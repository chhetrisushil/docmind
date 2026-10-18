import type { PrincipalCryptoOptions, StorageConfig } from "@loom/app";
import { EncryptingEventStore, EncryptingSnapshotStore, type KeyStore } from "@loom/plugin-crypto";
import { postgresStorage } from "@loom/plugin-postgres";
import { Pool } from "pg";
import { SENSITIVE_EVENT_PATHS } from "./sensitive";
import { subjectOfExecution } from "./subject";

type CustomStorage = Extract<StorageConfig, { kind: "custom" }>;

/** Pool config for docmind_loom; `search_path` keeps Loom's tables in schema `loom`. */
export function loomPoolConfig(loomUrl: string): { connectionString: string; options: string } {
  return { connectionString: loomUrl, options: "-c search_path=loom" };
}

export interface DurableStorageOptions {
  loomUrl: string;
  keys: KeyStore;
  /** Event paths to seal, per event type. Defaults to `SENSITIVE_EVENT_PATHS`. */
  sensitive?: Readonly<Record<string, readonly string[]>>;
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
  lease: { get?(executionId: string): Promise<unknown> };
  /**
   * Ends the Loom pool. Call it after `app.close()` (which closes the stores but, because the pool
   * is lent to them, leaves it open); never before.
   */
  close(): Promise<void>;
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
export function createDurableStorage({
  loomUrl,
  keys,
  sensitive = SENSITIVE_EVENT_PATHS,
}: DurableStorageOptions): DurableStorage {
  // Built here, not by the preset, so a dropped idle connection is logged instead of crashing the
  // process. The stores borrow it; `close()` ends it.
  const pool = new Pool(loomPoolConfig(loomUrl));
  pool.on("error", (err) => console.error("idle Loom database connection failed:", err.message));
  const pg = postgresStorage({ url: pool as never }); // pg typings differ between the linked Loom and this repo
  const events = new EncryptingEventStore(pg.eventStore, keys, {
    sensitive: { ...sensitive },
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
    lease: pg.leaseStore,
    close: () => pool.end(),
  };
}

/**
 * `createDurableStorage`, then waits for Loom's schema DDL to finish. The event store starts it in
 * its constructor and only awaits it on first use, so without this a DDL failure would surface
 * after the server is already listening. On failure the pool is ended and the error carries no URL.
 */
export async function openDurableStorage(options: DurableStorageOptions): Promise<DurableStorage> {
  const durable = createDurableStorage(options);
  try {
    // Each store runs its own migration from its constructor; await all three so none is left
    // rejecting unobserved, then report the first failure.
    const results = await Promise.allSettled([
      durable.raw.eventStore.read("boot-probe"),
      durable.raw.snapshotStore.loadLatest("boot-probe"),
      durable.lease.get?.("boot-probe"),
    ]);
    for (const r of results) if (r.status === "rejected") throw r.reason;
  } catch (err) {
    await durable.close().catch(() => {});
    throw new Error(
      `Loom storage failed to boot: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return durable;
}
