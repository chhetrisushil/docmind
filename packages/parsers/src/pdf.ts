import { extractText, getDocumentProxy } from "unpdf";
import {
  type DocumentParser,
  type ParseRejectCode,
  ParseRejectedError,
  type ParsedDocument,
  type ParsedMedia,
  type ParsedSection,
} from "./types";

export const MAX_PDF_PAGES = 5000;

// unpdf's typings omit these pdf.js options, which are accepted at run time.
const PDF_OPTIONS = {
  isEvalSupported: false,
  useSystemFonts: false,
  disableFontFace: true,
} as Parameters<typeof getDocumentProxy>[1];

/** pdf.js signals by error name; nothing it says is kept. */
export const rejectionOf = (err: unknown): ParseRejectCode =>
  err instanceof Error && err.name === "PasswordException"
    ? "unsupported_content"
    : "corrupt_content";

/**
 * PDF (spec 5.3) with unpdf (pdf.js, in-thread, eval off, no system fonts). A page section per page
 * with text; pages with no text layer are listed as media so the parse step can send them to vision
 * (M3b D8). No rendering happens here: it would need a native canvas.
 */
export const pdfParser: DocumentParser = {
  id: "pdf",
  accepts: (mime, ext) =>
    mime.split(";")[0]?.trim().toLowerCase() === "application/pdf" || ext?.toLowerCase() === "pdf",
  async parse(bytes): Promise<ParsedDocument> {
    let pages: string[];
    try {
      // A copy: pdf.js may transfer or detach the buffer it is given.
      const pdf = await getDocumentProxy(new Uint8Array(bytes), PDF_OPTIONS);
      if (pdf.numPages > MAX_PDF_PAGES) throw new ParseRejectedError("too_large");
      pages = (await extractText(pdf, { mergePages: false })).text as string[];
    } catch (err) {
      if (err instanceof ParseRejectedError) throw err;
      throw new ParseRejectedError(rejectionOf(err));
    }
    const sections: ParsedSection[] = [];
    const media: ParsedMedia[] = [];
    pages.forEach((raw, i) => {
      const text = raw.replace(/\r\n?/g, "\n").trim();
      if (text === "")
        media.push({ mime: "application/pdf", locator: { kind: "page", page: i + 1 } });
      else sections.push({ headingPath: [], text, locator: { kind: "page", page: i + 1 } });
    });
    return { text: sections.map((s) => s.text).join("\n\n"), sections, media };
  },
};
