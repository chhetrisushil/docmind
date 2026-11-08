import { randomUUID } from "node:crypto";
import { ReferencePlanner } from "@loom-ui/planner";
import type { DecideContext, PlanResult, PlannerModel } from "@loom-ui/planner";
import type { Fact } from "./facts";
import { planVisuals } from "./plan";

/** A planner model that replies with `replies` in order, repeating the last, and counts its calls. */
export function scriptedPlannerModel(replies: string[]) {
  const model = {
    calls: 0,
    async complete() {
      const content = replies[Math.min(model.calls, replies.length - 1)] as string;
      model.calls += 1;
      return { content };
    },
  };
  return model satisfies PlannerModel;
}

/** A recording decide context: a repeated decision id is served from `decisions`, with no decider call. */
export function recording() {
  const decisions = new Map<string, unknown>();
  const ctx: DecideContext & { decisions: Map<string, unknown> } = {
    decisions,
    async decide(id, decider) {
      if (decisions.has(id)) return decisions.get(id) as never;
      const value = await decider({
        invokeTransient: () => Promise.reject(new Error("no scope in this stub")),
      });
      decisions.set(id, JSON.parse(JSON.stringify(value)));
      return value;
    },
  };
  return ctx;
}

/** A real `PlanResult` with one KeyFigure `nodeId` binding `fact-0`, made by the reference planner on a scripted model; `run` composes it (document or turn flavour). */
export async function scriptedFigurePlan(
  nodeId: string,
  label: string,
  summary: string,
  run: (
    planner: ReferencePlanner,
    fact: Fact,
    ctx: ReturnType<typeof recording>,
  ) => Promise<PlanResult>,
): Promise<PlanResult> {
  const fact: Fact = {
    kind: "figure",
    label,
    value: 4242,
    unit: "USD",
    chunkIds: [randomUUID()],
    ordinal: 0,
  };
  const node = {
    id: nodeId,
    type: "KeyFigure",
    label,
    span: 4,
    props: {},
    binding: { capability: "fact-0", arguments: {}, path: "value", priority: "P0" },
  };
  const model = scriptedPlannerModel([JSON.stringify({ summary, nodes: [node] })]);
  return run(new ReferencePlanner({ model, modelId: "test" }), fact, recording());
}

/** A real `PlanResult` (one KeyFigure tile `nodeId`, labelled `label`, binding one fact), made by the reference planner on a scripted model. */
export const aPlan = (
  nodeId: string,
  label: string,
  summary = "A headline figure",
): Promise<PlanResult> =>
  scriptedFigurePlan(nodeId, label, summary, (planner, fact, ctx) =>
    planVisuals(planner, [fact], ctx),
  );

/** A node's children (the experience root is a container; its static type is the wider ExperienceNode). */
export const childrenOf = (root: unknown) =>
  (root as { children: readonly { id: string }[] }).children;
