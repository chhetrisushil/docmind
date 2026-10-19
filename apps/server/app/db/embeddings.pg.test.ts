import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { T1, U1, seedUsers } from "../documents/testHarness";
import { migrate, setAppRolePassword } from "./migrate";
import { withTenant } from "./tenant";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "./testSupport";

const vec = (n = 768, x = "0.5") => `[${Array.from({ length: n }, () => x).join(",")}]`;

// A document and one chunk, inserted as the owner role (which bypasses RLS).
async function insertChunk(
  owner: Pool,
  o: { tenant?: string; user?: string; embedding?: { vector: string; model: string | null } } = {},
) {
  const tenant = o.tenant ?? T1;
  const doc = randomUUID();
  const chunkId = randomUUID();
  const hex = doc.replaceAll("-", "").repeat(2);
  await owner.query(
    `INSERT INTO documents (id, tenant_id, owner_id, title_enc, filename_enc, mime, size_bytes, content_address, fingerprint)
     VALUES ($1, $2, $3, '{}', '{}', 'text/plain', 1, $4, $5)`,
    [doc, tenant, o.user ?? U1, `hmac-sha256:${hex}`, hex],
  );
  await owner.query(
    `INSERT INTO chunks (id, tenant_id, document_id, ordinal, section_ordinal, text_enc, locator, token_count, embedding, embedding_model)
     VALUES ($1, $2, $3, 0, 0, '{}', '{"kind":"section","index":0}', 1, $4::vector, $5)`,
    [chunkId, tenant, doc, o.embedding?.vector ?? null, o.embedding?.model ?? null],
  );
  return { doc, chunkId };
}

describe.skipIf(!PG_URL)("chunk embeddings (needs DOCMIND_TEST_PG_URL)", () => {
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

  it("has the embedding column, pair constraint and HNSW index", async () => {
    const col = await db.owner.query(
      "SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = 'chunks'::regclass AND attname = 'embedding'",
    );
    const idx = await db.owner.query(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'chunks' AND indexname = 'chunks_embedding_hnsw'",
    );
    const pair = await db.owner.query(
      "SELECT 1 FROM pg_constraint WHERE conrelid = 'chunks'::regclass AND conname = 'chunks_embedding_pair'",
    );
    expect(col.rows.map((r) => r.t)).toEqual(["vector(768)"]);
    expect(pair.rowCount).toBe(1);
    expect(idx.rows[0].indexdef).toMatch(/USING hnsw \(embedding vector_cosine_ops\)/);
  });

  it("is owned by the migrator, not the app role, and chunks keeps row-level security", async () => {
    const { rows } = await db.owner.query(
      `SELECT (SELECT pg_get_userbyid(extowner) FROM pg_extension WHERE extname = 'vector') AS ext,
              pg_get_userbyid(c.relowner) AS tbl, c.relrowsecurity AS rls,
              (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relname = 'chunks_embedding_hnsw') AS idx,
              current_user AS me
         FROM pg_class c WHERE c.relname = 'chunks'`,
    );
    expect(rows[0].ext).toBe(rows[0].me);
    expect(rows[0].idx).toBe(rows[0].me);
    expect(rows[0].tbl).toBe(rows[0].me);
    expect(rows[0].rls).toBe(true);
  });

  it("requires a model whenever there is a vector, and exactly 768 dimensions", async () => {
    await expect(
      insertChunk(db.owner, { embedding: { vector: vec(), model: null } }),
    ).rejects.toMatchObject({ code: "23514", constraint: "chunks_embedding_pair" });
    await expect(
      insertChunk(db.owner, { embedding: { vector: vec(3), model: "m" } }),
    ).rejects.toMatchObject({ code: "22000" });
    await expect(
      insertChunk(db.owner, { embedding: { vector: vec(), model: "m" } }),
    ).resolves.toMatchObject({});
    // A model with no vector is the other half of the pair.
    const { chunkId } = await insertChunk(db.owner);
    await expect(
      db.owner.query("UPDATE chunks SET embedding_model = 'm' WHERE id = $1", [chunkId]),
    ).rejects.toMatchObject({ code: "23514", constraint: "chunks_embedding_pair" });
  });

  // F01: the owner passes without the grant, so this runs as docmind_app, who writes and searches.
  it("lets the app role write a vector and rank by cosine distance (extension functions granted)", async () => {
    const { chunkId } = await insertChunk(db.owner);
    const ranked = await withTenant(app, T1, async (tx) => {
      // The assignment coerces to vector(768): the typmod function `vector(vector,integer,boolean)`.
      await tx.query(
        "UPDATE chunks SET embedding = $1::vector, embedding_model = 'm' WHERE id = $2",
        [vec(), chunkId],
      );
      // `<=>` runs cosine_distance.
      return (
        await tx.query(
          "SELECT id FROM chunks WHERE embedding IS NOT NULL AND id = $2 ORDER BY embedding <=> $1::vector LIMIT 1",
          [vec(), chunkId],
        )
      ).rows;
    });
    expect(ranked).toEqual([{ id: chunkId }]);
    // Every member function of the extension is executable by the app (a pgvector upgrade that
    // adds functions would show up here).
    const { rows } = await db.owner.query(
      `SELECT count(*)::int AS ungranted FROM pg_proc p
         JOIN pg_depend d ON d.objid = p.oid AND d.classid = 'pg_proc'::regclass AND d.deptype = 'e'
         JOIN pg_extension e ON e.oid = d.refobjid AND e.extname = 'vector'
        WHERE p.prokind = 'f' AND NOT has_function_privilege('docmind_app', p.oid, 'EXECUTE')`,
    );
    expect(rows[0]).toEqual({ ungranted: 0 });
  });
});
