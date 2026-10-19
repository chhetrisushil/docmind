import WordExtractor from "word-extractor";
import {
  type DocumentParser,
  ParseRejectedError,
  type ParsedDocument,
  type ParsedSection,
} from "./types";

export const DOC_SECTION_CHARS = 4000;

/**
 * Legacy Word (spec 5.3) with `word-extractor`: body text only, no styles, so no heading paths. Sections
 * are runs of paragraphs, located by paragraph index. Any throw is corrupt content (its message is
 * never kept; the library's errors are plain Error).
 */
export const docParser: DocumentParser = {
  id: "doc",
  accepts: (mime, ext) =>
    mime.split(";")[0]?.trim().toLowerCase() === "application/msword" ||
    ext?.toLowerCase() === "doc",
  async parse(bytes): Promise<ParsedDocument> {
    let body: string;
    try {
      body = (await new WordExtractor().extract(Buffer.from(bytes))).getBody();
    } catch {
      throw new ParseRejectedError("corrupt_content");
    }
    const paragraphs = body
      .replace(/\r\n?/g, "\n")
      .split(/\n\s*\n|\n/)
      .map((p) => p.trim())
      .filter((p) => p !== "");
    const text = paragraphs.join("\n\n");
    const sections: ParsedSection[] = [];
    let from = 0;
    while (from < paragraphs.length) {
      let to = from;
      let size = (paragraphs[from] as string).length;
      while (
        to + 1 < paragraphs.length &&
        size + 2 + (paragraphs[to + 1] as string).length <= DOC_SECTION_CHARS
      ) {
        to++;
        size += 2 + (paragraphs[to] as string).length;
      }
      sections.push({
        headingPath: [],
        text: paragraphs.slice(from, to + 1).join("\n\n"),
        locator: { kind: "paragraphs", from, to },
      });
      from = to + 1;
    }
    return { text, sections, media: [] };
  },
};
