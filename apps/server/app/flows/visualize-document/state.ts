import type { Identity } from "@docmind/auth";
import type { VisualsState } from "@docmind/contracts";
import type { Pool } from "pg";
import { withTenant } from "../../db/tenant";
import { getDocument } from "../../documents/repo";
import type { VisualRuns } from "./runs";
import type { VisualsStarter } from "./start";

/**
 * Where a document's visuals stand, for its detail response (the caller owns the document): `running` while a run is in
 * flight (this process's, or one the table records as running), else `ready` when the lineage has a head, else `failed`
 * when the last run ended failed, else `none` (not made yet, empty, skipped).
 */
export type VisualsStateReader = (
  identity: Identity,
  documentId: string,
  hasHead: boolean,
) => Promise<VisualsState>;

export function visualsStateReader(o: {
  pool: Pool;
  runs: Pick<VisualRuns, "last">;
  starter: Pick<VisualsStarter, "running" | "reconcile">;
}): VisualsStateReader {
  return async (identity, documentId, hasHead) => {
    const doc = await withTenant(o.pool, identity.tenantId, (tx) =>
      getDocument(tx, identity.userId, documentId),
    );
    if (!doc) return hasHead ? "ready" : "none";
    const ref = { tenantId: identity.tenantId, userId: identity.userId, documentId };
    if (o.starter.running(ref, doc.ingest_generation)) return "running";
    let last = await o.runs.last(identity, documentId, doc.ingest_generation);
    // A `running` row this process is not tracking may be a lost end event: ask Loom and repair it, so it never sticks.
    if (last?.state === "running")
      last = await o.starter.reconcile(ref, doc.ingest_generation, last);
    if (last?.state === "running") return "running";
    if (hasHead) return "ready";
    return last?.state === "failed" ? "failed" : "none";
  };
}
