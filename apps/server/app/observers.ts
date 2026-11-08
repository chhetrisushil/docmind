import type { EventEnvelope } from "@loom/core";

type Observer = (event: EventEnvelope) => void | Promise<void>;

/**
 * One `onDurableEvent` out of several observers (Loom allows one per runtime). Each observer runs even if an earlier one
 * throws; a rejection is logged by class and never returned, so the runtime has no promise to wait on or fail on. The
 * observers' synchronous parts run on the runtime's write chain: they must only enqueue.
 */
export function composeDurableObservers(...observers: Observer[]): (event: EventEnvelope) => void {
  const report = (err: unknown) =>
    console.error(
      "durable observer failed",
      err instanceof Error ? err.constructor.name : typeof err,
    );
  return (event) => {
    for (const observe of observers) {
      try {
        const out = observe(event);
        if (out) void out.catch(report);
      } catch (err) {
        report(err);
      }
    }
  };
}
