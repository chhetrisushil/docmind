import { type OfferedFact, factCapabilities } from "@docmind/experiences";
import type { Intent } from "@loom-ui/core";
import type { DecideContext, PlanResult, Planner } from "@loom-ui/planner";
import { composeVisuals } from "../visualize-document/plan";

export const TURN_INTENT: Intent = {
  objective:
    "Illustrate this answer for its reader. Choose nothing if no visual adds understanding.",
  source: "application",
  sensitivity: "sensitive",
};

/**
 * One `ctx.decide` (the planner's own, keyed by DOCMIND_PLANNER_DECISION_KEY; R19: keyed decision ids): the model's plan over the turn's
 * facts, recorded and replayable. The intent holds no answer text; fact values reach the model only as fenced data.
 */
export const planTurn = (
  planner: Planner,
  offered: readonly OfferedFact[],
  ctx: DecideContext,
): Promise<PlanResult> => composeVisuals(planner, TURN_INTENT, factCapabilities(offered), ctx);
