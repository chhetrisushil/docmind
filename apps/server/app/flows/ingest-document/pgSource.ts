import type { Pool } from "pg";
import { withTenant } from "../../db/tenant";
import { DocumentGoneError } from "./errors";
import type { IngestStartInput } from "./flow";

export interface DocumentSource {
  meta(ref: IngestStartInput): Promise<{ mime: string; contentAddress: string }>;
  read(ref: IngestStartInput, contentAddress: string): Promise<Uint8Array>;
}

type Blobs = (identity: { tenantId: string; userId: string }) => {
  get(ref: { __loomContent: string }): Promise<Uint8Array | null>;
};

/**
 * Reads a document's type and bytes. Both calls run in withTenant and are scoped to the document's
 * owner; a missing, foreign or other-tenant document is DocumentGoneError. `read` also requires the
 * address to be the one stored on the document row: the per-user blob store would otherwise serve
 * any blob of the same user, so the check is what ties the bytes to this document.
 */
export class PgDocumentSource implements DocumentSource {
  constructor(
    private readonly pool: Pool,
    private readonly blobs: Blobs,
  ) {}

  private async row(ref: IngestStartInput) {
    const row = await withTenant(this.pool, ref.tenantId, async (tx) => {
      const { rows } = await tx.query<{ mime: string; content_address: string }>(
        "SELECT mime, content_address FROM documents WHERE id = $1 AND owner_id = $2",
        [ref.documentId, ref.userId],
      );
      return rows[0];
    });
    if (!row) throw new DocumentGoneError();
    return { mime: row.mime, contentAddress: row.content_address };
  }

  meta(ref: IngestStartInput) {
    return this.row(ref);
  }

  async read(ref: IngestStartInput, contentAddress: string): Promise<Uint8Array> {
    // The gap between this row check and the blob read is accepted: a vanished blob is null, so gone, and the step's later writes hit the FK.
    if ((await this.row(ref)).contentAddress !== contentAddress) throw new DocumentGoneError();
    const store = this.blobs({ tenantId: ref.tenantId, userId: ref.userId });
    const bytes = await store.get({ __loomContent: contentAddress });
    if (bytes === null) throw new DocumentGoneError(); // delete removed the blob first, or erasure did
    return bytes;
  }
}
