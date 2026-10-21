import { createSecretKey, randomBytes, randomUUID } from "node:crypto";
import { PostgresKeyStore } from "@docmind/keystore-pg";
import { PayloadShreddedError } from "@loom/plugin-crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../config";
import { migrate, setAppRolePassword, setRolePassword } from "../db/migrate";
import { APP_PASSWORD, LOOM_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";
import { type DurableStorage, createDurableStorage } from "../storage";
import { executionIdFor } from "../subject";
import { hydrateSubjectIndex } from "./compliance";

describe.skipIf(!PG_URL)("erasure wiring over durable storage (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let pool: Pool;
  let keys: PostgresKeyStore;
  let stores: DurableStorage;
  const [A, B] = [randomUUID(), randomUUID()];
  const [a1, a2, b1] = [
    executionIdFor(A, "ingest-1"),
    `u_${A}.c-${randomUUID()}`,
    executionIdFor(B, "ingest-1"),
  ];

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await setRolePassword(db.owner, "docmind_loom", LOOM_PASSWORD);
    pool = new Pool({ connectionString: db.appUrl });
    keys = new PostgresKeyStore(pool, [{ id: "kek-1", key: createSecretKey(randomBytes(32)) }]);
    stores = createDurableStorage({ loomUrl: db.loomUrl, keys });
    stores.crypto.events.registerSensitive("NOTE_ADDED", ["text"]);
    // Executions are written straight to the store, as a previous process would have left them:
    // nothing reaches `onEvent`, so a freshly built app's subject index is empty.
    for (const [id, text] of [
      [a1, "a secret"],
      [a2, "a chat secret"],
      [b1, "b secret"],
    ] as const) {
      const at = (sequence: number, eventType: string, payload: unknown) => ({
        id: randomUUID(),
        workflowId: "notes",
        executionId: id,
        eventType,
        sequence,
        timestamp: 1_000 + sequence,
        payload,
      });
      await stores.sealed.eventStore.append(at(0, "EXECUTION_STARTED", { input: {} }));
      await stores.sealed.eventStore.append(at(1, "NOTE_ADDED", { text }));
      await stores.sealed.eventStore.append(at(2, "EXECUTION_COMPLETED", {}));
    }
  });

  afterAll(async () => {
    await stores?.storage.eventStore.close?.();
    await stores?.close();
    await pool?.end();
    await db?.drop();
  });

  it("answers unknown from an empty index and shreds nothing; once hydrated it erases, and only that user", async () => {
    const app = buildApp(stores.storage, stores.crypto, {
      erasure: { keys, raw: stores.raw },
    });
    try {
      const index = app.subjectIndex;
      if (!index) throw new Error("the app has no subject index");
      expect(index.executionsOf(A)).toEqual([]);
      await expect(app.eraseSubject(A, undefined, { parked: "shred" })).resolves.toMatchObject({
        outcome: "unknown",
        erased: [],
      });
      expect(await keys.wasDestroyed(A)).toBe(false);

      expect(await hydrateSubjectIndex(stores.raw.eventStore, index)).toBe(3);
      const result = await app.eraseSubject(A, undefined, { parked: "shred" });
      expect(result).toMatchObject({ subjectId: A, outcome: "erased" });
      expect([...result.erased].sort()).toEqual([a1, a2].sort());

      expect(await keys.wasDestroyed(A)).toBe(true);
      await expect(stores.sealed.eventStore.read(a1)).rejects.toBeInstanceOf(PayloadShreddedError);
      expect((await stores.raw.eventStore.read(a2)).at(-1)?.eventType).toBe("PAYLOAD_SHREDDED");
      // The other user is untouched.
      expect((await stores.sealed.eventStore.read(b1))[1]?.payload).toEqual({ text: "b secret" });
      expect(await keys.wasDestroyed(B)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("is idempotent: erasing the same user again changes nothing and does not throw", async () => {
    const app = buildApp(stores.storage, stores.crypto, { erasure: { keys, raw: stores.raw } });
    try {
      const index = app.subjectIndex;
      if (!index) throw new Error("the app has no subject index");
      await hydrateSubjectIndex(stores.raw.eventStore, index);
      // Self-contained: erase first (a no-op repeat if the other test already did), then erase again.
      await app.eraseSubject(A, undefined, { parked: "shred" });
      const again = await app.eraseSubject(A, undefined, { parked: "shred" });
      expect(again.outcome).toBe("erased");
      expect(
        (await stores.raw.eventStore.read(a1)).filter((e) => e.eventType === "PAYLOAD_SHREDDED"),
      ).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
