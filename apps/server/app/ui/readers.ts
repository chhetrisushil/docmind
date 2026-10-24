import type { Identity } from "@docmind/auth";
import type { DocumentDto, DocumentPassage } from "@docmind/contracts";
import { CHAT_LIST_CAP, CONTENT_CAP, type UiReaders, citedWindow } from "@docmind/experiences";
import type { Pool } from "pg";
import { listChatsPage } from "../chats/routes";
import type { FieldCrypto } from "../crypto/fields";
import { withTenant } from "../db/tenant";
import { decodeContentCursor, readContent } from "../documents/content";
import { getDocument, listDocuments, toDto } from "../documents/repo";
import { type SourceDeps, readSource } from "../documents/source";
import type { DocumentStatusReads } from "../status/ingestStatus";
import { STATUS_MESSAGES, UPLOADED } from "../status/model";

export interface UiReaderDeps {
  pool: Pool;
  fields: FieldCrypto;
  status: DocumentStatusReads;
  blobs: SourceDeps["blobs"];
  registry: SourceDeps["registry"];
}

const PAGE = 100;
/** What a document's `error` says when it is not one of the status model's own sentences. */
export const FIXED_ERROR = "Processing this document failed.";
const SENTENCES = new Set<string>(Object.values(STATUS_MESSAGES));
/** `DocumentDto.error` comes from the status model's fixed table; this keeps it so even if a stored code ever mapped to anything else. */
export const fixedError = (error: string | null): string | null =>
  error === null ? null : SENTENCES.has(error) ? error : FIXED_ERROR;
const shown = (dto: DocumentDto): DocumentDto => ({ ...dto, error: fixedError(dto.error) });
const PROCESSING = new Set<DocumentDto["status"]>(["uploaded", "parsing", "embedding"]);
const matches =
  (status: "all" | "ready" | "processing" | "failed") =>
  (state: DocumentDto["status"]): boolean =>
    status === "all" || (status === "processing" ? PROCESSING.has(state) : state === status);

/**
 * The readers the UI plane serves from, bound to ONE caller. The tenant and the owner come from `identity` (the session)
 * and are applied by `withTenant` and by the owner column of every query; no argument names either. Each reader uses the
 * same functions as the REST route of the same data, so what a user can see here is exactly what the API lets them see.
 */
export function readersFor(deps: UiReaderDeps, identity: Identity): UiReaders {
  const cipher = () => deps.fields.forUser(identity.userId);
  return {
    async documents({ limit, status }) {
      const keep = matches(status);
      const items: DocumentDto[] = [];
      let after: { t: string; i: string } | null = null;
      let truncated = false;
      for (;;) {
        const cursor: { t: string; i: string } | null = after;
        const page: Awaited<ReturnType<typeof listDocuments>> = await withTenant(
          deps.pool,
          identity.tenantId,
          (tx) => listDocuments(tx, identity.userId, { cursor, limit: PAGE }),
        );
        const views = await deps.status.forPage(
          identity,
          page.rows.map((r) => ({ id: r.id, generation: r.ingest_generation })),
        );
        for (const row of page.rows) {
          // The status decides before anything is opened: only the documents returned are decrypted.
          const view = views.get(row.id) ?? UPLOADED;
          if (!keep(view.status)) continue;
          if (items.length === limit) {
            truncated = true; // one more match than asked for
            break;
          }
          items.push(shown(await toDto(row, cipher(), view)));
        }
        if (truncated || !page.next) break;
        after = { t: page.next.created_cursor, i: page.next.id };
      }
      return { items, truncated };
    },

    async document({ id }) {
      const row = await withTenant(deps.pool, identity.tenantId, (tx) =>
        getDocument(tx, identity.userId, id),
      );
      if (!row) return null;
      return shown(
        await toDto(
          row,
          cipher(),
          await deps.status.forDocument(identity, row.id, row.ingest_generation),
        ),
      );
    },

    /**
     * Reads pages from `readContent`, which proves the document is this caller's (owner-scoped, tenant-scoped, not erasing)
     * on every page. A cited passage is kept when it is found among the passages read, which belong to this document and
     * this user by construction: a passage id of another document or user is never in these pages, so it is simply absent.
     * A cited passage past the first `upto` items is kept (everything up to it is returned), up to CONTENT_CAP passages;
     * past that cap it is not found and the first `upto` are returned.
     */
    async content({ id, upto, passage }) {
      const out: DocumentPassage[] = [];
      let after = -1;
      let more = false;
      for (;;) {
        const page = await readContent(deps.pool, deps.fields, identity, id, after);
        if (page === null) return null;
        out.push(...page.items);
        const next = page.nextCursor === null ? null : decodeContentCursor(page.nextCursor);
        more = next !== null;
        if (next === null) break;
        after = next;
        if (
          (out.length >= upto &&
            (passage === undefined || out.some((p) => p.passageId === passage))) ||
          out.length >= CONTENT_CAP
        )
          break;
      }
      const keep = citedWindow(out, upto, passage);
      return { items: out.slice(0, keep), more: more || out.length > keep };
    },

    source: ({ id, passage }) =>
      readSource(deps, identity, id, passage === "" ? undefined : passage),

    async chats({ q }) {
      const page = await listChatsPage(deps, identity, null, q === "" ? undefined : q);
      return page.items.slice(0, CHAT_LIST_CAP);
    },
  };
}
