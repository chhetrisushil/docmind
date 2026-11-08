import { ReferencePlanner } from "@loom-ui/planner";
import { describe, expect, it } from "vitest";
import { recording, scriptedPlannerModel } from "../visualize-document/testing";
import { TURN_INTENT, planTurn } from "./plan";

const A = "00000000-0000-4000-8000-00000000000a";
const fig = (ordinal: number, label: string) => ({
  kind: "figure" as const,
  label,
  value: 7,
  chunkIds: [A],
  ordinal,
});
const node = (id: string, capability: string) => ({
  id,
  type: "KeyFigure",
  label: id,
  span: 4,
  props: {},
  binding: { capability, arguments: {}, path: "value", priority: "P0" },
});

describe("planTurn", () => {
  it("offers a capability per fact, binds stored facts of two documents to their own pins, and records one decision", async () => {
    const B = "00000000-0000-4000-8000-00000000000b";
    const model = scriptedPlannerModel([
      JSON.stringify({ summary: "s", nodes: [node("n1", "fact-0"), node("n2", "fact-1")] }),
    ]);
    const ctx = recording();
    const offered = [
      { fact: fig(0, "Revenue"), origin: { kind: "doc" as const, documentId: A } },
      { fact: fig(0, "Margin"), origin: { kind: "doc" as const, documentId: B } },
    ];
    const plan = await planTurn(new ReferencePlanner({ model, modelId: "test" }), offered, ctx);
    expect(plan.findings.filter((f) => f.severity === "error")).toEqual([]);
    // `remapProvider` is the planner's provider operation
    const pins = plan.ops
      .flatMap((o) =>
        o.type === "remapProvider" ? [o.spec.executionGraph[0]?.toolSchemaHash] : [],
      )
      .sort();
    expect(pins).toEqual(
      [`docmind:visual.facts@1#${A}/fact-0`, `docmind:visual.facts@1#${B}/fact-0`].sort(),
    );
    const before = model.calls;
    await planTurn(new ReferencePlanner({ model, modelId: "test" }), offered, ctx);
    expect(model.calls).toBe(before);
    expect(before).toBe(1);
  });
  it("states the fixed intent and carries no answer text", () => {
    expect(TURN_INTENT.objective).toBe(
      "Illustrate this answer for its reader. Choose nothing if no visual adds understanding.",
    );
    expect(TURN_INTENT.sensitivity).toBe("sensitive");
  });
});
