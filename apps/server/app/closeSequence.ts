import { SHUTDOWN_DRAIN_MS, drainWithin } from "./shutdown";

/**
 * How long shutdown waits for a pool to end. `pool.end()` waits for checked-out clients, so a query
 * stuck on one (an abandoned step's write) would otherwise keep the process alive until SIGKILL.
 */
export const POOL_END_MS = 10_000;

/** A close step hit its bound. The message names the step only. */
export class CloseTimeoutError extends Error {
  constructor(step: string) {
    super(`shutdown step timed out: ${step}`);
    this.name = "CloseTimeoutError";
  }
}

/**
 * Races `work` against a deadline. The deadline winning rejects with CloseTimeoutError; the work's
 * own rejection propagates (unlike drainWithin, which swallows it), so `runAll` still reports it.
 */
export async function bounded(work: Promise<unknown>, ms: number, step: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CloseTimeoutError(step)), ms);
  });
  try {
    await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** What the close sequence calls; main.ts supplies the real ones. */
export interface CloseDeps {
  startsIdle(): Promise<unknown>;
  closeIngest(): Promise<unknown>;
  /** The chat's in-flight model calls; absent when chat is not composed. */
  closeChat?(): Promise<unknown>;
  closeHeartbeat(): Promise<unknown>;
  detachStatusFeed(): void;
  closeStatus(): Promise<unknown>;
  closeApp(): Promise<unknown>;
  closeDurable(): Promise<unknown>;
  endPool(): Promise<unknown>;
}

/**
 * The steps `runAll` runs once the server has stopped accepting requests, in the order that keeps
 * them safe:
 *  1. let fired flow starts settle (bounded: a start stuck on a dead database must not keep the stores open);
 *  2. interrupt the ingest steps and the chat's model calls (their steps stay un-completed in the log,
 *     like ingest's, and recovery re-runs them next boot; the chat flow declares no turn deadline, so
 *     Loom cannot time the pending model step out and fail it while the close runs), then kill in-flight parses, before any pool ends;
 *  3. release this node's execution leases, so the next boot recovers what was interrupted at once
 *     instead of waiting out the lease (after the steps are interrupted, before the stores close);
 *  4. stop feeding the status model (a step still running must not fold onto stores about to close), close it;
 *  5. close the app (Loom's stores), then the Loom pool, then the pool the key store reads from, each pool
 *     bounded by POOL_END_MS.
 */
export const closeSequence = (
  d: CloseDeps,
  poolEndMs = POOL_END_MS,
): (() => Promise<unknown>)[] => {
  const closeChat = d.closeChat?.bind(d);
  return [
    () => drainWithin(d.startsIdle(), SHUTDOWN_DRAIN_MS),
    () => d.closeIngest(),
    ...(closeChat ? [() => closeChat()] : []),
    () => d.closeHeartbeat(),
    async () => {
      d.detachStatusFeed();
      await d.closeStatus();
    },
    () => d.closeApp(),
    () => bounded(d.closeDurable(), poolEndMs, "closeDurable"),
    () => bounded(d.endPool(), poolEndMs, "endPool"),
  ];
};
