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
  starter: Pick<VisualsStarter, "running">;
}): VisualsStateReader {
  return async (identity, documentId, hasHead) => {
    if (o.starter.running({ userId: identity.userId, documentId })) return "running";
    const doc = await withTenant(o.pool, identity.tenantId, (tx) =>
      getDocument(tx, identity.userId, documentId),
    );
    const last = doc ? await o.runs.last(identity, documentId, doc.ingest_generation) : null;
    if (last?.state === "running") return "running";
    if (hasHead) return "ready";
    return last?.state === "failed" ? "failed" : "none";
  };
}
