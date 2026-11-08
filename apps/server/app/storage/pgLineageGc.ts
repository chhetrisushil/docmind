import type { Lineage } from "@loom-ui/lineage";
import type { Pool } from "pg";
import { pgSessionLock } from "../db/sessionLock";
import type { LineageGcDeps } from "./lineageGc";
import type { PgContentStore } from "./pgContentStore";

/** The session advisory lock one collection holds, on the Loom database (every replica shares it). */
export const LINEAGE_GC_LOCK_KEY = "docmind:lineage-gc";

/**
 * The production collector deps. `lineage` is THE visuals `Lineage` (one instance holds every line: document
 * `visuals-*` and chat-turn `turnvisuals-*`, all users) over the SEALED store, so `pins()` can open the retained
 * artifacts to find the refs inside them; `store` is the raw `PgContentStore` underneath it (the only one with the
 * sweep set). Every version of every line is kept (`keepLast: Infinity`): this collector reclaims blobs nothing
 * names, never history.
 */
export function lineageGcDeps(
  parts: { lineage: Pick<Lineage, "pins">; store: PgContentStore },
  loomPool: Pool,
): LineageGcDeps {
  return {
    pins: () => parts.lineage.pins({ keepLast: Number.POSITIVE_INFINITY }),
    store: parts.store,
    lock: () => pgSessionLock(loomPool, LINEAGE_GC_LOCK_KEY, "lineage gc lock"),
  };
}
