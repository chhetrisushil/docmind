import { AuthService, type Identity, PasswordAuthenticator } from "@docmind/auth";
import { EncryptedFsContentStore } from "@docmind/blob-store";
import { type ChunkVectorStore, PgChunkVectorStore } from "@docmind/vector-pg";
import type { PrincipalCryptoOptions, StorageConfig } from "@loom/app";
import type { EventStore } from "@loom/event-runtime";
import type { KeyStore } from "@loom/plugin-crypto";
import type { ReadModelStore } from "@loom/plugin-read-model";
import type { Pool } from "pg";
import { PgAuthStore } from "./auth/pgAuthStore";
import { PgThrottle } from "./auth/pgThrottle";
import { authRoutes } from "./auth/routes";
import { buildApp } from "./config";
import { FieldCrypto } from "./crypto/fields";
import { withTenant } from "./db/tenant";
import { type IngestPort, loomIngest } from "./documents/ingest";
import type { DocumentLimits } from "./documents/limits";
import { documentRoutes } from "./documents/routes";
import { StartScheduler } from "./documents/startScheduler";
import type { IngestWiring } from "./flows/ingest-document/limits";
import { pgIngestDeps } from "./flows/ingest-document/pgDeps";
import { createHttpServer } from "./server";
import { IngestStatus } from "./status/ingestStatus";
import { flowSteps, statusSensitive } from "./status/wire";

/** The stores behind the ingest-status model: in production the Loom-pool writer and the tenant-bound reader. */
export interface StatusStores {
  writer: ReadModelStore;
  readerFor(identity: Identity): ReadModelStore;
  /** The decrypting event store the model reads (live and catch-up source); its sealing covers feed the sensitive map. */
  source: EventStore;
}

export interface ComposeOptions {
  /** The docmind_app pool: auth, documents and the ingest step read through it. */
  pool: Pool;
  keys: KeyStore;
  storage: StorageConfig;
  crypto?: PrincipalCryptoOptions;
  limits: DocumentLimits;
  blobRoot: string;
  secureCookies: boolean;
  trustProxy: boolean;
  /** Parser registry, runner and progress bus; the runner and registry reach the parse ports through pgIngestDeps. */
  ingest: IngestWiring;
  /** The ingest-status model's stores. */
  status: StatusStores;
  /** Test seam: the vector store. Defaults to the Pg store over `withTenant` on the app pool (never the Loom pool). */
  vectors?: ChunkVectorStore & { verify?(tenantId: string): Promise<void> };
  /** Test seam: observe or wrap the ingest port the routes use. */
  wrapIngest?: (port: IngestPort) => IngestPort;
}

/**
 * Everything `main` runs, minus configuration and process concerns: the Loom app with the ingest
 * step's database access, the auth and document routes, and the HTTP server (not yet listening).
 * The acceptance test builds the server through this same function.
 */
export function buildServer(options: ComposeOptions) {
  const { pool, keys, limits } = options;
  const feed: { onEvent?: IngestStatus["onEvent"] } = {}; // the model is built after defineConfig, which the sensitive map needs; onEvent reaches it through this holder
  const fields = new FieldCrypto(keys);
  // The per-identity blob store, built the same way for the routes and the ingest source.
  const blobs = ({ tenantId, userId }: Identity) =>
    new EncryptedFsContentStore({
      root: options.blobRoot,
      tenantId,
      userId,
      keys,
      maxBytes: limits.maxFileBytes,
    });
  const { embedder } = options.ingest;
  const vectors =
    options.vectors ??
    new PgChunkVectorStore({
      tenant: (tenantId, fn) => withTenant(pool, tenantId, fn),
      modelId: embedder.modelId,
      dimensions: embedder.dimensions,
    });
  const app = buildApp(options.storage, options.crypto, {
    ingest: pgIngestDeps({ pool, fields, blobs, wiring: options.ingest, vectors }),
    onEvent: (event) => feed.onEvent?.(event),
  });
  const status = new IngestStatus({
    writer: options.status.writer,
    readerFor: options.status.readerFor,
    source: options.status.source,
    sensitive: statusSensitive(flowSteps(), options.status.source),
    bus: options.ingest.bus,
  });
  feed.onEvent = status.onEvent;
  const ingest = options.wrapIngest
    ? options.wrapIngest(loomIngest(app.runtime))
    : loomIngest(app.runtime);
  const starts = new StartScheduler(ingest);
  const store = new PgAuthStore(pool);
  const throttle = new PgThrottle(pool);
  const authenticator = new PasswordAuthenticator(store);
  const server = createHttpServer({
    ...authRoutes({
      service: new AuthService(store),
      authenticator,
      store,
      throttle,
      secureCookies: options.secureCookies,
      trustProxy: options.trustProxy,
    }),
    ...documentRoutes({
      pool,
      authenticator,
      fields,
      blobs,
      limits,
      ingest,
      starts,
      status,
    }),
  });
  return {
    app,
    server,
    store,
    throttle,
    starts,
    ingestWiring: options.ingest,
    vectors,
    bus: options.ingest.bus,
    status,
    /** Stops feeding the model; shutdown calls it before `status.close()` so a late event is not folded onto closing pools. */
    detachStatusFeed: () => {
      feed.onEvent = undefined;
    },
  };
}
