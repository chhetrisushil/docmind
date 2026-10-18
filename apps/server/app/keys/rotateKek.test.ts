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

  it("finishes after a crash: batches are atomic and a re-run takes the rest", async () => {
    let updates = 0;
    const patched = new WeakSet<object>(); // the pool hands the same client back, so wrap it once
    const crashing = {
      query: db.owner.query.bind(db.owner),
      connect: async () => {
        const client = await db.owner.connect();
        if (patched.has(client)) return client;
        patched.add(client);
        const run = client.query.bind(client) as (...args: unknown[]) => unknown;
        (client as { query: unknown }).query = (...args: unknown[]) => {
          if (
            typeof args[0] === "string" &&
            args[0].startsWith("UPDATE data_keys") &&
            ++updates === 4
          ) {
            throw new Error("crash");
          }
          return run(...args);
        };
        return client;
      },
    } as unknown as Pool;

    const before = await rows();
    await expect(rotateKek(crashing, [newKek, oldKek], 2)).rejects.toThrow("crash");
    expect(updates).toBe(4); // batch 2 had already written one row when it failed
    const after = await rows();
    const live = after.filter((r) => !r.destroyed_at);
    const done = live.filter((r) => r.kek_id === "kek-2");
    const undone = live.filter((r) => r.kek_id !== "kek-2");
    expect(done).toHaveLength(2); // the first batch committed
    expect(undone).toHaveLength(2); // the second rolled back whole, including its one written row
    for (const row of undone) {
      expect(row).toEqual(before.find((r) => r.subject_id === row.subject_id));
    }

    const rest = await rotateKek(db.owner, [newKek, oldKek], 2);
    expect(rest).toEqual({ rotated: 2, failed: [], remaining: {} });
    expect(await verifyKeys(db.owner, newKek)).toMatchObject({ verified: 4, wrongKek: 0 });
  });

  it("reports a key that will not open, and keys wrapped by an unknown KEK, and changes neither", async () => {
    const [bad, stranger] = [...deks.keys()];
    await db.owner.query("UPDATE data_keys SET wrapped_dek = $2 WHERE subject_id = $1", [
      bad,
      randomBytes(60),
    ]);
    await db.owner.query("UPDATE data_keys SET kek_id = 'kek-0' WHERE subject_id = $1", [stranger]);
    const before = (await rows()).filter((r) => r.subject_id === bad || r.subject_id === stranger);

    const result = await rotateKek(db.owner, [newKek, oldKek]);
    expect(result).toEqual({ rotated: 2, failed: [bad], remaining: { "kek-1": 1, "kek-0": 1 } });
    expect((await rows()).filter((r) => r.subject_id === bad || r.subject_id === stranger)).toEqual(
      before,
    );

    // With only the new KEK, verification still flags the bad row (by subject id) and the unknown-KEK row.
    expect(await verifyKeys(db.owner, newKek)).toEqual({ verified: 2, wrongKek: 2, failed: [] });
    const oldOnly = await verifyKeys(db.owner, oldKek);
    expect(oldOnly.failed).toEqual([bad]);
  });

  it("skips a row another transaction holds, counts it as remaining, and takes it next run", async () => {
    const [locked] = [...deks.keys()];
    const holder = await db.owner.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM data_keys WHERE subject_id = $1 FOR UPDATE", [locked]);
      const result = await rotateKek(db.owner, [newKek, oldKek]);
      expect(result).toEqual({ rotated: 3, failed: [], remaining: { "kek-1": 1 } });
      await holder.query("COMMIT");
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined); // no-op after COMMIT; frees the lock if the test failed
      holder.release();
    }
    expect(await rotateKek(db.owner, [newKek, oldKek])).toEqual({
      rotated: 1,
      failed: [],
      remaining: {},
    });
  });
});
