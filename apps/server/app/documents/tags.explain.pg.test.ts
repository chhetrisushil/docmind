import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../db/tenant";
import { PG_URL } from "../db/testSupport";
import { type PgFixture, startPgFixture } from "../flows/ingest-document/pgFixture";
import { type TagFilter, listDocumentsQuery } from "./repo";
import { T1, T2, U1, U1B, U2 } from "./testHarness";

type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
};
const walk = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(walk)];

// Like ui/connections.pg.test.ts: a seeded library, ANALYZE, the plan under the default planner settings. The ids are
// deterministic (a counter, not gen_random_uuid()), so the physical layout the planner sees is the same on every run, and
// only the selective case asserts a plan.
describe.skipIf(!PG_URL)("the tag filter on a seeded library (needs DOCMIND_TEST_PG_URL)", () => {
  let fx: PgFixture;
  let rare: string; // on 6 of U1's 600 documents
  let common: string; // on about 7% of them
  let other: string; // on about 7% of them, together with `common` on some
  beforeAll(async () => {
    fx = await startPgFixture();
    const q = (sql: string, args: unknown[] = []) => fx.db.owner.query(sql, args);
    // U1 has 600 documents; two other users hold 3000 each, so the owner predicate is selective. `base` keeps the ids apart.
    for (const [tenant, owner, docs, base] of [
      [T1, U1, 600, 0x1000],
      [T1, U1B, 3000, 0x100000],
      [T2, U2, 3000, 0x200000],
    ] as const) {
      await q(
        `INSERT INTO documents (id, tenant_id, owner_id, title_enc, filename_enc, mime, size_bytes, content_address, fingerprint, created_at)
         SELECT lpad(to_hex($4::bigint + g), 32, '0')::uuid, $1::uuid, $2::uuid, '{}', '{}', 'text/plain', 1,
                'hmac-sha256:' || lpad(to_hex($4::bigint + g), 64, '0'), lpad(to_hex($4::bigint + g), 64, '0'),
                now() - make_interval(secs => g)
           FROM generate_series(1, $3::int) g`,
        [tenant, owner, docs, base],
      );
      await q(
        `INSERT INTO tags (id, tenant_id, owner_id, name_enc, name_bind)
         SELECT lpad(to_hex($3::bigint + g), 32, '0')::uuid, $1::uuid, $2::uuid, '{}',
                decode(md5($2::text || g::text) || md5(g::text || $2::text), 'hex')
           FROM generate_series(1, 41) g`,
        [tenant, owner, base],
      );
    }
    // Three of the first 40 tags per document, by the document's rank among its owner's documents (deterministic).
    await q(
      `INSERT INTO document_tags (document_id, tag_id, tenant_id, owner_id)
       SELECT DISTINCT d.id, t.id, d.tenant_id, d.owner_id
         FROM (SELECT id, tenant_id, owner_id, row_number() OVER (PARTITION BY owner_id ORDER BY id) AS rn FROM documents) d
         JOIN (SELECT id, owner_id, row_number() OVER (PARTITION BY owner_id ORDER BY id) AS tn FROM tags) t
           ON t.owner_id = d.owner_id AND t.tn <= 40
          AND t.tn IN ((d.rn % 40) + 1, ((d.rn * 7) % 40) + 1, ((d.rn * 13) % 40) + 1)`,
    );
    const nth = async (n: number) =>
      (await q("SELECT id FROM tags WHERE owner_id = $1 ORDER BY id OFFSET $2 LIMIT 1", [U1, n]))
        .rows[0].id as string;
    common = await nth(1); // the 2nd tag
    other = await nth(7); // the 8th tag: on every document that has the 2nd and whose rank is 1 mod 40
    rare = await nth(40); // the 41st tag: on no document yet, then on 6 of those that hold `common`
    await q(
      `INSERT INTO document_tags (document_id, tag_id, tenant_id, owner_id)
       SELECT document_id, $3, tenant_id, owner_id FROM document_tags WHERE owner_id = $1 AND tag_id = $2 ORDER BY document_id LIMIT 6`,
      [U1, common, rare],
    );
    await q("ANALYZE");
  }, 120_000);
  afterAll(async () => void (await fx?.close()));

  const lit = (v: unknown) =>
    v === null ? "NULL" : Array.isArray(v) ? `'{${v.join(",")}}'` : `'${v}'`;
  const query = (filter: TagFilter, limit = 51) =>
    listDocumentsQuery(U1, { cursor: null, limit, tenantId: T1, filter });

  /** Plans and runs the listing as the app role, with the parameters as literals so the planner sees the values. */
  async function explain(filter: TagFilter) {
    const { sql, params } = query(filter);
    const inline = sql.replace(/\$(\d+)/g, (_m, i) => lit(params[Number(i) - 1]));
    return withTenant(fx.app, T1, async (tx) => {
      const res = await tx.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${inline}`);
      return walk(res.rows[0]["QUERY PLAN"][0].Plan as PlanNode);
    });
  }
  const idsOf = async (filter: TagFilter) => {
    const { sql, params } = query(filter, 1000);
    const rows = await withTenant(
      fx.app,
      T1,
      async (tx) => (await tx.query<{ id: string }>(sql, params)).rows,
    );
    return rows.map((r) => r.id).sort();
  };

  it("a rare tag is reached through the tag index, never by scanning the library", async () => {
    const nodes = await explain({ tagIds: [rare], match: "any" });
    const seq = nodes.filter((n) => n["Node Type"] === "Seq Scan").map((n) => n["Relation Name"]);
    expect(seq.filter((r) => r === "document_tags" || r === "documents")).toEqual([]);
    expect(nodes.some((n) => n["Index Name"] === "document_tags_owner_tag_idx")).toBe(true);
  });

  it("any and all return exactly what a brute-force read of the links says", async () => {
    const links = (
      await fx.db.owner.query<{ document_id: string; tag_id: string }>(
        "SELECT document_id, tag_id FROM document_tags WHERE owner_id = $1",
        [U1],
      )
    ).rows;
    const held = new Map<string, Set<string>>();
    for (const l of links)
      held.set(l.document_id, (held.get(l.document_id) ?? new Set()).add(l.tag_id));
    const brute = (tagIds: string[], match: "any" | "all") =>
      [...held]
        .filter(([, tags]) =>
          match === "all" ? tagIds.every((t) => tags.has(t)) : tagIds.some((t) => tags.has(t)),
        )
        .map(([doc]) => doc)
        .sort();
    const cases: [string[], "any" | "all"][] = [
      [[rare], "any"],
      [[rare, common], "any"],
      [[rare, common], "all"],
      [[common, other], "any"],
      [[common, other], "all"],
    ];
    for (const [tagIds, match] of cases) {
      const want = brute(tagIds, match);
      expect(want.length).toBeGreaterThan(0); // each case selects something
      expect(await idsOf({ tagIds, match })).toEqual(want);
    }
    // All is narrower than Any for two common tags: the two forms really differ on this data.
    expect((await idsOf({ tagIds: [common, other], match: "all" })).length).toBeLessThan(
      (await idsOf({ tagIds: [common, other], match: "any" })).length,
    );
  });
});
