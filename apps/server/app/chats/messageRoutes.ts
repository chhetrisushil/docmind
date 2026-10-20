import { ListMessagesQuery } from "@docmind/contracts";
import type { ListMessagesResponse } from "@docmind/contracts";
import { ConversationNotFoundError, InvalidCursorError } from "@loom/conversation";
import { requireAuth } from "../http/requireAuth";
import { type Handler, json, sendError } from "../http/respond";
import { loadChat, notFound, principalOf } from "./access";
import { chatConversationId } from "./ids";
import { HISTORY_PAGE, readHistoryPage, toMessageDtos } from "./messages";
import type { ChatRouteDeps } from "./routes";

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
  };
}
