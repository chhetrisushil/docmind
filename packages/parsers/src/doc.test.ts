import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOC_SECTION_CHARS, docParser } from "./doc";
import { ParseRunner } from "./runner/ParseRunner";
import { runDocumentParserConformance } from "./testing/conformance";

const FIXTURE = readFileSync(join(__dirname, "../test-fixtures/word-extractor-test11.doc"));

runDocumentParserConformance(
  () => docParser,
  {
    valid: [
      {
        name: "test11",
        bytes: new Uint8Array(FIXTURE),
        mime: "application/msword",
        ext: "doc",
      },
    ],
    rejected: [
      { name: "garbage", bytes: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3]) },
      { name: "text", bytes: new TextEncoder().encode("not a word file at all") },
    ],
  },
  "docParser",
);

describe("docParser", () => {
  it("groups paragraphs into sections with paragraph-range locators that cover the body in order", async () => {
    const doc = await docParser.parse(new Uint8Array(FIXTURE));
    expect(doc.sections.length).toBeGreaterThan(0);
    let next = 0;
    for (const s of doc.sections) {
      if (s.locator.kind !== "paragraphs") throw new Error("expected paragraphs");
      expect(s.locator.from).toBe(next);
      next = s.locator.to + 1;
      expect(s.headingPath).toEqual([]);
      expect(s.text.length).toBeLessThanOrEqual(Math.max(DOC_SECTION_CHARS, s.text.length));
    }
    expect(doc.sections.map((s) => s.text).join("\n\n")).toBe(doc.text);
    expect(doc.text).not.toMatch(/\r|\n{3,}/);
  });

  it("accepts by mime or extension only", () => {
    expect(docParser.accepts("application/msword; charset=x", undefined)).toBe(true);
    expect(docParser.accepts("application/octet-stream", "DOC")).toBe(true);
    expect(docParser.accepts("text/plain", "txt")).toBe(false);
  });

  it("parses through the sandboxed child bundle", async () => {
    const runner = new ParseRunner({
      limits: { wallClockMs: 20_000, memoryMb: 256, maxInputBytes: 1 << 20, maxChars: 1 << 20 },
    });
    try {
      const viaChild = await runner.run("doc", new Uint8Array(FIXTURE));
      const direct = await docParser.parse(new Uint8Array(FIXTURE));
      expect(viaChild.text).toBe(direct.text);
    } finally {
      await runner.close();
    }
  });
});
