import type { IncomingMessage, ServerResponse } from "node:http";
import type { Identity } from "@docmind/auth";
import {
  ConversationNotFoundError,
  InvalidCursorError,
  followConversation,
  parseCursor,
} from "@loom/conversation";
import { SseSink, frame } from "@loom/plugin-conversation-sse";
import { type Schedule, intervalSchedule } from "../documents/events";
import { requireAuth } from "../http/requireAuth";
import { type Handler, sendError } from "../http/respond";
import { loadChat, notFound, principalOf } from "./access";
import { chatConversationId } from "./ids";
import { toMessageDtos } from "./messages";
import type { ChatRouteDeps } from "./routes";

/** The route key of the open-ended chat stream; the server exempts it from the request timer. */
export const CHAT_STREAM_ROUTE = "GET /api/chats/:id/stream";

/** Open chat streams the whole process allows (each also counts against its user's cap). */
export const MAX_CHAT_STREAMS_GLOBAL = 1000;

export interface ChatStreamDeps
  extends Pick<
    ChatRouteDeps,
    "pool" | "authenticator" | "fields" | "chat" | "eventStore" | "reasoning"
  > {
  maxStreamsPerUser?: number;
  maxStreams?: number;
  heartbeatMs?: number;
  /** Bytes a slow client may leave unread before it is cut off (it reconnects with Last-Event-ID). */
  maxPendingBytes?: number;
  pollMs?: number;
  schedule?: Schedule;
  /** Called after a stream has released its slot (tests await it). */
  onStreamEnd?: () => void;
}

const errorCodeOf = (err: unknown): "invalid_cursor" | "not_found" | "internal" => {
  if (err instanceof InvalidCursorError) return "invalid_cursor";
  if (err instanceof ConversationNotFoundError) return "not_found";
  console.error("chat stream failed", err instanceof Error ? err.constructor.name : typeof err);
  return "internal";
};

/** The resume point: `Last-Event-ID` (what EventSource sends on its own) or `?cursor=`. */
function resumeOf(req: IncomingMessage): string | undefined {
  const header = req.headers["last-event-id"];
  if (typeof header === "string" && header !== "") return header;
  return new URL(req.url ?? "/", "http://localhost").searchParams.get("cursor") ?? undefined;
}

/**
 * `GET /api/chats/:id/stream` (D7). The chat is loaded for its owner first (404 for anything else), Loom then
 * authorizes the read, and only then are the cursor and the limits looked at. Open streams are counted per user and in
 * total; the slot is released exactly once on every exit path (client close, error, backpressure, completion, closeAll).
 */
export function chatStreamRoutes(deps: ChatStreamDeps): {
  routes: Record<string, Handler>;
  closeAll(): void;
} {
  const maxPerUser = deps.maxStreamsPerUser ?? 4;
  const maxGlobal = deps.maxStreams ?? MAX_CHAT_STREAMS_GLOBAL;
  const schedule = deps.schedule ?? intervalSchedule;
  const open = new Map<string, number>();
  const live = new Map<ServerResponse, () => void>(); // each stream's `end`, for closeAll
  let closing = false;

  const routes: Record<string, Handler> = {
    [CHAT_STREAM_ROUTE]: requireAuth(deps.authenticator, async (req, res, identity, ctx) => {
      const chat = await loadChat(deps, identity, ctx);
      if (!chat) return notFound(res);
      const conversationId = chatConversationId(identity.userId, chat.id);
      const principal = principalOf(identity);
      let status: Awaited<ReturnType<ChatRouteDeps["chat"]["conversations"]["status"]>>;
      try {
        await deps.chat.conversations.authorizeRead(conversationId, { principal });
        status = await deps.chat.conversations.status(conversationId, { principal });
      } catch (err) {
        if (err instanceof ConversationNotFoundError) return notFound(res);
        throw err;
      }
      const cursor = resumeOf(req);
      if (cursor !== undefined && parseCursor(cursor) === undefined)
        return sendError(res, 400, "invalid_cursor", "cursor is not valid");
      // After closeAll: 200 and end at once (a non-200 would stop EventSource for good; a 200 makes it reconnect to the next process).
      if (closing) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        res.end("retry: 5000\n\n");
        return;
      }
      const count = open.get(identity.userId) ?? 0;
      if (count >= maxPerUser || live.size >= maxGlobal)
        return sendError(res, 429, "too_many_streams", "too many open chat streams");
      // The client left while Loom authorized: its close has fired already, so no slot is taken.
      if (res.destroyed || res.writableEnded) return;
      // Check and increment in one synchronous block, so two concurrent opens cannot both pass.
      open.set(identity.userId, count + 1);
      stream(deps, {
        req,
        res,
        identity,
        chatId: chat.id,
        conversationId,
        cursor,
        status,
        open,
        live,
        schedule,
      });
    }),
  };
  return {
    routes,
    /** Ends every open stream and frees its slot, so `server.close()` can finish. */
    closeAll() {
      closing = true;
      for (const end of [...live.values()]) end();
    },
  };
}

interface StreamCall {
  req: IncomingMessage;
  res: ServerResponse;
  identity: Identity;
  chatId: string;
  conversationId: string;
  cursor: string | undefined;
  status: { state: string; running: boolean; turns: number };
  open: Map<string, number>;
  live: Map<ServerResponse, () => void>;
  schedule: Schedule;
}

function stream(deps: ChatStreamDeps, c: StreamCall): void {
  const { res, identity, conversationId, chatId } = c;
  const ac = new AbortController();
  let ended = false;
  let released = false;
  const cleanups: (() => void)[] = [];
  const release = () => {
    if (released) return;
    released = true;
    c.live.delete(res);
    const left = (c.open.get(identity.userId) ?? 1) - 1;
    if (left <= 0) c.open.delete(identity.userId);
    else c.open.set(identity.userId, left);
    deps.onStreamEnd?.();
  };
  const sink = new SseSink(res, deps.maxPendingBytes ?? 1024 * 1024, () => end(true));
  function end(destroy: boolean): void {
    if (ended) return;
    ended = true;
    ac.abort();
    for (const off of cleanups.splice(0)) off();
    sink.close();
    try {
      if (destroy) res.destroy();
      else res.end();
    } catch {
      // the socket is already gone
    }
    release();
  }
  c.live.set(res, () => end(false));
  res.once("close", () => end(true));
  res.once("error", () => end(true));

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
  });
  sink.send("retry: 3000\n\n");
  sink.send(
    frame("status", { state: c.status.state, running: c.status.running, turns: c.status.turns }),
  );

  // Task 152b attaches the live listeners here, synchronously after the status frame.
  attachLive(deps, c, sink, cleanups);

  void (async () => {
    try {
      for await (const item of followConversation(
        { reader: deps.chat.reader, eventStore: deps.eventStore },
        conversationId,
        {
          ...(c.cursor !== undefined && { cursor: c.cursor }),
          signal: ac.signal,
          ...(deps.pollMs !== undefined && { pollMs: deps.pollMs }),
        },
      )) {
        if (item.type === "closed") {
          sink.send(frame("closed", {}));
          break;
        }
        const [message] = await toMessageDtos(deps, identity, chatId, [item.entry]);
        if (message) sink.send(frame("message", message, item.entry.cursor));
      }
    } catch (err) {
      if (!ended) sink.send(frame("error", { code: errorCodeOf(err) }));
    } finally {
      end(false);
    }
  })();
}

/** 152a: no live kinds yet. */
function attachLive(
  _deps: ChatStreamDeps,
  _c: StreamCall,
  _sink: SseSink,
  _cleanups: (() => void)[],
): void {}
