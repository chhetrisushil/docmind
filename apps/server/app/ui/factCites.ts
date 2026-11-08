import { Locator, Uuid, locatorText } from "@docmind/contracts";
import type { Pool } from "pg";
import type { FieldCrypto } from "../crypto/fields";
import { withTenant } from "../db/tenant";
import { titleBind } from "../documents/repo";

export interface CiteDeps {
  pool: Pool;
  fields: FieldCrypto;
}

export interface ResolvedCite {
  documentId: string;
  label: string;
}

const MAX_LABEL = 200; // loom-ui's MAX_WIDGET_REF_LABEL
/**
 * The most distinct chunk ids one call resolves. Unreachable by a well-formed caller: a fact cites at most 8 chunk ids
 * (`ChunkIds` in `flows/visualize-document/facts.ts`) and a document keeps at most MAX_FACTS (16) facts, so one document's
 * facts name at most 16 x 8 = 128 distinct ids, a quarter of this cap. It only bounds the `ANY($2)` array against a
 * caller that passes more.
 */
const MAX_IDS = 512;
const UNTITLED = "Untitled document";

/** Cuts to at most `max` UTF-16 units, never ending in half a surrogate pair. */
const clip = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
};

/** "<title>, <place>" (the place in the Sources panel's words), at most 200 characters, the title giving way. */
export const citeLabel = (title: string, locator: Locator): string => {
  const place = locatorText(locator);
  const head = title.trim() === "" ? UNTITLED : title.trim();
  return `${clip(head, MAX_LABEL - place.length - 2)}, ${place}`;
};

interface Row {
  id: string;
  document_id: string;
  locator: unknown;
  title_enc: unknown;
}

/**
 * The owner's chunks among `chunkIds`, by chunk id (a chunk id is the passage id the page opens): the document each belongs
 * to and a label of its title and place. Owner-scoped through the document join inside `withTenant`; an unknown, foreign or
 * malformed id, and a chunk of a deleted document (its chunks cascade), is absent. Reads no passage text.
 */
export async function resolveCites(
  deps: CiteDeps,
  who: { tenantId: string; userId: string },
  chunkIds: readonly string[],
): Promise<Map<string, ResolvedCite>> {
  const ids = [
    ...new Set(chunkIds.filter((i) => Uuid.safeParse(i).success).map((i) => i.toLowerCase())),
  ].slice(0, MAX_IDS);
  if (ids.length === 0) return new Map();
  const rows = await withTenant(deps.pool, who.tenantId, async (tx) => {
    const res = await tx.query<Row>(
      `SELECT c.id, c.document_id, c.locator, d.title_enc
         FROM chunks c JOIN documents d ON d.id = c.document_id AND d.tenant_id = c.tenant_id
        WHERE d.owner_id = $1 AND c.id = ANY($2::uuid[])`,
      [who.userId, ids],
    );
    return res.rows;
  });
  const cipher = deps.fields.forUser(who.userId);
  const titles = new Map(
    await Promise.all(
      [...new Map(rows.map((r) => [r.document_id, r.title_enc]))].map(
        async ([id, enc]) => [id, await cipher.openText(titleBind(id), enc)] as const,
      ),
    ),
  );
  const out = new Map<string, ResolvedCite>();
  for (const r of rows) {
    const locator = Locator.safeParse(r.locator);
    if (!locator.success) continue; // a chunk we cannot place is not cited
    out.set(r.id, {
      documentId: r.document_id,
      label: citeLabel(titles.get(r.document_id) as string, locator.data),
    });
  }
  return out;
}
