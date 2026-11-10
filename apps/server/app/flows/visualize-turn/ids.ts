import { RecordOrd } from "@docmind/contracts";
import { UUID_PATTERN, type UserExecutionId, legacyIds, opaqueIds } from "../../opaqueIds";

/** What a visualize-turn run is about: ids only. `ord` is the assistant record's ordinal (`ChatMessageDto.id`). */
export interface TurnRef {
  tenantId: string;
  userId: string;
  chatId: string;
  ord: RecordOrd;
}

export const TURN_FLOW_ID = "visualize-turn";
const CANONICAL_UUID = new RegExp(`^${UUID_PATTERN}$`);
const MAX_RERUN = 999;

const checkOrd = (ord: number) => {
  if (!RecordOrd.safeParse(ord).success)
    throw new RangeError("ord must be an integer from 1 to 999999999999999");
};
const checkUuid = (what: string, id: string) => {
  if (!CANONICAL_UUID.test(id)) throw new RangeError(`${what} must be a canonical lower-case uuid`);
};

/**
 * The execution of a turn's one automatic pass (Loom starts a caller-chosen id once, so it is also the idempotency key); `rerun` makes
 * `-r<n>`, an on-demand run. PHASE 2 switches this to `UserIds.turnVisualize` (`h_<H>:visualize-turn-<C>-<ord>[-rN]`); until then it is the
 * old format. Ids only.
 */
export function turnExecutionId(
  userId: string,
  chatId: string,
  ord: number,
  rerun?: number,
): UserExecutionId {
  checkOrd(ord);
  if (rerun !== undefined && (!Number.isSafeInteger(rerun) || rerun < 1 || rerun > MAX_RERUN))
    throw new RangeError("rerun must be an integer from 1 to 999");
  return legacyIds.turnVisualize(userId, chatId.toLowerCase(), ord, rerun);
}

/**
 * The lineage line of a turn's visuals. PHASE 2 switches this to `UserIds.turnLineage` (`turnvisuals-<H>-<C>-<ord>`); until then it is the old
 * format. Ids only: stored in plaintext, and it survives erasure (the subject mapping parses it back to the owner).
 */
export const turnExperienceId = (r: { userId: string; chatId: string; ord: number }): string => {
  checkUuid("userId", r.userId);
  checkUuid("chatId", r.chatId);
  checkOrd(r.ord);
  return legacyIds.turnLineage(r.userId, r.chatId, r.ord);
};

/** What a turn-visualize execution id names, in either format; null for any other id (or a new-format id whose user is not cached). */
export function parseTurnExecution(
  id: string,
): { userId: string; chatId: string; ord: number; rerun?: number } | null {
  const p = opaqueIds.parse(id);
  if (p?.family !== "turnVisualize") return null;
  return {
    userId: p.userId,
    chatId: p.chatId as string,
    ord: p.ord as number,
    ...(p.rerun !== undefined && { rerun: p.rerun }),
  };
}
/** A turn-visualize execution of either format, from its shape alone (no key). */
export const isTurnVisualizeExecution = (id: string): boolean =>
  opaqueIds.family(id) === "turnVisualize";
