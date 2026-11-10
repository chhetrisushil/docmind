import { clipText } from "../../http/clip";

/** The longest label (a heading or an entity name) a structure fact keeps. */
export const MAX_STRUCTURE_LABEL = 80;

/** A heading or a name as a label: trimmed and clipped to 80 UTF-16 units (an astral character counts 2); "" when nothing is left. */
export const clipLabel = (raw: string): string =>
  clipText(raw.trim(), MAX_STRUCTURE_LABEL).trimEnd();

/** The most raw items of one answer (merged over windows) a normaliser reads: a runaway answer costs a bounded scan. */
export const MAX_RAW_ITEMS = 200;

/** A plain object (not null, not a list): the shape every untrusted model item is checked for first. */
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Untrusted model text as a short label: control characters and line breaks become one space, invisible format characters
 * (zero-width, BOM, word joiner) are dropped, runs of space collapse, then it is trimmed and clipped to `max` UTF-16 units
 * (never inside a surrogate pair). "" when nothing visible is left.
 */
export const cleanText = (raw: string, max: number): string =>
  clipText(
    raw
      .replace(/[\p{Cc}\u2028\u2029]|\p{Surrogate}/gu, " ")
      .replace(/\p{Cf}|[\u115f\u1160\u3164\uffa0\u2800]/gu, "")
      .replace(/\s+/g, " ")
      .trim(),
    max,
  ).trimEnd();

/** What two spellings of one name share: NFKC, lower case, one inner space. The dedupe key of events, links and parties. */
export const nameKey = (raw: string): string =>
  raw.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * The passage of this document an item cites that comes first in the document, or null when none of its `ids` is one of the
 * document's passages. `position` maps each passage id (lower case) to its index in passage order, so its keys are exactly
 * "the passages of this document". Ids are matched case-insensitively; anything that is not a string is ignored.
 */
export function earliestPassage(
  ids: unknown,
  position: ReadonlyMap<string, number>,
): string | null {
  if (!Array.isArray(ids)) return null;
  let best: string | null = null;
  for (const raw of ids) {
    if (typeof raw !== "string") continue;
    const id = raw.toLowerCase();
    const at = position.get(id);
    if (at === undefined) continue;
    if (best === null || at < (position.get(best) as number)) best = id;
  }
  return best;
}
