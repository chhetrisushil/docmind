import { createSecretKey, randomBytes } from "node:crypto";
import { PostgresKeyStore } from "@docmind/keystore-pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./config";
import { migrate, setAppRolePassword, setRolePassword } from "./db/migrate";
import { APP_PASSWORD, LOOM_PASSWORD, PG_URL, type TestDb, createTestDb } from "./db/testSupport";
import { createDurableStorage } from "./storage";

describe("buildApp", () => {
  it("composes under strict mode on in-memory storage", async () => {
    const app = buildApp({ kind: "memory" });
    await app.close();
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
