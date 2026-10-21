import { createSecretKey, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgresKeyStore } from "@docmind/keystore-pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword, setRolePassword } from "../db/migrate";
import { APP_PASSWORD, LOOM_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";
import { type DurableStorage, openDurableStorage } from "../storage";
import { Eraser, type ErasureDeps, abortableSleep } from "./eraser";
import { pgErasureLock, pgErasureSql } from "./pgSteps";
import { MemoryErasureStore } from "./testing";
import type { ErasureRequest } from "./types";

const HASH = "$argon2id$not-a-real-hash";

describe.skipIf(!PG_URL)("the Postgres steps of the eraser (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;
  let locks: Pool;
  let durable: DurableStorage;
  let root: string;
  let sql: ReturnType<typeof pgErasureSql>;

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await setRolePassword(db.owner, "docmind_loom", LOOM_PASSWORD);
    app = new Pool({ connectionString: db.appUrl });
    locks = new Pool({ connectionString: db.appUrl, max: 3, connectionTimeoutMillis: 5_000 });
    const keys = new PostgresKeyStore(app, [
      { id: "kek-1", key: createSecretKey(randomBytes(32)) },
    ]);
    durable = await openDurableStorage({ loomUrl: db.loomUrl, keys });
    root = mkdtempSync(join(tmpdir(), "dm-erasure-pg-"));
    sql = pgErasureSql({ app, locks, loom: durable.pool, blobRoot: root });
  });
  afterAll(async () => {
    await durable?.close();
    await locks?.end();
    await app?.end();
    await db?.drop();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** A tenant with the given users (sign-up makes one user per tenant; more go in as the owner does). */
  async function tenantWith(...emails: string[]) {
    const tenantId = randomUUID();
    const users: { userId: string; email: string }[] = [];
    for (const [i, email] of emails.entries()) {
      const userId = randomUUID();
      if (i === 0)
        await db.owner.query("SELECT public.auth_sign_up($1, $2, $3, $4)", [
          tenantId,
          userId,
          email,
          HASH,
        ]);
      else
        await db.owner.query(
          "INSERT INTO users (id, tenant_id, email, password_hash) VALUES ($1, $2, $3, $4)",
          [userId, tenantId, email, HASH],
        );
      users.push({ userId, email });
    }
    return { tenantId, users };
  }
  const request = (tenantId: string, userId: string): ErasureRequest => ({
    userId,
    tenantId,
    state: "pending",
    steps: [],
    attempts: 0,
  });
  const count = async (q: string, args: unknown[]) =>
    (await db.owner.query(q, args)).rows[0].n as number;

  it("lists the user's chats, soft-deleted ones included, and never a colleague's", async () => {
    const { tenantId, users } = await tenantWith("a@work.test", "b@work.test");
    const [a, b] = users as [(typeof users)[0], (typeof users)[0]];
    const mine = [randomUUID(), randomUUID()];
    for (const id of mine)
      await db.owner.query(
        "INSERT INTO chat_sessions (id, tenant_id, user_id) VALUES ($1, $2, $3)",
        [id, tenantId, a.userId],
      );
    await db.owner.query("UPDATE chat_sessions SET deleted_at = now() WHERE id = $1", [mine[1]]);
    await db.owner.query("INSERT INTO chat_sessions (id, tenant_id, user_id) VALUES ($1, $2, $3)", [
      randomUUID(),
      tenantId,
      b.userId,
    ]);
    const work = await sql.work(request(tenantId, a.userId));
    expect([...work.chatIds].sort()).toEqual([...mine].sort());
    expect(work.documents).toEqual([]);
  });

  it("rows: deletes the user (whose email is already scrubbed) and their data, the user's timers and leases, and the empty tenant; twice is fine", async () => {
    const { tenantId, users } = await tenantWith("solo@erase.test");
    const [u] = users as [(typeof users)[0]];
    // The request transaction (Task 170a) has already replaced the email; the step must not need it.
    await db.owner.query(
      "UPDATE users SET email = 'erased:' || id::text, erasing_at = now() WHERE id = $1",
      [u.userId],
    );
    const chatId = randomUUID();
    await db.owner.query("INSERT INTO chat_sessions (id, tenant_id, user_id) VALUES ($1, $2, $3)", [
      chatId,
      tenantId,
      u.userId,
    ]);
    const docId = randomUUID();
    await db.owner.query(
      `INSERT INTO documents (id, tenant_id, owner_id, title_enc, filename_enc, mime, size_bytes, content_address, fingerprint)
       VALUES ($1, $2, $3, '{"x":1}', '{"x":2}', 'text/plain', 5, $4, $5)`,
      [docId, tenantId, u.userId, `hmac-sha256:${"ab".repeat(32)}`, "ab".repeat(32)],
    );
    const exec = `u_${u.userId}:ingest-${randomUUID()}.2`;
    const other = `u_${randomUUID()}:ingest-${randomUUID()}.2`;
    for (const id of [exec, other]) {
      await durable.pool.query("INSERT INTO loom.timers (execution_id, wake_at) VALUES ($1, 1)", [
        id,
      ]);
      await durable.pool.query(
        "INSERT INTO loom.leases (execution_id, owner, expires_at) VALUES ($1, 'x', 1)",
        [id],
      );
    }

    await sql.rows(request(tenantId, u.userId));
    await sql.rows(request(tenantId, u.userId)); // idempotent: nothing left to delete is not an error

    expect(await count("SELECT count(*)::int AS n FROM users WHERE id = $1", [u.userId])).toBe(0);
    expect(
      await count("SELECT count(*)::int AS n FROM chat_sessions WHERE id = $1", [chatId]),
    ).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM tenants WHERE id = $1", [tenantId])).toBe(0);
    expect(
      await count("SELECT count(*)::int AS n FROM loom.timers WHERE execution_id = $1", [exec]),
    ).toBe(0);
    expect(
      await count("SELECT count(*)::int AS n FROM loom.leases WHERE execution_id = $1", [exec]),
    ).toBe(0);
    expect(
      await count("SELECT count(*)::int AS n FROM loom.timers WHERE execution_id = $1", [other]),
    ).toBe(1); // another user's stay
    expect(
      await count("SELECT count(*)::int AS n FROM loom.leases WHERE execution_id = $1", [other]),
    ).toBe(1);
  });

  it("rows: keeps the tenant while a colleague remains, and the colleague's data", async () => {
    const { tenantId, users } = await tenantWith("keep1@work.test", "keep2@work.test");
    const [gone, stays] = users as [(typeof users)[0], (typeof users)[0]];
    const chatId = randomUUID();
    await db.owner.query("INSERT INTO chat_sessions (id, tenant_id, user_id) VALUES ($1, $2, $3)", [
      chatId,
      tenantId,
      stays.userId,
    ]);
    await sql.rows(request(tenantId, gone.userId));
    expect(await count("SELECT count(*)::int AS n FROM tenants WHERE id = $1", [tenantId])).toBe(1);
    expect(await count("SELECT count(*)::int AS n FROM users WHERE id = $1", [stays.userId])).toBe(
      1,
    );
    expect(
      await count("SELECT count(*)::int AS n FROM chat_sessions WHERE id = $1", [chatId]),
    ).toBe(1);
  });

  it("blobs: removes the user's directory and nothing of the colleague's; twice is fine", async () => {
    const tenantId = randomUUID();
    const [gone, stays] = [randomUUID(), randomUUID()];
    for (const u of [gone, stays]) {
      mkdirSync(join(root, tenantId, u), { recursive: true });
      writeFileSync(join(root, tenantId, u, "ab"), "x");
    }
    await sql.blobs(request(tenantId, gone));
    await sql.blobs(request(tenantId, gone));
    expect(existsSync(join(root, tenantId, gone))).toBe(false);
    expect(existsSync(join(root, tenantId, stays, "ab"))).toBe(true);
  });

  /** Advisory locks on `erasure:<user>` that are granted right now, seen from a connection of our own. */
  const held = async (userId: string) =>
    count(
      `SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND granted
          AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1::text, 0)`,
      [`erasure:${userId}`],
    );

  it("lock: one holder per user at a time, visible in pg_locks, gone after release", async () => {
    const lock = pgErasureLock(locks);
    const user = randomUUID();
    const first = await lock(user);
    expect(first).not.toBeNull();
    expect(await held(user)).toBe(1);
    expect(await lock(user)).toBeNull(); // held (another session)
    const other = randomUUID();
    const second = await lock(other);
    expect(second).not.toBeNull();
    expect(await held(other)).toBe(1);
    await first?.();
    expect(await held(user)).toBe(0); // really unlocked, not merely re-entrant on a reused session
    expect(await held(other)).toBe(1);
    await second?.();
    expect(await held(other)).toBe(0);
  });

  /** An Eraser over the real lock and the in-memory store, with every step but `rows` a no-op. */
  async function eraserWith(
    userId: string,
    tenantId: string,
    rows: ErasureDeps["rows"],
    sleep?: ErasureDeps["sleep"],
  ) {
    const store = new MemoryErasureStore();
    await store.insert({ query: async () => undefined }, userId, tenantId, randomBytes(32));
    const noop = async () => {};
    const deps: ErasureDeps = {
      store,
      lock: pgErasureLock(locks),
      work: async () => ({ documents: [], chatIds: [] }),
      closeStreams: () => {},
      settleStart: noop,
      settleTitles: noop,
      cancelIngest: noop,
      stopChat: noop,
      cancelTitle: noop,
      eraseSubject: async () => ({ outcome: "unknown" }),
      keys: { destroy: noop, wasDestroyed: async () => true },
      forgetStatus: noop,
      forgetActivity: noop,
      rows,
      blobs: noop,
      ...(sleep && { sleep }),
    };
    return { eraser: new Eraser(deps), store };
  }

  it("the eraser holds its lock while it works and releases it after success, during a backoff, and after stop", async () => {
    const quiet = (await import("vitest")).vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // success
      const a = randomUUID();
      let during = -1;
      const ok = await eraserWith(a, randomUUID(), async () => {
        during = await held(a);
      });
      await ok.eraser.run(a);
      expect(during).toBe(1);
      expect(await held(a)).toBe(0);
      expect(await ok.store.get(a)).toBeNull();
      // a step that throws once, then recovers
      const b = randomUUID();
      let calls = 0;
      const flaky = await eraserWith(b, randomUUID(), async () => {
        if (calls++ === 0) throw new RangeError("boom");
        expect(await held(b)).toBe(1); // taken again for the retry
      });
      await flaky.eraser.run(b);
      expect(await held(b)).toBe(0);
      // stopped while backing off
      const c = randomUUID();
      const stuck = await eraserWith(
        c,
        randomUUID(),
        async () => {
          throw new RangeError("down");
        },
        abortableSleep,
      );
      const run = stuck.eraser.run(c);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await held(c)).toBe(0); // the backoff holds no lock
      await stuck.eraser.stop();
      await run;
      expect(await held(c)).toBe(0);
    } finally {
      quiet.mockRestore();
    }
  });
  it("a dropped lock connection does not crash the process: the run re-acquires the lock and finishes", async () => {
    const quiet = (await import("vitest")).vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // An error on the pool itself (an idle connection) is handled.
      expect(() => locks.emit("error", new Error("idle drop"))).not.toThrow();
      const user = randomUUID();
      let calls = 0;
      const killed = await eraserWith(
        user,
        randomUUID(),
        async () => {
          if (calls++ > 0) return;
          const pid = await db.owner.query(
            `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted
              AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1::text, 0)`,
            [`erasure:${user}`],
          );
          await db.owner.query("SELECT pg_terminate_backend($1)", [pid.rows[0].pid]);
          await new Promise((resolve) => setTimeout(resolve, 300)); // the client sees the drop
        },
        async () => {},
      );
      await killed.eraser.run(user);
      expect(calls).toBe(2); // ran again under a new lock
      expect(await killed.store.get(user)).toBeNull();
      expect(await held(user)).toBe(0);
    } finally {
      quiet.mockRestore();
    }
  });
});
