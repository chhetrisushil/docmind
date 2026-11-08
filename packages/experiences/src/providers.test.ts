import { describe, expect, it } from "vitest";
import { PINS, factFormatFingerprint } from "./providers";

describe("factFormatFingerprint", () => {
  it("is stable and names the pins of both fact tools", () => {
    expect(factFormatFingerprint()).toBe(factFormatFingerprint());
    expect(factFormatFingerprint()).toBe(`${PINS["visual.facts"]}+${PINS["turn.facts"]}`);
  });

  it("changes when either fact pin changes, and not when another pin does", () => {
    const saved = { ...PINS };
    const mut = PINS as Record<string, string>;
    try {
      const before = factFormatFingerprint();
      mut["visual.facts"] = "docmind:visual.facts@2";
      const afterVisual = factFormatFingerprint();
      expect(afterVisual).not.toBe(before);
      mut["turn.facts"] = "docmind:turn.facts@2";
      expect(factFormatFingerprint()).not.toBe(afterVisual);
      Object.assign(mut, saved);
      mut["documents.list"] = "docmind:documents.list@9";
      expect(factFormatFingerprint()).toBe(before);
    } finally {
      Object.assign(mut, saved);
    }
  });
});
