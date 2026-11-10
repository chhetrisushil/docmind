import { createHash } from "node:crypto";
import { InMemoryKeyStore, type KeyStore } from "@loom/plugin-crypto";
import { UserIds, legacyIds } from "./ids";
import type { HandleStore } from "./opaqueIds";
import { OpaqueIds } from "./opaqueIds";
import { deriveIdKey, handleOfKey } from "./siv";

/** An in-memory `HandleStore` with the unique-handle rule of `users.id_handle`. For unit tests; the Postgres one is `PgHandleStore`. */
export class MemoryHandleStore implements HandleStore {
  readonly rows = new Map<string, { tenantId: string; handle: string | null }>();
  /** Users to answer `read` and `claim` for (a test registers the ones it needs). */
  add(
    userId: string,
    tenantId = "00000000-0000-0000-0000-0000000000aa",
    handle: string | null = null,
  ) {
    this.rows.set(userId, { tenantId, handle });
  }
  async read(who: { userId: string }) {
    return this.rows.get(who.userId)?.handle ?? null;
  }
  async claim(who: { userId: string; tenantId: string }, handle: string) {
    const row = this.rows.get(who.userId) ?? { tenantId: who.tenantId, handle: null };
    for (const [id, other] of this.rows) {
      if (id !== who.userId && other.handle === handle) throw new Error("duplicate id_handle");
    }
    row.handle ??= handle;
    this.rows.set(who.userId, row);
    return row.handle;
  }
  async userOf(handle: string) {
    for (const [id, row] of this.rows) if (row.handle === handle) return id;
    return null;
  }
  async page(after: string, limit: number) {
    return [...this.rows]
      .filter(([id, row]) => row.handle !== null && id > after)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .slice(0, limit)
      .map(([userId, row]) => ({ userId, handle: row.handle as string }));
  }
}

/**
 * A `MemoryHandleStore` that registers any user it is asked about (a test that starts executions for many users needs no setup per user).
 * Handles are still derived from each user's key and unique, as in production.
 */
export class AutoHandleStore extends MemoryHandleStore {
  override async read(who: { userId: string; tenantId: string }) {
    if (!this.rows.has(who.userId)) this.add(who.userId, who.tenantId);
    return super.read(who);
  }
  override async claim(who: { userId: string; tenantId: string }, handle: string) {
    if (!this.rows.has(who.userId)) this.add(who.userId, who.tenantId);
    return super.claim(who, handle);
  }
}

const dekOf = (userId: string) => createHash("sha256").update(`test-dek:${userId}`).digest();

/**
 * A key store whose data key for a subject is a fixed function of it, so a test can compute the ids a starter will build for a user
 * (`deterministicUser`) without awaiting the starter. Everything else behaves as `InMemoryKeyStore` (destroy, `wasDestroyed`).
 */
export class DeterministicKeyStore extends InMemoryKeyStore implements KeyStore {
  override async getOrCreate(subjectId: string): Promise<Buffer> {
    await super.getOrCreate(subjectId); // refuses a destroyed subject, as the real store does
    return dekOf(subjectId);
  }
  override async get(subjectId: string): Promise<Buffer | null> {
    return (await super.get(subjectId)) === null ? null : dekOf(subjectId);
  }
}

/** The builders a `testIdSource()` gives this user, computed with no key store and no await. */
export const deterministicUser = (userId: string): UserIds => {
  const key = deriveIdKey(dekOf(userId));
  return new UserIds(userId, handleOfKey(key), key);
};

/** A fresh in-memory `OpaqueIds` over an `AutoHandleStore` and a `DeterministicKeyStore`, for tests that pass `ids` to a starter. */
export const testIdSource = () => new OpaqueIds(new DeterministicKeyStore(), new AutoHandleStore());

/** The old-format ingest id (a document's first generation is 2, as `INGEST_GENERATION`): what tests seed or read for a run from before the deploy. */
export const legacyIngestId = (userId: string, documentId: string, generation = 2) =>
  legacyIds.ingest(userId, documentId, generation);
export const legacyVisualizeId = (
  userId: string,
  documentId: string,
  generation: number,
  rerun?: number,
) => legacyIds.visualize(userId, documentId, generation, rerun);
export const legacySuggestTagsId = (userId: string, documentId: string, run: number) =>
  legacyIds.suggestTags(userId, documentId, run);

/** A fresh in-memory key store, handle store and `OpaqueIds`. A test that needs the process-wide parsers calls `opaqueIds.install(ids)` and removes it afterwards. */
export function testOpaqueIds() {
  const keys = new InMemoryKeyStore();
  const store = new MemoryHandleStore();
  return { keys, store, ids: new OpaqueIds(keys, store) };
}
