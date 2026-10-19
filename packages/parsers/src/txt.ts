import { decodeText } from "./text";
import type { DocumentParser, ParsedDocument } from "./types";

export const txtParser: DocumentParser = {
  id: "txt",
  accepts: (mime, ext) =>
    mime.split(";")[0]?.trim().toLowerCase() === "text/plain" || ext?.toLowerCase() === "txt",
  parse(bytes): ParsedDocument {
    const text = decodeText(bytes);
    if (text.trim() === "") return { text: "", sections: [], media: [] };
    return {
      text,
      sections: [{ headingPath: [], text, locator: { kind: "chars", start: 0, end: text.length } }],
      media: [],
    };
  },
};
