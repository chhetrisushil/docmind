import { randomUUID } from "node:crypto";
import { ParseAbortedError } from "@docmind/parsers";
import type { Pool } from "pg";
import type { FieldCrypto } from "../../crypto/fields";
import { withTenant } from "../../db/tenant";
import { lockDocument } from "../ingest-document/pgEntities";
import {
  type AnyFact,
  ENTITY_MAP_ORDINAL,
  type Fact,
  OUTLINE_ORDINAL,
  STRUCTURE_ORDINAL_BASE,
  StoredEntry,
  StoredFact,
  type StructureFact,
} from "./facts";

export type VisualizeRef = { tenantId: string; userId: string; documentId: string };

export interface VisualFactStore {
  /**
   * Replaces the document's EXTRACTED facts (ordinals below 16) in one transaction; returns the rows written. The structure
   * facts (ordinals 16 and 17) are not touched.
   */
  replace(ref: VisualizeRef, facts: readonly Fact[], signal?: AbortSignal): Promise<number>;
  /** Replaces the document's STRUCTURE facts (ordinals 16 and 17) in one transaction; the extracted facts are not touched. */
  replaceStructure(
    ref: VisualizeRef,
    facts: readonly StructureFact[],
    signal?: AbortSignal,
  ): Promise<number>;
  /** The document's extracted facts in ordinal order: what chat and the extraction re-plan check read. Throws DocumentGoneError if the user does not own it. */
  list(ref: VisualizeRef): Promise<Fact[]>;
  /** Every fact of the document, structure facts included, in ordinal order. Throws DocumentGoneError if the user does not own it. */
  listAll(ref: VisualizeRef): Promise<AnyFact[]>;
}

const factBind = (id: string) => `visualfact:${id}:fact`;

export class PgVisualFacts implements VisualFactStore {
  constructor(
    private readonly pool: Pool,
    private readonly fields: FieldCrypto,
  ) {}

  // `async`, so a refused range is a rejected promise (as every caller and test sees it), never a synchronous throw.
  async replace(ref: VisualizeRef, facts: readonly Fact[], signal?: AbortSignal): Promise<number> {
    if (facts.some((f) => f.ordinal >= STRUCTURE_ORDINAL_BASE))
      throw new Error("extracted facts use ordinals below 16");
    return this.write(ref, facts, "<", signal);
  }

  async replaceStructure(
    ref: VisualizeRef,
    facts: readonly StructureFact[],
    signal?: AbortSignal,
  ): Promise<number> {
    if (facts.some((f) => f.ordinal !== OUTLINE_ORDINAL && f.ordinal !== ENTITY_MAP_ORDINAL))
      throw new Error("structure facts use ordinals 16 and 17");
    // Refuse a fact no reader could parse: the step fails here, instead of every `listAll` failing on every later run.
    for (const f of facts)
      if (!StoredEntry.safeParse(f).success)
        throw new Error("structure fact has an unexpected shape");
    return this.write(ref, facts, ">=", signal);
  }

  /** `side` is the comparison of the writer's range against the base ordinal: `<` (extracted) or `>=` (structure). */
  private async write(
    ref: VisualizeRef,
    facts: readonly AnyFact[],
    side: "<" | ">=",
    signal?: AbortSignal,
  ): Promise<number> {
    // Sealing may call the key store: do it before the transaction, never under row locks.
    const cipher = this.fields.forUser(ref.userId);
    const rows = await Promise.all(
      facts.map(async (f) => {
        const id = randomUUID();
        return {
          id,
          // The column carries the fact's own kind (migration 0035 widened its CHECK); the sealed fact's `kind` is what readers use.
          kind: f.kind,
          ordinal: f.ordinal,
          chunkIds: f.chunkIds,
          sealed: JSON.stringify(await cipher.seal(factBind(id), f)),
        };
      }),
    );
    await withTenant(this.pool, ref.tenantId, async (tx) => {
      await lockDocument(tx, ref);
      await tx.query(
        `DELETE FROM visual_facts
          WHERE tenant_id = $1 AND owner_id = $2 AND document_id = $3 AND ordinal ${side} $4`,
        [ref.tenantId, ref.userId, ref.documentId, STRUCTURE_ORDINAL_BASE],
      );
      for (const r of rows) {
        await tx.query(
          `INSERT INTO visual_facts (id, tenant_id, owner_id, document_id, kind, ordinal, fact_enc, chunk_ids)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::uuid[])`,
          [r.id, ref.tenantId, ref.userId, ref.documentId, r.kind, r.ordinal, r.sealed, r.chunkIds],
        );
      }
      if (signal?.aborted) throw new ParseAbortedError();
    });
    return rows.length;
  }

  async listAll(ref: VisualizeRef): Promise<AnyFact[]> {
    return this.read(ref, StoredEntry, "");
  }

  /** Extracted facts only: the structure rows are filtered in SQL, so chat never opens or parses them. */
  async list(ref: VisualizeRef): Promise<Fact[]> {
    return (await this.read(ref, StoredFact, `AND ordinal < ${STRUCTURE_ORDINAL_BASE}`)) as Fact[];
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
