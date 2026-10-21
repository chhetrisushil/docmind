import type { ErasureWiring } from "./compliance";

/**
 * A snapshot store with no snapshots, for tests whose event store is in memory. `shredSubject` refuses
 * to run over a store that can `truncatePrefix` without one, and only ever reads it.
 */
export const noSnapshots = {
  loadLatest: async () => null,
  loadLatestSealed: async () => null,
} as unknown as ErasureWiring["raw"]["snapshotStore"];
