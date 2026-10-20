import { randomUUID } from "node:crypto";
import type { Authenticator } from "@docmind/auth";
import { CreateChatRequest } from "@docmind/contracts";
import type { EventStore } from "@loom/event-runtime";
import type { Pool } from "pg";
import type { FieldCrypto } from "../crypto/fields";
import { withTenant } from "../db/tenant";
import { readJson } from "../http/body";
import { requireAuth } from "../http/requireAuth";
import { type Handler, json, sendError } from "../http/respond";
import {
  loadChat,
  normalizeScope,
  notFound,
  principalOf,
  scopeIsOwned,
  unavailable,
} from "./access";
import { chatActivityOf } from "./activityRead";
import { toChatDto } from "./dto";
import { chatConversationId } from "./ids";
import type { ReplyReasoning } from "./reasoningRead";
import { insertChat, softDeleteChat } from "./sessions";
import type { ChatWiring } from "./wiring";

export interface ChatRouteDeps {
  pool: Pool;
  authenticator: Authenticator;
  fields: FieldCrypto;
  /** `chat.available` is false without ANTHROPIC_API_KEY: create and send answer 503 (D12); everything else works. */
  chat: ChatWiring;
  /** The decrypting event store the stream follows (`followConversation`). */
  eventStore: EventStore;
  /** Reads a reply's reasoning (history, endpoint); the create and get routes do not use it. */
  reasoning: ReplyReasoning;
}

/** The chat API. Every route takes tenant and user from the session and loads the chat with `user_id = identity.userId`. */
export function chatRoutes(deps: ChatRouteDeps): Record<string, Handler> {
  return {
    "POST /api/chats": requireAuth(deps.authenticator, async (req, res, identity) => {
      if (!deps.chat.available) {
        req.resume(); // the body is not read: let the socket move on
        return unavailable(res);
      }
      const body = await readJson(req, res, CreateChatRequest);
      if (!body) return;
      const scope = normalizeScope(body.scope);
      const id = randomUUID();
      const row = await withTenant(deps.pool, identity.tenantId, async (tx) =>
        (await scopeIsOwned(tx, identity.userId, scope))
          ? insertChat(tx, identity.tenantId, identity.userId, id, scope)
          : null,
      );
      if (!row)
        return sendError(res, 400, "invalid_scope", "scope names a document that is not yours");
      try {
        // The only place a chat conversation starts (startRatchet.test.ts checks this exact argument).
        await deps.chat.conversations.start({
          conversationId: chatConversationId(identity.userId, id),
          principal: principalOf(identity),
        });
      } catch (err) {
        // A chat nobody can talk to must not stay in the list.
        await withTenant(deps.pool, identity.tenantId, (tx) =>
          softDeleteChat(tx, identity.userId, id),
        ).catch(() => {});
        throw err;
      }
      json(
        res,
        201,
        await toChatDto(row, deps.fields.forUser(identity.userId), { messages: 0, last_at: null }),
      );
    }),

    "GET /api/chats/:id": requireAuth(deps.authenticator, async (_req, res, identity, ctx) => {
      const row = await loadChat(deps, identity, ctx);
      if (!row) return notFound(res);
      const activity = await withTenant(deps.pool, identity.tenantId, (tx) =>
        chatActivityOf(tx, identity.userId, row.id),
      );
      json(res, 200, await toChatDto(row, deps.fields.forUser(identity.userId), activity));
    }),
  };
}
