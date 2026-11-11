import { type ChatConversationId, UUID_PATTERN, legacyIds, opaqueIds } from "../opaqueIds";

export { UUID_PATTERN };
export type { ChatConversationId };

const CANONICAL_CHAT = new RegExp(`^${UUID_PATTERN}$`);

export const CHAT_FLOW_ID = "doc-chat";
export const CHAT_GK_FLOW_ID = "doc-chat-gk";
export const CHAT_TITLE_FLOW_ID = "chat-title";
export const CHAT_MODEL_TOOL_ID = "chat-model";
/** The rolling summary of evicted turns (`@loom/conversation` `budget.summarizerToolId`, Loom's `createSummarizerEffect`). */
export const CHAT_SUMMARIZER_TOOL_ID = "chat-summarize";
export const CHAT_TOOL_IDS = [
  "search_docs",
  "related",
  "read_section",
  "get_summary",
  "list_documents",
] as const;
/** Every effect id a chat conversation may invoke: the grant list of both chat flows. */
export const CHAT_EFFECT_IDS: readonly string[] = [
  CHAT_MODEL_TOOL_ID,
  CHAT_SUMMARIZER_TOOL_ID,
  ...CHAT_TOOL_IDS,
];

export const isChatFlowId = (id: string): boolean => id === CHAT_FLOW_ID || id === CHAT_GK_FLOW_ID;

/**
 * The OLD-format Loom conversation id of a chat, `u_<user>.c-<chat>`: what every chat created before phase 2 runs under, and what
 * `ChatIds` (`chats/chatIds.ts`) builds for a chat whose `id_format` is `legacy`. Production code gets a chat's ids from the resolver, never
 * from here. Loom ids may not contain a colon, so the `u_<uuid>:` form is not available.
 */
export function legacyChatConversationId(userId: string, chatId: string): ChatConversationId {
  // The id module lower-cases a chat id it is given; this builder has always refused one that is not already canonical.
  if (!CANONICAL_CHAT.test(chatId)) {
    throw new RangeError(
      "userId and chatId must be canonical lowercase UUIDs (8-4-4-4-12 hex digits)",
    );
  }
  return legacyIds.conversation(userId, chatId);
}

/** The user and chat of a conversation or generation id of either format, or null when it is neither (or the new format's user is not cached). */
export function chatIdOfConversation(id: string): { userId: string; chatId: string } | null {
  const p = opaqueIds.parse(id);
  return p?.family === "conversation" ? { userId: p.userId, chatId: p.chatId as string } : null;
}

/** The execution of a chat's auto title (either format), from its shape alone. */
export const isChatTitleExecution = (id: string): boolean => opaqueIds.family(id) === "chatTitle";

/** A chat conversation (any generation) of either format, from its shape alone: no key, so recovery and compaction never miss on a cold cache. */
export const isChatConversation = (id: string): boolean => opaqueIds.family(id) === "conversation";

/** Every chat execution boot recovery may re-drive: a conversation (any generation) or a title flow (ruling P5). */
export const isRecoverableChatExecution = (id: string): boolean =>
  isChatConversation(id) || isChatTitleExecution(id);
