import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DOC_SECTION_CHARS, docParser, groupParagraphs } from "./doc";
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
    }
    expect(doc.sections.map((s) => s.text).join("\n\n")).toBe(doc.text);
    expect(doc.text).not.toMatch(/\r|\n{3,}/);
  });

  describe("groupParagraphs", () => {
    const loc = (s: { locator: { kind: string } }) => s.locator;
    it("keeps two paragraphs summing to exactly the limit (with separator) in one section", () => {
      const a = "a".repeat(1999);
      const b = "b".repeat(DOC_SECTION_CHARS - 1999 - 2);
      const out = groupParagraphs([a, b]);
      expect(out).toHaveLength(1);
      expect(out[0]?.text.length).toBe(DOC_SECTION_CHARS);
      expect(groupParagraphs([a, `${b}b`])).toHaveLength(2);
    });

    it("makes contiguous sections covering the paragraphs in order", () => {
      const paras = Array.from({ length: 9 }, (_, i) => String(i).repeat(1500));
      const out = groupParagraphs(paras);
      expect(out.length).toBeGreaterThanOrEqual(3);
      let next = 0;
      for (const s of out) {
        const l = loc(s) as { kind: string; from: number; to: number };
        expect(l.kind).toBe("paragraphs");
        expect(l.from).toBe(next);
        next = l.to + 1;
      }
      expect(next).toBe(paras.length);
      expect(out.map((s) => s.text).join("\n\n")).toBe(paras.join("\n\n"));
    });

    it("keeps an oversize paragraph whole in its own section", () => {
      const big = "x".repeat(5000);
      const out = groupParagraphs(["small", big, "tail"]);
      expect(out.map((s) => s.text)).toEqual(["small", big, "tail"]);
      expect(out.map(loc)).toEqual([
        { kind: "paragraphs", from: 0, to: 0 },
        { kind: "paragraphs", from: 1, to: 1 },
        { kind: "paragraphs", from: 2, to: 2 },
      ]);
    });
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
