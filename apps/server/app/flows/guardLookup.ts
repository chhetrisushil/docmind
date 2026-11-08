import type { Pool, PoolClient } from "pg";
import { withTenant } from "../db/tenant";

/**
 * The scaffold the visualize guards share: run the existence query as the tenant, and turn any failure into an Error
 * with a fixed message (a driver error can carry ids or SQL; the message is logged). Each guard keeps its own query and
 * its own "gone" decision.
 */
export async function guardLookup<T>(
  pool: Pool,
  tenantId: string,
  query: (tx: PoolClient) => Promise<T>,
  failure: string,
): Promise<T> {
  try {
    return await withTenant(pool, tenantId, query);
  } catch {
    throw new Error(failure);
  }
}
