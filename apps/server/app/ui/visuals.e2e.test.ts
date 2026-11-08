import { randomUUID } from "node:crypto";
import {
  OWNER_READ,
  PINS,
  capabilitiesOf,
  createViews,
  detailWithVisuals,
  factProvider,
} from "@docmind/experiences";
import type { UiReaders } from "@docmind/experiences";
import { InMemoryLineageStore, Lineage } from "@loom-ui/lineage";
import { declaredToolClassesFrom } from "@loom-ui/planner";
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
      "document",
    );
    expect(JSON.stringify(a)).toContain("4242");
    expect(JSON.stringify(b)).toContain("99");
    expect(visualFacts).toHaveBeenCalledTimes(1);

    // A fact that cites a passage hydrates with a source marker for it (the reader attaches `cites`).
    const passage = randomUUID();
    const cited = facts.map((f) => ({
      ...f,
      cites: [{ documentId: ref.documentId, passageId: passage, label: "Report, Page 2" }],
    }));
    const [c] = await views.hydrateExperience(
      exp,
      [load("fact-0")],
      { visualFacts: vi.fn(async () => cited as never) } as unknown as UiReaders,
      "u",
      "document",
    );
    expect(c).toMatchObject({
      state: "ready",
      value: { refs: [{ id: `${ref.documentId}:${passage}`, label: "Report, Page 2" }] },
    });

    // Without the owner's clearance the same experience is refused: the fact handles are classified (R27).
    const noClearance = await views.hydrateExperience(exp, [load("fact-0")], readers, "u");
    expect(noClearance[0]?.state).toBe("error");
    expect(visualFacts).toHaveBeenCalledTimes(1); // never invoked
    // The table equals what the capabilities declare.
    expect(declaredToolClassesFrom(capabilitiesOf(facts as never))).toEqual(
      OWNER_READ.declaredToolClasses,
    );
    // For the owner nothing is redacted.
    expect(p.fingerprint.restrictedHandles).toEqual([]);
    expect(p.inventory.handles.map((h) => h.handle)).toEqual(
      expect.arrayContaining(["fact-0", "fact-1"]),
    );
  });

  it("serves the static detail, under the same hash, when the head's nodes do not compile", async () => {
    const facts = [fact(0, "Revenue", 4242)];
    const model = scriptedPlannerModel([
      JSON.stringify({ summary: "One", nodes: [node("rev", "Revenue", 0)] }),
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
    // An invalid prop on the planned node (a span the layout does not allow) makes the compile fail.
    const bad = JSON.parse(JSON.stringify(head.value));
    bad.root.children[0].props = { value: { nested: "invalid" } };
    bad.root.children[0].span = 99;
    const onFinding = vi.fn();
    const views = createViews({
      placeholderKey: "k".repeat(32),
      revisionKey: "r".repeat(32),
      onFinding,
    });
    const stat = views.payload("detail", "web");
    const served = views.documentPayload(ref.documentId, bad, "web");
    const hydrated = views.documentExperience(ref.documentId, bad);
    expect(hydrated.versionHash).toBe(served.versionHash);
    expect(served.versionHash).toBe(stat.versionHash);
    expect(onFinding).toHaveBeenCalledWith("unbound", expect.any(String));
  });
});
