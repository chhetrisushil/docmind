import { PgChunkVectorStore, searchExactSql, searchSql } from "@docmind/vector-pg";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../../db/tenant";
import { PG_URL } from "../../db/testSupport";
import { insertDocument } from "../../documents/repo";
import { T1, U1, U1B, newDocument } from "../../documents/testHarness";
import { type PgFixture, startPgFixture } from "./pgFixture";

// A corpus where the nearest rows to each query belong to ANOTHER user, so only an index scan that keeps
// going past its first `ef_search` candidates (hnsw.iterative_scan) can return the owner's rows:
//   per query: 150 near-duplicates in the other user's document (cosine ~0.999, more than ef_search),
//              30 in the owner's documents D1..D5 (~0.96), 5 in the owner's target document D0 (~0.71);
//   plus 200 random chunks in each of the owner's documents (cosine ~0).
const DIM = 768;
const QUERIES = 10;
const EF = 100;

/** mulberry32: a seeded generator. The data (vectors and ids) is seeded; HNSW graph construction is not. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** A uuid-shaped id drawn from the seeded generator. */
const uid = (r: () => number): string => {
  const h = Array.from({ length: 32 }, () => Math.floor(r() * 16).toString(16)).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20)}`;
};
const unit = (v: number[]): number[] => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => Math.fround(x / n));
};
const noise = (r: () => number) => Array.from({ length: DIM }, () => r() - 0.5);
/** cosine to `q` is 1 / sqrt(1 + t^2). */
const near = (q: number[], t: number, r: () => number): number[] => {
  const n = unit(noise(r));
  return unit(q.map((x, i) => x + t * (n[i] as number)));
};
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] as number), 0);

describe.skipIf(!PG_URL)(
  "HNSW iterative search (needs DOCMIND_TEST_PG_URL and pgvector 0.8)",
  () => {
    let fx: PgFixture;
    let app: Pool;
    let store: PgChunkVectorStore;
    const scope = { tenantId: T1, ownerId: U1 };
    const vec = new Map<string, number[]>(); // chunk id -> vector, the owner's chunks only
    const docs: string[] = []; // D0..D5 of the owner
    const queries: number[][] = [];
    const planted = new Map<number, { target: string[]; others: string[] }>();

    async function addChunks(documentId: string, rows: { id: string; v: number[] }[]) {
      for (let i = 0; i < rows.length; i += 250) {
        const part = rows.slice(i, i + 250);
        await fx.db.owner.query(
          `INSERT INTO chunks (id, tenant_id, document_id, ordinal, section_ordinal, text_enc, locator, token_count, embedding, embedding_model)
         SELECT u.id, $1, $2, u.ord + $3, 0, '{}', '{"kind":"section","index":0}', 1, u.v::vector, 'm'
           FROM unnest($4::uuid[], $5::int[], $6::text[]) AS u(id, ord, v)`,
          [
            T1,
            documentId,
            i,
            part.map((r) => r.id),
            part.map((_, k) => k),
            part.map((r) => `[${r.v.map((x) => x.toPrecision(9)).join(",")}]`),
          ],
        );
      }
    }

    beforeAll(async () => {
      fx = await startPgFixture();
      app = fx.app;
      // The planner prefers a sort over a scan of a few thousand rows; production tables are large enough
      // for it to pick the index. Forbidding the sort makes the HNSW scan the only ordered path, which is
      // the path these tests are about.
      store = new PgChunkVectorStore({
        modelId: "m",
        dimensions: DIM,
        efSearch: EF,
        tenant: (t, fn) =>
          withTenant(app, t, async (tx) => {
            await tx.query("SELECT set_config('enable_sort', 'off', true)");
            return fn(tx);
          }),
      });
      const r = rng(7);
      const mk = async (owner: string, n: number) => {
        const d = await newDocument(fx.fields, T1, owner, n.toString(16).padStart(64, "0"));
        await withTenant(app, T1, (tx) => insertDocument(tx, d));
        return d.id;
      };
      for (let n = 0; n < 6; n++) docs.push(await mk(U1, n + 1));
      const theirs = await mk(U1B, 100);
      for (let k = 0; k < QUERIES; k++) queries.push(unit(noise(r)));
      const mine = new Map<string, { id: string; v: number[] }[]>(docs.map((d) => [d, []]));
      const theirRows: { id: string; v: number[] }[] = [];
      for (const d of docs)
        for (let i = 0; i < 200; i++) mine.get(d)?.push({ id: uid(r), v: unit(noise(r)) });
      for (const [k, q] of queries.entries()) {
        const p = { target: [] as string[], others: [] as string[] };
        for (let i = 0; i < 5; i++) {
          const row = { id: uid(r), v: near(q, 1, r) };
          mine.get(docs[0] as string)?.push(row);
          p.target.push(row.id);
        }
        for (let i = 0; i < 30; i++) {
          const row = { id: uid(r), v: near(q, 0.3, r) };
          mine.get(docs[1 + (i % 5)] as string)?.push(row);
          p.others.push(row.id);
        }
        for (let i = 0; i < 150; i++) theirRows.push({ id: uid(r), v: near(q, 0.05, r) });
        planted.set(k, p);
      }
      for (const [d, rows] of mine) {
        await addChunks(d, rows);
        for (const row of rows) vec.set(row.id, row.v);
      }
      await addChunks(theirs, theirRows);
      await fx.db.owner.query("ANALYZE chunks");
      await fx.db.owner.query("ANALYZE documents");
    }, 120_000);
    afterAll(async () => {
      await fx?.close();
    });

    it("finds the owner's nearest rows although more than ef_search nearer rows belong to someone else (recall@10 vs an exact scan)", async () => {
      let hit = 0;
      for (const [k, q] of queries.entries()) {
        const exact = [...vec]
          .map(([id, v]) => ({ id, s: dot(q, v) }))
          .sort((a, b) => b.s - a.s)
          .slice(0, 10)
          .map((x) => x.id);
        const got = (await store.search(scope, q, 10)).map((h) => h.chunkId);
        expect(
          got.every((id) => vec.has(id)),
          `query ${k} returned a row of another owner`,
        ).toBe(true);
        hit += exact.filter((id) => got.includes(id)).length;
      }
      expect(hit / (QUERIES * 10)).toBeGreaterThanOrEqual(0.9);
    });

    it("finds the target document's rows when the search is restricted to it, and nothing outside it", async () => {
      let found = 0;
      for (const [k, q] of queries.entries()) {
        const hits = await store.search(scope, q, 10, 0.5, { documentIds: [docs[0] as string] });
        const wanted = new Set(planted.get(k)?.target);
        // everything returned is the target document's and clears the floor: planted rows only
        expect(hits.every((h) => wanted.has(h.chunkId) && h.score > 0.6)).toBe(true);
        found += hits.length;
      }
      expect(found / (QUERIES * 5)).toBeGreaterThanOrEqual(0.9);
    });

    it("would miss them without the iterative scan (a control: the test data does what it claims)", async () => {
      const rows = await withTenant(app, T1, async (tx) => {
        await tx.query("SELECT set_config('enable_sort', 'off', true)");
        await tx.query("SELECT set_config('hnsw.iterative_scan', 'off', true)");
        await tx.query("SELECT set_config('hnsw.ef_search', $1, true)", [String(EF)]);
        const q = `[${(queries[0] as number[]).join(",")}]`;
        return (await tx.query(searchSql(false), [q, U1, "m", 10, 2])).rows;
      });
      expect(rows).toEqual([]);
    });

    it("a NaN cosine distance (zero vector) fails `distance <= $n`, so searchSql needs no vector_norm", async () => {
      const row = await withTenant(app, T1, async (tx) => {
        const r = await tx.query(
          "SELECT ('[0,0,1]'::vector <=> '[1,0,0]'::vector) AS d, ('[0,0,0]'::vector <=> '[1,0,0]'::vector) AS z, (('[0,0,0]'::vector <=> '[1,0,0]'::vector) <= 3) AS le, (('[0,0,0]'::vector <=> '[1,0,0]'::vector) <= 'Infinity'::float8) AS le_inf",
        );
        return r.rows[0];
      });
      expect(row.d).toBe(1);
      expect(row.z).toBeNaN();
      expect(row.le).toBe(false);
      expect(row.le_inf).toBe(false);
    });

    it("an unfiltered search can be cut short by the index scan budget; the document-filtered one is exact", async () => {
      const q = queries[0] as number[];
      const lit = `[${q.join(",")}]`;
      const run = async (sql: string, params: unknown[]) =>
        withTenant(app, T1, async (tx) => {
          await tx.query("SELECT set_config('enable_sort', 'off', true)");
          await tx.query("SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true)");
          await tx.query("SELECT set_config('hnsw.ef_search', '10', true)");
          await tx.query("SELECT set_config('hnsw.max_scan_tuples', '1', true)");
          return (await tx.query(sql, params)).rows;
        });
      const cut = await run(searchSql(false), [lit, U1, "m", 10, 2]);
      expect(cut.length).toBeLessThan(10);
      const exact = await run(searchExactSql, [lit, U1, "m", 10, 2, [docs[0]]]);
      expect(exact).toHaveLength(10);
      // the document's five planted rows are its nearest, then its random rows
      expect(
        exact
          .slice(0, 5)
          .map((r) => r.id)
          .sort(),
      ).toEqual([...(planted.get(0)?.target ?? [])].sort());
      // and through the store, with the same low budget
      const low = new PgChunkVectorStore({
        modelId: "m",
        dimensions: DIM,
        efSearch: 10,
        tenant: (t, fn) =>
          withTenant(app, t, async (tx) => {
            await tx.query("SELECT set_config('hnsw.max_scan_tuples', '1', true)");
            return fn(tx);
          }),
      });
      expect((await low.search(scope, q, 10)).length).toBeLessThan(10);
      const filtered = await low.search(scope, q, 10, undefined, {
        documentIds: [docs[0] as string],
      });
      expect(filtered).toHaveLength(10);
    });

    it("plans the unfiltered search on the HNSW index and the document-filtered one on an exact sort", async () => {
      const q = `[${(queries[0] as number[]).join(",")}]`;
      const explain = (sql: string, params: unknown[]) =>
        withTenant(app, T1, async (tx) => {
          await tx.query("SELECT set_config('enable_sort', 'off', true)");
          const res = await tx.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
          return JSON.stringify(res.rows[0]["QUERY PLAN"]);
        });
      const plain = await explain(searchSql(false), [q, U1, "m", 24, 2]);
      console.log(`EXPLAIN unfiltered: ${(/"Index Name":"[a-z_]+"/.exec(plain) ?? ["none"])[0]}`);
      expect(plain).toContain('"Index Name":"chunks_embedding_hnsw"');
      const filtered = await explain(searchExactSql, [q, U1, "m", 24, 2, [docs[0]]]);
      console.log(`EXPLAIN filtered: ${(/"Node Type":"Sort"/.exec(filtered) ?? ["no sort"])[0]}`);
      expect(filtered).not.toContain("chunks_embedding_hnsw");
      expect(filtered).toContain('"Node Type":"Sort"');
    });
  },
);
