import { registerLineageSensitivePaths } from "@loom-ui/lineage";
import type { PrincipalCryptoOptions, StorageConfig } from "@loom/app";
import type { ContentStore } from "@loom/plugin-content";
import {
  EncryptingContentStore,
  EncryptingEventStore,
  EncryptingSnapshotStore,
  type KeyStore,
} from "@loom/plugin-crypto";
import { PostgresTimerStore, postgresStorage } from "@loom/plugin-postgres";
import { Pool } from "pg";
import { SummaryChoiceEventStore } from "./chats/summaryChoice";
import { SENSITIVE_EVENT_PATHS } from "./sensitive";
import { subjectOfExecution } from "./subject";

type CustomStorage = Extract<StorageConfig, { kind: "custom" }>;

/** Pool config for docmind_loom; `search_path` keeps Loom's tables in schema `loom`. */
export function loomPoolConfig(
  loomUrl: string,
  max?: number,
): { connectionString: string; options: string; max?: number } {
  return { connectionString: loomUrl, options: "-c search_path=loom", ...(max && { max }) };
}

export interface DurableStorageOptions {
  loomUrl: string;
  keys: KeyStore;
  /** Size of the Loom pool (`DOCMIND_LOOM_POOL_MAX`); node-postgres's default of 10 when omitted. */
  loomPoolMax?: number;
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
  /** The Loom pool (docmind_loom); the status writer shares it. `close()` ends it. */
  pool: Pool;
  /** The sealing pair as Loom sees it: the event store is the summary-choice decorator over `EncryptingEventStore`. */
  sealed: StorePair;
  raw: StorePair;
  lease: { get?(executionId: string): Promise<unknown> };
  /** Loom's durable timers; borrows the Loom pool. */
  timers: PostgresTimerStore;
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
  loomPoolMax,
  sensitive = SENSITIVE_EVENT_PATHS,
}: DurableStorageOptions): DurableStorage {
  // Built here, not by the preset, so a dropped idle connection is logged instead of crashing the
  // process. The stores borrow it; `close()` ends it.
  const pool = new Pool(loomPoolConfig(loomUrl, loomPoolMax));
  pool.on("error", (err) =>
    console.error(
      "idle Loom database connection failed",
      err instanceof Error ? err.constructor.name : typeof err,
    ),
  );
  const pg = postgresStorage({ url: pool as never }); // pg typings differ between the linked Loom and this repo
  const events = new EncryptingEventStore(pg.eventStore, keys, {
    sensitive: { ...sensitive },
    subjectOf: subjectOfExecution,
  });
  // The visuals lineage (`__loom_ui_lineage__:visuals-<userId>-<documentId>`, owned by `subjectOfExecution`): its composed ops,
  // summary and provenance are sealed under the user's key from the first write, so destroying the key erases the line.
  registerLineageSensitivePaths(events);
  // The rolling summary's `summary-fit` decision carries the summary as a bare string choice; the decorator stores it
  // as `choice.text` (sealed) and gives Loom the string back (chats/summaryChoice.ts). Loom's principal sealing
  // (`crypto.events`) and erasure (`raw`) keep the undecorated stores.
  const decorated = new SummaryChoiceEventStore(events);
  const snapshots = new EncryptingSnapshotStore(pg.snapshotStore, keys, {
    sealState: true,
    legacyPlaintext: "refuse",
    subjectOf: subjectOfExecution,
    events: pg.eventStore,
  });
  const timers = new PostgresTimerStore(pool as never);
  return {
    storage: {
      kind: "custom",
      eventStore: decorated,
      snapshotStore: snapshots,
      leaseStore: pg.leaseStore,
      // Loom moves a trimmed or deleted inbox's envelopes here first and refuses to boot a chat app
      // without one (ADR 0139). Passed raw: `defineConfig` seals it under the event store's KeyStore
      // and subject mapping, so erasing a user also makes their archived envelopes unreadable.
      archiveStore: pg.archiveStore,
    },
    crypto: { events, snapshots },
    pool,
    sealed: { eventStore: decorated, snapshotStore: snapshots },
    raw: { eventStore: pg.eventStore, snapshotStore: pg.snapshotStore },
    lease: pg.leaseStore,
    timers,
    close: () => pool.end(),
  };
}

/**
 * A lineage's artifact store: `inner` sealed under the same KeyStore and subject mapping as the event store, so the
 * blobs of a visuals line are erased with the user's key like its events. Build the `Lineage` over this, never over `inner`.
 */
export function sealedLineageContent(inner: ContentStore, keys: KeyStore): EncryptingContentStore {
  return new EncryptingContentStore(inner, keys, { subjectOf: subjectOfExecution });
}

/**
 * `createDurableStorage`, then waits for Loom's schema DDL to finish. The event store starts it in
 * its constructor and only awaits it on first use, so without this a DDL failure would surface
 * after the server is already listening. On failure the pool is ended and the error carries no URL.
 */
export async function openDurableStorage(options: DurableStorageOptions): Promise<DurableStorage> {
  const durable = createDurableStorage(options);
  try {
    // Each store runs its own migration from its constructor; await them all so none is left
    // rejecting unobserved, then report the first failure.
    const results = await Promise.allSettled([
      durable.raw.eventStore.read("boot-probe"),
      durable.raw.snapshotStore.loadLatest("boot-probe"),
      durable.storage.archiveStore?.headers("boot-probe"),
      durable.lease.get?.("boot-probe"),
      durable.timers.due(0, 1),
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
