import { describe, expect, it } from "vitest";
import type { Citation } from "./chats";
import { sourcesValue } from "./sources";

const c = (n: number, over: Partial<Citation> = {}): Citation => ({
  passageId: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  documentId: "7f6d1b8e-3b0a-4a56-8f2f-0a8e0f7c4d11",
  docTitle: `Doc ${n}`,
  locator: { kind: "page", page: n },
  snippet: `snippet ${n}`,
  ...over,
});

describe("sourcesValue", () => {
  it("says sources appear later when there are none", () =>
    expect(sourcesValue([])).toEqual({
      note: "Sources appear when the answer is complete.",
      sources: [],
    }));
  it("lists each citation with its document, place and snippet, in order, each with its index", () => {
    const v = sourcesValue([c(1), c(2, { docTitle: "" })]);
    expect(v.note).toBe("2 sources for this answer.");
    expect(v.sources.map((s) => [s.title, s.where, s.snippet])).toEqual([
      ["Doc 1", "Page 1", "snippet 1"],
      ["Untitled document", "Page 2", "snippet 2"],
    ]);
    expect(v.sources.map((s) => s.index)).toEqual([0, 1]);
    expect(sourcesValue([c(1)]).note).toBe("1 source for this answer.");
  });
  it("keeps the citations' order whichever is selected, and marks exactly that one", () => {
    const all = [c(1), c(2), c(3)];
    for (const pick of all) {
      const v = sourcesValue(all, pick.passageId);
      expect(v.sources.map((s) => s.passageId)).toEqual(all.map((x) => x.passageId));
      expect(v.sources.map((s) => s.index)).toEqual([0, 1, 2]);
      expect(v.sources.filter((s) => s.selected)).toHaveLength(1);
      expect(v.sources.find((s) => s.selected)?.passageId).toBe(pick.passageId);
    }
  });
  it("marks none without a selection or with an unknown one, and never prefixes the place", () => {
    for (const sel of [undefined, "00000000-0000-4000-8000-0000000000ff"]) {
      const v = sourcesValue([c(1), c(2)], sel);
      expect(v.sources.map((s) => s.selected)).toEqual([false, false]);
    }
    const v = sourcesValue([c(1), c(2)], c(2).passageId);
    expect(v.sources.map((s) => s.where)).toEqual(["Page 1", "Page 2"]);
    expect(JSON.stringify(v)).not.toContain("Selected - ");
  });
  it("names every kind of place, and a place it does not know", () => {
    const where = (locator: Citation["locator"]) =>
      sourcesValue([c(1, { locator })]).sources[0]?.where;
    expect(where({ kind: "section", index: 1 })).toBe("Section 2");
    expect(where({ kind: "chars", start: 120, end: 480 })).toBe("Characters 120-480");
    expect(where({ kind: "paragraphs", from: 4, to: 6 })).toBe("Paragraphs 4-6");
    expect(where({ kind: "region", page: 2 })).toBe("Page 2, region");
    expect(where({ kind: "page" } as never)).toBe("Somewhere in the document");
  });
});
