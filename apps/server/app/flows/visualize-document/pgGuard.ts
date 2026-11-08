import type { Pool } from "pg";
import { withTenant } from "../../db/tenant";
import { DocumentGoneError } from "../ingest-document/errors";
import type { IngestStartInput } from "../ingest-document/flow";
import type { StepGuard } from "../ingest-document/stepEffect";

/**
 * The visualize steps' guard: the document must still exist for its owner on the generation this execution ran for
 * (D1), and its owner must not be being erased (`users.erasing_at`): a late start or a re-driven step of an erasing
 * user's document ends as `document_gone` and writes nothing. A failure is rethrown with a fixed message.
 */
export class PgVisualizeGuard implements StepGuard {
  constructor(private readonly pool: Pool) {}

  async begin(
    { tenantId, userId, documentId }: IngestStartInput,
    _step: string,
    generation?: number,
  ) {
    let row: { ingest_generation: number } | undefined;
    try {
      row = await withTenant(this.pool, tenantId, async (tx) => {
        const { rows } = await tx.query<{ ingest_generation: number }>(
          `SELECT d.ingest_generation FROM documents d
             JOIN users u ON u.id = d.owner_id AND u.erasing_at IS NULL
            WHERE d.id = $1 AND d.owner_id = $2`,
          [documentId, userId],
        );
        return rows[0];
      });
    } catch {
      throw new Error("document existence check failed");
    }
    if (row === undefined) throw new DocumentGoneError();
    if (generation !== undefined && Number(row.ingest_generation) !== generation)
      throw new DocumentGoneError();
  }
}
