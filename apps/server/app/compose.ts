import { AuthService, PasswordAuthenticator } from "@docmind/auth";
import { EncryptedFsContentStore } from "@docmind/blob-store";
import type { PrincipalCryptoOptions, StorageConfig } from "@loom/app";
import type { KeyStore } from "@loom/plugin-crypto";
import type { Pool } from "pg";
import { PgAuthStore } from "./auth/pgAuthStore";
import { PgThrottle } from "./auth/pgThrottle";
import { authRoutes } from "./auth/routes";
import { buildApp } from "./config";
import { FieldCrypto } from "./crypto/fields";
import { type IngestPort, loomIngest } from "./documents/ingest";
import type { DocumentLimits } from "./documents/limits";
import { documentRoutes } from "./documents/routes";
import { pgIngestDeps } from "./flows/ingest-document/pgDeps";
import { createHttpServer } from "./server";

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
  const app = buildApp(options.storage, options.crypto, { ingest: pgIngestDeps(pool) });
  const ingest = options.wrapIngest
    ? options.wrapIngest(loomIngest(app.runtime))
    : loomIngest(app.runtime);
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
      fields: new FieldCrypto(keys),
      blobs: ({ tenantId, userId }) =>
        new EncryptedFsContentStore({
          root: options.blobRoot,
          tenantId,
          userId,
          keys,
          maxBytes: limits.maxFileBytes,
        }),
      limits,
      ingest,
    }),
  });
  return { app, server, store, throttle };
}
