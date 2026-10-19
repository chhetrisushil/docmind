import { type ParsedDocument, ParsedDocument as ParsedDocumentSchema } from "@docmind/parsers";
import type { Pool } from "pg";
import type { FieldCrypto } from "../../crypto/fields";
import { withTenant } from "../../db/tenant";
import { DocumentGoneError } from "./errors";
import type { IngestStartInput } from "./flow";

export const parsedBind = (documentId: string) => `document:${documentId}:parsed`;

export interface ParsedStore {
  put(ref: IngestStartInput, parsed: ParsedDocument): Promise<void>;
  take(ref: IngestStartInput): Promise<ParsedDocument | undefined>;
  drop(ref: IngestStartInput): Promise<void>;
}

const OWNED = "EXISTS (SELECT 1 FROM documents d WHERE d.id = $1 AND d.owner_id = $2)";

/** Sealed parsed documents. Every query runs in withTenant and is scoped to the document's owner. */
export class PgParsedStore implements ParsedStore {
  constructor(
    private readonly pool: Pool,
    private readonly fields: FieldCrypto,
  ) {}

  async put(ref: IngestStartInput, parsed: ParsedDocument): Promise<void> {
    const sealed = await this.fields.forUser(ref.userId).seal(parsedBind(ref.documentId), parsed);
    await withTenant(this.pool, ref.tenantId, async (tx) => {
      // INSERT ... SELECT: a document that is not this owner's inserts nothing. The FK covers a delete race.
      const { rowCount } = await tx.query(
        `INSERT INTO parsed_documents (tenant_id, document_id, body_enc)
         SELECT d.tenant_id, d.id, $3::jsonb FROM documents d WHERE d.id = $1 AND d.owner_id = $2
         ON CONFLICT (tenant_id, document_id) DO UPDATE SET body_enc = EXCLUDED.body_enc`,
        [ref.documentId, ref.userId, JSON.stringify(sealed)],
      );
      if (!rowCount) throw new DocumentGoneError();
    });
  }

  async take(ref: IngestStartInput): Promise<ParsedDocument | undefined> {
    const body = await withTenant(this.pool, ref.tenantId, async (tx) => {
      const { rows } = await tx.query<{ owned: boolean; body_enc: unknown }>(
        `SELECT ${OWNED} AS owned, (SELECT body_enc FROM parsed_documents WHERE document_id = $1) AS body_enc`,
        [ref.documentId, ref.userId],
      );
      if (!rows[0]?.owned) throw new DocumentGoneError();
      return rows[0].body_enc;
    });
    if (body == null) return undefined;
    const opened = await this.fields.forUser(ref.userId).open(parsedBind(ref.documentId), body);
    // safeParse and a fixed message: a ZodError can carry decrypted content in its issues.
    const result = ParsedDocumentSchema.safeParse(opened);
    if (!result.success) throw new Error("the stored parsed document has an invalid shape");
    return result.data;
  }

  async drop(ref: IngestStartInput): Promise<void> {
    await withTenant(this.pool, ref.tenantId, async (tx) => {
      const { rows } = await tx.query<{ owned: boolean }>(
        `WITH gone AS (DELETE FROM parsed_documents p USING documents d
           WHERE p.document_id = d.id AND p.tenant_id = d.tenant_id AND d.id = $1 AND d.owner_id = $2 RETURNING 1)
         SELECT ${OWNED} AS owned`,
        [ref.documentId, ref.userId],
      );
      if (!rows[0]?.owned) throw new DocumentGoneError();
    });
  }
}
