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
  try {
    await tx.query("BEGIN");
    await tx.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(tx);
    await tx.query("COMMIT");
    return result;
  } catch (err) {
    await tx.query("ROLLBACK");
    throw err;
  } finally {
    tx.release();
  }
}
