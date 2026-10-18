import type { PrincipalCryptoOptions, StorageConfig } from "@loom/app";
import { EncryptingEventStore, EncryptingSnapshotStore, type KeyStore } from "@loom/plugin-crypto";
import { postgresStorage } from "@loom/plugin-postgres";
import { subjectOfExecution } from "./subject";

type CustomStorage = Extract<StorageConfig, { kind: "custom" }>;

export interface DurableStorageOptions {
  /** Connection string for the docmind_loom role (it owns the `loom` schema). */
  loomUrl: string;
  /** Where per-user data keys live. Event payloads and snapshots are sealed under these. */
  keys: KeyStore;
}

interface StorePair {
  eventStore: CustomStorage["eventStore"];
  snapshotStore: NonNullable<CustomStorage["snapshotStore"]>;
}

export interface DurableStorage {
  storage: CustomStorage;
  crypto: PrincipalCryptoOptions;
  /** The encrypting pair that `storage` hands to Loom. */
  sealed: StorePair;
  /** The unwrapped pair. */
  raw: StorePair;
}

/**
 * Loom's Postgres event log and snapshots, wrapped so that what they hold is encrypted per user.
 *
 * - `storage` and `crypto` go into `defineConfig` (`storage`, and `security.crypto` so Loom marks the
 *   principal's identity fields as sensitive too).
 * - `raw` is the unwrapped pair, which erasure needs (`shredSubject` must write its tombstone to the
 *   raw log; M5).
 *
 * Both wrappers use the same KeyStore and the same subject mapping, so one destroyed key erases a
 * user's events and snapshots together. The snapshot store seals the whole folded state.
 * `subjectOfExecution` is the crypto subject only; it is not `compliance.subjectOf` (M5).
 */
export function createDurableStorage({ loomUrl, keys }: DurableStorageOptions): DurableStorage {
  const pg = postgresStorage({
    url: { connectionString: loomUrl, options: "-c search_path=loom" },
  });
  const events = new EncryptingEventStore(pg.eventStore, keys, {
    sensitive: {},
    subjectOf: subjectOfExecution,
  });
  const snapshots = new EncryptingSnapshotStore(pg.snapshotStore, keys, {
    sealState: true,
    subjectOf: subjectOfExecution,
    events: pg.eventStore,
  });
  return {
    storage: {
      kind: "custom",
      eventStore: events,
      snapshotStore: snapshots,
      leaseStore: pg.leaseStore,
    },
    crypto: { events, snapshots },
    sealed: { eventStore: events, snapshotStore: snapshots },
    raw: { eventStore: pg.eventStore, snapshotStore: pg.snapshotStore },
  };
}
