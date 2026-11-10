import type { TurnSettledEvent } from "@loom/conversation";
import { chatIdOfConversation } from "../../chats/ids";
import { opaqueIds } from "../../opaqueIds";
import type { TurnRef } from "./ids";
import type { TurnRead } from "./readTurn";

export const MAX_WAITING = 20;

export interface TriggerDeps {
  /** True while the `visuals` role is on. */
  enabled(): boolean;
  /** The tenant of a live chat, or null (unknown, soft-deleted, owner being erased): `docmind_chat_tenant(chat_id, user_id)` (the user comes from the conversation id). */
  tenantOf(userId: string, chatId: string): Promise<string | null>;
  turn: { read(ref: TurnRef, signal?: AbortSignal): Promise<TurnRead | null> };
  /** Visuals executions (document and turn) waiting on the shared gate. */
  backlog(): number;
  maxWaiting: number;
}

/**
 * The trigger filter (spec section 4): the turn to visualize, or null. Cheap checks first, so a failed or role-off turn
 * costs no query: complete, role on, a chat's conversation, backlog under the cap; then the chat is live and the answer
 * cites at least one document that is still the user's.
 */
export async function turnToVisualize(
  e: TurnSettledEvent,
  d: TriggerDeps,
): Promise<TurnRef | null> {
  if (e.status !== "complete" || !d.enabled()) return null;
  // A new-format conversation id hides its user and chat: fill the key cache for it first (this is an async entry point).
  const handle = opaqueIds.handleOf(e.conversationId);
  if (handle !== null) await opaqueIds.ensure(handle);
  const ids = chatIdOfConversation(e.conversationId);
  if (!ids || d.backlog() >= d.maxWaiting) return null;
  const tenantId = await d.tenantOf(ids.userId, ids.chatId);
  if (!tenantId) return null;
  const ref: TurnRef = { tenantId, userId: ids.userId, chatId: ids.chatId, ord: e.ord };
  const turn = await d.turn.read(ref);
  return turn && turn.status === "complete" && turn.citations.length > 0 ? ref : null;
}
