import { describe, expect, it } from "vitest";
import { grounded } from "../flows/visualize-document/facts";
import {
  EVAL_SUMMARY_MAX_CHARS,
  VISUALS_EVAL_CASES,
  summarizeVisualsEval,
} from "./visualsEval.fixture";

describe("the chat visuals eval fixture", () => {
  it("has unique ids, both source kinds, and questions over documents with known figures", () => {
    const ids = VISUALS_EVAL_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(VISUALS_EVAL_CASES.map((c) => c.expectedSource))).toEqual(
      new Set(["stored", "fallback"]),
    );
    expect(VISUALS_EVAL_CASES.length).toBeGreaterThanOrEqual(8);
  });
  it("every known figure is stated in its document (the grounding check agrees), so a wrong fact is measurable", () => {
    const chunk = "00000000-0000-4000-8000-000000000001";
    for (const c of VISUALS_EVAL_CASES)
      for (const f of c.figures)
        expect(
          grounded(
            { kind: "figure", label: f.label, value: f.value, chunkIds: [chunk] },
            new Map([[chunk, c.document]]),
          ),
          `${c.id}: ${f.label}`,
        ).toBe(true);
  });
  it("sizes each document against the eval's own summary cap: stored cases fit under it, fallback cases state their first figure past it", () => {
    for (const c of VISUALS_EVAL_CASES) {
      if (c.expectedSource === "stored")
        expect(c.document.length, c.id).toBeLessThanOrEqual(EVAL_SUMMARY_MAX_CHARS);
      else expect(c.document.search(/\d/), c.id).toBeGreaterThan(EVAL_SUMMARY_MAX_CHARS); // the filler holds no digit
    }
  });
  it("scores the stored and fallback rates and the wrong facts", () => {
    const [a, b, c] = VISUALS_EVAL_CASES;
    expect(
      summarizeVisualsEval([
        { id: a?.id as string, source: "stored", facts: (a?.figures ?? []).map((f) => ({ ...f })) },
        { id: b?.id as string, source: "fallback", facts: [{ label: "Invented", value: 1 }] },
        { id: c?.id as string, source: "none", facts: [] },
      ]),
    ).toEqual({ stored: 1, fallback: 1, none: 1, wrongFacts: 1 });
  });
});
