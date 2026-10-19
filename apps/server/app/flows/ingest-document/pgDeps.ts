import type { Pool } from "pg";
import type { FieldCrypto } from "../../crypto/fields";
import type { IngestDeps } from "./deps";
import type { IngestWiring } from "./limits";
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
}

export const pgIngestDeps = ({ pool, fields, blobs, wiring }: PgIngestArgs): IngestDeps => ({
  guard: new PgStepGuard(pool),
  source: new PgDocumentSource(pool, blobs),
  parsed: new PgParsedStore(pool, fields),
  registry: wiring.registry,
  runner: wiring.runner,
  shutdown: wiring.shutdown.signal,
  ...(wiring.sleep && { sleep: wiring.sleep }),
});
