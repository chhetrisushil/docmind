import { makeZip } from "./makeZip";

const enc = (s: string) => new TextEncoder().encode(s);
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
// 1x1 transparent PNG.
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

const IMAGE_XML =
  `<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">` +
  `<wp:extent cx="10" cy="10"/><wp:docPr id="1" name="p" descr="x"/>` +
  `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData>` +
  `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill>` +
  `<a:blip r:embed="rId5"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;

/** Test-only: a minimal docx (what mammoth needs) built with `makeZip`. `image` adds a PNG in the last paragraph. */
export function makeDocx(
  paragraphs: { style?: "Heading1" | "Heading2"; text: string }[],
  options: { image?: boolean } = {},
): Uint8Array {
  const body = paragraphs
    .map((p, i) => {
      const style = p.style ? `<w:pPr><w:pStyle w:val="${p.style}"/></w:pPr>` : "";
      const img = options.image && i === paragraphs.length - 1 ? IMAGE_XML : "";
      return `<w:p>${style}<w:r><w:t>${esc(p.text)}</w:t></w:r>${img}</w:p>`;
    })
    .join("");
  const styleXml = (id: string, name: string) =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/></w:style>`;
  const entries = [
    {
      name: "[Content_Types].xml",
      data: enc(
        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>` +
          `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
          `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
      ),
    },
    {
      name: "_rels/.rels",
      data: enc(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
    },
    {
      name: "word/_rels/document.xml.rels",
      data: enc(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/>` +
          `<Relationship Id="rId5" Type="${R}/image" Target="media/image1.png"/></Relationships>`,
      ),
    },
    {
      name: "word/document.xml",
      data: enc(
        `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}</w:body></w:document>`,
      ),
      method: 8 as const,
    },
    {
      name: "word/styles.xml",
      data: enc(
        `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="${W}">${styleXml("Heading1", "heading 1")}${styleXml("Heading2", "heading 2")}</w:styles>`,
      ),
    },
    ...(options.image ? [{ name: "word/media/image1.png", data: PNG }] : []),
  ];
  return makeZip(entries);
}
