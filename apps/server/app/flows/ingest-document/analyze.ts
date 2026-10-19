import type { DocumentStats } from "@docmind/contracts";
import type { ParsedDocument } from "@docmind/parsers";

export const WORDS_PER_MINUTE = 230;
const LIST_CAP = 20;
const OUTLINE_CAP = 50;
const SCAN_CHARS = 1_000_000; // dates, numbers and language look at the start of long documents only
const STOP: Record<string, readonly string[]> = {
  en: ["the", "and", "of", "to", "in", "is", "it", "that", "with", "for", "on", "are"],
  de: ["der", "die", "und", "das", "ist", "nicht", "mit", "dem", "den", "ein", "eine", "auf"],
  fr: ["le", "la", "les", "et", "des", "est", "une", "dans", "pour", "pas", "que", "sur"],
  es: ["el", "la", "los", "las", "y", "que", "es", "una", "por", "para", "con", "del"],
  it: ["il", "la", "che", "di", "e", "è", "per", "una", "non", "con", "del", "sono"],
  pt: ["o", "a", "os", "que", "e", "do", "da", "em", "um", "para", "com", "não"],
  nl: ["de", "het", "een", "en", "van", "is", "dat", "niet", "op", "met", "zijn", "voor"],
  sv: ["och", "att", "det", "som", "är", "en", "på", "för", "med", "inte", "av", "till"],
};
export const LANGUAGES = Object.keys(STOP);
const MONTHS =
  "January|February|March|April|May|June|July|August|September|October|November|December";
const DATE = new RegExp(
  `\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2} (?:${MONTHS}) \\d{4}\\b|\\b(?:${MONTHS}) \\d{1,2}, \\d{4}\\b`,
  "gi",
);
const NUMBER =
  /[$€£¥]\s?\d[\d,]*(?:\.\d+)?|\b\d+(?:\.\d+)?\s?%|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d{5,}(?:\.\d+)?\b/g;

const unique = (xs: Iterable<string>, cap: number): string[] => {
  const out: string[] = [];
  for (const x of xs) {
    if (!out.includes(x)) out.push(x);
    if (out.length >= cap) break;
  }
  return out;
};

function language(words: string[]): string | null {
  const counts = Object.fromEntries(LANGUAGES.map((l) => [l, 0])) as Record<string, number>;
  for (const w of words)
    for (const l of LANGUAGES)
      if ((STOP[l] as readonly string[]).includes(w)) counts[l] = (counts[l] ?? 0) + 1;
  const [best, second] = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!best || best[1] < 20 || (second && best[1] < second[1] * 1.5)) return null;
  return best[0];
}

/**
 * Deterministic statistics (spec 5.2 "analyze", M3b D11). Everything but the counts derives from
 * content (outline, dates, numbers), so the caller seals the result. Pure: no I/O, no clock.
 */
export function analyzeDocument(parsed: ParsedDocument): DocumentStats {
  const segmenter = new Intl.Segmenter("und", { granularity: "word" });
  const words: string[] = [];
  let wordCount = 0;
  for (const s of segmenter.segment(parsed.text)) {
    if (!s.isWordLike) continue;
    wordCount++;
    if (words.length < 20_000) words.push(s.segment.toLowerCase());
  }
  let maxPage = 0;
  for (const { locator: l } of [...parsed.sections, ...parsed.media]) {
    if ((l.kind === "page" || l.kind === "region") && l.page > maxPage) maxPage = l.page;
  }
  const scan = parsed.text.slice(0, SCAN_CHARS);
  return {
    wordCount,
    pageCount: maxPage > 0 ? maxPage : null,
    readingTimeMinutes: Math.round((wordCount / WORDS_PER_MINUTE) * 10) / 10,
    language: language(words),
    outline: unique(
      parsed.sections
        .filter((s) => s.headingPath.length > 0)
        .flatMap((s) =>
          s.headingPath.slice(0, 2).map((_, i) =>
            s.headingPath
              .slice(0, i + 1)
              .join(" › ")
              .slice(0, 200),
          ),
        ),
      OUTLINE_CAP,
    ),
    dates: unique(scan.match(DATE) ?? [], LIST_CAP),
    numbers: unique(
      (scan.match(NUMBER) ?? []).map((n) => n.trim()),
      LIST_CAP,
    ),
  };
}
