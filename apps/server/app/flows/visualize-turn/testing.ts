import { RecordOrd } from "@docmind/contracts";
import type { PlanResult } from "@loom-ui/planner";
import { UUID_PATTERN, legacyIds } from "../../opaqueIds";
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

const CANONICAL_UUID = new RegExp(`^${UUID_PATTERN}$`);
const MAX_RERUN = 999;
const checkOrd = (ord: number) => {
  if (!RecordOrd.safeParse(ord).success)
    throw new RangeError("ord must be an integer from 1 to 999999999999999");
};
const checkUuid = (what: string, id: string) => {
  if (!CANONICAL_UUID.test(id)) throw new RangeError(`${what} must be a canonical lower-case uuid`);
};

/** The old-format turn execution id, with the old builder's signature and checks: tests that seed or read a legacy chat's turn run. */
export const legacyTurnExecutionId = (
  userId: string,
  chatId: string,
  ord: number,
  rerun?: number,
) => {
  checkOrd(ord);
  if (rerun !== undefined && (!Number.isSafeInteger(rerun) || rerun < 1 || rerun > MAX_RERUN))
    throw new RangeError("rerun must be an integer from 1 to 999");
  return legacyIds.turnVisualize(userId, chatId.toLowerCase(), ord, rerun);
};
/** The old-format turn lineage id, with the old builder's strictness (canonical lower-case user and chat ids, a valid ord). */
export const legacyTurnExperienceId = (r: {
  userId: string;
  chatId: string;
  ord: number;
}): string => {
  checkUuid("userId", r.userId);
  checkUuid("chatId", r.chatId);
  checkOrd(r.ord);
  return legacyIds.turnLineage(r.userId, r.chatId, r.ord);
};
