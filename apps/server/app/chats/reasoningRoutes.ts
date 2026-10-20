import { ReasoningQuery } from "@docmind/contracts";
import { ConversationNotFoundError, InvalidCursorError } from "@loom/conversation";
import { requireAuth } from "../http/requireAuth";
import { type Handler, json, sendError } from "../http/respond";
import { loadChat, notFound, principalOf } from "./access";
import { chatConversationId } from "./ids";
import { reasoningBody } from "./reasoningRead";
import type { ChatRouteDeps } from "./routes";

export const REASONING_ROUTE = "GET /api/chats/:id/reasoning";

/**
 * The model's reasoning of one reply, durable (ADR 0133 D6; the shape of Loom's own endpoint, so loom-ui's
 * `ChatFeed({ reasoning: { durable: true } })` can fetch it). Two owner checks: the chat row (`user_id = identity`,
 * not deleted) and Loom's `reasoningTarget`, which in owner mode serves the owner alone and answers every other
 * case (unknown cursor, a user message, someone else) with the same not-found. Any other failure is the server's
 * generic 500: no message of it reaches the client.
 */
export function chatReasoningRoutes(deps: ChatRouteDeps): Record<string, Handler> {
  return {
    [REASONING_ROUTE]: requireAuth(deps.authenticator, async (req, res, identity, ctx) => {
      const chat = await loadChat(deps, identity, ctx);
      if (!chat) return notFound(res);
      const url = new URL(req.url ?? "/", "http://localhost");
      const query = ReasoningQuery.safeParse(Object.fromEntries(url.searchParams));
      if (!query.success) return sendError(res, 400, "invalid_request", "invalid query");
      try {
        const body = await reasoningBody(
          {
            conversations: deps.chat.conversations,
            log: deps.eventStore,
            store: deps.chat.reasoning,
          },
          { tenantId: identity.tenantId, userId: identity.userId, chatId: chat.id },
          chatConversationId(identity.userId, chat.id),
          query.data.cursor,
          { principal: principalOf(identity) },
        );
        json(res, 200, body);
      } catch (err) {
        if (err instanceof InvalidCursorError)
          return sendError(res, 400, "invalid_cursor", "cursor is not valid");
        if (err instanceof ConversationNotFoundError) return notFound(res);
        throw err;
      }
    }),
  };
}
