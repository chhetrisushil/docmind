import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../../db/tenant";
import { PG_URL } from "../../db/testSupport";
import { deleteDocument } from "../../documents/repo";
import { bumpGeneration } from "../../documents/repo";
import { T1, T2, U1B } from "../../documents/testHarness";
import { DocumentGoneError } from "../ingest-document/errors";
import { type PgFixture, startPgFixture } from "../ingest-document/pgFixture";
import {
  ENTITY_MAP_ORDINAL,
  EXTRACT_FORMAT,
  type ExtractionWrite,
  type Fact,
  OUTLINE_ORDINAL,
  type StructureFact,
} from "./facts";
import { PgVisualFacts, type VisualizeRef } from "./pgFacts";
import { aggregateFacts } from "./testing";

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
    await expect(insert("diagram", 3)).rejects.toThrow(/visual_facts_kind_(ordinal_)?check/);
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
    await expect(store.replace(ref, [fig(16, chunk)])).rejects.toThrow(
      /extraction writes ordinals/,
    );
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

  it("migration 0037 admits each aggregate kind at its own ordinal only, pins every kind to its own ordinal, and keeps the constraint names", async () => {
    const ref = await fx.doc("c0".repeat(32));
    const chunk = await seedChunk(ref);
    const insert = (kind: string, ordinal: number) =>
      fx.db.owner.query(
        "INSERT INTO visual_facts (id, tenant_id, owner_id, document_id, kind, ordinal, fact_enc, chunk_ids) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, '{}'::jsonb, $6::uuid[])",
        [ref.tenantId, ref.userId, ref.documentId, kind, ordinal, [chunk]],
      );
    await insert("timeline", 18);
    await insert("relations", 19);
    await insert("outline", 16);
    await insert("cooccurrence", 17);
    await insert("series", 0);
    await insert("factTable", 15);
    const pinned = /visual_facts_kind_ordinal_check/;
    await expect(insert("timeline", 3)).rejects.toThrow(pinned);
    await expect(insert("figure", 18)).rejects.toThrow(pinned);
    await expect(insert("figure", 19)).rejects.toThrow(pinned);
    await expect(insert("relations", 18)).rejects.toThrow(pinned);
    await expect(insert("timeline", 19)).rejects.toThrow(pinned);
    await expect(insert("relations", 17)).rejects.toThrow(pinned);
    await expect(insert("outline", 17)).rejects.toThrow(pinned);
    await expect(insert("cooccurrence", 16)).rejects.toThrow(pinned);
    await expect(insert("figure", 20)).rejects.toThrow(/visual_facts_(kind_)?ordinal_check/);
    await expect(insert("timeline", 20)).rejects.toThrow(/visual_facts_(kind_)?ordinal_check/);
    await expect(insert("diagram", 18)).rejects.toThrow(/visual_facts_kind_(ordinal_)?check/);
    const names = await fx.db.owner.query(
      "SELECT conname FROM pg_constraint WHERE conrelid = 'visual_facts'::regclass AND contype = 'c' ORDER BY conname",
    );
    expect(names.rows.map((r) => r.conname)).toEqual([
      "visual_facts_kind_check",
      "visual_facts_kind_ordinal_check",
      "visual_facts_ordinal_check",
    ]);
  });

  it("ownership of ordinals: extraction owns 0..15 and 18..19 together, structure owns 16..17, and a re-plan that skips extraction keeps the aggregates", async () => {
    const ref = await fx.doc("c1".repeat(32));
    const chunk = await seedChunk(ref);
    const store = new PgVisualFacts(fx.app, fx.fields);
    const { timeline, relations } = aggregateFacts(chunk);
    const ordinals = async () => (await store.listAll(ref)).map((f) => f.ordinal);

    expect(await store.replace(ref, [fig(0, chunk), timeline, relations])).toBe(3);
    expect(await ordinals()).toEqual([0, 18, 19]);
    // structure facts land beside them without touching them
    await store.replaceStructure(ref, [outlineFact(chunk), mapFact(chunk)]);
    expect(await ordinals()).toEqual([0, 16, 17, 18, 19]);
    // a re-plan that skips extraction only re-derives structure: 18..19 survive both an empty and a full structure replace
    await store.replaceStructure(ref, []);
    expect(await ordinals()).toEqual([0, 18, 19]);
    await store.replaceStructure(ref, [outlineFact(chunk)]);
    expect(await ordinals()).toEqual([0, 16, 18, 19]);
    // a new extraction with no timeline removes the old one, and keeps the structure facts
    await store.replace(ref, [fig(0, chunk), relations]);
    expect(await ordinals()).toEqual([0, 16, 19]);
    await store.replace(ref, [fig(1, chunk)]);
    expect(await ordinals()).toEqual([1, 16]);
    // an empty extraction (a refusal) clears 0..15 and 18..19 together, never the structure facts
    await store.replace(ref, [fig(2, chunk), timeline, relations]);
    await store.replace(ref, []);
    expect(await ordinals()).toEqual([16]);
  });

  it("list returns the extracted facts only, so chat never sees a timeline or relations fact", async () => {
    const ref = await fx.doc("c2".repeat(32));
    const chunk = await seedChunk(ref);
    const store = new PgVisualFacts(fx.app, fx.fields);
    const { timeline, relations } = aggregateFacts(chunk);
    await store.replace(ref, [fig(0, chunk), timeline, relations]);
    await store.replaceStructure(ref, [outlineFact(chunk)]);
    expect((await store.list(ref)).map((f) => [f.ordinal, f.kind])).toEqual([[0, "figure"]]);
    expect((await store.listAll(ref)).map((f) => f.kind)).toEqual([
      "figure",
      "outline",
      "timeline",
      "relations",
    ]);
  });

  it("refuses an aggregate outside its own ordinal, a fact outside 0..15, and an aggregate that would not read back, writing nothing", async () => {
    const ref = await fx.doc("c3".repeat(32));
    const chunk = await seedChunk(ref);
    const store = new PgVisualFacts(fx.app, fx.fields);
    const { timeline, relations } = aggregateFacts(chunk);
    await store.replace(ref, [fig(0, chunk), timeline]);
    const refused = /extraction writes ordinals/;
    await expect(store.replace(ref, [{ ...timeline, ordinal: 19 }])).rejects.toThrow(refused);
    await expect(store.replace(ref, [{ ...relations, ordinal: 18 }])).rejects.toThrow(refused);
    await expect(store.replace(ref, [fig(17, chunk)])).rejects.toThrow(refused);
    await expect(store.replace(ref, [fig(18, chunk)])).rejects.toThrow(refused);
    const short = { ...timeline, events: (timeline as { events: unknown[] }).events.slice(0, 2) };
    await expect(store.replace(ref, [short as unknown as ExtractionWrite])).rejects.toThrow(
      /unexpected shape/,
    );
    // every refusal left the stored rows as they were
    expect((await store.listAll(ref)).map((f) => f.ordinal)).toEqual([0, 18]);
  });

  it("stores aggregates sealed, with their own column kind, owner-scoped", async () => {
    const ref = await fx.doc("c4".repeat(32));
    const chunk = await seedChunk(ref);
    const store = new PgVisualFacts(fx.app, fx.fields);
    const { timeline, relations } = aggregateFacts(chunk);
    await store.replace(ref, [timeline, relations]);
    const raw = await fx.db.owner.query(
      "SELECT kind, fact_enc::text AS t FROM visual_facts WHERE document_id = $1 ORDER BY ordinal",
      [ref.documentId],
    );
    expect(raw.rows.map((r) => r.kind)).toEqual(["timeline", "relations"]);
    for (const r of raw.rows) {
      expect(r.t).not.toContain("Zebra");
      expect(r.t).not.toContain("acquired");
      expect(r.t).not.toContain("March 2024");
    }
    expect((await store.listAll(ref)).map((f) => f.kind)).toEqual(["timeline", "relations"]);
    await expect(store.replace({ ...ref, userId: U1B }, [])).rejects.toBeInstanceOf(
      DocumentGoneError,
    );
  });

  it("aggregateCount counts this document's timeline and relations rows without opening any fact", async () => {
    const ref = await fx.doc("c5".repeat(32));
    const other = await fx.doc("c6".repeat(32));
    const chunk = await seedChunk(ref);
    const otherChunk = await seedChunk(other);
    const store = new PgVisualFacts(fx.app, fx.fields);
    const { timeline, relations } = aggregateFacts(chunk);
    expect(await store.aggregateCount(ref)).toBe(0);
    await store.replace(ref, [fig(0, chunk), timeline]);
    await store.replace(other, [
      aggregateFacts(otherChunk).timeline,
      aggregateFacts(otherChunk).relations,
    ]);
    expect(await store.aggregateCount(ref)).toBe(1); // not the figure, not the other document's rows
    await store.replace(ref, [fig(0, chunk), timeline, relations]);
    expect(await store.aggregateCount(ref)).toBe(2);
    await store.replaceStructure(ref, [outlineFact(chunk)]);
    expect(await store.aggregateCount(ref)).toBe(2); // structure facts are not aggregates
    await store.replace(ref, [fig(0, chunk)]);
    expect(await store.aggregateCount(ref)).toBe(0);
    await expect(store.aggregateCount({ ...ref, userId: U1B })).rejects.toBeInstanceOf(
      DocumentGoneError,
    );
  });

  it("a stale ingest generation changes no aggregate (the extraction writer is fenced)", async () => {
    const ref = await fx.doc("c7".repeat(32));
    const chunk = await seedChunk(ref);
    const store = new PgVisualFacts(fx.app, fx.fields);
    const { timeline } = aggregateFacts(chunk);
    await fx.db.owner.query("UPDATE documents SET ingest_generation = 5 WHERE id = $1", [
      ref.documentId,
    ]);
    await store.replace(ref, [timeline], undefined, 5);
    await expect(store.replace(ref, [], undefined, 4)).rejects.toBeInstanceOf(DocumentGoneError);
    expect(await store.aggregateCount(ref)).toBe(1);
  });

  it("the extraction write stamps the document with the extraction format in its own transaction; nothing else does", async () => {
    const ref = await fx.doc("c8".repeat(32));
    const other = await fx.doc("c9".repeat(32));
    const chunk = await seedChunk(ref);
    const store = new PgVisualFacts(fx.app, fx.fields);
    expect(await store.extractFormat(ref)).toBeNull(); // a document extracted before c2: never stamped
    await store.replaceStructure(ref, [outlineFact(chunk)]);
    expect(await store.extractFormat(ref)).toBeNull(); // the structure writer never stamps
    await store.replace(ref, [fig(0, chunk)]);
    expect(await store.extractFormat(ref)).toBe(EXTRACT_FORMAT);
    expect(EXTRACT_FORMAT).toBe("docmind.extract@2");
    expect(await store.extractFormat(other)).toBeNull(); // another document is untouched
    // an extraction that found nothing, or was refused, is still an extraction under this format
    await fx.db.owner.query("UPDATE documents SET visual_extract_format = NULL WHERE id = $1", [
      ref.documentId,
    ]);
    await store.replace(ref, []);
    expect(await store.extractFormat(ref)).toBe(EXTRACT_FORMAT);
    // an older stamp is replaced by the current one
    await fx.db.owner.query(
      "UPDATE documents SET visual_extract_format = 'docmind.extract@1' WHERE id = $1",
      [ref.documentId],
    );
    expect(await store.extractFormat(ref)).toBe("docmind.extract@1");
    await store.replace(ref, [fig(0, chunk)]);
    expect(await store.extractFormat(ref)).toBe(EXTRACT_FORMAT);
  });

  it("a refused or superseded extraction write does not stamp, and the stamp is owner-scoped and bounded", async () => {
    const ref = await fx.doc("ca".repeat(32));
    const chunk = await seedChunk(ref);
    const store = new PgVisualFacts(fx.app, fx.fields);
    await expect(store.replace(ref, [fig(17, chunk)])).rejects.toThrow(
      /extraction writes ordinals/,
    );
    expect(await store.extractFormat(ref)).toBeNull();
    await fx.db.owner.query("UPDATE documents SET ingest_generation = 5 WHERE id = $1", [
      ref.documentId,
    ]);
    await expect(store.replace(ref, [fig(0, chunk)], undefined, 4)).rejects.toBeInstanceOf(
      DocumentGoneError,
    );
    expect(await store.extractFormat(ref)).toBeNull(); // the stale writer's transaction rolled back, stamp included
    await expect(store.extractFormat({ ...ref, userId: U1B })).rejects.toBeInstanceOf(
      DocumentGoneError,
    );
    await expect(
      fx.db.owner.query("UPDATE documents SET visual_extract_format = $2 WHERE id = $1", [
        ref.documentId,
        "x".repeat(65),
      ]),
    ).rejects.toThrow(/check/i);
  });

  it("a stale writer that read its generation before a concurrent re-ingest bump writes nothing (the fence serialises against the bump)", async () => {
    for (const which of ["replace", "replaceStructure"] as const) {
      const ref = await fx.doc(`d${which === "replace" ? "0" : "1"}`.repeat(32));
      const chunk = await seedChunk(ref);
      const store = new PgVisualFacts(fx.app, fx.fields);
      await fx.db.owner.query("UPDATE documents SET ingest_generation = 5 WHERE id = $1", [
        ref.documentId,
      ]);
      await store.replace(ref, [fig(0, chunk)], undefined, 5);
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let bumpedNow: () => void = () => {};
      const bumpedSignal = new Promise<void>((r) => {
        bumpedNow = r;
      });
      // The bump's transaction holds the row lock, uncommitted, while the stale writer starts.
      const bump = withTenant(fx.app, ref.tenantId, async (tx) => {
        await bumpGeneration(tx, ref.documentId, ref.userId, 5);
        bumpedNow();
        await gate;
      });
      await bumpedSignal;
      const stale =
        which === "replace"
          ? store.replace(ref, [], undefined, 5)
          : store.replaceStructure(ref, [outlineFact(chunk)], undefined, 5);
      const outcome = stale.then(
        () => "wrote",
        (e: unknown) => (e instanceof DocumentGoneError ? "gone" : "other"),
      );
      await new Promise((r) => setTimeout(r, 400));
      release();
      await bump;
      expect(await outcome).toBe("gone");
      expect((await store.listAll(ref)).map((f) => f.ordinal)).toEqual([0]);
    }
  });

  it("an unfenced write takes the documents row lock first, as a fenced one does (one lock order, no deadlock)", async () => {
    const ref = await fx.doc("e7".repeat(32));
    const chunk = await seedChunk(ref);
    const store = new PgVisualFacts(fx.app, fx.fields);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let heldNow: () => void = () => {};
    const held = new Promise<void>((r) => {
      heldNow = r;
    });
    const blocker = withTenant(fx.app, ref.tenantId, async (tx) => {
      await tx.query("SELECT 1 FROM documents WHERE id = $1 FOR NO KEY UPDATE", [ref.documentId]);
      heldNow();
      await gate;
    });
    await held;
    const write = store.replace(ref, [fig(0, chunk)]); // no generation
    // The write waits at its documents lock, before it has deleted or inserted anything.
    let waitingOn = "";
    for (let i = 0; i < 40 && !waitingOn; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const { rows } = await fx.db.owner.query<{ query: string }>(
        "SELECT query FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'SELECT ingest_generation%'",
      );
      waitingOn = rows[0]?.query ?? "";
    }
    expect(waitingOn).toContain("FOR NO KEY UPDATE");
    release();
    await blocker;
    await write;
    expect((await store.listAll(ref)).map((f) => f.ordinal)).toEqual([0]);
  });

  it("an aborted extraction write rolls the facts and the stamp back together", async () => {
    const ref = await fx.doc("d2".repeat(32));
    const chunk = await seedChunk(ref);
    const store = new PgVisualFacts(fx.app, fx.fields);
    await store.replace(ref, [fig(0, chunk)]);
    await fx.db.owner.query("UPDATE documents SET visual_extract_format = NULL WHERE id = $1", [
      ref.documentId,
    ]);
    const ac = new AbortController();
    ac.abort();
    await expect(store.replace(ref, [fig(1, chunk)], ac.signal)).rejects.toThrow();
    expect(await store.extractFormat(ref)).toBeNull();
    expect((await store.listAll(ref)).map((f) => f.ordinal)).toEqual([0]);
  });

  it("the database refuses an extracted kind at 16 or 17, by the pinned constraint", async () => {
    const ref = await fx.doc("d3".repeat(32));
    const chunk = await seedChunk(ref);
    const insert = (kind: string, ordinal: number) =>
      fx.db.owner.query(
        "INSERT INTO visual_facts (id, tenant_id, owner_id, document_id, kind, ordinal, fact_enc, chunk_ids) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, '{}'::jsonb, $6::uuid[])",
        [ref.tenantId, ref.userId, ref.documentId, kind, ordinal, [chunk]],
      );
    await expect(insert("figure", 16)).rejects.toThrow(/visual_facts_kind_ordinal_check/);
    await expect(insert("series", 17)).rejects.toThrow(/visual_facts_kind_ordinal_check/);
    await expect(insert("factTable", 16)).rejects.toThrow(/visual_facts_kind_ordinal_check/);
  });

  it("aggregateCount and extractFormat decrypt nothing", async () => {
    const ref = await fx.doc("d4".repeat(32));
    const chunk = await seedChunk(ref);
    const { timeline, relations } = aggregateFacts(chunk);
    await new PgVisualFacts(fx.app, fx.fields).replace(ref, [fig(0, chunk), timeline, relations]);
    const opened: string[] = [];
    const spy = {
      forUser: (u: string) => {
        const c = fx.fields.forUser(u);
        return {
          ...c,
          open: async (bind: string, env: unknown) => {
            opened.push(bind);
            return c.open(bind, env);
          },
        };
      },
    } as unknown as typeof fx.fields;
    const store = new PgVisualFacts(fx.app, spy);
    expect(await store.aggregateCount(ref)).toBe(2);
    expect(await store.extractFormat(ref)).toBe(EXTRACT_FORMAT);
    expect(opened).toEqual([]);
    await store.listAll(ref); // the control: reading facts does open them
    expect(opened.length).toBe(3);
  });
});
