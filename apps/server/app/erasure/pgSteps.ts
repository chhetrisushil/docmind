import { eraseUserBlobs } from "@docmind/blob-store";
import type { Pool } from "pg";
import { CHAT_ACTIVITY_MODEL } from "../chats/sessions";
import { pgSessionLock } from "../db/sessionLock";
import { withTenant } from "../db/tenant";
import { handleListerPrefixes, prefixExtensions, userPrefixes } from "../opaqueIds";
import { PgHandleStore } from "../opaqueIds/pgHandles";
import { INGEST_STATUS_MODEL } from "../status/model";
import type { ErasureDeps } from "./eraser";
import type { ErasureRequest } from "./types";

export interface PgErasureOptions {
  /** The docmind_app pool: every statement on it runs under the request's tenant. */
  app: Pool;
  /**
   * A small pool of its own for the advisory locks (`ERASURE_CONCURRENCY + 1` connections, a connect timeout), so a
   * lock held through a backoff can never starve the app pool.
   */
  locks: Pool;
  /** The docmind_loom pool (owns the `loom` schema). */
  loom: Pool;
  blobRoot: string;
}

/**
 * A session advisory lock per user (`erasure:<user>`) on a connection of its own, held until released.
 * A dead connection drops the lock by itself. Null when another session holds it.
 */
export function pgErasureLock(pool: Pool): ErasureDeps["lock"] {
  // An idle lock connection dropped by the server must not crash the process. Class only.
  pool.on("error", (err) =>
    console.error(
      "idle erasure lock connection failed",
      err instanceof Error ? err.constructor.name : typeof err,
    ),
  );
  return (userId) => pgSessionLock(pool, `erasure:${userId}`, "erasure lock");
}

export function pgErasureSql(
  o: PgErasureOptions,
): Pick<ErasureDeps, "lock" | "work" | "rows" | "blobs" | "handleOf"> {
  const { app, loom } = o;
  /** The user's `users.id_handle`, read under the tenant while the row exists; null when there is none (or no row). */
  const handles = new PgHandleStore(app);
  const handleOf = (req: ErasureRequest): Promise<string | null> =>
    handles.read({ tenantId: req.tenantId, userId: req.userId });
  return {
    lock: pgErasureLock(o.locks),
    handleOf,

    async work(req) {
      return withTenant(app, req.tenantId, async (tx) => {
        const docs = await tx.query(
          "SELECT id, ingest_generation FROM documents WHERE owner_id = $1",
          [req.userId],
        );
        const chats = await tx.query("SELECT id FROM chat_sessions WHERE user_id = $1", [
          req.userId,
        ]);
        return {
          documents: docs.rows.map((r) => ({
            id: r.id as string,
            generation: Number(r.ingest_generation),
          })),
          chatIds: chats.rows.map((r) => r.id as string),
        };
      });
    },

    async rows(req: ErasureRequest) {
      // The throttle counters are not touched here: they are keyed by a hash of the email, which the request
      // transaction already replaced, so the route clears them (Task 170a).
      // 1. Loom retires the timers of terminal executions but has no prefix API: remove what is left, under both prefixes
      //    (`u_<uuid>` for runs before the deploy, `h_<handle>` after). This runs BEFORE the user row goes, because the handle that
      //    names the second prefix is on that row; a retry after the row is gone has no handle, and nothing left to find.
      const handle = await handleOf(req);
      // Each prefix by equality and its `:` and `.c-` forms, so an id that merely extends a prefix is never matched. One statement per
      // prefix, in the indexable `= OR starts_with OR starts_with` shape (no array of prefixes: that cannot use the index).
      for (const prefix of userPrefixes(req.userId, handle)) {
        for (const table of ["timers", "leases"] as const)
          await loom.query(
            `DELETE FROM loom.${table} WHERE execution_id = $1 OR starts_with(execution_id, $2) OR starts_with(execution_id, $3)`,
            [prefix, ...prefixExtensions(prefix)],
          );
      }
      // 1b. The read-model tombstones under `h_<handle>` (left by the `readModels` step: `state` NULL, `erased`) still carry `scope` (the user
      //     UUID) and `app_key` (the document or chat UUID) beside the handle: that row would link them for good. Scrub both while the handle
      //     can still be read (it goes with the user row below). The loom role has UPDATE on the table and a FOR ALL policy (migration 0012);
      //     only erased rows are touched, and a NULL scope is what the fold writes for a neutral row. Idempotent: a retry re-runs it.
      if (handle !== null) {
        const mine = handleListerPrefixes(handle);
        await loom.query(
          `UPDATE public.read_model_state SET scope = NULL, app_key = NULL
            WHERE model_id = ANY($1::text[]) AND erased
              AND (execution_id = $2 OR starts_with(execution_id, $3) OR starts_with(execution_id, $4))`,
          [[INGEST_STATUS_MODEL, CHAT_ACTIVITY_MODEL], mine.exact, ...mine.starts],
        );
      }
      // 2. The user row: the foreign keys cascade to sessions, documents (chunks, parsed text, links, entities, visual facts),
      //    tags (with their links and suggestions) and chats (turn items, reasoning texts). The handle goes with it.
      await withTenant(app, req.tenantId, (tx) =>
        tx.query("DELETE FROM users WHERE id = $1 AND tenant_id = $2", [req.userId, req.tenantId]),
      );
      // 3. The personal tenant goes with its last user (D6). A tenant with other users stays.
      await app.query("SELECT public.docmind_delete_empty_tenant($1)", [req.tenantId]);
    },

    blobs: (req) => eraseUserBlobs(o.blobRoot, req.tenantId, req.userId),
  };
}
