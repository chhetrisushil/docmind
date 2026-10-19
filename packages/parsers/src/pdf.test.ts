import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MAX_PDF_PAGES, pdfParser, rejectionOf } from "./pdf";
import { ParseRunner } from "./runner/ParseRunner";
import { runDocumentParserConformance } from "./testing/conformance";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(__dirname, "../test-fixtures", name)));

// pdf.js prints a non-fatal standardFontDataUrl warning; keep the test output clean.
beforeAll(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => vi.restoreAllMocks());

runDocumentParserConformance(
  () => pdfParser,
  {
    valid: [
      { name: "two pages", bytes: fixture("two-pages.pdf"), mime: "application/pdf", ext: "pdf" },
    ],
    rejected: [{ name: "garbage", bytes: new TextEncoder().encode("%PDF-1.7\nnot really\n%%EOF") }],
  },
  "pdfParser",
);

describe("pdfParser", () => {
  it("makes one page section per page with text and lists textless pages as media", async () => {
    const doc = await pdfParser.parse(fixture("textless-middle.pdf"));
    expect(doc.sections.map((s) => [s.locator, s.text])).toEqual([
      [{ kind: "page", page: 1 }, "First"],
      [{ kind: "page", page: 3 }, "Third"],
    ]);
    expect(doc.text).toBe("First\n\nThird");
    expect(doc.media).toEqual([{ mime: "application/pdf", locator: { kind: "page", page: 2 } }]);
  });

  it("joins page texts with a blank line", async () => {
    const doc = await pdfParser.parse(fixture("two-pages.pdf"));
    expect(doc.text).toBe("Page one text\n\nPage two text");
    expect(doc.media).toEqual([]);
  });

  it("does not detach the caller's buffer", async () => {
    const bytes = fixture("two-pages.pdf");
    await pdfParser.parse(bytes);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });

  it("maps pdf.js's password error to unsupported_content", () => {
    expect(rejectionOf(Object.assign(new Error("x"), { name: "PasswordException" }))).toBe(
      "unsupported_content",
    );
    expect(rejectionOf(Object.assign(new Error("x"), { name: "InvalidPDFException" }))).toBe(
      "corrupt_content",
    );
    expect(rejectionOf(new TypeError("x"))).toBe("corrupt_content");
  });

  it("bounds the page count", () => {
    expect(MAX_PDF_PAGES).toBe(5000);
  });

  it("accepts by mime or extension", () => {
    expect(pdfParser.accepts("application/pdf; x=y")).toBe(true);
    expect(pdfParser.accepts("application/octet-stream", "PDF")).toBe(true);
    expect(pdfParser.accepts("text/plain", "txt")).toBe(false);
  });

  it("parses through the sandboxed child bundle", async () => {
    const runner = new ParseRunner({
      limits: { wallClockMs: 20_000, memoryMb: 512, maxInputBytes: 1 << 20, maxChars: 1 << 20 },
    });
    try {
      const doc = await runner.run("pdf", fixture("textless-middle.pdf"));
      expect(doc.sections.map((s) => s.text)).toEqual(["First", "Third"]);
      expect(doc.media).toHaveLength(1);
    } finally {
      await runner.close();
    }
  });
});
