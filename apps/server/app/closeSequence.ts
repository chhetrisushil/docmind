import { SHUTDOWN_DRAIN_MS, drainWithin } from "./shutdown";

/**
 * How long shutdown waits for a pool to end. `pool.end()` waits for checked-out clients, so a query
 * stuck on one (an abandoned step's write) would otherwise keep the process alive until SIGKILL.
 */
export const POOL_END_MS = 10_000;

/** What the close sequence calls; main.ts supplies the real ones. */
export interface CloseDeps {
  startsIdle(): Promise<unknown>;
  closeIngest(): Promise<unknown>;
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
 *  2. interrupt the steps, then kill in-flight parses, before any pool ends;
 *  3. release this node's execution leases, so the next boot recovers what was interrupted at once
 *     instead of waiting out the lease (after the steps are interrupted, before the stores close);
 *  4. stop feeding the status model (a step still running must not fold onto stores about to close), close it;
 *  5. close the app (Loom's stores), then the Loom pool, then the pool the key store reads from, each pool
 *     bounded by POOL_END_MS.
 */
export const closeSequence = (
  d: CloseDeps,
  poolEndMs = POOL_END_MS,
): (() => Promise<unknown>)[] => [
  () => drainWithin(d.startsIdle(), SHUTDOWN_DRAIN_MS),
  () => d.closeIngest(),
  () => d.closeHeartbeat(),
  async () => {
    d.detachStatusFeed();
    await d.closeStatus();
  },
  () => d.closeApp(),
  () => drainWithin(d.closeDurable(), poolEndMs),
  () => drainWithin(d.endPool(), poolEndMs),
];
