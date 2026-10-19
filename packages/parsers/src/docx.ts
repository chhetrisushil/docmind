import mammoth from "mammoth";
import { htmlToSections } from "./htmlSections";
import {
  type DocumentParser,
  ParseRejectedError,
  type ParsedDocument,
  type ParsedMedia,
} from "./types";
import { docxZipLimits, zipBudget } from "./zip";

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * docx (spec 5.3): the zip budget first (M3b D5), then mammoth to HTML (images become empty `img`s;
 * their type is recorded as media, never their bytes), then sections from the HTML. Anything mammoth
 * throws is corrupt content: its messages are never kept.
 */
export const docxParser: DocumentParser = {
  id: "docx",
  accepts: (mime, ext) =>
    mime.split(";")[0]?.trim().toLowerCase() === DOCX_MIME || ext?.toLowerCase() === "docx",
  async parse(bytes): Promise<ParsedDocument> {
    zipBudget(bytes, docxZipLimits(bytes.length));
    const images: string[] = [];
    let html: string;
    try {
      const out = await mammoth.convertToHtml(
        { buffer: Buffer.from(bytes) },
        {
          convertImage: mammoth.images.imgElement(async (image) => {
            images.push(String(image.contentType ?? "application/octet-stream").slice(0, 100));
            return { src: "" };
          }),
        },
      );
      html = out.value;
    } catch {
      throw new ParseRejectedError("corrupt_content");
    }
    const { text, sections, images: imageSections } = htmlToSections(html);
    // An image belongs to the section open where it appeared (the walker's index per <img>, in order).
    // If the two lists disagree, record no media rather than mismatched ones.
    const last = Math.max(0, sections.length - 1);
    const media: ParsedMedia[] =
      imageSections.length === images.length
        ? images.map((mime, i) => ({
            mime,
            locator: { kind: "section", index: Math.min(imageSections[i] as number, last) },
          }))
        : [];
    return { text, sections, media };
  },
};
