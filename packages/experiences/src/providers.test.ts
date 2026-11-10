import { describe, expect, it } from "vitest";
import { PINS, STRUCTURE_FORMAT, factFormatFingerprint } from "./providers";

describe("factFormatFingerprint", () => {
  it("is stable and names the pins of both fact tools, of the connections tool, and the structure format", () => {
    expect(factFormatFingerprint()).toBe(factFormatFingerprint());
    expect(factFormatFingerprint()).toBe(
      `${PINS["visual.facts"]}+${PINS["turn.facts"]}+${PINS["doc.connections"]}+${STRUCTURE_FORMAT}`,
    );
    expect(STRUCTURE_FORMAT).toBe("docmind.structure@1");
    expect(factFormatFingerprint().length).toBeLessThanOrEqual(200);
  });

  it("is unchanged by the timeline and relations release, so the boot stale pass re-plans nothing (spec D5)", () => {
    // The literal is the fingerprint on `main` before this release; a run stamped with it must still read as current.
    expect(factFormatFingerprint()).toBe(
      "docmind:visual.facts@1+docmind:turn.facts@1+docmind:doc.connections@1+docmind.structure@1",
    );
  });

  it("changes when any of the three pins changes, and not when another pin does", () => {
    const saved = { ...PINS };
    const mut = PINS as Record<string, string>;
    try {
      const before = factFormatFingerprint();
      mut["visual.facts"] = "docmind:visual.facts@2";
      const afterVisual = factFormatFingerprint();
      expect(afterVisual).not.toBe(before);
      mut["turn.facts"] = "docmind:turn.facts@2";
      const afterTurn = factFormatFingerprint();
      expect(afterTurn).not.toBe(afterVisual);
      mut["doc.connections"] = "docmind:doc.connections@2";
      expect(factFormatFingerprint()).not.toBe(afterTurn);
      Object.assign(mut, saved);
      mut["documents.list"] = "docmind:documents.list@9";
      expect(factFormatFingerprint()).toBe(before);
    } finally {
      Object.assign(mut, saved);
    }
  });
});
