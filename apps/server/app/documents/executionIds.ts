import type { Pool } from "pg";
import { withTenant } from "../db/tenant";

/**
 * Where a document's current ingest and visualize execution ids are kept (`documents.ingest_execution_id` and `visualize_execution_id`,
 * migration 0038). The sweeps and the connections reader compare these columns with the status rows' execution ids; they can no longer
 * build the ids themselves, because a new-format id needs the user's key.
 */
export interface ExecutionRecorder {
  /** Records the id of the document's CURRENT ingest execution unless one is already recorded for this generation. A bumped or deleted document is a no-op. */
  recordIngest(
    who: { tenantId: string; userId: string },
    documentId: string,
    generation: number,
    executionId: string,
  ): Promise<void>;
  /** The same for the visualize execution (run 0) of the generation. */
  recordVisualize(
    who: { tenantId: string; userId: string },
    documentId: string,
    generation: number,
    executionId: string,
  ): Promise<void>;
}

/** An old pod only ingests documents that were just uploaded or retried, so the boot repair looks back one week. */
export const BOOT_REPAIR_WINDOW_SECONDS = 7 * 24 * 3600;

const COLUMN = { ingest: "ingest_execution_id", visualize: "visualize_execution_id" } as const;

/**
 * Runs migration 0038's idempotent backfill (`public.docmind_repair_execution_ids`, SECURITY DEFINER: the sweep's cross-tenant reach) and
 * returns how many columns it set. A document whose current generation has an old-format status row and no stored id gets that id: this is
 * how a document an OLD pod ingested between the migration job and the stop of the old pod (old pods never write the columns) is found by the sweeps. It never overwrites
 * a stored id. `bootIngest` calls it before the sweeps start (Task 6).
 */
export async function repairStoredExecutionIds(
  pool: Pick<Pool, "query">,
  /** Only documents updated within this many seconds are repaired (the boot call: 7 days). `undefined` is unbounded, as the migration's own call is. */
  withinSeconds: number | undefined = BOOT_REPAIR_WINDOW_SECONDS,
): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    "SELECT public.docmind_repair_execution_ids(CASE WHEN $1::float8 IS NULL THEN NULL ELSE make_interval(secs => $1::float8) END) AS n",
    [withinSeconds ?? null],
  );
  return rows[0]?.n ?? 0;
}

export class PgExecutionRecorder implements ExecutionRecorder {
  constructor(private readonly pool: Pool) {}

  private record(
    column: keyof typeof COLUMN,
    who: { tenantId: string; userId: string },
    documentId: string,
    generation: number,
    executionId: string,
  ): Promise<void> {
    // The column name comes from the closed map above, never from input.
    return withTenant(this.pool, who.tenantId, async (tx) => {
      await tx.query(
        `UPDATE documents SET ${COLUMN[column]} = $1
          WHERE id = $2 AND owner_id = $3 AND tenant_id = $4
            AND ingest_generation = $5 AND ${COLUMN[column]} IS NULL`,
        [executionId, documentId, who.userId, who.tenantId, generation],
      );
    });
  }

  recordIngest(
    who: { tenantId: string; userId: string },
    documentId: string,
    generation: number,
    executionId: string,
  ) {
    return this.record("ingest", who, documentId, generation, executionId);
  }

  recordVisualize(
    who: { tenantId: string; userId: string },
    documentId: string,
    generation: number,
    executionId: string,
  ) {
    return this.record("visualize", who, documentId, generation, executionId);
  }
}
