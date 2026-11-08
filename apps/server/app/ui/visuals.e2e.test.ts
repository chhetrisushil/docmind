import { randomUUID } from "node:crypto";
import { PINS, createViews, detailWithVisuals, factProvider } from "@docmind/experiences";
import type { UiReaders } from "@docmind/experiences";
import { InMemoryLineageStore, Lineage } from "@loom-ui/lineage";
import { ReferencePlanner } from "@loom-ui/planner";
import { InMemoryContentStore } from "@loom/plugin-content";
import { describe, expect, it, vi } from "vitest";
import type { Fact } from "../flows/visualize-document/facts";
import { commitPlan, experienceIdOf } from "../flows/visualize-document/lineage";
import { planVisuals } from "../flows/visualize-document/plan";
import { recording, scriptedPlannerModel } from "../flows/visualize-document/testing";

const fact = (ordinal: number, label: string, value: number): Fact => ({
  kind: "figure",
  label,
  value,
  unit: "USD",
  chunkIds: [randomUUID()],
  ordinal,
});
const node = (id: string, label: string, n: number) => ({
  id,
  type: "KeyFigure",
  label,
  span: 4,
  props: {},
  binding: { capability: `fact-${n}`, arguments: {}, path: "value", priority: "P0" },
});

describe("planner output to a served, hydrated detail (R26)", () => {
  it("maps each planned node back to its own fact and hydrates that fact's value", async () => {
    const facts = [fact(0, "Revenue", 4242), fact(1, "Costs", 99)];
    const model = scriptedPlannerModel([
      JSON.stringify({
        summary: "Two figures",
        nodes: [node("rev", "Revenue", 0), node("cost", "Costs", 1)],
      }),
    ]);
    const plan = await planVisuals(
      new ReferencePlanner({ model, modelId: "t" }),
      facts,
      recording(),
    );
    const lineage = new Lineage({
      events: new InMemoryLineageStore(),
      content: new InMemoryContentStore(),
    });
    const ref = { tenantId: randomUUID(), userId: randomUUID(), documentId: randomUUID() };
    await commitPlan(lineage, ref, plan, () => "2026-11-08T10:00:00.000Z");
    const head = await lineage.resolveLatest(experienceIdOf(ref));
    if (!head.ok) throw new Error("no head");

    const exp = detailWithVisuals(head.value, ref.documentId);
    expect(JSON.stringify(exp.root)).toContain('"id":"visuals"');
    expect(exp.providers["fact-0"]).toEqual(factProvider(0, ref.documentId, "KeyFigure"));
    expect(exp.providers["fact-1"]).toEqual(factProvider(1, ref.documentId, "KeyFigure"));
    // the generated providers carry the invoker's own pin, so the schemaDrift check is unaffected
    expect(exp.providers["fact-1"]?.executionGraph[0]?.toolSchemaHash).toBe(PINS["visual.facts"]);

    const visualFacts = vi.fn(async () => facts as never);
    const readers = { visualFacts } as unknown as UiReaders;
    const views = createViews({ placeholderKey: "k".repeat(32), revisionKey: "r".repeat(32) });
    const p = views.documentPayload(ref.documentId, head.value, "web");
    const load = (handle: string) => ({
      experienceId: p.experienceId,
      versionHash: p.versionHash,
      handle,
      params: {},
    });
    const [a, b] = await views.hydrateExperience(
      exp,
      [load("fact-0"), load("fact-1")],
      readers,
      "u",
    );
    expect(JSON.stringify(a), "a").toContain("4242");
    expect(JSON.stringify(a)).toContain("4242");
    expect(JSON.stringify(b)).toContain("99");
    expect(visualFacts).toHaveBeenCalledTimes(1);
  });
});
