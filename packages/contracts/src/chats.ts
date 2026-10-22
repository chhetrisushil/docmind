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

/** What kind of reasoning this is: a `summary` is never presented as the full chain of thought; `redacted` carries no text (loom-ui `ChatReasoningKind`). */
export const ChatReasoningKind = z.enum(["text", "summary", "redacted"]);
export type ChatReasoningKind = z.infer<typeof ChatReasoningKind>;

/**
 * A reply's reasoning as history shows it: the recorded attempts' texts folded into one (Loom ADR 0133, loom-ui
 * `chatReasoningFromDurable`). Absent `status` means the text was read and its digest checked. Model output derived
 * from untrusted input: text only.
 */
export const ChatReasoningDto = z.object({
  text: z.string().max(40_000),
  kind: ChatReasoningKind,
  status: z.enum(["erased", "digest-mismatch"]).optional(),
  truncated: z.literal(true).optional(),
});
export type ChatReasoningDto = z.infer<typeof ChatReasoningDto>;

/** Why a turn failed: Loom's fixed, user-safe TurnResult reasons (any other becomes `model-error`). Never a provider message or status. */
export const ChatFailureReason = z.enum([
  "rate-limited",
  "quota",
  "tool-error",
  "denied",
  "model-error",
  "turn-failed",
  "cancelled",
]);
export type ChatFailureReason = z.infer<typeof ChatFailureReason>;

export const ChatMessageDto = z.object({
  /** The conversation record's ordinal, in decimal (the record's own `ord`). The history cursor and the SSE `id:` are `cursor`. */
  id: z.string().regex(/^(0|[1-9][0-9]{0,14})$/),
  /** The turn number (1-based, global to the chat); 0 for a rejected user message, which has no turn. */
  turn: z.number().int().nonnegative(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  status: ChatMessageStatus,
  citations: z.array(Citation),
  /** Loom's history cursor of this record, `<generation>.<sequence>`: the SSE `id:` of its `message` frame and what `GET /api/chats/:id/reasoning?cursor=` takes. */
  cursor: Cursor,
  /** The model's reasoning for an assistant turn, or `null` (none kept, or a user message). */
  reasoning: ChatReasoningDto.nullable(),
  steps: z.array(ChatToolStep),
  outcome: ChatOutcome.nullable(),
  /** Only on a failed assistant message (also in its SSE `message` frame). */
  failureReason: ChatFailureReason.optional(),
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

/** `GET /api/chats/:id/reasoning?cursor=<a reply's cursor>`. */
export const ReasoningQuery = z.object({ cursor: Cursor });
export type ReasoningQuery = z.infer<typeof ReasoningQuery>;

const ReasoningPartDto = z.object({
  kind: ChatReasoningKind,
  /** `redacted`: the vendor withheld it; `erased`: removed on purpose; `digest-mismatch`: the stored text no longer matches its record. */
  status: z.enum(["ok", "redacted", "erased", "digest-mismatch"]),
  text: z.string().optional(),
});
const ReasoningAttemptDto = z.object({
  attempt: z.number().int().nonnegative(),
  provider: z.string(),
  model: z.string().optional(),
  recorded: z.boolean(),
  parts: z.array(ReasoningPartDto),
});

/** Loom's `/reasoning` body, unchanged: loom-ui folds it. Superseded attempts are kept; `recorded` marks the one the step used. */
export const ReasoningResponse = z.object({
  steps: z.array(
    z.object({
      stepId: z.string(),
      recordedAttempt: z.number().int().nonnegative().optional(),
      attempts: z.array(ReasoningAttemptDto),
    }),
  ),
  truncated: z.literal(true).optional(),
});
export type ReasoningResponse = z.infer<typeof ReasoningResponse>;

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
 * What `GET /api/chats/:id/stream` sends, for the web client. On the wire the SSE `event:` is `kind` and `data:` is
 * the rest of the object as JSON: for `message` that is the `ChatMessageDto` itself (its fields sit beside `kind`, not
 * under a `message` key). `message` is durable (its SSE id is the message's `cursor`); the others are live and carry
 * no id. Parse a frame as `ChatStreamEvent.parse({ kind: <event>, ...JSON.parse(<data>) })`.
 *
 * `reasoning`, `reasoning-partial` and `reset` are loom-ui's `ChatFeed` events exactly (`{turn, text}`, `{turn}`):
 * `turn` is the hub's accepted-turn number, the same one as `answer` and `ChatMessageDto.turn`. `tool` and
 * `tool-reset` come from DocMind's `ChatBus`, which numbers by the turn key (`turnKey`, what the side table uses);
 * the two numbers are not convertible from a live event, so each frame keeps the name of the one it carries.
 */
export const ChatStreamEvent = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("status"),
    state: z.string().min(1),
    running: z.boolean(),
    turns: Count,
  }),
  ChatMessageDto.extend({ kind: z.literal("message") }),
  z.object({ kind: z.literal("reasoning"), turn: z.number().int().min(1), text: z.string() }),
  z.object({
    kind: z.literal("reasoning-partial"),
    turn: z.number().int().min(1),
    text: z.string(),
  }),
  z.object({ kind: z.literal("tool"), turnKey: Count, step: ChatToolStep }),
  z.object({ kind: z.literal("tool-reset"), turnKey: Count }),
  z.object({ kind: z.literal("answer"), turn: Count, text: z.string() }),
  z.object({ kind: z.literal("reset"), turn: Count }),
  z.object({ kind: z.literal("closed") }),
  z.object({
    kind: z.literal("error"),
    code: z.enum(["invalid_cursor", "not_found", "too_many_streams", "internal"]),
  }),
]);
export type ChatStreamEvent = z.infer<typeof ChatStreamEvent>;
