# Opaque execution and lineage ids, R14 (design)

Date: 2026-11-10. Status: approved; amended after the phase 1 pre-flight scan (see the "Amendments" notes in §2, §4, §6 and §8: HMAC-SHA256 synthetic IV with AES-256-CTR in place of AES-SIV, a shape-only subject, the snapshot pruner in phase 1, mixed history tested piecewise, sealed flow inputs, and the tombstone scrub).

## 1. Goal

After a user is erased, the Loom execution ids and lineage ids left behind must reveal nothing linkable: no user, document or chat UUID. Today these ids are stored in plaintext, survive erasure and carry raw UUIDs, for example `u_<userId>:visualize-<documentId>`, `u_<userId>.c-<chatId>` and `visuals-<userId>-<documentId>`.

The record of how many runs happened and when may remain. Removing that too would need a Loom change (see §7).

## 2. Decisions

| Id | Decision |
|---|---|
| O1 | **Keyed, reversible pseudonyms.** No lookup table of ids. |
| O2 | **A per-user id key.** It is derived with HKDF from the user's data key, under a label distinct from every other derived key, and cached in memory once derived. |
| O3 | **A user handle.** `H = base32(HMAC(idKey, "user"))`, 128 bits. It is stored in a new `users.id_handle` column (nullable, unique; migration 0038). The handle is created lazily on the user's first new-format start. New ids use `h_<H>` where they used `u_<userId>`. |
| O4 | **Id tokens.** Document and chat ids become `base32(IV || AES-256-CTR(encKey, IV, uuid))`: deterministic, authenticated, and reversible while the key exists. Generation (`.g`), run (`-rN`) and chat ordinal stay in clear. **Amendment:** RFC 5297 AES-SIV is not in `node:crypto` and the repo takes no cipher library, so the token is the SIV composition from Node primitives: `IV = HMAC-SHA256(macKey, family \|\| 0x00 \|\| uuid)[0..16]`, with `macKey` and `encKey` separate HKDF outputs under `docmind-id-v1/mac` and `docmind-id-v1/enc`. Decryption recomputes the IV and compares it in constant time, which is the authentication. The family (`doc` or `chat`) is authenticated with the token. This is not RFC 5297's CMAC-based S2V and claims no interoperability with it. |
| O5 | **One module, `opaqueIds`.** It builds and parses every id family in both the old and the new format. A ratchet test forbids any other code from building or parsing ids. |
| O6 | **Loom subject.** It is `h_<H>` for new ids and the user UUID for old ids. Erasure destroys both subject keys, the user's data key and the handle. |
| O7 | **Compatibility.** Old `u_` executions keep working indefinitely, through dual-format parsing. New runs use the new format from deploy. There is no backfill. The old ids stay readable after erasure; this is a documented residual. |
| O8 | **Two phases, one PR each.** Phase 1 covers the core, migration 0038, dual parsing everywhere, the document flows and the snapshot pruner. Phase 2 covers the chat flows. **Amendment:** the pruner moved to phase 1 (it only walks id ranges, and both ranges are needed as soon as an `h_` run exists). |

Rejected:
- A one-way HMAC plus a sealed lookup table. Every parse would become a database read, and the table would need to stay consistent.
- A random handle table with a separate scheme for document and chat ids.
- An upstream Loom change that makes the erasure subject explicit. It would be the cleanest, but it blocks on upstream. It stays an option for §7.

## 3. Id shapes

| Family | Old | New |
|---|---|---|
| Ingest | `u_<u>:ingest-<d>[.g]` | `h_<H>:ingest-<D>[.g]` |
| Document visuals | `u_<u>:visualize-<d>[.g][-rN]` | `h_<H>:visualize-<D>[.g][-rN]` |
| Turn visuals | `u_<u>:visualize-turn-<c>-<ord>[-rN]` | `h_<H>:visualize-turn-<C>-<ord>[-rN]` |
| Suggest tags | `u_<u>:suggest-tags-<d>-rN` | `h_<H>:suggest-tags-<D>-rN` |
| Chat title | `u_<u>:chat-title-<c>` | `h_<H>:chat-title-<C>` |
| Chat conversation | `u_<u>.c-<c>[~n]` | `h_<H>.c-<C>[~n]` |
| Document lineage | `visuals-<u>-<d>` | `visuals-<H>-<D>` |
| Turn lineage | `turnvisuals-<u>-<c>-<ord>` | `turnvisuals-<H>-<C>-<ord>` |

`D` and `C` are tokens. Every new id stays well under Loom's 1024-byte limit (about 100 bytes). The old and new forms are distinguishable by their prefix and by token length.

## 4. Parsing and the key cache

- `opaqueIds.parse(id)` returns `{ userId, documentId? , chatId?, generation?, run?, ord? }` or `null`. It is synchronous.
  - For an `h_` id, it looks up the handle in an in-memory map from handle to user id and id key, then decrypts the token.
  - An unknown handle, or a token that fails authentication, gives `null`.
  - **Amendment:** `subjectOfExecution` does not depend on the cache. The subject is shape-only: `h_<H>` for an `h_<H>...` id, the user UUID for a `u_<uuid>...` id, and "no subject" for a lineage id of any other shape. A cache-dependent subject would make a replica that has not seen a user refuse that user's legitimate events (recovery, a second replica) and would make the subject index miss at hydrate. Only `opaqueIds` builds a new-format id, and only after the user's key and handle exist; a forged handle gets a fresh subject key that no user owns. The id of an erased user parses to `null` (handle gone, key destroyed), and the stores refuse to write under a destroyed subject key.
- **Cache fill.**
  - A start fills the cache for its user.
  - Boot warms it for every user that has a recoverable or in-flight execution, before recovery, the status fold or any observer runs.
  - A miss outside boot does an async lookup of `users.id_handle` and derives the key, through an awaited `opaqueIds.ensure(handle)` at the async entry points.
- **Parsers that move to `opaqueIds`:**
  - the status fold (ingest/visualize key, scope and generation);
  - the visuals-run recorder and re-run/re-extract;
  - chat scope, activity and the reasoning store;
  - the turn trigger (`turnSettledObserver`);
  - the snapshot pruner;
  - the subject index.
- **Prefix walks cover both `u_<uuid>` and `h_<H>`:**
  - the erasure subject index;
  - forget-user;
  - erasure's deletion of Loom timers and leases;
  - status queries;
  - the snapshot pruner.
- **SQL** must no longer build execution ids. `ui/connections.ts` will store or compute the ingest execution id in application code. The plan chooses between the two.

## 5. Failures

- A key-store outage while deriving the id key fails the start, which is retried like any other key outage. A start never falls back to a plaintext-UUID id.
- The handle insert races are settled by the unique constraint. On a conflict, re-read the stored handle; it must equal the derived one.
- An id from an erased user (handle gone) parses to `null`, and nothing is written under it.

## 6. Privacy and erasure

- No new execution id, lineage id, Loom timer or lease row, or log line contains a plain user, document or chat UUID.
- **Amendment, flow inputs:** every flow's start input and step inputs carry `userId` and `documentId` or `chatId` in plaintext in the event log. Phase 1 seals those four fields under the subject key, so a new run's events hold no plain UUID after erasure.
- **Amendment, tombstones:** a read-model tombstone nulls `state` only and keeps `scope` (the user UUID) and `app_key` (the document UUID) beside the `h_<H>` execution id. Erasure scrubs `scope` and `app_key` on the erased rows under `h_<H>` (in the `rows` step, before the handle is deleted), so no row links the handle to a UUID.
- Erasure:
  1. Computes or reads `H` while the keys exist.
  2. Stops and cancels executions under both prefixes. A stop repeated after a park (the shred of the user subject parked behind a running turn, after the `h_<H>` subject was already shredded) cancels only under subjects whose key is still alive: the `h_<H>` subject key's durable tombstone (`wasDestroyed`) marks the handle retired, so no `h_<H>` id is built for it. The shred said `erased` for it, so it has no run left, and Loom would otherwise refuse the cancel and append an `EXECUTION_DENIED` naming the actor's UUID on the `h_` stream.
  3. Destroys the data key, the `h_<H>` subject key and the cached id key.
  4. Deletes `users.id_handle` along with the user.

  After erasure, new-format ids are unlinkable.
- **Residual:**
  - Old-format ids, those from runs before deploy, stay readable.
  - Run counts and timing remain as records.
  - After a read-model rebuild, an erased handle's executions refold to neutral live rows (empty `state`, null `scope` and `app_key`) that carry only the `h_<H>` execution id, which holds no UUID. The handle's prefix can no longer be walked to tombstone them.
  - Another process keeps an erased user's id key in its cache until it restarts or a load miss evicts it: erasure calls `forgetSubject` only in the erasing process (no cross-process forget). If that process folds an event of the erased user's `h_` execution it can write `scope` and `app_key` beside the handle again. With one replica this cannot happen; with N replicas see `docs/design/cloud-scaling.md` §4 (S9).
  - The same stale entry skips the durable destroyed-key check (`wasDestroyed(h_<H>)`) on a cache hit, so such a replica could rebuild an erased user's `h_` ids and issue a cancel that Loom denies with the actor's id in the clear, until it restarts. A single replica is covered by `forgetSubject` eviction; multi-replica needs the S9 fix (cross-process forget) first.
  - The `data_keys` tombstone of `h_<H>` is written with a fixed `created_at` and `destroyed_at` (the epoch, migration 0038's `key_destroy`), so it cannot be paired with the user's tombstone by time. The ERASURE_PENDING pairing residual is closed (Loom PR #778): the eraser calls `eraseSubject` with `record: false`, so a park appends nothing to Loom's plaintext, never-cleared `__loom_erasure__` stream (the eraser keeps its own durable request and re-calls until `erased`, so nothing relied on Loom completing a recorded park), and `compliance.erase.controlStreamKey` makes every row there that names a subject carry `{ subjectRef: "hmac-sha256:<hex>", keyId }` instead of the subject id. The key is HKDF-SHA256 over the KEK with the info label `docmind-erasure-control-v1` (`erasure/controlKey.ts`), and the previous KEK's derived key is passed as `previousControlStreamKeys` while a rotation is under way (docs/operations/rotate-kek.md). It must stay secret: with it, anyone can test a guessed id against a `subjectRef`. Parks recorded before this change stay in that stream as plaintext `ERASURE_PENDING { subjectId }` rows (Loom cannot rewrite them), so a pre-deploy pair of parked subjects remains linked. Remaining Loom residuals on that stream: its rows list what they delete, so a dedup blob cited by both subjects shows the same content address under both digests; sender-redaction rows repeat the same streamId; and the execution ids in archive rows are new-format (`h_<H>:...`) for new runs.
  - Until phase 2, a chat's executions and its turn visuals lineage (`__loom_ui_lineage__:turnvisuals-<user>-<chat>-<ord>`) keep old-format ids that name the user and the chat. Their content is sealed under the destroyed key. The phase 1 end-to-end scan (`opaqueIds.e2e.pg.test.ts`) therefore proves "no linkable id" for the document flows and the `h_` handle only; the chat's old-format ids are an allow-listed residual there.
- `cloud-deploy.md` notes that rolling back past the first `h_` run is unsafe: older code can't parse new ids. The alternative is to roll forward with a fix release, because restoring the pre-0038 sweep functions would also orphan every `h_` run.

## 7. Out of scope

- A Loom purge or rewrite of an erased user's execution records (ids, counts, timing). This would be a possible later request to loom-ba.
- Backfilling or renaming old `u_` executions.
- Ids outside Loom, such as HTTP access logs or URLs with document ids.

## 8. Testing

- **Unit:**
  - token round trip, determinism and tamper rejection (the HMAC-SHA256 synthetic IV with AES-256-CTR construction), with pinned known-answer vectors;
  - handle derivation and domain separation;
  - building and parsing every family in both formats;
  - the byte limit;
  - parse of an unknown handle or a bad token gives `null`.
- **Ratchet:** no code outside `opaqueIds` builds or parses ids, extending `executionIds.test.ts`.
- **Postgres:**
  - `users.id_handle` is unique, and the insert race behaves as in §5;
  - erasure destroys both keys, deletes the handle and covers both prefixes;
  - after erasure, a full scan of Loom's tables (executions, events, timers, leases, snapshots, lineage) contains none of the user's, documents' or chats' UUIDs from new runs.
- **Recovery:** after a restart with a cold cache, `h_` runs are recovered and their status folds correctly.
- **Mixed history:** a user with both old and new runs. Check status, re-run, re-extract-once, connections and erasure. **Amendment:** phase 1 tests these piecewise (candidates for reads and cancels, the sweeps with a stored old id, the status fold of both formats, connections, erasure of both prefixes) rather than as one scenario test.
- **End to end:**
  - Phase 1: upload, visualize, suggest tags, then erase; nothing linkable remains, including no row that holds both the handle and any UUID.
  - Phase 2: chat, title, turn visuals, then erase; the same holds.
- **Browser check before each PR.**
