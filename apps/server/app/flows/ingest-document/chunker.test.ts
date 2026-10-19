import { Locator } from "@docmind/contracts";
import type { ParsedDocument } from "@docmind/parsers";
import { describe, expect, it } from "vitest";
import { chunkDocument, estimateTokens } from "./chunker";

type S = { text: string; headingPath?: string[]; page?: number };
const doc = (...sections: S[]): ParsedDocument => {
  let at = 0;
  const parts = sections.map((s) => {
    const start = at;
    at += s.text.length + 2;
    return {
      headingPath: s.headingPath ?? [],
      text: s.text,
      locator: s.page
        ? ({ kind: "page", page: s.page } as const)
        : ({ kind: "chars", start, end: start + s.text.length } as const),
    };
  });
  return { text: sections.map((s) => s.text).join("\n\n"), sections: parts, media: [] };
};
const para = (n: number, size = 400) => `Paragraph ${n} ${"word ".repeat(size / 5)}`.trim();

describe("chunkDocument", () => {
  it("makes one chunk for a short section, with the exact text and a chars locator", () => {
    expect(chunkDocument(doc({ text: "Short text." }), { overlap: 0 })).toEqual([
      {
        ordinal: 0,
        sectionOrdinal: 0,
        headingPath: [],
        text: "Short text.",
        tokenCount: 3,
        locator: { kind: "chars", start: 0, end: 11 },
      },
    ]);
  });

  it("packs paragraphs up to the target and tiles the section when there is no overlap", () => {
    const text = [1, 2, 3, 4, 5, 6, 7].map((n) => para(n)).join("\n\n");
    const chunks = chunkDocument(doc({ text }), { overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(2400);
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
    expect(chunks.map((c) => c.text).join("\n\n")).toBe(text);
  });

  it("never crosses a section boundary and carries each section's heading path", () => {
    const d = doc(
      { text: "Alpha body.", headingPath: ["A"] },
      { text: "Beta body.", headingPath: ["B", "B1"] },
    );
    expect(
      chunkDocument(d, { overlap: 0 }).map((c) => [c.sectionOrdinal, c.headingPath, c.text]),
    ).toEqual([
      [0, ["A"], "Alpha body."],
      [1, ["B", "B1"], "Beta body."],
    ]);
  });

  it("splits a long paragraph at whitespace, never mid-surrogate", () => {
    const chunks = chunkDocument(doc({ text: `${"😀 ".repeat(1500)}end` }), { overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(2400);
      expect(c.text).not.toMatch(/[\ud800-\udbff]$/);
      expect(c.text).not.toMatch(/^[\udc00-\udfff]/);
    }
  });

  it("hard-cuts whitespace-free text without splitting a surrogate pair", () => {
    const text = "😀".repeat(2000);
    const chunks = chunkDocument(doc({ text }), { overlap: 0 });
    expect(chunks.map((c) => c.text).join("")).toBe(text);
    for (const c of chunks) expect(c.text.length % 2).toBe(0);
  });

  it("gives chars locators that slice the parsed text and passes a page locator through", () => {
    const d = doc({ text: [1, 2, 3, 4].map((n) => para(n, 1000)).join("\n\n") });
    for (const c of chunkDocument(d, { overlap: 0 })) {
      expect(c.locator.kind).toBe("chars");
      if (c.locator.kind === "chars")
        expect(d.text.slice(c.locator.start, c.locator.end)).toBe(c.text);
    }
    expect(chunkDocument(doc({ text: "On a page.", page: 4 }), { overlap: 0 })[0]?.locator).toEqual(
      {
        kind: "page",
        page: 4,
      },
    );
  });

  it("keeps the locator to numbers and a kind: every chunk locator passes the strict contract and no heading leaks in", () => {
    const d = doc({ text: para(1, 5000), headingPath: ["Secret heading"] });
    const chunks = chunkDocument(d, { overlap: 0 });
    for (const c of chunks) {
      expect(Locator.parse(c.locator)).toEqual(c.locator);
      expect(JSON.stringify(c.locator)).not.toContain("Secret");
    }
  });

  it("offsets chars locators from a section that does not start at zero", () => {
    const d = doc({ text: "First." }, { text: "Second section." });
    const c = chunkDocument(d, { overlap: 0 })[1];
    expect(c?.locator).toEqual({ kind: "chars", start: 8, end: 23 });
    expect(d.text.slice(8, 23)).toBe(c?.text);
  });

  it("makes no chunks for an empty document and ignores whitespace-only sections", () => {
    expect(chunkDocument({ text: "", sections: [], media: [] })).toEqual([]);
    expect(chunkDocument(doc({ text: " \n\n " }))).toEqual([]);
  });

  it("honours a smaller target", () => {
    const chunks = chunkDocument(doc({ text: para(1, 1200) }), { targetTokens: 100, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(400);
  });
});

describe("estimateTokens", () => {
  it("estimates four characters per token, at least one", () => {
    expect([estimateTokens("a"), estimateTokens("abcd"), estimateTokens("abcde")]).toEqual([
      1, 1, 2,
    ]);
  });
});
