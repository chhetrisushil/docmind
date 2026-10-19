import mammoth from "mammoth";
import { describe, expect, it } from "vitest";
import { DOCX_MIME, docxParser } from "./docx";
import { ParseRunner } from "./runner/ParseRunner";
import { runDocumentParserConformance } from "./testing/conformance";
import { makeDocx } from "./testing/makeDocx";
import { makeZip } from "./testing/makeZip";

const enc = (s: string) => new TextEncoder().encode(s);

runDocumentParserConformance(
  () => docxParser,
  {
    valid: [
      {
        name: "headings",
        bytes: makeDocx([{ style: "Heading1", text: "Title" }, { text: "Body." }]),
        mime: DOCX_MIME,
        ext: "docx",
      },
    ],
    rejected: [
      { name: "not a zip", bytes: enc("PK\u0003\u0004 junk") },
      { name: "a zip with no document", bytes: makeZip([{ name: "x.txt", data: enc("x") }]) },
    ],
  },
  "docxParser",
);

const PARAS = [
  { style: "Heading1" as const, text: "Title" },
  { text: "Body one." },
  { style: "Heading2" as const, text: "Sub" },
  { text: "Body two." },
];

describe("docxParser", () => {
  it("makes mammoth turn Heading1 into h1", async () => {
    const out = await mammoth.convertToHtml({ buffer: Buffer.from(makeDocx(PARAS)) });
    expect(out.value).toBe("<h1>Title</h1><p>Body one.</p><h2>Sub</h2><p>Body two.</p>");
  });

  it("maps Heading styles to heading paths", async () => {
    const doc = await docxParser.parse(makeDocx(PARAS));
    expect(doc.sections.map((s) => [s.headingPath, s.text])).toEqual([
      [["Title"], "Body one."],
      [["Title", "Sub"], "Body two."],
    ]);
  });

  it("accepts by mime or extension only", () => {
    expect(docxParser.accepts(`${DOCX_MIME}; x=y`)).toBe(true);
    expect(docxParser.accepts("application/octet-stream", "DOCX")).toBe(true);
    expect(docxParser.accepts("application/zip", "zip")).toBe(false);
  });

  it("refuses a zip bomb before mammoth sees it", async () => {
    const bomb = makeZip([
      { name: "word/document.xml", data: new Uint8Array(65 * 1024 * 1024), method: 8 },
    ]);
    await expect(docxParser.parse(bomb)).rejects.toMatchObject({
      name: "ParseRejectedError",
      code: "too_large",
    });
  });

  it("lists images as media and never carries their bytes", async () => {
    const doc = await docxParser.parse(makeDocx([{ text: "with image" }], { image: true }));
    expect(doc.media).toEqual([{ mime: "image/png", locator: { kind: "section", index: 0 } }]);
  });

  it("records no media when the document has no text sections", async () => {
    const doc = await docxParser.parse(makeDocx([{ text: "" }], { image: true }));
    expect(doc.sections).toEqual([]);
    expect(doc.media).toEqual([]);
  });

  it("places an image in the section open where it appeared", async () => {
    const doc = await docxParser.parse(
      makeDocx(
        [
          { style: "Heading1", text: "A" },
          { text: "a" },
          { style: "Heading1", text: "B" },
          { text: "b" },
        ],
        {
          image: true,
        },
      ),
    );
    expect(doc.media).toEqual([{ mime: "image/png", locator: { kind: "section", index: 1 } }]);
  });

  it("runs inside the bundled child and matches the direct call", async () => {
    const runner = new ParseRunner({
      limits: { wallClockMs: 10_000, memoryMb: 256, maxInputBytes: 1 << 20, maxChars: 1 << 20 },
    });
    try {
      const bytes = makeDocx(PARAS, { image: true });
      expect(await runner.run("docx", bytes)).toEqual(await docxParser.parse(bytes));
    } finally {
      await runner.close();
    }
  });
});
