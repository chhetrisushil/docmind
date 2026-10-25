import type { Server } from "node:http";
import { positiveInt } from "./documents/limits";
import { StartupConfigError } from "./startupError";

/**
 * Stops accepting requests, lets in-flight ones finish, and only then closes the app.
 * `server.close()` waits for idle keep-alive sockets too, and one that goes idle after the call is
 * not closed for us, so idle sockets are swept until the server is down.
 */
export async function shutdown(server: Server, app: { close(): Promise<void> }): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      const sweep = setInterval(() => server.closeIdleConnections(), 50);
      server.close((err) => {
        clearInterval(sweep);
        return err ? reject(err) : resolve();
      });
      server.closeIdleConnections();
    });
  } finally {
    // The stores must close even when the server could not (the error still propagates).
    await app.close();
  }
}

/** How long shutdown waits for fired ingest starts to settle before it closes the stores anyway. */
export const SHUTDOWN_DRAIN_MS = 10_000;

/** Resolves when `work` settles or after `ms`, whichever is first; never rejects, leaves no timer behind. */
export async function drainWithin(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([work.catch(() => undefined), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs every step in order even if one throws, then rethrows the first error. */
export async function runAll(...steps: (() => Promise<unknown>)[]): Promise<void> {
  let failure: { err: unknown } | undefined;
  for (const step of steps) {
    try {
      await step();
    } catch (err) {
      failure ??= { err };
    }
  }
  if (failure) throw failure.err;
}

/** After the close sequence, how long a still-live event loop (a stuck socket) is given before the forced exit. */
export const FORCE_EXIT_MS = 5_000;

/** How long the close sequence waits for the readiness probe's own pool to end. */
export const READINESS_END_MS = 2_000;

/**
 * The worst case of the close sequence when every bounded step hits its bound: two SHUTDOWN_DRAIN_MS waits
 * (the sweeper, the fired starts) and three 10 s pool ends (the eraser's locks, the Loom pool, the app
 * pool; closeSequence.test pins that 10 s is POOL_END_MS), plus the readiness pool.
 */
export const CLOSE_BOUNDS_MS = 2 * SHUTDOWN_DRAIN_MS + 3 * 10_000 + READINESS_END_MS;

/**
 * The overall deadline of a shutdown, armed when the signal arrives. It must exceed the sum of the
 * bounded close steps (CLOSE_BOUNDS_MS, 52 s) and any DOCMIND_SHUTDOWN_DELAY_MS, and stay under a
 * supervisor's kill timeout (systemd defaults to 90 s), so a slow in-flight request (the per-route request
 * timeout is 60 s) cannot hold the process until SIGKILL, which would skip the lease release.
 */
export const FORCE_EXIT_DEADLINE_MS = 60_000;

/**
 * `DOCMIND_SHUTDOWN_DEADLINE_MS` (default FORCE_EXIT_DEADLINE_MS, at most an hour): the overall shutdown deadline.
 * Set it to the platform's termination grace minus a few seconds; below the close steps' 40 s it ends
 * the process before the leases are released. A bad value fails the boot.
 */
export function loadShutdownDeadlineMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(env, "DOCMIND_SHUTDOWN_DEADLINE_MS", FORCE_EXIT_DEADLINE_MS, 3_600_000);
}

/**
 * Schedules an unref'd forced exit: it never keeps a cleanly stopped process alive, and it ends one
 * that a stuck socket or pool client would otherwise hold open. Call it after the close sequence,
 * whether it succeeded or failed; `exit` receives the exit code the process was going to have.
 */
export function scheduleForceExit(
  exit: (code: number) => void,
  getCode: () => number | string | null | undefined,
  ms = FORCE_EXIT_MS,
): void {
  setTimeout(() => exit(Number(getCode() ?? 0)), ms).unref();
}

/**
 * A boot warning (fixed text) when the deadline cannot cover the close sequence's worst case plus the
 * forced-exit margin: a shutdown that hits its bounds is then cut off before the leases are released.
 * Only a warning, because the usual shutdown is far quicker than its bounds.
 */
export function shutdownDeadlineWarning(deadlineMs: number): string | undefined {
  return deadlineMs < CLOSE_BOUNDS_MS + FORCE_EXIT_MS
    ? "DOCMIND_SHUTDOWN_DEADLINE_MS is below the close sequence's worst case plus the forced-exit margin (57000): a slow shutdown may be cut off before the execution leases are released"
    : undefined;
}

/**
 * `DOCMIND_SHUTDOWN_DELAY_MS` (default 0): after SIGTERM, how long the server keeps serving normally, with
 * `/readyz` answering 503, before it starts to drain. It gives a balancer's probes time to see the 503
 * and stop routing; without it the listener closes in the same tick and the next probe is refused. The
 * delay counts inside the shutdown deadline, so it must leave room for the close steps' bounds. A bad
 * value, or one that does not fit, fails the boot.
 */
export function loadShutdownDelayMs(
  env: NodeJS.ProcessEnv = process.env,
  deadlineMs: number = FORCE_EXIT_DEADLINE_MS,
): number {
  const raw = env.DOCMIND_SHUTDOWN_DELAY_MS?.trim();
  if (!raw) return 0;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value))
    throw new StartupConfigError("DOCMIND_SHUTDOWN_DELAY_MS must be a non-negative integer");
  if (value > 0 && value >= deadlineMs - CLOSE_BOUNDS_MS)
    throw new StartupConfigError(
      `DOCMIND_SHUTDOWN_DELAY_MS must be less than DOCMIND_SHUTDOWN_DEADLINE_MS minus ${CLOSE_BOUNDS_MS} (the close steps' bounds)`,
    );
  return value;
}
