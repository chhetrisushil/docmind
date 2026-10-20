import { z } from "zod";
import { Cursor, IsoDateTime, Uuid } from "./common";

/** `"all"` searches every document; otherwise only the listed ones. */
export const ChatScope = z.union([
  z.literal("all"),
  z.object({ documentIds: z.array(Uuid).min(1).max(100) }),
]);
export type ChatScope = z.infer<typeof ChatScope>;

/**
 * Where a passage sits in its document. The kinds are the chunk locator kinds (`Locator` in
 * documents.ts), so a stored chunk locator is a valid citation locator as it is. Extra fields per
 * `kind` are kept (`passthrough`).
 */
export const CitationLocator = z
  .object({ kind: z.enum(["chars", "section", "page", "paragraphs", "region"]) })
  .passthrough();
export type CitationLocator = z.infer<typeof CitationLocator>;

export const Citation = z.object({
  passageId: z.string().min(1),
  documentId: Uuid,
  docTitle: z.string(),
  locator: CitationLocator,
  snippet: z.string(),
});
export type Citation = z.infer<typeof Citation>;

/** `POST /api/chats`. */
export const CreateChatRequest = z.object({ scope: ChatScope.default("all") });
export type CreateChatRequest = z.infer<typeof CreateChatRequest>;

export const ChatSessionDto = z.object({
  id: Uuid,
  /** `null` until a title is set (auto or by the user); the UI shows "New chat". */
  title: z.string().nullable(),
  scope: ChatScope,
  createdAt: IsoDateTime,
  lastMessageAt: IsoDateTime.nullable(),
  messageCount: z.number().int().nonnegative(),
});
export type ChatSessionDto = z.infer<typeof ChatSessionDto>;

/** `GET /api/chats?cursor&q`: `q` filters by title. */
export const ListChatsQuery = z.object({
  cursor: Cursor.optional(),
  q: z.string().trim().max(200).optional(),
});
export type ListChatsQuery = z.infer<typeof ListChatsQuery>;

export const ListChatsResponse = z.object({
  items: z.array(ChatSessionDto),
  nextCursor: Cursor.nullable(),
});
export type ListChatsResponse = z.infer<typeof ListChatsResponse>;

/** One tool step the agent took in a turn, shown as "Searched documents ...". The label is content. */
export const ChatToolStep = z.object({
  name: z.enum(["search_docs", "related", "read_section", "get_summary", "list_documents"]),
  label: z.string().max(300),
  count: z.number().int().nonnegative(),
});
export type ChatToolStep = z.infer<typeof ChatToolStep>;

export const ChatMessageStatus = z.enum(["complete", "interrupted", "failed", "rejected"]);
export type ChatMessageStatus = z.infer<typeof ChatMessageStatus>;

/** Why an assistant turn ended other than by answering. */
export const ChatOutcome = z.enum(["refusal", "max_tokens", "max_iterations"]);
export type ChatOutcome = z.infer<typeof ChatOutcome>;

export const ChatMessageDto = z.object({
  /** The conversation record's ordinal, in decimal: the history cursor and the stream event id. */
  id: z.string().regex(/^(0|[1-9][0-9]{0,14})$/),
  /** The turn number (1-based, global to the chat); 0 for a rejected user message, which has no turn. */
  turn: z.number().int().nonnegative(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  status: ChatMessageStatus,
  citations: z.array(Citation),
  /** The summarized thinking of an assistant turn, or `null`. */
  thinking: z.string().nullable(),
  steps: z.array(ChatToolStep),
  outcome: ChatOutcome.nullable(),
  createdAt: IsoDateTime,
});
export type ChatMessageDto = z.infer<typeof ChatMessageDto>;

/** `GET /api/chats/:id/messages?cursor`. */
export const ListMessagesQuery = z.object({ cursor: Cursor.optional() });
export type ListMessagesQuery = z.infer<typeof ListMessagesQuery>;

export const ListMessagesResponse = z.object({
  items: z.array(ChatMessageDto),
  nextCursor: Cursor.nullable(),
});
export type ListMessagesResponse = z.infer<typeof ListMessagesResponse>;

/**
 * `POST /api/chats/:id/messages`. The reply arrives on the SSE stream. `messageId` makes a retry of
 * the same send idempotent; `editOf` is the ordinal (at least 1) of an earlier user message this one replaces.
 */
export const SendMessageRequest = z.object({
  text: z.string().trim().min(1).max(8000),
  messageId: Uuid.optional(),
  editOf: z.number().int().min(1).optional(),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;

/** The id the user's message was recorded under (the client's `messageId`, or one the server made). */
export const SendMessageResponse = z.object({ messageId: z.string().min(1) });
export type SendMessageResponse = z.infer<typeof SendMessageResponse>;

/** `POST /api/chats/:id/stop`: whether a turn was running. */
export const StopChatResponse = z.object({ stopped: z.boolean() });
export type StopChatResponse = z.infer<typeof StopChatResponse>;

/** `PATCH /api/chats/:id`: rename, change scope, or both. */
export const PatchChatRequest = z
  .object({ title: z.string().trim().min(1).max(200).optional(), scope: ChatScope.optional() })
  .refine((v) => v.title !== undefined || v.scope !== undefined, {
    message: "provide a title, a scope, or both",
  });
export type PatchChatRequest = z.infer<typeof PatchChatRequest>;

const Count = z.number().int().nonnegative();

/**
 * What `GET /api/chats/:id/stream` sends, for the web client. On the wire the SSE `event:` is `kind`
 * and `data:` is the rest of the object as JSON. `message` is durable (its SSE id is the message id);
 * the others are live and carry no id.
 *
 * Two turn numbers exist and a live event carries exactly the one it came with: `turn` is the hub's
 * accepted-turn number (`answer`, and `reset` from the hub); `turnKey` is the bus's turn key
 * (`thinking`, `tool`, and `reset` from the bus). They are not convertible from a live event alone.
 */
export const ChatStreamEvent = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("status"),
    state: z.string().min(1),
    running: z.boolean(),
    turns: Count,
  }),
  z.object({ kind: z.literal("message"), message: ChatMessageDto }),
  z.object({ kind: z.literal("thinking"), turnKey: Count, text: z.string() }),
  z.object({ kind: z.literal("tool"), turnKey: Count, step: ChatToolStep }),
  z.object({ kind: z.literal("answer"), turn: Count, text: z.string() }),
  z.object({ kind: z.literal("reset"), turn: Count.optional(), turnKey: Count.optional() }),
  z.object({ kind: z.literal("closed") }),
  z.object({
    kind: z.literal("error"),
    code: z.enum(["invalid_cursor", "not_found", "too_many_streams", "internal"]),
  }),
]);
export type ChatStreamEvent = z.infer<typeof ChatStreamEvent>;
