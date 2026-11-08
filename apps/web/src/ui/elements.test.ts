import { mergedCatalog } from "@docmind/experiences";
import { createChatLitRegistry } from "@loom-ui/renderer-lit/chat";
import { describe, expect, it } from "vitest";
import "./elements";
import "./session";

/**
 * The tag loom-ui's registry draws each widget kind with (litRegistry and the chat registry). Hand-copied on purpose:
 * loom-ui (pinned 5ab86f8) exports no kind-to-tag map; litRegistry.ts registers each tag inline, so none can be read.
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
  TextInput: "lu-text-input",
  SelectInput: "lu-select-input",
  MultiSelectInput: "lu-multi-select-input",
};

// The chat registry defines the chat and input elements when it is built (session.ts builds it on mount).
createChatLitRegistry();

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
