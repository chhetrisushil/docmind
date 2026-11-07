import type { Operation } from "@loom-ui/core";
import { LineErasedError, type Lineage } from "@loom-ui/lineage";
import type { PlanReport, PlanResult } from "@loom-ui/planner";
import type { Effect } from "@loom/effect-runtime";
import { DocumentGoneError } from "../ingest-document/errors";
import {
  type StepGuard,
  StepResult,
  type StepSeams,
  ingestStepOptions,
  stepEffectOf,
} from "../ingest-document/stepEffect";
import { commitPlan } from "./lineage";
import type { VisualizeRef } from "./pgFacts";

/**
 * The commit step's input: the plan the plan step decided. User content (labels, bindings, the model's summary), so
 * `STEP_STARTED.input.ops`, `input.summary` and `input.report` are sealed in S/sensitive.ts.
 */
export type CommitInput = VisualizeRef & {
  ops: Operation[];
  summary?: string;
  summaryClass?: PlanResult["summaryClass"];
  report: PlanReport;
};

/**
 * Commits the plan to the document's lineage line (sealed under the user's key). The output is a content-free
 * `StepResult` (the number of ops committed). A line whose owner was erased is `document_gone`.
 * It publishes nothing: the "visuals ready" event is the runner's (a later task), so these deps carry no bus.
 */
export function commitEffect(
  deps: { guard: StepGuard; lineage: Lineage; now: () => string } & StepSeams,
): Effect<CommitInput, StepResult> {
  return stepEffectOf(
    "visualize-commit",
    deps.guard,
    async (ref) => {
      const input = ref as CommitInput;
      try {
        await commitPlan(deps.lineage, input, input, deps.now);
      } catch (err) {
        if (err instanceof LineErasedError) throw new DocumentGoneError();
        throw err;
      }
      return { count: input.ops.length };
    },
    { schema: StepResult, ended: (end) => end },
    ingestStepOptions(deps),
  ) as unknown as Effect<CommitInput, StepResult>;
}
