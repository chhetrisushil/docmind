import { z } from "zod";
import { Uuid } from "./common";

export const MAX_TAG_NAME_CHARS = 40;
export const MAX_TAGS_PER_DOCUMENT = 20;
export const MAX_TAGS_PER_USER = 200;
export const MAX_TAGS_PER_FILTER = 10;
export const MAX_TAG_SUGGESTIONS = 5;
export const MAX_NEW_TAG_SUGGESTIONS = 3;

// Refused anywhere in a name: control characters, lone surrogates (they would share a bind with U+FFFD), zero-width,
// bidi-control and line/paragraph-separator characters (invisible or reordering, so two names could look alike).
// Checked on the raw string, before trim() can strip an edge one.
const FORBIDDEN =
  /\p{Cc}|\p{Cs}|[\u200B-\u200D]|\u2060|\uFEFF|[\u202A-\u202E]|[\u2066-\u2069]|\u2028|\u2029/u;

/** The display name as typed, trimmed; null when it is empty, over 40 characters (code points) or holds a forbidden character. */
export function cleanTagName(raw: string): string | null {
  if (FORBIDDEN.test(raw)) return null;
  const name = raw.trim();
  const length = [...name].length;
  if (length < 1 || length > MAX_TAG_NAME_CHARS) return null;
  return name;
}

/**
 * What the keyed lookup hash is taken over: NFKC, trimmed, inner whitespace collapsed to one space, case-folded
 * (upper then lower case, then ß to "ss": "ẞ" lower-cases to "ß" but "ß" upper-cases to "SS", so the explicit map is what
 * makes "ẞ", "ß" and "ss" meet and the result idempotent). Null when `raw` is not a valid tag name. Never the display name.
 */
export function normaliseTagName(raw: string): string | null {
  const name = cleanTagName(raw);
  if (name === null) return null;
  const folded = name
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toUpperCase()
    .toLowerCase()
    .replace(/ß/gu, "ss");
  return folded === "" ? null : folded;
}

/** A tag name in a request body: cleaned, or an issue that never quotes the value. */
export const TagName = z
  .string()
  .max(400)
  .transform((raw, ctx) => {
    const name = cleanTagName(raw);
    if (name === null) {
      ctx.addIssue({ code: "custom", message: "invalid tag name" });
      return z.NEVER;
    }
    return name;
  });

export const DocumentTag = z.object({ id: Uuid, name: z.string() }).strict();
export type DocumentTag = z.infer<typeof DocumentTag>;

/** One row of `GET /api/tags`: `documents` is how many of the user's documents carry it. */
export const TagSummary = z
  .object({ id: Uuid, name: z.string(), documents: z.number().int().nonnegative() })
  .strict();
export type TagSummary = z.infer<typeof TagSummary>;

export const ListTagsResponse = z.object({ tags: z.array(TagSummary) });
export type ListTagsResponse = z.infer<typeof ListTagsResponse>;

/** `POST /api/tags`, `PATCH /api/tags/:id`, `POST /api/documents/:id/tags` and the accept and dismiss routes. */
export const TagNameRequest = z.object({ name: TagName }).strict();
export type TagNameRequest = z.infer<typeof TagNameRequest>;

export const TagResponse = z.object({ tag: DocumentTag });
export type TagResponse = z.infer<typeof TagResponse>;

export const SetDocumentTagsRequest = z
  .object({
    tagIds: z.array(Uuid.transform((s) => s.toLowerCase())).max(MAX_TAGS_PER_DOCUMENT),
  })
  .strict();
export type SetDocumentTagsRequest = z.infer<typeof SetDocumentTagsRequest>;

/** What every document-tag route answers: the document's tags and its open suggestions. */
export const DocumentTagsResponse = z.object({
  tags: z.array(DocumentTag),
  suggestedTags: z.array(z.string()),
});
export type DocumentTagsResponse = z.infer<typeof DocumentTagsResponse>;

/** `POST /api/documents/:id/tag-suggestions/refresh`: the `suggest-tags` run was started. */
export const SuggestTagsResponse = z.object({ started: z.literal(true) });
export type SuggestTagsResponse = z.infer<typeof SuggestTagsResponse>;

export const TagMatch = z.enum(["any", "all"]);
export type TagMatch = z.infer<typeof TagMatch>;

/** The `tags` query value: comma-separated ids; empty is none; duplicates collapse; at most 10; anything else is refused. */
export const TagIdList = z
  .string()
  .max(MAX_TAGS_PER_FILTER * 37)
  .transform((s, ctx) => {
    if (s === "") return [] as string[];
    const ids = [...new Set(s.split(",").map((x) => x.trim().toLowerCase()))];
    if (ids.length > MAX_TAGS_PER_FILTER || ids.some((x) => !Uuid.safeParse(x).success)) {
      ctx.addIssue({ code: "custom", message: "invalid tag list" });
      return z.NEVER;
    }
    return ids;
  });
