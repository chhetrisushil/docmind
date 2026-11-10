import { mergedCatalog, shape } from "@docmind/experiences";
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

describe("lu-diagram draws the reshaped timeline and relationships (real reshaper output)", () => {
  type El = HTMLElement & { updateComplete: Promise<boolean>; value: unknown };
  const cid = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
  const mount = async (value: unknown): Promise<ShadowRoot> => {
    document.body.innerHTML = "";
    const el = document.createElement("lu-diagram") as El;
    Object.assign(el, {
      widget: {
        kind: "Diagram",
        id: "d",
        title: "Chart",
        binding: { projectionId: "hydration", path: "values.d" },
        props: {},
      },
      value,
    });
    document.body.appendChild(el);
    for (let i = 0; i < 3; i++) await el.updateComplete;
    return el.shadowRoot as ShadowRoot;
  };
  const texts = (root: ShadowRoot, selector: string) =>
    [...root.querySelectorAll(selector)].map((t) => t.textContent);

  it("a timeline: one node per event in date order, a quarter event labelled as written, a day event as its text", async () => {
    const value = shape("visual-timeline-18", [
      {
        kind: "timeline",
        ordinal: 18,
        chunkIds: [cid(1), cid(2), cid(3)],
        events: [
          {
            at: "2024-03-01",
            precision: "month",
            when: "March 2024",
            label: "Acme buys Beta",
            chunkId: cid(1),
          },
          {
            at: "2025-07-01",
            precision: "quarter",
            when: "Q3 2025",
            label: "Launch",
            chunkId: cid(2),
          },
          {
            at: "2026-02-14",
            precision: "day",
            when: "14 February 2026",
            label: "Office opens",
            chunkId: cid(3),
          },
        ],
      },
    ]);
    const root = await mount(value);
    expect(root.querySelector('[data-layout="timeline"]')).not.toBeNull();
    expect(texts(root, "svg .node text")).toEqual([
      "March 2024 · Acme buys Beta",
      "Q3 2025 · Launch",
      "Office opens",
    ]);
  });

  it("relationships: a node per party and a labelled arrow per relation, as text", async () => {
    const value = shape("visual-relations-19", [
      {
        kind: "relations",
        ordinal: 19,
        chunkIds: [cid(1)],
        entities: ["Acme", "Beta Works", "Cora"],
        links: [
          { from: 0, to: 1, rel: "acquired", chunkId: cid(1) },
          { from: 2, to: 0, rel: "leads", chunkId: cid(1) },
          { from: 2, to: 1, rel: "advises", chunkId: cid(1) },
        ],
      },
    ]);
    const root = await mount(value);
    expect(root.querySelector('[data-layout="network"]')).not.toBeNull();
    expect(texts(root, "svg .node text").sort()).toEqual(["Acme", "Beta Works", "Cora"]);
    expect(texts(root, "svg .edge text").sort()).toEqual(["acquired", "advises", "leads"]);
  });
});
