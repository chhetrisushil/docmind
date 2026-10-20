import type { Identity } from "@docmind/auth";
import type { Citation } from "@docmind/contracts";
import { tainted } from "@loom/classify";
import { checkCitations } from "@loom/knowledge";
import type { Pool } from "pg";
import type { FieldCrypto } from "../crypto/fields";
import { withTenant } from "../db/tenant";
import { titleBind } from "../documents/repo";
import type { StoredPassage } from "./turnItems";

export const SNIPPET_MAX = 280;
export const DELETED_DOCUMENT = "(deleted document)";

/** `[[<passage id>]]`, with the space before it, so removing one does not leave "claim ." behind. */
const MARKER = / ?\[\[([0-9a-f-]{36})\]\]/g;

/** At most `max` UTF-16 units, never ending on half a surrogate pair. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * D6. `retrieved` is every `passages` item of the turn; `titles` maps a document id to its current title (a
 * document missing from it was deleted). The result is deterministic, so history and the stream compute it on read.
 */
export function citeReply(
  text: string,
  retrieved: readonly StoredPassage[],
  titles: ReadonlyMap<string, string>,
): { text: string; citations: Citation[] } {
  const claimed = [...text.matchAll(MARKER)].map((m) => m[1] as string);
  if (claimed.length === 0) return { text, citations: [] };
  const byId = new Map<string, StoredPassage>();
  for (const p of retrieved) if (!byId.has(p.passageId)) byId.set(p.passageId, p);
  // `checkCitations` compares ids exactly against `docId`; the passage id is the id the model was shown.
  const check = checkCitations(
    claimed,
    [...byId.keys()].map((docId, index) => ({ docId, index, text: tainted("", "document") })),
  );
  const grounded = new Set(check.grounded);
  const cleaned = text.replace(MARKER, (marker, id: string) => (grounded.has(id) ? marker : ""));
  const seen = new Set<string>();
  const citations: Citation[] = [];
  for (const id of claimed) {
    const p = byId.get(id);
    if (!p || seen.has(id)) continue;
    seen.add(id);
    citations.push({
      passageId: id,
      documentId: p.documentId,
      docTitle: titles.get(p.documentId) ?? DELETED_DOCUMENT,
      locator: p.locator,
      snippet: clip(p.snippet, SNIPPET_MAX),
    });
  }
  return { text: cleaned, citations };
}

/**
 * The current titles of the caller's documents among `documentIds`. A document that is gone, another user's or in
 * another tenant is simply absent, so a stored passage cannot be used to read a title it has no right to.
 */
export async function documentTitles(
  pool: Pool,
  fields: FieldCrypto,
  identity: Identity,
  documentIds: readonly string[],
): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const ids = [...new Set(documentIds.map((id) => id.toLowerCase()))];
  if (ids.length === 0) return titles;
  const rows = await withTenant(
    pool,
    identity.tenantId,
    async (tx) =>
      (
        await tx.query<{ id: string; title_enc: unknown }>(
          "SELECT id, title_enc FROM documents WHERE owner_id = $1 AND id = ANY($2::uuid[])",
          [identity.userId, ids],
        )
      ).rows,
  );
  const cipher = fields.forUser(identity.userId);
  for (const row of rows)
    titles.set(row.id, await cipher.openText(titleBind(row.id), row.title_enc));
  return titles;
}
