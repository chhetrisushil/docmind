import { createSecretKey, randomBytes, randomUUID } from "node:crypto";
import { PostgresKeyStore } from "@docmind/keystore-pg";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import { EncryptingEventStore, InMemoryKeyStore } from "@loom/plugin-crypto";
import { TimerService } from "@loom/workflow-runtime";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SummaryChoiceEventStore } from "./chats/summaryChoice";
import { buildApp, visualizeFlows } from "./config";
import { migrate, setAppRolePassword, setRolePassword } from "./db/migrate";
import { APP_PASSWORD, LOOM_PASSWORD, PG_URL, type TestDb, createTestDb } from "./db/testSupport";
import { noSnapshots, testControlKeys } from "./erasure/testing";
import { visualizeDocumentFlow } from "./flows/visualize-document/flow";
import { openDurableStorage } from "./storage";

describe("buildApp", () => {
  it("composes under strict mode on in-memory storage", async () => {
    const app = buildApp({ kind: "memory" });
    await app.close();
  });
});

describe("visualizeFlows", () => {
  it("registers the 1.0.0 visualize flow before the current one, and only the current one without it", () => {
    const current = visualizeDocumentFlow();
    const legacy = visualizeDocumentFlow(undefined, { legacy: true });
    expect(
      visualizeFlows({ flow: current, legacyFlow: legacy }).map((f) => f.definition.version),
    ).toEqual(["1.0.0", "1.1.0"]);
    expect(visualizeFlows({ flow: current }).map((f) => f.definition.version)).toEqual(["1.1.0"]);
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
        controlStreamKeys: testControlKeys(),
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

describe("buildApp control stream", () => {
  it("a parked erasure recorded by Loom names the subject by a keyed subjectRef, never by id", async () => {
    const store = new InMemoryAsyncEventStore();
    const app = buildApp({ kind: "custom", eventStore: store }, undefined, {
      erasure: {
        keys: new InMemoryKeyStore(),
        raw: { eventStore: store, snapshotStore: noSnapshots },
        controlStreamKeys: testControlKeys(),
      },
    });
    try {
      const user = randomUUID();
      const executionId = `u_${user}:ingest-1`;
      // A running execution of the user: the shred parks behind it.
      const started = {
        id: "e0",
        workflowId: "wf",
        executionId,
        eventType: "EXECUTION_STARTED",
        sequence: 0,
        timestamp: 1,
        payload: {},
      };
      await store.append(started as never);
      app.subjectIndex?.handleEvent(started as never);
      const r = await app.eraseSubject(user, undefined, { parked: "shred", record: true });
      expect(r.outcome).toBe("parked");
      const rows = await store.read("__loom_erasure__");
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(JSON.stringify(row)).not.toContain(user);
        const payload = row.payload as Record<string, unknown>;
        expect(payload.subjectId).toBeUndefined();
        expect(payload.subjectRef).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
      }
    } finally {
      await app.close();
    }
  });
});

describe("buildApp autostart with erasure", () => {
  const chat = () => ({ flows: [], effects: {}, timers: new InMemoryTimerStore() });
  const erasure = () => ({
    keys: new InMemoryKeyStore(),
    raw: { eventStore: new InMemoryAsyncEventStore(), snapshotStore: noSnapshots },
    controlStreamKeys: testControlKeys(),
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
    const app = buildApp({ kind: "custom", eventStore }, undefined, {
      erasure: { keys, raw, controlStreamKeys: testControlKeys() },
    });
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
    // Opened, not just created: the stores' boot work (migrations, the snapshot codec probe) must finish before
    // `durable.close()` ends the pool, or it rejects unobserved after the test.
    const durable = await openDurableStorage({ loomUrl: db.loomUrl, keys });
    const { storage, crypto } = durable;
    // The rolling summary's decision is sealable only through this decorator; Loom must still see a sealing store.
    expect(storage.eventStore).toBeInstanceOf(SummaryChoiceEventStore);
    expect(durable.sealed.eventStore).toBe(storage.eventStore);
    expect(crypto.events).toBeInstanceOf(EncryptingEventStore);
    const shape = storage.eventStore as unknown as Record<string, unknown>;
    const sealing = crypto.events as unknown as Record<string, unknown>;
    expect(shape.keys).toBe(sealing.keys);
    expect(shape.subjectOf).toBe(sealing.subjectOf);
    expect(shape.senderSubjectOf).toBe(sealing.senderSubjectOf);
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
