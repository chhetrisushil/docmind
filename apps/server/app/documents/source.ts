import type { Identity } from "@docmind/auth";
import type { EncryptedFsContentStore } from "@docmind/blob-store";
import { type DocumentSourceResponse, Locator } from "@docmind/contracts";
import { type ParserRegistry, decodeText } from "@docmind/parsers";
import type { Pool } from "pg";
import { withTenant } from "../db/tenant";

/** The most source text served: ingest's analysis window, and within the client parsers' bound. */
export const SOURCE_MAX_CHARS = 1_000_000;
const FORMATS = { md: "md", org: "org", txt: "txt" } as const;

export type SourceResult = { applicable: false } | ({ applicable: true } & DocumentSourceResponse);
export interface SourceDeps {
  pool: Pool;
  blobs: (identity: Identity) => EncryptedFsContentStore;
  registry: ParserRegistry;
}

/**
 * A document's stored original, decoded exactly as ingest decoded it (so passage `chars` locators are offsets into
 * it), for the formats the page renders (md, org, txt). `null`: not found, not the caller's, or the caller is being
 * erased. `{ applicable: false }`: any other format, or bytes that no longer decode. `focus`: the locator of
 * `passageId` when it is a chunk of THIS document with a `chars` locator. Content is never logged.
 */
export async function readSource(
  deps: SourceDeps,
  identity: Identity,
  documentId: string,
  passageId?: string,
): Promise<SourceResult | null> {
  const row = await withTenant(deps.pool, identity.tenantId, async (tx) => {
    const alive = await tx.query("SELECT 1 FROM users WHERE id = $1 AND erasing_at IS NULL", [
      identity.userId,
    ]);
    if (alive.rowCount === 0) return null;
    const doc = await tx.query<{ mime: string; content_address: string }>(
      "SELECT mime, content_address FROM documents WHERE id = $1 AND owner_id = $2",
      [documentId, identity.userId],
    );
    const d = doc.rows[0];
    if (!d) return null;
    let locator: unknown;
    if (passageId) {
      const c = await tx.query<{ locator: unknown }>(
        "SELECT locator FROM chunks WHERE id = $1 AND document_id = $2",
        [passageId, documentId],
      );
      locator = c.rows[0]?.locator;
    }
    return { mime: d.mime, address: d.content_address, locator };
  });
  if (row === null) return null;
  // Ingest selects with the mime only, so this does too.
  const id = deps.registry.select(row.mime)?.id;
  const format = id === "md" || id === "org" || id === "txt" ? FORMATS[id] : undefined;
  if (!format) return { applicable: false };
  const bytes = await deps.blobs(identity).get({ __loomContent: row.address });
  if (bytes === null) throw new Error("the document's stored content is missing");
  let full: string;
  try {
    full = decodeText(bytes);
  } catch {
    return { applicable: false };
  }
  let text = full;
  let truncated = false;
  if (full.length > SOURCE_MAX_CHARS) {
    const cut = full.lastIndexOf("\n", SOURCE_MAX_CHARS);
    text = full.slice(0, cut > 0 ? cut : SOURCE_MAX_CHARS);
    truncated = true;
  }
  const loc = Locator.safeParse(row.locator);
  const focus =
    loc.success && loc.data.kind === "chars" && loc.data.start < text.length
      ? { from: loc.data.start, to: Math.min(loc.data.end, text.length) }
      : undefined;
  return { applicable: true, format, text, truncated, ...(focus && { focus }) };
}
