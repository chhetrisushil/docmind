import { Locator } from "@docmind/contracts";
import type { ParsedDocument } from "@docmind/parsers";
import { describe, expect, it } from "vitest";
import { chunkDocument, chunkIdFor, estimateTokens } from "./chunker";

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

describe("chunkDocument options", () => {
  it.each([0, -1, 1.5, Number.NaN])("rejects targetTokens %s", (targetTokens) => {
    expect(() => chunkDocument(doc({ text: "x" }), { targetTokens })).toThrow(
      new RangeError("targetTokens must be an integer >= 1"),
    );
  });
  it.each([-0.1, 1, Number.NaN])("rejects overlap %s", (overlap) => {
    expect(() => chunkDocument(doc({ text: "x" }), { overlap })).toThrow(
      new RangeError("overlap must be a number in [0, 1)"),
    );
  });
  it("terminates with the smallest target and keeps exact locators", () => {
    const d = doc({ text: "😀😀😀 😀" });
    const chunks = chunkDocument(d, { targetTokens: 1, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeGreaterThan(0);
      if (c.locator.kind === "chars")
        expect(d.text.slice(c.locator.start, c.locator.end)).toBe(c.text);
    }
  });
});

describe("estimateTokens", () => {
  it("estimates four characters per token, at least one", () => {
    expect([estimateTokens("a"), estimateTokens("abcd"), estimateTokens("abcde")]).toEqual([
      1, 1, 2,
    ]);
  });
});

describe("chunkIdFor", () => {
  it("derives a stable, well-formed UUID per document and ordinal, different for each", () => {
    const d = "11111111-1111-4111-8111-111111111111";
    const id = chunkIdFor(d, 0);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(chunkIdFor(d, 0)).toBe(id);
    expect(
      new Set([id, chunkIdFor(d, 1), chunkIdFor("22222222-2222-4222-8222-222222222222", 0)]).size,
    ).toBe(3);
  });
});

describe("overlap", () => {
  const long = (n: number) => Array.from({ length: n }, (_, i) => para(i + 1)).join("\n\n");

  it("starts each later chunk of a section inside the end of the previous one, by up to 15% of the target", () => {
    const chunks = chunkDocument(doc({ text: long(12) }));
    expect(chunks.length).toBeGreaterThan(2);
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]?.locator;
      const cur = chunks[i]?.locator;
      if (prev?.kind !== "chars" || cur?.kind !== "chars") throw new Error("expected chars");
      const shared = prev.end - cur.start;
      expect(shared).toBeGreaterThan(0);
      expect(shared).toBeLessThanOrEqual(360);
      expect(chunks[i]?.text.length).toBeLessThanOrEqual(2400);
    }
  });

  it("starts overlapped chunks on a word start and covers every non-space character", () => {
    const d = doc({ text: long(12) });
    const chunks = chunkDocument(d);
    const covered = new Array<boolean>(d.text.length).fill(false);
    for (const c of chunks) {
      if (c.locator.kind !== "chars") throw new Error("expected chars");
      if (c.ordinal > 0) expect(/\s/.test(d.text[c.locator.start - 1] ?? "")).toBe(true);
      for (let i = c.locator.start; i < c.locator.end; i++) covered[i] = true;
    }
    expect(d.text.split("").every((ch, i) => /\s/.test(ch) || covered[i])).toBe(true);
  });

  it("does not carry text across sections", () => {
    const chunks = chunkDocument(doc({ text: long(8) }, { text: long(8) }));
    const first = chunks.find((c) => c.sectionOrdinal === 1)?.locator;
    const last = chunks.filter((c) => c.sectionOrdinal === 0).at(-1)?.locator;
    if (first?.kind !== "chars" || last?.kind !== "chars") throw new Error("expected chars");
    expect(first.start).toBeGreaterThanOrEqual(last.end);
  });

  it("is deterministic and equals the no-overlap tiling when overlap is 0", () => {
    const d = doc({ text: long(10) });
    expect(chunkDocument(d)).toEqual(chunkDocument(d));
    expect(
      chunkDocument(d, { overlap: 0 })
        .map((c) => c.text)
        .join("\n\n"),
    ).toBe(d.text);
  });

  it("terminates, stays exact and never splits a surrogate pair on unspaced text", () => {
    const text = "😀".repeat(3000);
    const d = doc({ text });
    const chunks = chunkDocument(d, { targetTokens: 100, overlap: 0.5 });
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      if (c.locator.kind !== "chars") throw new Error("expected chars");
      expect(c.text).toBe(d.text.slice(c.locator.start, c.locator.end));
      expect(c.text.length).toBeLessThanOrEqual(400);
      expect(c.text).toMatch(/^(?:😀)+$/u);
    }
  });
});
