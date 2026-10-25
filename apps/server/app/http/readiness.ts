import { type Handler, json } from "./respond";

/** How long a probe waits for the database before it answers 503; a balancer's own timeout is longer. */
export const READY_PING_TIMEOUT_MS = 1_000;

/** A ping this many timeouts old is not reused: a probe starts a fresh one instead of waiting on it forever. */
const STALE_PING_TIMEOUTS = 3;

/**
 * The readiness probe behind `GET /readyz` and `HEAD /readyz` (`/healthz` stays the static liveness check).
 * It is 200 only while the process is not shutting down and `ping` (a trivial query) succeeds within
 * `timeoutMs`; otherwise 503 with a fixed reason code, never error text. `beginShutdown()` flips it to
 * 503 `shutting_down`; the caller keeps serving for a while after that, so a balancer's next probe can
 * see it (see `DOCMIND_SHUTDOWN_DELAY_MS`).
 *
 * `ping` must not use the request pool: a probe queued behind a saturated pool would report the
 * database down while it is healthy, and every replica would be ejected at peak. `compose.ts` gives it
 * a connection of its own, and `close()` ends whatever `closePing` ends.
 *
 * The probe is unauthenticated, so it must not amplify: concurrent probes share the one ping in flight,
 * and a new one starts only after it settles (or goes stale). A failed ping is not remembered.
 */
export function createReadiness(opts: {
  ping: () => Promise<unknown>;
  closePing?: () => Promise<unknown>;
  timeoutMs?: number;
  now?: () => number;
}): { handler: Handler; beginShutdown(): void; close(): Promise<void> } {
  const timeoutMs = opts.timeoutMs ?? READY_PING_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  let shuttingDown = false;
  let inflight: { done: Promise<boolean>; startedAt: number } | undefined;

  const ping = (): Promise<boolean> => {
    if (!inflight || now() - inflight.startedAt > STALE_PING_TIMEOUTS * timeoutMs) {
      // `Promise.resolve().then` turns a synchronous throw from `ping` into a rejection, so it is a 503 too.
      const done: Promise<boolean> = Promise.resolve()
        .then(opts.ping)
        .then(
          () => true,
          () => false,
        );
      const entry = { done, startedAt: now() };
      inflight = entry;
      void done.then(() => {
        if (inflight === entry) inflight = undefined;
      });
    }
    return inflight.done;
  };

  const unavailable = (reason: "db_unavailable" | "shutting_down") => ({
    status: "unavailable",
    reason,
  });

  return {
    beginShutdown: () => {
      shuttingDown = true;
    },
    close: async () => {
      shuttingDown = true;
      await opts.closePing?.();
    },
    handler: async (_req, res) => {
      res.setHeader("cache-control", "no-store");
      if (shuttingDown) return json(res, 503, unavailable("shutting_down"));
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      });
      const ok = await Promise.race([ping(), deadline]).finally(() => clearTimeout(timer));
      // The shutdown may have begun while the ping ran: report it, not the database.
      if (shuttingDown) return json(res, 503, unavailable("shutting_down"));
      if (!ok) return json(res, 503, unavailable("db_unavailable"));
      json(res, 200, { status: "ready" });
    },
  };
}
