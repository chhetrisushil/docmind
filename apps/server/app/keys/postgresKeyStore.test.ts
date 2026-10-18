import { createSecretKey, randomBytes, randomUUID } from "node:crypto";
import { PostgresKeyStore } from "@docmind/keystore-pg";
import { runKeyStoreConformance } from "@loom/conformance";
import type { KeyStore } from "@loom/plugin-crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe } from "vitest";
import { migrate, setAppRolePassword } from "../db/migrate";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";

const kek = { id: "kek-1", key: createSecretKey(randomBytes(32)) };

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
});
