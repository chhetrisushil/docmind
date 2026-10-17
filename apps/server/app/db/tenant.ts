import type { Pool, PoolClient } from "pg";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` in one transaction whose row-level-security context is `tenantId`. The setting is
 * transaction-local, so a pooled connection never carries a tenant into its next use. The caller
 * must take `tenantId` from the Authenticator, never from the request.
 */
export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  if (!UUID.test(tenantId)) throw new Error("withTenant: tenantId must be a uuid");
  const tx = await pool.connect();
  let broken: Error | undefined;
  const note = (e: Error) => {
    broken = e;
  };
  // A connection lost mid-transaction emits "error"; without a listener that crashes the process.
  tx.on("error", note);
  try {
    await tx.query("BEGIN");
    await tx.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(tx);
    // An aborted transaction (fn swallowed a database error) answers COMMIT with ROLLBACK.
    const end = await tx.query("COMMIT");
    if (end.command === "ROLLBACK") throw new Error("withTenant: transaction was aborted");
    return result;
  } catch (err) {
    // Never let a failed ROLLBACK (dead connection) mask the original error.
    await tx.query("ROLLBACK").catch(note);
    throw err;
  } finally {
    // Drop any session-level value fn set; release(err) destroys a connection that cannot be trusted.
    if (!broken) await tx.query("SELECT set_config('app.tenant_id', '', false)").catch(note);
    tx.off("error", note);
    tx.release(broken);
  }
}
