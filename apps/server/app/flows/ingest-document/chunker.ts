import { createHash } from "node:crypto";
import type { Locator } from "@docmind/contracts";
import type { ParsedDocument } from "@docmind/parsers";

export interface Chunk {
  ordinal: number;
  sectionOrdinal: number;
  /** Heading text is content: it is sealed with the chunk text, never put in `locator`. */
  headingPath: string[];
  text: string;
  tokenCount: number;
  locator: Locator;
}
export interface ChunkOptions {
  targetTokens?: number;
  /** Fraction of the target repeated at the start of the next chunk of the same section (Task 72). */
  overlap?: number;
}

const CHARS_PER_TOKEN = 4;
export const DEFAULT_TARGET_TOKENS = 600;
export const DEFAULT_OVERLAP = 0.15;

export const estimateTokens = (text: string): number =>
  Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));

interface Span {
  start: number;
  end: number;
}

/** Non-empty paragraph spans (blank-line separated) of `text`, each at most `max` long. */
function units(text: string, max: number): Span[] {
  const out: Span[] = [];
  for (const m of text.matchAll(/\S[\s\S]*?(?=\n\s*\n|$)/g)) {
    let start = m.index as number;
    const end = start + m[0].trimEnd().length;
    while (end - start > max) {
      let cut = start + max;
      while (cut > start + max / 2 && !/\s/.test(text[cut] as string)) cut--;
      if (!/\s/.test(text[cut] as string)) cut = start + max; // no usable whitespace: hard cut
      if (/[\ud800-\udbff]/.test(text[cut - 1] ?? "")) cut--; // not between surrogates
      if (cut <= start) cut = start + (/[\ud800-\udbff]/.test(text[start] ?? "") ? 2 : 1); // always advance
      out.push({ start, end: cut });
      start = cut;
      while (start < end && /\s/.test(text[start] as string)) start++;
    }
    if (end > start) out.push({ start, end });
  }
  return out;
}

/** Greedy packing of consecutive units; a chunk runs from its first unit's start to its last unit's end. */
function packed(all: Span[], max: number, overlapChars: number, text: string): Span[] {
  const out: Span[] = [];
  let cur: Span | undefined;
  for (const u of all) {
    if (cur && u.end - cur.start > max) {
      out.push(cur);
      cur = { start: overlapStart(text, cur, u, overlapChars, max), end: u.end };
      continue;
    }
    cur = cur ? { start: cur.start, end: u.end } : u;
  }
  if (cur) out.push(cur);
  return out;
}

/** Where the next chunk begins: up to `overlapChars` before `next`, on a word start, within `max`, after the previous start. */
function overlapStart(
  text: string,
  prev: Span,
  next: Span,
  overlapChars: number,
  max: number,
): number {
  let at = Math.max(prev.start + 1, next.start - overlapChars, next.end - max);
  if (at >= next.start) return next.start;
  while (at < next.start && !/\s/.test(text[at - 1] as string)) at++; // snap forward to a word start
  return Math.min(at, next.start);
}

/** Deterministic, so a re-run of the chunk step writes the same ids and embedding is idempotent by id. */
export function chunkIdFor(documentId: string, ordinal: number): string {
  const h = createHash("sha256").update(`docmind-chunk-v1:${documentId}:${ordinal}`).digest();
  h[6] = ((h[6] as number) & 0x0f) | 0x50; // version 5 layout
  h[8] = ((h[8] as number) & 0x3f) | 0x80; // RFC 4122 variant
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** Section-bounded chunks whose text is an exact slice of the section text. */
export function chunkDocument(doc: ParsedDocument, options: ChunkOptions = {}): Chunk[] {
  const target = options.targetTokens ?? DEFAULT_TARGET_TOKENS;
  if (!Number.isInteger(target) || target < 1)
    throw new RangeError("targetTokens must be an integer >= 1");
  const overlap = options.overlap ?? DEFAULT_OVERLAP;
  if (!Number.isFinite(overlap) || overlap < 0 || overlap >= 1)
    throw new RangeError("overlap must be a number in [0, 1)");
  const max = target * CHARS_PER_TOKEN;
  const overlapChars = Math.floor(max * overlap);
  const chunks: Chunk[] = [];
  doc.sections.forEach((section, sectionOrdinal) => {
    const loc = section.locator;
    for (const span of packed(units(section.text, max), max, overlapChars, section.text)) {
      const text = section.text.slice(span.start, span.end);
      chunks.push({
        ordinal: chunks.length,
        sectionOrdinal,
        headingPath: section.headingPath,
        text,
        tokenCount: estimateTokens(text),
        locator:
          loc.kind === "chars"
            ? { kind: "chars", start: loc.start + span.start, end: loc.start + span.end }
            : loc,
      });
    }
  });
  return chunks;
}
