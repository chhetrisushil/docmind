import type { Server } from "node:http";

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
