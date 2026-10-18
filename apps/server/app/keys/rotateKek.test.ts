import { createSecretKey, randomBytes, randomUUID } from "node:crypto";
import { type Kek, PostgresKeyStore, rotateKek, verifyKeys } from "@docmind/keystore-pg";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword } from "../db/migrate";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";

const oldKek: Kek = { id: "kek-1", key: createSecretKey(randomBytes(32)) };
const newKek: Kek = { id: "kek-2", key: createSecretKey(randomBytes(32)) };

describe.skipIf(!PG_URL)("KEK rotation (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;
  let deks: Map<string, Buffer>;

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    app = new Pool({ connectionString: db.appUrl });
  });

  afterAll(async () => {
    await app?.end();
    await db?.drop();
  });

  /** Five users with keys under the old KEK, one of them erased. */
  beforeEach(async () => {
    await db.owner.query("TRUNCATE data_keys");
    const store = new PostgresKeyStore(app, [oldKek]);
    deks = new Map();
    for (let i = 0; i < 5; i++) {
      const subject = randomUUID();
      deks.set(subject, await store.getOrCreate(subject));
    }
    await store.destroy([...deks.keys()][4] as string);
  });

  const rows = async () =>
    (await db.owner.query("SELECT * FROM data_keys ORDER BY subject_id")).rows;

  it("moves every live key to the new KEK without changing any data key", async () => {
    const result = await rotateKek(db.owner, [newKek, oldKek], 2);
    expect(result).toEqual({ rotated: 4, failed: [], remaining: {} });

    const onlyNew = new PostgresKeyStore(app, [newKek]);
    for (const [subject, dek] of deks) {
      const got = await onlyNew.get(subject);
      if (await onlyNew.wasDestroyed(subject)) expect(got).toBeNull();
      else expect(got?.equals(dek)).toBe(true);
    }
    expect(await verifyKeys(db.owner, newKek)).toEqual({ verified: 4, wrongKek: 0, failed: [] });
  });

  it("leaves a tombstone exactly as it was", async () => {
    const before = (await rows()).filter((r) => r.destroyed_at);
    await rotateKek(db.owner, [newKek, oldKek]);
    expect((await rows()).filter((r) => r.destroyed_at)).toEqual(before);
    expect(before).toHaveLength(1);
  });

  it("is a no-op when run again", async () => {
    await rotateKek(db.owner, [newKek, oldKek]);
    const settled = await rows();
    expect(await rotateKek(db.owner, [newKek, oldKek])).toEqual({
      rotated: 0,
      failed: [],
      remaining: {},
    });
    expect(await rows()).toEqual(settled);
  });
});
