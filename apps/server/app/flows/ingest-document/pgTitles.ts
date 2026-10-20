import type { Pool } from "pg";
import type { FieldCrypto } from "../../crypto/fields";
import { withTenant } from "../../db/tenant";
import { titleBind } from "../../documents/repo";
import { DocumentGoneError } from "./errors";
import type { IngestStartInput } from "./flow";

export const TITLE_CAP = 2000;

export interface TitleSource {
  /** The owner's other documents: decrypted titles (content: never logged) and ordinal-0 chunk ids. */
  others(
    ref: IngestStartInput,
  ): Promise<{ documentId: string; title: string; firstChunkId: string | null }[]>;
}

export class PgTitleSource implements TitleSource {
  constructor(
    private readonly pool: Pool,
    private readonly fields: FieldCrypto,
  ) {}

  async others(ref: IngestStartInput) {
    const rows = await withTenant(this.pool, ref.tenantId, async (tx) => {
      const own = await tx.query("SELECT 1 FROM documents WHERE id = $1 AND owner_id = $2", [
        ref.documentId,
        ref.userId,
      ]);
      if (!own.rowCount) throw new DocumentGoneError();
      const { rows } = await tx.query<{
        id: string;
        title_enc: unknown;
        first_chunk: string | null;
      }>(
        `SELECT d.id, d.title_enc,
                (SELECT c.id FROM chunks c WHERE c.document_id = d.id AND c.ordinal = 0) AS first_chunk
           FROM documents d
          WHERE d.owner_id = $2 AND d.id <> $1
          ORDER BY d.created_at DESC
          LIMIT ${TITLE_CAP}`,
        [ref.documentId, ref.userId],
      );
      return rows;
    });
    const cipher = this.fields.forUser(ref.userId);
    const out: { documentId: string; title: string; firstChunkId: string | null }[] = [];
    for (const r of rows) {
      try {
        const title = await cipher.openText(titleBind(r.id), r.title_enc);
        out.push({ documentId: r.id, title, firstChunkId: r.first_chunk });
      } catch {
        // a document deleted mid-read, or an unreadable title: skipped, never logged
      }
    }
    return out;
  }
}
