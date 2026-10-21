import type { IncomingMessage, ServerResponse } from "node:http";
import type { Identity } from "@docmind/auth";
import {
  ConversationNotFoundError,
  InvalidCursorError,
  type LiveEvent,
  SubscriberLimitError,
  followConversation,
  parseCursor,
} from "@loom/conversation";
import { SseSink, frame } from "@loom/plugin-conversation-sse";
import { withTenant } from "../db/tenant";
import { type Schedule, intervalSchedule } from "../documents/events";
import { requireAuth } from "../http/requireAuth";
import { type Handler, sendError } from "../http/respond";
import { loadChat, notFound, principalOf } from "./access";
import { ChatBusLimitError, type LiveChatEvent } from "./bus";
import { chatConversationId } from "./ids";
import { toMessageDtos } from "./messages";
import type { ChatRouteDeps } from "./routes";
import { getChat } from "./sessions";

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

const MAX_BATCH = 500;

/**
 * Groups an async sequence into the runs that arrive without waiting for I/O. `followConversation` yields every
 * entry of one read back to back (no await between them), and the next read needs the database or the event store,
 * which takes a later turn of the event loop; so the items that are ready before the next macrotask are one read's
 * page. Order is preserved and nothing is dropped; the grouping only decides how many items share one batch.
 */
async function* batches<T>(source: AsyncGenerator<T>): AsyncGenerator<T[]> {
  const TICK = Symbol("tick");
  let pending: Promise<IteratorResult<T>> | undefined;
  try {
    for (;;) {
      const first = await (pending ?? source.next());
      pending = undefined;
      if (first.done) return;
      const batch: T[] = [first.value];
      let finished = false;
      while (batch.length < MAX_BATCH) {
        const next = source.next();
        const raced = await Promise.race([
          next,
          new Promise<typeof TICK>((resolve) => setImmediate(() => resolve(TICK))),
        ]);
        if (raced === TICK) {
          pending = next;
          break;
        }
        if (raced.done) {
          finished = true;
          break;
        }
        batch.push(raced.value);
      }
      yield batch;
      if (finished) return;
    }
  } finally {
    // A read still in flight is abandoned with the stream: its failure must not surface as unhandled.
    // Not awaited: a return queues behind that read, which only ends when the stream's own abort wakes it.
    pending?.catch(() => undefined);
    source.return(undefined).catch(() => undefined);
  }
}

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
  closeUser(userId: string): void;
} {
  const maxPerUser = deps.maxStreamsPerUser ?? 4;
  const maxGlobal = deps.maxStreams ?? MAX_CHAT_STREAMS_GLOBAL;
  const schedule = deps.schedule ?? intervalSchedule;
  const open = new Map<string, number>();
  const live = new Map<ServerResponse, { userId: string; end: () => void }>(); // each stream's owner and `end`, for closeAll and closeUser
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
      for (const { end } of [...live.values()]) end();
    },
    /**
     * Ends every open chat stream of one user (account erasure). Unlike `closeAll` it is not a shutdown. A stream
     * that was still authorizing is caught by its own heartbeat, which re-checks the session and the chat.
     */
    closeUser(userId: string) {
      for (const entry of [...live.values()]) if (entry.userId === userId) entry.end();
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
  live: Map<ServerResponse, { userId: string; end: () => void }>;
  schedule: Schedule;
}

/** True while the request still authenticates as the stream's user and that user's chat is live. */
async function stillAllowed(deps: ChatStreamDeps, c: StreamCall): Promise<boolean> {
  const who = await deps.authenticator.authenticate(c.req);
  if (!who || who.userId !== c.identity.userId || who.tenantId !== c.identity.tenantId)
    return false;
  const row = await withTenant(deps.pool, who.tenantId, (tx) => getChat(tx, who.userId, c.chatId));
  return row !== null;
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
  c.live.set(res, { userId: identity.userId, end: () => end(false) });
  res.once("close", () => end(true));
  res.on("error", () => end(true));

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
  // The heartbeat also re-checks the session and the chat: a stream outlives its login otherwise.
  let checking = false;
  const tick = () => {
    sink.send(": ping\n\n");
    if (checking || ended) return;
    checking = true;
    stillAllowed(deps, c)
      .then((ok) => ok || end(false))
      .catch(() => end(false)) // fail closed; the client reconnects and is authenticated again
      .finally(() => {
        checking = false;
      });
  };
  cleanups.push(c.schedule(tick, deps.heartbeatMs ?? 15_000));
  attachLive(deps, c, sink, cleanups);

  void (async () => {
    try {
      const follow = followConversation(
        { reader: deps.chat.reader, eventStore: deps.eventStore },
        conversationId,
        {
          ...(c.cursor !== undefined && { cursor: c.cursor }),
          signal: ac.signal,
          ...(deps.pollMs !== undefined && { pollMs: deps.pollMs }),
        },
      );
      // One toMessageDtos per batch (the entries one read of Loom's reader produced), so a replay reads each
      // generation's log, the turn items and the titles once per batch, not once per message.
      for await (const batch of batches(follow)) {
        const entries = batch.flatMap((item) => (item.type === "message" ? [item.entry] : []));
        if (entries.length > 0) {
          for (const message of await toMessageDtos(deps, identity, chatId, entries))
            sink.send(frame("message", message, message.cursor));
        }
        if (batch.some((item) => item.type === "closed")) {
          sink.send(frame("closed", {}));
          break;
        }
      }
    } catch (err) {
      if (!ended) sink.send(frame("error", { code: errorCodeOf(err) }));
    } finally {
      end(false);
    }
  })();
}

/**
 * Subscribes to the hub (answer and reasoning deltas, resets) and the bus (tool steps, tool resets), then sends what
 * a turn that is already running has produced. The subscriptions come first, so nothing published in between is
 * lost, and the whole function is synchronous: it runs in the same tick as the status frame.
 */
function attachLive(
  deps: ChatStreamDeps,
  c: StreamCall,
  sink: SseSink,
  cleanups: (() => void)[],
): void {
  const answer = (turn: number, text: string) => frame("answer", { turn, text });
  const reasoning = (turn: number, text: string) => frame("reasoning", { turn, text });
  const onHub = (e: LiveEvent) => {
    if (e.type === "reset") return void sink.send(frame("reset", { turn: e.turn }));
    // Reasoning is its own coalescing channel, so a burst of it never delays or merges into the answer's frames.
    if (e.type === "reasoning") return void sink.delta(e.turn, e.text, reasoning, "reasoning");
    sink.delta(e.turn, e.text, answer);
  };
  // Bus events carry the turn key; hub events the accepted-turn number. Each keeps its own name.
  const onBus = (e: LiveChatEvent) => {
    if (e.kind === "reset") return void sink.send(frame("tool-reset", { turnKey: e.turnKey }));
    sink.send(frame("tool", { turnKey: e.turnKey, step: e.step }));
  };
  try {
    cleanups.push(deps.chat.hub.subscribe(c.conversationId, onHub));
    cleanups.push(deps.chat.bus.subscribe(c.chatId, onBus));
  } catch (err) {
    if (!(err instanceof SubscriberLimitError || err instanceof ChatBusLimitError)) throw err;
    sink.send(frame("error", { code: "too_many_streams" }));
    return;
  }
  // The stream is the chat owner's alone (the route loaded the chat row with user_id = identity), which is the
  // audience Loom's own SSE gives reasoning in owner mode.
  const thought = deps.chat.hub.reasoningPartialOf(c.conversationId);
  if (thought) sink.send(frame("reasoning-partial", { turn: thought.turn, text: thought.text }));
  const text = deps.chat.hub.partialOf(c.conversationId);
  if (text) sink.send(frame("answer", { turn: text.turn, text: text.text }));
}
