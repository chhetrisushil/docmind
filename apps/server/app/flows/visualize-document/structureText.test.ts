import { describe, expect, it } from "vitest";
import { cleanText, earliestPassage, isRecord, nameKey } from "./structureText";

describe("cleanText", () => {
  it("turns control characters and line breaks into one space and drops invisible format characters", () => {
    expect(cleanText("A\u0000B", 80)).toBe("A B");
    expect(cleanText("  x \n\t y  ", 80)).toBe("x y");
    expect(cleanText("Ac\u200bme\u2060 Corp\ufeff", 80)).toBe("Acme Corp");
    expect(cleanText("line\u2028break\u2029here", 80)).toBe("line break here");
  });

  it("clips at the limit, never inside a surrogate pair, and trims after clipping", () => {
    expect(cleanText("abcdef", 3)).toBe("abc");
    expect(cleanText("ab cdef", 3)).toBe("ab");
    expect(cleanText(`${"a".repeat(79)}\u{1F600}`, 80)).toBe("a".repeat(79));
  });

  it("is empty when nothing visible is left", () => {
    expect(cleanText(" \u200b\u0007 ", 80)).toBe("");
    expect(cleanText("", 80)).toBe("");
  });
});

describe("nameKey", () => {
  it("folds case, width, ligatures and runs of spaces, so spellings of one name collide", () => {
    expect(nameKey("  ACME   Corp ")).toBe("acme corp");
    expect(nameKey("ﬁnance")).toBe("finance");
    expect(nameKey("Ｃｏｒａ")).toBe("cora");
    expect(nameKey("Acme")).not.toBe(nameKey("Acme Corp"));
  });
});

describe("earliestPassage", () => {
  const position = new Map([
    ["aaaa", 0],
    ["bbbb", 1],
    ["cccc", 2],
  ]);
  it("is the cited passage of this document with the lowest position, matched case-insensitively", () => {
    expect(earliestPassage(["cccc", "BBBB", "zzzz", 5], position)).toBe("bbbb");
    expect(earliestPassage(["cccc"], position)).toBe("cccc");
  });
  it("is null when nothing cited belongs to this document, or the field is not a list", () => {
    expect(earliestPassage(["zzzz"], position)).toBeNull();
    expect(earliestPassage([], position)).toBeNull();
    expect(earliestPassage("aaaa", position)).toBeNull();
    expect(earliestPassage(undefined, position)).toBeNull();
  });
});

describe("isRecord", () => {
  it("accepts plain objects only", () => {
    expect(isRecord({})).toBe(true);
    for (const v of [null, [], "x", 1, undefined]) expect(isRecord(v)).toBe(false);
  });
});
