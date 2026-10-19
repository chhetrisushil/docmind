import type { Identity } from "@docmind/auth";
import type { Pool } from "pg";
import { withTenant } from "../db/tenant";
import type { DocumentStatusReads } from "../status/ingestStatus";
import type { StatusView } from "../status/model";
import { type DocumentRow, bumpGeneration } from "./repo";
import type { StartScheduler } from "./startScheduler";

export interface RestartDeps {
  pool: Pool;
  status: DocumentStatusReads;
  starts: StartScheduler;
}

export type RestartResult =
  | { restarted: true; row: DocumentRow }
  | { restarted: false; view: StatusView };

/**
 * A failed document gets its next generation (D1), and that generation is fired after the bump
 * commits. Resumable: each step skips what is already done (D2). Anything but `failed` is left alone,
 * and so is a lost race (another retry or a delete moved the row first). `label` names the caller in
 * the start-failure log; it is never an id.
 */
export async function restartIfFailed(
  deps: RestartDeps,
  identity: Identity,
  row: DocumentRow,
  label: string,
): Promise<RestartResult> {
  const view = await deps.status.forDocument(identity, row.id, row.ingest_generation);
  if (view.status !== "failed") return { restarted: false, view };
  const next = await withTenant(deps.pool, identity.tenantId, (tx) =>
    bumpGeneration(tx, row.id, identity.userId, row.ingest_generation),
  );
  if (!next) return { restarted: false, view };
  deps.starts.fire(identity, next.id, next.ingest_generation, label);
  return { restarted: true, row: next };
}
