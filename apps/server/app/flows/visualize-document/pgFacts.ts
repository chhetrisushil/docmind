import { randomUUID } from "node:crypto";
import { ParseAbortedError } from "@docmind/parsers";
import type { Pool } from "pg";
import type { FieldCrypto } from "../../crypto/fields";
import { withTenant } from "../../db/tenant";
import { DocumentGoneError } from "../ingest-document/errors";
import { lockDocument } from "../ingest-document/pgEntities";
import {
  AGGREGATE_ORDINAL_BASE,
  type AnyFact,
  ENTITY_MAP_ORDINAL,
  EXTRACT_FORMAT,
  type ExtractionWrite,
  type Fact,
  OUTLINE_ORDINAL,
  RELATIONS_ORDINAL,
  STRUCTURE_ORDINAL_BASE,
  StoredEntry,
  StoredFact,
  type StructureFact,
  TIMELINE_ORDINAL,
  isAggregateFact,
} from "./facts";

export type VisualizeRef = { tenantId: string; userId: string; documentId: string };

export interface VisualFactStore {
  /**
   * Replaces the document's EXTRACTION-owned rows in one transaction: the extracted facts (ordinals 0..15) and the model's
   * aggregates (the timeline at 18, the relations at 19), together, so an extraction with no timeline removes the old one.
   * Returns the rows written. The structure facts (16 and 17) are not touched.
   */
  replace(
    ref: VisualizeRef,
    facts: readonly ExtractionWrite[],
    signal?: AbortSignal,
    generation?: number,
  ): Promise<number>;
  /** Replaces the document's STRUCTURE facts (ordinals 16 and 17) in one transaction; every other row is not touched. */
  replaceStructure(
    ref: VisualizeRef,
    facts: readonly StructureFact[],
    signal?: AbortSignal,
    generation?: number,
  ): Promise<number>;
  /** The document's extracted facts in ordinal order: what chat and the extraction re-plan check read. Throws DocumentGoneError if the user does not own it. */
  list(ref: VisualizeRef): Promise<Fact[]>;
  /** Every fact of the document, structure facts and aggregates included, in ordinal order. Throws DocumentGoneError if the user does not own it. */
  listAll(ref: VisualizeRef): Promise<AnyFact[]>;
  /** How many aggregate rows (timeline, relations) the document has. Counts rows only: nothing is opened. Throws DocumentGoneError if the user does not own it. */
  aggregateCount(ref: VisualizeRef): Promise<number>;
  /** The format of the extraction that last wrote this document's facts (`EXTRACT_FORMAT`), or null when it was extracted before the stamp existed. Throws DocumentGoneError if the user does not own it. */
  extractFormat(ref: VisualizeRef): Promise<string | null>;
}

const factBind = (id: string) => `visualfact:${id}:fact`;

/** The ordinal each aggregate kind lives at. */
const AGGREGATE_ORDINAL = { timeline: TIMELINE_ORDINAL, relations: RELATIONS_ORDINAL } as const;

/** True when `f` is a row the extraction writer owns: a fact at 0..15, the timeline at 18 or the relations at 19. */
const extractionOwns = (f: ExtractionWrite): boolean =>
  isAggregateFact(f)
    ? f.ordinal === AGGREGATE_ORDINAL[f.kind]
    : Number.isInteger(f.ordinal) && f.ordinal >= 0 && f.ordinal < STRUCTURE_ORDINAL_BASE;

/**
 * The ordinals each writer replaces, as a SQL predicate over `ordinal` with `$4` = 16 and `$5` = 18: extraction owns
 * `< 16` and `>= 18`, structure owns `>= 16` and `< 18`. The two sets are disjoint and together cover 0..19.
 */
const OWNED = {
  extraction: "(ordinal < $4 OR ordinal >= $5)",
  structure: "(ordinal >= $4 AND ordinal < $5)",
} as const;

export class PgVisualFacts implements VisualFactStore {
  constructor(
    private readonly pool: Pool,
    private readonly fields: FieldCrypto,
  ) {}

  // `async`, so a refused range is a rejected promise (as every caller and test sees it), never a synchronous throw.
  async replace(
    ref: VisualizeRef,
    facts: readonly ExtractionWrite[],
    signal?: AbortSignal,
    generation?: number,
  ): Promise<number> {
    if (!facts.every(extractionOwns))
      throw new Error(
        "extraction writes ordinals 0..15, the timeline at 18 and the relations at 19",
      );
    // Refuse an aggregate no reader could parse: the step fails here, instead of every `listAll` failing on every later run.
    for (const f of facts)
      if (isAggregateFact(f) && !StoredEntry.safeParse(f).success)
        throw new Error("aggregate fact has an unexpected shape");
    return this.write(ref, facts, "extraction", signal, generation);
  }

  async replaceStructure(
    ref: VisualizeRef,
    facts: readonly StructureFact[],
    signal?: AbortSignal,
    generation?: number,
  ): Promise<number> {
    if (facts.some((f) => f.ordinal !== OUTLINE_ORDINAL && f.ordinal !== ENTITY_MAP_ORDINAL))
      throw new Error("structure facts use ordinals 16 and 17");
    // Refuse a fact no reader could parse: the step fails here, instead of every `listAll` failing on every later run.
    for (const f of facts)
      if (!StoredEntry.safeParse(f).success)
        throw new Error("structure fact has an unexpected shape");
    return this.write(ref, facts, "structure", signal, generation);
  }

  /** `owner` names the writer: it decides which ordinals the transaction deletes before it inserts. */
  private async write(
    ref: VisualizeRef,
    facts: readonly AnyFact[],
    owner: keyof typeof OWNED,
    signal?: AbortSignal,
    generation?: number,
  ): Promise<number> {
    // Sealing may call the key store: do it before the transaction, never under row locks.
    const cipher = this.fields.forUser(ref.userId);
    const rows = await Promise.all(
      facts.map(async (f) => {
        const id = randomUUID();
        return {
          id,
          // The column carries the fact's own kind (migrations 0035 and 0037 widened its CHECKs); the sealed fact's `kind` is what readers use.
          kind: f.kind,
          ordinal: f.ordinal,
          chunkIds: f.chunkIds,
          sealed: JSON.stringify(await cipher.seal(factBind(id), f)),
        };
      }),
    );
    await withTenant(this.pool, ref.tenantId, async (tx) => {
      await lockDocument(tx, ref);
      // Every write locks the documents row FIRST (FOR NO KEY UPDATE), fenced or not, so the lock order is documents then
      // visual_facts for all writers (an unfenced and a fenced write of one document cannot deadlock). It conflicts with a
      // re-ingest's generation bump (lockDocument's KEY SHARE does not), so a bump in flight commits first and this read
      // sees it. No deadlock: the bump locks only this one documents row.
      const { rows: held } = await tx.query<{ ingest_generation: number }>(
        "SELECT ingest_generation FROM documents WHERE id = $1 AND owner_id = $2 AND tenant_id = $3 FOR NO KEY UPDATE",
        [ref.documentId, ref.userId, ref.tenantId],
      );
      // The step guard checked the generation at begin; a re-ingest can land after that. Under the document lock, a run of a
      // superseded generation writes nothing (the same outcome as the guard: the document is gone for this run).
      if (generation !== undefined && Number(held[0]?.ingest_generation) !== generation)
        throw new DocumentGoneError();
      await tx.query(
        `DELETE FROM visual_facts
          WHERE tenant_id = $1 AND owner_id = $2 AND document_id = $3 AND ${OWNED[owner]}`,
        [ref.tenantId, ref.userId, ref.documentId, STRUCTURE_ORDINAL_BASE, AGGREGATE_ORDINAL_BASE],
      );
      for (const r of rows) {
        await tx.query(
          `INSERT INTO visual_facts (id, tenant_id, owner_id, document_id, kind, ordinal, fact_enc, chunk_ids)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::uuid[])`,
          [r.id, ref.tenantId, ref.userId, ref.documentId, r.kind, r.ordinal, r.sealed, r.chunkIds],
        );
      }
      // Only the extraction write stamps: the stamp says which extraction made these facts (spec D5), in the same transaction.
      if (owner === "extraction")
        await tx.query(
          "UPDATE documents SET visual_extract_format = $4 WHERE id = $1 AND owner_id = $2 AND tenant_id = $3",
          [ref.documentId, ref.userId, ref.tenantId, EXTRACT_FORMAT],
        );
      if (signal?.aborted) throw new ParseAbortedError();
    });
    return rows.length;
  }

  async listAll(ref: VisualizeRef): Promise<AnyFact[]> {
    return this.read(ref, StoredEntry, "");
  }

  /** Extracted facts only: every other row is filtered in SQL, so chat never opens or parses it. */
  async list(ref: VisualizeRef): Promise<Fact[]> {
    return (await this.read(ref, StoredFact, `AND ordinal < ${STRUCTURE_ORDINAL_BASE}`)) as Fact[];
  }

  async aggregateCount(ref: VisualizeRef): Promise<number> {
    const res = await withTenant(this.pool, ref.tenantId, async (tx) => {
      await lockDocument(tx, ref);
      return tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM visual_facts
          WHERE tenant_id = $1 AND owner_id = $2 AND document_id = $3 AND ordinal >= $4`,
        [ref.tenantId, ref.userId, ref.documentId, AGGREGATE_ORDINAL_BASE],
      );
    });
    return res.rows[0]?.n ?? 0;
  }

  async extractFormat(ref: VisualizeRef): Promise<string | null> {
    const res = await withTenant(this.pool, ref.tenantId, async (tx) => {
      await lockDocument(tx, ref);
      return tx.query<{ format: string | null }>(
        "SELECT visual_extract_format AS format FROM documents WHERE id = $1 AND owner_id = $2 AND tenant_id = $3",
        [ref.documentId, ref.userId, ref.tenantId],
      );
    });
    return res.rows[0]?.format ?? null;
  }

  private async read(
    ref: VisualizeRef,
    schema: { safeParse(v: unknown): { success: boolean; data?: unknown } },
    extra: string,
  ): Promise<AnyFact[]> {
    const res = await withTenant(this.pool, ref.tenantId, async (tx) => {
      await lockDocument(tx, ref);
      return tx.query<{ id: string; fact_enc: unknown }>(
        `SELECT id, fact_enc FROM visual_facts
          WHERE tenant_id = $1 AND owner_id = $2 AND document_id = $3 ${extra} ORDER BY ordinal`,
        [ref.tenantId, ref.userId, ref.documentId],
      );
    });
    const cipher = this.fields.forUser(ref.userId);
    return Promise.all(
      res.rows.map(async (r) => {
        const parsed = schema.safeParse(await cipher.open(factBind(r.id), r.fact_enc));
        if (!parsed.success) throw new Error("visual fact has an unexpected shape");
        return parsed.data as AnyFact;
      }),
    );
  }
}
