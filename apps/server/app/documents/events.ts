import type { ServerResponse } from "node:http";
import type { ProgressBus, ProgressScope } from "./progress";

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
