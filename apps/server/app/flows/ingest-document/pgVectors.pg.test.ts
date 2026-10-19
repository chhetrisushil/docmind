import { PgChunkVectorStore } from "@docmind/vector-pg";
import { type VectorHarness, runChunkVectorStoreConformance } from "@docmind/vector-pg/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword } from "../../db/migrate";
import { withTenant } from "../../db/tenant";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../../db/testSupport";

describe.skipIf(!PG_URL)("PgChunkVectorStore (needs DOCMIND_TEST_PG_URL and pgvector)", () => {
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

  const make = (modelId: string, dimensions = 768) =>
    new PgChunkVectorStore({ tenant: (t, fn) => withTenant(app, t, fn), modelId, dimensions });

  // The tenant, user, document and chunk rows the kit asks for, written as the owner role. The kit
  // reuses DOC_A across its cases in this one database, and chunks are unique on (tenant, document,
  // ordinal), so each seed replaces the document's chunks (F02): a case then sees exactly its own.
  const seed: VectorHarness["seed"] = async (scope, documentId, ids) => {
    const hex = documentId.replaceAll("-", "").repeat(2);
    await db.owner.query(
      "INSERT INTO tenants (id, name) VALUES ($1, 'kit') ON CONFLICT DO NOTHING",
      [scope.tenantId],
    );
    await db.owner.query(
      "INSERT INTO users (id, tenant_id, email, password_hash) VALUES ($1, $2, $3, 'x') ON CONFLICT DO NOTHING",
      [scope.ownerId, scope.tenantId, `${scope.ownerId}@example.com`],
    );
    await db.owner.query(
      `INSERT INTO documents (id, tenant_id, owner_id, title_enc, filename_enc, mime, size_bytes, content_address, fingerprint)
       VALUES ($1, $2, $3, '{}', '{}', 'text/plain', 1, $4, $5) ON CONFLICT DO NOTHING`,
      [documentId, scope.tenantId, scope.ownerId, `hmac-sha256:${hex}`, hex],
    );
    // Replace, keeping the rows (and vectors) of ids that stay: the kit's twin keeps a surviving
    // chunk's vector. Park the survivors' ordinals out of the way (the unique key is not deferrable).
    await db.owner.query(
      "DELETE FROM chunks WHERE document_id = $1 AND NOT (id = ANY($2::uuid[]))",
      [documentId, ids],
    );
    await db.owner.query("UPDATE chunks SET ordinal = ordinal + 1000000 WHERE document_id = $1", [
      documentId,
    ]);
    for (const [ordinal, id] of ids.entries()) {
      await db.owner.query(
        `INSERT INTO chunks (id, tenant_id, document_id, ordinal, section_ordinal, text_enc, locator, token_count)
         VALUES ($1, $2, $3, $4, 0, '{}', '{"kind":"section","index":0}', 1)
         ON CONFLICT (id) DO UPDATE SET ordinal = EXCLUDED.ordinal`,
        [id, scope.tenantId, documentId, ordinal],
      );
    }
  };

  runChunkVectorStoreConformance(
    async () => ({ store: make("m1"), withModel: (m) => make(m), seed }),
    "PgChunkVectorStore",
  );
});
