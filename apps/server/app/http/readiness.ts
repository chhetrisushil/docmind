import { type Handler, json } from "./respond";

/** How long a probe waits for the database before it answers 503; a balancer's own timeout is longer. */
export const READY_PING_TIMEOUT_MS = 1_000;

/**
 * The readiness probe behind `GET /readyz` (`/healthz` stays the static liveness check). It is 200 only
 * while the process is not shutting down and `ping` (a trivial query on the app pool) succeeds within
 * `timeoutMs`; otherwise 503 with a fixed reason code, never error text. `beginShutdown()` flips it at
 * the very start of shutdown, so a balancer stops routing before the drain begins.
 *
 * The probe is unauthenticated, so it must not amplify: concurrent probes share the one ping in flight,
 * and a new one starts only after it settles. At most one pool connection is ever spent on probes.
 */
export function createReadiness(opts: {
  ping: () => Promise<unknown>;
  timeoutMs?: number;
}): { handler: Handler; beginShutdown(): void } {
  const timeoutMs = opts.timeoutMs ?? READY_PING_TIMEOUT_MS;
  let shuttingDown = false;
  let inflight: Promise<boolean> | undefined;

  const ping = (): Promise<boolean> => {
    if (!inflight) {
      const p: Promise<boolean> = opts.ping().then(
        () => true,
        () => false,
      );
      inflight = p;
      void p.then(() => {
        if (inflight === p) inflight = undefined;
      });
    }
    return inflight;
  };

  const unavailable = (reason: "db_unavailable" | "shutting_down") => ({
    status: "unavailable",
    reason,
  });

  return {
    beginShutdown: () => {
      shuttingDown = true;
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
