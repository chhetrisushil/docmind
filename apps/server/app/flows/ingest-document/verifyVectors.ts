import { VectorSchemaError, VectorVersionError } from "@docmind/vector-pg";
import { runAll } from "../../shutdown";
import { StartupConfigError } from "../../startupError";

/** Owns no rows. `verify` reads only the catalog (`pg_attribute`, `pg_extension`), so this id opens a transaction and touches no tenant data. */
export const NIL_TENANT = "00000000-0000-4000-8000-000000000000";

/** The only text a dimension mismatch surfaces: names variables, never values. */
export const VECTOR_MISMATCH =
  "chunks.embedding does not match DOCMIND_EMBED_DIMENSIONS (the vector column size)";

/** Chat search needs pgvector's iterative index scans (`hnsw.iterative_scan`), added in 0.8.0. */
export const PGVECTOR_TOO_OLD = "pgvector 0.8.0 or newer is required for chat search";

/**
 * Boot check: the database's `chunks.embedding` column must fit the embedder. A mismatch becomes a
 * StartupConfigError (safe to print); any other failure keeps its class only. Either way every
 * cleanup step runs first, so the process can exit.
 */
export async function verifyVectors(
  vectors: { verify?(tenantId: string): Promise<void> },
  cleanup: readonly (() => Promise<unknown>)[],
): Promise<void> {
  try {
    await vectors.verify?.(NIL_TENANT);
  } catch (err) {
    await runAll(...cleanup).catch(() => undefined);
    if (err instanceof VectorSchemaError) {
      throw new StartupConfigError(VECTOR_MISMATCH);
    }
    if (err instanceof VectorVersionError) {
      throw new StartupConfigError(PGVECTOR_TOO_OLD);
    }
    throw err;
  }
}
