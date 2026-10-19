import { cutHeading } from "./text";
import type { ParsedSection } from "./types";

const MAX_DEPTH = 16; // ParsedSection.headingPath.max
const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot);/gi, (m, e: string) => {
    const lower = e.toLowerCase();
    if (lower in NAMED) return NAMED[lower] as string;
    const cp = lower.startsWith("#x")
      ? Number.parseInt(lower.slice(2), 16)
      : Number.parseInt(lower.slice(1), 10);
    return cp >= 1 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)
      ? String.fromCodePoint(cp)
      : m;
  });
}

const BLOCKS = new Set(["p", "li", "td", "th", "ul", "ol", "table", "tr"]);

/**
 * Walks mammoth's HTML subset into text and sections (spec 5.3). `h1`-`h6` open sections (their text is
 * the heading path, never section text); `p`, `li`, `td`, `th` are blocks joined by a blank line (cells by
 * a tab, rows by a newline). Separators sit between blocks only, so each section is an exact `chars`
 * slice of `text`. `images` lists the section index open at each `<img>`, in document order.
 */
export function htmlToSections(html: string): {
  text: string;
  sections: ParsedSection[];
  images: number[];
} {
  let text = "";
  const sections: ParsedSection[] = [];
  const images: number[] = [];
  const stack: { level: number; title: string }[] = [];
  let open = { path: [] as string[], start: -1, end: -1 };
  let buf = "";
  let heading = 0; // the open heading's level, or 0
  let sep = "";

  const closeSection = () => {
    if (open.start >= 0) {
      sections.push({
        headingPath: open.path,
        text: text.slice(open.start, open.end),
        locator: { kind: "chars", start: open.start, end: open.end },
      });
    }
  };
  const flushBlock = (): boolean => {
    const block = buf.trim();
    buf = "";
    if (block === "") return false;
    if (text !== "") text += sep;
    if (open.start < 0) open.start = text.length;
    text += block;
    open.end = text.length;
    return true;
  };
  const sepAfter = (tag: string) => {
    sep = tag === "td" || tag === "th" ? "\t" : tag === "tr" ? "\n" : "\n\n";
  };

  for (const m of html.matchAll(/<(\/?)([a-z0-9]+)[^>]*>|[^<]+|</gi)) {
    const [raw, slash, name] = m;
    if (name === undefined) {
      buf += decode(raw);
      continue;
    }
    const tag = name.toLowerCase();
    const level = /^h([1-6])$/.test(tag) ? Number(tag[1]) : 0;
    if (!slash) {
      if (level) {
        if (heading === 0) flushBlock();
        heading = level;
        buf = "";
        closeSection();
        open = { path: open.path, start: -1, end: -1 };
      } else if (tag === "br") buf += "\n";
      else if (tag === "img") images.push(sections.length);
      else if (BLOCKS.has(tag) && heading === 0) {
        if (buf.trim() !== "") {
          flushBlock();
          sep = "\n\n";
        }
        if (tag === "table") sep = "\n\n";
      }
      continue;
    }
    if (level) {
      if (heading === 0) continue;
      const title = cutHeading(decode(buf).trim() === "" ? "" : buf);
      buf = "";
      heading = 0;
      if (title !== "") {
        while (stack.length > 0 && (stack[stack.length - 1] as { level: number }).level >= level)
          stack.pop();
        stack.push({ level, title });
        open = { path: stack.slice(0, MAX_DEPTH).map((s) => s.title), start: -1, end: -1 };
      }
      sep = "\n\n";
    } else if (BLOCKS.has(tag) && heading === 0) {
      const emitted = flushBlock();
      if (!emitted && (tag === "td" || tag === "th") && sep.startsWith("\t")) sep += "\t";
      else sepAfter(tag);
    }
  }
  if (heading === 0) flushBlock();
  closeSection();
  return { text, sections, images };
}
