import type { Planner } from "@loom-ui/planner";
import { flow$, step$ } from "@loom/core";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";
import { StepResult } from "../ingest-document/stepEffect";
import type { TurnRef } from "./ids";
import { TURN_RETRY, TurnFactsInput, TurnFactsOutput, TurnInput, TurnLoadOutput } from "./model";
import { planTurn } from "./plan";

/** The flow's result: one word. Never content. */
export const TurnOutput = z.object({ outcome: z.enum(["visualized", "nothing"]) }).strict();
export type TurnOutput = z.infer<typeof TurnOutput>;

// A step id doubles as its tool id; `security.ts` grants exactly these and `deps.ts` registers their effects.
// Retries are declared metadata (part of the flow's identity); `stepEffect` applies them.
export const turnLoadStep = step$({
  id: "turn-load",
  name: "TurnLoad",
  inputSchema: TurnInput,
  outputSchema: TurnLoadOutput,
  retry: TURN_RETRY,
});
export const turnExtractStep = step$({
  id: "turn-extract",
  name: "TurnExtract",
  inputSchema: TurnInput,
  outputSchema: StepResult,
  retry: TURN_RETRY,
});
export const turnFactsStep = step$({
  id: "turn-facts",
  name: "TurnFacts",
  inputSchema: TurnFactsInput,
  outputSchema: TurnFactsOutput,
  retry: TURN_RETRY,
});

// The commit step's input is the plan (ops, summary, report): loose here, the effect (commit.ts `TurnCommitInput`) holds
// the shape. STEP_STARTED seals `input.ops|summary|report`.
const CommitStepInput = TurnInput.extend({
  outcome: z.enum(["visualized", "nothing"]),
  ops: z.array(z.unknown()),
  summary: z.string().optional(),
  summaryClass: z.string().optional(),
  report: z.unknown().optional(),
});
export const turnCommitStep = step$({
  id: "turn-commit",
  name: "TurnCommit",
  inputSchema: CommitStepInput,
  outputSchema: StepResult,
  retry: TURN_RETRY,
});

export const TURN_STEPS = [turnLoadStep, turnExtractStep, turnFactsStep, turnCommitStep];

/**
 * load (stored facts that cover the citations; references only) -> extract (only when none: the turn's own chunks) ->
 * facts (the kept facts' content, sealed) -> one planner decision -> commit (the plan to the turn's lineage, then a
 * `visuals` frame). Everything that is not "visualized" ends as "nothing" (C7), and goes through the commit step too, which
 * publishes the `nothing` frame (spec section 5: every run that ends nothing announces it, so an on-demand click resolves);
 * only exhausted step retries fail the run.
 */
export const runVisualizeTurn =
  (planner: () => Planner | undefined): FlowRunner<TurnRef, TurnOutput> =>
  async (ctx, input) => {
    const nothing = async (): Promise<TurnOutput> => {
      await ctx.run(turnCommitStep, { ...input, outcome: "nothing", ops: [] });
      return { outcome: "nothing" };
    };
    const loaded = await ctx.run(turnLoadStep, input);
    if (loaded.outcome !== "done" || !loaded.cited) return nothing(); // not a visualizable turn (uncited, not complete, gone)
    if (loaded.refs.length === 0) {
      const extracted = await ctx.run(turnExtractStep, input);
      if (
        extracted.outcome !== "done" ||
        extracted.model === "none" ||
        (extracted.count ?? 0) === 0
      )
        return nothing();
    }
    const read = await ctx.run(turnFactsStep, { ...input, refs: loaded.refs });
    if (read.outcome !== "done" || read.facts.length === 0) return nothing();
    const p = planner();
    if (!p) return nothing();
    const plan = await planTurn(
      p,
      read.facts.map(({ fact, origin }) => ({ fact, origin })),
      ctx,
    );
    if (plan.findings.some((f) => f.severity === "error") || plan.ops.length === 0)
      return nothing();
    const committed = await ctx.run(turnCommitStep, {
      ...input,
      outcome: "visualized",
      ops: [...plan.ops],
      report: plan.report,
      ...(plan.summary && { summary: plan.summary, summaryClass: plan.summaryClass }),
    });
    return committed.outcome === "done" ? { outcome: "visualized" } : { outcome: "nothing" };
  };

/** The flow, with the planner of this app (a secret and a model: per app, as `visualizeDocumentFlow`). */
export const visualizeTurnFlow = (
  planner: () => Planner | undefined = () => undefined,
): RegisteredFlow => ({
  definition: flow$({
    id: "visualize-turn",
    name: "VisualizeTurn",
    version: "1.0.0",
    inputSchema: TurnInput,
    outputSchema: TurnOutput,
    steps: TURN_STEPS,
  }),
  runner: runVisualizeTurn(planner) as FlowRunner<unknown, unknown>,
});
