# Opaque execution and lineage ids, R14 (design)

Date: 2026-11-10. Status: draft for review.

## 1. Goal

After a user is erased, the Loom execution ids and lineage ids left behind must reveal nothing linkable: no user, document or chat UUID. Today these ids are stored in plaintext, survive erasure and carry raw UUIDs, for example `u_<userId>:visualize-<documentId>`, `u_<userId>.c-<chatId>` and `visuals-<userId>-<documentId>`.

The record of how many runs happened and when may remain. Removing that too would need a Loom change (see §7).

## 2. Decisions

| Id | Decision |
|---|---|
| O1 | **Keyed, reversible pseudonyms.** No lookup table of ids. |
| O2 | **A per-user id key.** It is derived with HKDF from the user's data key, under a label distinct from every other derived key, and cached in memory once derived. |
| O3 | **A user handle.** `H = base32(HMAC(idKey, "user"))`, 128 bits. It is stored in a new `users.id_handle` column (nullable, unique; migration 0038). The handle is created lazily on the user's first new-format start. New ids use `h_<H>` where they used `u_<userId>`. |
| O4 | **Id tokens.** Document and chat ids become `base32(AES-SIV(idKey, uuid))`: deterministic, authenticated, and reversible while the key exists. Generation (`.g`), run (`-rN`) and chat ordinal stay in clear. |
| O5 | **One module, `opaqueIds`.** It builds and parses every id family in both the old and the new format. A ratchet test forbids any other code from building or parsing ids. |
| O6 | **Loom subject.** It is `h_<H>` for new ids and the user UUID for old ids. Erasure destroys both subject keys, the user's data key and the handle. |
| O7 | **Compatibility.** Old `u_` executions keep working indefinitely, through dual-format parsing. New runs use the new format from deploy. There is no backfill. The old ids stay readable after erasure; this is a documented residual. |
| O8 | **Two phases, one PR each.** Phase 1 covers the core, migration 0038, dual parsing everywhere and the document flows. Phase 2 covers the chat flows and the snapshot pruner. |

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
  - An unknown handle, or a token that fails authentication, gives `null`. `subjectOfExecution` then answers "no subject", and the encrypting stores refuse to write under it.
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
- Erasure:
  1. Computes or reads `H` while the keys exist.
  2. Stops and cancels executions under both prefixes.
  3. Destroys the data key, the `h_<H>` subject key and the cached id key.
  4. Deletes `users.id_handle` along with the user.

  After erasure, new-format ids are unlinkable.
- **Residual:**
  - Old-format ids, those from runs before deploy, stay readable.
  - Run counts and timing remain as records.
- `cloud-deploy.md` notes that rolling back past the first `h_` run is unsafe: older code can't parse new ids.

## 7. Out of scope

- A Loom purge or rewrite of an erased user's execution records (ids, counts, timing). This would be a possible later request to loom-ba.
- Backfilling or renaming old `u_` executions.
- Ids outside Loom, such as HTTP access logs or URLs with document ids.

## 8. Testing

- **Unit:**
  - AES-SIV round trip, determinism and tamper rejection;
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
- **Mixed history:** a user with both old and new runs. Check status, re-run, re-extract-once, connections and erasure.
- **End to end:**
  - Phase 1: upload, visualize, suggest tags, then erase; nothing linkable remains.
  - Phase 2: chat, title, turn visuals, then erase; the same holds.
- **Browser check before each PR.**
