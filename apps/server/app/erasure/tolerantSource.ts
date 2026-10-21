import type { EventEnvelope } from "@loom/core";
import { type EventStore, isKeyUnavailable } from "@loom/event-runtime";
import { EncryptingEventStore, type KeyStore } from "@loom/plugin-crypto";
import { subjectOfExecution } from "../subject";

/** `["EVENT_TYPE.path", …]` (a store's `sealingCapability().covers`) back into the per-type path map. */
export function sensitiveFromCovers(covers: readonly string[]): Record<string, string[]> {
  const byType = new Map<string, string[]>();
  for (const cover of covers) {
    const dot = cover.indexOf(".");
    if (dot <= 0 || dot === cover.length - 1) continue; // an event type has no dot; ignore a malformed entry
    const type = cover.slice(0, dot);
    const paths = byType.get(type) ?? [];
    paths.push(cover.slice(dot + 1));
    byType.set(type, paths);
  }
  return Object.fromEntries(byType);
}

export interface TolerantSourceOptions {
  /** The raw (unwrapped) event store the strict one wraps. */
  raw: EventStore;
  keys: KeyStore;
  /** The strict sealing store, read for what it seals once `defineConfig` has registered its framework paths. */
  strict: Pick<EventStore, "sealingCapability">;
}

/**
 * A read-only view of the log for the read models: an erased user's sealed fields read as
 * `{ $shredded: true }` instead of throwing `PayloadShreddedError`, so catch-up, a rebuild and a version
 * bump can fold past an erased execution. It redacts a real shred (a `PAYLOAD_SHREDDED` tombstone in
 * the log) and the window of a shred that crashed after the key store destroyed the key but before the
 * tombstones were written (`keys.wasDestroyed(subject)` is true: the same durable proof Loom's own
 * `shredSubject` uses). A key that is merely missing on this node, and was never destroyed, still
 * raises `KeyUnavailableError`.
 *
 * Never hand it to the runtime, to a resume or to any read that returns data to a user: a fold off a
 * placeholder is not the original, so the authoritative path keeps the strict store.
 */
export function tolerantSource({ raw, keys, strict }: TolerantSourceOptions): EventStore {
  const store = new EncryptingEventStore(raw, keys, {
    sensitive: sensitiveFromCovers(strict.sealingCapability?.()?.covers ?? []),
    subjectOf: subjectOfExecution,
    onShredded: "tolerate",
  });
  const redactIfDestroyed = async (err: unknown): Promise<EventEnvelope[]> => {
    if (
      isKeyUnavailable(err) &&
      err.redacted &&
      (await keys.wasDestroyed?.(err.subjectId)) === true
    ) {
      return [...err.redacted];
    }
    throw err;
  };
  const reads = new Set<string | symbol>(["read", "readFrom", "readRange"]);
  return new Proxy(store, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (!reads.has(prop) || typeof value !== "function") return value;
      return (...args: unknown[]) =>
        (value as (...a: unknown[]) => Promise<EventEnvelope[]>)
          .apply(target, args)
          .catch(redactIfDestroyed);
    },
  });
}
