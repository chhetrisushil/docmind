import type { Planner } from "@loom-ui/planner";
import { flow$, step$ } from "@loom/core";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";
import { FAILURE_CODES } from "../ingest-document/errors";
import { LLM_RETRY, STEP_RETRY, StepResult } from "../ingest-document/stepEffect";
import { ExtractResult } from "./extract";
import { dropUnfittingOps, logDropped } from "./fit";
import type { VisualizeRef } from "./pgFacts";
import { LoadOutput, planVisuals, plannerUnavailable } from "./plan";

/** Ids only, strict: the same shape as the ingest start. The execution id is `visualizeExecutionId(...)` (start.ts). */
export const VisualizeInput = z
  .object({ tenantId: z.string().uuid(), userId: z.string().uuid(), documentId: z.string().uuid() })
  .strict();

/** The flow's result: an outcome and a fixed code. Never content. */
export const VisualizeOutput = z
  .object({
    outcome: z.enum(["done", "empty", "skipped", "failed", "document_gone"]),
    code: z
      .enum([...FAILURE_CODES, "visuals-plan-invalid", "visuals-model-unavailable"])
      .optional(),
  })
  .strict();
export type VisualizeOutput = z.infer<typeof VisualizeOutput>;

// A step id doubles as its tool id; `security.ts` grants exactly these and `deps.ts` registers their effects.
// Retries are declared metadata (part of the flow's identity); `stepEffect` applies them.
export const visualizeExtractStep = step$({
  id: "visualize-extract",
  name: "VisualizeExtract",
  inputSchema: VisualizeInput,
  outputSchema: ExtractResult,
  retry: LLM_RETRY, // it calls the visuals model
});

export const visualizeLoadStep = step$({
  id: "visualize-load",
  name: "VisualizeLoad",
  inputSchema: VisualizeInput,
  outputSchema: LoadOutput,
  retry: STEP_RETRY,
});

// The commit step's input is the plan (ops, summary, report). Its schema is loose: the plan was validated by the
// planner and the effect (commit.ts `CommitInput`) holds the shape. STEP_STARTED seals `input.ops|summary|report`.
const CommitStepInput = VisualizeInput.extend({
  ops: z.array(z.unknown()),
  summary: z.string().optional(),
  summaryClass: z.string().optional(),
  report: z.unknown(),
});
export const visualizeCommitStep = step$({
  id: "visualize-commit",
  name: "VisualizeCommit",
  inputSchema: CommitStepInput,
  outputSchema: StepResult,
  retry: STEP_RETRY,
});

export const VISUALIZE_STEPS = [visualizeExtractStep, visualizeLoadStep, visualizeCommitStep];

/**
 * extract (model, facts stored sealed) -> load (the facts, for the decision; skipped when there are none) -> one planner
 * decision (over the facts and the live connections) -> commit
 * (the plan to the document's lineage). `planner` is read after the load step, so a role that went off in
 * between ends the run as `skipped`. A failure here never reaches the document's ingest status.
 */
export const runVisualize =
  (planner: () => Planner | undefined): FlowRunner<VisualizeRef, VisualizeOutput> =>
  async (ctx, input) => {
    const extracted = await ctx.run(visualizeExtractStep, input);
    if (extracted.outcome !== "done")
      return { outcome: extracted.outcome, ...(extracted.code && { code: extracted.code }) };
    if (extracted.model === "none") return { outcome: "skipped" };
    // No facts (the model found none, or refused and the stored facts were cleared): there is nothing to load, but the
    // connections are live data, so the planner still runs, offered only the connections capability.
    let facts: LoadOutput["facts"] = [];
    if (extracted.count !== 0) {
      const loaded = await ctx.run(visualizeLoadStep, input);
      if (loaded.outcome !== "done") return { outcome: loaded.outcome };
      facts = loaded.facts;
    }
    const p = planner();
    if (!p) return { outcome: "skipped" };
    const plan = await planVisuals(p, facts, ctx);
    if (plannerUnavailable(plan)) return { outcome: "failed", code: "visuals-model-unavailable" };
    // With no facts, a plan the planner could not make (it refuses an empty plan) is just nothing to show.
    if (
      extracted.count === 0 &&
      (plan.ops.length === 0 || plan.findings.some((f) => f.severity === "error"))
    ) {
      // Codes only, never text: a broken connections binding must not hide behind a quiet `empty`.
      const codes = plan.findings.filter((f) => f.severity === "error").map((f) => f.code);
      if (codes.length > 0) console.warn("visualize connections-only plan failed", codes);
      return { outcome: "empty" };
    }
    if (plan.findings.some((f) => f.severity === "error"))
      return { outcome: "failed", code: "visuals-plan-invalid" };
    // Facts that do not fit their widget would only hydrate as error placeholders: commit the ones that fit.
    const byOrdinal = new Map(facts.map((f) => [f.ordinal, f]));
    const fitted = dropUnfittingOps(plan.ops, (ref) =>
      ref.kind === "detail" ? byOrdinal.get(ref.ordinal) : undefined,
    );
    logDropped("visualize", fitted.dropped);
    if (fitted.ops.length === 0) return { outcome: "empty" };
    const committed = await ctx.run(visualizeCommitStep, {
      ...input,
      ops: fitted.ops,
      report: plan.report,
      ...(plan.summary && { summary: plan.summary, summaryClass: plan.summaryClass }),
    });
    return committed.outcome === "done" ? { outcome: "done" } : { outcome: committed.outcome };
  };

/** The flow, with the planner of this app. Flows are static modules, but the planner holds a secret and a model: per app. */
export const visualizeDocumentFlow = (
  planner: () => Planner | undefined = () => undefined,
): RegisteredFlow => ({
  definition: flow$({
    id: "visualize-document",
    name: "VisualizeDocument",
    version: "1.0.0",
    inputSchema: VisualizeInput,
    outputSchema: VisualizeOutput,
    steps: VISUALIZE_STEPS,
  }),
  runner: runVisualize(planner) as FlowRunner<unknown, unknown>,
});
