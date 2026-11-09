import { randomUUID } from "node:crypto";
import { FACT_VISUALS_CATALOG, factCapabilities } from "@docmind/experiences";
import type { FactRef } from "@docmind/experiences";
import { ReferencePlanner } from "@loom-ui/planner";
import { describe, expect, it } from "vitest";
import { CONNECTIONS_PLAN_NODE } from "../../ui/testSupport";
import type { Fact } from "./facts";
import { dropUnfittingOps } from "./fit";
import { VISUALS_INTENT, composeVisuals, planVisuals } from "./plan";
import { recording, scriptedPlannerModel } from "./testing";

const CHUNK = randomUUID();
const FIGURE: Fact = {
  kind: "figure",
  label: "Zebra Revenue",
  value: 4242,
  chunkIds: [CHUNK],
  ordinal: 0,
};
const REGIONS: Fact = {
  kind: "series",
  label: "Zebra Regions",
  points: [
    { x: "North", y: 1 },
    { x: "South", y: 2 },
  ],
  chunkIds: [CHUNK],
  ordinal: 1,
};
const node = (id: string, type: string, capability: string, parent?: string) => ({
  id,
  type,
  label: id,
  span: 4,
  props: {},
  ...(parent && { parent }),
  binding: { capability, arguments: {}, path: "label", priority: "P1" },
});
const plan = (nodes: unknown[]) =>
  planVisuals(
    new ReferencePlanner({
      model: scriptedPlannerModel([JSON.stringify({ summary: "s", nodes })]),
      modelId: "t",
    }),
    [FIGURE, REGIONS],
    recording(),
  );
const byOrdinal = (facts: Fact[]) => (ref: FactRef) =>
  ref.kind === "detail" ? facts.find((f) => f.ordinal === ref.ordinal) : undefined;
const inserted = (ops: readonly unknown[]) =>
  (ops as { type: string; node?: { id: string } }[])
    .filter((o) => o.type === "insertNode")
    .map((o) => o.node?.id);

describe("dropUnfittingOps", () => {
  it("drops a trend over category labels and a key figure over a series, keeps the fitting node", async () => {
    const p = await plan([
      node("headline", "KeyFigure", "fact-0"),
      node("trend", "FigureTrend", "fact-1"),
      node("kpi", "KeyFigure", "fact-1"),
      node("chart", "FigureChart", "fact-1"),
    ]);
    const out = dropUnfittingOps(p.ops, byOrdinal([FIGURE, REGIONS]));
    expect(inserted(out.ops)).toEqual(["headline", "chart"]);
    expect(out.dropped).toEqual(["FigureTrend", "KeyFigure"]); // entry names only, never a fact's text
    expect(JSON.stringify(out.dropped)).not.toContain("Zebra");
  });

  it("drops a node whose fact is gone, and a group left empty (nested too); keeps a group with a survivor", async () => {
    const p = await plan([
      { id: "outer", container: "section", span: 12 },
      { id: "inner", container: "grid", span: 12, parent: "outer" },
      node("trend", "FigureTrend", "fact-1", "inner"),
      { id: "keep", container: "row", span: 12 },
      node("headline", "KeyFigure", "fact-0", "keep"),
      node("lost", "KeyFigure", "fact-0", "keep"),
    ]);
    const out = dropUnfittingOps(p.ops, byOrdinal([REGIONS])); // fact 0 no longer stored
    expect(inserted(out.ops)).toEqual([]);
    expect(out.ops).toEqual([]);
    const some = dropUnfittingOps(p.ops, byOrdinal([FIGURE, REGIONS]));
    expect(inserted(some.ops)).toEqual(["keep", "headline", "lost"]);
  });

  it("leaves the connections widgets alone, and drops a provider no node uses any more", async () => {
    const p = await plan([CONNECTIONS_PLAN_NODE, node("trend", "FigureTrend", "fact-1")]);
    const out = dropUnfittingOps(p.ops, byOrdinal([FIGURE, REGIONS]));
    expect(inserted(out.ops)).toEqual([CONNECTIONS_PLAN_NODE.id]);
    expect(out.ops.filter((o) => o.type === "remapProvider")).toHaveLength(1);
  });

  it("resolves a chat turn's capabilities through the pin: stored (per document) and extracted facts", async () => {
    const doc = randomUUID();
    const offered = [
      { fact: REGIONS, origin: { kind: "doc" as const, documentId: doc } },
      { fact: { ...REGIONS, ordinal: 0 }, origin: { kind: "turn" as const } },
    ];
    const p = await composeVisuals(
      new ReferencePlanner({
        model: scriptedPlannerModel([
          JSON.stringify({
            summary: "s",
            nodes: [node("a", "FigureTrend", "fact-0"), node("b", "FigureChart", "fact-1")],
          }),
        ]),
        modelId: "t",
      }),
      VISUALS_INTENT,
      factCapabilities(offered),
      FACT_VISUALS_CATALOG,
      recording(),
    );
    const lookup = (ref: FactRef) =>
      ref.kind === "doc" && ref.documentId === doc
        ? REGIONS
        : ref.kind === "turn"
          ? { ...REGIONS, ordinal: 0 }
          : undefined;
    expect(inserted(dropUnfittingOps(p.ops, lookup).ops)).toEqual(["b"]);
  });
});
