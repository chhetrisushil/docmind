import type { PrincipalCryptoOptions, StorageConfig } from "@loom/app";
import { EncryptingEventStore, EncryptingSnapshotStore, type KeyStore } from "@loom/plugin-crypto";
import { postgresStorage } from "@loom/plugin-postgres";
import { subjectOfExecution } from "./subject";

type CustomStorage = Extract<StorageConfig, { kind: "custom" }>;

/** Pool config for docmind_loom; `search_path` keeps Loom's tables in schema `loom`. */
export function loomPoolConfig(loomUrl: string): { connectionString: string; options: string } {
  return { connectionString: loomUrl, options: "-c search_path=loom" };
}

export interface DurableStorageOptions {
  loomUrl: string;
  keys: KeyStore;
}

interface StorePair {
  eventStore: CustomStorage["eventStore"];
  snapshotStore: NonNullable<CustomStorage["snapshotStore"]>;
}

export interface DurableStorage {
  storage: CustomStorage;
  crypto: PrincipalCryptoOptions;
  sealed: StorePair;
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
 * Both wrappers share one KeyStore and `subjectOfExecution` (the crypto subject only, not
 * `compliance.subjectOf`), so one destroyed key erases a user's events and snapshots together.
 */
export function createDurableStorage({ loomUrl, keys }: DurableStorageOptions): DurableStorage {
  const pg = postgresStorage({ url: loomPoolConfig(loomUrl) });
  const events = new EncryptingEventStore(pg.eventStore, keys, {
    sensitive: {},
    subjectOf: subjectOfExecution,
  });
  const snapshots = new EncryptingSnapshotStore(pg.snapshotStore, keys, {
    sealState: true,
    legacyPlaintext: "refuse",
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
