import { randomUUID } from "node:crypto";
import { PgChunkVectorStore, VectorSchemaError } from "@docmind/vector-pg";
import {
  A,
  B,
  DOC_A,
  DOC_B,
  type VectorHarness,
  runChunkVectorStoreConformance,
} from "@docmind/vector-pg/testing";
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

  const basis = (i: number): number[] => {
    const v = new Array<number>(768).fill(0);
    v[i] = 1;
    return v;
  };
  const stored = async (id: string) =>
    (await db.owner.query("SELECT embedding IS NOT NULL AS has FROM chunks WHERE id = $1", [id]))
      .rows[0]?.has;

  it("two owners in one tenant: neither can see or write the other's chunk", async () => {
    const store = make("m1");
    const a = randomUUID();
    const b = randomUUID();
    await seed(A, DOC_A, [a]);
    await seed(B, DOC_B, [b]);
    expect(await store.missing(B, DOC_A, 10)).toEqual([]); // while A's chunk has no vector yet
    // B writes against A's document and chunk, and against its own document with A's chunk id.
    expect(await store.upsert(B, DOC_A, [{ chunkId: a, vector: basis(0) }])).toEqual({
      written: 0,
      missing: [a],
    });
    expect(await store.upsert(B, DOC_B, [{ chunkId: a, vector: basis(0) }])).toEqual({
      written: 0,
      missing: [a],
    });
    expect(await stored(a)).toBe(false);
    expect(await store.upsert(A, DOC_B, [{ chunkId: b, vector: basis(0) }])).toEqual({
      written: 0,
      missing: [b],
    });
    expect(await stored(b)).toBe(false);
    // Each owner writes their own and then sees only their own.
    await store.upsert(A, DOC_A, [{ chunkId: a, vector: basis(0) }]);
    await store.upsert(B, DOC_B, [{ chunkId: b, vector: basis(0) }]);
    expect((await store.search(A, basis(0), 10)).map((h) => h.chunkId)).toEqual([a]);
    expect((await store.search(B, basis(0), 10)).map((h) => h.chunkId)).toEqual([b]);
  });

  it("writes a batch larger than any parameter limit in one call", async () => {
    const store = make("m1");
    const ids = Array.from({ length: 300 }, () => randomUUID());
    await seed(A, DOC_A, ids);
    const items = ids.map((chunkId, i) => ({ chunkId, vector: basis(i % 768) }));
    expect(await store.upsert(A, DOC_A, items)).toEqual({ written: 300, missing: [] });
    expect(await store.missing(A, DOC_A, 1000)).toEqual([]);
  });

  it("verify() accepts the column it was built for and rejects another size", async () => {
    await expect(make("m").verify(randomUUID())).resolves.toBeUndefined();
    const err = await make("m", 8)
      .verify(randomUUID())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VectorSchemaError);
    expect((err as Error).message).toMatch(/^chunks\.embedding is not vector\(8\)$/);
  });

  it("a malformed id is refused before any transaction with a fixed message that omits the value", async () => {
    const store = make("m1");
    const bad = "not-a-uuid-SECRET";
    const attempts: [string, () => Promise<unknown>][] = [
      ["chunkId", () => store.upsert(A, DOC_A, [{ chunkId: bad, vector: basis(0) }])],
      ["documentId", () => store.upsert(A, bad, [])],
      ["ownerId", () => store.missing({ ...A, ownerId: bad }, DOC_A, 1)],
      ["ownerId", () => store.search({ ...A, ownerId: bad }, basis(0), 1)],
      ["tenantId", () => store.search({ ...A, tenantId: bad }, basis(0), 1)],
    ];
    for (const [name, run] of attempts) {
      const err = await run().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe(`PgChunkVectorStore: ${name} must be a uuid`);
      expect((err as Error).message).not.toContain(bad);
    }
  });
});
