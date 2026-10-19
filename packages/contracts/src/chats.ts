import { z } from "zod";
import { Cursor, IsoDateTime, Uuid } from "./common";

/** `"all"` searches every document; otherwise only the listed ones. */
export const ChatScope = z.union([
  z.literal("all"),
  z.object({ documentIds: z.array(Uuid).min(1).max(100) }),
]);
export type ChatScope = z.infer<typeof ChatScope>;

/** Where a passage sits in its document. Extra fields per `kind` are defined with the parsers (M3). */
export const CitationLocator = z
  .object({ kind: z.enum(["chars", "heading", "page", "paragraphs", "region"]) })
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
  id: z.string().min(1),
  title: z.string(),
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

export const ChatMessageDto = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  citations: z.array(Citation),
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

/** `POST /api/chats/:id/messages`. The reply arrives on the SSE stream. */
export const SendMessageRequest = z.object({ text: z.string().trim().min(1).max(8000) });
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;

/** `PATCH /api/chats/:id`: rename, change scope, or both. */
export const PatchChatRequest = z
  .object({ title: z.string().trim().min(1).max(200).optional(), scope: ChatScope.optional() })
  .refine((v) => v.title !== undefined || v.scope !== undefined, {
    message: "provide a title, a scope, or both",
  });
export type PatchChatRequest = z.infer<typeof PatchChatRequest>;
