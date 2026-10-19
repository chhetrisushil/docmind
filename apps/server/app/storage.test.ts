import { createSecretKey, randomBytes, randomUUID } from "node:crypto";
import { PostgresKeyStore } from "@docmind/keystore-pg";
import { PayloadShreddedError, shredSubject } from "@loom/plugin-crypto";
import { PostgresEventStore } from "@loom/plugin-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { migrate, setAppRolePassword, setRolePassword } from "./db/migrate";
import { APP_PASSWORD, LOOM_PASSWORD, PG_URL, type TestDb, createTestDb } from "./db/testSupport";
import {
  type DurableStorage,
  createDurableStorage,
  loomPoolConfig,
  openDurableStorage,
} from "./storage";
import { executionIdFor } from "./subject";

describe.skipIf(!PG_URL)("durable, encrypted Loom storage (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;
  let keys: PostgresKeyStore;
  let stores: DurableStorage;

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await setRolePassword(db.owner, "docmind_loom", LOOM_PASSWORD);
    app = new Pool({ connectionString: db.appUrl });
    keys = new PostgresKeyStore(app, [{ id: "kek-1", key: createSecretKey(randomBytes(32)) }]);
    stores = createDurableStorage({ loomUrl: db.loomUrl, keys });
    stores.crypto.events.registerSensitive("NOTE_ADDED", ["text"]);
  });

  afterAll(async () => {
    await stores?.storage.eventStore.close?.();
    await stores?.close();
    await app?.end();
    await db?.drop();
  });

  it("logs an idle Loom connection error by class only", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    stores.pool.emit("error", new Error("connect ECONNREFUSED 10.1.2.3 as secret-user"));
    expect(spy.mock.calls).toEqual([["idle Loom database connection failed", "Error"]]);
    spy.mockRestore();
  });

  const note = (executionId: string, text: string) => ({
    id: randomUUID(),
    workflowId: "notes",
    executionId,
    eventType: "NOTE_ADDED",
    sequence: 0,
    timestamp: 1,
    payload: { text, author: "kept in the clear" },
  });

  it("boots Loom's schema as docmind_loom with no privilege warning", async () => {
    const notices: string[] = [];
    const pool = new Pool(loomPoolConfig(db.loomUrl));
    pool.on("connect", (client) => {
      client.on("notice", (n) => notices.push(String(n.message)));
    });
    const store = new PostgresEventStore(pool as never); // pg typings differ between the linked Loom and this repo;
    try {
      await store.read("boot-probe");
      expect(notices.filter((m) => m.startsWith("loom:"))).toEqual([]);
      expect(await store.incarnationAnchors()).toBe(true);
    } finally {
      await store.close();
      await pool.end();
    }
    const { rows } = await db.owner.query(
      `SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'loom' AND t.tgname = 'trg_events_incarnation'`,
    );
    expect(rows).toHaveLength(1);
  });

  it("seals each user's events under that user's key, not the execution's", async () => {
    const userA = randomUUID();
    const exec = executionIdFor(userA, "notes-1");
    await stores.sealed.eventStore.append(note(exec, "secret A"));

    expect((await stores.sealed.eventStore.read(exec))[0]?.payload).toMatchObject({
      text: "secret A",
    });
    const stored = (await stores.raw.eventStore.read(exec))[0]?.payload as { text: object };
    expect(JSON.stringify(stored.text)).not.toContain("secret A");

    // The table itself, read as docmind_loom, holds no plaintext either.
    const loom = new Pool(loomPoolConfig(db.loomUrl));
    try {
      const { rows } = await loom.query(
        "SELECT payload::text AS p FROM events WHERE execution_id = $1",
        [exec],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].p).not.toContain("secret A");
      expect(rows[0].p).toContain("kept in the clear");
    } finally {
      await loom.end();
    }

    const { rows } = await db.owner.query(
      "SELECT subject_id FROM data_keys WHERE subject_id = ANY($1)",
      [[userA, exec]],
    );
    expect(rows).toEqual([{ subject_id: userA }]);
  });

  it("seals and reads an execution no user owns, under its own x: key", async () => {
    const exec = `system-sweep-${randomUUID()}`;
    await stores.sealed.eventStore.append(note(exec, "system secret"));

    expect((await stores.sealed.eventStore.read(exec))[0]?.payload).toMatchObject({
      text: "system secret",
    });
    const stored = (await stores.raw.eventStore.read(exec))[0]?.payload as { text: object };
    expect(JSON.stringify(stored.text)).not.toContain("system secret");
    const { rows } = await db.owner.query(
      "SELECT subject_id FROM data_keys WHERE subject_id = $1",
      [`x:${exec}`],
    );
    expect(rows).toEqual([{ subject_id: `x:${exec}` }]);
  });

  it("keeps a Loom child execution of a user's execution under that user's key", async () => {
    const user = randomUUID();
    const parent = executionIdFor(user, "ingest-1");
    const child = `${parent}::step#0`;
    await stores.sealed.eventStore.append(note(child, "child secret"));

    expect((await stores.sealed.eventStore.read(child))[0]?.payload).toMatchObject({
      text: "child secret",
    });
    const { rows } = await db.owner.query(
      "SELECT subject_id FROM data_keys WHERE subject_id = ANY($1)",
      [[user, `x:${child}`]],
    );
    expect(rows).toEqual([{ subject_id: user }]);

    await shredSubject(keys, stores.raw.eventStore, child, {
      subjectId: user,
      executionIds: [child],
      snapshotStore: stores.raw.snapshotStore,
    });
    await expect(stores.sealed.eventStore.read(child)).rejects.toBeInstanceOf(PayloadShreddedError);
  });

  it("seals the paths it is given at construction, not only those registered afterwards", async () => {
    const custom = createDurableStorage({
      loomUrl: db.loomUrl,
      keys,
      sensitive: { DOC_NAMED: ["filename"] },
    });
    try {
      const exec = executionIdFor(randomUUID(), "named");
      await custom.sealed.eventStore.append({
        ...note(exec, "unused"),
        eventType: "DOC_NAMED",
        payload: { filename: "tax-return.pdf", documentId: "d1" },
      });
      const raw = (await custom.raw.eventStore.read(exec))[0]?.payload as {
        filename: object;
        documentId: string;
      };
      expect(JSON.stringify(raw.filename)).not.toContain("tax-return");
      expect(raw.documentId).toBe("d1");
    } finally {
      await custom.storage.eventStore.close?.();
      await custom.close();
    }
  });

  it("makes one user's events unreadable after their key is destroyed, and no one else's", async () => {
    const [userA, userB] = [randomUUID(), randomUUID()];
    const [execA1, execA2, execB] = [
      executionIdFor(userA, "one"),
      executionIdFor(userA, "two"),
      executionIdFor(userB, "one"),
    ];
    for (const e of [execA1, execA2, execB])
      await stores.sealed.eventStore.append(note(e, "secret"));

    for (const e of [execA1, execA2]) {
      await shredSubject(keys, stores.raw.eventStore, e, {
        subjectId: userA,
        executionIds: [execA1, execA2],
        snapshotStore: stores.raw.snapshotStore,
      });
    }

    await expect(stores.sealed.eventStore.read(execA1)).rejects.toBeInstanceOf(
      PayloadShreddedError,
    );
    await expect(stores.sealed.eventStore.read(execA2)).rejects.toBeInstanceOf(
      PayloadShreddedError,
    );
    expect((await stores.sealed.eventStore.read(execB))[0]?.payload).toMatchObject({
      text: "secret",
    });
    expect(await keys.wasDestroyed(userA)).toBe(true);
    expect(await keys.wasDestroyed(userB)).toBe(false);
  });

  it("reports the key unavailable, not erased, when it is destroyed without a tombstone", async () => {
    const [userA, userB] = [randomUUID(), randomUUID()];
    const [execA, execB] = [executionIdFor(userA, "k"), executionIdFor(userB, "k")];
    for (const e of [execA, execB]) await stores.sealed.eventStore.append(note(e, "plain words"));

    await keys.destroy(userA);

    await expect(stores.sealed.eventStore.read(execA)).rejects.toMatchObject({
      code: "KEY_UNAVAILABLE", // Loom's KeyUnavailableError; a misconfiguration, never an erasure
    });
    expect((await stores.sealed.eventStore.read(execB))[0]?.payload).toMatchObject({
      text: "plain words",
    });
  });

  it("seals snapshots under the same key, so the checkpoint is erased with the events", async () => {
    const user = randomUUID();
    const exec = executionIdFor(user, "snap");
    const state = { variables: { draft: "private words" } };
    const snapshot = {
      id: randomUUID(),
      executionId: exec,
      workflowId: "notes",
      sequence: 1,
      createdAt: 1,
    };
    // biome-ignore lint/suspicious/noExplicitAny: a minimal folded state is enough to seal
    await stores.sealed.snapshotStore.save({ ...snapshot, state: state as any });

    expect((await stores.sealed.snapshotStore.loadLatest(exec))?.state).toEqual(state);
    const raw = await stores.raw.snapshotStore.loadLatest(exec);
    expect(JSON.stringify(raw?.state)).not.toContain("private words");

    await shredSubject(keys, stores.raw.eventStore, exec, {
      subjectId: user,
      executionIds: [exec],
      snapshotStore: stores.raw.snapshotStore,
    });
    await expect(stores.sealed.snapshotStore.loadLatest(exec)).rejects.toBeInstanceOf(
      PayloadShreddedError,
    );
  });
});

describe.skipIf(!PG_URL)("openDurableStorage (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await setRolePassword(db.owner, "docmind_loom", LOOM_PASSWORD);
    app = new Pool({ connectionString: db.appUrl });
  });

  afterAll(async () => {
    await app?.end();
    await db?.drop();
  });

  const keysFor = () =>
    new PostgresKeyStore(app, [{ id: "kek-1", key: createSecretKey(randomBytes(32)) }]);

  it("rejects, naming no URL, when Loom's schema DDL cannot run", async () => {
    await db.owner.query("ALTER SCHEMA loom OWNER TO CURRENT_USER");
    await db.owner.query("REVOKE ALL ON SCHEMA loom FROM docmind_loom");
    try {
      const err = await openDurableStorage({ loomUrl: db.loomUrl, keys: keysFor() }).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(err?.message).toMatch(/^Loom storage failed to boot: /);
      expect(err?.message).not.toContain(LOOM_PASSWORD);
    } finally {
      await db.owner.query("ALTER SCHEMA loom OWNER TO docmind_loom");
    }
  });

  it("resolves once the DDL has run", async () => {
    const durable = await openDurableStorage({ loomUrl: db.loomUrl, keys: keysFor() });
    await durable.storage.eventStore.close?.();
    await durable.close();
  });
});
