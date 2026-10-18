import { createSecretKey, randomBytes, randomUUID } from "node:crypto";
import { type Kek, PostgresKeyStore } from "@docmind/keystore-pg";
import { runKeyStoreConformance } from "@loom/conformance";
import type { KeyStore } from "@loom/plugin-crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword } from "../db/migrate";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";

const kek: Kek = { id: "kek-1", key: createSecretKey(randomBytes(32)) };

describe.skipIf(!PG_URL)("PostgresKeyStore (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;

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

  // The contract names subjects like "s1"; a random prefix per instance keeps the tests apart.
  const isolated = (inner: KeyStore): KeyStore => {
    const ns = `${randomUUID()}:`;
    return {
      durable: inner.durable,
      getOrCreate: (s) => inner.getOrCreate(ns + s),
      get: (s) => inner.get(ns + s),
      destroy: (s) => inner.destroy(ns + s),
      wasDestroyed: (s) => (inner.wasDestroyed as NonNullable<KeyStore["wasDestroyed"]>)(ns + s),
    };
  };
  runKeyStoreConformance(() => isolated(new PostgresKeyStore(app, [kek])), "PostgresKeyStore");

  const fresh = () => `subject-${randomUUID()}`;
  const rowOf = async (subject: string) =>
    (await db.owner.query("SELECT * FROM data_keys WHERE subject_id = $1", [subject])).rows[0];

  it("refuses an empty KEK list and duplicate KEK ids", () => {
    expect(() => new PostgresKeyStore(app, [] as unknown as [Kek])).toThrow(
      "at least one KEK is required",
    );
    expect(() => new PostgresKeyStore(app, [kek, { ...kek }])).toThrow('duplicate KEK id "kek-1"');
  });

  it("gives a new instance the same key: the key survives a restart", async () => {
    const subject = fresh();
    const key = await new PostgresKeyStore(app, [kek]).getOrCreate(subject);
    expect((await new PostgresKeyStore(app, [kek]).get(subject))?.equals(key)).toBe(true);
  });

  it("stores the key wrapped, never in the clear", async () => {
    const subject = fresh();
    const key = await new PostgresKeyStore(app, [kek]).getOrCreate(subject);
    const row = await rowOf(subject);
    expect(row.kek_id).toBe("kek-1");
    expect(row.wrapped_dek).toHaveLength(60);
    expect(row.wrapped_dek.includes(key)).toBe(false);
  });

  it("hands two racing creators the same key", async () => {
    const subject = fresh();
    const store = new PostgresKeyStore(app, [kek]);
    const keys = await Promise.all(Array.from({ length: 8 }, () => store.getOrCreate(subject)));
    expect(new Set(keys.map((k) => k.toString("hex"))).size).toBe(1);
  });

  it("leaves only a tombstone: the live row holds no key material after destroy", async () => {
    const subject = fresh();
    const store = new PostgresKeyStore(app, [kek]);
    await store.getOrCreate(subject);
    await store.destroy(subject);
    const row = await rowOf(subject);
    expect([row.wrapped_dek, row.kek_id]).toEqual([null, null]);
    expect(row.destroyed_at).toBeInstanceOf(Date);
    await expect(store.getOrCreate(subject)).rejects.toThrow(/destroyed/);
  });

  it("stays destroyed even when the database is asked for a key directly", async () => {
    const subject = fresh();
    await new PostgresKeyStore(app, [kek]).destroy(subject);
    await expect(
      app.query("SELECT * FROM public.key_put($1, $2, 'kek-1')", [subject, randomBytes(60)]),
    ).rejects.toThrow(/destroyed/);
  });

  it("does not open a wrapped key copied onto another subject, or under another KEK", async () => {
    const [a, b] = [fresh(), fresh()];
    const store = new PostgresKeyStore(app, [kek]);
    await store.getOrCreate(a);
    await store.getOrCreate(b);
    await db.owner.query(
      "UPDATE data_keys SET wrapped_dek = (SELECT wrapped_dek FROM data_keys WHERE subject_id = $1) WHERE subject_id = $2",
      [a, b],
    );
    await expect(store.get(b)).rejects.toThrow();
    const other: Kek = { id: "kek-1", key: createSecretKey(randomBytes(32)) };
    await expect(new PostgresKeyStore(app, [other]).get(a)).rejects.toThrow();
  });

  it("opens keys written under an earlier KEK after rotation, and names an unknown one", async () => {
    const subject = fresh();
    const old = await new PostgresKeyStore(app, [kek]).getOrCreate(subject);
    const next: Kek = { id: "kek-2", key: createSecretKey(randomBytes(32)) };
    expect((await new PostgresKeyStore(app, [next, kek]).get(subject))?.equals(old)).toBe(true);
    await expect(new PostgresKeyStore(app, [next]).get(subject)).rejects.toThrow(
      /unknown KEK "kek-1"/,
    );
  });

  it("is a table the app role cannot read, only reach through the functions", async () => {
    await expect(app.query("SELECT * FROM data_keys")).rejects.toThrow(/permission denied/);
    await expect(app.query("DELETE FROM data_keys")).rejects.toThrow(/permission denied/);
  });
});
