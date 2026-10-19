import { describe, expect, it } from "vitest";
import { cutHeading } from "./text";

describe("cutHeading", () => {
  it("trims and leaves short titles alone", () => {
    expect(cutHeading("  hi  ")).toBe("hi");
  });
  it("cuts to max units", () => {
    expect(cutHeading("abcdef", 4)).toBe("abcd");
  });
  it("drops a high surrogate left at the cut by a non-BMP char", () => {
    const s = "ab\u{1F600}cd"; // units: a b D83D DE00 c d
    expect(cutHeading(s, 3)).toBe("ab");
    expect(cutHeading(s, 4)).toBe("ab\u{1F600}");
  });
});
