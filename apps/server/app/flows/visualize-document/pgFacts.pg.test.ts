import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../../db/tenant";
import { PG_URL } from "../../db/testSupport";
import { deleteDocument } from "../../documents/repo";
import { T1, T2, U1B } from "../../documents/testHarness";
import { DocumentGoneError } from "../ingest-document/errors";
import { type PgFixture, startPgFixture } from "../ingest-document/pgFixture";
import { ENTITY_MAP_ORDINAL, type Fact, OUTLINE_ORDINAL, type StructureFact } from "./facts";
import { PgVisualFacts, type VisualizeRef } from "./pgFacts";

describe.skipIf(!PG_URL)("PgVisualFacts (needs DOCMIND_TEST_PG_URL)", () => {
  let fx: PgFixture;
  beforeAll(async () => {
    fx = await startPgFixture();
  });
  afterAll(async () => {
    await fx?.close();
  });

  const fig = (ordinal: number, chunk: string): Fact => ({
    kind: "figure",
    label: "Revenue",
    value: 1200,
    chunkIds: [chunk],
    ordinal,
  });
  async function seedChunk(ref: VisualizeRef): Promise<string> {
    const id = randomUUID();
    await fx.db.owner.query(
      `INSERT INTO chunks (id, tenant_id, document_id, ordinal, section_ordinal, text_enc, locator, token_count)
       VALUES ($1, $2, $3, 0, 0, '{"x":1}', '{"kind":"chars","start":0,"end":5}', 2)`,
      [id, ref.tenantId, ref.documentId],
    );
    return id;
  }
  const rowCount = async (documentId: string) =>
    (
      await fx.db.owner.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM visual_facts WHERE document_id = $1",
        [documentId],
      )
    ).rows[0]?.n;

  it("round-trips sealed facts in ordinal order and replaces in one transaction", async () => {
    const ref = await fx.doc("1".repeat(64));
    const chunk = await seedChunk(ref);
    const store = new PgVisualFacts(fx.app, fx.fields);
    expect(await store.replace(ref, [fig(1, chunk), fig(0, chunk)])).toBe(2);
    expect((await store.list(ref)).map((f) => f.ordinal)).toEqual([0, 1]);
    await store.replace(ref, [fig(0, chunk)]);
    expect(await store.list(ref)).toEqual([fig(0, chunk)]);
  });

  it("stores no plaintext label", async () => {
    const ref = await fx.doc("2".repeat(64));
    const chunk = await seedChunk(ref);
    await new PgVisualFacts(fx.app, fx.fields).replace(ref, [fig(0, chunk)]);
    const raw = await fx.db.owner.query(
      "SELECT fact_enc::text AS t FROM visual_facts WHERE document_id = $1",
      [ref.documentId],
    );
    expect(raw.rows).toHaveLength(1);
    expect(raw.rows.map((r) => r.t).join()).not.toContain("Revenue");
  });

  it("is invisible to another tenant and gone with the document", async () => {
    const ref = await fx.doc("3".repeat(64));
    const chunk = await seedChunk(ref);
    await new PgVisualFacts(fx.app, fx.fields).replace(ref, [fig(0, chunk)]);
    const other = await withTenant(fx.app, T2, (tx) =>
      tx.query("SELECT 1 FROM visual_facts WHERE document_id = $1", [ref.documentId]),
    );
    expect(other.rows).toEqual([]);
    const own = await withTenant(fx.app, T1, (tx) =>
      tx.query("SELECT 1 FROM visual_facts WHERE document_id = $1", [ref.documentId]),
    );
    expect(own.rows).toHaveLength(1);
    expect(await rowCount(ref.documentId)).toBe(1);
    await withTenant(fx.app, T1, (tx) => deleteDocument(tx, ref.userId, ref.documentId));
    expect(await rowCount(ref.documentId)).toBe(0);
  });

  it("rolls back a replace whose attempt was aborted", async () => {
    const ref = await fx.doc("4".repeat(64));
    const chunk = await seedChunk(ref);
    const store = new PgVisualFacts(fx.app, fx.fields);
    await store.replace(ref, [fig(0, chunk)]);
    const ac = new AbortController();
    ac.abort();
    await expect(
      store.replace(ref, [fig(0, chunk), fig(1, chunk)], ac.signal),
    ).rejects.toMatchObject({
      name: "ParseAbortedError",
    });
    expect(await rowCount(ref.documentId)).toBe(1);
  });

  it("list and replace throw DocumentGoneError for a document the user does not own", async () => {
    const ref = await fx.doc("5".repeat(64));
    const chunk = await seedChunk(ref);
    const store = new PgVisualFacts(fx.app, fx.fields);
    const stranger = { ...ref, userId: U1B };
    await expect(store.list(stranger)).rejects.toBeInstanceOf(DocumentGoneError);
    await expect(store.replace(stranger, [fig(0, chunk)])).rejects.toBeInstanceOf(
      DocumentGoneError,
    );
    expect(await rowCount(ref.documentId)).toBe(0);
  });

  it("migration 0035 admits the structure kinds at ordinals 16 and 17 and still refuses anything else", async () => {
    const ref = await fx.doc("a0".repeat(32));
    const chunk = await seedChunk(ref);
    const insert = (kind: string, ordinal: number) =>
      fx.db.owner.query(
        "INSERT INTO visual_facts (id, tenant_id, owner_id, document_id, kind, ordinal, fact_enc, chunk_ids) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, '{}'::jsonb, $6::uuid[])",
        [ref.tenantId, ref.userId, ref.documentId, kind, ordinal, [chunk]],
      );
    await insert("outline", 16);
    await insert("cooccurrence", 17);
    await expect(insert("figure", 18)).rejects.toThrow(/visual_facts_(kind_)?ordinal_check/);
    await expect(insert("diagram", 3)).rejects.toThrow(/visual_facts_kind_check/);
    // The kind and the ordinal range must agree (M7): structure kinds only at 16+, extracted kinds only below.
    await expect(insert("figure", 17)).rejects.toThrow(/visual_facts_kind_ordinal_check/);
    await expect(insert("outline", 3)).rejects.toThrow(/visual_facts_kind_ordinal_check/);
    await insert("series", 0);
    await insert("factTable", 15);
    const names = await fx.db.owner.query(
      "SELECT conname FROM pg_constraint WHERE conrelid = 'visual_facts'::regclass AND contype = 'c' ORDER BY conname",
    );
    expect(names.rows.map((r) => r.conname)).toEqual([
      "visual_facts_kind_check",
      "visual_facts_kind_ordinal_check",
      "visual_facts_ordinal_check",
    ]);
  });

  const outlineFact = (chunk: string): StructureFact => ({
    kind: "outline",
    title: "Zebra-Secret-Title",
    nodes: ["Zebra-Heading-A", "Zebra-Heading-B", "Zebra-Heading-C"].map((label, i) => ({
      id: `s${i}`,
      label,
      level: 1,
      passageCount: 1,
      firstChunkId: chunk,
    })),
    chunkIds: [chunk],
    ordinal: OUTLINE_ORDINAL,
  });
  const mapFact = (chunk: string): StructureFact => ({
    kind: "cooccurrence",
    entities: ["Zebra-Ent-A", "Zebra-Ent-B", "Zebra-Ent-C"].map((name) => ({
      name,
      entityKind: "organization" as const,
      passages: 2,
    })),
    edges: [
      { a: 0, b: 1, weight: 2, firstChunkId: chunk },
      { a: 1, b: 2, weight: 2, firstChunkId: chunk },
    ],
    chunkIds: [chunk],
    ordinal: ENTITY_MAP_ORDINAL,
  });

  it("extraction and structure each replace only their own ordinals", async () => {
    const ref = await fx.doc("b1".repeat(32));
    const chunk = await seedChunk(ref);
    const store = new PgVisualFacts(fx.app, fx.fields);
    await store.replace(ref, [fig(0, chunk), fig(1, chunk)]);
    expect(await store.replaceStructure(ref, [outlineFact(chunk), mapFact(chunk)])).toBe(2);
    expect((await store.listAll(ref)).map((f) => [f.ordinal, f.kind])).toEqual([
      [0, "figure"],
      [1, "figure"],
      [16, "outline"],
      [17, "cooccurrence"],
    ]);
    // A re-extraction does not wipe the structure facts...
    await store.replace(ref, [fig(0, chunk)]);
    expect((await store.listAll(ref)).map((f) => f.ordinal)).toEqual([0, 16, 17]);
    // ...and a structure replace does not wipe the extracted ones; an empty replace clears just its own range.
    await store.replaceStructure(ref, [outlineFact(chunk)]);
    expect((await store.listAll(ref)).map((f) => f.ordinal)).toEqual([0, 16]);
    await store.replaceStructure(ref, []);
    expect((await store.listAll(ref)).map((f) => f.ordinal)).toEqual([0]);
  });

  it("list returns the extracted facts only, so chat and the re-plan check never see a structure fact", async () => {
    const ref = await fx.doc("b2".repeat(32));
    const chunk = await seedChunk(ref);
    const store = new PgVisualFacts(fx.app, fx.fields);
    await store.replace(ref, [fig(0, chunk)]);
    await store.replaceStructure(ref, [outlineFact(chunk)]);
    expect((await store.list(ref)).map((f) => f.kind)).toEqual(["figure"]);
  });

  it("refuses a fact outside the writer's ordinal range", async () => {
    const ref = await fx.doc("b3".repeat(32));
    const chunk = await seedChunk(ref);
    const store = new PgVisualFacts(fx.app, fx.fields);
    await expect(store.replace(ref, [fig(16, chunk)])).rejects.toThrow(/ordinals below 16/);
    await expect(
      store.replaceStructure(ref, [{ ...outlineFact(chunk), ordinal: 3 }]),
    ).rejects.toThrow(/ordinals 16 and 17/);
  });

  it("stores structure facts sealed, with their own column kind (migration 0035), owner-scoped", async () => {
    const ref = await fx.doc("b4".repeat(32));
    const chunk = await seedChunk(ref);
    const store = new PgVisualFacts(fx.app, fx.fields);
    await store.replaceStructure(ref, [outlineFact(chunk), mapFact(chunk)]);
    const raw = await fx.db.owner.query(
      "SELECT kind, fact_enc::text AS t FROM visual_facts WHERE document_id = $1 ORDER BY ordinal",
      [ref.documentId],
    );
    expect(raw.rows.map((r) => r.kind)).toEqual(["outline", "cooccurrence"]);
    for (const r of raw.rows) {
      expect(r.t).not.toContain("Zebra");
      expect(r.t).not.toContain("outline");
    }
    await expect(store.listAll({ ...ref, userId: U1B })).rejects.toBeInstanceOf(DocumentGoneError);
    await expect(store.replaceStructure({ ...ref, userId: U1B }, [])).rejects.toBeInstanceOf(
      DocumentGoneError,
    );
  });

  it("replaceStructure refuses a fact that would not read back, writing nothing; list never reads structure rows", async () => {
    const ref = await fx.doc("b5".repeat(32));
    const chunk = await seedChunk(ref);
    const store = new PgVisualFacts(fx.app, fx.fields);
    await store.replaceStructure(ref, [outlineFact(chunk)]);
    const good = outlineFact(chunk);
    const bad = {
      ...good,
      nodes: (good as { nodes: unknown[] }).nodes.slice(0, 2),
    } as unknown as StructureFact;
    await expect(store.replaceStructure(ref, [bad])).rejects.toThrow(/unexpected shape/);
    expect((await store.listAll(ref)).map((f) => f.ordinal)).toEqual([16]); // the old row is still there
    // A structure row that does not parse must not break the extracted read (chat).
    await store.replace(ref, [fig(0, chunk)]);
    await fx.db.owner.query(
      "UPDATE visual_facts SET fact_enc = '{\"x\":1}'::jsonb WHERE document_id = $1 AND ordinal = 16",
      [ref.documentId],
    );
    expect((await store.list(ref)).map((f) => f.ordinal)).toEqual([0]);
    await expect(store.listAll(ref)).rejects.toThrow();
  });

  it("a write from a stale ingest generation changes nothing and ends as document gone (both writers)", async () => {
    const ref = await fx.doc("b6".repeat(32));
    const chunk = await seedChunk(ref);
    const store = new PgVisualFacts(fx.app, fx.fields);
    await fx.db.owner.query("UPDATE documents SET ingest_generation = 5 WHERE id = $1", [
      ref.documentId,
    ]);
    await store.replace(ref, [fig(0, chunk)], undefined, 5);
    await store.replaceStructure(ref, [outlineFact(chunk)], undefined, 5);
    // A run of generation 4 passed its step guard before the re-ingest: its writes must not land.
    await expect(store.replaceStructure(ref, [], undefined, 4)).rejects.toBeInstanceOf(
      DocumentGoneError,
    );
    await expect(store.replace(ref, [], undefined, 4)).rejects.toBeInstanceOf(DocumentGoneError);
    expect((await store.listAll(ref)).map((f) => f.ordinal)).toEqual([0, 16]);
    // No generation given (a caller without one) keeps the old behaviour.
    await store.replaceStructure(ref, [], undefined);
    expect((await store.listAll(ref)).map((f) => f.ordinal)).toEqual([0]);
  });
});
