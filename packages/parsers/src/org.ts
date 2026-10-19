import { parse } from "orga";
import { cutHeading, decodeText } from "./text";
import type { DocumentParser, ParsedDocument, ParsedSection } from "./types";

const MAX_DEPTH = 16; // ParsedSection.headingPath.max

interface OrgNode {
  type: string;
  children?: OrgNode[];
  position?: { start: { offset: number }; end: { offset: number } };
}
const off = (n: OrgNode | undefined, edge: "start" | "end") => n?.position?.[edge].offset;
// Headline children that are not part of the title.
const NOT_TITLE = new Set(["stars", "todo", "tags", "priority"]);

/**
 * Org-mode (spec 5.3) with `orga`. A section is a headline's own body: from the end of its headline to
 * its first child section (or its end). The title is the headline's children minus stars, TODO keyword,
 * priority and tags. Offsets come from the parser, so every section is an exact slice of the text.
 */
export const orgParser: DocumentParser = {
  id: "org",
  accepts: (mime, ext) =>
    mime.split(";")[0]?.trim().toLowerCase() === "text/x-org" || ext?.toLowerCase() === "org",
  parse(bytes): ParsedDocument {
    const text = decodeText(bytes);
    if (text.trim() === "") return { text: "", sections: [], media: [] };
    const sections: ParsedSection[] = [];
    const push = (path: string[], from: number, to: number) => {
      let start = from;
      let end = to;
      while (start < end && /\s/.test(text[start] as string)) start++;
      while (end > start && /\s/.test(text[end - 1] as string)) end--;
      if (end > start) {
        sections.push({
          headingPath: path.slice(0, MAX_DEPTH),
          text: text.slice(start, end),
          locator: { kind: "chars", start, end },
        });
      }
    };
    const visit = (node: OrgNode, path: string[]) => {
      const kids = node.children ?? [];
      const firstSection = kids.find((k) => k.type === "section");
      if (node.type === "section") {
        const headline = kids.find((k) => k.type === "headline");
        const titleKids = (headline?.children ?? []).filter((k) => !NOT_TITLE.has(k.type));
        const from = off(titleKids[0], "start");
        const to = off(titleKids.at(-1), "end");
        const title =
          from === undefined || to === undefined ? "" : cutHeading(text.slice(from, to));
        const own = [...path, title];
        push(own, off(headline, "end") ?? 0, off(firstSection, "start") ?? off(node, "end") ?? 0);
        for (const k of kids) if (k.type === "section") visit(k, own);
        return;
      }
      push(path, 0, off(firstSection, "start") ?? text.length); // the document's preamble
      for (const k of kids) if (k.type === "section") visit(k, path);
    };
    visit(parse(text) as OrgNode, []);
    return { text, sections, media: [] };
  },
};
