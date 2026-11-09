import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EntityKeys } from "../../crypto/entityKeys";
import { type FieldCrypto, FieldKeyStoreError } from "../../crypto/fields";
import { withTenant } from "../../db/tenant";
import { PG_URL } from "../../db/testSupport";
import { T1, T2, U1, U1B } from "../../documents/testHarness";
import { chunkIdFor } from "../ingest-document/chunker";
import { DocumentGoneError } from "../ingest-document/errors";
import { PgChunkStore } from "../ingest-document/pgChunks";
import { PgEntityStore } from "../ingest-document/pgEntities";
import { type PgFixture, startPgFixture } from "../ingest-document/pgFixture";
import { CANDIDATES_SQL, MENTIONS_SQL, PgStructureReader } from "./pgStructure";

const chunk = (ordinal: number, sectionOrdinal: number, headingPath: string[]) => ({
  ordinal,
  sectionOrdinal,
  headingPath,
  text: `Zebra passage text ${ordinal}`,
  tokenCount: 4,
  locator: { kind: "chars" as const, start: ordinal * 10, end: ordinal * 10 + 5 },
});

describe.skipIf(!PG_URL)("PgStructureReader (needs DOCMIND_TEST_PG_URL)", () => {
  let fx: PgFixture;
  beforeAll(async () => {
    fx = await startPgFixture();
  });
  afterAll(async () => {
    await fx?.close();
  });

  async function seed(fp: string, headings: string[][]) {
    const ref = await fx.doc(fp);
    await new PgChunkStore(fx.app, fx.fields).replace(
      ref,
      headings.map((path, i) => chunk(i, i, path)),
    );
    return ref;
  }
  const reader = (fields: FieldCrypto = fx.fields) => new PgStructureReader(fx.app, fields);
  const entities = () => new PgEntityStore(fx.app, fx.fields, new EntityKeys(fx.keys));

  it("reads each passage's section and opened heading path in passage order, and the title", async () => {
    const ref = await seed("a".repeat(64), [[], ["Intro"], ["Methods"], ["Methods", "Data"]]);
    const rows = await reader().headings(ref);
    expect(rows?.map((r) => [r.chunkId, r.sectionOrdinal, r.headingPath])).toEqual([
      [chunkIdFor(ref.documentId, 0), 0, []],
      [chunkIdFor(ref.documentId, 1), 1, ["Intro"]],
      [chunkIdFor(ref.documentId, 2), 2, ["Methods"]],
      [chunkIdFor(ref.documentId, 3), 3, ["Methods", "Data"]],
    ]);
    expect(await reader().title(ref)).toBe("Quarterly report"); // the fixture document's title, opened under the owner's key
  });

  it("reads one row per section (its first passage, with the section's passage count) and opens only those", async () => {
    const ref = await fx.doc("8".repeat(64));
    // 6 passages in 3 sections: ordinals 0..2 -> section 0 (preamble), 3..4 -> section 1, 5 -> section 2.
    const layout: [number, string[]][] = [
      [0, []],
      [0, []],
      [0, []],
      [1, ["Intro"]],
      [1, ["Intro"]],
      [2, ["Intro", "Scope"]],
    ];
    await new PgChunkStore(fx.app, fx.fields).replace(
      ref,
      layout.map(([section, path], i) => chunk(i, section, path)),
    );
    let opened = 0;
    const counting = {
      forUser: (u: string) => {
        const inner = fx.fields.forUser(u);
        return new Proxy(inner, {
          get: (t, prop) =>
            prop === "open"
              ? async (...a: unknown[]) => {
                  opened++;
                  return (t.open as (...x: unknown[]) => Promise<unknown>)(...a);
                }
              : Reflect.get(t, prop),
        });
      },
    } as unknown as FieldCrypto;
    const rows = await reader(counting).headings(ref);
    expect(rows?.map((r) => [r.chunkId, r.sectionOrdinal, r.headingPath, r.passages])).toEqual([
      [chunkIdFor(ref.documentId, 0), 0, [], 3],
      [chunkIdFor(ref.documentId, 3), 1, ["Intro"], 2],
      [chunkIdFor(ref.documentId, 5), 2, ["Intro", "Scope"], 1],
    ]);
    expect(opened).toBe(3);
  });

  it("is owner-scoped: another user's document is gone", async () => {
    const ref = await seed("b".repeat(64), [["A"]]);
    const other = { ...ref, userId: U1B };
    await expect(reader().headings(other)).rejects.toBeInstanceOf(DocumentGoneError);
    await expect(reader().title(other)).rejects.toBeInstanceOf(DocumentGoneError);
    await expect(reader().entities(other)).resolves.toEqual([]);
    await expect(reader().mentions(other, [randomUUID()])).resolves.toEqual([]);
  });

  it("returns null when a passage does not open, and rethrows a key-store outage", async () => {
    const ref = await seed("c".repeat(64), [["A"], ["B"]]);
    await fx.db.owner.query("UPDATE chunks SET text_enc = '{\"x\":1}'::jsonb WHERE id = $1", [
      chunkIdFor(ref.documentId, 0),
    ]);
    expect(await reader().headings(ref)).toBeNull();
    const down = {
      forUser: () => ({
        open: async () => {
          throw new FieldKeyStoreError();
        },
        openText: async () => {
          throw new FieldKeyStoreError();
        },
      }),
    } as unknown as FieldCrypto;
    await expect(reader(down).headings(ref)).rejects.toBeInstanceOf(FieldKeyStoreError);
    await expect(reader(down).title(ref)).rejects.toBeInstanceOf(FieldKeyStoreError);
  });

  it("counts this document's passages per entity, ranks them, and reads the kept entities' passages", async () => {
    const ref = await seed("d".repeat(64), [["A"], ["B"], ["C"], ["D"]]);
    const other = await seed("e".repeat(64), [["A"]]);
    const ids = [0, 1, 2, 3].map((i) => chunkIdFor(ref.documentId, i));
    await entities().replaceForDocument(ref, [
      { name: "Acme Ltd", kind: "organization", chunkIds: [ids[0], ids[1], ids[2]] as string[] },
      { name: "Bolt Inc", kind: "organization", chunkIds: [ids[1], ids[2]] as string[] },
      { name: "Cora", kind: "person", chunkIds: [ids[3]] as string[] },
    ]);
    // Acme also appears in another document: those passages must not count here.
    await entities().replaceForDocument(other, [
      { name: "Acme Ltd", kind: "organization", chunkIds: [chunkIdFor(other.documentId, 0)] },
    ]);
    const got = await reader().entities(ref);
    expect(got?.map((e) => [e.name, e.kind, e.passages])).toEqual([
      ["Acme Ltd", "organization", 3],
      ["Bolt Inc", "organization", 2],
      ["Cora", "person", 1],
    ]);
    const acme = got?.[0]?.id as string;
    const bolt = got?.[1]?.id as string;
    const mentions = await reader().mentions(ref, [acme, bolt]);
    // In passage order. Within one passage the order is by entity id (a random UUID), so it is not asserted:
    // the pairs are compared after sorting by (ordinal, name) (P6).
    expect(mentions.map((m) => m.ordinal)).toEqual(
      [...mentions.map((m) => m.ordinal)].sort((a, b) => a - b),
    );
    const nameOf = new Map(got?.map((e) => [e.id, e.name]));
    const pairs = mentions
      .map((m) => [m.ordinal, nameOf.get(m.entityId) as string] as const)
      .sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    expect(pairs).toEqual([
      [0, "Acme Ltd"],
      [1, "Acme Ltd"],
      [1, "Bolt Inc"],
      [2, "Acme Ltd"],
      [2, "Bolt Inc"],
    ]);
    expect(mentions.map((m) => m.chunkId).sort()).toEqual(
      [ids[0], ids[1], ids[1], ids[2], ids[2]].sort(),
    );
  });

  it("refuses more entity ids than the candidate cap, so the LATERAL limit can never truncate", async () => {
    const ref = await seed("9".repeat(64), [["A"]]);
    const ids = Array.from({ length: 201 }, () => randomUUID());
    await expect(reader().mentions(ref, ids)).rejects.toThrow(/at most 200/);
  });

  it("returns null when an entity name does not open", async () => {
    const ref = await seed("f".repeat(64), [["A"], ["B"]]);
    await entities().replaceForDocument(ref, [
      { name: "Acme Ltd", kind: "organization", chunkIds: [chunkIdFor(ref.documentId, 0)] },
    ]);
    await fx.db.owner.query(
      "UPDATE entities SET name_enc = '{\"x\":1}'::jsonb WHERE owner_id = $1 AND id IN (SELECT entity_id FROM chunk_entities WHERE chunk_id = $2)",
      [U1, chunkIdFor(ref.documentId, 0)],
    );
    expect(await reader().entities(ref)).toBeNull();
  });
});

describe.skipIf(!PG_URL)(
  "the co-occurrence queries on a library of 500 documents (needs DOCMIND_TEST_PG_URL)",
  () => {
    let fx: PgFixture;
    let selfId: string;
    const ENTITIES = 5000;
    beforeAll(async () => {
      fx = await startPgFixture();
      const c = await fx.db.owner.connect();
      try {
        // The library: 500 documents x 8 passages (4000), 5000 entities, one mention per passage, plus the cases below.
        await c.query(
          `INSERT INTO documents (id, tenant_id, owner_id, title_enc, filename_enc, mime, size_bytes, content_address, fingerprint)
           SELECT gen_random_uuid(), $1::uuid, $2::uuid, '{"x":1}'::jsonb, '{"x":1}'::jsonb, 'text/plain', 1,
                  'hmac-sha256:' || lpad(to_hex(g), 64, '0'), lpad(to_hex(g), 64, '0')
             FROM generate_series(1, 500) g`,
          [T1, U1],
        );
        await c.query(
          `INSERT INTO chunks (id, tenant_id, document_id, ordinal, section_ordinal, text_enc, locator, token_count)
           SELECT gen_random_uuid(), d.tenant_id, d.id, o, 0, '{"x":1}'::jsonb, '{"kind":"section","index":0}'::jsonb, 1
             FROM documents d CROSS JOIN generate_series(0, 7) o`,
        );
        await c.query(
          `INSERT INTO entities (id, tenant_id, owner_id, kind, name_enc, name_key)
           SELECT gen_random_uuid(), $1::uuid, $2::uuid, 'organization', '{"x":1}'::jsonb, lpad(to_hex(g), 64, '0')
             FROM generate_series(1, ${ENTITIES}) g`,
          [T1, U1],
        );
        await c.query(`CREATE TEMP TABLE seed_chunks AS
          SELECT tenant_id, id, row_number() OVER (ORDER BY id) AS rn FROM chunks`);
        await c.query(`CREATE TEMP TABLE seed_entities AS
          SELECT id, row_number() OVER (ORDER BY id) AS rn FROM entities`);
        await c.query(`INSERT INTO chunk_entities (tenant_id, chunk_id, entity_id)
          SELECT c.tenant_id, c.id, e.id FROM seed_chunks c JOIN seed_entities e ON e.rn = (c.rn % ${ENTITIES}) + 1`);
        // This document (the first by id) names 50 more entities, spread over its 8 passages.
        await c.query(
          `INSERT INTO chunk_entities (tenant_id, chunk_id, entity_id)
           SELECT mc.tenant_id, mc.id, e.id
             FROM (SELECT id, tenant_id FROM documents ORDER BY id LIMIT 1) d
             JOIN chunks mc ON mc.document_id = d.id
             JOIN seed_entities e ON e.rn <= 50 AND e.rn % 8 = mc.ordinal
           ON CONFLICT DO NOTHING`,
        );
        // A hub: one entity on every passage of the library, so on every passage of this document too.
        await c.query(
          `INSERT INTO entities (id, tenant_id, owner_id, kind, name_enc, name_key)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'organization', '{"x":1}'::jsonb, lpad(to_hex(100000), 64, '0'))`,
          [T1, U1],
        );
        await c.query(`INSERT INTO chunk_entities (tenant_id, chunk_id, entity_id)
          SELECT c.tenant_id, c.id, e.id FROM chunks c, entities e WHERE e.name_key = lpad(to_hex(100000), 64, '0')`);
        await c.query("ANALYZE");
      } finally {
        c.release();
      }
      selfId = (await fx.db.owner.query("SELECT id FROM documents ORDER BY id LIMIT 1")).rows[0].id;
    }, 120_000);
    afterAll(async () => {
      await fx?.close();
    });

    type PlanNode = {
      "Node Type": string;
      "Relation Name"?: string;
      "Actual Rows"?: number;
      "Actual Loops"?: number;
      "Rows Removed by Filter"?: number;
      Plans?: PlanNode[];
    };
    const walk = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(walk)];
    /** Plans and runs `sql` as the app role under the DEFAULT planner settings, with the parameters as literals. */
    async function explain(sql: string, params: unknown[]) {
      return withTenant(fx.app, T1, async (tx) => {
        const inline = sql.replace(/\$(\d+)/g, (_m, n) => {
          const v = params[Number(n) - 1];
          return Array.isArray(v) ? `ARRAY[${v.map((x) => `'${x}'`).join(",")}]::uuid[]` : `'${v}'`;
        });
        const res = await tx.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${inline}`);
        const top = res.rows[0]["QUERY PLAN"][0];
        return { nodes: walk(top.Plan as PlanNode), ms: Number(top["Execution Time"]) };
      });
    }
    /** Rows a plan node touched: returned plus filtered out, over all its loops. */
    const visited = (n: PlanNode) =>
      ((n["Actual Rows"] ?? 0) + (n["Rows Removed by Filter"] ?? 0)) * (n["Actual Loops"] ?? 1);
    const LARGE = ["chunks", "chunk_entities"];
    const TABLES = ["chunks", "chunk_entities", "documents", "entities"];
    // This document has 8 passages and about 70 mention rows; the library has 500 documents, 4000 passages, 8000+ mention rows,
    // 5000 entities. Anything under 300 visited rows per table cannot have scanned the library, whatever plan the planner picks.
    const VISITED_BOUND = 300;

    async function expectBound(sql: string, params: unknown[]) {
      const { nodes, ms } = await explain(sql, params);
      // Robust to the plan shape: no table is read beyond this document's neighbourhood...
      for (const n of nodes) {
        const rel = n["Relation Name"];
        if (rel !== undefined && TABLES.includes(rel))
          expect(visited(n), `${n["Node Type"]} on ${rel}`).toBeLessThan(VISITED_BOUND);
      }
      // ...and the two large tables are never sequentially scanned (a tiny table may legitimately be: not asserted on).
      expect(
        nodes
          .filter((n) => n["Node Type"] === "Seq Scan" && LARGE.includes(n["Relation Name"] ?? ""))
          .map((n) => n["Relation Name"]),
      ).toEqual([]);
      expect(ms).toBeLessThan(2000);
    }

    const candidateIds = async () =>
      (
        await withTenant(fx.app, T1, async (tx) =>
          tx.query<{ entity_id: string }>(CANDIDATES_SQL, [U1, selfId, T1, 20, 200]),
        )
      ).rows.map((r) => r.entity_id);

    it("the candidates query walks out from this document and never scans the library", async () => {
      await expectBound(CANDIDATES_SQL, [U1, selfId, T1, 20, 200]);
    });
    it("the mentions query walks out from this document and never scans the library, hub entity included", async () => {
      const ids = await candidateIds();
      expect(ids.length).toBeGreaterThan(20); // the hub and the 50 named entities are in the ranked set
      await expectBound(MENTIONS_SQL, [U1, selfId, T1, ids]);
    });
    it("returns only this document's rows", async () => {
      const rows = await withTenant(fx.app, T1, async (tx) =>
        tx.query<{ n: number }>(CANDIDATES_SQL, [U1, selfId, T1, 20, 200]),
      );
      // This document has 8 passages: the hub is in all 8, never in the library's 4000.
      expect(Math.max(...rows.rows.map((r) => r.n))).toBe(8);
      const own = new Set(
        (
          await fx.db.owner.query("SELECT id FROM chunks WHERE document_id = $1", [selfId])
        ).rows.map((r) => r.id as string),
      );
      const mentions = await withTenant(fx.app, T1, async (tx) =>
        tx.query<{ chunk_id: string }>(MENTIONS_SQL, [U1, selfId, T1, await candidateIds()]),
      );
      expect(mentions.rows.length).toBeGreaterThan(0);
      expect(mentions.rows.every((r) => own.has(r.chunk_id))).toBe(true);
    });
    it("another owner or tenant reads nothing, even with this document's id", async () => {
      const none = await withTenant(fx.app, T1, async (tx) =>
        tx.query(CANDIDATES_SQL, [U1B, selfId, T1, 20, 200]),
      );
      expect(none.rowCount).toBe(0);
      const other = await withTenant(fx.app, T1, async (tx) =>
        tx.query(MENTIONS_SQL, [U1, selfId, T2, await candidateIds()]),
      );
      expect(other.rowCount).toBe(0);
    });
  },
);
