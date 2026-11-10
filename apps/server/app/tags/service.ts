import { randomUUID } from "node:crypto";
import {
  type DocumentTag,
  MAX_TAGS_PER_DOCUMENT,
  MAX_TAGS_PER_USER,
  MAX_TAG_SUGGESTIONS,
  cleanTagName,
  normaliseTagName,
} from "@docmind/contracts";
import type { Pool, PoolClient } from "pg";
import type { FieldCrypto } from "../crypto/fields";
import type { TagKeys } from "../crypto/tagKeys";
import { withTenant } from "../db/tenant";
import { type ExistingTag, parseSuggestedTags } from "./suggestions";

export const tagNameBind = (id: string) => `tag:${id}:name`;
export const suggestionsBind = (documentId: string) => `document:${documentId}:tag-suggestions`;

export interface TagOwner {
  tenantId: string;
  userId: string;
}
export interface TagWithCount extends DocumentTag {
  documents: number;
}
export interface DocumentTagsView {
  tags: DocumentTag[];
  suggestedTags: string[];
}

// Fixed messages: these reach logs and error answers, so they never carry a name.
export class TagNameInvalidError extends Error {
  constructor() {
    super("invalid tag name");
    this.name = "TagNameInvalidError";
  }
}
export class TagExistsError extends Error {
  constructor() {
    super("a tag with this name exists");
    this.name = "TagExistsError";
  }
}
export class UnknownTagError extends Error {
  constructor() {
    super("unknown tag");
    this.name = "UnknownTagError";
  }
}
export class TagLimitError extends Error {
  constructor(readonly limit: "document" | "user") {
    super("tag limit reached");
    this.name = "TagLimitError";
  }
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
const byName = (a: DocumentTag, b: DocumentTag) =>
  collator.compare(a.name, b.name) || (a.id < b.id ? -1 : 1);

interface Prepared {
  id: string;
  display: string;
  bind: Buffer;
  sealed: unknown;
}
interface NameRow {
  id: string;
  name_enc: unknown;
}

/** Serialises one owner's tag writes (the limit checks and the get-or-create). Held until the transaction ends. */
const lockOwner = (tx: PoolClient, o: TagOwner) =>
  tx.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))", [
    `docmind:tags:${o.userId}`,
  ]);

/** Owner-scoped `FOR KEY SHARE`: a concurrent delete of the document waits, then cascades our rows. False when it is not the owner's. */
async function lockDocument(tx: PoolClient, o: TagOwner, documentId: string): Promise<boolean> {
  const { rowCount } = await tx.query(
    "SELECT 1 FROM documents WHERE id = $1 AND owner_id = $2 AND tenant_id = $3 FOR KEY SHARE",
    [documentId, o.userId, o.tenantId],
  );
  return rowCount === 1;
}

/** The owner's tag with this lookup hash, or a new one (limit checked). Call under `lockOwner`. */
async function upsertTag(
  tx: PoolClient,
  o: TagOwner,
  p: Prepared,
): Promise<{ id: string; created: boolean }> {
  const found = await tx.query<{ id: string }>(
    "SELECT id FROM tags WHERE owner_id = $1 AND tenant_id = $2 AND name_bind = $3",
    [o.userId, o.tenantId, p.bind],
  );
  if (found.rows[0]) return { id: found.rows[0].id, created: false };
  const total = await tx.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM tags WHERE owner_id = $1 AND tenant_id = $2",
    [o.userId, o.tenantId],
  );
  if ((total.rows[0] as { n: number }).n >= MAX_TAGS_PER_USER) throw new TagLimitError("user");
  await tx.query(
    "INSERT INTO tags (id, tenant_id, owner_id, name_enc, name_bind) VALUES ($1, $2, $3, $4::jsonb, $5)",
    [p.id, o.tenantId, o.userId, JSON.stringify(p.sealed), p.bind],
  );
  return { id: p.id, created: true };
}

/**
 * Every read and write of tags, links and suggestions. Names are sealed under the owner's key and compared by a keyed hash;
 * all key-store calls (seal, open, hash) happen outside the transactions, never under a row lock. Every statement names the
 * owner and the tenant, in addition to row-level security. Nothing here logs or puts a name in an error.
 */
export class TagService {
  constructor(
    private readonly pool: Pool,
    private readonly fields: FieldCrypto,
    private readonly keys: TagKeys,
  ) {}

  private async prepare(o: TagOwner, raw: string, id: string = randomUUID()): Promise<Prepared> {
    const display = cleanTagName(raw);
    if (display === null) throw new TagNameInvalidError();
    const bind = await this.keys.forUser(o.userId).nameBind(display);
    if (bind === null) throw new TagNameInvalidError();
    return {
      id,
      display,
      bind,
      sealed: await this.fields.forUser(o.userId).seal(tagNameBind(id), display),
    };
  }

  // Deliberate: one undecryptable row fails the whole read (as a document title does), so corruption is loud, never a silent gap.
  private async open(o: TagOwner, rows: readonly NameRow[]): Promise<DocumentTag[]> {
    const cipher = this.fields.forUser(o.userId);
    const named = await Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        name: await cipher.openText(tagNameBind(r.id), r.name_enc),
      })),
    );
    return named.sort(byName);
  }

  async list(o: TagOwner): Promise<TagWithCount[]> {
    const rows = await withTenant(
      this.pool,
      o.tenantId,
      async (tx) =>
        (
          await tx.query<NameRow & { documents: number }>(
            `SELECT t.id, t.name_enc, count(dt.document_id)::int AS documents
               FROM tags t
               LEFT JOIN document_tags dt
                 ON dt.tag_id = t.id AND dt.owner_id = t.owner_id AND dt.tenant_id = t.tenant_id
              WHERE t.owner_id = $1 AND t.tenant_id = $2
              GROUP BY t.id`,
            [o.userId, o.tenantId],
          )
        ).rows,
    );
    const counts = new Map(rows.map((r) => [r.id, r.documents]));
    return (await this.open(o, rows)).map((t) => ({ ...t, documents: counts.get(t.id) ?? 0 }));
  }

  async create(o: TagOwner, raw: string): Promise<{ tag: DocumentTag; created: boolean }> {
    const p = await this.prepare(o, raw);
    const out = await withTenant(this.pool, o.tenantId, async (tx) => {
      await lockOwner(tx, o);
      const r = await upsertTag(tx, o, p);
      const row = await tx.query<NameRow>(
        "SELECT id, name_enc FROM tags WHERE id = $1 AND owner_id = $2 AND tenant_id = $3",
        [r.id, o.userId, o.tenantId],
      );
      return { created: r.created, row: row.rows[0] as NameRow };
    });
    const [tag] = await this.open(o, [out.row]);
    return { tag: tag as DocumentTag, created: out.created };
  }

  /** The renamed tag; null when it is not the owner's. Throws `TagExistsError` when the new name belongs to another of their tags. */
  async rename(o: TagOwner, id: string, raw: string): Promise<DocumentTag | null> {
    const p = await this.prepare(o, raw, id); // sealed under the tag's own id
    try {
      const hit = await withTenant(this.pool, o.tenantId, async (tx) => {
        await lockOwner(tx, o);
        const r = await tx.query(
          `UPDATE tags SET name_enc = $4::jsonb, name_bind = $5
            WHERE id = $1 AND owner_id = $2 AND tenant_id = $3`,
          [id, o.userId, o.tenantId, JSON.stringify(p.sealed), p.bind],
        );
        return r.rowCount === 1;
      });
      return hit ? { id, name: p.display } : null;
    } catch (err) {
      if ((err as { code?: unknown }).code === "23505") throw new TagExistsError();
      throw err;
    }
  }

  async remove(o: TagOwner, id: string): Promise<boolean> {
    return withTenant(this.pool, o.tenantId, async (tx) => {
      await lockOwner(tx, o); // serialised with the writers: a link in flight sees the tag gone (never a raw 23503)
      const r = await tx.query(
        "DELETE FROM tags WHERE id = $1 AND owner_id = $2 AND tenant_id = $3",
        [id, o.userId, o.tenantId],
      );
      return r.rowCount === 1;
    });
  }

  /** The tags of each listed document (a page of the library), one owner-scoped read. A document with none is absent. */
  async forDocuments(
    o: TagOwner,
    documentIds: readonly string[],
  ): Promise<Map<string, DocumentTag[]>> {
    const out = new Map<string, DocumentTag[]>();
    if (documentIds.length === 0) return out;
    const rows = await withTenant(
      this.pool,
      o.tenantId,
      async (tx) =>
        (
          await tx.query<NameRow & { document_id: string }>(
            `SELECT dt.document_id, t.id, t.name_enc
               FROM document_tags dt
               JOIN tags t ON t.id = dt.tag_id AND t.owner_id = dt.owner_id AND t.tenant_id = dt.tenant_id
              WHERE dt.owner_id = $1 AND dt.tenant_id = $2 AND dt.document_id = ANY($3::uuid[])`,
            [o.userId, o.tenantId, [...documentIds]],
          )
        ).rows,
    );
    const names = new Map((await this.open(o, rows)).map((t) => [t.id, t]));
    for (const r of rows) {
      const tag = names.get(r.id) as DocumentTag;
      out.set(r.document_id, [...(out.get(r.document_id) ?? []), tag]);
    }
    for (const [id, tags] of out) out.set(id, tags.sort(byName));
    return out;
  }

  private async readSuggestions(
    o: TagOwner,
    documentId: string,
  ): Promise<{ names: string[]; raw: unknown } | null> {
    const row = await withTenant(
      this.pool,
      o.tenantId,
      async (tx) =>
        (
          await tx.query<{ names_enc: unknown }>(
            `SELECT s.names_enc
               FROM documents d
               LEFT JOIN document_tag_suggestions s
                 ON s.document_id = d.id AND s.owner_id = d.owner_id AND s.tenant_id = d.tenant_id
              WHERE d.id = $1 AND d.owner_id = $2 AND d.tenant_id = $3`,
            [documentId, o.userId, o.tenantId],
          )
        ).rows[0],
    );
    if (!row) return null;
    if (row.names_enc == null) return { names: [], raw: null };
    const opened = await this.fields
      .forUser(o.userId)
      .open(suggestionsBind(documentId), row.names_enc);
    return { names: parseSuggestedTags(opened), raw: row.names_enc };
  }

  // Two reads, not one snapshot: a racing accept may briefly show a name as both tag and suggestion; the linked filter hides it.
  /** The document's tags and its open suggestions (those not already linked); null when it is not the owner's. */
  async detail(o: TagOwner, documentId: string): Promise<DocumentTagsView | null> {
    const stored = await this.readSuggestions(o, documentId);
    if (!stored) return null;
    const tags = (await this.forDocuments(o, [documentId])).get(documentId) ?? [];
    const linked = new Set(tags.map((t) => normaliseTagName(t.name)));
    return {
      tags,
      suggestedTags: stored.names.filter((n) => !linked.has(normaliseTagName(n))),
    };
  }

  async setForDocument(
    o: TagOwner,
    documentId: string,
    tagIds: readonly string[],
  ): Promise<DocumentTagsView | null> {
    const ids = [...new Set(tagIds.map((t) => t.toLowerCase()))];
    if (ids.length > MAX_TAGS_PER_DOCUMENT) throw new TagLimitError("document");
    const found = await this.guardFk(() =>
      withTenant(this.pool, o.tenantId, async (tx) => {
        await lockOwner(tx, o);
        if (!(await lockDocument(tx, o, documentId))) return false;
        const owned = await tx.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM tags WHERE owner_id = $1 AND tenant_id = $2 AND id = ANY($3::uuid[])",
          [o.userId, o.tenantId, ids],
        );
        if ((owned.rows[0] as { n: number }).n !== ids.length) throw new UnknownTagError();
        await tx.query(
          "DELETE FROM document_tags WHERE document_id = $1 AND owner_id = $2 AND tenant_id = $3",
          [documentId, o.userId, o.tenantId],
        );
        await tx.query(
          `INSERT INTO document_tags (document_id, tag_id, tenant_id, owner_id)
         SELECT $1, t, $2, $3 FROM unnest($4::uuid[]) AS t`,
          [documentId, o.tenantId, o.userId, ids],
        );
        return true;
      }),
    );
    return found ? this.detail(o, documentId) : null;
  }

  /** Links the tag named `raw`, creating it if the owner has none. False when the document is not the owner's. */
  private async link(o: TagOwner, documentId: string, raw: string): Promise<boolean> {
    const p = await this.prepare(o, raw);
    return this.guardFk(() =>
      withTenant(this.pool, o.tenantId, async (tx) => {
        await lockOwner(tx, o);
        if (!(await lockDocument(tx, o, documentId))) return false;
        const { id } = await upsertTag(tx, o, p);
        const has = await tx.query(
          "SELECT 1 FROM document_tags WHERE document_id = $1 AND tag_id = $2 AND owner_id = $3 AND tenant_id = $4",
          [documentId, id, o.userId, o.tenantId],
        );
        if (has.rowCount === 0) {
          const n = await tx.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM document_tags WHERE document_id = $1 AND owner_id = $2 AND tenant_id = $3",
            [documentId, o.userId, o.tenantId],
          );
          if ((n.rows[0] as { n: number }).n >= MAX_TAGS_PER_DOCUMENT)
            throw new TagLimitError("document");
          await tx.query(
            "INSERT INTO document_tags (document_id, tag_id, tenant_id, owner_id) VALUES ($1, $2, $3, $4)",
            [documentId, id, o.tenantId, o.userId],
          );
        }
        return true;
      }),
    );
  }

  /** A foreign-key failure means a tag (or the document) was deleted under us: answer it as a domain result, never a raw pg error. */
  private async guardFk(run: () => Promise<boolean>): Promise<boolean> {
    try {
      return await run();
    } catch (err) {
      const e = err as { code?: unknown; constraint?: unknown };
      if (e.code !== "23503") throw err;
      if (e.constraint === "document_tags_tag_fkey") throw new UnknownTagError();
      return false; // the document went away
    }
  }

  async addToDocument(
    o: TagOwner,
    documentId: string,
    raw: string,
  ): Promise<DocumentTagsView | null> {
    return (await this.link(o, documentId, raw)) ? this.detail(o, documentId) : null;
  }

  async removeFromDocument(
    o: TagOwner,
    documentId: string,
    tagId: string,
  ): Promise<DocumentTagsView | null> {
    const found = await withTenant(this.pool, o.tenantId, async (tx) => {
      if (!(await lockDocument(tx, o, documentId))) return false;
      await tx.query(
        "DELETE FROM document_tags WHERE document_id = $1 AND tag_id = $2 AND owner_id = $3 AND tenant_id = $4",
        [documentId, tagId, o.userId, o.tenantId],
      );
      return true;
    });
    return found ? this.detail(o, documentId) : null;
  }

  /**
   * The owner's tags for a suggestion prompt: most used first, then by name, at most 200, each marked when this document has
   * it. Null when the document is not the owner's.
   */
  async suggestionContext(ref: TagOwner & { documentId: string }): Promise<ExistingTag[] | null> {
    const rows = await withTenant(this.pool, ref.tenantId, async (tx) => {
      if (!(await lockDocumentRead(tx, ref))) return null;
      return (
        await tx.query<NameRow & { uses: number; linked: boolean | null }>(
          `SELECT t.id, t.name_enc, count(dt.document_id)::int AS uses, bool_or(dt.document_id = $3) AS linked
             FROM tags t
             LEFT JOIN document_tags dt
               ON dt.tag_id = t.id AND dt.owner_id = t.owner_id AND dt.tenant_id = t.tenant_id
            WHERE t.owner_id = $1 AND t.tenant_id = $2
            GROUP BY t.id`,
          [ref.userId, ref.tenantId, ref.documentId],
        )
      ).rows;
    });
    if (rows === null) return null;
    const meta = new Map(rows.map((r) => [r.id, r]));
    return (await this.open(ref, rows))
      .sort(
        (a, b) =>
          (meta.get(b.id)?.uses ?? 0) - (meta.get(a.id)?.uses ?? 0) ||
          collator.compare(a.name, b.name) ||
          (a.id < b.id ? -1 : 1),
      )
      .slice(0, MAX_TAGS_PER_USER)
      .map((t) => ({ id: t.id, name: t.name, linked: meta.get(t.id)?.linked === true }));
  }

  /** Replaces the document's suggestions (an empty list removes the row). False when the document is not the owner's. */
  async putSuggestions(
    ref: TagOwner & { documentId: string },
    names: readonly string[],
  ): Promise<boolean> {
    // The storage boundary keeps the spec's "up to 5 cleaned names" whatever the caller passes.
    const seen = new Set<string>();
    const kept: string[] = [];
    for (const raw of names) {
      const name = cleanTagName(raw);
      const key = name === null ? null : normaliseTagName(name);
      if (name === null || key === null || seen.has(key)) continue;
      seen.add(key);
      kept.push(name);
      if (kept.length === MAX_TAG_SUGGESTIONS) break;
    }
    const sealed =
      kept.length === 0
        ? null
        : await this.fields.forUser(ref.userId).seal(suggestionsBind(ref.documentId), kept);
    return withTenant(this.pool, ref.tenantId, async (tx) => {
      if (sealed === null) {
        const exists = await lockDocumentRead(tx, ref);
        await tx.query(
          "DELETE FROM document_tag_suggestions WHERE document_id = $1 AND owner_id = $2 AND tenant_id = $3",
          [ref.documentId, ref.userId, ref.tenantId],
        );
        return exists;
      }
      // Locked first, so a concurrent delete of the document waits and then cascades this row (no raw 23503). The SELECT
      // names owner and tenant, and the composite foreign key ties the row to that document, so the conflict target (the
      // document's own row) can only ever be the owner's.
      if (!(await lockDocument(tx, ref, ref.documentId))) return false;
      const r = await tx.query(
        `INSERT INTO document_tag_suggestions (document_id, tenant_id, owner_id, names_enc)
         SELECT d.id, d.tenant_id, d.owner_id, $4::jsonb
           FROM documents d WHERE d.id = $1 AND d.owner_id = $2 AND d.tenant_id = $3
         ON CONFLICT (document_id) DO UPDATE SET names_enc = EXCLUDED.names_enc, updated_at = now()`,
        [ref.documentId, ref.userId, ref.tenantId, JSON.stringify(sealed)],
      );
      return r.rowCount === 1;
    });
  }

  /** Removes one name from the suggestions with a compare-and-set on the stored envelope (it carries a fresh nonce per seal, so it is a true version; no key call under a lock). Throws after 5 lost races rather than answer success with the name still suggested. */
  private async removeSuggestion(o: TagOwner, documentId: string, raw: string): Promise<void> {
    const norm = normaliseTagName(raw);
    if (norm === null) return;
    for (let attempt = 0; attempt < 5; attempt++) {
      const cur = await this.readSuggestions(o, documentId);
      if (!cur || cur.raw === null) return;
      const kept = cur.names.filter((n) => normaliseTagName(n) !== norm);
      if (kept.length === cur.names.length) return;
      const sealed =
        kept.length === 0
          ? null
          : await this.fields.forUser(o.userId).seal(suggestionsBind(documentId), kept);
      const done = await withTenant(this.pool, o.tenantId, async (tx) => {
        const r =
          sealed === null
            ? await tx.query(
                `DELETE FROM document_tag_suggestions
                  WHERE document_id = $1 AND owner_id = $2 AND tenant_id = $3 AND names_enc = $4::jsonb`,
                [documentId, o.userId, o.tenantId, JSON.stringify(cur.raw)],
              )
            : await tx.query(
                `UPDATE document_tag_suggestions SET names_enc = $5::jsonb, updated_at = now()
                  WHERE document_id = $1 AND owner_id = $2 AND tenant_id = $3 AND names_enc = $4::jsonb`,
                [documentId, o.userId, o.tenantId, JSON.stringify(cur.raw), JSON.stringify(sealed)],
              );
        return r.rowCount === 1;
      });
      if (done) return;
    }
    throw new Error("tag suggestion update contended");
  }

  async accept(o: TagOwner, documentId: string, raw: string): Promise<DocumentTagsView | null> {
    if (!(await this.link(o, documentId, raw))) return null;
    await this.removeSuggestion(o, documentId, raw);
    return this.detail(o, documentId);
  }

  async dismiss(o: TagOwner, documentId: string, raw: string): Promise<DocumentTagsView | null> {
    const exists = await this.readSuggestions(o, documentId);
    if (!exists) return null;
    await this.removeSuggestion(o, documentId, raw);
    return this.detail(o, documentId);
  }
}

async function lockDocumentRead(
  tx: PoolClient,
  o: TagOwner & { documentId: string },
): Promise<boolean> {
  const { rowCount } = await tx.query(
    "SELECT 1 FROM documents WHERE id = $1 AND owner_id = $2 AND tenant_id = $3",
    [o.documentId, o.userId, o.tenantId],
  );
  return rowCount === 1;
}
