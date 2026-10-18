import type { Pool } from "pg";
import { withTenant } from "../../db/tenant";
import type { IngestDeps } from "./deps";

/**
 * The stub step's database access: a tenant-scoped, owner-scoped existence check; ids in, boolean
 * out. A failure is rethrown with a fixed message, because a step failure's message lands in the
 * event log and the driver's error can carry ids or SQL parameters.
 */
export function pgIngestDeps(pool: Pool): IngestDeps {
  return {
    documentExists: async ({ tenantId, userId, documentId }) => {
      try {
        return await withTenant(pool, tenantId, async (tx) => {
          const { rowCount } = await tx.query(
            "SELECT 1 FROM documents WHERE id = $1 AND owner_id = $2",
            [documentId, userId],
          );
          return (rowCount ?? 0) > 0;
        });
      } catch {
        throw new Error("document existence check failed");
      }
    },
  };
}
