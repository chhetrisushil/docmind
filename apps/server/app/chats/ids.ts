import { isValidConversationId } from "@loom/conversation";

/** The canonical lower-case UUID source (8-4-4-4-12), defined once; subject.ts and the chat ids share it. */
export const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CANONICAL = new RegExp(`^${UUID_PATTERN}$`);
// Loom's generations are `<id>~<n>` with n >= 1 (generation 0 has no suffix).
const CHAT_CONVERSATION = new RegExp(
  `^u_(${UUID_PATTERN})\\.c-(${UUID_PATTERN})(?:~[1-9][0-9]{0,8})?$`,
);

export const CHAT_FLOW_ID = "doc-chat";
export const CHAT_GK_FLOW_ID = "doc-chat-gk";
export const CHAT_TITLE_FLOW_ID = "chat-title";
export const CHAT_MODEL_TOOL_ID = "chat-model";
export const CHAT_TOOL_IDS = [
  "search_docs",
  "related",
  "read_section",
  "get_summary",
  "list_documents",
] as const;
/** Every effect id a chat conversation may invoke: the grant list of both chat flows. */
export const CHAT_EFFECT_IDS: readonly string[] = [CHAT_MODEL_TOOL_ID, ...CHAT_TOOL_IDS];

export const isChatFlowId = (id: string): boolean => id === CHAT_FLOW_ID || id === CHAT_GK_FLOW_ID;

declare const chatConversation: unique symbol;
/**
 * A conversation id built by `chatConversationId`. A plain string is not assignable to it, and the
 * ratchet in startRatchet.test.ts refuses any `Conversations.start` that does not build its id here.
 */
export type ChatConversationId = string & { readonly [chatConversation]: true };

/**
 * The Loom conversation id of a chat: `u_<user>.c-<chat>`. Loom ids may not contain a colon, so the
 * `u_<uuid>:` form of `executionIdFor` is not available; `subjectOfExecution` reads this form too, so
 * every event of the chat (its generations `~n`, its inbox) is sealed under the owner's key.
 * Both ids are canonical lower-case UUIDs, so the id is 77 characters and carries no content.
 */
export function chatConversationId(userId: string, chatId: string): ChatConversationId {
  if (!CANONICAL.test(userId) || !CANONICAL.test(chatId)) {
    throw new RangeError(
      "userId and chatId must be canonical lowercase UUIDs (8-4-4-4-12 hex digits)",
    );
  }
  const id = `u_${userId}.c-${chatId}`;
  if (!isValidConversationId(id)) throw new RangeError("not a valid Loom conversation id");
  return id as ChatConversationId;
}

/** The user and chat of a conversation or generation id, or null when it is neither. */
export function chatIdOfConversation(id: string): { userId: string; chatId: string } | null {
  const m = CHAT_CONVERSATION.exec(id);
  return m ? { userId: m[1] as string, chatId: m[2] as string } : null;
}

const CHAT_TITLE_EXECUTION = new RegExp(`^u_${UUID_PATTERN}:chat-title-${UUID_PATTERN}$`);

/** The execution of a chat's auto title: `executionIdFor(userId, "chat-title-<chatId>")` (D14). */
export const isChatTitleExecution = (id: string): boolean => CHAT_TITLE_EXECUTION.test(id);

/** Every chat execution boot recovery may re-drive: a conversation (any generation) or a title flow (ruling P5). */
export const isRecoverableChatExecution = (id: string): boolean =>
  chatIdOfConversation(id) !== null || isChatTitleExecution(id);
