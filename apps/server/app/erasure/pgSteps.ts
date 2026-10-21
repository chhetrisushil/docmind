import { eraseUserBlobs } from "@docmind/blob-store";
import type { Pool } from "pg";
import { withTenant } from "../db/tenant";
import type { ErasureDeps, ErasureLock } from "./eraser";
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
  return async (userId) => {
    const key = `erasure:${userId}`;
    const client = await pool.connect();
    // A held connection that drops loses the lock: tell the eraser (`lost`) instead of crashing the process.
    const gone = new AbortController();
    const onError = (err: unknown) => {
      console.error(
        "erasure lock connection failed",
        err instanceof Error ? err.constructor.name : typeof err,
      );
      gone.abort();
    };
    client.on("error", onError);
    const done = (destroy?: Error) => {
      client.removeListener("error", onError);
      client.release(
        destroy ?? (gone.signal.aborted ? new Error("lock connection lost") : undefined),
      );
    };
    try {
      const { rows } = await client.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS held",
        [key],
      );
      if (!rows[0].held) {
        done();
        return null;
      }
    } catch (err) {
      done(err instanceof Error ? err : new Error("lock failed"));
      throw err;
    }
    const release: ErasureLock = async () => {
      try {
        if (gone.signal.aborted) return done(); // the lock went with the connection
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key]);
        done();
      } catch (err) {
        done(err instanceof Error ? err : new Error("unlock failed")); // destroys the connection, and the lock with it
      }
    };
    release.lost = gone.signal;
    return release;
  };
}

export function pgErasureSql(
  o: PgErasureOptions,
): Pick<ErasureDeps, "lock" | "work" | "rows" | "blobs"> {
  const { app, loom } = o;
  return {
    lock: pgErasureLock(o.locks),

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
      // 1. The user row: the foreign keys cascade to sessions, documents (chunks, parsed text, links, entities)
      //    and chats (turn items, reasoning texts).
      await withTenant(app, req.tenantId, (tx) =>
        tx.query("DELETE FROM users WHERE id = $1 AND tenant_id = $2", [req.userId, req.tenantId]),
      );
      // 2. Loom retires the timers of terminal executions but has no prefix API: remove what is left.
      //    An execution id of the user always starts with `u_<uuid>` (subject.ts).
      const prefix = `u_${req.userId}`;
      await loom.query("DELETE FROM loom.timers WHERE starts_with(execution_id, $1)", [prefix]);
      await loom.query("DELETE FROM loom.leases WHERE starts_with(execution_id, $1)", [prefix]);
      // 3. The personal tenant goes with its last user (D6). A tenant with other users stays.
      await app.query("SELECT public.docmind_delete_empty_tenant($1)", [req.tenantId]);
    },

    blobs: (req) => eraseUserBlobs(o.blobRoot, req.tenantId, req.userId),
  };
}
