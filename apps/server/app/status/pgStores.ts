import { type PgConfig, PostgresReadModelStore } from "@loom/plugin-postgres";
import type { ReadModelStore } from "@loom/plugin-read-model";
import type { Pool } from "pg";
import { withTenant } from "../db/tenant";

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
