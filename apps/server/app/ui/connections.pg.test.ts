import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withTenant } from "../db/tenant";
import { PG_URL } from "../db/testSupport";
import { T1, T2, U1, U1B, U2 } from "../documents/testHarness";
import { type PgFixture, startPgFixture } from "../flows/ingest-document/pgFixture";
import { ENTITIES_SQL, RELATED_SQL, SELF_SQL, readConnections } from "./connections";
import { connectionsSeeder } from "./testSupport";

const A1 = { tenantId: T1, userId: U1 };

describe.skipIf(!PG_URL)("readConnections (needs DOCMIND_TEST_PG_URL)", () => {
  let fx: PgFixture;
  const { ids, id, ch, seed, link, entity } = connectionsSeeder(() => fx, A1);
  const read = (name: string, who = A1) =>
    readConnections({ pool: fx.app, fields: fx.fields }, who, id(name));

  beforeAll(async () => {
    fx = await startPgFixture();
  });
  afterAll(async () => {
    await fx?.close();
  });
  beforeEach(async () => {
    await fx.db.owner.query("DELETE FROM documents"); // chunks, links and chunk_entities cascade
    await fx.db.owner.query("DELETE FROM entities");
    await fx.db.owner.query("DELETE FROM read_model_state");
    ids.clear();
  });

  it("groups links per related document with kind counts and the strongest weight, ordered by strength, link count, id", async () => {
    for (const n of ["a", "b", "c", "d", "e"]) await seed(n, { chunks: 3 });
    await link(ch("a", 0), ch("b", 0), 0.5, "similar");
    await link(ch("a", 1), ch("b", 1), 0.9, "reference");
    await link(ch("a", 2), ch("b", 2), 0.5, "similar");
    await link(ch("a", 0), ch("c", 0), 0.7, "similar");
    await link(ch("a", 0), ch("d", 0), 0.7, "entity");
    await link(ch("a", 1), ch("d", 1), 0.7, "entity");
    await link(ch("a", 0), ch("e", 0), 0.99, "structure"); // never a connection
    const got = await read("a");
    expect(got?.documentId).toBe(id("a"));
    expect(got?.related.map((r) => r.documentId)).toEqual([id("b"), id("d"), id("c")]);
    expect(got?.related[0]).toMatchObject({
      title: "b",
      kinds: { entity: 0, reference: 1, similar: 2 },
    });
    expect(got?.related[0]?.strength).toBeCloseTo(0.9, 5);
    expect(got?.related[1]?.kinds).toEqual({ entity: 2, reference: 0, similar: 0 });
    expect(got?.entities).toEqual([]);
  });

  it("breaks a tie of strength and link count by document id", async () => {
    for (const n of ["a", "b", "c"]) await seed(n);
    await link(ch("a", 0), ch("b", 0), 0.6);
    await link(ch("a", 1), ch("c", 0), 0.6);
    const got = await read("a");
    expect(got?.related.map((r) => r.documentId)).toEqual([id("b"), id("c")].sort());
  });

  it("counts only the caller's ready, live documents, and never the document itself", async () => {
    await seed("a");
    await seed("b");
    await seed("notReady", { ready: false });
    await seed("theirs", { who: { tenantId: T1, userId: U1B } });
    await link(ch("a", 0), ch("a", 1), 0.9); // within the document
    await link(ch("a", 0), ch("notReady", 0), 0.9);
    await link(ch("a", 0), ch("theirs", 0), 0.9); // another user of the same tenant
    await link(ch("a", 1), ch("b", 0), 0.1);
    expect((await read("a"))?.related.map((r) => r.documentId)).toEqual([id("b")]);
    await fx.db.owner.query("DELETE FROM documents WHERE id = $1", [id("b")]);
    expect((await read("a"))?.related).toEqual([]);
  });

  it("returns at most 8 related documents, the strongest", async () => {
    await seed("a", { chunks: 1 });
    for (let i = 0; i < 10; i++) {
      await seed(`r${i}`, { chunks: 1 });
      await link(ch("a", 0), ch(`r${i}`, 0), (i + 1) / 20);
    }
    const got = await read("a");
    expect(got?.related).toHaveLength(8);
    expect(got?.related.map((r) => r.title)).toEqual([
      "r9",
      "r8",
      "r7",
      "r6",
      "r5",
      "r4",
      "r3",
      "r2",
    ]);
  });

  it("lists the entities this document shares, rarest first, with their documents by title", async () => {
    for (const n of ["a", "b", "c", "d", "e"]) await seed(n);
    const acme = await entity("Acme Corp", [ch("a", 0), ch("b", 0)], { kind: "organization" });
    const jane = await entity("Jane Doe", [ch("a", 1), ch("e", 1), ch("c", 1), ch("d", 1)], {
      kind: "person",
    });
    await entity("Solo", [ch("a", 0)]); // not shared with any other document
    await entity("Elsewhere", [ch("b", 1), ch("c", 0)]); // not in this document
    const got = await read("a");
    expect(got?.entities).toEqual([
      {
        entityId: acme,
        name: "Acme Corp",
        kind: "organization",
        documents: [{ documentId: id("b"), title: "b" }],
      },
      {
        entityId: jane,
        name: "Jane Doe",
        kind: "person",
        documents: [
          { documentId: id("c"), title: "c" },
          { documentId: id("d"), title: "d" },
          { documentId: id("e"), title: "e" },
        ],
      },
    ]);
  });

  it("caps entities at 12 and the documents named per entity at 5, and skips not-ready and foreign documents", async () => {
    await seed("a", { chunks: 1 });
    await seed("b", { chunks: 1 });
    for (let i = 0; i < 14; i++) await entity(`E${i}`, [ch("a", 0), ch("b", 0)]);
    const many = await entity("Many", [ch("a", 0)]);
    for (let i = 0; i < 7; i++) {
      await seed(`m${i}`, { chunks: 1 });
      await fx.db.owner.query(
        "INSERT INTO chunk_entities (tenant_id, chunk_id, entity_id) VALUES ($1, $2, $3)",
        [T1, ch(`m${i}`, 0), many],
      );
    }
    await seed("notReady", { chunks: 1, ready: false });
    await seed("theirs", { chunks: 1, who: { tenantId: T1, userId: U1B } });
    const spread = await entity("Spread", [ch("a", 0), ch("notReady", 0), ch("theirs", 0)]);
    const got = await read("a");
    expect(got?.entities).toHaveLength(12);
    expect(got?.entities.some((e) => e.entityId === spread)).toBe(false); // no ready document of the owner shares it
    // the 14 two-document entities are rarer than "Many"; with 12 slots "Many" does not appear
    expect(got?.entities.every((e) => e.documents.length === 1)).toBe(true);
    await fx.db.owner.query("DELETE FROM entities WHERE id <> $1", [many]);
    const only = await read("a");
    expect(only?.entities).toHaveLength(1);
    expect(only?.entities[0]?.documents).toHaveLength(5);
    const titles = only?.entities[0]?.documents.map((d) => d.title) ?? [];
    expect(titles).toEqual([...titles].sort());
  });

  it("drops an entity whose name does not open, and a document whose title does not open", async () => {
    await seed("a");
    await seed("b");
    await seed("sealedElsewhere", { titleKey: U1B });
    const good = await entity("Acme Corp", [ch("a", 0), ch("b", 0)]);
    await entity("Unreadable", [ch("a", 1), ch("b", 1)], { sealedBy: U1B }); // owned by U1, sealed under another key
    await link(ch("a", 0), ch("sealedElsewhere", 0), 0.9);
    await link(ch("a", 1), ch("b", 0), 0.2);
    const got = await read("a");
    expect(got?.entities.map((e) => e.entityId)).toEqual([good]);
    expect(got?.related.map((r) => r.documentId)).toEqual([id("b")]);
  });

  it("is owner-scoped: another user, another tenant, a malformed id and an unknown id read nothing", async () => {
    await seed("a");
    const deps = { pool: fx.app, fields: fx.fields };
    expect(await read("a", { tenantId: T1, userId: U1B })).toBeNull();
    expect(await read("a", { tenantId: T2, userId: U2 })).toBeNull();
    expect(await readConnections(deps, A1, "not-a-uuid")).toBeNull();
    expect(await readConnections(deps, A1, randomUUID())).toBeNull();
    expect(await read("a")).toEqual({ documentId: id("a"), related: [], entities: [] });
    expect(await readConnections(deps, A1, id("a").toUpperCase())).toMatchObject({
      documentId: id("a"),
    });
  });

  it("never reads an entity of another user, even one linked to this owner's chunks", async () => {
    await seed("a");
    await seed("b");
    await entity("Theirs", [ch("a", 0), ch("b", 0)], { user: U1B });
    expect((await read("a"))?.entities).toEqual([]);
  });
});

describe.skipIf(!PG_URL)(
  "the connections queries on about 500 documents (needs DOCMIND_TEST_PG_URL)",
  () => {
    let fx: PgFixture;
    let selfId: string;

    beforeAll(async () => {
      fx = await startPgFixture();
      const c = await fx.db.owner.connect();
      try {
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
           FROM documents d CROSS JOIN generate_series(0, 3) o`,
        );
        await c.query(
          `INSERT INTO entities (id, tenant_id, owner_id, kind, name_enc, name_key)
         SELECT gen_random_uuid(), $1::uuid, $2::uuid, 'organization', '{"x":1}'::jsonb, lpad(to_hex(g), 64, '0')
           FROM generate_series(1, 200) g`,
          [T1, U1],
        );
        await c.query(`CREATE TEMP TABLE seed_chunks AS
        SELECT tenant_id, id, row_number() OVER (ORDER BY id) AS rn FROM chunks`);
        await c.query(`CREATE TEMP TABLE seed_entities AS
        SELECT id, row_number() OVER (ORDER BY id) AS rn FROM entities`);
        await c.query(`INSERT INTO chunk_entities (tenant_id, chunk_id, entity_id)
        SELECT c.tenant_id, c.id, e.id FROM seed_chunks c JOIN seed_entities e ON e.rn = (c.rn % 200) + 1`);
        await c.query(`INSERT INTO chunk_links (tenant_id, src_chunk_id, dst_chunk_id, kind, weight)
        SELECT a.tenant_id, a.id, b.id, 'similar', 0.5
          FROM seed_chunks a CROSS JOIN generate_series(1, 6) AS k(n)
          JOIN seed_chunks b ON b.rn = ((a.rn * 7 + k.n * 131) % 2000) + 1 AND b.id <> a.id
        ON CONFLICT DO NOTHING`);
        await c.query(
          `INSERT INTO read_model_state (model_id, execution_id, app_key, scope, sequence, state)
         SELECT 'ingest-status', 'u_' || d.owner_id::text || ':ingest-' || d.id::text || '.' || d.ingest_generation::text,
                d.id::text, d.owner_id::text, 0, '{"status":"ready"}'::jsonb
           FROM documents d`,
        );
        await c.query("ANALYZE");
      } finally {
        c.release();
      }
      selfId = (await fx.db.owner.query("SELECT id FROM documents ORDER BY id LIMIT 1")).rows[0].id;
    }, 120_000);
    afterAll(async () => {
      await fx?.close();
    });

    type PlanNode = { "Node Type": string; "Relation Name"?: string; Plans?: PlanNode[] };
    const walk = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(walk)];
    /** Plans (and runs) `sql` as the app role with sequential scans off: a Seq Scan left in the plan has no index to use. */
    async function explain(sql: string, params: unknown[]) {
      return withTenant(fx.app, T1, async (tx) => {
        await tx.query("SET LOCAL enable_seqscan = off");
        // Literals, so the planner sees the values; every parameter is a uuid or a small integer.
        const inline = sql.replace(/\$(\d+)/g, (_m, n) => `'${params[Number(n) - 1]}'`);
        const res = await tx.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${inline}`);
        const top = res.rows[0]["QUERY PLAN"][0];
        return { nodes: walk(top.Plan as PlanNode), ms: Number(top["Execution Time"]) };
      });
    }
    const BIG = ["chunks", "chunk_links", "chunk_entities", "documents", "entities"];

    it.each([
      ["related", RELATED_SQL, [U1, 8]],
      ["entities", ENTITIES_SQL, [U1, 12, 5]],
    ] as const)(
      "the %s query reaches every large table through an index, in well under a second",
      async (_n, sql, rest) => {
        const params = [rest[0], selfId, ...rest.slice(1)];
        const { nodes, ms } = await explain(sql, params);
        const seq = nodes
          .filter((n) => n["Node Type"] === "Seq Scan")
          .map((n) => n["Relation Name"]);
        expect(seq.filter((r) => r !== undefined && BIG.includes(r))).toEqual([]);
        expect(ms).toBeLessThan(2000);
      },
    );

    it("the self check is a primary-key lookup", async () => {
      const { nodes } = await explain(SELF_SQL, [U1, selfId]);
      expect(nodes.some((n) => n["Node Type"] === "Seq Scan")).toBe(false);
    });
  },
);
