import type { Operation } from "@loom-ui/core";
import { LineErasedError, LineUnreadableError, type Lineage } from "@loom-ui/lineage";
import type { PlanReport, PlanResult } from "@loom-ui/planner";
import type { Effect } from "@loom/effect-runtime";
import type { ProgressBus } from "../../documents/progress";
import { DocumentGoneError, VisualsLineageError } from "../ingest-document/errors";
import {
  type StepGuard,
  StepResult,
  type StepSeams,
  ingestStepOptions,
  stepEffectOf,
} from "../ingest-document/stepEffect";
import { LineageRefusedError, commitPlan } from "./lineage";
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
 * After a commit (an idempotent no-write one too) it tells the owner's open browsers the visuals are ready; a bus that
 * fails is reported (class only) and never fails the step.
 */
export function commitEffect(
  deps: { guard: StepGuard; lineage: Lineage; now: () => string; bus: ProgressBus } & StepSeams,
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
        // Neither is transient: a refusal repeats, and an unreadable line (key not on this node, not a confirmed erasure) fails closed.
        if (err instanceof LineageRefusedError || err instanceof LineUnreadableError)
          throw new VisualsLineageError();
        throw err;
      }
      try {
        deps.bus.publish(
          { userId: input.userId },
          { documentId: input.documentId, status: "ready", step: "finalize", visuals: "ready" },
        );
      } catch (err) {
        console.error(
          "visuals ready event not published",
          err instanceof Error ? err.constructor.name : typeof err,
        );
      }
      return { count: input.ops.length };
    },
    { schema: StepResult, ended: (end) => end },
    ingestStepOptions(deps),
  ) as unknown as Effect<CommitInput, StepResult>;
}
