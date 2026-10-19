import type { ChunkVectorStore } from "@docmind/vector-pg";
import type { KeyStore } from "@loom/plugin-crypto";
import type { Pool } from "pg";
import type { FieldCrypto } from "../../crypto/fields";
import type { IngestDeps } from "./deps";
import { IngestConfigError } from "./errors";
import { type IngestWiring, parseStepTimeoutMs } from "./limits";
import { PgChunkStore } from "./pgChunks";
import { PgStepGuard } from "./pgGuard";
import { PgParsedStore } from "./pgParsed";
import { PgDocumentResults } from "./pgResults";
import { PgDocumentSource } from "./pgSource";
import { VisionReader } from "./vision";

export interface PgIngestArgs {
  pool: Pool;
  fields: FieldCrypto;
  /** The per-user data keys; entity names are keyed (HMAC) under a key derived from them. */
  keys: KeyStore;
  /** The per-identity blob store the document routes use. */
  blobs: (identity: { tenantId: string; userId: string }) => {
    get(ref: { __loomContent: string }): Promise<Uint8Array | null>;
  };
  wiring: IngestWiring;
  /** Must agree with `wiring.embedder` (model and dimensions), or composition refuses. */
  vectors: ChunkVectorStore;
}

export function pgIngestDeps({ pool, fields, blobs, wiring, vectors }: PgIngestArgs): IngestDeps {
  // A deployment fault: refuse to compose rather than embed vectors the store cannot compare.
  if (
    vectors.modelId !== wiring.embedder.modelId ||
    vectors.dimensions !== wiring.embedder.dimensions
  ) {
    throw new IngestConfigError();
  }
  return {
    guard: new PgStepGuard(pool),
    source: new PgDocumentSource(pool, blobs),
    parsed: new PgParsedStore(pool, fields),
    chunks: new PgChunkStore(pool, fields),
    results: new PgDocumentResults(pool, fields),
    registry: wiring.registry,
    vectors,
    embedder: wiring.embedder,
    runner: wiring.runner,
    maxChars: wiring.runnerLimits.maxChars,
    shutdown: wiring.shutdown.signal,
    gate: wiring.gate,
    parseStepTimeoutMs: parseStepTimeoutMs(wiring.runnerLimits, wiring.llm.config.timeoutMs),
    ...(wiring.llm.vision && { vision: new VisionReader(wiring.llm.vision) }),
    ...(wiring.sleep && { sleep: wiring.sleep }),
  };
}
