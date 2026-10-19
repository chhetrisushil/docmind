import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { Pool } from "pg";
import { FieldCrypto } from "../../crypto/fields";
import { migrate, setAppRolePassword } from "../../db/migrate";
import { withTenant } from "../../db/tenant";
import { APP_PASSWORD, type TestDb, createTestDb } from "../../db/testSupport";
import { insertDocument } from "../../documents/repo";
import { T1, U1, newDocument, seedUsers } from "../../documents/testHarness";
import type { IngestStartInput } from "./flow";

export interface PgFixture {
  db: TestDb;
  app: Pool;
  keys: InMemoryKeyStore;
  fields: FieldCrypto;
  doc(fingerprint: string): Promise<IngestStartInput>;
  close(): Promise<void>;
}

export async function startPgFixture(): Promise<PgFixture> {
  const db = await createTestDb();
  await migrate(db.owner);
  await setAppRolePassword(db.owner, APP_PASSWORD);
  await seedUsers(db.owner);
  const app = new Pool({ connectionString: db.appUrl });
  const keys = new InMemoryKeyStore();
  const fields = new FieldCrypto(keys);
  return {
    db,
    app,
    keys,
    fields,
    async doc(fingerprint) {
      const d = await newDocument(fields, T1, U1, fingerprint);
      await withTenant(app, T1, (tx) => insertDocument(tx, d));
      return { tenantId: T1, userId: U1, documentId: d.id };
    },
    async close() {
      await app.end();
      await db.drop();
    },
  };
}
