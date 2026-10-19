import type { ParsedSection } from "@docmind/parsers";

export const SUMMARY_GROUP_CHARS = 24_000;

export interface SummaryGroup {
  sections: number[];
  text: string;
}

const SEPARATOR = "\n\n";
const isHigh = (c: string | undefined) => /[\ud800-\udbff]/.test(c ?? "");

/** Largest cut in (0, max] that is not between surrogates; prefers whitespace in the second half. */
function cutAt(text: string, max: number): number {
  if (text.length <= max) return text.length;
  let cut = max;
  while (cut > max / 2 && !/\s/.test(text[cut] as string)) cut--;
  if (!/\s/.test(text[cut] as string)) cut = max;
  if (isHigh(text[cut - 1])) cut--;
  if (cut <= 0) cut = isHigh(text[0]) ? 2 : 1;
  return cut;
}

/**
 * Packs consecutive sections into groups holding at most `groupChars` of body text (plus the heading
 * prefix and separators). `maxChars` bounds the body text read; heading prefixes are not counted.
 */
export function packGroups(
  sections: ParsedSection[],
  maxChars: number,
  groupChars: number = SUMMARY_GROUP_CHARS,
): SummaryGroup[] {
  const groups: SummaryGroup[] = [];
  let current: SummaryGroup | null = null;
  const add = (index: number, piece: string) => {
    if (current && current.text.length + SEPARATOR.length + piece.length <= groupChars) {
      current.text += SEPARATOR + piece;
      if (!current.sections.includes(index)) current.sections.push(index);
      return;
    }
    current = { sections: [index], text: piece };
    groups.push(current);
  };
  let used = 0;
  for (const [index, section] of sections.entries()) {
    if (used >= maxChars) break;
    let text = section.text.trim();
    if (text === "") continue;
    if (used + text.length > maxChars) {
      text = text.slice(0, cutAt(text, maxChars - used)).trimEnd();
      if (text === "") break;
    }
    used += text.length;
    const prefix = section.headingPath.length > 0 ? `## ${section.headingPath.join(" › ")}\n` : "";
    if (text.length <= groupChars) {
      add(index, prefix + text);
      continue;
    }
    const room = Math.max(1, groupChars - prefix.length);
    let rest = text;
    while (rest !== "") {
      const cut = cutAt(rest, room);
      const piece = rest.slice(0, cut).trim();
      if (piece !== "") add(index, prefix + piece);
      rest = rest.slice(cut).trimStart();
    }
  }
  return groups;
}
