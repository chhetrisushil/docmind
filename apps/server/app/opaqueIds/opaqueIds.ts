import type { KeyStore } from "@loom/plugin-crypto";
import { FieldKeyStoreError, FieldKeyUnavailableError } from "../crypto/fields";
import {
  HANDLE_RE,
  type IdFamily,
  type OpaqueShape,
  type ParsedId,
  UserIds,
  handleOfAnyId,
  shapeOfExecution,
  shapeOfLineage,
} from "./ids";
import { type IdKey, type TokenFamily, deriveIdKey, handleOfKey, openToken } from "./siv";

/** Where a user's handle lives (`users.id_handle`) and how it is found from the handle alone. */
export interface HandleStore {
  /** The user's stored handle, or null. Runs under the user's tenant. */
  read(who: { tenantId: string; userId: string }): Promise<string | null>;
  /**
   * Stores `handle` unless the user already has one, and returns the stored value (spec section 5: the unique constraint settles a race,
   * the loser re-reads). The caller refuses a stored value that differs from the one it derived.
   */
  claim(who: { tenantId: string; userId: string }, handle: string): Promise<string>;
  /** The user a handle belongs to, across tenants (the cache-miss path), or null (never issued, or the user is erased). */
  userOf(handle: string): Promise<string | null>;
  /** One page of users that have a handle, ordered by user id, after `after` (the boot warm-up). */
  page(after: string, limit: number): Promise<{ userId: string; handle: string }[]>;
}

/** The stored handle is not the one the user's key derives: the row or the key was tampered with, or the key was replaced. */
export class HandleMismatchError extends Error {
  constructor() {
    super("the stored id handle does not match the user's id key");
    this.name = "HandleMismatchError";
  }
}

/** The handle store failed. Fixed message, no cause: a driver error may carry the handle, a parameter or SQL text. */
export class HandleStoreError extends Error {
  constructor() {
    super("the id handle store failed");
    this.name = "HandleStoreError";
  }
}

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { code?: unknown }).code === "23505";

/** Runs a store call, replacing any error except the key errors with a `HandleStoreError` (and a unique-key collision with `HandleMismatchError`). */
async function guarded<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof HandleMismatchError) throw err;
    // The key is gone or the key store is down: not a handle store outage, and callers classify these two differently.
    if (err instanceof FieldKeyUnavailableError || err instanceof FieldKeyStoreError) throw err;
    throw isUniqueViolation(err) ? new HandleMismatchError() : new HandleStoreError();
  }
}

interface Entry {
  readonly ids: UserIds;
  readonly key: IdKey;
}

export const WARM_PAGE = 500;
export const WARM_CONCURRENCY = 8;
const MISS_LIMIT = 1000;
const MISS_TTL_MS = 30_000;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * The one module that builds and parses execution and lineage ids, in both formats (O5). The new format needs the user's id key, which
 * is async to fetch and then cached: `ensureUser` and `ensureHandle` are the async entry points, `parse` and the `UserIds` builders are
 * synchronous. A `parse` of an old-format id never needs the cache; of a new-format id it answers null on a cache miss, so a caller that
 * can see such an id first awaits `ensureHandle(handleOf(id))` (see `opaqueIds.handleOf`).
 */
export class OpaqueIds {
  private readonly byHandle = new Map<string, Entry>();
  private readonly byUser = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<Entry>>();
  /**
   * Key fetches in flight, by `u:<userId>` and `h:<handle>`. `forget` cancels the tickets under the key it drops, so a mint or key load that
   * started before an erasure does not cache its result. An entry exists only while a fetch is in flight (nothing grows per erased user).
   */
  private readonly fetches = new Map<string, Set<{ cancelled: boolean }>>();
  /** Handles the store said nobody holds, with an expiry: an erased user's leftover ids must not cost a lookup each. */
  private readonly misses = new Map<string, number>();
  /**
   * Handles whose `h_` subject is being shredded right now (`retireHandle`, until `unretireHandle`). Loom destroys the handle's key inside
   * `eraseSubject`, before the cache is told: while a handle is here no read or mint hands out its builders, so a concurrent cache hit
   * cannot build an `h_` id against a key that may already be gone. Entries live only for the duration of one shred call.
   */
  private readonly retiring = new Map<string, number>();

  private isRetiring(handle: string): boolean {
    return (this.retiring.get(handle) ?? 0) > 0;
  }

  constructor(
    private readonly keys: Pick<KeyStore, "get" | "getOrCreate" | "wasDestroyed">,
    private readonly store: HandleStore,
    /** `warmPage`: users per page of the boot warm-up (default `WARM_PAGE`); a test sets a small one to cross a page boundary. */
    private readonly options: { warmPage?: number } = {},
  ) {}

  private put(userId: string, key: IdKey, handle: string): Entry {
    const entry = { ids: new UserIds(userId, handle, key), key };
    this.misses.delete(handle);
    this.byHandle.set(handle, entry);
    this.byUser.set(userId, entry);
    return entry;
  }

  /** The user's builders, minting the key and the handle on a user's first new-format start. A key-store outage throws (never a plaintext fallback). */
  async ensureUser(who: { tenantId: string; userId: string }): Promise<UserIds> {
    const hit = this.byUser.get(who.userId);
    if (hit) {
      if (this.isRetiring(hit.ids.handle)) throw new FieldKeyUnavailableError();
      return hit.ids;
    }
    let pending = this.inflight.get(who.userId);
    if (!pending) {
      const started = this.mint(who);
      pending = started.finally(() => {
        if (this.inflight.get(who.userId) === pending) this.inflight.delete(who.userId);
      });
      this.inflight.set(who.userId, pending);
    }
    return (await pending).ids;
  }

  private ticket(keys: string[]): { cancelled: boolean; done(): void } {
    const t = {
      cancelled: false,
      done: () => {
        for (const k of keys) {
          const set = this.fetches.get(k);
          set?.delete(t);
          if (set?.size === 0) this.fetches.delete(k);
        }
      },
    };
    for (const k of keys) {
      const set = this.fetches.get(k) ?? new Set();
      set.add(t);
      this.fetches.set(k, set);
    }
    return t;
  }

  private cancel(key: string): void {
    for (const t of this.fetches.get(key) ?? []) t.cancelled = true;
  }

  private async mint(who: { tenantId: string; userId: string }): Promise<Entry> {
    const ticket = this.ticket([`u:${who.userId}`]);
    try {
      return await this.mintKey(who, ticket);
    } finally {
      ticket.done();
    }
  }

  private async mintKey(
    who: { tenantId: string; userId: string },
    ticket: { cancelled: boolean },
  ): Promise<Entry> {
    let dek: Buffer;
    try {
      dek = await this.keys.getOrCreate(who.userId);
    } catch {
      // The store's own errors may name the subject or KEK, so they are not passed on.
      const destroyed = (await this.keys.wasDestroyed?.(who.userId).catch(() => false)) === true;
      throw destroyed ? new FieldKeyUnavailableError() : new FieldKeyStoreError();
    }
    const key = deriveIdKey(dek);
    const handle = handleOfKey(key);
    if ((await guarded(() => this.store.claim(who, handle))) !== handle)
      throw new HandleMismatchError();
    if (await this.handleRetired(handle)) throw new FieldKeyUnavailableError();
    if (ticket.cancelled || this.isRetiring(handle)) throw new FieldKeyUnavailableError();
    return this.put(who.userId, key, handle);
  }

  /**
   * The cache-miss path: finds the user of a handle, derives the key from the stored data key (it never mints one) and caches both.
   * Null for a handle no user holds (never issued, or erased) and for a user whose key is destroyed.
   */
  async ensureHandle(handle: string): Promise<UserIds | null> {
    const hit = this.byHandle.get(handle);
    if (hit) return this.isRetiring(handle) ? null : hit.ids;
    if (!HANDLE_RE.test(handle)) return null;
    const missUntil = this.misses.get(handle);
    if (missUntil !== undefined && missUntil > Date.now()) return null;
    const userId = await guarded(() => this.store.userOf(handle));
    const entry = userId === null ? null : await this.loadKey(userId, handle);
    if (entry === null) this.recordMiss(handle); // never issued, erased, or the key is destroyed
    return entry?.ids ?? null;
  }

  private recordMiss(handle: string): void {
    this.misses.delete(handle);
    if (this.misses.size >= MISS_LIMIT) {
      const oldest = this.misses.keys().next().value;
      if (oldest !== undefined) this.misses.delete(oldest);
    }
    this.misses.set(handle, Date.now() + MISS_TTL_MS);
  }

  /**
   * Whether the `h_<handle>` subject key was destroyed: the durable mark that a handle is retired. The erasure destroys that key before the
   * user's data key (which this cache derives the id key from), so a stop repeated after a park must not rebuild an `h_` id for it (Loom
   * would refuse the cancel and audit the actor's UUID in the clear on the `h_` stream).
   */
  private async handleRetired(handle: string): Promise<boolean> {
    try {
      return (await this.keys.wasDestroyed?.(`h_${handle}`)) === true;
    } catch {
      throw new FieldKeyStoreError();
    }
  }

  private async loadKey(userId: string, handle: string): Promise<Entry | null> {
    const hit = this.byUser.get(userId);
    if (hit) return this.isRetiring(handle) ? null : hit;
    const ticket = this.ticket([`u:${userId}`, `h:${handle}`]);
    try {
      let dek: Buffer | null;
      try {
        dek = await this.keys.get(userId);
      } catch {
        throw new FieldKeyStoreError();
      }
      if (dek === null) return null;
      const key = deriveIdKey(dek);
      if (handleOfKey(key) !== handle) throw new HandleMismatchError();
      if (await this.handleRetired(handle)) {
        this.recordMiss(handle); // only a cache of the durable answer
        return null;
      }
      if (ticket.cancelled || this.isRetiring(handle)) return null; // forgotten or being shredded while the key was being fetched
      return this.put(userId, key, handle);
    } finally {
      ticket.done();
    }
  }

  /**
   * Boot: caches every user that has a handle, before recovery, the status fold or any observer runs. It covers a superset of the users with
   * a recoverable or in-flight execution (Loom lists executions by id prefix only, and a read-model rebuild folds every user's executions),
   * in pages of `WARM_PAGE` with `WARM_CONCURRENCY` key reads at a time. A destroyed key is skipped; a key-store outage throws. A user
   * whose stored handle does not match their key (`HandleMismatchError`) is skipped too: one corrupted row must not fail the boot for every
   * user (the spec only requires failing on a key-store outage). The skips are reported once, by class and count, never by user.
   */
  async warm(): Promise<number> {
    const pageSize = this.options.warmPage ?? WARM_PAGE;
    let after = NIL_UUID;
    let warmed = 0;
    let mismatched = 0;
    const report = () => {
      if (mismatched > 0)
        console.warn("id keys: users skipped at warm-up", {
          reason: "HandleMismatchError",
          count: mismatched,
        });
    };
    for (;;) {
      const page = await guarded(() => this.store.page(after, pageSize));
      for (let i = 0; i < page.length; i += WARM_CONCURRENCY) {
        const loaded = await Promise.all(
          page.slice(i, i + WARM_CONCURRENCY).map(async (u) => {
            try {
              return await this.loadKey(u.userId, u.handle);
            } catch (err) {
              if (!(err instanceof HandleMismatchError)) throw err;
              mismatched += 1;
              return null;
            }
          }),
        );
        warmed += loaded.filter((e) => e !== null).length;
      }
      const last = page[page.length - 1];
      if (page.length < pageSize || !last) {
        report();
        return warmed;
      }
      after = last.userId;
    }
  }

  /**
   * Loads an EXISTING user's id key without minting anything: the reader of a user's old and new ids (a status page, a lineage head)
   * calls it first. False when the user has no handle yet (every id of theirs is old-format, which needs no key) or the key is gone.
   */
  async load(who: { tenantId: string; userId: string }): Promise<boolean> {
    const cached = this.byUser.get(who.userId);
    if (cached) return !this.isRetiring(cached.ids.handle);
    const handle = await guarded(() => this.store.read(who));
    if (handle === null) return false;
    return (await this.ensureHandle(handle)) !== null;
  }

  /** Whether a handle is cached (a synchronous check, for the code that gates a fold on `ensureHandle`). */
  knows(handle: string): boolean {
    return this.byHandle.has(handle);
  }

  /** Drops what a destroyed subject key leaves: the user's cache entry for a user UUID, the entry of a handle for an `h_<H>` subject. */
  forgetSubject(subjectId: string): void {
    const handle = subjectId.startsWith("h_") ? subjectId.slice(2) : null;
    if (handle === null) {
      this.forget(subjectId);
      return;
    }
    this.cancel(`h:${handle}`);
    const entry = this.byHandle.get(handle);
    if (entry) this.forget(entry.ids.userId);
    // The user's data key may outlive the handle's subject key (the erasure destroys them in turn): `loadKey` and `mintKey` read the key
    // store's durable tombstone for `h_<handle>`, so nothing here needs to remember the retirement.
  }

  /**
   * The erasure is about to shred the `h_<handle>` subject: until `unretireHandle`, nothing hands out this handle's builders (`cached`,
   * `load`, `ensureUser` and `ensureHandle` refuse, and an in-flight fetch does not cache). The cache entry itself is kept, so a shred that
   * parks (the key is alive, the retried stop must name the `h_` runs) resumes from the cache once it is un-retired.
   */
  retireHandle(handle: string): void {
    this.retiring.set(handle, (this.retiring.get(handle) ?? 0) + 1); // nests: overlapping shreds of one handle
    this.cancel(`h:${handle}`);
  }

  /** The shred call returned (or threw): from here the key store's durable tombstone answers for a destroyed key. */
  unretireHandle(handle: string): void {
    const n = (this.retiring.get(handle) ?? 0) - 1;
    if (n > 0) this.retiring.set(handle, n);
    else this.retiring.delete(handle);
  }

  /** Drops a user from the cache (erasure, after the key is destroyed). */
  forget(userId: string): void {
    this.cancel(`u:${userId}`);
    this.inflight.delete(userId);
    const entry = this.byUser.get(userId);
    if (entry) this.byHandle.delete(entry.ids.handle);
    this.byUser.delete(userId);
  }

  /** The user's builders if cached, else undefined. For code that cannot await; a miss is a bug in the caller's entry point. */
  cached(userId: string): UserIds | undefined {
    const entry = this.byUser.get(userId);
    return entry && !this.isRetiring(entry.ids.handle) ? entry.ids : undefined;
  }

  /** What an execution or conversation id names, or null (unknown shape, unknown handle, a token that fails authentication). */
  parse(id: string): ParsedId | null {
    return this.resolve(shapeOfExecution(id));
  }

  /** Phase 2 reader (no production caller yet; the tests cover it). What a lineage line's experience id names (`visuals-...` or `turnvisuals-...`). */
  parseLineage(id: string): ParsedId | null {
    return this.resolve(shapeOfLineage(id));
  }

  private resolve(shape: ReturnType<typeof shapeOfExecution>): ParsedId | null {
    if (shape === null) return null;
    if (shape.format === "legacy") return shape.parsed;
    const s: OpaqueShape = shape.shape;
    const entry = this.byHandle.get(s.handle);
    if (!entry) return null;
    const open = (family: TokenFamily, token: string | undefined) =>
      token === undefined ? undefined : openToken(entry.key, family, token);
    const documentId = open("doc", s.documentToken);
    const chatId = open("chat", s.chatToken);
    if (documentId === null || chatId === null) return null;
    return {
      format: "opaque",
      family: s.family as IdFamily,
      userId: entry.ids.userId,
      ...(documentId !== undefined && { documentId }),
      ...(chatId !== undefined && { chatId }),
      ...(s.generation !== undefined && { generation: s.generation }),
      ...(s.rerun !== undefined && { rerun: s.rerun }),
      ...(s.ord !== undefined && { ord: s.ord }),
    };
  }
}
