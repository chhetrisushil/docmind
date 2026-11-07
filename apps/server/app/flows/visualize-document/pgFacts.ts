import { randomUUID } from "node:crypto";
import { ParseAbortedError } from "@docmind/parsers";
import type { Pool } from "pg";
import type { FieldCrypto } from "../../crypto/fields";
import { withTenant } from "../../db/tenant";
import { lockDocument } from "../ingest-document/pgEntities";
import { type Fact, StoredFact } from "./facts";

export type VisualizeRef = { tenantId: string; userId: string; documentId: string };

export interface VisualFactStore {
  /** Replaces the document's facts in one transaction; returns the rows written. */
  replace(ref: VisualizeRef, facts: readonly Fact[], signal?: AbortSignal): Promise<number>;
  /** The document's facts in ordinal order. Throws DocumentGoneError if the user does not own it. */
  list(ref: VisualizeRef): Promise<Fact[]>;
}

const factBind = (id: string) => `visualfact:${id}:fact`;

export class PgVisualFacts implements VisualFactStore {
  constructor(
    private readonly pool: Pool,
    private readonly fields: FieldCrypto,
  ) {}

  async replace(ref: VisualizeRef, facts: readonly Fact[], signal?: AbortSignal): Promise<number> {
    // Sealing may call the key store: do it before the transaction, never under row locks.
    const cipher = this.fields.forUser(ref.userId);
    const rows = await Promise.all(
      facts.map(async (f) => {
        const id = randomUUID();
        return {
          id,
          kind: f.kind,
          ordinal: f.ordinal,
          chunkIds: f.chunkIds,
          sealed: JSON.stringify(await cipher.seal(factBind(id), f)),
        };
      }),
    );
    await withTenant(this.pool, ref.tenantId, async (tx) => {
      await lockDocument(tx, ref);
      await tx.query("DELETE FROM visual_facts WHERE document_id = $1", [ref.documentId]);
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

  async list(ref: VisualizeRef): Promise<Fact[]> {
    const res = await withTenant(this.pool, ref.tenantId, async (tx) => {
      await lockDocument(tx, ref);
      return tx.query<{ id: string; fact_enc: unknown }>(
        "SELECT id, fact_enc FROM visual_facts WHERE document_id = $1 AND owner_id = $2 ORDER BY ordinal",
        [ref.documentId, ref.userId],
      );
    });
    const cipher = this.fields.forUser(ref.userId);
    return Promise.all(
      res.rows.map(async (r) => {
        const parsed = StoredFact.safeParse(await cipher.open(factBind(r.id), r.fact_enc));
        if (!parsed.success) throw new Error("visual fact has an unexpected shape");
        return parsed.data;
      }),
    );
  }
}
