import type { ChunkVectorStore } from "@docmind/vector-pg";
import type { KeyStore } from "@loom/plugin-crypto";
import type { Pool } from "pg";
import { EntityKeys } from "../../crypto/entityKeys";
import type { FieldCrypto } from "../../crypto/fields";
import { type ProviderName, pdfMaxBytes } from "../../llm/roles";
import type { IngestDeps } from "./deps";
import { IngestConfigError } from "./errors";
import { type IngestWiring, parseStepTimeoutMs } from "./limits";
import { PgChunkStore } from "./pgChunks";
import { PgEntityStore } from "./pgEntities";
import { PgStepGuard } from "./pgGuard";
import { PgLinkStore } from "./pgLinks";
import { PgParsedStore } from "./pgParsed";
import { PgDocumentResults } from "./pgResults";
import { PgDocumentSource } from "./pgSource";
import { PgTitleSource } from "./pgTitles";
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

export function pgIngestDeps({
  pool,
  fields,
  keys,
  blobs,
  wiring,
  vectors,
}: PgIngestArgs): IngestDeps {
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
    entities: new PgEntityStore(pool, fields, new EntityKeys(keys)),
    links: new PgLinkStore(pool),
    titles: new PgTitleSource(pool, fields),
    summaryMaxChars: wiring.summaryMaxChars,
    ...(wiring.llm.summary && { llm: wiring.llm.summary }),
    registry: wiring.registry,
    vectors,
    embedder: wiring.embedder,
    runner: wiring.runner,
    maxChars: wiring.runnerLimits.maxChars,
    shutdown: wiring.shutdown.signal,
    gate: wiring.gate,
    parseStepTimeoutMs: parseStepTimeoutMs(wiring.runnerLimits, wiring.llm.config.visionTimeoutMs),
    ...((wiring.llm.vision || wiring.llm.visionPdf) && {
      vision: new VisionReader({
        ...(wiring.llm.vision && { image: wiring.llm.vision }),
        ...(wiring.llm.visionPdf && { pdf: wiring.llm.visionPdf }),
        ...(wiring.llm.visionPdf && {
          // visionPdf is set only when its provider is not "off", so the cast holds.
          pdfMaxBytes: pdfMaxBytes(wiring.llm.roles.roles.visionPdf.provider as ProviderName),
        }),
      }),
    }),
    ...(wiring.sleep && { sleep: wiring.sleep }),
  };
}
