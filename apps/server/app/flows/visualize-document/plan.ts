import { VISUALS_CATALOG, capabilitiesOf } from "@docmind/experiences";
import type { Intent } from "@loom-ui/core";
import type { DecideContext, PlanResult, Planner } from "@loom-ui/planner";
import type { Effect } from "@loom/effect-runtime";
import { z } from "zod";
import { FAILURE_CODES } from "../ingest-document/errors";
import {
  type StepGuard,
  type StepSeams,
  ingestStepOptions,
  stepEffectOf,
} from "../ingest-document/stepEffect";
import { type Fact, MAX_FACTS, StoredFact } from "./facts";
import type { VisualFactStore, VisualizeRef } from "./pgFacts";

/**
 * The load step's output, and so what its event holds: the outcome and code of a `StepResult`, plus the
 * document's facts. The facts are user content: `output.facts` is sealed in S/sensitive.ts. Empty unless done.
 */
export const LoadOutput = z
  .object({
    outcome: z.enum(["done", "document_gone", "failed"]),
    code: z.enum(FAILURE_CODES).optional(),
    facts: z.array(StoredFact).max(MAX_FACTS),
  })
  .strict();
export type LoadOutput = z.infer<typeof LoadOutput>;

export function loadEffect(
  deps: { guard: StepGuard; facts: VisualFactStore } & StepSeams,
): Effect<VisualizeRef, LoadOutput> {
  return stepEffectOf(
    "visualize-load",
    deps.guard,
    async (ref) => ({ facts: await deps.facts.list(ref) }),
    { schema: LoadOutput, ended: (end) => ({ ...end, facts: [] }) },
    ingestStepOptions(deps),
  );
}

export const VISUALS_INTENT: Intent = {
  objective:
    "Help a reader grasp this document at a glance. Show only what a visual makes clearer than prose. Prefer fewer widgets. Every widget binds one fact.",
  source: "application",
  sensitivity: "sensitive",
};

/** One `ctx.decide` (the planner's own): the model's plan over the document's facts, recorded and replayable. */
export async function planVisuals(
  planner: Planner,
  facts: readonly Fact[],
  ctx: DecideContext,
): Promise<PlanResult> {
  return planner.compose(
    {
      intent: VISUALS_INTENT,
      catalog: VISUALS_CATALOG,
      capabilities: capabilitiesOf(facts),
      containers: [],
      surface: "web",
      contextClass: "sensitive",
    },
    ctx,
  );
}
