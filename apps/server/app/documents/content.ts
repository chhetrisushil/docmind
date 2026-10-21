import type { Identity } from "@docmind/auth";
import { type DocumentContentResponse, Locator } from "@docmind/contracts";
import type { Pool } from "pg";
import { z } from "zod";
import type { FieldCrypto } from "../crypto/fields";
import { withTenant } from "../db/tenant";
import { chunkBind } from "../flows/ingest-document/pgChunks";
import { getDocument } from "./repo";

/** Passages per page of `GET /api/documents/:id/content`. */
export const CONTENT_PAGE = 20;
const SEALED = z.object({ text: z.string(), headingPath: z.array(z.string()) });

export const encodeContentCursor = (ordinal: number): string =>
  Buffer.from(`o:${ordinal}`).toString("base64url");

/** The ordinal a cursor names, or null: opaque to clients, validated like any input (no sign, no leading zero, nine digits at most). */
export function decodeContentCursor(cursor: string): number | null {
  const match = /^o:(0|[1-9][0-9]{0,8})$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  return match ? Number(match[1]) : null;
}

interface Row {
  id: string;
  ordinal: number;
  locator: unknown;
  text_enc: unknown;
}

/**
 * The passages of one of the caller's documents after ordinal `after`, in reading order, with text opened (content: never
 * logged). `null` when the document does not exist, is not the caller's, or its owner is being erased. Owner-scoped inside `withTenant`.
 */
export async function readContent(
  pool: Pool,
  fields: FieldCrypto,
  identity: Identity,
  documentId: string,
  after: number,
): Promise<DocumentContentResponse | null> {
  const rows = await withTenant(pool, identity.tenantId, async (tx) => {
    const alive = await tx.query("SELECT 1 FROM users WHERE id = $1 AND erasing_at IS NULL", [
      identity.userId,
    ]);
    if (alive.rowCount === 0) return null;
    if (!(await getDocument(tx, identity.userId, documentId))) return null;
    const res = await tx.query<Row>(
      `SELECT c.id, c.ordinal, c.locator, c.text_enc
         FROM chunks c JOIN documents d ON d.id = c.document_id AND d.tenant_id = c.tenant_id
        WHERE d.id = $1 AND d.owner_id = $2 AND c.ordinal > $3
        ORDER BY c.ordinal LIMIT $4`,
      [documentId, identity.userId, after, CONTENT_PAGE + 1],
    );
    return res.rows;
  });
  if (rows === null) return null;
  const page = rows.slice(0, CONTENT_PAGE);
  const cipher = fields.forUser(identity.userId);
  const items = await Promise.all(
    page.map(async (r) => {
      const sealed = SEALED.safeParse(await cipher.open(chunkBind(r.id), r.text_enc));
      const locator = Locator.safeParse(r.locator);
      // A fixed message: a schema error could carry decrypted content.
      if (!sealed.success || !locator.success)
        throw new Error("the stored chunk has an invalid shape");
      return {
        passageId: r.id,
        ordinal: r.ordinal,
        locator: locator.data,
        headingPath: sealed.data.headingPath,
        text: sealed.data.text,
      };
    }),
  );
  const last = page[page.length - 1];
  return {
    items,
    nextCursor: rows.length > CONTENT_PAGE && last ? encodeContentCursor(last.ordinal) : null,
  };
}
