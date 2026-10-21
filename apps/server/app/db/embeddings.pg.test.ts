import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { T1, T2, U1, U2, seedUsers } from "../documents/testHarness";
import { MIGRATIONS_DIR, migrate, setAppRolePassword } from "./migrate";
import { withTenant } from "./tenant";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "./testSupport";

// The non-extension functions docmind_app may execute: granted on purpose by 0002, 0005, 0006, 0007, 0015, 0016, 0024, 0025.
const APP_EXECUTABLE = [
  "app_tenant_id()",
  "auth_find_login(text)",
  "auth_find_session(text)",
  "auth_purge_expired_sessions()",
  "auth_sign_up(uuid,uuid,text,text)",
  "docmind_delete_empty_tenant(uuid)",
  "docmind_erasure_mark(uuid,text,boolean)",
  "docmind_erasure_pending(text,uuid,integer)",
  "docmind_erasure_status(bytea)",
  "docmind_orphan_statuses(integer)",
  "docmind_stale_uploads_v2(interval,interval,integer)",
  "key_destroy(text)",
  "key_get(text)",
  "key_put(text,bytea,text)",
  "key_was_destroyed(text)",
  "throttle_clear(text)",
  "throttle_fail(text,integer,integer,integer,integer)",
  "throttle_purge()",
  "throttle_retry_after(text[])",
];

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
  // I1: the probe function exists BEFORE 0014 runs (it sorts between 0013 and 0014), so a grant that
  // is wider than the vector extension's members would reach it.
  it("grants EXECUTE to the app only on the vector extension's functions, nothing else", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dm-mig-probe-"));
    const scratch = await createTestDb();
    try {
      for (const f of readdirSync(MIGRATIONS_DIR))
        copyFileSync(join(MIGRATIONS_DIR, f), join(dir, f));
      writeFileSync(
        join(dir, "0013_zz_probe.sql"),
        "CREATE FUNCTION embed_probe() RETURNS int LANGUAGE sql AS 'SELECT 1';",
      );
      const applied = await migrate(scratch.owner, dir);
      expect(applied.indexOf("0013_zz_probe.sql")).toBeLessThan(
        applied.indexOf("0014_chunk_embeddings.sql"),
      );
      const { rows } = await scratch.owner.query<{ f: string }>(
        `SELECT p.oid::regprocedure::text AS f FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
            AND has_function_privilege('docmind_app', p.oid, 'EXECUTE')
            AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid
                              AND d.classid = 'pg_proc'::regclass AND d.deptype = 'e')
          ORDER BY 1`,
      );
      expect(rows.map((r) => r.f)).toEqual(APP_EXECUTABLE);
      const probe = await scratch.owner.query(
        `SELECT has_function_privilege('docmind_app', 'embed_probe()', 'EXECUTE') AS app,
                has_function_privilege('docmind_loom', 'cosine_distance(vector,vector)', 'EXECUTE') AS loom`,
      );
      expect(probe.rows[0]).toEqual({ app: false, loom: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await scratch.drop();
    }
  });

  it("lets the app role read only its own tenant's embeddings", async () => {
    const mine = await insertChunk(db.owner, { embedding: { vector: vec(), model: "m" } });
    const theirs = await insertChunk(db.owner, {
      tenant: T2,
      user: U2,
      embedding: { vector: vec(), model: "m" },
    });
    const seen = async (tenant: string) =>
      withTenant(app, tenant, async (tx) =>
        (
          await tx.query(
            "SELECT id FROM chunks WHERE embedding IS NOT NULL ORDER BY embedding <=> $1::vector",
            [vec()],
          )
        ).rows.map((r) => r.id),
      );
    const t1 = await seen(T1);
    const t2 = await seen(T2);
    expect(t1).toContain(mine.chunkId);
    expect(t1).not.toContain(theirs.chunkId);
    expect(t2).toEqual([theirs.chunkId]);
  });
});
