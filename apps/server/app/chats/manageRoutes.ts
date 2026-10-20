import type { StopChatResponse } from "@docmind/contracts";
import { PatchChatRequest } from "@docmind/contracts";
import { ConversationNotFoundError } from "@loom/conversation";
import { InboxClosedError } from "@loom/workflow-runtime";
import { withTenant } from "../db/tenant";
import { readJson } from "../http/body";
import { requireAuth } from "../http/requireAuth";
import { type Handler, json, sendError } from "../http/respond";
import { loadChat, normalizeScope, notFound, principalOf, scopeIsOwned } from "./access";
import { chatActivityOf } from "./activityRead";
import { toChatDto } from "./dto";
import { chatConversationId } from "./ids";
import type { ChatRouteDeps } from "./routes";
import { chatTitleBind, getChat, setScope, setTitle, softDeleteChat } from "./sessions";

/** Rename, scope, delete and stop. None of them needs a Claude key. */
export function chatManageRoutes(deps: ChatRouteDeps): Record<string, Handler> {
  return {
    "PATCH /api/chats/:id": requireAuth(deps.authenticator, async (req, res, identity, ctx) => {
      const chat = await loadChat(deps, identity, ctx);
      if (!chat) {
        req.resume();
        return notFound(res);
      }
      const body = await readJson(req, res, PatchChatRequest);
      if (!body) return;
      const cipher = deps.fields.forUser(identity.userId);
      const scope = body.scope === undefined ? undefined : normalizeScope(body.scope);
      const titleEnc =
        body.title === undefined
          ? undefined
          : await cipher.seal(chatTitleBind(chat.id), body.title);
      // One transaction: a refused scope leaves the title alone, and the other way round.
      const outcome = await withTenant(deps.pool, identity.tenantId, async (tx) => {
        if (scope !== undefined && !(await scopeIsOwned(tx, identity.userId, scope)))
          return "invalid_scope" as const;
        if (
          titleEnc !== undefined &&
          !(await setTitle(tx, identity.userId, chat.id, titleEnc, "user"))
        )
          return "gone" as const;
        if (scope !== undefined && !(await setScope(tx, identity.userId, chat.id, scope)))
          return "gone" as const;
        return (await getChat(tx, identity.userId, chat.id)) ?? ("gone" as const);
      });
      if (outcome === "invalid_scope")
        return sendError(res, 400, "invalid_scope", "scope names a document that is not yours");
      if (outcome === "gone") return notFound(res);
      const activity = await withTenant(deps.pool, identity.tenantId, (tx) =>
        chatActivityOf(tx, identity.userId, chat.id),
      );
      json(res, 200, await toChatDto(outcome, cipher, activity));
    }),

    "DELETE /api/chats/:id": requireAuth(deps.authenticator, async (_req, res, identity, ctx) => {
      const chat = await loadChat(deps, identity, ctx);
      if (!chat) return notFound(res);
      const removed = await withTenant(deps.pool, identity.tenantId, (tx) =>
        softDeleteChat(tx, identity.userId, chat.id),
      );
      if (!removed) return notFound(res); // a concurrent delete won
      // The row is gone from every read now (open streams end on their next heartbeat). Failures below are
      // logged by class only and never undo the delete.
      const conversationId = chatConversationId(identity.userId, chat.id);
      try {
        deps.chat.stops.stop(conversationId);
      } catch (err) {
        console.error(
          "delete chat: stop failed",
          err instanceof Error ? err.constructor.name : typeof err,
        );
      }
      try {
        await deps.chat.conversations.close(conversationId, { principal: principalOf(identity) });
      } catch (err) {
        // Closed already or never started: nothing to do. Anything else leaves an idle conversation behind a
        // deleted row (erasure removes it); the answer is still 204.
        if (!(err instanceof ConversationNotFoundError || err instanceof InboxClosedError))
          console.error(
            "delete chat: close failed",
            err instanceof Error ? err.constructor.name : typeof err,
          );
      }
      res.writeHead(204);
      res.end();
    }),

    "POST /api/chats/:id/stop": requireAuth(
      deps.authenticator,
      async (_req, res, identity, ctx) => {
        const chat = await loadChat(deps, identity, ctx);
        if (!chat) return notFound(res);
        // True when a turn was listening. It can be true for a turn that finished an instant ago (its listener is
        // removed just after the turn ends), in which case the stop is a no-op.
        const stopped = deps.chat.stops.stop(chatConversationId(identity.userId, chat.id));
        json(res, 202, { stopped } satisfies StopChatResponse);
      },
    ),
  };
}
