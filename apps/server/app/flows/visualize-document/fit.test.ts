import { randomUUID } from "node:crypto";
import { FACT_VISUALS_CATALOG, factCapabilities } from "@docmind/experiences";
import type { FactRef, VisualFactRaw } from "@docmind/experiences";
import { ReferencePlanner } from "@loom-ui/planner";
import { describe, expect, it } from "vitest";
import { CONNECTIONS_PLAN_NODE } from "../../ui/testSupport";
import type { Fact, StructureFact } from "./facts";
import { dropUnfittingOps, fittedSummary } from "./fit";
import { VISUALS_INTENT, composeVisuals, planVisuals } from "./plan";
import { aggregateFacts, recording, scriptedPlannerModel } from "./testing";

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
const OUTLINE: StructureFact = {
  kind: "outline",
  title: "Zebra Report",
  nodes: ["A", "B", "C"].map((label, i) => ({
    id: `s${i}`,
    label,
    level: 1,
    passageCount: 1,
    firstChunkId: CHUNK,
  })),
  chunkIds: [CHUNK],
  ordinal: 16,
};
const lookupOf = (facts: readonly VisualFactRaw[]) => (ref: FactRef) =>
  ref.kind === "detail" ? facts.find((f) => f.ordinal === ref.ordinal) : undefined;
const inserted = (ops: readonly unknown[]) =>
  (ops as { type: string; node?: { id: string } }[])
    .filter((o) => o.type === "insertNode")
    .map((o) => o.node?.id);

describe("dropUnfittingOps", () => {
  it("keeps a DocumentOutline bound to the outline fact and drops it when fact-16 holds something else", async () => {
    const outlineNode = {
      ...node("outline", "DocumentOutline", "fact-16"),
      span: 12,
      binding: { capability: "fact-16", arguments: {}, path: "nodes", priority: "P1" },
    };
    const p = await planVisuals(
      new ReferencePlanner({
        model: scriptedPlannerModel([JSON.stringify({ summary: "s", nodes: [outlineNode] })]),
        modelId: "t",
      }),
      [FIGURE, OUTLINE],
      recording(),
    );
    expect(p.findings.filter((f) => f.severity === "error")).toEqual([]);
    const kept = dropUnfittingOps(p.ops, lookupOf([FIGURE, OUTLINE]));
    expect(inserted(kept.ops)).toEqual(["outline"]);
    expect(kept.dropped).toEqual([]);
    // fact-16 now holds a figure: an outline widget does not fit it
    const gone = dropUnfittingOps(p.ops, lookupOf([FIGURE, { ...FIGURE, ordinal: 16 }]));
    expect(inserted(gone.ops)).toEqual([]);
    expect(gone.dropped).toEqual(["DocumentOutline"]);
    // and a fact that is gone fits nothing
    expect(inserted(dropUnfittingOps(p.ops, lookupOf([FIGURE])).ops)).toEqual([]);
  });

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

describe("fittedSummary", () => {
  const withFindings = async () => {
    const p = await plan([
      node("headline", "KeyFigure", "fact-0"),
      node("trend", "FigureTrend", "fact-1"),
    ]);
    const report = {
      ...p.report,
      attempts: [
        {
          parsed: true,
          findings: [
            { code: "x", severity: "warn" as const, message: "Zebra trend", nodeId: "trend" },
            { code: "y", severity: "warn" as const, message: "kept note", nodeId: "headline" },
            { code: "z", severity: "warn" as const, message: "plan-wide" },
          ],
        },
      ],
    };
    return {
      ...p,
      report,
      summary: "Zebra Regions trend shows growth",
      summaryClass: p.summaryClass,
    };
  };

  it("with a drop, replaces the planner summary by survivors' entry names and filters the report", async () => {
    const p = await withFindings();
    const fitted = dropUnfittingOps(p.ops, byOrdinal([FIGURE, REGIONS]));
    expect(fitted.dropped).toEqual(["FigureTrend"]);
    const out = fittedSummary(p, fitted);
    expect(out.summary).toBe("KeyFigure");
    expect(out.summary).not.toContain("Zebra");
    expect(JSON.stringify(out.report)).not.toContain("Zebra trend");
    expect(out.report.attempts[0]?.findings.map((f) => f.code)).toEqual(["y", "z"]);
    expect(out.report.decisionId).toBe(p.report.decisionId);
  });

  it("with no drop, leaves summary and report unchanged", async () => {
    const same = dropUnfittingOps(
      (await plan([node("headline", "KeyFigure", "fact-0")])).ops,
      byOrdinal([FIGURE]),
    );
    expect(same.dropped).toEqual([]);
    const q = await withFindings();
    const out = fittedSummary(q, same);
    expect(out.summary).toBe(q.summary);
    expect(out.report).toBe(q.report);
  });

  it("keeps a DocumentTimeline and a Relationships bound to their own facts, and drops each on the wrong or a missing fact", async () => {
    const { timeline, relations } = aggregateFacts(CHUNK);
    const widget = (id: string, type: string, capability: string, path: string) => ({
      ...node(id, type, capability),
      span: 12,
      binding: { capability, arguments: {}, path, priority: "P1" },
    });
    const p = await planVisuals(
      new ReferencePlanner({
        model: scriptedPlannerModel([
          JSON.stringify({
            summary: "s",
            nodes: [
              widget("timeline", "DocumentTimeline", "fact-18", "nodes"),
              widget("relations", "Relationships", "fact-19", "edges"),
            ],
          }),
        ]),
        modelId: "t",
      }),
      [FIGURE, timeline, relations],
      recording(),
    );
    expect(p.findings.filter((f) => f.severity === "error")).toEqual([]);
    const kept = dropUnfittingOps(p.ops, lookupOf([FIGURE, timeline, relations]));
    expect(inserted(kept.ops)).toEqual(["timeline", "relations"]);
    expect(kept.dropped).toEqual([]);
    // each ordinal holds the other aggregate: neither widget fits
    const swapped = dropUnfittingOps(
      p.ops,
      lookupOf([FIGURE, { ...relations, ordinal: 18 }, { ...timeline, ordinal: 19 }]),
    );
    expect(inserted(swapped.ops)).toEqual([]);
    expect(swapped.dropped).toEqual(["DocumentTimeline", "Relationships"]);
    // a chart at 18 fits neither, and a fact that is gone fits nothing
    expect(
      inserted(dropUnfittingOps(p.ops, lookupOf([FIGURE, { ...FIGURE, ordinal: 18 }])).ops),
    ).toEqual([]);
    expect(inserted(dropUnfittingOps(p.ops, lookupOf([FIGURE, timeline])).ops)).toEqual([
      "timeline",
    ]);
  });
});
