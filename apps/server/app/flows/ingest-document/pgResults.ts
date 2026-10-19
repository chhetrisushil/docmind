import type { DocumentStats, DocumentSummary } from "@docmind/contracts";
import { ParseAbortedError } from "@docmind/parsers";
import type { Pool } from "pg";
import type { FieldCrypto } from "../../crypto/fields";
import { withTenant } from "../../db/tenant";
import { statsBind, summaryBind } from "../../documents/repo";
import { DocumentGoneError } from "./errors";
import type { IngestStartInput } from "./flow";

export interface DocumentResults {
  putStats(ref: IngestStartInput, stats: DocumentStats, signal?: AbortSignal): Promise<void>;
  hasSummary(ref: IngestStartInput): Promise<boolean>;
  putSummary(ref: IngestStartInput, summary: DocumentSummary, signal?: AbortSignal): Promise<void>;
}

/** The analyze and summarize results on the document row, sealed (statsBind / summaryBind, the binds toDto opens). */
export class PgDocumentResults implements DocumentResults {
  constructor(
    private readonly pool: Pool,
    private readonly fields: FieldCrypto,
  ) {}

  private async put(
    ref: IngestStartInput,
    column: "stats_enc" | "summary_enc",
    sealed: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    await withTenant(this.pool, ref.tenantId, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE documents SET ${column} = $3::jsonb WHERE id = $1 AND owner_id = $2 RETURNING id`,
        [ref.documentId, ref.userId, JSON.stringify(sealed)],
      );
      if (!rowCount) throw new DocumentGoneError();
      if (signal?.aborted) throw new ParseAbortedError(); // last before COMMIT: an abandoned attempt rolls back
    });
  }

  async putStats(ref: IngestStartInput, stats: DocumentStats, signal?: AbortSignal): Promise<void> {
    const sealed = await this.fields.forUser(ref.userId).seal(statsBind(ref.documentId), stats);
    await this.put(ref, "stats_enc", sealed, signal);
  }

  async hasSummary(ref: IngestStartInput): Promise<boolean> {
    const row = await withTenant(
      this.pool,
      ref.tenantId,
      async (tx) =>
        (
          await tx.query<{ has: boolean }>(
            "SELECT summary_enc IS NOT NULL AS has FROM documents WHERE id = $1 AND owner_id = $2",
            [ref.documentId, ref.userId],
          )
        ).rows[0],
    );
    if (!row) throw new DocumentGoneError();
    return row.has;
  }

  async putSummary(
    ref: IngestStartInput,
    summary: DocumentSummary,
    signal?: AbortSignal,
  ): Promise<void> {
    const sealed = await this.fields.forUser(ref.userId).seal(summaryBind(ref.documentId), summary);
    await this.put(ref, "summary_enc", sealed, signal);
  }
}
