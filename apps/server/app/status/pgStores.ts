import { type PgConfig, PostgresReadModelStore } from "@loom/plugin-postgres";
import type { ReadModelStore } from "@loom/plugin-read-model";
import type { Pool } from "pg";
import { withTenant } from "../db/tenant";
import type { UserExecutionLister } from "./forgetUser";

// The tables are DocMind's own (migration 0012): no DDL runs here, and the schema is explicit
// because the Loom pool's search_path is `loom`.
const PLACEMENT = { schema: "public", manageSchema: false } as const;

/**
 * The one place DocMind's `pg` Pool meets Loom's `PgConfig` (two pg copies, so the types differ
 * though the runtime surface is the same). Every hand-off goes through here.
 */
interface TenantPool {
  query(text: string, values?: unknown[]): Promise<unknown>;
  connect(): Promise<never>;
  end(): Promise<void>;
}
const asLoomPool = (pool: Pool | TenantPool): PgConfig => pool as unknown as PgConfig;

/** The service's store: the Loom role writes every tenant's rows under the `ingest_all` policy. */
export const pgStatusWriter = (loomPool: Pool): ReadModelStore =>
  new PostgresReadModelStore(asLoomPool(loomPool), PLACEMENT);

/**
 * A store for one caller's reads. Every query runs inside `withTenant`, so the `tenant_read`
 * policy limits rows to the tenant's users. It owns nothing and never runs DDL. Writes are refused
 * by the database (the app role holds SELECT only); `connect`, used by Loom's transactional
 * writes, is refused here as well.
 */
export function pgStatusReaderFor(
  appPool: Pool,
): (identity: { tenantId: string }) => ReadModelStore {
  return ({ tenantId }) => {
    const tenantPool: TenantPool = {
      query: (text: string, values?: unknown[]) =>
        withTenant(appPool, tenantId, (tx) => tx.query(text, values)),
      connect: async () => {
        throw new Error("the status reader is read-only");
      },
      end: async () => {},
    };
    return new PostgresReadModelStore(asLoomPool(tenantPool), PLACEMENT);
  };
}

const LIST_BATCH = 500;

/**
 * The Loom role's narrow read for user erasure: the execution ids (never the state) of one user's rows in a model
 * that are not tombstoned yet, by id prefix. The prefix is matched with `starts_with` and exact equality, never
 * `LIKE`, because `_` is a wildcard and a user id is bound text. The Loom pool's search_path is `loom`, so the
 * table is schema-qualified. `docmind_loom` may read every tenant's rows (policy `ingest_all`, migration 0012).
 */
export const pgUserExecutions =
  (loomPool: Pick<Pool, "query">): UserExecutionLister =>
  async (modelId, userId) => {
    const { rows } = await loomPool.query<{ execution_id: string }>(
      `SELECT execution_id FROM public.read_model_state
        WHERE model_id = $1 AND NOT erased
          AND (execution_id = $2 OR starts_with(execution_id, $3) OR starts_with(execution_id, $4))
        ORDER BY execution_id
        LIMIT ${LIST_BATCH}`,
      [modelId, `u_${userId}`, `u_${userId}:`, `u_${userId}.c-`],
    );
    return rows.map((r) => r.execution_id);
  };
