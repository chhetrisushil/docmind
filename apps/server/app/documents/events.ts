import type { ServerResponse } from "node:http";
import type { Authenticator } from "@docmind/auth";
import { requireAuth } from "../http/requireAuth";
import { type Handler, sendError } from "../http/respond";
import type { ProgressBus, ProgressScope } from "./progress";

/** Open event streams the whole process allows, over every user (each also counts against its user's cap). */
export const MAX_STREAMS_GLOBAL = 1000;

export type Schedule = (fn: () => void, ms: number) => () => void;

export const intervalSchedule: Schedule = (fn, ms) => {
  const timer = setInterval(fn, ms);
  timer.unref();
  return () => clearInterval(timer);
};

/**
 * Wires one response to the bus. Returns `stop` (idempotent): it unsubscribes, cancels the
 * heartbeat and ends the response once. A write that reports a full socket buffer means the client
 * is not reading: destroy it (EventSource reconnects and re-lists). The listener never throws into
 * the bus. `scope` comes from the caller's session, never from the request.
 */
export function openStream(
  res: ServerResponse,
  onClose: (stop: () => void) => void,
  bus: ProgressBus,
  scope: ProgressScope,
  schedule: Schedule,
  heartbeatMs: number,
): () => void {
  let seq = 0;
  let closed = false;
  let off: () => void = () => {};
  let cancelHeartbeat: () => void = () => {};

  const end = (destroy: boolean) => {
    if (closed) return;
    closed = true;
    off();
    cancelHeartbeat();
    try {
      if (destroy) res.destroy();
      else res.end();
    } catch {
      // the socket is already gone
    }
  };
  const stop = () => end(false);
  const send = (frame: string) => {
    if (closed) return;
    try {
      if (!res.write(frame)) end(true);
    } catch {
      end(true);
    }
  };

  res.once("close", () => end(true));
  res.once("error", () => end(true));
  // Events are hints: the bus already validated this one (ids only), so it is written as delivered.
  off = bus.subscribe(scope, (event) =>
    send(`id: ${++seq}\nevent: progress\ndata: ${JSON.stringify(event)}\n\n`),
  );
  // A bus that delivered synchronously during subscribe and ended the stream (a full buffer) ran
  // `end` while `off` was still the no-op: release the subscription now.
  if (closed) off();
  cancelHeartbeat = schedule(() => send(": ping\n\n"), heartbeatMs);
  if (closed) cancelHeartbeat();
  onClose(stop);
  return stop;
}

/** The route key of the open-ended progress stream; the server exempts it from the request timer. */
export const EVENTS_ROUTE = "GET /api/documents/events";

export interface EventRoutesDeps {
  authenticator: Authenticator;
  bus: ProgressBus;
  maxStreamsPerUser?: number;
  /** Process-wide ceiling on open streams. Default {@link MAX_STREAMS_GLOBAL}. */
  maxStreams?: number;
  heartbeatMs?: number;
  schedule?: Schedule;
  /** Called after a stream has released its slot (tests await it). */
  onStreamEnd?: () => void;
}

/**
 * `GET /api/documents/events`: the caller's own progress events as server-sent events. The bus scope
 * is the session's user id and nothing from the request. Open streams are counted per user and in total (state
 * owned by this route set, no module global); the slot is released exactly once on every exit path
 * (client close, error, backpressure destroy, `closeAll`).
 */
export function documentEventRoutes(deps: EventRoutesDeps): {
  routes: Record<string, Handler>;
  closeAll(): void;
} {
  const max = deps.maxStreamsPerUser ?? 4;
  const maxGlobal = deps.maxStreams ?? MAX_STREAMS_GLOBAL;
  const open = new Map<string, number>();
  const live = new Map<ServerResponse, () => void>(); // each open stream's `release`, for closeAll
  const stops = new Map<ServerResponse, () => void>();
  let closing = false; // set by closeAll: shutdown has begun, no new stream may stay open
  const routes: Record<string, Handler> = {
    [EVENTS_ROUTE]: requireAuth(deps.authenticator, (_req, res, identity) => {
      const { userId } = identity;
      // A request that finished authenticating after closeAll: answer 200 and end at once (a non-200
      // would stop EventSource for good; a 200 makes it reconnect to the next process). No slot, no subscription.
      if (closing) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        res.end("retry: 5000\n\n");
        return;
      }
      const count = open.get(userId) ?? 0;
      if (count >= max || live.size >= maxGlobal) {
        return sendError(res, 429, "too_many_streams", "too many open event streams");
      }
      // The client left while authentication ran: its close event has already fired, so no slot is taken.
      if (res.destroyed || res.writableEnded) return;
      // Check and increment happen in one synchronous block, so two concurrent opens cannot both pass.
      open.set(userId, count + 1);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        live.delete(res);
        stops.delete(res);
        const left = (open.get(userId) ?? 1) - 1;
        if (left <= 0) open.delete(userId);
        else open.set(userId, left);
        deps.onStreamEnd?.();
      };
      live.set(res, release);
      res.once("close", release);
      try {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          "x-accel-buffering": "no",
        });
        res.write("retry: 5000\n\n");
        openStream(
          res,
          (stop) => stops.set(res, stop),
          deps.bus,
          { userId },
          deps.schedule ?? intervalSchedule,
          deps.heartbeatMs ?? 15_000,
        );
      } catch (err) {
        stops.get(res)?.();
        release();
        throw err;
      }
    }),
  };
  return {
    routes,
    /** Unsubscribes, ends every open stream and frees its slot, so `server.close()` can finish (F10). */
    closeAll() {
      closing = true;
      for (const [res, release] of [...live]) {
        stops.get(res)?.(); // first: after this no bus event writes to a response that is ending
        release();
      }
    },
  };
}
