import type { Identity } from "@docmind/auth";
import { factFormatFingerprint } from "@docmind/experiences";
import type { EventEnvelope } from "@loom/core";
import type { Pool } from "pg";
import { withTenant } from "../../db/tenant";
import type { ProgressBus } from "../../documents/progress";
import { parseVisualizeExecution } from "../../status/model";
import { VisualizeOutput } from "./flow";

export type VisualRunState = "running" | VisualizeOutput["outcome"];
export type VisualRunCode = NonNullable<VisualizeOutput["code"]> | "internal";

/** The last visualize run of a document's ingest generation: its number (0 is the automatic run, n is `-r<n>`), state and fixed code. */
export interface VisualRun {
  run: number;
  state: VisualRunState;
  code: VisualRunCode | null;
}

export interface VisualRuns {
  /**
   * Records a run's state (migration 0030 keeps the newest run and never reopens a finished one). Ids, enums, a code and the
   * fact-format fingerprint only; the fingerprint is kept only for a `done` run (any other state leaves the last stamp).
   */
  record(
    r: { userId: string; documentId: string; generation: number; run: number },
    state: VisualRunState,
    code?: VisualRunCode,
    format?: string,
  ): Promise<void>;
  /** The last run of the generation, owner-scoped; null when none was recorded. */
  last(
    identity: Pick<Identity, "tenantId" | "userId">,
    documentId: string,
    generation: number,
  ): Promise<VisualRun | null>;
}

export class PgVisualRuns implements VisualRuns {
  constructor(private readonly pool: Pick<Pool, "query" | "connect">) {}

  async record(
    r: { userId: string; documentId: string; generation: number; run: number },
    state: VisualRunState,
    code?: VisualRunCode,
    format?: string,
  ): Promise<void> {
    await this.pool.query(
      "SELECT public.docmind_record_visual_run($1::uuid, $2::uuid, $3::integer, $4::integer, $5, $6, $7)",
      [
        r.userId,
        r.documentId.toLowerCase(),
        r.generation,
        r.run,
        state,
        code ?? null,
        format ?? null,
      ],
    );
  }

  async last(
    identity: Pick<Identity, "tenantId" | "userId">,
    documentId: string,
    generation: number,
  ): Promise<VisualRun | null> {
    const { rows } = await withTenant(this.pool as Pool, identity.tenantId, (tx) =>
      tx.query<{ run: number; state: VisualRunState; code: VisualRunCode | null }>(
        "SELECT run, state, code FROM visual_runs WHERE document_id = $1 AND generation = $2 AND owner_id = $3",
        [documentId.toLowerCase(), generation, identity.userId],
      ),
    );
    const row = rows[0];
    return row ? { run: Number(row.run), state: row.state, code: row.code } : null;
  }
}

const logClass = (err: unknown) =>
  console.error(
    "visual run record failed",
    err instanceof Error ? err.constructor.name : typeof err,
  );

/**
 * An event sink (beside the status model's): when a visualize execution ends, records its outcome and, for a failed run,
 * tells the owner's open pages (`visuals: "failed"`). It reads the execution id and the output's outcome and code only,
 * never content. Synchronous and never throws; the write follows on a chain, in event order.
 */
export function visualRunRecorder(o: {
  runs: Pick<VisualRuns, "record">;
  bus: ProgressBus;
  onError?: (err: unknown) => void;
}): { onEvent(e: EventEnvelope): void; idle(): Promise<void> } {
  const report = o.onError ?? logClass;
  let chain: Promise<void> = Promise.resolve();
  return {
    onEvent(e) {
      if (
        e.eventType !== "EXECUTION_COMPLETED" &&
        e.eventType !== "EXECUTION_FAILED" &&
        e.eventType !== "EXECUTION_CANCELLED"
      )
        return;
      const id = parseVisualizeExecution(e.executionId);
      if (!id) return;
      const end = endOf(e);
      if (!end) return;
      chain = chain
        .then(async () => {
          await o.runs.record(
            {
              userId: id.userId,
              documentId: id.documentId,
              generation: id.generation,
              run: id.rerun,
            },
            end.state,
            end.code,
            ...(end.state === "done" ? [factFormatFingerprint()] : []),
            // A committed run (outcome done) is stamped with the format it planned over. Only this live feed stamps: a run
            // repaired at boot (`reconcile`) is not, since that process cannot know which code wrote it. The row keeps the
            // PREVIOUS stamp (COALESCE in the SQL), so a stale re-run whose end event was lost is still stale and is
            // re-planned once more at the next boot (one bounded extra planner call). A NULL stamp is never stale.
          );
          if (end.state === "failed" && end.notify)
            o.bus.publish(
              { userId: id.userId },
              { documentId: id.documentId, status: "ready", step: "finalize", visuals: "failed" },
            );
        })
        .catch(report);
    },
    idle: () => chain,
  };
}

/** The recorded outcome of a terminal Loom execution state (its output is ids and enums only); null while it has not ended. */
export function outcomeOfState(state: {
  status: string;
  variables?: Record<string, unknown>;
}): { state: VisualRunState; code?: VisualRunCode } | null {
  if (state.status === "completed") {
    const out = VisualizeOutput.safeParse(state.variables?._output);
    return out.success
      ? { state: out.data.outcome, ...(out.data.code && { code: out.data.code }) }
      : { state: "failed", code: "internal" };
  }
  if (state.status === "failed" || state.status === "cancelled")
    return { state: "failed", code: "internal" };
  return null;
}

function endOf(
  e: EventEnvelope,
): { state: VisualRunState; code?: VisualRunCode; notify: boolean } | null {
  if (e.eventType === "EXECUTION_COMPLETED") {
    const payload = e.payload as { output?: unknown } | undefined;
    const out = VisualizeOutput.safeParse(payload?.output);
    if (!out.success) return null;
    return { state: out.data.outcome, ...(out.data.code && { code: out.data.code }), notify: true };
  }
  // A thrown failure is a failed run the user may retry. A cancel (recovery gave up, or a delete or a retry of the
  // document) is recorded too, so a run never stays `running`, but tells no page: a delete finds no document row.
  return { state: "failed", code: "internal", notify: e.eventType === "EXECUTION_FAILED" };
}
