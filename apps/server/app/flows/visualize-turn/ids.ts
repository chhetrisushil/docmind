import type { RecordOrd } from "@docmind/contracts";
import { opaqueIds } from "../../opaqueIds";

/** What a visualize-turn run is about: ids only. `ord` is the assistant record's ordinal (`ChatMessageDto.id`). */
export interface TurnRef {
  tenantId: string;
  userId: string;
  chatId: string;
  ord: RecordOrd;
}

export const TURN_FLOW_ID = "visualize-turn";

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
