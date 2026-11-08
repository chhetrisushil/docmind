import { ORD_PATTERN, RecordOrd } from "@docmind/contracts";
import { UUID_PATTERN } from "../../chats/ids";
import { type UserExecutionId, executionIdFor } from "../../subject";

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
 * `visualize-turn-<chatId>-<ord>`: the one automatic pass of a turn (Loom starts a caller-chosen id once, so it is also
 * the idempotency key). `rerun` makes `-r<n>`, an on-demand run. Ids only.
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
  return executionIdFor(
    userId,
    `visualize-turn-${chatId.toLowerCase()}-${ord}${rerun === undefined ? "" : `-r${rerun}`}`,
  );
}

/**
 * The lineage line of a turn's visuals. Ids only: stored in plaintext, and it survives erasure (subject.ts parses it
 * back to the owner, so the shape is part of the erasure contract).
 */
export const turnExperienceId = (r: { userId: string; chatId: string; ord: number }): string => {
  checkUuid("userId", r.userId);
  checkUuid("chatId", r.chatId);
  checkOrd(r.ord);
  return `turnvisuals-${r.userId}-${r.chatId}-${r.ord}`;
};

const TURN_EXECUTION = new RegExp(
  `^u_(${UUID_PATTERN}):visualize-turn-(${UUID_PATTERN})-(${ORD_PATTERN})(?:-r([1-9][0-9]{0,2}))?$`,
);
export function parseTurnExecution(
  id: string,
): { userId: string; chatId: string; ord: number; rerun?: number } | null {
  const m = TURN_EXECUTION.exec(id);
  if (!m) return null;
  return {
    userId: m[1] as string,
    chatId: m[2] as string,
    ord: Number(m[3]),
    ...(m[4] !== undefined && { rerun: Number(m[4]) }),
  };
}
export const isTurnVisualizeExecution = (id: string): boolean => TURN_EXECUTION.test(id);
