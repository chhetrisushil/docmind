import type { ServerResponse } from "node:http";
import { ListMessagesQuery, SendMessageRequest } from "@docmind/contracts";
import type { ListMessagesResponse, SendMessageResponse } from "@docmind/contracts";
import {
  ConversationNotFoundError,
  InvalidCursorError,
  InvalidTurnError,
  QueueFullError,
  SubscriberLimitError,
} from "@loom/conversation";
import { InboxClosedError, InboxFullError } from "@loom/workflow-runtime";
import { readJson } from "../http/body";
import { requireAuth } from "../http/requireAuth";
import { type Handler, json, sendError } from "../http/respond";
import { loadChat, notFound, principalOf, unavailable } from "./access";
import { chatConversationId } from "./ids";
import { HISTORY_PAGE, readHistoryPage, toMessageDtos } from "./messages";
import type { ChatRouteDeps } from "./routes";

/** 8,000 characters are at most 32,000 bytes of UTF-8 plus the JSON around them (H10). */
export const SEND_MAX_BYTES = 40 * 1024;

/** Loom's refusals as HTTP answers. Fixed text: an error's own message can carry the conversation id. */
function sendFailure(res: ServerResponse, err: unknown): void {
  if (err instanceof ConversationNotFoundError) notFound(res);
  else if (err instanceof InvalidTurnError)
    sendError(res, 400, "invalid_turn", "the message cannot be sent");
  else if (err instanceof InboxClosedError)
    sendError(res, 409, "chat_closed", "the chat is closed");
  else if (
    err instanceof InboxFullError ||
    err instanceof QueueFullError ||
    err instanceof SubscriberLimitError
  ) {
    res.setHeader("retry-after", "1");
    sendError(res, 429, "too_many_requests", "too many messages are waiting; try again shortly");
  } else throw err;
}

/** History and send. */
export function chatMessageRoutes(deps: ChatRouteDeps): Record<string, Handler> {
  return {
    "GET /api/chats/:id/messages": requireAuth(
      deps.authenticator,
      async (req, res, identity, ctx) => {
        const chat = await loadChat(deps, identity, ctx);
        if (!chat) return notFound(res);
        const url = new URL(req.url ?? "/", "http://localhost");
        const query = ListMessagesQuery.safeParse(Object.fromEntries(url.searchParams));
        if (!query.success) return sendError(res, 400, "invalid_request", "invalid query");
        try {
          const page = await readHistoryPage(
            deps.chat.conversations,
            chatConversationId(identity.userId, chat.id),
            principalOf(identity),
            query.data.cursor,
            HISTORY_PAGE,
          );
          json(res, 200, {
            items: await toMessageDtos(deps, identity, chat.id, page.entries),
            nextCursor: page.nextCursor,
          } satisfies ListMessagesResponse);
        } catch (err) {
          if (err instanceof InvalidCursorError)
            return sendError(res, 400, "invalid_cursor", "cursor is not valid");
          if (err instanceof ConversationNotFoundError) return notFound(res);
          throw err;
        }
      },
    ),

    // A message sent while a turn is running interrupts it (Loom's barge-in): the partial reply is recorded as interrupted.
    "POST /api/chats/:id/messages": requireAuth(
      deps.authenticator,
      async (req, res, identity, ctx) => {
        if (!deps.chat.available) {
          req.resume(); // the body is not read: let the socket move on
          return unavailable(res);
        }
        const chat = await loadChat(deps, identity, ctx);
        if (!chat) return notFound(res);
        const body = await readJson(req, res, SendMessageRequest, { maxBytes: SEND_MAX_BYTES });
        if (!body) return;
        let sent: { messageId: string };
        try {
          sent = await deps.chat.conversations.sendTurn(
            chatConversationId(identity.userId, chat.id),
            body.text,
            {
              principal: principalOf(identity),
              ...(body.messageId !== undefined && { messageId: body.messageId }),
              ...(body.editOf !== undefined && { editOf: body.editOf }),
            },
          );
        } catch (err) {
          sendFailure(res, err);
          return;
        }
        // Auto title (D14, ruling P5): once per chat, started by an accepted message while the chat is untitled. The
        // starter swallows Loom's start-once rejection; whatever else it does, the message is already accepted.
        if (chat.title_source === "none") {
          try {
            deps.titles?.fire({
              tenantId: identity.tenantId,
              userId: identity.userId,
              chatId: chat.id,
            });
          } catch (err) {
            console.error(
              "chat title start failed",
              err instanceof Error ? err.constructor.name : typeof err,
            );
          }
        }
        json(res, 202, { messageId: sent.messageId } satisfies SendMessageResponse);
      },
    ),
  };
}
