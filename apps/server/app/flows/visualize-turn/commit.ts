import type { Operation } from "@loom-ui/core";
import type { Lineage } from "@loom-ui/lineage";
import type { PlanReport, PlanResult } from "@loom-ui/planner";
import type { Effect } from "@loom/effect-runtime";
import type { ChatBus } from "../../chats/bus";
import { VisualsLineageError } from "../ingest-document/errors";
import {
  type StepGuard,
  StepResult,
  type StepSeams,
  ingestStepOptions,
  stepEffectOf,
} from "../ingest-document/stepEffect";
import { committing } from "../visualize-document/commit";
import { commitPlanTo } from "../visualize-document/lineage";
import { type TurnRef, turnExperienceId } from "./ids";
import { TURN_RETRY } from "./model";
import { TURN_INTENT } from "./plan";

/**
 * The commit step's input: the plan the planner decided. User content (labels, bindings, the model's summary), so
 * `STEP_STARTED.input.ops`, `input.summary` and `input.report` are sealed in S/sensitive.ts (already registered).
 */
export type TurnCommitInput = TurnRef & {
  outcome: "visualized" | "nothing";
  ops: Operation[];
  summary?: string;
  summaryClass?: PlanResult["summaryClass"];
  report?: PlanReport;
};

/**
 * "visualized": replaces the head of the turn's line (sealed under the user's key; R18: a sealed, idempotent commit; an identical head is returned with
 * nothing written). "nothing": writes nothing. Either way it then publishes `visuals` on the chat's bus (idempotent commit or
 * not): every run that ends `nothing` announces it too (spec section 5). A bus that fails is logged by class and never fails
 * the step. A line whose owner was erased is "gone"; a refusal or an unreadable line is the visuals lineage error (not transient).
 */
export function turnCommitEffect(
  deps: {
    guard: StepGuard<TurnRef>;
    lineage: Lineage;
    now: () => string;
    bus: Pick<ChatBus, "publish">;
  } & StepSeams,
): Effect<TurnCommitInput, StepResult> {
  return stepEffectOf<StepResult, TurnCommitInput>(
    "turn-commit",
    deps.guard,
    async (input) => {
      if (input.outcome === "visualized") {
        const { report } = input;
        if (!report) throw new VisualsLineageError(); // the flow always sends it; without one there is nothing to commit
        const target = {
          experienceId: turnExperienceId(input),
          intent: TURN_INTENT,
          sourceKind: "turn-visuals",
        };
        await committing(() => commitPlanTo(deps.lineage, target, { ...input, report }, deps.now));
      }
      try {
        deps.bus.publish(input.chatId, {
          kind: "visuals",
          ord: input.ord,
          outcome: input.outcome,
        });
      } catch (err) {
        console.error(
          "turn visuals event not published",
          err instanceof Error ? err.constructor.name : typeof err,
        );
      }
      return { count: input.ops.length };
    },
    { schema: StepResult, ended: (end) => end },
    ingestStepOptions(deps, TURN_RETRY),
  );
}
