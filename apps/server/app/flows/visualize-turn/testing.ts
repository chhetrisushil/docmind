import type { PlanResult } from "@loom-ui/planner";
import { scriptedFigurePlan } from "../visualize-document/testing";
import { planTurn } from "./plan";

/** A real `PlanResult` (one KeyFigure `nodeId`, labelled `label`, binding an extracted turn fact), made by the reference planner on a scripted model. */
export const aTurnPlan = (
  nodeId: string,
  label: string,
  summary = "A headline figure",
): Promise<PlanResult> =>
  scriptedFigurePlan(nodeId, label, summary, (planner, fact, ctx) =>
    planTurn(planner, [{ fact, origin: { kind: "turn" } }], ctx),
  );
