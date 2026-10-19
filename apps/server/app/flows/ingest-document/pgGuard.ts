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
  ): Promise<void> {
    let found: boolean;
    try {
      found = await withTenant(this.pool, tenantId, async (tx) => {
        const { rowCount } = await tx.query(
          "SELECT 1 FROM documents WHERE id = $1 AND owner_id = $2",
          [documentId, userId],
        );
        return (rowCount ?? 0) > 0;
      });
    } catch {
      throw new Error("document existence check failed");
    }
    if (!found) throw new DocumentGoneError();
  }
}
