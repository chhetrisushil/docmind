import type { Pool } from "pg";

/** The release function of a held session lock. `lost` aborts when the lock's connection failed: the lock is gone. */
export type SessionLock = (() => Promise<void>) & { lost?: AbortSignal };

/**
 * A session advisory lock (`pg_try_advisory_lock(hashtextextended(key, 0))`) on a connection of its own, held
 * until released. A dead connection drops the lock by itself, and `lost` says so. Null when another session holds
 * it. `label` names the lock in the log lines, which carry an error's class only.
 */
export async function pgSessionLock(
  pool: Pool,
  key: string,
  label: string,
): Promise<SessionLock | null> {
  const client = await pool.connect();
  // A held connection that drops loses the lock: tell the holder (`lost`) instead of crashing the process.
  const gone = new AbortController();
  const onError = (err: unknown) => {
    console.error(
      `${label} connection failed`,
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
  const release: SessionLock = async () => {
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
}
