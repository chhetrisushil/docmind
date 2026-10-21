import { randomUUID } from "node:crypto";
import { newSessionToken } from "@docmind/auth";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PgAuthStore } from "../auth/pgAuthStore";
import { migrate, setAppRolePassword } from "../db/migrate";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";
import { pgAccountErasure } from "./account";
import { PgErasureStore } from "./pgStore";
import { newReceipt } from "./receipt";
import { ERASURE_STEPS } from "./types";

describe.skipIf(!PG_URL)("the account erasure transaction (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;
  let auth: PgAuthStore;
  const run = vi.fn(async () => {});

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    app = new Pool({ connectionString: db.appUrl });
    auth = new PgAuthStore(app);
  });
  afterAll(async () => {
    await app?.end();
    await db?.drop();
  });

  async function account(email: string) {
    const identity = { tenantId: randomUUID(), userId: randomUUID() };
    expect(await auth.createAccount({ ...identity, email, passwordHash: "x" })).toBe(true);
    const sessions: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { tokenHash } = newSessionToken();
      await auth.createSession({
        ...identity,
        tokenHash,
        expiresAt: new Date(Date.now() + 60_000),
      });
      sessions.push(tokenHash);
    }
    return { identity, sessions };
  }
  const erasure = () =>
    pgAccountErasure({ pool: app, store: new PgErasureStore(app), eraser: { run } });
  const emailOf = async (userId: string) =>
    (await db.owner.query("SELECT email FROM users WHERE id = $1", [userId])).rows[0].email;
  const sessionCount = async (userId: string) =>
    (
      await db.owner.query("SELECT count(*)::int AS n FROM auth_sessions WHERE user_id = $1", [
        userId,
      ])
    ).rows[0].n;

  it("records the request, deletes every session of the user and only theirs, marks the user, and frees the email", async () => {
    const ada = await account("ada@erase.test");
    const bob = await account("bob@erase.test");
    const receipt = newReceipt();
    expect(await erasure().request(ada.identity, receipt.hash)).toBe(true);
    expect(await new PgErasureStore(app).status(receipt.hash)).toBe("pending");
    const stored = await db.owner.query(
      "SELECT receipt_hash FROM erasure_requests WHERE user_id = $1",
      [ada.identity.userId],
    );
    expect(stored.rows[0].receipt_hash).toEqual(receipt.hash); // the hash, not the token
    expect(stored.rows[0].receipt_hash.toString("base64url")).not.toBe(receipt.token);
    // the email: replaced in the same transaction, the neighbour's untouched, the old address in no row
    expect(await emailOf(ada.identity.userId)).toBe(`erased:${ada.identity.userId}`);
    expect(await emailOf(bob.identity.userId)).toBe("bob@erase.test");
    expect(
      (await db.owner.query("SELECT count(*)::int AS n FROM users WHERE email = 'ada@erase.test'"))
        .rows[0].n,
    ).toBe(0);

    const req = await db.owner.query(
      "SELECT tenant_id, state, steps FROM erasure_requests WHERE user_id = $1",
      [ada.identity.userId],
    );
    expect(req.rows).toEqual([{ tenant_id: ada.identity.tenantId, state: "pending", steps: [] }]);
    expect(await sessionCount(ada.identity.userId)).toBe(0);
    expect(await sessionCount(bob.identity.userId)).toBe(2);
    expect(
      (
        await db.owner.query("SELECT erasing_at IS NOT NULL AS marked FROM users WHERE id = $1", [
          ada.identity.userId,
        ])
      ).rows[0].marked,
    ).toBe(true);
    expect(
      (
        await db.owner.query("SELECT erasing_at IS NULL AS clean FROM users WHERE id = $1", [
          bob.identity.userId,
        ])
      ).rows[0].clean,
    ).toBe(true);
    for (const hash of ada.sessions) expect(await auth.findSession(hash)).toBeNull();
    expect(await auth.findSession(bob.sessions[0] ?? "")).toEqual(bob.identity);
  });

  it("a second request is refused (false) and rolled back whole: the first receipt is the one that works", async () => {
    const cy = await account("cy@erase.test");
    const [one, two] = [newReceipt(), newReceipt()];
    expect(await erasure().request(cy.identity, one.hash)).toBe(true);
    const first = (
      await db.owner.query("SELECT erasing_at FROM users WHERE id = $1", [cy.identity.userId])
    ).rows[0].erasing_at as Date;
    // a session created after the first request (a concurrent login) must survive the refused second one
    const { tokenHash } = newSessionToken();
    await auth.createSession({
      ...cy.identity,
      tokenHash,
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(await erasure().request(cy.identity, two.hash)).toBe(false);
    const second = (
      await db.owner.query("SELECT erasing_at FROM users WHERE id = $1", [cy.identity.userId])
    ).rows[0].erasing_at as Date;
    expect(second.getTime()).toBe(first.getTime());
    expect(await sessionCount(cy.identity.userId)).toBe(1); // the refused request deleted nothing
    expect(
      (
        await db.owner.query("SELECT count(*)::int AS n FROM erasure_requests WHERE user_id = $1", [
          cy.identity.userId,
        ])
      ).rows[0].n,
    ).toBe(1);
    const store = new PgErasureStore(app);
    expect(await store.status(one.hash)).toBe("pending");
    expect(await store.status(two.hash)).toBeNull();
    expect(await emailOf(cy.identity.userId)).toBe(`erased:${cy.identity.userId}`);
  });

  it("is all or nothing: when the insert fails the sessions stay and the email is not scrubbed", async () => {
    const dee = await account("dee@erase.test");
    const broken = pgAccountErasure({
      pool: app,
      store: {
        insert: async () => {
          throw new RangeError("insert failed");
        },
        status: async () => null,
      },
      eraser: { run },
    });
    await expect(broken.request(dee.identity, newReceipt().hash)).rejects.toThrow(RangeError);
    expect(await emailOf(dee.identity.userId)).toBe("dee@erase.test");
    expect(await sessionCount(dee.identity.userId)).toBe(2);
    expect(
      (
        await db.owner.query("SELECT erasing_at IS NULL AS clean FROM users WHERE id = $1", [
          dee.identity.userId,
        ])
      ).rows[0].clean,
    ).toBe(true);
  });

  it("status reads the request by receipt hash through the definer function, with no tenant: pending, then done, null for a stranger", async () => {
    const eve = await account("eve@erase.test");
    const receipt = newReceipt();
    await erasure().request(eve.identity, receipt.hash);
    expect(await erasure().status(receipt.hash)).toBe("pending");
    expect(await erasure().status(newReceipt().hash)).toBeNull();
    // the steps are recorded in order (0024); `done` is the last of them
    for (const step of ERASURE_STEPS) await new PgErasureStore(app).mark(eve.identity.userId, step);
    expect(await erasure().status(receipt.hash)).toBe("done");
  });

  it("throws and rolls back when the scrub does not update exactly one user row", async () => {
    const fay = await account("fay@erase.test");
    const store = new PgErasureStore(app);
    const blind = pgAccountErasure({
      pool: app,
      store: {
        status: store.status.bind(store),
        // the real insert, then the tenant context moves, so row-level security hides the user from the UPDATE
        insert: async (tx, userId, tenantId, hash) => {
          const inserted = await store.insert(tx, userId, tenantId, hash);
          await tx.query("SELECT set_config('app.tenant_id', $1, true)", [randomUUID()]);
          return inserted;
        },
      },
      eraser: { run },
    });
    await expect(blind.request(fay.identity, newReceipt().hash)).rejects.toThrow();
    expect(await emailOf(fay.identity.userId)).toBe("fay@erase.test");
    expect(
      (
        await db.owner.query("SELECT count(*)::int AS n FROM erasure_requests WHERE user_id = $1", [
          fay.identity.userId,
        ])
      ).rows[0].n,
    ).toBe(0);
    expect(await sessionCount(fay.identity.userId)).toBe(2);
  });

  it("start() closes the user's streams at once, before and without any eraser slot, and a throwing close does not stop the run", () => {
    const id = randomUUID();
    const order: string[] = [];
    const never = vi.fn(() => {
      order.push("run");
      return new Promise<void>(() => {}); // an eraser still waiting for a slot / a chat turn
    });
    pgAccountErasure({
      pool: app,
      store: new PgErasureStore(app),
      eraser: { run: never },
      closeStreams: (userId) => {
        expect(userId).toBe(id);
        order.push("close");
      },
    }).start(id);
    expect(order).toEqual(["close", "run"]);
    const survives = vi.fn(async () => {});
    pgAccountErasure({
      pool: app,
      store: new PgErasureStore(app),
      eraser: { run: survives },
      closeStreams: () => {
        throw new RangeError("boom");
      },
    }).start(id);
    expect(survives).toHaveBeenCalledWith(id);
  });

  it("start() runs the eraser for that user and never throws", () => {
    const id = randomUUID();
    erasure().start(id);
    expect(run).toHaveBeenCalledWith(id);
  });
});
