import { randomUUID } from "node:crypto";
import type { Authenticator, Identity } from "@docmind/auth";
import {
  type ChatSessionDto,
  CreateChatRequest,
  ListChatsQuery,
  type ListChatsResponse,
} from "@docmind/contracts";
import type { EventStore } from "@loom/event-runtime";
import type { Pool } from "pg";
import type { FieldCrypto } from "../crypto/fields";
import { withTenant } from "../db/tenant";
import { decodeCursor, encodeCursor } from "../documents/cursor";
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
import { chatMessageRoutes } from "./messageRoutes";
import type { ReplyReasoning } from "./reasoningRead";
import { chatReasoningRoutes } from "./reasoningRoutes";
import { insertChat, listChats, softDeleteChat } from "./sessions";
import type { ChatRef } from "./turnItems";
import type { ChatWiring } from "./wiring";

/** Starts a chat's auto title (the `chat-title` flow, Task 154): start-once, never throws. */
export interface ChatTitleTrigger {
  fire(ref: ChatRef): void;
}

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
  /** Called by the send route for an untitled chat after a message was accepted. Absent without a title model. */
  titles?: ChatTitleTrigger;
}

export const PAGE = 50;
/** `q` filters after decryption: the server scans the owner's live chats in batches, at most SCAN_MAX in one request. */
export const SCAN_BATCH = 200;
export const SCAN_MAX = 2000;

/**
 * One page of the caller's chats, newest activity first. Without `q` it is one query. With `q` it pages through the
 * owner's chats, decrypts each title and keeps the matches until a page is full or the scan cap is reached; the cursor
 * then continues the scan, so a rare match is found by following `nextCursor` (an empty page with a cursor is not the end).
 */
export async function listChatsPage(
  deps: Pick<ChatRouteDeps, "pool" | "fields">,
  identity: Identity,
  start: { t: string; i: string } | null,
  q: string | undefined,
): Promise<{ items: ChatSessionDto[]; next: string | null }> {
  const cipher = deps.fields.forUser(identity.userId);
  const needle = q?.toLowerCase();
  const size = needle === undefined ? PAGE + 1 : SCAN_BATCH;
  const items: ChatSessionDto[] = [];
  const cursors: string[] = []; // the cursor of each kept item
  let after = start;
  let scanned = 0;
  let lastScanned: string | null = null;
  let exhausted = false;
  while (!exhausted && scanned < SCAN_MAX) {
    const rows = await withTenant(deps.pool, identity.tenantId, (tx) =>
      listChats(tx, identity.userId, { ...(after && { cursor: after }), limit: size }),
    );
    exhausted = rows.length < size;
    for (const row of rows) {
      scanned++;
      const dto = await toChatDto(row, cipher, row);
      lastScanned = encodeCursor({ created_cursor: row.sort_cursor, id: row.id });
      if (needle !== undefined && !(dto.title ?? "").toLowerCase().includes(needle)) continue;
      if (items.length === PAGE) {
        // A 51st match: there is more, and the next page starts after the 50th.
        return { items, next: cursors[PAGE - 1] ?? null };
      }
      items.push(dto);
      cursors.push(lastScanned);
    }
    const last = rows.at(-1);
    if (last) after = { t: last.sort_cursor, i: last.id };
  }
  return { items, next: exhausted ? null : lastScanned };
}

/** The chat API. Every route takes tenant and user from the session and loads the chat with `user_id = identity.userId`. */
export function chatRoutes(deps: ChatRouteDeps): Record<string, Handler> {
  const core: Record<string, Handler> = {
    "GET /api/chats": requireAuth(deps.authenticator, async (req, res, identity) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const query = ListChatsQuery.safeParse(Object.fromEntries(url.searchParams));
      if (!query.success) return sendError(res, 400, "invalid_request", "invalid query");
      let cursor: { t: string; i: string } | null = null;
      if (query.data.cursor !== undefined) {
        cursor = decodeCursor(query.data.cursor);
        if (!cursor) return sendError(res, 400, "invalid_cursor", "cursor is not valid");
      }
      const page = await listChatsPage(
        deps,
        identity,
        cursor,
        query.data.q === "" ? undefined : query.data.q,
      );
      json(res, 200, { items: page.items, nextCursor: page.next } satisfies ListChatsResponse);
    }),

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
        ).catch((rollbackErr) =>
          console.error(
            "chat create rollback failed",
            rollbackErr instanceof Error ? rollbackErr.constructor.name : typeof rollbackErr,
          ),
        );
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
  return { ...core, ...chatMessageRoutes(deps), ...chatReasoningRoutes(deps) };
}
