import { createSecretKey, randomBytes, randomUUID } from "node:crypto";
import { PostgresKeyStore } from "@docmind/keystore-pg";
import { PayloadShreddedError, shredSubject } from "@loom/plugin-crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword, setRolePassword } from "./db/migrate";
import { APP_PASSWORD, LOOM_PASSWORD, PG_URL, type TestDb, createTestDb } from "./db/testSupport";
import { type DurableStorage, createDurableStorage } from "./storage";
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
    await app?.end();
    await db?.drop();
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

  it("seals each user's events under that user's key, not the execution's", async () => {
    const userA = randomUUID();
    const exec = executionIdFor(userA, "notes-1");
    await stores.sealed.eventStore.append(note(exec, "secret A"));

    expect((await stores.sealed.eventStore.read(exec))[0]?.payload).toMatchObject({
      text: "secret A",
    });
    const stored = (await stores.raw.eventStore.read(exec))[0]?.payload as { text: object };
    expect(JSON.stringify(stored.text)).not.toContain("secret A");

    const { rows } = await db.owner.query(
      "SELECT subject_id FROM data_keys WHERE subject_id = ANY($1)",
      [[userA, exec]],
    );
    expect(rows).toEqual([{ subject_id: userA }]);
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
