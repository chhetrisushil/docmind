import type { Server } from "node:http";
import { positiveInt } from "./documents/limits";

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

/**
 * The overall deadline of a shutdown, armed when the signal arrives. It must exceed the sum of the
 * bounded close steps (two SHUTDOWN_DRAIN_MS waits, two 10 s pool ends: 40 s) and stay under a
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
