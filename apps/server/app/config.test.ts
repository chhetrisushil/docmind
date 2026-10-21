import { createSecretKey, randomBytes } from "node:crypto";
import { PostgresKeyStore } from "@docmind/keystore-pg";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { TimerService } from "@loom/workflow-runtime";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "./config";
import { migrate, setAppRolePassword, setRolePassword } from "./db/migrate";
import { APP_PASSWORD, LOOM_PASSWORD, PG_URL, type TestDb, createTestDb } from "./db/testSupport";
import { noSnapshots } from "./erasure/testing";
import { createDurableStorage } from "./storage";

describe("buildApp", () => {
  it("composes under strict mode on in-memory storage", async () => {
    const app = buildApp({ kind: "memory" });
    await app.close();
  });
});

describe("buildApp compliance", () => {
  it("has no subject index and refuses to erase without the erasure wiring", async () => {
    const app = buildApp({ kind: "memory" });
    expect(app.subjectIndex).toBeUndefined();
    await expect(app.eraseSubject("u")).rejects.toThrow(/requires `compliance/);
    await app.close();
  });

  it("with the erasure wiring it has the index, and an unknown subject is answered, not refused", async () => {
    const app = buildApp({ kind: "memory" }, undefined, {
      erasure: {
        keys: new InMemoryKeyStore(),
        raw: { eventStore: new InMemoryAsyncEventStore(), snapshotStore: noSnapshots },
      },
    });
    expect(app.subjectIndex).toBeDefined();
    await expect(app.eraseSubject("nobody")).resolves.toMatchObject({
      outcome: "unknown",
      erased: [],
    });
    await app.close();
  });
});

describe("buildApp autostart with erasure", () => {
  const chat = () => ({ flows: [], effects: {}, timers: new InMemoryTimerStore() });
  const erasure = () => ({
    keys: new InMemoryKeyStore(),
    raw: { eventStore: new InMemoryAsyncEventStore(), snapshotStore: noSnapshots },
  });

  it("does not start the timers at composition: `bootIngest` fills the subject index first, then `app.start()`", async () => {
    const start = vi.spyOn(TimerService.prototype, "start");
    try {
      const app = buildApp({ kind: "memory" }, undefined, { chat: chat(), erasure: erasure() });
      expect(start).not.toHaveBeenCalled();
      app.start();
      expect(start).toHaveBeenCalledTimes(1);
      await app.close();
    } finally {
      start.mockRestore();
    }
  });

  it("without erasure the timers start at composition, as before", async () => {
    const start = vi.spyOn(TimerService.prototype, "start");
    try {
      const app = buildApp({ kind: "memory" }, undefined, { chat: chat() });
      expect(start).toHaveBeenCalledTimes(1);
      await app.close();
    } finally {
      start.mockRestore();
    }
  });
});

describe("buildApp onWarn with erasure", () => {
  it("a Loom warning that carries ids reaches the console without them", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const id = "u_6a1f0c52-1111-4222-8333-444455556666";
    // Loom reads the erasure control stream at boot; a failure there is reported through onWarn with String(err).
    const eventStore = new InMemoryAsyncEventStore();
    eventStore.read = async () => {
      throw new Error(`ShredIncompleteError: shredSubject("${id}") (${id}:ingest-1)`);
    };
    const keys = new InMemoryKeyStore();
    const raw = { eventStore: new InMemoryAsyncEventStore(), snapshotStore: noSnapshots };
    const app = buildApp({ kind: "custom", eventStore }, undefined, { erasure: { keys, raw } });
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith("[loom]", expect.stringContaining("ShredIncompleteError")),
    );
    const printed = warn.mock.calls.map((c) => c[1]).find((m) => String(m).includes("Shred"));
    // The ids are replaced one for one; the rest of the text is kept for the operator.
    expect(printed).toBe(
      'erasure coordinator: Error: ShredIncompleteError: shredSubject("<id>") (<id>) — the request stays parked and will retry',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(id);
    await app.close();
    warn.mockRestore();
  });
});

describe("buildApp onWarn without erasure", () => {
  it("is installed too: a Loom notice goes through the redacting sink", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const app = buildApp({ kind: "memory" });
      await app.close();
      // Loom reports its boot verify through onWarn; it is printed with the sink's prefix.
      expect(warn.mock.calls.some((c) => c[0] === "[loom]")).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

describe.skipIf(!PG_URL)("buildApp on durable storage (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let pool: Pool;

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await setRolePassword(db.owner, "docmind_loom", LOOM_PASSWORD);
    pool = new Pool({ connectionString: db.appUrl });
  });

  afterAll(async () => {
    await pool?.end();
    await db?.drop();
  });

  it("composes under strict mode, with encrypting stores that Loom accepts as sealing", async () => {
    const keys = new PostgresKeyStore(pool, [
      { id: "kek-1", key: createSecretKey(randomBytes(32)) },
    ]);
    const durable = createDurableStorage({ loomUrl: db.loomUrl, keys });
    const { storage, crypto } = durable;
    const app = buildApp(storage, crypto);
    expect(app.stores.eventStore).toBe(storage.eventStore);
    expect(app.security?.crypto).toEqual({ allowPlaintextCheckpoints: false });
    await app.close();
    await durable.close();
  });
});

it("composes without chat exactly as before: no chat flow, no chat effect", async () => {
  const app = buildApp({ kind: "memory" });
  expect(app.runtime.getFlowIds()).not.toContain("doc-chat");
  expect(app.effectRuntime.kindOf("search_docs")).toBeUndefined();
  await app.close();
});
