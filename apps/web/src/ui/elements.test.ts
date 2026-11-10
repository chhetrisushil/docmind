import { mergedCatalog } from "@docmind/experiences";
import { describe, expect, it } from "vitest";
import "./elements";
import { createViewRegistry } from "./session";

/**
 * The tag loom-ui's registry draws each widget kind with (litRegistry and the chat registry). Hand-copied on purpose:
 * loom-ui (pinned fc34435) exports no kind-to-tag map; litRegistry.ts registers each tag inline, so none can be read.
 */
const TAG: Record<string, string> = {
  Kpi: "lu-kpi",
  Table: "lu-table",
  StatusCard: "lu-status-card",
  Note: "lu-note",
  Prose: "lu-prose",
  A2UIView: "lu-a2ui-widget",
  BarChart: "lu-bar-chart",
  TimeSeries: "lu-timeseries",
  Chat: "lu-chat",
  Diagram: "lu-diagram",
  TextInput: "lu-text-input",
  SelectInput: "lu-select-input",
  MultiSelectInput: "lu-multi-select-input",
};

// The view registry defines the chat and input elements and the opt-in diagram element when it is built (session.ts builds it on mount).
createViewRegistry();

describe("the web app registers every element its catalogues can draw", () => {
  const kinds = [
    ...new Set(
      mergedCatalog().entries.map((e) => (e.surfaces as { web: { kind: string } }).web.kind),
    ),
  ];
  it("knows a tag for every kind", () => {
    for (const k of kinds) expect(TAG[k], k).toBeDefined();
  });
  it.each(kinds)("%s has its custom element defined", (k) => {
    expect(customElements.get(TAG[k] as string), TAG[k]).toBeDefined();
  });
});

describe("the opt-in diagram widget", () => {
  it("is defined by the registry every view is drawn with (the connections map)", () => {
    createViewRegistry();
    expect(customElements.get("lu-diagram")).toBeDefined();
  });
});

describe("the structure widgets", () => {
  it("the outline and the entity map are Diagram entries, and lu-diagram is defined for them", () => {
    createViewRegistry();
    for (const name of ["DocumentOutline", "EntityMap"]) {
      const entry = mergedCatalog().entries.find((e) => e.name === name);
      expect(entry, name).toBeDefined();
      const kind = (entry?.surfaces as { web: { kind: string } }).web.kind;
      expect(kind).toBe("Diagram");
      expect(customElements.get(TAG[kind] as string)).toBeDefined();
    }
  });

  it("the timeline and the relationships are Diagram entries too (loom-ui's lu-diagram draws the timeline and network layouts)", () => {
    createViewRegistry();
    for (const name of ["DocumentTimeline", "Relationships"]) {
      const entry = mergedCatalog().entries.find((e) => e.name === name);
      expect(entry, name).toBeDefined();
      const kind = (entry?.surfaces as { web: { kind: string } }).web.kind;
      expect(kind).toBe("Diagram");
      expect(customElements.get(TAG[kind] as string)).toBeDefined();
    }
  });
});
