import type { IngestStep } from "@docmind/contracts";
import type { Pool } from "pg";
import { withTenant } from "../../db/tenant";
import { DocumentGoneError } from "./errors";
import type { IngestStartInput } from "./flow";
import type { StepGuard } from "./stepEffect";

/**
 * Is the document still there for its owner? Tenant- and owner-scoped; ids in, nothing out. A failure
 * is rethrown with a fixed message, because a step failure's message lands in the event log and the
 * driver's error can carry ids or SQL parameters.
 */
export class PgStepGuard implements StepGuard {
  constructor(private readonly pool: Pool) {}

  async begin(
    { tenantId, userId, documentId }: IngestStartInput,
    _step: IngestStep,
    generation?: number,
  ): Promise<void> {
    let current: number | undefined;
    try {
      current = await withTenant(this.pool, tenantId, async (tx) => {
        const { rows } = await tx.query<{ ingest_generation: number }>(
          "SELECT ingest_generation FROM documents WHERE id = $1 AND owner_id = $2",
          [documentId, userId],
        );
        return rows[0]?.ingest_generation;
      });
    } catch {
      throw new Error("document existence check failed");
    }
    if (current === undefined) throw new DocumentGoneError();
    if (generation !== undefined && generation !== current) throw new DocumentGoneError(); // superseded (D1)
  }
}
