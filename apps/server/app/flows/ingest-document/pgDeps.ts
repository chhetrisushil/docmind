import type { ChunkVectorStore } from "@docmind/vector-pg";
import type { Pool } from "pg";
import type { FieldCrypto } from "../../crypto/fields";
import type { IngestDeps } from "./deps";
import { IngestConfigError } from "./errors";
import type { IngestWiring } from "./limits";
import { PgChunkStore } from "./pgChunks";
import { PgStepGuard } from "./pgGuard";
import { PgParsedStore } from "./pgParsed";
import { PgDocumentSource } from "./pgSource";

export interface PgIngestArgs {
  pool: Pool;
  fields: FieldCrypto;
  /** The per-identity blob store the document routes use. */
  blobs: (identity: { tenantId: string; userId: string }) => {
    get(ref: { __loomContent: string }): Promise<Uint8Array | null>;
  };
  wiring: IngestWiring;
  /** Checked against `wiring.embedder` when given (Task 91b makes it required and returns it in the deps). */
  vectors?: ChunkVectorStore;
}

export function pgIngestDeps({ pool, fields, blobs, wiring, vectors }: PgIngestArgs): IngestDeps {
  // A deployment fault: refuse to compose rather than embed vectors the store cannot compare.
  if (
    vectors &&
    (vectors.modelId !== wiring.embedder.modelId ||
      vectors.dimensions !== wiring.embedder.dimensions)
  ) {
    throw new IngestConfigError();
  }
  return {
    guard: new PgStepGuard(pool),
    source: new PgDocumentSource(pool, blobs),
    parsed: new PgParsedStore(pool, fields),
    chunks: new PgChunkStore(pool, fields),
    registry: wiring.registry,
    runner: wiring.runner,
    shutdown: wiring.shutdown.signal,
    ...(wiring.sleep && { sleep: wiring.sleep }),
  };
}
