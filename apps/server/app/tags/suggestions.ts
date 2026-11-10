import {
  MAX_NEW_TAG_SUGGESTIONS,
  MAX_TAGS_PER_USER,
  MAX_TAG_NAME_CHARS,
  MAX_TAG_SUGGESTIONS,
  cleanTagName,
  normaliseTagName,
} from "@docmind/contracts";

/** One of the owner's tags, as the suggestion code sees it. `linked`: it is already on the document in question. */
export interface ExistingTag {
  id: string;
  name: string;
  linked: boolean;
}

const LOOK_AT = 20;

/** The model's `suggestedTags` read leniently: the strings of an array (first 20), else `[]`. Never throws. */
export function parseSuggestedTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string").slice(0, LOOK_AT);
}

const clip = (name: string): string => [...name.trim()].slice(0, MAX_TAG_NAME_CHARS).join("");

/**
 * The names to offer for a document (spec section 4): each clipped to 40 characters, empty and control-character names dropped,
 * mapped onto an existing tag whose normalised form is equal (keeping that tag's display name), deduped, at most 5 with at most
 * 3 that are not existing tags, and never a tag already linked to the document. `raw` is the model's field, parsed leniently.
 */
export function normaliseSuggestions(raw: unknown, existingTags: readonly ExistingTag[]): string[] {
  const known = new Map<string, ExistingTag>();
  for (const t of existingTags) {
    const n = normaliseTagName(t.name);
    if (n !== null) known.set(n, t);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  let fresh = 0;
  for (const candidate of parseSuggestedTags(raw)) {
    const display = cleanTagName(clip(candidate));
    if (display === null) continue;
    const norm = normaliseTagName(display);
    if (norm === null || seen.has(norm)) continue;
    seen.add(norm);
    const match = known.get(norm);
    if (match?.linked) continue;
    if (!match && fresh >= MAX_NEW_TAG_SUGGESTIONS) continue;
    if (!match) fresh++;
    out.push(match ? match.name : display);
    if (out.length === MAX_TAG_SUGGESTIONS) break;
  }
  return out;
}

/**
 * The one prompt line that asks for `suggestedTags`. The existing tags are the user's own words, so they go in as a JSON array
 * (quoted and escaped, at most 200): a tag name can never read as an instruction.
 */
export function tagInstruction(existing: readonly string[]): string {
  const known = existing.slice(0, MAX_TAGS_PER_USER);
  return known.length === 0
    ? 'For "suggestedTags", give up to 3 short topic tags (1 to 3 words each) this document could be filed under.'
    : `For "suggestedTags", give up to 5 short tags for this document. The reader already uses these tags (a JSON list): ${JSON.stringify(known)}. Reuse an existing tag exactly as written wherever one fits, and add at most 3 tags that are not in that list.`;
}
