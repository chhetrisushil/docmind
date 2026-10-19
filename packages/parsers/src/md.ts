import { Lexer, type Token } from "marked";
import { cutHeading, decodeText } from "./text";
import type { DocumentParser, ParsedDocument, ParsedSection } from "./types";

const MAX_DEPTH = 16; // ParsedSection.headingPath.max

/** The plain text of a heading's inline tokens: emphasis, links and code spans lose their markup. */
function plain(tokens: Token[] | undefined, fallback: string): string {
  if (!tokens) return fallback;
  let out = "";
  for (const t of tokens) {
    const nested = (t as { tokens?: Token[] }).tokens;
    out += nested ? plain(nested, "") : "text" in t && typeof t.text === "string" ? t.text : t.raw;
  }
  return out;
}

/** Trims whitespace off a range of `text` so the section stays an exact slice. */
function trimmed(text: string, from: number, to: number): { start: number; end: number } {
  let start = from;
  let end = to;
  while (start < end && /\s/.test(text[start] as string)) start++;
  while (end > start && /\s/.test(text[end - 1] as string)) end--;
  return { start, end };
}

/**
 * Markdown (spec 5.3, M3b D4: `marked`'s lexer, not remark, which needs ~600 bytes of heap per source
 * byte). Each heading starts a section that runs to the next heading; the heading text goes into the
 * heading path, never into the section text. Top-level token `raw` strings tile the input exactly,
 * so offsets are exact; if they ever do not, the whole text is one section.
 */
export const mdParser: DocumentParser = {
  id: "md",
  accepts: (mime, ext) => {
    const m = mime.split(";")[0]?.trim().toLowerCase();
    const e = ext?.toLowerCase();
    return m === "text/markdown" || e === "md" || e === "markdown";
  },
  parse(bytes): ParsedDocument {
    const text = decodeText(bytes);
    if (text.trim() === "") return { text: "", sections: [], media: [] };
    const tokens = Lexer.lex(text, { gfm: true });
    const sections: ParsedSection[] = [];
    const stack: { depth: number; text: string }[] = [];
    let open = { start: 0, path: [] as string[] };
    let at = 0;
    const close = (end: number) => {
      const r = trimmed(text, open.start, end);
      if (r.end > r.start) {
        sections.push({
          headingPath: open.path,
          text: text.slice(r.start, r.end),
          locator: { kind: "chars", ...r },
        });
      }
    };
    for (const token of tokens) {
      const start = at;
      at += token.raw.length;
      if (token.type !== "heading") continue;
      close(start);
      const depth = (token as { depth: number }).depth;
      while (stack.length > 0 && (stack.at(-1)?.depth ?? 0) >= depth) stack.pop();
      const title = cutHeading(
        plain((token as { tokens?: Token[] }).tokens, (token as { text: string }).text),
      );
      stack.push({ depth, text: title });
      open = { start: at, path: stack.map((s) => s.text).slice(0, MAX_DEPTH) };
    }
    if (at !== text.length) {
      // The lexer did not tile the input: fall back to one exact section rather than wrong offsets.
      const r = trimmed(text, 0, text.length);
      return {
        text,
        sections: [
          {
            headingPath: [],
            text: text.slice(r.start, r.end),
            locator: { kind: "chars", ...r },
          },
        ],
        media: [],
      };
    }
    close(text.length);
    return { text, sections, media: [] };
  },
};
