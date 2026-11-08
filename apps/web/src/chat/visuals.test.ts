import { describe, expect, it } from "vitest";
import { VISUALS_COPY, visualsViewOf } from "./visuals";

const base = {
  role: "assistant" as const,
  status: "complete",
  citations: [{}],
  hasVisuals: false,
  phase: "idle" as const,
};

describe("visualsViewOf", () => {
  it("has the exact copy of the spec", () => {
    expect(VISUALS_COPY).toEqual({
      strip: "Visuals",
      visualize: "Visualize",
      visualizing: "Visualizing…",
      revisualize: "Re-visualize",
      limited: "Try again in a minute",
      nothing: "Nothing to visualize",
    });
  });
  it("offers Visualize on a cited answer with no visuals, and Re-visualize plus the strip once it has some", () => {
    expect(visualsViewOf(base)).toEqual({
      strip: false,
      action: "Visualize",
      busy: false,
      note: null,
    });
    expect(visualsViewOf({ ...base, hasVisuals: true })).toEqual({
      strip: true,
      action: "Re-visualize",
      busy: false,
      note: null,
    });
  });
  it("shows Visualizing… (busy) while a run is waited on, keeping the strip of earlier visuals", () => {
    expect(visualsViewOf({ ...base, phase: "running" })).toEqual({
      strip: false,
      action: "Visualizing…",
      busy: true,
      note: null,
    });
    expect(visualsViewOf({ ...base, hasVisuals: true, phase: "running" })?.strip).toBe(true);
  });
  it("says Try again in a minute after a 429, without the action, and Nothing to visualize beside it", () => {
    expect(visualsViewOf({ ...base, phase: "limited" })).toEqual({
      strip: false,
      action: null,
      busy: false,
      note: "Try again in a minute",
    });
    expect(visualsViewOf({ ...base, phase: "nothing" })).toEqual({
      strip: false,
      action: "Visualize",
      busy: false,
      note: "Nothing to visualize",
    });
  });
  it("keeps the earlier visuals when a re-run ends nothing (ruling C1): no note, back to Re-visualize", () => {
    expect(visualsViewOf({ ...base, hasVisuals: true, phase: "nothing" })).toEqual({
      strip: true,
      action: "Re-visualize",
      busy: false,
      note: null,
    });
  });
  it.each([
    [{ role: "user" as const }],
    [{ status: "interrupted" }],
    [{ status: "failed" }],
    [{ status: "rejected" }],
    [{ status: "streaming" }],
    [{ citations: [] }],
  ])("shows neither strip nor action for %j", (over) => {
    expect(visualsViewOf({ ...base, ...over, hasVisuals: true })).toBeNull();
  });
});
