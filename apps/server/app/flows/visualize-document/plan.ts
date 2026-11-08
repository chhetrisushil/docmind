import { VISUALS_CATALOG, visualCapabilities } from "@docmind/experiences";
import { LlmUnavailableError } from "@docmind/llm-anthropic";
import type { Intent, SemanticCatalog } from "@loom-ui/core";
import type { CapabilityRef, DecideContext, PlanResult, Planner } from "@loom-ui/planner";
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

/** One `ctx.decide` (the planner's own): the model's plan for `intent` over `capabilities` and `catalog`, recorded and replayable. */
export const composeVisuals = (
  planner: Planner,
  intent: Intent,
  capabilities: CapabilityRef[],
  catalog: SemanticCatalog,
  ctx: DecideContext,
): Promise<PlanResult> =>
  planner.compose(
    {
      intent,
      catalog,
      capabilities,
      containers: [],
      surface: "web",
      contextClass: "sensitive",
    },
    ctx,
  );

export const planVisuals = (
  planner: Planner,
  facts: readonly Fact[],
  ctx: DecideContext,
): Promise<PlanResult> =>
  composeVisuals(planner, VISUALS_INTENT, visualCapabilities(facts), VISUALS_CATALOG, ctx);

const UNAVAILABLE = `model call failed: ${new LlmUnavailableError().message.replace(/ \(HTTP \d+\)$/, "")}`;

/**
 * True when the planner gave up because its model stayed unreachable: every error finding of its last attempt is the
 * planner's own `model-error` for a transient `LlmUnavailableError` (the planner swallows a model failure into a finding
 * and retries it, so a run that ends here has exhausted its attempts), besides the `plan-failed` summary it adds. Any other
 * error finding (a malformed plan, a permanent model error) is not this.
 */
export const plannerUnavailable = (plan: Pick<PlanResult, "findings">): boolean => {
  const errors = plan.findings.filter((f) => f.severity === "error" && f.code !== "plan-failed");
  return (
    errors.length > 0 &&
    errors.every((f) => f.code === "model-error" && f.message.startsWith(UNAVAILABLE))
  );
};
