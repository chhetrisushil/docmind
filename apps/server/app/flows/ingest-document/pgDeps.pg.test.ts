import { randomUUID } from "node:crypto";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FieldCrypto } from "../../crypto/fields";
import { migrate, setAppRolePassword } from "../../db/migrate";
import { withTenant } from "../../db/tenant";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../../db/testSupport";
import { insertDocument } from "../../documents/repo";
import { T1, T2, U1, U1B, newDocument, seedUsers } from "../../documents/testHarness";
import { pgIngestDeps } from "./pgDeps";

describe.skipIf(!PG_URL)("pgIngestDeps (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;
  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await seedUsers(db.owner);
    app = new Pool({ connectionString: db.appUrl });
  });
  afterAll(async () => {
    await app?.end();
    await db?.drop();
  });

  it("sees a document for its owner only, in its own tenant only", async () => {
    const fields = new FieldCrypto(new InMemoryKeyStore());
    const doc = await newDocument(fields, T1, U1, "e".repeat(64));
    await withTenant(app, T1, (tx) => insertDocument(tx, doc));
    const id = doc.id;
    const deps = pgIngestDeps(app);
    expect(await deps.documentExists({ tenantId: T1, userId: U1, documentId: id })).toBe(true);
    expect(await deps.documentExists({ tenantId: T1, userId: U1B, documentId: id })).toBe(false); // colleague
    expect(await deps.documentExists({ tenantId: T2, userId: U1, documentId: id })).toBe(false); // other tenant
    expect(await deps.documentExists({ tenantId: T1, userId: U1, documentId: randomUUID() })).toBe(
      false,
    );
    await db.owner.query("DELETE FROM documents WHERE id = $1", [id]);
    expect(await deps.documentExists({ tenantId: T1, userId: U1, documentId: id })).toBe(false); // gone
  });

  it("fails with a fixed message that carries none of the ids", async () => {
    const bad = "not-a-uuid-marker";
    const err = await pgIngestDeps(app)
      .documentExists({ tenantId: T1, userId: U1, documentId: bad })
      .catch((e: unknown) => e);
    expect(err).toEqual(new Error("document existence check failed"));
    expect((err as Error).message).not.toContain(bad);
    expect((err as Error).cause).toBeUndefined();
  });
});
