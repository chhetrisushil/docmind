# Opaque Execution and Lineage Ids, Phase 1 (R14) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every execution id and lineage id that the document flows create (ingest, visualize-document, suggest-tags, the document visuals line) carry no user, document or chat UUID, by building them as keyed, reversible pseudonyms, while every parser in the server already reads both the old and the new shape (chats included), so phase 2 only switches the chat builders.

**Architecture:** One module, `apps/server/app/opaqueIds/`, builds and parses every id family in both formats. A new-format id is `h_<H>` for the user (`H` = a 128-bit handle from the user's id key, stored in `users.id_handle`) plus `base32(IV || AES-256-CTR(uuid))` tokens (a synthetic-IV seal under keys derived from the user's data key); generation, run and ordinal stay in the clear. Synchronous parsers read a process-wide in-memory key cache that boot warms, that every async entry point fills on a miss, and that never needs a key for classification, generation or the erasure subject. SQL stops building ids: the application stores each document's current ingest and visualize execution ids in two new `documents` columns. Erasure covers both id formats and both Loom subjects (the user's UUID and `h_<H>`).

**Tech Stack:** TypeScript, Node `crypto` (HKDF, HMAC-SHA256, AES-256-CTR), Postgres (RLS, `withTenant`, SECURITY DEFINER functions), Loom (`@loom/plugin-crypto` KeyStore and encrypting stores, `@loom/compliance` subject index, `@loom/plugin-read-model`), vitest, pnpm/turbo, biome.

**Spec:** `docs/specs/2026-11-10-opaque-ids-design.md` (binding; read it first). Phase 2 (a separate later plan) switches the chat builders (conversation, chat-title, visualize-turn, turn lineage) and their call sites.

## Pre-flight record (read before starting)

Every existing name in this plan was verified against the code at `main` 875fe1e (this worktree's base) and Loom pin 4af27eaa. The id module, the migration and the stores in Tasks 1 and 2, the subject mapping and the ensure gate in Tasks 3 and 4 were compiled and run in a scratch copy first (vitest, `tsc`, biome, and the Postgres suites against the test cluster); the rest of Tasks 3 to 7 (the eraser, wire and pg steps, the parsers, the starters, connections, the ratchet) was applied in a working copy and its unit and focused pg suites run, and the existing suites were migrated there by the scripts in Task 5 step 5. The Task 5 stack helper (`runIds`) and the Task 8 end-to-end test and harness edits were typed against the code as read and are proved by their own test steps. The full Postgres suite was not run to completion on the final state: the first run's failures were all of the two kinds Task 5 step 6 names (a test reading a real run by its old-format id, a test seeding a status row without the stored id). Findings that shape the plan:

| Id | Finding | Where handled |
|---|---|---|
| F1 | **AES-SIV (hard question 1).** Node here is 24.18 (`engines`: `>=22.13.0`, no `.nvmrc`). `crypto.getCiphers()` lists `aes-128/192/256-ctr` and no `siv`: RFC 5297 AES-SIV is not in `node:crypto`. `pnpm-lock.yaml` has no `@noble/*` or any cipher library (the server's direct dependencies are `busboy`, `pg`, `zod` and the sibling Loom and loom-ui links), and this plan adds none: a dependency that holds a key-handling primitive for one call site is a supply-chain surface the repo has avoided, and Loom itself builds its sealed format from `node:crypto` primitives with a synthetic IV (`plugins/crypto/src/EncryptingContentStore.ts`, "an SIV over the associated data: HMAC(ivKey, ...)"). **Decision:** the standard SIV composition from `node:crypto`: `IV = HMAC-SHA256(macKey, family || 0x00 || uuid)[0..16]`, `token = base32(IV || AES-256-CTR(encKey, IV, uuid))`, decryption recomputes the IV and compares in constant time (that is the authentication). `macKey` and `encKey` are separate HKDF outputs (explicit key separation), the family (`doc` or `chat`) is authenticated with the token, and the handle is a third use of the root key under its own label. Known-answer vectors are pinned in `siv.test.ts` (computed from this construction; the base32 alphabet is checked against the RFC 4648 vectors `foobar` and `ff ff`). The spec says "AES-SIV"; this is the SIV construction with AES-256-CTR as the cipher and HMAC-SHA256 as the PRF, not RFC 5297's CMAC-based S2V. | Task 1 |
| F2 | **Key derivation (hard question 2).** `TagKeys.forUser` and `EntityKeys.forUser` (`crypto/tagKeys.ts`, `crypto/entityKeys.ts`) take the user's data key from the KeyStore (`getOrCreate(userId)` for a tag, which can be a first write; `get(userId)` for an entity read) and derive `Buffer.from(hkdfSync("sha256", dek, Buffer.alloc(0), INFO, 32))` with `INFO` = `docmind-tag-v1` and `docmind-entity-v1`, mapping a store failure to `FieldKeyStoreError` and a destroyed key to `FieldKeyUnavailableError`. The id key is the same mechanism with `docmind-id-v1`; its two sub-keys use `docmind-id-v1/mac` and `docmind-id-v1/enc`. `OpaqueIds.ensureUser` mints through `getOrCreate` (a start can be the user's first write) and `OpaqueIds.ensureHandle` and `load` read through `get` (a reader never mints). | Task 1 |
| F3 | **Loom subject `h_<H>` (hard question 3).** `public.data_keys.subject_id` is `text` (0007) and `PostgresKeyStore` keys, wraps (AAD = subject) and destroys by that string, so `h_<H>` gets its own key exactly as the existing `x:<id>` subjects do. `EncryptingEventStore`, `EncryptingSnapshotStore` and `EncryptingContentStore` take the subject from `subjectOfExecution` (`storage.ts`), so every event, snapshot and lineage blob of an `h_<H>...` execution is sealed under `h_<H>`'s key. Loom's `eraseSubject(subjectId)` groups by `SubjectIndex.executionsOf(subjectId)` and calls the app's shredder, which runs `shredSubject(keys, raw.eventStore, first, { subjectId, executionIds, ... })` and destroys THAT subject's key: one call per subject. So erasure calls `eraseSubject` for `h_<H>` and for the user UUID; the `key` step still destroys the user's data key; the `rows` step destroys `h_<H>`'s key before it deletes the row that holds the handle; and `OpaqueIds.forgetSubject` evicts the cache after each destroy. The KeyStore tombstones (`data_keys` rows with `wrapped_dek` NULL and `destroyed_at`) remain for both subjects, so a later `getOrCreate` refuses to re-mint. Residual, noted in the docs: the two tombstones carry near-equal `destroyed_at`, so someone holding the table and a quiet erasure window could pair `h_<H>` with a user UUID by time alone. | Tasks 3, 8 |
| F4 | **Cache (hard question 4).** `OpaqueIds` keeps `handle -> {userId, key}` and `userId -> same`. **Classification, the ingest generation, the run number and the erasure subject never need the key** (they are in the clear in both formats), so `isIngestExecution`, `generationOf`, recovery ownership, compaction exemption, the pruner and `subjectOfExecution` cannot miss on a cold cache. Only the user and document or chat ids need it (the status fold's key and scope, the run recorder, the ready hook, chat scope and activity). Fill paths: a start awaits `ensureUser`; a reader awaits `load` (no minting); the boot awaits `warm()` (every user with a handle, in pages of 500, 8 key reads at a time, before the status model boots, so before recovery, the fold or any observer; a destroyed key is skipped, a key-store outage fails the boot with the fixed label); a live event whose handle is not cached goes through `ensureGate` (`status/ensureGate.ts`), which queues it and everything behind it, awaits `opaqueIds.ensure(handle)` and only then folds, so log order holds and a cold user's `ready` is folded and still fires `onReady`; an `ensure` that keeps failing is reported by class and the event is left for the next boot's catch-up (never folded under an unknown user, which would store a row no reader sees). The ready hook awaits `ensure` itself and reports an identity it cannot resolve instead of returning silently. A parse that misses answers `null`. | Tasks 1, 4, 6 |
| F5 | **Flow hashes (hard question 5).** Loom's `flowContentHash` (`packages/core/src/flowHash.ts` at 4af27eaa) hashes `definition.id`, `version`, `deadlineMs` and each step's `id`, tool id, timeout and retry, and nothing else: no execution id, no input, no handler. So the id format changes no hash and no flow version moves. Pinned with the real function: `visualize-document` 1.1.0 `sha256:d3bfb104f3d015ab8165a9784f5f958bd46a347f3a2fb66f4d0d7be6c4e25f9e` and `ingest-document` 3.0.0 `sha256:e9c2819cd68e5b3d2bae57d5ef9e7d55af3067a99db66e225b00f0adfa864dc4` (both already pinned by `flowHash.test.ts` in their folders; Task 5 re-runs them), and new pins for `suggest-tags` 1.0.0 `sha256:3d99db0fdaf88f4bbeb69d371610811f5fcf57d208ff31494e2235d81490189b` and `chat-title` 1.0.0 `sha256:f56568832761a1d68e89a5daf6b8edcf299eeadce26c916438f5f83a2cfa2007` (computed on `main`). | Task 5 |
| F6 | **SQL builds ids in six places, not one (hard question 6).** `ui/connections.ts` (`EXEC_KEY`) and five SECURITY DEFINER functions: `docmind_stale_uploads_v2` (0024), `docmind_ready_documents` (0028), `docmind_visual_retry_documents` (0030), `docmind_visual_stale_format_documents` (0032) and `docmind_visual_unrecorded_documents` (0034) each build `'u_' \|\| owner \|\| ':ingest-' \|\| doc ...` (and `:visualize-`) to look up the status row. A new-format id cannot be built in SQL (it needs the user's key), and the sweeps run across tenants with `LIMIT`, so filtering in application code after the page is cut would starve the page. **Decision: store.** Migration 0038 adds `documents.ingest_execution_id` and `documents.visualize_execution_id` (the current generation's ingest id and visualize run-0 id); the application records the id it starts (`documents/executionIds.ts`, called before the start, so a crash leaves a recorded id with no status row, which the sweep lists and re-starts); `bumpGeneration` clears both with the generation; the six sites compare the column. A document whose current generation already has an old-format status row is backfilled with that exact old id, so a run in flight at deploy stays found. Computing in application code was rejected for connections too: it needs a second query per request and a LIMIT-correct over-fetch, for no gain, while a plain column in the lateral subquery's output keeps the "leakproof comparison" property the existing comment relies on. | Tasks 2, 5, 6 |
| F7 | **Prefix walks.** Five sites walk `u_<uuid>`: `erasure/compliance.ts` (hydrate), `status/forgetUser.ts`, `erasure/pgSteps.ts` (`loom.timers`/`loom.leases`), `status/pgStores.ts` (`pgUserExecutions`), `snapshots/pruner.ts`. Each now walks `u_` and `h_` (the pruner and hydrate by range, the others by `u_<uuid>` and `h_<H>` prefixes from `opaqueIds/prefixes.ts`). The handle is read from `users.id_handle` BEFORE the row is deleted: `pgSteps.rows` deletes timers and leases first, and the eraser reads the handle for the `shred` and `readModels` steps and destroys `h_<H>`'s key in the `rows` step. A re-run after the row is gone finds the work already done (each step is idempotent and ordered so). | Task 3 |
| F8 | **Spec deviation, flagged.** Spec section 4 says an unknown handle makes `subjectOfExecution` answer "no subject" so the stores refuse the write. A subject that depends on the cache would make a replica that has not seen a user refuse that user's legitimate events (recovery, a second replica) and would make the subject index miss at hydrate. This plan makes the subject depend on the id's shape only (`h_<H>` for `h_<H>...`), keeps "no subject" for a lineage id of any other shape, and relies on the fact that only `opaqueIds` builds a new-format id and only after the user's key and handle exist (`ensureUser`); a forged handle gets a fresh subject key that no user owns. The id of an erased user parses to `null` (handle gone, key destroyed), which is the part of the spec that matters for erasure. | Tasks 1, 3 |
| F9 | **Phase boundary.** The document flows move to the new format in this phase. The chat builders (`chatConversationId`, `turnExecutionId`, `turnExperienceId`, the chat-title start) keep building the old format through `legacyIds`, but every PARSER already reads the new chat shapes (`h_<H>.c-<C>[~n]`, `h_<H>:chat-title-<C>`, `h_<H>:visualize-turn-<C>-<ord>[-rN]`, `turnvisuals-<H>-<C>-<ord>`), the chat activity model and the run gate use the ensure gate, the erasure cancels both formats for chats, and the snapshot pruner walks both ranges. The remaining phase 2 work is listed at the end of this plan. | Tasks 3, 4, 7 |
| F10 | **Not covered by the spec's list, noted.** `public.read_model_state` (DocMind's table, not Loom's) keeps `app_key` (document id) and `scope` (user id) as plain UUIDs and a tombstone keeps `scope` ("A tombstone keeps the sequence, execution id and scope", `status/ingestStatus.ts`). This is unchanged by this work and outside spec section 6's list (executions, events, timers, leases, snapshots, lineage); the existing erasure e2e already scans every column of every table for the user's ids and allows exactly this residue. | Task 8 (docs) |
| F11 | **Flow inputs carry plain ids (a gap in the spec).** Every flow's start input and every step's input is `{ tenantId, userId, documentId }` or `{ tenantId, userId, chatId }` in plaintext in `loom.events.payload` (`sensitive.ts` pins this: a test asserts "leaves an ingest execution's events untouched", and the erasure scan allow-lists it as "ids only: the flow input"). Opaque execution ids alone therefore leave the user and document UUIDs of every new run in the log after an erasure, and spec section 8's scan of Loom's tables could not pass. **Decision:** seal those four fields (`FLOW_INPUT_IDS`) under the subject key, with the proof helpers updated. Tried in a scratch copy: the erasure e2e and the ingest raw-log proof pass with it. | Task 6 |

## How the earlier scans' defects are avoided here

| Defect class | Design |
|---|---|
| Schemas capped too low | The two new columns allow 1024 characters (Loom's `MAX_EXECUTION_ID_BYTES`); every new-format id is under 140 bytes and a test asserts both. The handle column is exactly `^[a-z2-7]{26}$`; a token is exactly 52 characters; the generation (9 digits), run (3 digits) and ordinal (15 digits) patterns are copied from the code they replace. |
| Planner and sample mismatches | No planner, catalogue or sample is touched. |
| Flaky EXPLAIN tests | None added. The connections reader keeps its existing plan-shape tests (Task 6 reruns them); the only SQL change there is a column in place of an expression. |
| Random-UUID ordering | No test depends on the order of random ids or handles: pages are checked by sorted id sets, and the key-cache tests use fixed UUIDs. |
| Vacuous assertions | Every ratchet and scan has a control: the ratchet is run against a virtual file that must be flagged, the e2e scan first proves `h_` executions exist and that the user's ids are findable elsewhere, tamper tests change every character, and every "is null" has a "is not null" twin. |
| Redeclared constants | `UUID_PATTERN`, the prefixes, the generation and run bounds and the token length are declared once in `opaqueIds/` and imported; `chats/ids.ts` re-exports `UUID_PATTERN`. |
| SQL without owner and tenant predicates | `PgHandleStore.claim` and `read` and `PgExecutionRecorder` name the user, the tenant and the generation in every statement; the two cross-tenant lookups are SECURITY DEFINER functions that return ids only; the migration's backfill runs as the owner role. |
| Biome failures in pasted code | The code in Tasks 1 to 3 was run through `biome check --write` before it was pasted; each commit step runs it again. |
| Typecheck gates that need a later task | `executionIdFor` stays exported from `subject.ts` (as `legacyIds.named`) until Task 7 removes it with the last caller, so Tasks 3 to 6 each compile on their own; `ingestExecutionId`, `visualizeExecutionId` and the other old builders are removed in the task that moves their last caller. |
| Unclosed code fences | Every fence in this plan is closed; Task 8's last step counts them. |

## Global Constraints

Every task's requirements include these (copied verbatim from the spec):

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


Plan-level constraints (from the repo and this plan):

- Verification commands run from the worktree root `/Users/such/workspace/docmind/.worktrees/opaque-ids`: `pnpm typecheck`, `pnpm typecheck:tests`, `pnpm lint`, `pnpm build`, and the suites named in each task. Postgres suites need `set -a; . ./.env; set +a` first (it sets `DOCMIND_TEST_PG_URL`, a separate test cluster); **a skipped pg test is not a pass**: check the vitest summary shows the pg tests ran. The worktree has no `node_modules` of its own: run `pnpm install --frozen-lockfile` once at the root before the first command. The snippets in this plan are not pre-wrapped to biome's line width everywhere: run `pnpm exec biome check --write <the files you changed>` before each commit, and keep the code's meaning exactly as written.
- No new dependency. Node's `crypto` only (F1).
- No new-format id, lineage id, Loom timer or lease row, or log line contains a plain user, document or chat UUID (spec section 6); no `console` line prints an id (the existing redaction in `erasure/compliance.ts` learns the `h_` shape in Task 3).
- A key-store outage while deriving the id key fails the operation (the start throws, the boot fails with the fixed label); nothing falls back to an old-format id (spec section 5).
- Each task's own `pnpm typecheck && pnpm typecheck:tests && pnpm lint` passes on its own commit.
- Commit messages end with the two attribution lines given by the session (`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` and the `Claude-Session:` line).

## Plan decisions (where the spec is silent or the code constrains it)

- **Plan decision: one process-wide parser, injected builders.** Synchronous parsers (Loom's `keyOf`/`scopeOf`, the status fold, the stores' subject mapping) cannot take a constructor argument, so `opaqueIds` (the facade in `opaqueIds/index.ts`) reads one instance that `compose.ts` installs (`opaqueIds.install`). An old-format id parses with no instance. Builders are NOT global: every starter takes a `UserIdSource` (`ids`) and awaits `ensureUser`, so a test passes its own.
- **Plan decision: which format a start uses.** From deploy every NEW execution of a document flow is new-format (spec O7). A start never looks for an old-format twin: the generations make ids unique (a retry or re-ingest bumps the generation and clears the stored ids), and the sweeps only list documents with no status row under the stored id. Reads and cancels use CANDIDATES: the old-format id and, when the user has a handle, the new-format id.
- **Plan decision: the lineage line of a document.** New commits go to the new line (`visuals-<H>-<D>`). A read tries the new line first and falls back to the old one, so a document visualized before deploy keeps showing until its next run replaces it (the commit replaces the head's content in full, so the old line is then superseded, never merged). The old line stays readable after erasure (spec O7 residual).
- **Plan decision: boot warm covers every user with a handle.** The spec asks for users with a recoverable or in-flight execution. Loom lists executions by id prefix only, the read models rebuild by folding every execution, and one key read per user at boot is bounded by the user count, so the plan warms a superset (users with `id_handle IS NOT NULL`).
- **Plan decision: the handle is claimed with one UPDATE.** `UPDATE users SET id_handle = $1 WHERE id = $2 AND tenant_id = $3 AND id_handle IS NULL AND erasing_at IS NULL RETURNING id_handle`; a concurrent claim finds the column set, updates nothing and reads the stored value; the unique constraint is the backstop for a handle two users derived (spec section 5). A stored handle that differs from the derived one is `HandleMismatchError`.
- **Plan decision: the ratchet.** The existing start/fork ratchet (`UserExecutionId`) stays. A second scan of every non-test source file reports any string, template or regex literal that builds or parses an id (`u_`, `h_`, `:ingest-`, `:visualize-`, `:suggest-tags-`, `:chat-title-`, `.c-`, `visuals-` and `turnvisuals-` templates) or imports `LINEAGE_STREAM_PREFIX`, outside `app/opaqueIds/` and one named test-support file.

## File Structure

Created (`apps/server/app/opaqueIds/`):
- `base32.ts`: strict RFC 4648 lower-case base32.
- `siv.ts`: the id key (HKDF), the handle, the SIV token.
- `ids.ts`: the id families, both formats' shapes and builders (`UserIds`, `legacyIds`), the subject mapping.
- `opaqueIds.ts`: `OpaqueIds` (key cache, `ensureUser`, `ensureHandle`, `load`, `warm`, `forget`) and the `HandleStore` port.
- `prefixes.ts`: the user prefixes the walks use.
- `pgHandles.ts`: `PgHandleStore` on `users.id_handle`.
- `index.ts`: the facade (`opaqueIds`) and the exports.
- `testing.ts`: `MemoryHandleStore`, `testOpaqueIds`.
- Tests beside each (`siv.test.ts`, `opaqueIds.test.ts`, `prefixes.test.ts`, `pgHandles.pg.test.ts`).

Created elsewhere: `infra/migrations/0038_opaque_ids.sql`; `documents/executionIds.ts` (the recorder) and `documents/executionCandidates.ts` (old and new candidates for reads and cancels); `status/ensureGate.ts`; `db/executionIds.pg.test.ts`.

Modified: `subject.ts`, `erasure/{compliance,eraser,wire,pgSteps}.ts`, `status/{model,ingestStatus,forgetUser,pgStores}.ts`, `chats/{ids,activity,scope,reasoningStore}.ts`, `flows/visualize-turn/{trigger,ids}.ts`, `flows/visualize-document/{runs,extract,structure,deps,start,lineage,commit}.ts`, `flows/suggest-tags/start.ts`, `flows/chat-title/start.ts`, `documents/{ingest,repo,testHarness}.ts`, `ui/{connections,routes}.ts`, `snapshots/pruner.ts`, `compose.ts`, `bootIngest.ts`, `config.ts`, `erasure/e2eSupport.ts`, `executionIds.test.ts`, `docs/architecture.md`, `docs/operations/cloud-deploy.md`, and the tests named per task.

---

### Task 1: The `opaqueIds` core (O2, O3, O4, O5)

**Files:**
- Create: `apps/server/app/opaqueIds/base32.ts`, `siv.ts`, `ids.ts`, `opaqueIds.ts`, `index.ts`, `testing.ts`
- Test: `apps/server/app/opaqueIds/siv.test.ts`, `apps/server/app/opaqueIds/opaqueIds.test.ts`

**Interfaces:**
- Consumes: `KeyStore` (`@loom/plugin-crypto`: `get`, `getOrCreate`, `wasDestroyed?`), `FieldKeyStoreError` and `FieldKeyUnavailableError` (`crypto/fields.ts`), `ORD_PATTERN` (`@docmind/contracts`), `LINEAGE_STREAM_PREFIX` (`@loom-ui/lineage`), `isValidConversationId` (`@loom/conversation`), `MAX_EXECUTION_ID_BYTES` (`@loom/plugin-postgres`).
- Produces (all from `apps/server/app/opaqueIds/index.ts`):
  - `class OpaqueIds { constructor(keys: Pick<KeyStore,"get"|"getOrCreate"|"wasDestroyed">, store: HandleStore); ensureUser(who: {tenantId; userId}): Promise<UserIds>; ensureHandle(handle: string): Promise<UserIds | null>; load(who): Promise<boolean>; warm(): Promise<number>; cached(userId): UserIds | undefined; knows(handle): boolean; forget(userId): void; forgetSubject(subjectId): void; parse(id): ParsedId | null; parseLineage(id): ParsedId | null; handleOfId(id): string | null }`
  - `interface HandleStore { read(who); claim(who, handle): Promise<string>; userOf(handle): Promise<string | null>; page(after: string, limit: number): Promise<{userId; handle}[]> }`; `class HandleMismatchError`; `WARM_PAGE` (500), `WARM_CONCURRENCY` (8).
  - `class UserIds { userId; handle; ingest(documentId, generation); visualize(documentId, generation, rerun?); suggestTags(documentId, run); turnVisualize(chatId, ord, rerun?); chatTitle(chatId); conversation(chatId); documentLineage(documentId); turnLineage(chatId, ord) }` (all synchronous; `UserExecutionId` or `ChatConversationId` for executions, `string` for lineage ids).
  - `legacyIds` (the old-format builders: `named`, `ingest`, `visualize`, `suggestTags`, `turnVisualize`, `chatTitle`, `conversation`, `documentLineage`, `turnLineage`), `UUID_PATTERN`, `subjectOfId`, `subjectOfHandle(handle): string` (`h_<handle>`), `handleOfSubject`.
  - Types `UserExecutionId`, `ChatConversationId`, `IdFamily`, `ParsedId`, `ClearFields`.
  - The facade `opaqueIds`: `install(ids | undefined)`, `current()`, `parse(id)`, `parseLineage(id)`, `clear(id)` (family, generation, rerun, ord: no key), `family(id)`, `subjectOf(executionId)`, `subjectOfHandle(handle)`, `handleOf(id)`, `known(handle)`, `loadUser(who)`, `ensure(handle)`.
  - Test support (`testing.ts`): `MemoryHandleStore`, `AutoHandleStore` (registers any user it is asked about), `testOpaqueIds()` (a fresh key store, handle store and `OpaqueIds`), `DeterministicKeyStore` and `testIdSource()` (an `OpaqueIds` whose data keys are a fixed function of the user, so `deterministicUser(userId): UserIds` computes the ids a starter will build without awaiting it), and the old-format builders tests seed with: `legacyIngestId(userId, documentId, generation = 2)`, `legacyVisualizeId(userId, documentId, generation, rerun?)`, `legacySuggestTagsId(userId, documentId, run)`.

Design notes (the evidence is F1, F2 and F4 above): the new shapes are `h_<H>:ingest-<D>[.g]`, `h_<H>:visualize-<D>[.g][-rN]`, `h_<H>:visualize-turn-<C>-<ord>[-rN]`, `h_<H>:suggest-tags-<D>-rN`, `h_<H>:chat-title-<C>`, `h_<H>.c-<C>[~n]`, `visuals-<H>-<D>` and `turnvisuals-<H>-<C>-<ord>` with `H` 26 and `D`, `C` 52 characters of `[a-z2-7]`. The alphabet has no `-`, `.`, `:`, `~` or `_`, so tokens never contain a delimiter.

- [ ] **Step 1: Write the failing tests**

`apps/server/app/opaqueIds/siv.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode } from "./base32";
import { deriveIdKey, handleOfKey, openToken, sealToken } from "./siv";

const DEK = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("base32", () => {
  it("matches the RFC 4648 vectors (lower case, no padding)", () => {
    expect(base32Encode(Buffer.from("foobar"))).toBe("mzxw6ytboi");
    expect(base32Encode(Buffer.from([0xff, 0xff]))).toBe("777q");
  });
  it("decodes strictly: one spelling, an exact length, no stray characters", () => {
    expect(base32Decode("mzxw6ytboi", 6)?.toString()).toBe("foobar");
    expect(base32Decode("mzxw6ytbo", 6)).toBeNull(); // short
    expect(base32Decode("mzxw6ytboi=", 6)).toBeNull();
    expect(base32Decode("MZXW6YTBOI", 6)).toBeNull(); // upper case
    expect(base32Decode("777r", 2)).toBeNull(); // non-zero padding bits: a second spelling of 777q
  });
});

describe("the id key and the SIV token", () => {
  const key = deriveIdKey(DEK);

  it("pins the derived key, the handle and one token per family (known answers)", () => {
    expect(key.root.toString("hex")).toBe(
      "f4e3b42e90f917e3b3bdbb3479b7c6b3a1c8f0cd14996ed132a12e4e42829dc9",
    );
    expect(handleOfKey(key)).toBe("kk7zcxcciabo34q7qbcn7mlo4i");
    expect(sealToken(key, "doc", UUID)).toBe(
      "vmqd4aixfeawlpniksczeas5gmzrrsors76ejrwedakvajmt6v2q",
    );
    expect(sealToken(key, "chat", UUID)).toBe(
      "w2lj745t5q3hj6e6wa2zl7tvvwojggtt3ea5u4icpzw4brxrxjqa",
    );
  });

  it("round-trips, and is deterministic", () => {
    const token = sealToken(key, "doc", UUID);
    expect(token).toHaveLength(52);
    expect(sealToken(key, "doc", UUID)).toBe(token);
    expect(openToken(key, "doc", token)).toBe(UUID);
  });

  it("separates domains: a family, a user and the handle never collide", () => {
    const doc = sealToken(key, "doc", UUID);
    expect(sealToken(key, "chat", UUID)).not.toBe(doc);
    expect(openToken(key, "chat", doc)).toBeNull(); // a document token is not a chat token
    const other = deriveIdKey(Buffer.alloc(32, 7));
    expect(openToken(other, "doc", doc)).toBeNull(); // another user's key
    expect(handleOfKey(other)).not.toBe(handleOfKey(key));
    expect(doc.startsWith(handleOfKey(key))).toBe(false);
  });

  it("rejects every single-character change of a token (authenticated)", () => {
    const token = sealToken(key, "doc", UUID);
    const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
    for (let i = 0; i < token.length; i++) {
      const swapped = alphabet[(alphabet.indexOf(token[i] as string) + 1) % 32] as string;
      const bad = token.slice(0, i) + swapped + token.slice(i + 1);
      expect(openToken(key, "doc", bad)).toBeNull();
    }
  });

  it("refuses to seal anything but a canonical lower-case uuid", () => {
    expect(() => sealToken(key, "doc", UUID.toUpperCase())).toThrow(RangeError);
    expect(() => sealToken(key, "doc", "not-a-uuid")).toThrow(RangeError);
  });
});
```

`apps/server/app/opaqueIds/opaqueIds.test.ts`:

```ts
import { MAX_EXECUTION_ID_BYTES } from "@loom/plugin-postgres";
import { afterEach, describe, expect, it } from "vitest";
import { FieldKeyUnavailableError } from "../crypto/fields";
import { OpaqueIds, WARM_CONCURRENCY, legacyIds, opaqueIds } from "./index";
import { deterministicUser, testIdSource, testOpaqueIds } from "./testing";

const T = "00000000-0000-0000-0000-0000000000aa";
const U = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const D = "0f8fad5b-d9cb-469f-a165-70867728950e";
const C = "3a4b5c6d-7e8f-4a9b-8c1d-2e3f4a5b6c7d";

afterEach(() => opaqueIds.install(undefined));

async function userIds(user = U) {
  const t = testOpaqueIds();
  t.store.add(user, T);
  const ids = await t.ids.ensureUser({ tenantId: T, userId: user });
  return { ...t, userIds: ids };
}

describe("every family builds and parses, in both formats", () => {
  it("new format round trip (all eight families)", async () => {
    const { ids, userIds: u } = await userIds();
    opaqueIds.install(ids);
    const cases: [string, ReturnType<typeof opaqueIds.parse>][] = [
      [
        u.ingest(D, 2),
        { format: "opaque", family: "ingest", userId: U, documentId: D, generation: 2 },
      ],
      [
        u.ingest(D, 1),
        { format: "opaque", family: "ingest", userId: U, documentId: D, generation: 1 },
      ],
      [
        u.visualize(D, 3, 4),
        {
          format: "opaque",
          family: "visualize",
          userId: U,
          documentId: D,
          generation: 3,
          rerun: 4,
        },
      ],
      [
        u.visualize(D, 1),
        {
          format: "opaque",
          family: "visualize",
          userId: U,
          documentId: D,
          generation: 1,
          rerun: 0,
        },
      ],
      [
        u.suggestTags(D, 7),
        { format: "opaque", family: "suggestTags", userId: U, documentId: D, rerun: 7 },
      ],
      [
        u.turnVisualize(C, 12, 2),
        { format: "opaque", family: "turnVisualize", userId: U, chatId: C, ord: 12, rerun: 2 },
      ],
      [
        u.turnVisualize(C, 12),
        { format: "opaque", family: "turnVisualize", userId: U, chatId: C, ord: 12 },
      ],
      [u.chatTitle(C), { format: "opaque", family: "chatTitle", userId: U, chatId: C }],
      [u.conversation(C), { format: "opaque", family: "conversation", userId: U, chatId: C }],
      [
        `${u.conversation(C)}~3`,
        { format: "opaque", family: "conversation", userId: U, chatId: C },
      ],
    ];
    for (const [id, want] of cases) expect(opaqueIds.parse(id)).toEqual(want);
    expect(opaqueIds.parseLineage(u.documentLineage(D))).toEqual({
      format: "opaque",
      family: "documentLineage",
      userId: U,
      documentId: D,
    });
    expect(opaqueIds.parseLineage(u.turnLineage(C, 5))).toEqual({
      format: "opaque",
      family: "turnLineage",
      userId: U,
      chatId: C,
      ord: 5,
    });
  });

  it("old format parses with no instance installed", () => {
    expect(opaqueIds.current()).toBeUndefined();
    expect(opaqueIds.parse(legacyIds.ingest(U, D, 2))).toEqual({
      format: "legacy",
      family: "ingest",
      userId: U,
      documentId: D,
      generation: 2,
    });
    expect(opaqueIds.parse(legacyIds.visualize(U, D, 1, 3))).toEqual({
      format: "legacy",
      family: "visualize",
      userId: U,
      documentId: D,
      generation: 1,
      rerun: 3,
    });
    expect(opaqueIds.parse(legacyIds.suggestTags(U, D, 2))).toMatchObject({
      family: "suggestTags",
      rerun: 2,
    });
    expect(opaqueIds.parse(legacyIds.turnVisualize(U, C, 9))).toEqual({
      format: "legacy",
      family: "turnVisualize",
      userId: U,
      chatId: C,
      ord: 9,
    });
    expect(opaqueIds.parse(legacyIds.chatTitle(U, C))).toMatchObject({
      family: "chatTitle",
      chatId: C,
    });
    expect(opaqueIds.parse(`${legacyIds.conversation(U, C)}~2`)).toMatchObject({
      family: "conversation",
      userId: U,
    });
    expect(opaqueIds.parseLineage(legacyIds.documentLineage(U, D))).toMatchObject({
      documentId: D,
    });
    expect(opaqueIds.parseLineage(legacyIds.turnLineage(U, C, 4))).toMatchObject({ ord: 4 });
  });

  it("the old forms keep their exact text (the pre-deploy runs must stay readable)", () => {
    expect(legacyIds.ingest(U, D, 2)).toBe(`u_${U}:ingest-${D}.2`);
    expect(legacyIds.ingest(U, D, 1)).toBe(`u_${U}:ingest-${D}`);
    expect(legacyIds.visualize(U, D, 3, 2)).toBe(`u_${U}:visualize-${D}.3-r2`);
    expect(legacyIds.conversation(U, C)).toBe(`u_${U}.c-${C}`);
    expect(legacyIds.documentLineage(U, D)).toBe(`visuals-${U}-${D}`);
  });

  it("a new-format id is short and carries no uuid, user or document text", async () => {
    const { userIds: u } = await userIds();
    for (const id of [
      u.ingest(D, 2),
      u.visualize(D, 2, 999),
      u.turnVisualize(C, 999999999999999, 999),
      u.conversation(C),
      u.documentLineage(D),
    ]) {
      expect(Buffer.byteLength(id)).toBeLessThan(140);
      expect(Buffer.byteLength(id)).toBeLessThanOrEqual(MAX_EXECUTION_ID_BYTES);
      expect(id).not.toContain(U);
      expect(id).not.toContain(D);
      expect(id).not.toContain(C);
      expect(id).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
    }
  });

  it("refuses bad inputs", async () => {
    const { userIds: u } = await userIds();
    expect(() => u.ingest(D.toUpperCase(), 2)).toThrow(RangeError);
    expect(() => u.ingest(D, 0)).toThrow(RangeError);
    expect(() => u.visualize(D, 1_000_000_000)).toThrow(RangeError);
    expect(() => u.visualize(D, 1, 1000)).toThrow(RangeError);
    expect(() => u.turnVisualize(C, 0)).toThrow(RangeError);
    expect(() => legacyIds.ingest("nope", D, 1)).toThrow(RangeError);
  });
});

describe("parse answers null, never a wrong id", () => {
  it("an unknown handle, a cold cache and a tampered token", async () => {
    const { ids, userIds: u } = await userIds();
    const id = u.ingest(D, 2);
    expect(opaqueIds.parse(id)).toBeNull(); // not installed: a cold cache
    opaqueIds.install(ids);
    expect(opaqueIds.parse(id)).toMatchObject({ documentId: D });
    ids.forget(U);
    expect(opaqueIds.parse(id)).toBeNull(); // the user is forgotten (erased)
    const other = testOpaqueIds();
    other.store.add(U2, T);
    await other.ids.ensureUser({ tenantId: T, userId: U2 });
    opaqueIds.install(other.ids);
    expect(opaqueIds.parse(id)).toBeNull();
  });

  it("a token of the wrong family or from another user fails authentication", async () => {
    const { ids, userIds: u } = await userIds();
    opaqueIds.install(ids);
    const doc = u.ingest(D, 2);
    const asChat = doc.replace(":ingest-", ":chat-title-").replace(/\.2$/, "");
    expect(opaqueIds.parse(asChat)).toBeNull();
    const swapped = doc.replace(/ingest-[a-z2-7]{52}/, `ingest-${"a".repeat(52)}`);
    expect(opaqueIds.parse(swapped)).toBeNull();
  });

  it("an id that is neither format", () => {
    for (const id of [
      "",
      "u_x",
      `u_${U}:ingest-nope`,
      `h_short:ingest-${"a".repeat(52)}`,
      "x:1",
      `u_${D.toUpperCase()}:ingest-${D}`,
    ])
      expect(opaqueIds.parse(id)).toBeNull();
  });
});

describe("classification and the subject never need the key", () => {
  it("family and subjectOf work on a cold cache", async () => {
    const { userIds: u } = await userIds();
    expect(opaqueIds.current()).toBeUndefined();
    expect(opaqueIds.family(u.ingest(D, 2))).toBe("ingest");
    expect(opaqueIds.family(u.turnVisualize(C, 3))).toBe("turnVisualize");
    expect(opaqueIds.family(legacyIds.suggestTags(U, D, 1))).toBe("suggestTags");
    expect(opaqueIds.subjectOf(u.ingest(D, 2))).toBe(`h_${u.handle}`);
    expect(opaqueIds.subjectOf(u.conversation(C))).toBe(`h_${u.handle}`);
    expect(opaqueIds.subjectOf(legacyIds.ingest(U, D, 2))).toBe(U);
    expect(opaqueIds.subjectOf(`__loom_ui_lineage__:${u.documentLineage(D)}`)).toBe(
      `h_${u.handle}`,
    );
    expect(opaqueIds.subjectOf(`__loom_ui_lineage__:${legacyIds.turnLineage(U, C, 2)}`)).toBe(U);
    expect(opaqueIds.subjectOf("__loom_ui_lineage__:visuals-garbage")).toBe("");
    expect(opaqueIds.subjectOf("stray")).toBe("x:stray");
    expect(opaqueIds.handleOf(u.ingest(D, 2))).toBe(u.handle);
    expect(opaqueIds.handleOf(legacyIds.ingest(U, D, 2))).toBeNull();
  });
});

describe("the cache: ensureUser, ensureHandle, warm, forget", () => {
  it("ensureUser mints the handle once, stores it, and a second process re-reads the same one", async () => {
    const t = testOpaqueIds();
    t.store.add(U, T);
    const first = await t.ids.ensureUser({ tenantId: T, userId: U });
    expect(t.store.rows.get(U)?.handle).toBe(first.handle);
    const again = new OpaqueIds(t.keys, t.store);
    expect((await again.ensureUser({ tenantId: T, userId: U })).handle).toBe(first.handle);
    expect(first.ingest(D, 2)).toBe(
      (await again.ensureUser({ tenantId: T, userId: U })).ingest(D, 2),
    );
  });

  it("concurrent ensureUser calls share one derivation", async () => {
    const t = testOpaqueIds();
    t.store.add(U, T);
    let claims = 0;
    const claim = t.store.claim.bind(t.store);
    t.store.claim = async (...a) => {
      claims += 1;
      return claim(...a);
    };
    const [a, b] = await Promise.all([
      t.ids.ensureUser({ tenantId: T, userId: U }),
      t.ids.ensureUser({ tenantId: T, userId: U }),
    ]);
    expect(a.handle).toBe(b.handle);
    expect(claims).toBe(1);
  });

  it("refuses a stored handle that is not the derived one", async () => {
    const t = testOpaqueIds();
    t.store.add(U, T, "a".repeat(26));
    await expect(t.ids.ensureUser({ tenantId: T, userId: U })).rejects.toMatchObject({
      name: "HandleMismatchError",
    });
  });

  it("a destroyed key is FieldKeyUnavailableError, and nothing falls back to an old-format id", async () => {
    const t = testOpaqueIds();
    t.store.add(U, T);
    await t.keys.getOrCreate(U);
    await t.keys.destroy(U);
    await expect(t.ids.ensureUser({ tenantId: T, userId: U })).rejects.toBeInstanceOf(
      FieldKeyUnavailableError,
    );
  });

  it("ensureHandle fills a cold cache from the store and never mints a key", async () => {
    const warm = await userIds();
    const cold = new OpaqueIds(warm.keys, warm.store);
    opaqueIds.install(cold);
    const id = warm.userIds.ingest(D, 2);
    expect(opaqueIds.parse(id)).toBeNull();
    expect(await opaqueIds.ensure(warm.userIds.handle)).toBe(true);
    expect(opaqueIds.parse(id)).toMatchObject({ userId: U, documentId: D, generation: 2 });
    expect(await opaqueIds.ensure("b".repeat(26))).toBe(false); // nobody holds it
    warm.store.add(U2, T, "c".repeat(26));
    expect(await opaqueIds.ensure("c".repeat(26))).toBe(false); // a user with no key: not minted
    expect(await warm.keys.get(U2)).toBeNull();
  });

  it("warm loads every user with a handle, in pages, and skips a destroyed key", async () => {
    const t = testOpaqueIds();
    const users = Array.from(
      { length: WARM_CONCURRENCY + 3 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    for (const u of users) {
      t.store.add(u, T);
      await t.ids.ensureUser({ tenantId: T, userId: u });
    }
    const gone = users[1] as string;
    await t.keys.destroy(gone);
    const cold = new OpaqueIds(t.keys, t.store);
    expect(await cold.warm()).toBe(users.length - 1);
    expect(cold.cached(users[0] as string)).toBeDefined();
    expect(cold.cached(gone)).toBeUndefined();
  });

  it("forget drops both directions", async () => {
    const { ids, userIds: u } = await userIds();
    opaqueIds.install(ids);
    const id = u.ingest(D, 2);
    ids.forget(U);
    expect(ids.cached(U)).toBeUndefined();
    expect(opaqueIds.parse(id)).toBeNull();
  });
});

describe("clear fields, load and forgetSubject", () => {
  it("clear reads family, generation, run and ordinal in both formats with no cache", async () => {
    const { userIds: u } = await userIds();
    expect(opaqueIds.current()).toBeUndefined();
    expect(opaqueIds.clear(u.visualize(D, 3, 2))).toEqual({
      family: "visualize",
      generation: 3,
      rerun: 2,
    });
    expect(opaqueIds.clear(legacyIds.visualize(U, D, 3, 2))).toEqual({
      family: "visualize",
      generation: 3,
      rerun: 2,
    });
    expect(opaqueIds.clear(u.turnVisualize(C, 8))).toEqual({ family: "turnVisualize", ord: 8 });
    expect(opaqueIds.clear("nope")).toBeNull();
  });

  it("load reads an existing handle and never mints one", async () => {
    const t = testOpaqueIds();
    t.store.add(U, T);
    expect(await t.ids.load({ tenantId: T, userId: U })).toBe(false); // no handle yet: old-format ids only
    expect(await t.keys.get(U)).toBeNull(); // and no key was minted
    const minted = await t.ids.ensureUser({ tenantId: T, userId: U });
    const cold = new OpaqueIds(t.keys, t.store);
    expect(await cold.load({ tenantId: T, userId: U })).toBe(true);
    expect(cold.knows(minted.handle)).toBe(true);
  });

  it("forgetSubject drops a user by UUID or by h_<handle>", async () => {
    const { ids, userIds: u } = await userIds();
    ids.forgetSubject(`h_${u.handle}`);
    expect(ids.cached(U)).toBeUndefined();
    await ids.ensureUser({ tenantId: T, userId: U });
    ids.forgetSubject(U);
    expect(ids.knows(u.handle)).toBe(false);
  });
});

describe("the test id source", () => {
  it("builds the ids a test can compute without awaiting: deterministicUser equals what ensureUser gives", async () => {
    const ids = testIdSource();
    const built = await ids.ensureUser({ tenantId: T, userId: U });
    const computed = deterministicUser(U);
    expect(computed.handle).toBe(built.handle);
    expect(computed.ingest(D, 2)).toBe(built.ingest(D, 2));
    expect(deterministicUser(U2).handle).not.toBe(computed.handle);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/server && pnpm exec vitest run app/opaqueIds`
Expected: FAIL (the modules `./base32`, `./siv`, `./index`, `./testing` do not exist).

- [ ] **Step 3: Write the base32 and SIV modules**

`apps/server/app/opaqueIds/base32.ts`:

```ts
/** RFC 4648 base32, lower case, no padding: the alphabet has no `-`, `.`, `:`, `~` or `_`, so a token never contains an id delimiter. */
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

/** Strict: exactly `bytes` bytes, only alphabet characters, zero padding bits. Anything else is null (a token has one spelling). */
export function base32Decode(text: string, bytes: number): Buffer | null {
  if (text.length !== Math.ceil((bytes * 8) / 5)) return null;
  const out = Buffer.alloc(bytes);
  let acc = 0;
  let bits = 0;
  let at = 0;
  for (const ch of text) {
    const value = ALPHABET.indexOf(ch);
    if (value < 0) return null;
    acc = (acc << 5) | value;
    bits += 5;
    if (bits >= 8) {
      out[at++] = (acc >>> (bits - 8)) & 255;
      bits -= 8;
      acc &= (1 << bits) - 1;
    }
  }
  return acc === 0 ? out : null;
}
```

`apps/server/app/opaqueIds/siv.ts`:

```ts
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  timingSafeEqual,
} from "node:crypto";
import { base32Decode, base32Encode } from "./base32";

/** HKDF info of the per-user id key; distinct from `docmind-tag-v1` and `docmind-entity-v1` (crypto/tagKeys.ts, entityKeys.ts). */
export const ID_KEY_INFO = "docmind-id-v1";
const MAC_INFO = `${ID_KEY_INFO}/mac`;
const ENC_INFO = `${ID_KEY_INFO}/enc`;
const HANDLE_LABEL = "user";

/** The three keys of one user's ids. `root` signs the handle; `mac` and `enc` are derived from it and never used for anything else. */
export interface IdKey {
  readonly root: Buffer;
  readonly mac: Buffer;
  readonly enc: Buffer;
}

/** Which kind of id a token holds. It is authenticated with the token, so a document token never opens as a chat token. */
export type TokenFamily = "doc" | "chat";

const hkdf = (key: Buffer, info: string) =>
  Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), info, 32));

/** The id key of a user, from the user's data key (the `TagKeys` / `EntityKeys` mechanism with its own label). */
export function deriveIdKey(dek: Buffer): IdKey {
  const root = hkdf(dek, ID_KEY_INFO);
  return { root, mac: hkdf(root, MAC_INFO), enc: hkdf(root, ENC_INFO) };
}

/** `H = base32(HMAC(idKey, "user"))`, truncated to 128 bits: 26 characters. */
export const handleOfKey = (key: IdKey): string =>
  base32Encode(createHmac("sha256", key.root).update(HANDLE_LABEL).digest().subarray(0, 16));

const UUID_BYTES = 16;
const CANONICAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuidBytes = (uuid: string): Buffer => Buffer.from(uuid.replaceAll("-", ""), "hex");
const bytesUuid = (b: Buffer): string => {
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/** The synthetic IV: HMAC-SHA256 over the family, a zero byte and the plaintext, cut to 128 bits. */
const ivOf = (key: IdKey, family: TokenFamily, plain: Buffer): Buffer =>
  createHmac("sha256", key.mac)
    .update(family)
    .update(Buffer.from([0]))
    .update(plain)
    .digest()
    .subarray(0, 16);

const ctr = (key: IdKey, iv: Buffer, data: Buffer, decrypt: boolean): Buffer => {
  const c = decrypt
    ? createDecipheriv("aes-256-ctr", key.enc, iv)
    : createCipheriv("aes-256-ctr", key.enc, iv);
  return Buffer.concat([c.update(data), c.final()]);
};

/** The characters of a token: 32 bytes (a 16-byte IV and a 16-byte ciphertext) in base32. */
export const TOKEN_LENGTH = 52;

/**
 * A synthetic-IV (SIV) seal of a UUID: `base32(IV || AES-256-CTR(enc, IV, uuid))` with `IV = HMAC(mac, family || 0 || uuid)[0..16]`.
 * Deterministic, so one document or chat always has one token; reversible only with the key. Node's `crypto` has no RFC 5297 AES-SIV
 * (Node 24: `getCiphers()` lists CTR but no SIV), so this is the standard HMAC-PRF plus CTR composition from its primitives.
 */
export function sealToken(key: IdKey, family: TokenFamily, uuid: string): string {
  if (!CANONICAL.test(uuid)) throw new RangeError("a token seals a canonical lower-case uuid");
  const plain = uuidBytes(uuid);
  const iv = ivOf(key, family, plain);
  return base32Encode(Buffer.concat([iv, ctr(key, iv, plain, false)]));
}

/** The UUID a token seals, or null when the token is malformed, of another family or fails authentication. */
export function openToken(key: IdKey, family: TokenFamily, token: string): string | null {
  const raw = base32Decode(token, 2 * UUID_BYTES);
  if (raw === null) return null;
  const iv = raw.subarray(0, 16);
  const plain = ctr(key, iv, raw.subarray(16), true);
  const expected = ivOf(key, family, plain);
  return timingSafeEqual(iv, expected) ? bytesUuid(plain) : null;
}
```

- [ ] **Step 4: Write the id families, the cache and the facade**

`apps/server/app/opaqueIds/ids.ts` (the shapes of both formats, the builders, the subject mapping; the old-format regexes are the ones from `status/model.ts`, `chats/ids.ts`, `flows/visualize-turn/ids.ts`, `flows/suggest-tags/start.ts` and `subject.ts`, moved here):

```ts
import { ORD_PATTERN } from "@docmind/contracts";
import { LINEAGE_STREAM_PREFIX } from "@loom-ui/lineage";
import { isValidConversationId } from "@loom/conversation";
import { MAX_EXECUTION_ID_BYTES } from "@loom/plugin-postgres";
import { type IdKey, TOKEN_LENGTH, sealToken } from "./siv";

/** The canonical lower-case UUID source (8-4-4-4-12), defined once; `chats/ids.ts` re-exports it. */
export const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CANONICAL = new RegExp(`^${UUID_PATTERN}$`);
const U = UUID_PATTERN;
const H = "[a-z2-7]{26}";
const T = `[a-z2-7]{${TOKEN_LENGTH}}`;
const GEN = "[1-9][0-9]{0,8}";
const RERUN = "[1-9][0-9]{0,2}";
const MAX_GENERATION = 999_999_999;
const MAX_RERUN = 999;

declare const userExecution: unique symbol;
/**
 * An execution id built by this module. A plain string is not assignable to it, so a start or fork that passes `executionId` from
 * anywhere else is caught by the ratchet in executionIds.test.ts.
 */
export type UserExecutionId = string & { readonly [userExecution]: true };
declare const chatConversation: unique symbol;
/** A conversation id built by this module (`Conversations.start` takes nothing else; chats/startRatchet.test.ts). */
export type ChatConversationId = string & { readonly [chatConversation]: true };

/** The families of id the app builds. */
export type IdFamily =
  | "ingest"
  | "visualize"
  | "turnVisualize"
  | "suggestTags"
  | "chatTitle"
  | "conversation"
  | "documentLineage"
  | "turnLineage";

/** What an id names. `generation` is the INGEST generation (1 when the id has no suffix); `rerun` is 0 for an automatic run. */
export interface ParsedId {
  format: "legacy" | "opaque";
  family: IdFamily;
  userId: string;
  documentId?: string;
  chatId?: string;
  generation?: number;
  rerun?: number;
  ord?: number;
}

/** An opaque id before its tokens are opened: everything the id shows without the key. */
export interface OpaqueShape {
  family: IdFamily;
  handle: string;
  documentToken?: string;
  chatToken?: string;
  generation?: number;
  rerun?: number;
  ord?: number;
}

type Rule = {
  family: IdFamily;
  re: RegExp;
  read(m: RegExpExecArray): Omit<ParsedId, "format" | "family" | "userId"> & { userId?: string };
};
const num = (v: string | undefined, dflt?: number): number | undefined =>
  v === undefined ? dflt : Number(v);

/** Old format: the user and the document or chat as plain UUIDs. */
const LEGACY: readonly Rule[] = [
  {
    family: "ingest",
    re: new RegExp(`^u_(${U}):ingest-(${U})(?:\\.(${GEN}))?$`),
    read: (m) => ({
      userId: m[1] as string,
      documentId: m[2] as string,
      generation: num(m[3], 1) as number,
    }),
  },
  {
    family: "visualize",
    re: new RegExp(`^u_(${U}):visualize-(${U})(?:\\.(${GEN}))?(?:-r(${RERUN}))?$`),
    read: (m) => ({
      userId: m[1] as string,
      documentId: m[2] as string,
      generation: num(m[3], 1) as number,
      rerun: num(m[4], 0) as number,
    }),
  },
  {
    family: "turnVisualize",
    re: new RegExp(`^u_(${U}):visualize-turn-(${U})-(${ORD_PATTERN})(?:-r(${RERUN}))?$`),
    read: (m) => ({
      userId: m[1] as string,
      chatId: m[2] as string,
      ord: Number(m[3]),
      ...(m[4] !== undefined && { rerun: Number(m[4]) }),
    }),
  },
  {
    family: "suggestTags",
    re: new RegExp(`^u_(${U}):suggest-tags-(${U})-r(${RERUN})$`),
    read: (m) => ({ userId: m[1] as string, documentId: m[2] as string, rerun: Number(m[3]) }),
  },
  {
    family: "chatTitle",
    re: new RegExp(`^u_(${U}):chat-title-(${U})$`),
    read: (m) => ({ userId: m[1] as string, chatId: m[2] as string }),
  },
  {
    family: "conversation",
    re: new RegExp(`^u_(${U})\\.c-(${U})(?:~${GEN})?$`),
    read: (m) => ({ userId: m[1] as string, chatId: m[2] as string }),
  },
];
const LEGACY_LINEAGE: readonly Rule[] = [
  {
    family: "documentLineage",
    re: new RegExp(`^visuals-(${U})-(${U})$`),
    read: (m) => ({ userId: m[1] as string, documentId: m[2] as string }),
  },
  {
    family: "turnLineage",
    re: new RegExp(`^turnvisuals-(${U})-(${U})-(${ORD_PATTERN})$`),
    read: (m) => ({ userId: m[1] as string, chatId: m[2] as string, ord: Number(m[3]) }),
  },
];

interface OpaqueRule {
  family: IdFamily;
  re: RegExp;
  read(m: RegExpExecArray): Omit<OpaqueShape, "family">;
}
/** New format: `h_<H>` for the user, a token for the document or chat. */
const OPAQUE: readonly OpaqueRule[] = [
  {
    family: "ingest",
    re: new RegExp(`^h_(${H}):ingest-(${T})(?:\\.(${GEN}))?$`),
    read: (m) => ({
      handle: m[1] as string,
      documentToken: m[2] as string,
      generation: num(m[3], 1) as number,
    }),
  },
  {
    family: "visualize",
    re: new RegExp(`^h_(${H}):visualize-(${T})(?:\\.(${GEN}))?(?:-r(${RERUN}))?$`),
    read: (m) => ({
      handle: m[1] as string,
      documentToken: m[2] as string,
      generation: num(m[3], 1) as number,
      rerun: num(m[4], 0) as number,
    }),
  },
  {
    family: "turnVisualize",
    re: new RegExp(`^h_(${H}):visualize-turn-(${T})-(${ORD_PATTERN})(?:-r(${RERUN}))?$`),
    read: (m) => ({
      handle: m[1] as string,
      chatToken: m[2] as string,
      ord: Number(m[3]),
      ...(m[4] !== undefined && { rerun: Number(m[4]) }),
    }),
  },
  {
    family: "suggestTags",
    re: new RegExp(`^h_(${H}):suggest-tags-(${T})-r(${RERUN})$`),
    read: (m) => ({ handle: m[1] as string, documentToken: m[2] as string, rerun: Number(m[3]) }),
  },
  {
    family: "chatTitle",
    re: new RegExp(`^h_(${H}):chat-title-(${T})$`),
    read: (m) => ({ handle: m[1] as string, chatToken: m[2] as string }),
  },
  {
    family: "conversation",
    re: new RegExp(`^h_(${H})\\.c-(${T})(?:~${GEN})?$`),
    read: (m) => ({ handle: m[1] as string, chatToken: m[2] as string }),
  },
];
const OPAQUE_LINEAGE: readonly OpaqueRule[] = [
  {
    family: "documentLineage",
    re: new RegExp(`^visuals-(${H})-(${T})$`),
    read: (m) => ({ handle: m[1] as string, documentToken: m[2] as string }),
  },
  {
    family: "turnLineage",
    re: new RegExp(`^turnvisuals-(${H})-(${T})-(${ORD_PATTERN})$`),
    read: (m) => ({ handle: m[1] as string, chatToken: m[2] as string, ord: Number(m[3]) }),
  },
];

/** What an id shows without any key: an old-format id in full, a new-format id as handle plus tokens, or null. Never throws. */
export type Shape =
  | { format: "legacy"; parsed: ParsedId }
  | { format: "opaque"; shape: OpaqueShape };

function shapeIn(id: string, legacy: readonly Rule[], opaque: readonly OpaqueRule[]): Shape | null {
  for (const rule of legacy) {
    const m = rule.re.exec(id);
    if (m) {
      const read = rule.read(m);
      return {
        format: "legacy",
        parsed: { format: "legacy", family: rule.family, ...read, userId: read.userId as string },
      };
    }
  }
  for (const rule of opaque) {
    const m = rule.re.exec(id);
    if (m) return { format: "opaque", shape: { family: rule.family, ...rule.read(m) } };
  }
  return null;
}

/** The shape of an execution or conversation id. */
export const shapeOfExecution = (id: string): Shape | null => shapeIn(id, LEGACY, OPAQUE);
/** The shape of a lineage line's experience id (`visuals-...` or `turnvisuals-...`, without Loom UI's stream prefix). */
export const shapeOfLineage = (id: string): Shape | null =>
  shapeIn(id, LEGACY_LINEAGE, OPAQUE_LINEAGE);

/** The fields of an id that are in the clear in both formats: no key is needed to read them. */
export interface ClearFields {
  family: IdFamily;
  generation?: number;
  rerun?: number;
  ord?: number;
}

/** The clear fields of an execution or conversation id (family, ingest generation, run number, turn ordinal), or null. Never needs the cache. */
export function clearFieldsOf(id: string): ClearFields | null {
  const shape = shapeOfExecution(id);
  if (shape === null) return null;
  const r = shape.format === "legacy" ? shape.parsed : shape.shape;
  return {
    family: r.family,
    ...(r.generation !== undefined && { generation: r.generation }),
    ...(r.rerun !== undefined && { rerun: r.rerun }),
    ...(r.ord !== undefined && { ord: r.ord }),
  };
}

/** The family of an execution id, from its shape alone (no key): the cheap classification the fold and recovery use. */
export const familyOfExecution = (id: string): IdFamily | null => {
  const shape = shapeOfExecution(id);
  return shape === null
    ? null
    : shape.format === "legacy"
      ? shape.parsed.family
      : shape.shape.family;
};

const SUBJECT_LEGACY = new RegExp(`^u_(${U})(?::|\\.c-|$)`);
const SUBJECT_OPAQUE = new RegExp(`^h_(${H})(?::|\\.c-|$)`);
const LINEAGE_LEGACY_SUBJECT = new RegExp(
  `^(?:visuals-(${U})-${U}|turnvisuals-(${U})-${U}-${ORD_PATTERN})$`,
);
const LINEAGE_OPAQUE_SUBJECT = new RegExp(
  `^(?:visuals-(${H})-${T}|turnvisuals-(${H})-${T}-${ORD_PATTERN})$`,
);

/**
 * The erasure subject of an execution, from the id alone (no key, no cache): the user UUID for `u_<uuid>...` ids, `h_<H>` for `h_<H>...`
 * ids, the same for a lineage line, and `x:<id>` for an execution no user owns. A lineage id of another shape is "" (no subject):
 * the encrypting stores refuse to write under it.
 */
export function subjectOfId(executionId: string): string {
  if (executionId.startsWith(LINEAGE_STREAM_PREFIX)) {
    const rest = executionId.slice(LINEAGE_STREAM_PREFIX.length);
    const legacy = LINEAGE_LEGACY_SUBJECT.exec(rest);
    if (legacy) return (legacy[1] ?? legacy[2]) as string;
    const opaque = LINEAGE_OPAQUE_SUBJECT.exec(rest);
    return opaque ? `h_${(opaque[1] ?? opaque[2]) as string}` : "";
  }
  const legacy = SUBJECT_LEGACY.exec(executionId);
  if (legacy) return legacy[1] as string;
  const opaque = SUBJECT_OPAQUE.exec(executionId);
  return opaque ? `h_${opaque[1] as string}` : `x:${executionId}`;
}

/** The erasure subject of a user's new-format executions: `h_<H>`. */
export const subjectOfHandle = (handle: string): string => `h_${handle}`;

/** The handle of an `h_<H>` subject, or null. */
export const handleOfSubject = (subject: string): string | null =>
  new RegExp(`^h_(${H})$`).exec(subject)?.[1] ?? null;

const checkUuid = (what: string, id: string): string => {
  if (!CANONICAL.test(id)) throw new RangeError(`${what} must be a canonical lower-case uuid`);
  return id;
};
const checkGeneration = (g: number): number => {
  if (!Number.isSafeInteger(g) || g < 1 || g > MAX_GENERATION)
    throw new RangeError("generation must be an integer from 1 to 999999999");
  return g;
};
const checkRerun = (n: number): number => {
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_RERUN)
    throw new RangeError("rerun must be an integer from 1 to 999");
  return n;
};
const checkOrd = (ord: number): number => {
  if (!Number.isSafeInteger(ord) || ord < 1 || ord > 999_999_999_999_999)
    throw new RangeError("ord must be an integer from 1 to 999999999999999");
  return ord;
};
const within = <T extends string>(id: string): T => {
  const bytes = Buffer.byteLength(id, "utf8");
  if (bytes > MAX_EXECUTION_ID_BYTES)
    throw new RangeError(`id is ${bytes} bytes, over the ${MAX_EXECUTION_ID_BYTES}-byte limit`);
  return id as T;
};
const generationSuffix = (g: number) => (g === 1 ? "" : `.${g}`);
const rerunSuffix = (n: number | undefined) => (n === undefined ? "" : `-r${checkRerun(n)}`);

/** The old-format builders: what runs before the deploy used. Kept for reading and cancelling those runs, and for tests. */
export const legacyIds = {
  /** Any `u_<user>:<name>` id: the free-form shape Loom's `::` children and `~n` successors extend. For tests of the subject mapping; the families below are what the app ran. */
  named: (userId: string, name: string): UserExecutionId =>
    within(`u_${checkUuid("userId", userId)}:${name}`),
  ingest: (userId: string, documentId: string, generation: number): UserExecutionId =>
    within(
      `u_${checkUuid("userId", userId)}:ingest-${checkUuid("documentId", documentId)}${generationSuffix(checkGeneration(generation))}`,
    ),
  visualize: (
    userId: string,
    documentId: string,
    generation: number,
    rerun?: number,
  ): UserExecutionId =>
    within(
      `u_${checkUuid("userId", userId)}:visualize-${checkUuid("documentId", documentId)}${generationSuffix(checkGeneration(generation))}${rerunSuffix(rerun)}`,
    ),
  suggestTags: (userId: string, documentId: string, run: number): UserExecutionId =>
    within(
      `u_${checkUuid("userId", userId)}:suggest-tags-${checkUuid("documentId", documentId)}-r${checkRerun(run)}`,
    ),
  turnVisualize: (userId: string, chatId: string, ord: number, rerun?: number): UserExecutionId =>
    within(
      `u_${checkUuid("userId", userId)}:visualize-turn-${checkUuid("chatId", chatId)}-${checkOrd(ord)}${rerunSuffix(rerun)}`,
    ),
  chatTitle: (userId: string, chatId: string): UserExecutionId =>
    within(`u_${checkUuid("userId", userId)}:chat-title-${checkUuid("chatId", chatId)}`),
  conversation: (userId: string, chatId: string): ChatConversationId => {
    const id = `u_${checkUuid("userId", userId)}.c-${checkUuid("chatId", chatId)}`;
    if (!isValidConversationId(id)) throw new RangeError("not a valid Loom conversation id");
    return id as ChatConversationId;
  },
  documentLineage: (userId: string, documentId: string): string =>
    `visuals-${checkUuid("userId", userId)}-${checkUuid("documentId", documentId)}`,
  turnLineage: (userId: string, chatId: string, ord: number): string =>
    `turnvisuals-${checkUuid("userId", userId)}-${checkUuid("chatId", chatId)}-${checkOrd(ord)}`,
};

/** One user's builders, new format. Make one with `OpaqueIds.ensureUser` (it has fetched the key and the handle). Pure and synchronous. */
export class UserIds {
  constructor(
    readonly userId: string,
    readonly handle: string,
    private readonly key: IdKey,
  ) {}

  private doc = (id: string) => sealToken(this.key, "doc", checkUuid("documentId", id));
  private chat = (id: string) => sealToken(this.key, "chat", checkUuid("chatId", id));
  private prefix = () => `h_${this.handle}`;

  ingest(documentId: string, generation: number): UserExecutionId {
    return within(
      `${this.prefix()}:ingest-${this.doc(documentId)}${generationSuffix(checkGeneration(generation))}`,
    );
  }
  visualize(documentId: string, generation: number, rerun?: number): UserExecutionId {
    return within(
      `${this.prefix()}:visualize-${this.doc(documentId)}${generationSuffix(checkGeneration(generation))}${rerunSuffix(rerun)}`,
    );
  }
  suggestTags(documentId: string, run: number): UserExecutionId {
    return within(`${this.prefix()}:suggest-tags-${this.doc(documentId)}-r${checkRerun(run)}`);
  }
  turnVisualize(chatId: string, ord: number, rerun?: number): UserExecutionId {
    return within(
      `${this.prefix()}:visualize-turn-${this.chat(chatId)}-${checkOrd(ord)}${rerunSuffix(rerun)}`,
    );
  }
  chatTitle(chatId: string): UserExecutionId {
    return within(`${this.prefix()}:chat-title-${this.chat(chatId)}`);
  }
  conversation(chatId: string): ChatConversationId {
    const id = `${this.prefix()}.c-${this.chat(chatId)}`;
    if (!isValidConversationId(id)) throw new RangeError("not a valid Loom conversation id");
    return id as ChatConversationId;
  }
  documentLineage(documentId: string): string {
    return `visuals-${this.handle}-${this.doc(documentId)}`;
  }
  turnLineage(chatId: string, ord: number): string {
    return `turnvisuals-${this.handle}-${this.chat(chatId)}-${checkOrd(ord)}`;
  }
}
```

`apps/server/app/opaqueIds/opaqueIds.ts`:

```ts
import type { KeyStore } from "@loom/plugin-crypto";
import { FieldKeyStoreError, FieldKeyUnavailableError } from "../crypto/fields";
import {
  type IdFamily,
  type OpaqueShape,
  type ParsedId,
  UserIds,
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

interface Entry {
  readonly ids: UserIds;
  readonly key: IdKey;
}

export const WARM_PAGE = 500;
export const WARM_CONCURRENCY = 8;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * The one module that builds and parses execution and lineage ids, in both formats (O5). The new format needs the user's id key, which
 * is async to fetch and then cached: `ensureUser` and `ensureHandle` are the async entry points, `parse` and the `UserIds` builders are
 * synchronous. A `parse` of an old-format id never needs the cache; of a new-format id it answers null on a cache miss, so a caller that
 * can see such an id first awaits `ensureHandle(handleOf(id))` (see `handleOfId`).
 */
export class OpaqueIds {
  private readonly byHandle = new Map<string, Entry>();
  private readonly byUser = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<Entry>>();

  constructor(
    private readonly keys: Pick<KeyStore, "get" | "getOrCreate" | "wasDestroyed">,
    private readonly store: HandleStore,
  ) {}

  private put(userId: string, key: IdKey, handle: string): Entry {
    const entry = { ids: new UserIds(userId, handle, key), key };
    this.byHandle.set(handle, entry);
    this.byUser.set(userId, entry);
    return entry;
  }

  /** The user's builders, minting the key and the handle on a user's first new-format start. A key-store outage throws (never a plaintext fallback). */
  async ensureUser(who: { tenantId: string; userId: string }): Promise<UserIds> {
    const hit = this.byUser.get(who.userId);
    if (hit) return hit.ids;
    const pending =
      this.inflight.get(who.userId) ??
      this.mint(who).finally(() => this.inflight.delete(who.userId));
    this.inflight.set(who.userId, pending);
    return (await pending).ids;
  }

  private async mint(who: { tenantId: string; userId: string }): Promise<Entry> {
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
    if ((await this.store.claim(who, handle)) !== handle) throw new HandleMismatchError();
    return this.put(who.userId, key, handle);
  }

  /**
   * The cache-miss path: finds the user of a handle, derives the key from the stored data key (it never mints one) and caches both.
   * Null for a handle no user holds (never issued, or erased) and for a user whose key is destroyed.
   */
  async ensureHandle(handle: string): Promise<UserIds | null> {
    const hit = this.byHandle.get(handle);
    if (hit) return hit.ids;
    const userId = await this.store.userOf(handle);
    if (userId === null) return null;
    const entry = await this.loadKey(userId, handle);
    return entry?.ids ?? null;
  }

  private async loadKey(userId: string, handle: string): Promise<Entry | null> {
    const hit = this.byUser.get(userId);
    if (hit) return hit;
    let dek: Buffer | null;
    try {
      dek = await this.keys.get(userId);
    } catch {
      throw new FieldKeyStoreError();
    }
    if (dek === null) return null;
    const key = deriveIdKey(dek);
    if (handleOfKey(key) !== handle) throw new HandleMismatchError();
    return this.put(userId, key, handle);
  }

  /**
   * Boot: caches every user that has a handle, before recovery, the status fold or any observer runs. It covers a superset of the users with
   * a recoverable or in-flight execution (Loom lists executions by id prefix only, and a read-model rebuild folds every user's executions),
   * in pages of `WARM_PAGE` with `WARM_CONCURRENCY` key reads at a time. A destroyed key is skipped; a key-store outage throws.
   */
  async warm(): Promise<number> {
    let after = NIL_UUID;
    let warmed = 0;
    for (;;) {
      const page = await this.store.page(after, WARM_PAGE);
      for (let i = 0; i < page.length; i += WARM_CONCURRENCY) {
        const loaded = await Promise.all(
          page.slice(i, i + WARM_CONCURRENCY).map((u) => this.loadKey(u.userId, u.handle)),
        );
        warmed += loaded.filter((e) => e !== null).length;
      }
      const last = page[page.length - 1];
      if (page.length < WARM_PAGE || !last) return warmed;
      after = last.userId;
    }
  }

  /**
   * Loads an EXISTING user's id key without minting anything: the reader of a user's old and new ids (a status page, a lineage head)
   * calls it first. False when the user has no handle yet (every id of theirs is old-format, which needs no key) or the key is gone.
   */
  async load(who: { tenantId: string; userId: string }): Promise<boolean> {
    if (this.byUser.has(who.userId)) return true;
    const handle = await this.store.read(who);
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
    const entry = handle === null ? this.byUser.get(subjectId) : this.byHandle.get(handle);
    if (entry) this.forget(entry.ids.userId);
  }

  /** Drops a user from the cache (erasure, after the key is destroyed). */
  forget(userId: string): void {
    const entry = this.byUser.get(userId);
    if (entry) this.byHandle.delete(entry.ids.handle);
    this.byUser.delete(userId);
  }

  /** The user's builders if cached, else undefined. For code that cannot await; a miss is a bug in the caller's entry point. */
  cached(userId: string): UserIds | undefined {
    return this.byUser.get(userId)?.ids;
  }

  /** The handle of a new-format execution id (so a caller can `ensureHandle` first), or null for any other id. */
  handleOfId(id: string): string | null {
    const shape = shapeOfExecution(id) ?? shapeOfLineage(id);
    return shape?.format === "opaque" ? shape.shape.handle : null;
  }

  /** What an execution or conversation id names, or null (unknown shape, unknown handle, a token that fails authentication). */
  parse(id: string): ParsedId | null {
    return this.resolve(shapeOfExecution(id));
  }

  /** What a lineage line's experience id names (`visuals-...` or `turnvisuals-...`). */
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
```

`apps/server/app/opaqueIds/index.ts`:

```ts
import {
  type IdFamily,
  type ParsedId,
  clearFieldsOf,
  familyOfExecution,
  handleOfSubject,
  shapeOfExecution,
  shapeOfLineage,
  subjectOfHandle,
  subjectOfId,
} from "./ids";
import type { OpaqueIds } from "./opaqueIds";

export { OpaqueIds, HandleMismatchError, WARM_CONCURRENCY, WARM_PAGE } from "./opaqueIds";
export type { HandleStore } from "./opaqueIds";
export {
  UUID_PATTERN,
  UserIds,
  handleOfSubject,
  legacyIds,
  subjectOfHandle,
  subjectOfId,
} from "./ids";
export type { ChatConversationId, ClearFields, IdFamily, ParsedId, UserExecutionId } from "./ids";

let installed: OpaqueIds | undefined;

/**
 * The process's id module, as the synchronous parsers (the status fold, Loom's `keyOf` and `scopeOf`, the stores' subject mapping) see it.
 * An old-format id parses with no instance at all; a new-format id needs the one `compose.ts` installs (null until then, which every
 * entry point treats as "unknown handle"). Tests install their own and remove it afterwards.
 */
export const opaqueIds = {
  install(ids: OpaqueIds | undefined): void {
    installed = ids;
  },
  current: (): OpaqueIds | undefined => installed,
  /** What an execution or conversation id names, or null. Synchronous. */
  parse(id: string): ParsedId | null {
    const shape = shapeOfExecution(id);
    if (shape === null) return null;
    return shape.format === "legacy" ? shape.parsed : (installed?.parse(id) ?? null);
  },
  /** What a lineage line's experience id names, or null. */
  parseLineage(id: string): ParsedId | null {
    const shape = shapeOfLineage(id);
    if (shape === null) return null;
    return shape.format === "legacy" ? shape.parsed : (installed?.parseLineage(id) ?? null);
  },
  /** Family, ingest generation, run number and turn ordinal: in the clear in both formats, so no key and no miss. */
  clear: clearFieldsOf,
  /** The family of an execution id from its shape alone: no key, so it never misses on a cold cache. */
  family: (id: string): IdFamily | null => familyOfExecution(id),
  /** The erasure subject of an execution (see `subjectOfId`): from the id alone. */
  subjectOf: (executionId: string): string => subjectOfId(executionId),
  handleOfSubject,
  /** The subject of a user's new-format executions, `h_<handle>`. */
  subjectOfHandle,
  /** The handle of a new-format id, or null (old format, or not an id). */
  handleOf(id: string): string | null {
    const shape = shapeOfExecution(id) ?? shapeOfLineage(id);
    return shape?.format === "opaque" ? shape.shape.handle : null;
  },
  /** Whether the installed instance has this handle cached (false when none is installed or the id is old-format). */
  known: (handle: string): boolean => installed?.knows(handle) ?? false,
  /** Loads an existing user's id key without minting one (see `OpaqueIds.load`); false when none is installed. */
  async loadUser(who: { tenantId: string; userId: string }): Promise<boolean> {
    return installed ? installed.load(who) : false;
  },
  /** The awaited miss path: caches the user of `handle`. False when no user holds it (never issued, or erased) or the key is gone. */
  async ensure(handle: string): Promise<boolean> {
    if (!installed) return false;
    return (await installed.ensureHandle(handle)) !== null;
  },
};
```

`apps/server/app/opaqueIds/testing.ts`:

```ts
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/server && pnpm exec vitest run app/opaqueIds`
Expected: PASS (27 tests across the two files).

- [ ] **Step 6: Typecheck, lint, commit**

Run: `pnpm exec biome check --write apps/server/app/opaqueIds && pnpm typecheck && pnpm typecheck:tests && pnpm lint`
Expected: no errors.

```bash
git add apps/server/app/opaqueIds
git commit -m "feat(ids): the opaqueIds core, a synthetic-IV token and the per-user key cache"
```

---

### Task 2: Migration 0038, the handle store and the execution-id recorder (O3, F6)

**Files:**
- Create: `infra/migrations/0038_opaque_ids.sql`, `apps/server/app/opaqueIds/pgHandles.ts`, `apps/server/app/documents/executionIds.ts`
- Modify: `apps/server/app/documents/repo.ts:211-221` (`bumpGeneration`), `apps/server/app/documents/testHarness.ts:588-599` (`seedRow`; new `backfillExecutionIds`), the pg tests named in step 6
- Test: `apps/server/app/opaqueIds/pgHandles.pg.test.ts`, `apps/server/app/db/executionIds.pg.test.ts`

**Interfaces:**
- Consumes: `HandleStore` (Task 1), `withTenant(pool, tenantId, fn)` (`db/tenant.ts`), `FieldKeyUnavailableError`, `seedDoc`/`seedRow`/`seedUsers`/`ALICE`/`BOB`/`U1`/`U2` (`documents/testHarness.ts`).
- Produces:
  - `class PgHandleStore implements HandleStore { constructor(pool: Pool) }` (the app role's pool).
  - `interface ExecutionRecorder { recordIngest(who: {tenantId; userId}, documentId, generation, executionId): Promise<void>; recordVisualize(...same): Promise<void> }` and `class PgExecutionRecorder implements ExecutionRecorder { constructor(pool: Pool) }` (`documents/executionIds.ts`).
  - SQL: `users.id_handle`, `documents.ingest_execution_id`, `documents.visualize_execution_id`, `public.docmind_user_of_handle(text) -> uuid`, `public.docmind_user_handles(uuid, integer) -> (id uuid, id_handle text)`; the five sweep functions now compare the columns.
  - Test helper `backfillExecutionIds(owner: Pool): Promise<void>` (runs the migration's two backfill statements, read from the migration file so they cannot drift); `seedRow` calls it.

- [ ] **Step 1: Write the failing tests**

`apps/server/app/opaqueIds/pgHandles.pg.test.ts`:

```ts
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword } from "../db/migrate";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";
import { ALICE, ALICE2, BOB, T1, U1, U1B, U2, seedUsers } from "../documents/testHarness";
import { PgHandleStore } from "./pgHandles";

const H1 = "a".repeat(26);
const H2 = "b".repeat(26);

describe.skipIf(!PG_URL)("users.id_handle and its lookups (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;
  let store: PgHandleStore;
  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await seedUsers(db.owner);
    app = new Pool({ connectionString: db.appUrl });
    store = new PgHandleStore(app);
  });
  afterAll(async () => {
    await app?.end();
    await db?.drop();
  });

  it("claims once, and every later claim returns the stored value", async () => {
    expect(await store.read(ALICE)).toBeNull();
    expect(await store.claim(ALICE, H1)).toBe(H1);
    expect(await store.claim(ALICE, H2)).toBe(H1); // the stored one wins; the caller refuses a mismatch
    expect(await store.read(ALICE)).toBe(H1);
  });

  it("a concurrent claim settles on one value", async () => {
    const results = await Promise.all([
      store.claim(ALICE2, H2),
      store.claim(ALICE2, H2),
      store.claim(ALICE2, "c".repeat(26)),
    ]);
    expect(new Set(results).size).toBe(1);
    expect(await store.read(ALICE2)).toBe(results[0]);
  });

  it("is unique across users and tenants, and shaped", async () => {
    await expect(store.claim(BOB, H1)).rejects.toMatchObject({ code: "23505" });
    await expect(
      db.owner.query("UPDATE users SET id_handle = 'short' WHERE id = $1", [U2]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.owner.query("UPDATE users SET id_handle = $2 WHERE id = $1", [U2, "A".repeat(26)]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("row-level security keeps a claim inside its tenant", async () => {
    await expect(store.claim({ tenantId: T1, userId: U2 }, "d".repeat(26))).rejects.toThrow();
    expect(await store.read({ tenantId: T1, userId: U2 })).toBeNull();
  });

  it("an erasing user cannot claim a handle", async () => {
    await db.owner.query(
      "INSERT INTO users (id, tenant_id, email, password_hash, erasing_at) VALUES ('c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1', $1, 'gone@example.com', 'x', now())",
      [T1],
    );
    await expect(
      store.claim({ tenantId: T1, userId: "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1" }, "e".repeat(26)),
    ).rejects.toMatchObject({ name: "FieldKeyUnavailableError" });
  });

  it("finds the user of a handle across tenants, and pages the users that have one", async () => {
    expect(await store.userOf(H1)).toBe(U1);
    expect(await store.userOf("z".repeat(26))).toBeNull();
    const all = await store.page("00000000-0000-0000-0000-000000000000", 500);
    expect(all.map((r) => r.userId)).toEqual([U1, U1B].sort());
    const first = all[0] as { userId: string };
    expect((await store.page(first.userId, 500)).map((r) => r.userId)).toEqual(
      all.slice(1).map((r) => r.userId),
    );
    expect(await store.page("00000000-0000-0000-0000-000000000000", 1)).toHaveLength(1);
  });
});
```

`apps/server/app/db/executionIds.pg.test.ts` (it uses the helpers added in step 5):

```ts
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FieldCrypto } from "../crypto/fields";
import { PgExecutionRecorder } from "../documents/executionIds";
import { bumpGeneration } from "../documents/repo";
import { ALICE, BOB, U1, U2, backfillExecutionIds, seedDoc, seedRow, seedUsers } from "../documents/testHarness";
import { legacyIds } from "../opaqueIds";
import { migrate, setAppRolePassword } from "./migrate";
import { withTenant } from "./tenant";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "./testSupport";

const NIL = "00000000-0000-0000-0000-000000000000";
const READY = '{"status":"ready","step":"finalize","code":null}';
// What the application records for a new-format start: any opaque text; the SQL only compares it.
const opaque = (d: string, kind: string) =>
  `h_${"a".repeat(26)}:${kind}-${d.replaceAll("-", "").padEnd(52, "a")}.2`;

describe.skipIf(!PG_URL)(
  "documents.*_execution_id and the sweeps that read them (needs DOCMIND_TEST_PG_URL)",
  () => {
    let db: TestDb;
    let owner: Pool;
    let app: Pool;
    let fields: FieldCrypto;
    let recorder: PgExecutionRecorder;
    let n = 0;
    const fp = () => (n++).toString(16).padStart(64, "0");
    const column = async (id: string) =>
      (
        await owner.query(
          "SELECT ingest_execution_id AS i, visualize_execution_id AS v FROM documents WHERE id = $1",
          [id],
        )
      ).rows[0];

    beforeAll(async () => {
      db = await createTestDb();
      owner = db.owner;
      await migrate(owner);
      await setAppRolePassword(owner, APP_PASSWORD);
      await seedUsers(owner);
      app = new Pool({ connectionString: db.appUrl });
      fields = new FieldCrypto(new InMemoryKeyStore());
      recorder = new PgExecutionRecorder(app);
    });
    afterAll(async () => {
      await app.end();
      await db.drop();
    });

    it("records an id once per generation, only for the owner, and bumpGeneration clears both", async () => {
      const id = await seedDoc(owner, app, fields, ALICE, fp(), 600);
      expect(await column(id)).toEqual({ i: null, v: null });
      await recorder.recordIngest(ALICE, id, 2, opaque(id, "ingest"));
      await recorder.recordVisualize(ALICE, id, 2, opaque(id, "visualize"));
      await recorder.recordIngest(ALICE, id, 2, "h_other"); // a second record never overwrites
      expect(await column(id)).toEqual({ i: opaque(id, "ingest"), v: opaque(id, "visualize") });
      await recorder.recordIngest(ALICE, id, 3, "h_wrong-generation"); // not the current generation
      await recorder.recordIngest({ tenantId: BOB.tenantId, userId: U2 }, id, 2, "h_not-the-owner");
      expect((await column(id)).i).toBe(opaque(id, "ingest"));
      await withTenant(app, ALICE.tenantId, (tx) => bumpGeneration(tx, id, U1, 2));
      expect(await column(id)).toEqual({ i: null, v: null });
      await recorder.recordIngest(ALICE, id, 3, opaque(id, "ingest").replace(".2", ".3"));
      expect((await column(id)).i).toContain(".3");
    });

    it("the migration's backfill gives a document with an old-format status row that exact id, and no other document anything", async () => {
      const withRow = await seedDoc(owner, app, fields, ALICE, fp(), 600);
      const without = await seedDoc(owner, app, fields, ALICE, fp(), 600);
      await seedRow(owner, legacyIds.ingest(U1, withRow, 2), withRow, U1, READY);
      await backfillExecutionIds(owner);
      expect((await column(withRow)).i).toBe(legacyIds.ingest(U1, withRow, 2));
      expect((await column(without)).i).toBeNull();
    });

    it("docmind_ready_documents compares the stored ids: old and new format both match, a NULL never does", async () => {
      await owner.query("DELETE FROM documents");
      await owner.query("DELETE FROM read_model_state");
      const oldFormat = await seedDoc(owner, app, fields, ALICE, fp(), 600);
      const newFormat = await seedDoc(owner, app, fields, ALICE, fp(), 600);
      const unrecorded = await seedDoc(owner, app, fields, ALICE, fp(), 600);
      const visualized = await seedDoc(owner, app, fields, ALICE, fp(), 600);
      await seedRow(owner, legacyIds.ingest(U1, oldFormat, 2), oldFormat, U1, READY);
      await owner.query("UPDATE documents SET ingest_execution_id = $2 WHERE id = $1", [
        oldFormat,
        legacyIds.ingest(U1, oldFormat, 2),
      ]);
      await seedRow(owner, opaque(newFormat, "ingest"), newFormat, U1, READY);
      await recorder.recordIngest(ALICE, newFormat, 2, opaque(newFormat, "ingest"));
      await seedRow(owner, opaque(unrecorded, "ingest"), unrecorded, U1, READY); // a row, but no id recorded on the document
      await seedRow(owner, opaque(visualized, "ingest"), visualized, U1, READY);
      await recorder.recordIngest(ALICE, visualized, 2, opaque(visualized, "ingest"));
      await recorder.recordVisualize(ALICE, visualized, 2, opaque(visualized, "visualize"));
      // Loom's neutral row for the visualize execution itself.
      await owner.query(
        "INSERT INTO read_model_state (model_id, execution_id, app_key, scope, sequence, state) VALUES ('ingest-status', $1, NULL, NULL, 0, '{}')",
        [opaque(visualized, "visualize")],
      );
      const { rows } = await app.query("SELECT id FROM docmind_ready_documents($1::uuid, 100)", [
        NIL,
      ]);
      expect(rows.map((r) => r.id).sort()).toEqual([oldFormat, newFormat].sort());
    });

    it("the stale-upload sweep lists a document whose recorded id has no status row, and not one that has", async () => {
      await owner.query("DELETE FROM documents");
      await owner.query("DELETE FROM read_model_state");
      const started = await seedDoc(owner, app, fields, ALICE, fp(), 600);
      const notStarted = await seedDoc(owner, app, fields, ALICE, fp(), 600);
      await recorder.recordIngest(ALICE, started, 2, opaque(started, "ingest"));
      await seedRow(owner, opaque(started, "ingest"), started, U1);
      await recorder.recordIngest(ALICE, notStarted, 2, opaque(notStarted, "ingest"));
      const { rows } = await app.query(
        "SELECT id FROM docmind_stale_uploads_v2(make_interval(secs => 120), make_interval(secs => 604800), 10)",
      );
      expect(rows.map((r) => r.id)).toEqual([notStarted]);
    });
  },
);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `set -a; . ./.env; set +a; cd apps/server && pnpm exec vitest run app/opaqueIds/pgHandles app/db/executionIds`
Expected: FAIL (no `id_handle` column, no `PgHandleStore`, no `documents/executionIds`, no `backfillExecutionIds`).

- [ ] **Step 3: Write the migration**

`infra/migrations/0038_opaque_ids.sql`. The two backfill `UPDATE` statements must stay between the line `UPDATE documents d` and the line `CREATE FUNCTION public.docmind_user_of_handle`: the test helper slices the file there.

```sql
-- 0038: opaque execution and lineage ids (R14, docs/specs/2026-11-10-opaque-ids-design.md, phase 1).
--
-- 1. `users.id_handle` (O3): the user's handle `H`, 26 characters of lower-case base32 (128 bits), created lazily on the user's first
--    new-format start and unique across tenants. NULL until then. It is deleted with the user's row.
-- 2. Two lookups for the key cache, both SECURITY DEFINER like 0015..0034 (the boot warm-up and a cache miss run outside any tenant):
--    the user of a handle, and one keyset page of the users that have a handle. Ids and handles only, at most 500 rows.
-- 3. `documents.ingest_execution_id` and `documents.visualize_execution_id`: the id of the CURRENT generation's ingest and visualize
--    (run 0) executions. The sweeps below and the connections reader used to BUILD those ids inside SQL from the user and document
--    UUIDs; a new-format id cannot be built in SQL (it needs the user's key), so the application stores the id it started and the SQL
--    only compares it. NULL means "no execution recorded for this generation": it never matches a status row. The application writes
--    both when it starts the execution (documents/executionIds.ts) and `bumpGeneration` clears both with the generation.
--    Backfill: a document whose current generation already has an old-format status row keeps that exact old id, so a run that
--    started before the deploy stays found; any other document stays NULL and the next start records its (new-format) id.
-- 4. The five SECURITY DEFINER functions that built ids (0024's `docmind_stale_uploads_v2`, 0028's `docmind_ready_documents`,
--    0030's `docmind_visual_retry_documents`, 0032's `docmind_visual_stale_format_documents`, 0034's
--    `docmind_visual_unrecorded_documents`) are replaced with the same signature, columns and grants (CREATE OR REPLACE keeps the
--    ACL), comparing the stored columns. Their other predicates are unchanged. Old migrations are never edited.
ALTER TABLE users ADD COLUMN id_handle text
  CONSTRAINT users_id_handle_shape CHECK (id_handle ~ '^[a-z2-7]{26}$')
  CONSTRAINT users_id_handle_key UNIQUE;

ALTER TABLE documents
  ADD COLUMN ingest_execution_id text CHECK (ingest_execution_id IS NULL OR length(ingest_execution_id) <= 1024),
  ADD COLUMN visualize_execution_id text CHECK (visualize_execution_id IS NULL OR length(visualize_execution_id) <= 1024);

UPDATE documents d
   SET ingest_execution_id = 'u_' || d.owner_id::text || ':ingest-' || d.id::text
         || CASE WHEN d.ingest_generation = 1 THEN '' ELSE '.' || d.ingest_generation::text END
 WHERE EXISTS (
   SELECT 1 FROM read_model_state s
    WHERE s.model_id = 'ingest-status'
      AND s.execution_id = 'u_' || d.owner_id::text || ':ingest-' || d.id::text
          || CASE WHEN d.ingest_generation = 1 THEN '' ELSE '.' || d.ingest_generation::text END);
UPDATE documents d
   SET visualize_execution_id = 'u_' || d.owner_id::text || ':visualize-' || d.id::text
         || CASE WHEN d.ingest_generation = 1 THEN '' ELSE '.' || d.ingest_generation::text END
 WHERE EXISTS (
   SELECT 1 FROM read_model_state s
    WHERE s.model_id = 'ingest-status'
      AND s.execution_id = 'u_' || d.owner_id::text || ':visualize-' || d.id::text
          || CASE WHEN d.ingest_generation = 1 THEN '' ELSE '.' || d.ingest_generation::text END);

CREATE FUNCTION public.docmind_user_of_handle(p_handle text)
RETURNS uuid
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT u.id FROM public.users u WHERE u.id_handle = p_handle
$$;
REVOKE ALL ON FUNCTION public.docmind_user_of_handle(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.docmind_user_of_handle(text) TO docmind_app;

CREATE FUNCTION public.docmind_user_handles(p_after uuid, p_limit integer)
RETURNS TABLE (id uuid, id_handle text)
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT u.id, u.id_handle
    FROM public.users u
   WHERE u.id_handle IS NOT NULL AND u.id > p_after
   ORDER BY u.id
   LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;
REVOKE ALL ON FUNCTION public.docmind_user_handles(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.docmind_user_handles(uuid, integer) TO docmind_app;

CREATE OR REPLACE FUNCTION public.docmind_stale_uploads_v2(older_than interval, lookback interval, max_rows integer)
RETURNS TABLE (tenant_id uuid, owner_id uuid, id uuid, generation integer)
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT d.tenant_id, d.owner_id, d.id, d.ingest_generation
    FROM public.documents d
    JOIN public.users u ON u.id = d.owner_id AND u.erasing_at IS NULL
   WHERE older_than >= interval '0'
     AND lookback <= interval '400 days'
     AND d.updated_at < pg_catalog.now() - older_than
     AND d.updated_at > pg_catalog.now() - lookback
     AND NOT EXISTS (
       SELECT 1 FROM public.read_model_state s
        WHERE s.model_id = 'ingest-status' AND s.execution_id = d.ingest_execution_id)
   ORDER BY d.updated_at DESC
   LIMIT LEAST(GREATEST(max_rows, 1), 500)
$$;

CREATE OR REPLACE FUNCTION public.docmind_ready_documents(p_after uuid, p_limit integer)
RETURNS TABLE (tenant_id uuid, owner_id uuid, id uuid, generation integer)
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT d.tenant_id, d.owner_id, d.id, d.ingest_generation
    FROM public.documents d
    JOIN public.users u ON u.id = d.owner_id AND u.erasing_at IS NULL
   WHERE d.id > p_after
     AND EXISTS (
       SELECT 1 FROM public.read_model_state s
        WHERE s.model_id = 'ingest-status'
          AND NOT s.erased
          AND s.state ->> 'status' = 'ready'
          AND s.execution_id = d.ingest_execution_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.read_model_state v
        WHERE v.model_id = 'ingest-status' AND v.execution_id = d.visualize_execution_id)
   ORDER BY d.id
   LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;

CREATE OR REPLACE FUNCTION public.docmind_visual_retry_documents(p_after uuid, p_limit integer)
RETURNS TABLE (tenant_id uuid, owner_id uuid, id uuid, generation integer)
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT d.tenant_id, d.owner_id, d.id, d.ingest_generation
    FROM public.documents d
    JOIN public.users u ON u.id = d.owner_id AND u.erasing_at IS NULL
    JOIN public.visual_runs r ON r.document_id = d.id AND r.generation = d.ingest_generation
   WHERE d.id > p_after
     AND r.state = 'failed' AND r.code = 'visuals-model-unavailable'
     AND r.updated_at < now() - interval '1 hour'
     AND EXISTS (
       SELECT 1 FROM public.read_model_state s
        WHERE s.model_id = 'ingest-status'
          AND NOT s.erased
          AND s.state ->> 'status' = 'ready'
          AND s.execution_id = d.ingest_execution_id)
   ORDER BY d.id
   LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;

CREATE OR REPLACE FUNCTION public.docmind_visual_stale_format_documents(p_after uuid, p_limit integer, p_format text)
RETURNS TABLE (tenant_id uuid, owner_id uuid, id uuid, generation integer)
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT d.tenant_id, d.owner_id, d.id, d.ingest_generation
    FROM public.documents d
    JOIN public.users u ON u.id = d.owner_id AND u.erasing_at IS NULL
    JOIN public.visual_runs r ON r.document_id = d.id AND r.generation = d.ingest_generation
   WHERE d.id > p_after
     AND r.state = 'done' AND r.format IS DISTINCT FROM p_format
     AND EXISTS (
       SELECT 1 FROM public.read_model_state s
        WHERE s.model_id = 'ingest-status'
          AND NOT s.erased
          AND s.state ->> 'status' = 'ready'
          AND s.execution_id = d.ingest_execution_id)
   ORDER BY d.id
   LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;

CREATE OR REPLACE FUNCTION public.docmind_visual_unrecorded_documents(p_after uuid, p_limit integer)
RETURNS TABLE (tenant_id uuid, owner_id uuid, id uuid, generation integer)
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT d.tenant_id, d.owner_id, d.id, d.ingest_generation
    FROM public.documents d
    JOIN public.users u ON u.id = d.owner_id AND u.erasing_at IS NULL
   WHERE d.id > p_after
     AND NOT EXISTS (
       SELECT 1 FROM public.visual_runs r
        WHERE r.document_id = d.id AND r.generation = d.ingest_generation)
     AND EXISTS (
       SELECT 1 FROM public.read_model_state s
        WHERE s.model_id = 'ingest-status'
          AND NOT s.erased
          AND s.state ->> 'status' = 'ready'
          AND s.execution_id = d.ingest_execution_id)
     AND EXISTS (
       SELECT 1 FROM public.read_model_state v
        WHERE v.model_id = 'ingest-status' AND v.execution_id = d.visualize_execution_id)
   ORDER BY d.id
   LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;
```

- [ ] **Step 4: Write the handle store, the recorder and the `bumpGeneration` change**

`apps/server/app/opaqueIds/pgHandles.ts`:

```ts
import type { Pool } from "pg";
import { FieldKeyUnavailableError } from "../crypto/fields";
import { withTenant } from "../db/tenant";
import type { HandleStore } from "./opaqueIds";

/**
 * `users.id_handle` (migration 0038) on the app role. `read` and `claim` run under the user's tenant (row-level security), and every
 * statement names the user and the tenant. The cross-tenant lookups go through two SECURITY DEFINER functions: the app role cannot
 * read other tenants' users.
 */
export class PgHandleStore implements HandleStore {
  constructor(private readonly pool: Pool) {}

  async read(who: { tenantId: string; userId: string }): Promise<string | null> {
    return withTenant(this.pool, who.tenantId, async (tx) => {
      const { rows } = await tx.query<{ id_handle: string | null }>(
        "SELECT id_handle FROM users WHERE id = $1 AND tenant_id = $2",
        [who.userId, who.tenantId],
      );
      return rows[0]?.id_handle ?? null;
    });
  }

  /**
   * One statement settles a race: the first UPDATE sets the handle, a concurrent one finds `id_handle` set, updates nothing and reads
   * the stored value (the unique constraint is the backstop for a handle that two users derived). A user who is erasing, or gone, has
   * no handle to claim: the key is about to be, or already is, destroyed.
   */
  async claim(who: { tenantId: string; userId: string }, handle: string): Promise<string> {
    return withTenant(this.pool, who.tenantId, async (tx) => {
      const set = await tx.query<{ id_handle: string }>(
        `UPDATE users SET id_handle = $1
          WHERE id = $2 AND tenant_id = $3 AND id_handle IS NULL AND erasing_at IS NULL
          RETURNING id_handle`,
        [handle, who.userId, who.tenantId],
      );
      if (set.rows[0]) return set.rows[0].id_handle;
      const { rows } = await tx.query<{ id_handle: string | null }>(
        "SELECT id_handle FROM users WHERE id = $1 AND tenant_id = $2",
        [who.userId, who.tenantId],
      );
      const stored = rows[0]?.id_handle;
      if (!stored) throw new FieldKeyUnavailableError();
      return stored;
    });
  }

  async userOf(handle: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ id: string | null }>(
      "SELECT public.docmind_user_of_handle($1) AS id",
      [handle],
    );
    return rows[0]?.id ?? null;
  }

  async page(after: string, limit: number): Promise<{ userId: string; handle: string }[]> {
    const { rows } = await this.pool.query<{ id: string; id_handle: string }>(
      "SELECT id, id_handle FROM public.docmind_user_handles($1::uuid, $2::integer)",
      [after, limit],
    );
    return rows.map((r) => ({ userId: r.id, handle: r.id_handle }));
  }
}
```

`apps/server/app/documents/executionIds.ts`:

```ts
import type { Pool } from "pg";
import { withTenant } from "../db/tenant";

/**
 * Where a document's current ingest and visualize execution ids are kept (`documents.ingest_execution_id` and `visualize_execution_id`,
 * migration 0038). The sweeps and the connections reader compare these columns with the status rows' execution ids; they can no longer
 * build the ids themselves, because a new-format id needs the user's key.
 */
export interface ExecutionRecorder {
  /** Records the id of the document's CURRENT ingest execution unless one is already recorded for this generation. A bumped or deleted document is a no-op. */
  recordIngest(
    who: { tenantId: string; userId: string },
    documentId: string,
    generation: number,
    executionId: string,
  ): Promise<void>;
  /** The same for the visualize execution (run 0) of the generation. */
  recordVisualize(
    who: { tenantId: string; userId: string },
    documentId: string,
    generation: number,
    executionId: string,
  ): Promise<void>;
}

const COLUMN = { ingest: "ingest_execution_id", visualize: "visualize_execution_id" } as const;

export class PgExecutionRecorder implements ExecutionRecorder {
  constructor(private readonly pool: Pool) {}

  private record(
    column: keyof typeof COLUMN,
    who: { tenantId: string; userId: string },
    documentId: string,
    generation: number,
    executionId: string,
  ): Promise<void> {
    // The column name comes from the closed map above, never from input.
    return withTenant(this.pool, who.tenantId, async (tx) => {
      await tx.query(
        `UPDATE documents SET ${COLUMN[column]} = $1
          WHERE id = $2 AND owner_id = $3 AND tenant_id = $4
            AND ingest_generation = $5 AND ${COLUMN[column]} IS NULL`,
        [executionId, documentId, who.userId, who.tenantId, generation],
      );
    });
  }

  recordIngest(
    who: { tenantId: string; userId: string },
    documentId: string,
    generation: number,
    executionId: string,
  ) {
    return this.record("ingest", who, documentId, generation, executionId);
  }

  recordVisualize(
    who: { tenantId: string; userId: string },
    documentId: string,
    generation: number,
    executionId: string,
  ) {
    return this.record("visualize", who, documentId, generation, executionId);
  }
}
```

In `apps/server/app/documents/repo.ts`, replace the `bumpGeneration` doc comment and statement so the stored ids go with the generation:

```ts
/** D1: moves the owner's document to the next generation if it is still at `from`. Also stamps updated_at (the sweep's clock), clears the extraction format stamp (so the new generation's run extracts again) and clears the stored execution ids (the new generation has no execution yet: the next start records its own). */
export async function bumpGeneration(
  tx: PoolClient,
  id: string,
  ownerId: string,
  from: number,
): Promise<DocumentRow | null> {
  const { rows } = await tx.query<DocumentRow>(
    `UPDATE documents SET ingest_generation = ingest_generation + 1, updated_at = now(), visual_extract_format = NULL,
           ingest_execution_id = NULL, visualize_execution_id = NULL
      WHERE id = $1 AND owner_id = $2 AND ingest_generation = $3
      RETURNING ${DOCUMENT_COLUMNS}`,
    [id, ownerId, from],
  );
  return rows[0] ?? null;
}
```

- [ ] **Step 5: Add the test helpers**

In `apps/server/app/documents/testHarness.ts`, extend the `node:fs` import to `import { mkdtempSync, readFileSync, rmSync } from "node:fs";` (line 2; `join` and `Pool` are already imported). Replace `seedRow` (line 589) and add `backfillExecutionIds` before it. Every status row a test seeds under an old-format id now also gets its document's stored id, as the migration's backfill would give it:

```ts
/** The migration's two backfill statements (0038), run as the owner: a document whose current generation has an old-format status row gets that id stored. */
export async function backfillExecutionIds(owner: Pool): Promise<void> {
  const text = readFileSync(
    join(__dirname, "../../../../infra/migrations/0038_opaque_ids.sql"),
    "utf8",
  );
  await owner.query(
    text.slice(
      text.indexOf("UPDATE documents d"),
      text.indexOf("CREATE FUNCTION public.docmind_user_of_handle"),
    ),
  );
}

// What the status model's writer would have stored for an execution (and, as the migration's backfill would have, the id on its document).
export const seedRow = async (
  owner: Pool,
  executionId: string,
  key: string,
  scope: string,
  state = "{}",
) => {
  await owner.query(
    "INSERT INTO read_model_state (model_id, execution_id, app_key, scope, sequence, state) VALUES ('ingest-status', $1, $2, $3, 0, $4)",
    [executionId, key, scope, state],
  );
  await backfillExecutionIds(owner);
};
```

(`__dirname` is available: the server compiles to CommonJS, as `erasure/compliance.test.ts` already relies on.)

- [ ] **Step 6: Run the new tests, then keep every existing suite that touches the sweeps green**

Run: `set -a; . ./.env; set +a; cd apps/server && pnpm exec vitest run app/opaqueIds/pgHandles app/db/executionIds`
Expected: PASS (6 + 4 tests; the summary must show them run, not skipped).

The five sweep functions and the connections reader now depend on the stored ids, so the existing suites that seed status rows directly need the same sync. `seedRow` does it for them; each place that inserts into `read_model_state` with a literal `INSERT` needs one added line `await backfillExecutionIds(owner);` after it. Find them with `grep -n "INSERT INTO read_model_state" apps/server/app/documents/sweepSql.pg.test.ts apps/server/app/flows/visualize-document/ready.pg.test.ts apps/server/app/flows/visualize-document/rollout.pg.test.ts apps/server/app/flows/visualize-document/runs.pg.test.ts apps/server/app/documents/visuals.e2e.pg.test.ts apps/server/app/ui/connections.pg.test.ts apps/server/app/ui/testSupport.ts apps/server/app/db/embeddings.pg.test.ts` and add the line after each hit that writes an old-format execution id of a document's current generation (a neutral visualize row, for example `INSERT INTO read_model_state (...) VALUES ('ingest-status', $1, NULL, NULL, 0, '{}')` in `ready.pg.test.ts`). `ui/testSupport.ts:63` seeds through `seedRow`-style code with `ingestExecutionId(who.userId, d.id, 2)`: leave it (the builder still exists until Task 5) and add the sync line after its insert.

Run: `set -a; . ./.env; set +a; cd apps/server && pnpm exec vitest run app/documents/sweepSql app/flows/visualize-document/ready app/flows/visualize-document/rollout app/flows/visualize-document/runs app/documents/visuals.e2e app/ui/connections app/db`
Expected: PASS. If a test fails with a document missing from a sweep's list, its status row has no stored id: add the sync line after that insert.

- [ ] **Step 7: Typecheck, lint, commit**

Run: `pnpm exec biome check --write apps/server/app/opaqueIds apps/server/app/documents apps/server/app/db infra && pnpm typecheck && pnpm typecheck:tests && pnpm lint`
Expected: no errors.

```bash
git add infra/migrations/0038_opaque_ids.sql apps/server/app
git commit -m "feat(ids): migration 0038, users.id_handle, stored execution ids, the handle store and the recorder"
```

---

### Task 3: The subject, encrypting stores, erasure and the prefix walks (O6, F3, F7, F8)

**Files:**
- Create: `apps/server/app/opaqueIds/prefixes.ts`
- Modify: `apps/server/app/opaqueIds/index.ts` (one export line), `apps/server/app/subject.ts`, `apps/server/app/erasure/compliance.ts:63-130`, `apps/server/app/erasure/eraser.ts` (`ErasureDeps`, the `shred`, `readModels` and `rows` steps), `apps/server/app/erasure/wire.ts`, `apps/server/app/erasure/pgSteps.ts:11-80`, `apps/server/app/status/forgetUser.ts`, `apps/server/app/status/pgStores.ts:50-70`, `apps/server/app/status/ingestStatus.ts:213-222` (`forgetUser`), `apps/server/app/chats/activity.ts:136-146` (`forgetUser`)
- Test: `apps/server/app/opaqueIds/prefixes.test.ts`, `apps/server/app/subject.test.ts`, `apps/server/app/erasure/compliance.test.ts`, `apps/server/app/erasure/eraser.test.ts`, `apps/server/app/erasure/wire.test.ts`, `apps/server/app/erasure/pgSteps.pg.test.ts`, `apps/server/app/status/forgetUser.test.ts`

**Interfaces:**
- Consumes: Task 1 (`opaqueIds.subjectOf`, `legacyIds`, `OpaqueIds.load/cached/forgetSubject`), `shredSubject` (`@loom/plugin-crypto`), `SubjectIndex` (`@loom/compliance`).
- Produces:
  - `opaqueIds/prefixes.ts`: `USER_ID_PREFIXES = ["u_", "h_"] as const`; `userPrefixes(userId: string, handle?: string | null): string[]`; `isOwnedBy(executionId: string, userId: string, handle?: string | null): boolean`; `listerPrefixes(userId, handle?): { exact: string[]; starts: string[] }`.
  - `subjectOfExecution(e: { executionId: string }): string` (unchanged signature; now `opaqueIds.subjectOf`); `executionIdFor` stays exported (an alias of `legacyIds.named`) until Task 7.
  - `ErasureDeps.handleOf?(req: ErasureRequest): Promise<string | null>` (absent means no handle), `ErasureDeps.forgetStatus(userId: string, handle?: string | null)` and `forgetActivity(userId, handle?)`, `ErasureParts.ids?: Pick<OpaqueIds, "load" | "cached" | "forgetSubject">`.
  - `UserExecutionLister = (modelId: string, userId: string, handle?: string | null) => Promise<readonly string[]>`; `forgetUserRows(service, modelId, userId, lister?, source?, handle?)`; `isUserExecution(executionId, userId, handle?)`.
  - `hydrateSubjectIndex` walks `u_` then `h_`; `redactIds` and `warningFor` know `h_` ids.

Behaviour (the evidence is F3 and F7): `subjectOfExecution` is the one mapping both encrypting stores and the compliance subject index use, and it reads the id only. For an old-format id it is the user UUID (as today); for a new-format id it is `h_<H>`; for a lineage line of either format it is the owner's subject; any other lineage id is `""` (the stores refuse). Erasure calls Loom's `eraseSubject` once per subject (`h_<H>` first, then the user), destroys `h_<H>`'s key in the `rows` step before the row that holds the handle is deleted, and the `key` step still destroys the user's key.

- [ ] **Step 1: Write the failing tests**

`apps/server/app/opaqueIds/prefixes.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { USER_ID_PREFIXES, isOwnedBy, listerPrefixes, userPrefixes } from "./prefixes";

const U = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const H = "a".repeat(26);
const H2 = "b".repeat(26);

describe("the user prefixes", () => {
  it("are the two ranges the walks cover", () => {
    expect([...USER_ID_PREFIXES]).toEqual(["u_", "h_"]);
  });

  it("userPrefixes is u_<uuid> always and h_<handle> once the user has a handle", () => {
    expect(userPrefixes(U)).toEqual([`u_${U}`]);
    expect(userPrefixes(U, null)).toEqual([`u_${U}`]);
    expect(userPrefixes(U, H)).toEqual([`u_${U}`, `h_${H}`]);
  });

  it("isOwnedBy takes the prefix itself, its : and .c- forms, and nothing that only looks like them", () => {
    for (const id of [`u_${U}`, `u_${U}:ingest-x`, `u_${U}.c-x`, `h_${H}`, `h_${H}:ingest-x`, `h_${H}.c-x~2`])
      expect(isOwnedBy(id, U, H)).toBe(true);
    for (const id of [`h_${H}`, `h_${H}:x`, `h_${H}.c-x`]) expect(isOwnedBy(id, U, null)).toBe(false);
    for (const id of [`u_${OTHER}:x`, `h_${H2}:x`, `u_${U}x:y`, `h_${H}x`, `h_${H}-c-x`, `u_${U}.d-x`])
      expect(isOwnedBy(id, U, H)).toBe(false);
  });

  it("listerPrefixes names each prefix exactly and its : and .c- forms as starts", () => {
    expect(listerPrefixes(U)).toEqual({ exact: [`u_${U}`], starts: [`u_${U}:`, `u_${U}.c-`] });
    expect(listerPrefixes(U, H)).toEqual({
      exact: [`u_${U}`, `h_${H}`],
      starts: [`u_${U}:`, `u_${U}.c-`, `h_${H}:`, `h_${H}.c-`],
    });
  });
});
```

Append to `apps/server/app/subject.test.ts` (it keeps its `executionIdFor` alias of `legacyIds.named`; add the import `import { OpaqueIds, legacyIds } ...` only if the file does not have it; `UserIds` come from `testOpaqueIds`):

```ts
describe("erasure subject of a new-format id", () => {
  const T = "00000000-0000-0000-0000-0000000000aa";
  const DOC = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4";
  const CHAT = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
  const P = "__loom_ui_lineage__:";

  it("is h_<handle> for every shape, with no key and no cache, and the user for the old shapes beside them", async () => {
    const t = testOpaqueIds();
    t.store.add(USER, T);
    const u = await t.ids.ensureUser({ tenantId: T, userId: USER });
    const subject = `h_${u.handle}`;
    expect(opaqueIds.current()).toBeUndefined(); // nothing installed: a cold process
    for (const executionId of [
      u.ingest(DOC, 2),
      `${u.ingest(DOC, 2)}::step#0`,
      u.visualize(DOC, 3, 2),
      u.suggestTags(DOC, 4),
      u.turnVisualize(CHAT, 9),
      u.chatTitle(CHAT),
      u.conversation(CHAT),
      `${u.conversation(CHAT)}~3`,
      `${P}${u.documentLineage(DOC)}`,
      `${P}${u.turnLineage(CHAT, 5)}`,
    ])
      expect(subjectOfExecution({ executionId })).toBe(subject);
    expect(subjectOfExecution({ executionId: legacyIds.ingest(USER, DOC, 2) })).toBe(USER);
    expect(subjectOfExecution({ executionId: `${P}${legacyIds.documentLineage(USER, DOC)}` })).toBe(USER);
  });

  it("does not map a lookalike to a handle, and answers no subject for a bad lineage id", () => {
    const H = "a".repeat(26);
    const T52 = "b".repeat(52);
    for (const executionId of [`h_${H}x:ingest`, `h_${H.slice(1)}:ingest`, `h_${H.toUpperCase()}:x`, `h_${H}-c-x`, `H_${H}:x`])
      expect(subjectOfExecution({ executionId })).toBe(`x:${executionId}`);
    for (const id of [`visuals-${H}`, `visuals-${H}-${T52}x`, `visuals-${H.toUpperCase()}-${T52}`, `turnvisuals-${H}-${T52}`])
      expect(subjectOfExecution({ executionId: `${P}${id}` })).toBe("");
  });
});
```

with these imports added at the top of `subject.test.ts`: `import { opaqueIds } from "./opaqueIds";` and `import { testOpaqueIds } from "./opaqueIds/testing";`.

Append to `apps/server/app/erasure/compliance.test.ts` (inside `describe("hydrateSubjectIndex", ...)`, after the "seeks to the user range" test; the existing test's `expect(seen.cursors).toHaveLength(2)` becomes the three calls below, because the `h_` range is walked after the `u_` range):

```ts
  it("walks the u_ range and then the h_ range, each seeking to its prefix", async () => {
    const tail = Array.from({ length: 50 }, (_, i) => `zz-${String(i).padStart(3, "0")}`);
    const head = Array.from({ length: 50 }, (_, i) => `aa-${String(i).padStart(3, "0")}`);
    const seen = { cursors: [] as (string | undefined)[] };
    const idx = index();
    expect(await hydrateSubjectIndex(listOnly([...head, ...ids, ...tail], seen), idx, 4)).toBe(6);
    expect(seen.cursors[0]).toBe("u_");
    expect(seen.cursors).toHaveLength(3); // u_ (two pages: the second reaches the first non-user id), then h_ (one page)
    expect(seen.cursors[2]).toBe("h_");
  });

  it("attributes new-format executions to their h_<handle> subject from the id alone, and a user's two subjects stay apart", async () => {
    const H = "a".repeat(26);
    const T52 = "b".repeat(52);
    const fresh = [
      `h_${H}:ingest-${T52}.2`,
      `h_${H}:visualize-${T52}.2-r1`,
      `h_${H}.c-${T52}~2`,
      `h_${H}-not-an-execution`, // the prefix, but not a user execution id
    ];
    const idx = index();
    expect(await hydrateSubjectIndex(listOnly([...ids, ...fresh]), idx)).toBe(9);
    expect(idx.executionsOf(`h_${H}`)).toEqual(fresh.slice(0, 3).sort());
    expect(idx.executionsOf(A)).toHaveLength(5);
    expect(idx.subjects()).toEqual([A, B, `h_${H}`].sort());
  });
```

and, in the `warningFor`/`redactIds` tests of the same file (find them with `grep -n "redactIds\|warningFor" apps/server/app/erasure/compliance.test.ts`), add:

```ts
  it("redacts an h_ execution id like a u_ one, whatever follows it", () => {
    const H = "a".repeat(26);
    const T52 = "b".repeat(52);
    for (const id of [`h_${H}:ingest-${T52}.2`, `h_${H}.c-${T52}~1`, `h_${H}`]) {
      const out = redactIds(`erasure of ${id} failed: ${id}`);
      expect(out).not.toContain(H);
      expect(out).toContain("<id>");
    }
    expect(warningFor(`stuck h_${"c".repeat(26)}:x`)).not.toContain("c".repeat(26));
  });
```

(add `redactIds` to that file's import from `./compliance`).

Append to `apps/server/app/status/forgetUser.test.ts` (reuse its fake `service` and `source` builders: read the file first and follow its helpers; the new cases are):

```ts
  it("isUserExecution takes the user's h_<handle> forms only when the handle is given", () => {
    const U = "11111111-1111-4111-8111-111111111111";
    const H = "a".repeat(26);
    expect(isUserExecution(`h_${H}:ingest-x`, U, H)).toBe(true);
    expect(isUserExecution(`h_${H}.c-x`, U, H)).toBe(true);
    expect(isUserExecution(`h_${H}:ingest-x`, U)).toBe(false);
    expect(isUserExecution(`h_${"b".repeat(26)}:ingest-x`, U, H)).toBe(false);
    expect(isUserExecution(`u_${U}:ingest-x`, U, H)).toBe(true);
  });
```

Append to `apps/server/app/erasure/eraser.test.ts` (inside the existing `describe`, using its `fakeDeps`, `request`, `STEP_ORDER` and `Eraser`; `handleOf` is optional, so the existing tests do not change):

```ts
  it("erases the h_<handle> subject first, then the user, and destroys the handle's key before the row goes", async () => {
    const { deps, calls } = fakeDeps([request()]);
    const subjects: string[] = [];
    deps.handleOf = async () => "a".repeat(26);
    deps.eraseSubject = async (subject) => {
      subjects.push(subject);
      return { outcome: "erased" };
    };
    const destroyed: string[] = [];
    deps.keys = {
      destroy: async (subject) => void destroyed.push(subject),
      wasDestroyed: async () => true,
    };
    const forgot: unknown[] = [];
    deps.forgetStatus = async (u, h) => void forgot.push([u, h]);
    await new Eraser(deps).run(USER);
    expect(subjects).toEqual([`h_${"a".repeat(26)}`, USER]);
    expect(destroyed).toEqual([`h_${"a".repeat(26)}`, USER]); // the handle's key in `rows`, the user's in `key`
    expect(destroyed[0]).toBe(`h_${"a".repeat(26)}`);
    expect(forgot).toEqual([[USER, "a".repeat(26)]]);
    expect(calls).toContain("rows");
  });

  it("a parked h_ subject stops the work again, never touches the user's subject meanwhile, and retries from the same subject", async () => {
    const { deps } = fakeDeps([request()]);
    const asked: string[] = [];
    const answers: ("parked" | "erased")[] = ["parked", "erased", "erased"];
    deps.handleOf = async () => "a".repeat(26);
    deps.eraseSubject = async (subject) => {
      asked.push(subject);
      return { outcome: answers.shift() ?? "erased" };
    };
    await new Eraser(deps).run(USER);
    const handle = `h_${"a".repeat(26)}`;
    expect(asked).toEqual([handle, handle, USER]);
  });

  it("without a handle only the user's subject is erased", async () => {
    const { deps } = fakeDeps([request()]);
    const subjects: string[] = [];
    deps.eraseSubject = async (subject) => {
      subjects.push(subject);
      return { outcome: "erased" };
    };
    await new Eraser(deps).run(USER);
    expect(subjects).toEqual([USER]);
  });
```

Append to `apps/server/app/erasure/wire.test.ts` (it builds `parts()` and calls `erasureDeps(p)`; add `ids` through `over`):

```ts
  it("cancels the chat title under both formats and stops both conversations when the user has a handle", async () => {
    const t = testOpaqueIds();
    t.store.add(USER, TENANT);
    const user = await t.ids.ensureUser({ tenantId: TENANT, userId: USER });
    const { calls, parts: p } = parts({ ids: t.ids });
    const deps = erasureDeps(p);
    await deps.cancelTitle(who, CHAT);
    expect(calls).toEqual(
      expect.arrayContaining([
        `cancel:${legacyIds.chatTitle(USER, CHAT)}`,
        `cancel:${user.chatTitle(CHAT)}`,
      ]),
    );
    await deps.stopChat(who, CHAT);
    expect(calls).toEqual(
      expect.arrayContaining([
        `stop:${legacyIds.conversation(USER, CHAT)}`,
        `stop:${user.conversation(CHAT)}`,
      ]),
    );
  });

  it("a user with no handle cancels the old formats only, and a destroyed key reads as no new-format runs", async () => {
    const t = testOpaqueIds();
    t.store.add(USER, TENANT);
    const none = parts({ ids: t.ids });
    await erasureDeps(none.parts).cancelTitle(who, CHAT);
    expect(none.calls.filter((c) => c.startsWith("cancel:"))).toEqual([`cancel:${legacyIds.chatTitle(USER, CHAT)}`]);
    await t.ids.ensureUser({ tenantId: TENANT, userId: USER });
    await t.keys.destroy(USER);
    t.ids.forgetSubject(USER);
    const gone = parts({ ids: t.ids });
    await expect(erasureDeps(gone.parts).cancelTitle(who, CHAT)).resolves.toBeUndefined();
    expect(gone.calls.filter((c) => c.startsWith("cancel:"))).toEqual([`cancel:${legacyIds.chatTitle(USER, CHAT)}`]);
  });

  it("forgets the cached id key of every subject whose key it destroys", async () => {
    const t = testOpaqueIds();
    t.store.add(USER, TENANT);
    const user = await t.ids.ensureUser({ tenantId: TENANT, userId: USER });
    const { parts: p } = parts({ ids: t.ids });
    await erasureDeps(p).keys.destroy(`h_${user.handle}`);
    expect(t.ids.cached(USER)).toBeUndefined();
  });
```

with the imports `import { legacyIds } from "../opaqueIds";` and `import { testOpaqueIds } from "../opaqueIds/testing";`.

Append to `apps/server/app/erasure/pgSteps.pg.test.ts`, after the existing `rows` test (it already has `tenantWith`, `request`, `count`, `sql`, `durable` and `db`):

```ts
  it("rows: also deletes the user's timers and leases under the h_<handle> prefix, reads the handle before the row goes, and leaves another user's", async () => {
    const { tenantId, users } = await tenantWith("handle@erase.test");
    const [u] = users as [(typeof users)[0]];
    const mine = "a".repeat(26);
    const theirs = "b".repeat(26);
    await db.owner.query(
      "UPDATE users SET id_handle = $2, email = 'erased:' || id::text, erasing_at = now() WHERE id = $1",
      [u.userId, mine],
    );
    const own = [`h_${mine}:ingest-${"c".repeat(52)}.2`, `h_${mine}.c-${"d".repeat(52)}`];
    const other = `h_${theirs}:ingest-${"c".repeat(52)}.2`;
    for (const id of [...own, other]) {
      await durable.pool.query("INSERT INTO loom.timers (execution_id, wake_at) VALUES ($1, 1)", [id]);
      await durable.pool.query(
        "INSERT INTO loom.leases (execution_id, owner, expires_at) VALUES ($1, 'x', 1)",
        [id],
      );
    }
    expect(await sql.handleOf?.(request(tenantId, u.userId))).toBe(mine);

    await sql.rows(request(tenantId, u.userId));
    await sql.rows(request(tenantId, u.userId)); // idempotent

    for (const id of own) {
      expect(
        await count("SELECT count(*)::int AS n FROM loom.timers WHERE execution_id = $1", [id]),
      ).toBe(0);
      expect(
        await count("SELECT count(*)::int AS n FROM loom.leases WHERE execution_id = $1", [id]),
      ).toBe(0);
    }
    expect(
      await count("SELECT count(*)::int AS n FROM loom.timers WHERE execution_id = $1", [other]),
    ).toBe(1);
    expect(
      await count("SELECT count(*)::int AS n FROM loom.leases WHERE execution_id = $1", [other]),
    ).toBe(1);
    expect(await sql.handleOf?.(request(tenantId, u.userId))).toBeNull(); // the row is gone: nothing left to read it from
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `set -a; . ./.env; set +a; cd apps/server && pnpm exec vitest run app/opaqueIds/prefixes app/subject app/erasure app/status/forgetUser`
Expected: FAIL (no `prefixes` module; `handleOf`, the `h_` hydrate range and the two-subject erasure do not exist).

- [ ] **Step 3: Write the prefixes module and the subject mapping**

`apps/server/app/opaqueIds/prefixes.ts`:

```ts
/**
 * User-owned execution ids start with one of these: `u_<uuid>` (every run before the deploy) and `h_<handle>` (every run after). The log
 * lists ids in code-point order, so each is one contiguous run: a walk seeks to the prefix and stops at the first id past it.
 */
export const USER_ID_PREFIXES = ["u_", "h_"] as const;

/** The id prefixes of one user's executions: `u_<uuid>` always, `h_<handle>` once the user has a handle. */
export const userPrefixes = (userId: string, handle?: string | null): string[] => [
  `u_${userId}`,
  ...(handle ? [`h_${handle}`] : []),
];

/** Whether an execution id is the user's: a prefix itself, `<prefix>:...` (a flow) or `<prefix>.c-...` (a chat conversation, any generation). */
export const isOwnedBy = (executionId: string, userId: string, handle?: string | null): boolean =>
  userPrefixes(userId, handle).some(
    (p) =>
      executionId === p || executionId.startsWith(`${p}:`) || executionId.startsWith(`${p}.c-`),
  );

/**
 * What a `starts_with` lister matches: each prefix by equality, and its `:` and `.c-` forms by prefix. Bound as text, never `LIKE`:
 * `_` is a wildcard there and the prefix holds one.
 */
export const listerPrefixes = (
  userId: string,
  handle?: string | null,
): { exact: string[]; starts: string[] } => {
  const exact = userPrefixes(userId, handle);
  return { exact, starts: exact.flatMap((p) => [`${p}:`, `${p}.c-`]) };
};
```

Append to `apps/server/app/opaqueIds/index.ts`:

```ts
export { USER_ID_PREFIXES, isOwnedBy, listerPrefixes, userPrefixes } from "./prefixes";
```

Replace the whole of `apps/server/app/subject.ts` with:

```ts
import { legacyIds, opaqueIds } from "./opaqueIds";

export { chatConversationId, chatIdOfConversation } from "./chats/ids";
export type { ChatConversationId } from "./chats/ids";
export type { UserExecutionId } from "./opaqueIds";

/**
 * The erasure subject of an execution, from the id alone (no key, no cache, so it never misses at boot or on a replica that has not
 * seen the user): the user UUID for old-format ids (`u_<uuid>`, `u_<uuid>:...`, `u_<uuid>.c-...`), `h_<H>` for new-format ids, the same two
 * for a lineage line (`__loom_ui_lineage__:visuals-...` or `turnvisuals-...`), and `x:<id>` for an execution no user owns (it survives user
 * erasure, so every user-owned execution must be built by `opaqueIds`). Loom encrypts an execution's data under the key of its subject and
 * learns the subject from the execution id alone, so everything a user owns sits under two keys, the user's data key and `h_<H>`'s, and
 * erasure destroys both. A lineage id of any other shape resolves to "" (no subject): the encrypting stores refuse to write under it,
 * never seal it under a key erasure would miss. See `opaqueIds/ids.ts` `subjectOfId`.
 */
export function subjectOfExecution(e: { executionId: string }): string {
  return opaqueIds.subjectOf(e.executionId);
}

/**
 * The old-format id builder, kept so the families that still build `u_<user>:<name>` compile until each moves to `opaqueIds`
 * (the document flows in tasks 5 and 6, the chat flows in phase 2). Task 7 removes it.
 */
export const executionIdFor = legacyIds.named;
```

- [ ] **Step 4: Rewrite the compliance hydrate and the redaction**

In `apps/server/app/erasure/compliance.ts`, add `import { USER_ID_PREFIXES } from "../opaqueIds";` before the `../subject` import, replace the block from `const UUID = /[0-9a-f]...` through the end of `redactIds` with:

```ts
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** A user or execution id: any UUID, a `u_…` id (`u_<uuid>` or `u_<uuid>:<chat or document>`) or an `h_…` id (`h_<handle>` and its `:` and `.c-` forms). */
const HAS_ID = new RegExp(`${UUID.source}|\\b[uh]_[0-9A-Za-z_-]{6,}`, "i");
const ID = "<id>";
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/**
 * Replaces every id in a Loom notice and keeps the rest, so an operator still reads what happened
 * (`execution "<id>": REFUSED ... key-unavailable ...`): a whole `u_…` or `h_…` execution id (with its `:name`, `.c-<uuid>` or `.n`
 * suffix), the quoted execution id after the word `execution`, any bare UUID, and any email-shaped string (`<email>`).
 */
export function redactIds(message: string): string {
  return message
    .replace(/(\bexecution\s+)"[^"]*"/gi, `$1"${ID}"`)
    .replace(/\b[uh]_[0-9A-Za-z_-]{6,}[^\s"',;)\]]*/g, ID)
    .replace(new RegExp(UUID.source, "gi"), ID)
    .replace(EMAIL, "<email>");
}
```

and replace everything from `const USER_PREFIX = "u_";` (the old constant and its comment) through the end of the file, keeping `export const HYDRATE_PAGE = 500;`, with:

```ts
export const HYDRATE_PAGE = 500;

```ts
const bootstrapOf = (executionId: string): EventEnvelope => ({
  id: `hydrate-${executionId}`,
  workflowId: "",
  executionId,
  eventType: "EXECUTION_STARTED",
  sequence: 0,
  timestamp: 0,
  payload: {},
});

/**
 * Rebuilds Loom's subject index after a restart (it is fed live by `onEvent` only, so a fresh process
 * has none of the executions it did not start, and `eraseSubject` would answer `unknown` and shred
 * nothing: finding E4). Lists the `u_…` executions and then the `h_…` executions, one page at a time, and hands the index a synthetic
 * bootstrap event for each. The resolver reads the id alone (no key, no cache: an `h_<H>` id's subject is `h_<H>`), so no event is read and nothing is
 * decrypted; a log whose first events were compacted away hydrates the same. Safe to call again and
 * alongside the live feed. Returns how many user executions it attributed.
 */
export async function hydrateSubjectIndex(
  raw: Pick<EventStore, "listExecutionsPage">,
  index: Pick<SubjectIndex, "handleEvent">,
  pageSize = HYDRATE_PAGE,
): Promise<number> {
  if (raw.listExecutionsPage === undefined)
    throw new TypeError("hydrateSubjectIndex: the event store cannot list executions");
  let attributed = 0;
  for (const prefix of USER_ID_PREFIXES) {
    let cursor: string = prefix; // the cursor is strictly-after: every id of the run sorts after the bare prefix
    for (;;) {
      const page = await raw.listExecutionsPage({ cursor, limit: pageSize });
      let pastRun = false;
      for (const executionId of page.executionIds) {
        if (!executionId.startsWith(prefix)) {
          pastRun = true; // past this prefix's range
          break;
        }
        if (userSubjectOf({ executionId }) === undefined) continue; // the prefix, but not a user execution id
        index.handleEvent(bootstrapOf(executionId));
        attributed += 1;
      }
      if (pastRun || page.nextCursor === undefined) break;
      cursor = page.nextCursor;
    }
  }
  return attributed;
}
```
```

(The old `USER_PREFIX` constant and its doc comment are deleted; `USER_ID_PREFIXES` replaces it.)

- [ ] **Step 5: The eraser, its wiring and the Postgres steps**

`apps/server/app/erasure/eraser.ts`. Add `import { opaqueIds } from "../opaqueIds";` (the `h_<handle>` subject is built by `opaqueIds.subjectOfHandle`, never by string in this file: Task 7's ratchet forbids it). In `ErasureDeps`, replace the `eraseSubject`, `forgetStatus` and `forgetActivity` members and add `handleOf`:

```ts
  /**
   * `app.eraseSubject(subjectId, undefined, { parked: "shred" })`, once per Loom subject: the user's `h_<handle>` (new-format runs) and the user's UUID
   * (old-format runs). The tenant argument is undefined on purpose: DocMind has no `tenantOf`, so Loom's subject index has one partition, and a
   * tenant id would answer `unknown`.
   */
  eraseSubject(subjectId: string): Promise<{ outcome: "erased" | "parked" | "unknown" }>;
  /**
   * The user's id handle (`users.id_handle`), or null (no new-format run was ever started, or the row is gone). Read while the row exists, so
   * the steps before `rows` can name the `h_<handle>` subject and prefix. Absent: no handle.
   */
  handleOf?(req: ErasureRequest): Promise<string | null>;
  keys: {
    destroy(subjectId: string): Promise<void>;
    wasDestroyed(subjectId: string): Promise<boolean>;
  };
  forgetStatus(userId: string, handle?: string | null): Promise<unknown>;
  forgetActivity(userId: string, handle?: string | null): Promise<unknown>;
```

Replace the `shred`, `readModels` and `rows` cases of `step`:

```ts
      case "shred": {
        // The handle's subject first: while it is parked nothing else is erased, and a retry starts over at the same subject.
        const handle = (await deps.handleOf?.(req)) ?? null;
        const subjects = [...(handle === null ? [] : [opaqueIds.subjectOfHandle(handle)]), req.userId];
        const erased: string[] = [];
        for (const subject of subjects) {
          const { outcome } = await deps.eraseSubject(subject);
          if (outcome === "parked") {
            // A turn is still running. Stop whatever started since, then wait and ask again.
            await this.stopWork(req);
            throw new ErasureParkedError();
          }
          // 'unknown': the subject owns no execution. 'erased': the shred destroyed the key itself (E2).
          if (outcome === "erased") erased.push(subject);
        }
        for (const subject of erased)
          if (!(await deps.keys.wasDestroyed(subject))) throw new KeyNotDestroyedError();
        return;
      }
      case "readModels": {
        const handle = (await deps.handleOf?.(req)) ?? null;
        await deps.forgetStatus(req.userId, handle);
        await deps.forgetActivity(req.userId, handle);
        return;
      }
      case "rows": {
        // The handle's key goes BEFORE the row that holds the handle: after the delete nothing can name `h_<handle>` any more (and the
        // erasure request must not keep it: that would link the handle to the user for good). Destroying is idempotent.
        const handle = (await deps.handleOf?.(req)) ?? null;
        if (handle !== null) await deps.keys.destroy(opaqueIds.subjectOfHandle(handle));
        return deps.rows(req);
      }
```

`apps/server/app/erasure/wire.ts`. Add the imports `import { FieldKeyUnavailableError } ...` is not needed; add `import { type OpaqueIds, legacyIds } from "../opaqueIds";` and remove `import { chatConversationId } from "../chats/ids";` and `import { executionIdFor } from "../subject";` (their uses are replaced below). In `ErasureParts` add:

```ts
  /** The id key cache: erasure reads an existing user's key (never mints one) to name their new-format runs, and evicts it when a subject key is destroyed. Absent: old-format ids only. */
  ids?: Pick<OpaqueIds, "load" | "cached" | "forgetSubject">;
```

and change `sql` to `sql: Pick<ErasureDeps, "lock" | "work" | "rows" | "blobs" | "handleOf">;`. Inside `erasureDeps`, before `return`, add:

```ts
  /** The user's id builders when the user has a handle and a live key; undefined otherwise (a destroyed key means no new-format run can still be running). */
  const userIdsOf = async (identity: Identity) =>
    p.ids && (await p.ids.load(identity)) ? p.ids.cached(identity.userId) : undefined;
```

Replace `stopChat`, `cancelTitle` and `keys` in the returned object:

```ts
    async stopChat(identity: Identity, chatId: string) {
      if (!p.chat) return;
      const user = await userIdsOf(identity);
      // A conversation of either format may be live: stop and close both (a never-started one is "not found", as before).
      const conversationIds = [
        legacyIds.conversation(identity.userId, chatId),
        ...(user ? [user.conversation(chatId)] : []),
      ];
      for (const conversationId of conversationIds) {
        p.chat.stops.stop(conversationId); // aborts a running turn at its next checkpoint
        try {
          await p.chat.conversations.close(conversationId, { principal: principalOf(identity) });
        } catch (err) {
          // Never started, or closed already: nothing to wind down.
          if (!(err instanceof ConversationNotFoundError || err instanceof InboxClosedError))
            throw err;
        }
      }
    },
    async cancelTitle(identity, chatId) {
      const user = await userIdsOf(identity);
      const executionIds = [
        legacyIds.chatTitle(identity.userId, chatId),
        ...(user ? [user.chatTitle(chatId)] : []),
      ];
      for (const executionId of executionIds) {
        try {
          await p.runtime.cancel(executionId, ERASED, { principal: principalOf(identity) });
        } catch (err) {
          if (!isNoExecution(err, executionId)) throw err;
        }
      }
    },
    eraseSubject: (subjectId) => p.app.eraseSubject(subjectId, undefined, { parked: "shred" }),
    keys: {
      destroy: async (subjectId) => {
        await p.keys.destroy(subjectId);
        p.ids?.forgetSubject(subjectId); // the cached id key came from this key: it must not outlive it
      },
      wasDestroyed: async (subjectId) => (await p.keys.wasDestroyed?.(subjectId)) === true,
    },
    forgetStatus: (userId, handle) => p.status.forgetUser(userId, handle),
    forgetActivity: (userId, handle) => p.activity.forgetUser(userId, handle),
```

and widen the parts' types: `status: { forgetUser(userId: string, handle?: string | null): Promise<unknown> };` and the same for `activity`. Also change `app.eraseSubject(userId: string, tenantId: undefined, ...)` to `eraseSubject(subjectId: string, tenantId: undefined, ...)`. (The existing wire test at line 152 expects `cancelTitle` to reject with a `RangeError` for a bad chat id: `legacyIds.chatTitle` throws one, so it still does.)

`apps/server/app/erasure/pgSteps.ts`. Add `import { userPrefixes } from "../opaqueIds";`, change the return type to `Pick<ErasureDeps, "lock" | "work" | "rows" | "blobs" | "handleOf">`, and inside `pgErasureSql` before the `return`, add:

```ts
  /** The user's `users.id_handle`, read under the tenant while the row exists; null when there is none (or no row). */
  const handleOf = (req: ErasureRequest): Promise<string | null> =>
    withTenant(app, req.tenantId, async (tx) => {
      const { rows } = await tx.query<{ id_handle: string | null }>(
        "SELECT id_handle FROM users WHERE id = $1 AND tenant_id = $2",
        [req.userId, req.tenantId],
      );
      return rows[0]?.id_handle ?? null;
    });
```

Add `handleOf,` to the returned object, and replace the body of `rows` with:

```ts
    async rows(req: ErasureRequest) {
      // The throttle counters are not touched here: they are keyed by a hash of the email, which the request
      // transaction already replaced, so the route clears them (Task 170a).
      // 1. Loom retires the timers of terminal executions but has no prefix API: remove what is left, under both prefixes
      //    (`u_<uuid>` for runs before the deploy, `h_<handle>` after). This runs BEFORE the user row goes, because the handle that
      //    names the second prefix is on that row; a retry after the row is gone has no handle, and nothing left to find.
      for (const prefix of userPrefixes(req.userId, await handleOf(req))) {
        await loom.query("DELETE FROM loom.timers WHERE starts_with(execution_id, $1)", [prefix]);
        await loom.query("DELETE FROM loom.leases WHERE starts_with(execution_id, $1)", [prefix]);
      }
      // 2. The user row: the foreign keys cascade to sessions, documents (chunks, parsed text, links, entities, visual facts),
      //    tags (with their links and suggestions) and chats (turn items, reasoning texts). The handle goes with it.
      await withTenant(app, req.tenantId, (tx) =>
        tx.query("DELETE FROM users WHERE id = $1 AND tenant_id = $2", [req.userId, req.tenantId]),
      );
      // 3. The personal tenant goes with its last user (D6). A tenant with other users stays.
      await app.query("SELECT public.docmind_delete_empty_tenant($1)", [req.tenantId]);
    },
```

- [ ] **Step 6: The read-model forget walk**

`apps/server/app/status/forgetUser.ts`: replace the top of the file (the lister type, `isUserExecution` and `userExecutionsInLog`) and the signature and body of `forgetUserRows` as follows; the doc comment above `forgetUserRows` gains "and, with a `handle`, the user's `h_<handle>` executions":

```ts
import type { ReadModelEventSource, ReadModelService } from "@loom/plugin-read-model";
import { isOwnedBy, userPrefixes } from "../opaqueIds";

/** The user's rows of a model that are not yet tombstoned (their execution ids, never their state), under both id formats when the user has a handle. */
export type UserExecutionLister = (
  modelId: string,
  userId: string,
  handle?: string | null,
) => Promise<readonly string[]>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const PAGE = 500;

/** Whether an execution id belongs to the user: `u_<id>` itself, `u_<id>:…` (ingest, title) or `u_<id>.c-…` (chat), and the same under `h_<handle>`. */
export const isUserExecution = (
  executionId: string,
  userId: string,
  handle?: string | null,
): boolean => isOwnedBy(executionId, userId, handle);

/** The user's executions in the event log, by id prefix (a keyset walk from each prefix; a source without pages is filtered whole). */
async function userExecutionsInLog(
  source: ReadModelEventSource,
  userId: string,
  handle?: string | null,
): Promise<string[]> {
  if (!source.listExecutionsPage) {
    return ((await source.listExecutions?.()) ?? []).filter((id) =>
      isUserExecution(id, userId, handle),
    );
  }
  const out: string[] = [];
  for (const prefix of userPrefixes(userId, handle)) {
    out.push(prefix);
    let cursor: string | undefined = prefix;
    while (cursor !== undefined) {
      const page: { executionIds: string[]; nextCursor?: string } = await source.listExecutionsPage({
        cursor,
        limit: PAGE,
      });
      let past = false;
      for (const id of page.executionIds) {
        if (!id.startsWith(prefix)) {
          past = true; // ids sort by code point: the prefix is contiguous
          break;
        }
        if (isUserExecution(id, userId, handle)) out.push(id);
      }
      if (past) break;
      cursor = page.nextCursor;
    }
  }
  return out;
}
```

and in `forgetUserRows` add the parameter `handle?: string | null` after `source`, call `userExecutionsInLog(source, scope, handle)` and `lister(modelId, scope, handle)`.

`apps/server/app/status/pgStores.ts`: replace `pgUserExecutions` (keep its doc comment, adding "and under `h_<handle>` when the user has a handle") with:

```ts
import { listerPrefixes } from "../opaqueIds";

export const pgUserExecutions =
  (loomPool: Pick<Pool, "query">): UserExecutionLister =>
  async (modelId, userId, handle) => {
    const { exact, starts } = listerPrefixes(userId, handle);
    // Without a handle the second set repeats the first: harmless, and the statement keeps one shape.
    const [e1, e2] = [exact[0] as string, exact[1] ?? (exact[0] as string)];
    const [s1, s2] = [starts[0] as string, starts[1] as string];
    const [s3, s4] = [starts[2] ?? s1, starts[3] ?? s2];
    const { rows } = await loomPool.query<{ execution_id: string }>(
      `SELECT execution_id FROM public.read_model_state
        WHERE model_id = $1 AND NOT erased
          AND (execution_id = $2 OR starts_with(execution_id, $3) OR starts_with(execution_id, $4)
            OR execution_id = $5 OR starts_with(execution_id, $6) OR starts_with(execution_id, $7))
        ORDER BY execution_id
        LIMIT ${LIST_BATCH}`,
      [modelId, e1, s1, s2, e2, s3, s4],
    );
    return rows.map((r) => r.execution_id);
  };
```

In `apps/server/app/status/ingestStatus.ts`, change `forgetUser(userId: string)` to `forgetUser(userId: string, handle?: string | null)` and pass `handle` as the last argument of `forgetUserRows`; in `apps/server/app/chats/activity.ts` do the same for `ChatActivity.forgetUser`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `set -a; . ./.env; set +a; cd apps/server && pnpm exec vitest run app/opaqueIds app/subject app/erasure app/status`
Expected: PASS, including the existing suites (the pg tests must show as run). The compliance cursor test now counts three calls.

- [ ] **Step 8: Typecheck, lint, commit**

Run: `pnpm exec biome check --write apps/server/app/opaqueIds apps/server/app/subject.ts apps/server/app/subject.test.ts apps/server/app/erasure apps/server/app/status apps/server/app/chats/activity.ts && pnpm typecheck && pnpm typecheck:tests && pnpm lint`
Expected: no errors.

```bash
git add apps/server/app
git commit -m "feat(ids): one subject mapping for both formats, erasure of both subjects, and the prefix walks"
```

---

### Task 4: Dual-format parsing everywhere, the ensure gate and the snapshot pruner (O5, F4, F9)

**Files:**
- Create: `apps/server/app/status/ensureGate.ts`
- Modify: `apps/server/app/status/model.ts:36-85`, `apps/server/app/status/ingestStatus.ts`, `apps/server/app/chats/ids.ts`, `apps/server/app/chats/activity.ts`, `apps/server/app/flows/visualize-document/runs.ts:99-135`, `apps/server/app/flows/visualize-document/extract.ts:6,252`, `apps/server/app/flows/visualize-turn/ids.ts`, `apps/server/app/flows/visualize-turn/trigger.ts:29`, `apps/server/app/flows/suggest-tags/start.ts` (`isSuggestTagsExecution`), `apps/server/app/snapshots/pruner.ts:79-84`
- Not changed, and why: `chats/scope.ts:37` and `chats/reasoningStore.ts:39` already call `chatIdOfConversation`, which now reads both formats; `flows/visualize-document/structure.ts:45` and `deps.ts:49` call `visualizeGenerationOf`, which now needs no key; `bootIngest.ts` (`recoveryOwns`) and `config.ts` (`compactionExempt`) call the shape-only predicates.
- Test: `apps/server/app/status/ensureGate.test.ts`, `status/model.test.ts`, `status/ingestStatus.test.ts`, `chats/ids.test.ts`, `chats/activity.test.ts`, `flows/visualize-document/runs.test.ts`, `flows/visualize-turn/trigger.test.ts`, `snapshots/pruner.test.ts`, `bootIngest.test.ts`

**Interfaces:**
- Consumes: Tasks 1 and 3 (`opaqueIds.parse/clear/family/handleOf/known/ensure/loadUser`, `USER_ID_PREFIXES`, `testOpaqueIds`).
- Produces:
  - `ensureGate(report: (err: unknown) => void, sleep?: (ms: number) => Promise<void>): ((handle: string | null, run: () => void) => void) & { idle(): Promise<void> }`; `ENSURE_ATTEMPTS` (4), `ENSURE_BACKOFF_MS` (250).
  - `status/model.ts`: `isIngestExecution`, `isVisualizeExecution`, `generationOf`, `visualizeGenerationOf`, `visualizeRunOf(id): { generation; rerun } | null` (no key); `ingestKeyOf`, `ingestScopeOf`, `parseVisualizeExecution` (need the user's key for a new-format id, `undefined` or `null` on a miss).
  - `chats/ids.ts`: `chatIdOfConversation(id)` (both formats), `isChatConversation(id)` and `isChatTitleExecution(id)` and `isRecoverableChatExecution(id)` (shape only), `chatConversationId` (still the old format until phase 2; a function declaration, which `chats/startRatchet.test.ts` requires).
  - `flows/visualize-turn/ids.ts`: `parseTurnExecution`, `isTurnVisualizeExecution` (both formats); the turn builders stay old-format until phase 2.
  - `UserIdSource`-free: nothing here builds an id.

Behaviour (the evidence is F4): every classification, the ingest generation, the run number and the ordinal are in the clear, so the fold, recovery ownership, compaction exemption and the pruner never miss on a cold cache. Only the status fold's key and scope, the run recorder, the ready hook, chat scope and activity need a user, and each reaches the cache through an awaited `ensure` (`ensureGate` for the two synchronous feeds, an `await` at the async entries).

- [ ] **Step 1: Write the failing tests**

`apps/server/app/status/ensureGate.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpaqueIds, opaqueIds } from "../opaqueIds";
import { testOpaqueIds } from "../opaqueIds/testing";
import { ENSURE_ATTEMPTS, ensureGate } from "./ensureGate";

const T = "00000000-0000-0000-0000-0000000000aa";
const U = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const noSleep = async () => {};

afterEach(() => opaqueIds.install(undefined));

async function cold() {
  const t = testOpaqueIds();
  t.store.add(U, T);
  t.store.add(U2, T);
  const a = await t.ids.ensureUser({ tenantId: T, userId: U });
  const b = await t.ids.ensureUser({ tenantId: T, userId: U2 });
  const fresh = new OpaqueIds(t.keys, t.store); // a process that has booted without them
  opaqueIds.install(fresh);
  return { ...t, fresh, a: a.handle, b: b.handle };
}

describe("ensureGate", () => {
  it("runs at once, in the same tick, for an old-format id and for a cached handle", async () => {
    const { fresh, a } = await cold();
    await fresh.ensureHandle(a);
    const seen: string[] = [];
    const gate = ensureGate(() => {}, noSleep);
    gate(null, () => seen.push("old"));
    gate(a, () => seen.push("cached"));
    expect(seen).toEqual(["old", "cached"]);
  });

  it("queues a cold handle until ensure fills the cache, and keeps log order for later events", async () => {
    const { a, b, fresh } = await cold();
    await fresh.ensureHandle(b);
    const seen: string[] = [];
    const gate = ensureGate(() => {}, noSleep);
    gate(a, () => seen.push(`first:${opaqueIds.known(a)}`)); // cold: waits
    gate(b, () => seen.push("second")); // cached, but must not overtake the first
    gate(null, () => seen.push("third"));
    expect(seen).toEqual([]);
    await vi.waitFor(() => expect(seen).toEqual(["first:true", "second", "third"]));
    const later: string[] = [];
    gate(a, () => later.push("hot again"));
    expect(later).toEqual(["hot again"]); // the queue drained: the hot path is synchronous again
  });

  it("still runs for a handle nobody holds (an erased user): the fold writes the neutral row", async () => {
    await cold();
    const seen: string[] = [];
    const gate = ensureGate(() => {}, noSleep);
    gate("z".repeat(26), () => seen.push("erased"));
    await vi.waitFor(() => expect(seen).toEqual(["erased"]));
  });

  it("retries a failing ensure, then reports it and does not run the event", async () => {
    const { a, store } = await cold();
    let calls = 0;
    store.userOf = async () => {
      calls += 1;
      throw new Error("db down");
    };
    const reported: unknown[] = [];
    const seen: string[] = [];
    const gate = ensureGate((e) => reported.push(e), noSleep);
    gate(a, () => seen.push("ran"));
    gate(a, () => seen.push("ran again")); // queued behind it, same user: skipped without another round of retries
    await gate.idle();
    expect(reported).toHaveLength(1);
    expect(calls).toBe(ENSURE_ATTEMPTS);
    expect(seen).toEqual([]);
    const next: string[] = [];
    gate(null, () => next.push("after")); // the gate recovers: later events still flow
    expect(next).toEqual(["after"]);
  });

  it("idle resolves once everything queued has run, and at once when nothing is queued", async () => {
    const { a, b } = await cold();
    const seen: string[] = [];
    const gate = ensureGate(() => {}, noSleep);
    await gate.idle();
    gate(a, () => seen.push("a"));
    gate(b, () => seen.push("b"));
    expect(seen).toEqual([]);
    await gate.idle();
    expect(seen).toEqual(["a", "b"]);
  });
});
```

Append to `apps/server/app/status/model.test.ts` (add `afterEach` to the vitest import, `import { opaqueIds } from "../opaqueIds";`, `import { testOpaqueIds } from "../opaqueIds/testing";`, and `visualizeRunOf` to the `./model` import):

```ts
describe("new-format execution ids", () => {
  const T = randomUUID();
  afterEach(() => opaqueIds.install(undefined));

  async function user() {
    const t = testOpaqueIds();
    t.store.add(U, T);
    return { ids: t.ids, user: await t.ids.ensureUser({ tenantId: T, userId: U }) };
  }

  it("classification and the generation need no key; the user and the document need the cache", async () => {
    const { ids, user: u } = await user();
    const ingest = u.ingest(D, 3);
    const visualize = u.visualize(D, 3, 2);
    // A cold process: nothing installed.
    expect(opaqueIds.current()).toBeUndefined();
    expect([
      isIngestExecution(ingest),
      generationOf(ingest),
      isIngestExecution(visualize),
      isVisualizeExecution(visualize),
      isVisualizeExecution(ingest),
      visualizeGenerationOf(visualize),
      visualizeRunOf(visualize),
    ]).toEqual([true, 3, false, true, false, 3, { generation: 3, rerun: 2 }]);
    expect([
      ingestKeyOf(ingest),
      ingestScopeOf(ingest),
      parseVisualizeExecution(visualize),
    ]).toEqual([undefined, undefined, null]);
    // Warm: the same ids resolve.
    opaqueIds.install(ids);
    expect([ingestKeyOf(ingest), ingestScopeOf(ingest)]).toEqual([D, U]);
    expect(parseVisualizeExecution(visualize)).toEqual({
      userId: U,
      documentId: D,
      generation: 3,
      rerun: 2,
    });
  });

  it("an old-format id keeps resolving with nothing installed, beside a new one", async () => {
    const { ids, user: u } = await user();
    opaqueIds.install(ids);
    expect([ingestKeyOf(exec(".2")), ingestScopeOf(exec(".2"))]).toEqual([D, U]);
    expect(generationOf(u.ingest(D, 1))).toBe(1);
    expect(generationOf(exec())).toBe(1);
  });

  it("progressOf names the user and the document of a new-format event once the user is known, and nothing before", async () => {
    const { ids, user: u } = await user();
    const e = evt(u.ingest(D, 2), 1, "STEP_STARTED", { stepId: "ingest-embed" });
    expect(progressOf(e)).toBeNull();
    opaqueIds.install(ids);
    expect(progressOf(e)).toEqual({
      userId: U,
      progress: { documentId: D, step: "embed", status: "embedding" },
    });
  });
});
```

In `apps/server/app/status/ingestStatus.test.ts`: change the vitest import to `import { afterEach, describe, expect, it } from "vitest";`, add `import { OpaqueIds, opaqueIds } from "../opaqueIds";` and `import { testOpaqueIds } from "../opaqueIds/testing";`, and append (this is the cold-cache proof: the ready ingest is folded, published and fires `onReady` once; log order holds; a down key store is reported and the next boot folds the event):

```ts
describe("IngestStatus with new-format ids", () => {
  const T = randomUUID();
  const U2 = randomUUID();
  afterEach(() => opaqueIds.install(undefined));

  /** Users with handles, and a process whose key cache has never heard of them (a replica, or a user created after boot). */
  async function coldUsers() {
    const t = testOpaqueIds();
    t.store.add(U, T);
    t.store.add(U2, T);
    const user = await t.ids.ensureUser({ tenantId: T, userId: U });
    const second = await t.ids.ensureUser({ tenantId: T, userId: U2 });
    const cold = new OpaqueIds(t.keys, t.store);
    opaqueIds.install(cold);
    return { ...t, user, second, cold };
  }
  /** The first event of an ingest execution carries the start input, which holds the tenant (the ready hook reads it). */
  const withTenant = (events: ReturnType<typeof ingestRun>) => {
    const [first, ...rest] = events;
    return [{ ...(first as (typeof events)[0]), payload: { input: { tenantId: T } } }, ...rest];
  };

  it("a ready ingest on a cold cache is folded, published and fires onReady once; nothing is dropped", async () => {
    const { user } = await coldUsers();
    const ready: unknown[] = [];
    const { status, feed, errors, seen } = setup({
      onReady: (ref, generation) => ready.push([ref, generation]),
    });
    await status.boot();
    feed(...withTenant(ingestRun(user.ingest(D1, 2), "ready")));
    await status.close();
    expect((await status.forPage(ALICE, atDefault(D1))).get(D1)).toEqual({
      status: "ready",
      step: "finalize",
      error: null,
    });
    expect(ready).toEqual([[{ tenantId: T, userId: U, documentId: D1 }, 2]]);
    expect(seen).toContainEqual({ documentId: D1, step: "finalize", status: "ready" });
    expect(errors).toEqual([]);
  });

  it("keeps log order: a cold user's events are folded before a later event of a warm user", async () => {
    const { user, second, cold } = await coldUsers();
    await cold.ensureUser({ tenantId: T, userId: U2 }); // the second user is warm, the first is cold
    const { status, feed } = setup();
    await status.boot();
    feed(...ingestRun(user.ingest(D1, 2), "parsed")); // cold: waits for ensure
    feed(...ingestRun(second.ingest(D2, 2), "parsed")); // warm: must not overtake it
    await status.close();
    expect((await status.forPage(ALICE, atDefault(D1))).get(D1)).toMatchObject({
      status: "parsing",
    });
    const other = { tenantId: T, userId: U2 };
    expect((await status.forPage(other, atDefault(D2))).get(D2)).toMatchObject({
      status: "parsing",
    });
  });

  it("boot catch-up folds a new-format log once the key cache is warm", async () => {
    const { user, cold } = await coldUsers();
    const { log, status } = setup();
    log.append(...ingestRun(user.ingest(D1, 2), "ready"));
    await cold.warm();
    await status.boot();
    expect((await status.forPage(ALICE, atDefault(D1))).get(D1)).toMatchObject({ status: "ready" });
  });

  it("forDocument finds a row under either id format", async () => {
    const { user, cold } = await coldUsers();
    await cold.ensureUser({ tenantId: T, userId: U });
    const { log, status } = setup();
    await status.boot();
    log.append(...ingestRun(user.ingest(D1, 2), "ready")); // new format, never fed live
    log.append(...ingestRun(exec(D2), "ready")); // old format
    expect(await status.forDocument(ALICE, D1, 2)).toMatchObject({ status: "ready" });
    expect(await status.forDocument(ALICE, D2, 2)).toMatchObject({ status: "ready" });
  });

  it("a key store that is down for a cold user is reported, folds nothing, and the next boot's catch-up folds it", async () => {
    const { user, cold, store } = await coldUsers();
    const real = store.userOf.bind(store);
    store.userOf = async () => {
      throw new Error("key store down");
    };
    const { status, feed, errors, log, store: model, bus } = setup({ onReady: () => {} });
    await status.boot();
    feed(...withTenant(ingestRun(user.ingest(D1, 2), "ready")));
    await status.close();
    expect(errors).toHaveLength(1);
    store.userOf = real; // the store is back: the next boot warms and catches up from the watermark
    await cold.warm();
    expect((await status.forPage(ALICE, atDefault(D1))).get(D1)).toBeUndefined(); // it was not folded under an unknown user
    const next = new IngestStatus({
      writer: model,
      readerFor: () => model,
      source: log,
      sensitive: {},
      bus,
    });
    await next.boot();
    expect((await next.forPage(ALICE, atDefault(D1))).get(D1)).toMatchObject({ status: "ready" });
  });
});
```

Append to `apps/server/app/chats/ids.test.ts` (add `afterEach` to the vitest import and the two imports `import { opaqueIds } from "../opaqueIds";` and `import { testOpaqueIds } from "../opaqueIds/testing";`):

```ts
describe("the new chat shapes (read now, written by phase 2)", () => {
  const TENANT = "00000000-0000-0000-0000-0000000000aa";
  afterEach(() => opaqueIds.install(undefined));

  async function user() {
    const t = testOpaqueIds();
    t.store.add(USER, TENANT);
    return { ids: t.ids, user: await t.ids.ensureUser({ tenantId: TENANT, userId: USER }) };
  }

  it("reads the user and the chat of an h_ conversation, with or without a generation, once the user is cached", async () => {
    const { ids, user: u } = await user();
    const id = u.conversation(CHAT);
    expect(chatIdOfConversation(id)).toBeNull(); // cold: the tokens cannot be opened
    opaqueIds.install(ids);
    expect(chatIdOfConversation(id)).toEqual({ userId: USER, chatId: CHAT });
    expect(chatIdOfConversation(`${id}~3`)).toEqual({ userId: USER, chatId: CHAT });
    expect(chatIdOfConversation(u.chatTitle(CHAT))).toBeNull(); // a title is not a conversation
  });

  it("classifies a new-format conversation and title from the shape alone, so recovery never misses on a cold cache", async () => {
    const { user: u } = await user();
    expect(opaqueIds.current()).toBeUndefined();
    expect(isChatTitleExecution(u.chatTitle(CHAT))).toBe(true);
    expect(isChatTitleExecution(u.conversation(CHAT))).toBe(false);
    for (const id of [u.chatTitle(CHAT), u.conversation(CHAT), `${u.conversation(CHAT)}~2`])
      expect(isRecoverableChatExecution(id)).toBe(true);
    expect(isRecoverableChatExecution(u.ingest("0f8fad5b-d9cb-469f-a165-70867728950e", 2))).toBe(
      false,
    );
  });
});
```

Append to `apps/server/app/chats/activity.test.ts` (add `afterEach` to the vitest import and `import { OpaqueIds, opaqueIds } from "../opaqueIds";`, `import { testOpaqueIds } from "../opaqueIds/testing";`):

```ts
describe("ChatActivity with new-format conversation ids", () => {
  afterEach(() => opaqueIds.install(undefined));

  it("folds a conversation on a cold cache once the user's key is cached, under the chat id and its owner", async () => {
    const t = testOpaqueIds();
    t.store.add(U, T);
    const user = await t.ids.ensureUser({ tenantId: T, userId: U });
    opaqueIds.install(new OpaqueIds(t.keys, t.store)); // cold
    const conv = user.conversation(C);
    const s = await setup();
    s.feed(evt(conv, 0, "EXECUTION_STARTED", { input: {} }), record(conv, 1, 1, "user"));
    await s.activity.close();
    const rows = await s.rows();
    expect(rows.map((r) => r.executionId)).toEqual([conv]);
    expect(rows[0]?.state.n).toBeGreaterThan(0);
    expect(s.errors).toEqual([]);
  });
});
```

Append to `apps/server/app/flows/visualize-document/runs.test.ts` (add `import { OpaqueIds, opaqueIds } from "../../opaqueIds";` and `import { testOpaqueIds } from "../../opaqueIds/testing";`):

```ts
describe("visualRunRecorder with new-format ids", () => {
  it("records the end of a run on a cold cache once the user's key is cached, from the id alone otherwise", async () => {
    const T = randomUUID();
    const who = ids();
    const t = testOpaqueIds();
    t.store.add(who.userId, T);
    const user = await t.ids.ensureUser({ tenantId: T, userId: who.userId });
    opaqueIds.install(new OpaqueIds(t.keys, t.store)); // a process that has not cached this user
    try {
      const record = vi.fn<VisualRuns["record"]>(async () => {});
      const rec = visualRunRecorder({ runs: { record }, bus: new InMemoryProgressBus() });
      rec.onEvent(
        event(user.visualize(who.documentId, 3, 2), "EXECUTION_COMPLETED", {
          output: { outcome: "done" },
        }),
      );
      await rec.idle();
      expect(record).toHaveBeenCalledWith(
        { userId: who.userId, documentId: who.documentId, generation: 3, run: 2 },
        "done",
        undefined,
        factFormatFingerprint(),
      );
    } finally {
      opaqueIds.install(undefined);
    }
  });

  it("reports a key store that stays down and records nothing (the boot reconcile repairs the run)", async () => {
    const T = randomUUID();
    const who = ids();
    const t = testOpaqueIds();
    t.store.add(who.userId, T);
    const user = await t.ids.ensureUser({ tenantId: T, userId: who.userId });
    t.store.userOf = async () => {
      throw new Error("down");
    };
    opaqueIds.install(new OpaqueIds(t.keys, t.store));
    try {
      const record = vi.fn<VisualRuns["record"]>(async () => {});
      const errors: unknown[] = [];
      const rec = visualRunRecorder({
        runs: { record },
        bus: new InMemoryProgressBus(),
        onError: (e) => errors.push(e),
      });
      rec.onEvent(
        event(user.visualize(who.documentId, 2), "EXECUTION_COMPLETED", {
          output: { outcome: "done" },
        }),
      );
      await rec.idle();
      expect(record).not.toHaveBeenCalled();
      expect(errors).toHaveLength(1);
    } finally {
      opaqueIds.install(undefined);
    }
  });
});
```

Append to `apps/server/app/flows/visualize-turn/trigger.test.ts` (change the vitest import to include `afterEach`, add `import { OpaqueIds, opaqueIds } from "../../opaqueIds";` and `import { testOpaqueIds } from "../../opaqueIds/testing";`):

```ts
describe("turnToVisualize with a new-format conversation", () => {
  afterEach(() => opaqueIds.install(undefined));

  it("fills the key cache for the conversation's user before it reads the chat", async () => {
    const t = testOpaqueIds();
    t.store.add(user, tenant);
    const u = await t.ids.ensureUser({ tenantId: tenant, userId: user });
    opaqueIds.install(new OpaqueIds(t.keys, t.store)); // cold
    const conversationId = u.conversation(chat);
    const d = deps();
    expect(
      await turnToVisualize(event({ conversationId, executionId: conversationId }), d),
    ).toEqual({
      tenantId: tenant,
      userId: user,
      chatId: chat,
      ord: 4,
    });
    expect(d.tenantOf).toHaveBeenCalledWith(user, chat);
  });

  it("answers null for a conversation whose user is unknown (erased), and never reads a chat for it", async () => {
    const t = testOpaqueIds();
    t.store.add(user, tenant);
    const u = await t.ids.ensureUser({ tenantId: tenant, userId: user });
    opaqueIds.install(testOpaqueIds().ids); // a store that has never heard of this handle
    const conversationId = u.conversation(chat);
    const d = deps();
    expect(
      await turnToVisualize(event({ conversationId, executionId: conversationId }), d),
    ).toBeNull();
    expect(d.tenantOf).not.toHaveBeenCalled();
  });
});
```

In `apps/server/app/snapshots/pruner.test.ts`, insert before `describe("startSnapshotPruner"`:

```ts
describe("sweepChatSnapshots over both id formats", () => {
  it("walks the u_ range and then the h_ range, and prunes new-format conversations (every generation) and nothing else", async () => {
    const H = "a".repeat(26);
    const T52 = "b".repeat(52);
    const conversation = `h_${H}.c-${T52}`;
    const generation = `${conversation}~2`;
    const ingest = `h_${H}:ingest-${T52}.2`;
    const cursors: (string | undefined)[] = [];
    const { d } = deps([[CHAT]], {
      listExecutionsPage: vi.fn(async ({ cursor }: { cursor?: string }) => {
        cursors.push(cursor);
        return cursor === "h_"
          ? { executionIds: [conversation, generation, ingest, "zz-next"] }
          : { executionIds: [CHAT, INGEST, "h_after-the-u_-range"] };
      }),
    });
    const report = await sweepChatSnapshots(d);
    expect(cursors).toEqual(["u_", "h_"]);
    expect(vi.mocked(d.prune).mock.calls.map((c) => c[0])).toEqual([
      CHAT,
      conversation,
      generation,
    ]);
    expect(report.executions).toBe(3);
  });
});
```

In `apps/server/app/bootIngest.test.ts`, extend the `recoveryOwns` test with the new shapes (the last lines of the existing `it`):

```ts
    const handle = "a".repeat(26);
    const token = "b".repeat(52);
    expect(recoveryOwns(`h_${handle}:ingest-${token}.2`)).toBe(true);
    expect(recoveryOwns(`h_${handle}:visualize-${token}.2-r1`)).toBe(true);
    expect(recoveryOwns(`h_${handle}:visualize-turn-${token}-6-r2`)).toBe(true);
    expect(recoveryOwns(`h_${handle}:suggest-tags-${token}-r1`)).toBe(true);
    expect(recoveryOwns(`h_${handle}:chat-title-${token}`)).toBe(true);
    expect(recoveryOwns(`h_${handle}.c-${token}~2`)).toBe(true);
    expect(recoveryOwns(`h_${handle}:something-else`)).toBe(false);
```

(`bootIngest.test.ts` gets its warm-up tests in Task 6; the recovery list is the only change here.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/server && pnpm exec vitest run app/status app/chats/ids app/chats/activity.test app/flows/visualize-document/runs.test app/flows/visualize-turn/trigger app/snapshots/pruner app/bootIngest`
Expected: FAIL (`./ensureGate` does not exist; `visualizeRunOf` is not exported; the new-format ids do not parse).

- [ ] **Step 3: The ensure gate**

`apps/server/app/status/ensureGate.ts`:

```ts
import { opaqueIds } from "../opaqueIds";

/** Tries of one `ensure` before the event is given up on (the key store or the database is down), and the pause before the second. */
export const ENSURE_ATTEMPTS = 4;
export const ENSURE_BACKOFF_MS = 250;

/**
 * Keeps a synchronous feed (Loom's `observability.onEvent`) in log order while a new-format id's user may not be cached yet.
 *
 * `gate(handle, run)` runs `run` at once, in the same tick, when nothing is queued and the event's user is known (or the id has no
 * handle: an old-format id never needs a key). Otherwise `run` is queued behind everything already queued, after `opaqueIds.ensure(handle)`
 * has filled the cache, so a later event of a known user never overtakes an earlier one of a cold user. `ensure` answering false
 * (nobody holds the handle: the user is erased) still runs: the fold then writes the neutral row an erased user's execution gets.
 * An `ensure` that THROWS is retried; if it keeps throwing, the error is reported once (class only, by `report`) and `run` is NOT called, for
 * that event or for the events of the same user queued behind it (a user that failed is not retried again until the queue has drained): a
 * fold with an unknown user would store a row with no key and no scope, which every reader skips, so the event is left for the next
 * boot's catch-up, which folds from the watermark and has the warm cache. It is never dropped silently.
 */
export function ensureGate(
  report: (err: unknown) => void,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  let tail: Promise<void> | null = null;
  /** Handles whose `ensure` gave up during the current queue: their later queued events are skipped without another round of retries. */
  const failed = new Set<string>();
  const ensured = async (handle: string): Promise<boolean> => {
    let last: unknown;
    for (let attempt = 1; attempt <= ENSURE_ATTEMPTS; attempt++) {
      try {
        await opaqueIds.ensure(handle);
        return true;
      } catch (err) {
        last = err;
        if (attempt < ENSURE_ATTEMPTS) await sleep(ENSURE_BACKOFF_MS * 2 ** (attempt - 1));
      }
    }
    failed.add(handle);
    report(last);
    return false;
  };
  const gate = (handle: string | null, run: () => void): void => {
    if (tail === null && (handle === null || opaqueIds.known(handle))) {
      run();
      return;
    }
    const mine: Promise<void> = (tail ?? Promise.resolve())
      .then(async () => {
        if (handle !== null && !opaqueIds.known(handle)) {
          if (failed.has(handle) || !(await ensured(handle))) return;
        }
        run();
      })
      .catch(report)
      .finally(() => {
        if (tail === mine) {
          tail = null;
          failed.clear();
        }
      });
    tail = mine;
  };
  /** Resolves when everything queued so far has run (shutdown and tests). */
  const idle = async (): Promise<void> => {
    while (tail !== null) await tail;
  };
  return Object.assign(gate, { idle });
}
```

- [ ] **Step 4: The status model's parsers**

In `apps/server/app/status/model.ts` add `import { opaqueIds } from "../opaqueIds";` after the `../flows/ingest-document/errors` import, and replace everything from `const UUID = "[0-9a-f]...` through `generationOf` (the three old regexes and the functions built on them) with:

```ts
/**
 * An ingest or visualize execution of either id format. `isIngestExecution`, `isVisualizeExecution` and the generation read only what an id shows in
 * the clear, so they never miss on a cold key cache (the fold classifies every execution it sees). The user and the document of a NEW-format id are
 * sealed in its tokens: `ingestKeyOf`, `ingestScopeOf` and `parseVisualizeExecution` answer `undefined` or null for one whose user is not cached, so a caller
 * that can see one awaits `opaqueIds.ensure(handle)` first (`status/ensureGate.ts`; the ready hook; the run recorder).
 */
export const isVisualizeExecution = (executionId: string): boolean =>
  opaqueIds.family(executionId) === "visualize";

/** The parts of a visualize execution id (`rerun` is 0 for the automatic run, n for `-r<n>`); null for an id that is not one, or whose user is not cached. */
export const parseVisualizeExecution = (
  executionId: string,
): { userId: string; documentId: string; generation: number; rerun: number } | null => {
  const p = opaqueIds.parse(executionId);
  return p?.family === "visualize"
    ? {
        userId: p.userId,
        documentId: p.documentId as string,
        generation: p.generation as number,
        rerun: p.rerun as number,
      }
    : null;
};

/** The ingest generation and run number of a visualize execution, from the id alone (no key); null for an id that is not one. */
export const visualizeRunOf = (
  executionId: string,
): { generation: number; rerun: number } | null => {
  const c = opaqueIds.clear(executionId);
  return c?.family === "visualize"
    ? { generation: c.generation as number, rerun: c.rerun as number }
    : null;
};

/** The ingest generation a visualize execution ran for (no suffix is 1); `undefined` for an id that is not one. No key needed. */
export const visualizeGenerationOf = (executionId: string): number | undefined =>
  visualizeRunOf(executionId)?.generation;

export const ingestKeyOf = (executionId: string): string | undefined => {
  const p = opaqueIds.parse(executionId);
  return p?.family === "ingest" ? p.documentId : undefined;
};
export const ingestScopeOf = (executionId: string): string | undefined => {
  const p = opaqueIds.parse(executionId);
  return p?.family === "ingest" ? p.userId : undefined;
};
export const isIngestExecution = (executionId: string): boolean =>
  opaqueIds.family(executionId) === "ingest";
/** No suffix is generation 1; `undefined` for an id that is not an ingest execution. No key needed. */
export const generationOf = (executionId: string): number | undefined => {
  const c = opaqueIds.clear(executionId);
  return c?.family === "ingest" ? c.generation : undefined;
};
```

`flows/visualize-document/extract.ts`: change the import to `import { visualizeGenerationOf, visualizeRunOf } from "../../status/model";` and the line `const id = executionId === undefined ? null : parseVisualizeExecution(executionId);` to `const id = executionId === undefined ? null : visualizeRunOf(executionId);` (the step reads `id.rerun` and `id.generation` only).

- [ ] **Step 5: The ingest status gate, the ready hook and the readers**

In `apps/server/app/status/ingestStatus.ts`: remove `import { ingestExecutionId } from "../documents/ingest";`, add `import { legacyIds, opaqueIds } from "../opaqueIds";` and `import { ensureGate } from "./ensureGate";`, and replace the class header, fields and constructor with:

```ts
export class IngestStatus implements DocumentStatusReads {
  private readonly service: ReadModelService;
  private readonly report: (err: unknown) => void;
  private publishing: Promise<void> = Promise.resolve();
  private readonly gate: ReturnType<typeof ensureGate>;

  constructor(private readonly o: IngestStatusOptions) {
    this.report = o.onError ?? logClass;
    this.gate = ensureGate((err) => this.report(err));
    this.service = new ReadModelService(o.writer, {
      liveSource: o.source,
      sensitive: o.sensitive,
      onError: (err) => this.report(err),
    });
  }
```

Replace `onEvent`, add `fold`, and replace `ready` (they sit together between the constructor's `boot` and `forPage`):

```ts
  onEvent = (event: EventEnvelope): void => {
    if (!isIngestExecution(event.executionId)) return; // chat and title executions are not this model's
    // A new-format id hides its user and document in its tokens: the gate fills the key cache for a cold user first, and keeps log order.
    this.gate(opaqueIds.handleOf(event.executionId), () => this.fold(event));
  };

  private fold(event: EventEnvelope): void {
    this.service.handleEvent(event);
    const derived = progressOf(event);
    if (derived === null) return;
    this.publishing = this.publishing
      .then(() => this.service.drain())
      .then(() => this.o.bus.publish({ userId: derived.userId }, derived.progress))
      .then(() => {
        if (derived.progress.status === "ready") return this.ready(event.executionId);
      })
      .catch((err) => this.report(err));
  }

  /** The ready hook: the start input holds the tenant (the execution id and the event hold none). Never throws. */
  private async ready(executionId: string): Promise<void> {
    const { onReady } = this.o;
    const generation = generationOf(executionId);
    if (!onReady || generation === undefined) return;
    try {
      const handle = opaqueIds.handleOf(executionId);
      if (handle !== null) await opaqueIds.ensure(handle); // a cold cache must not make a ready document vanish
      const [first] = await this.o.source.readFrom(executionId, 0);
      const input = (first?.payload as { input?: Record<string, unknown> } | undefined)?.input;
      const tenantId = input?.tenantId;
      const userId = ingestScopeOf(executionId);
      const documentId = ingestKeyOf(executionId);
      // Only an erased user's id stays unresolved after `ensure` (an outage threw above, into the catch): nothing to start for them.
      if (typeof tenantId !== "string" || userId === undefined || documentId === undefined) return;
      onReady({ tenantId, userId, documentId }, generation);
    } catch (err) {
      this.report(err);
    }
  }
```

Replace `forPage` (the first lines load the user's key without minting; the scope check below it needs it for a new-format row):

```ts
  async forPage(
    identity: Identity,
    documents: readonly { id: string; generation: number }[],
  ): Promise<Map<string, StatusView>> {
    const views = new Map<string, StatusView>();
    if (documents.length === 0) return views;
    await opaqueIds.loadUser(identity); // the scope check below needs this user's key for a new-format row (no minting)
    // Stored keys are lowercase (routes lowercase ids too); answer under the caller's spelling.
    const wanted = new Map<string, { caller: string; generation: number }[]>();
    for (const d of documents) {
      const key = d.id.toLowerCase();
      wanted.set(key, [...(wanted.get(key) ?? []), { caller: d.id, generation: d.generation }]);
    }
    const reader = this.o.readerFor(identity);
    if (reader.getFoldedByKey === undefined)
      throw new TypeError("the status reader store has no folded-state support");
    for (const row of foldedStates(
      await reader.getFoldedByKey(INGEST_STATUS_MODEL, [...wanted.keys()]),
    )) {
      // Reader RLS is tenant-wide: owner scoping happens here (scope is the user id).
      if (row.key === null || ingestScopeOf(row.executionId) !== identity.userId) continue;
      const generation = generationOf(row.executionId);
      // Generation 1 is the bare id; `.1` is never emitted (Task 74b ruling).
      for (const w of wanted.get(row.key) ?? []) {
        if (w.generation === generation)
          views.set(w.caller, viewOf(row.state as IngestStatusState));
      }
    }
    return views;
  }
```

Replace `forDocument` (the read-repair refreshes the row under either format):

```ts
  async forDocument(
    identity: Identity,
    documentId: string,
    generation: number,
  ): Promise<StatusView> {
    // The writer refreshes (read-repair by execution id: a document with no row has no key to find); the reader reads. The row may
    // be under either id format (a run from before the deploy, or one after), so both candidates are refreshed.
    await opaqueIds.loadUser(identity);
    const id = documentId.toLowerCase();
    const user = opaqueIds.current()?.cached(identity.userId);
    await this.service.refresh(
      INGEST_STATUS_MODEL,
      [
        legacyIds.ingest(identity.userId, id, generation),
        ...(user ? [user.ingest(id, generation)] : []),
      ],
      [this.o.source],
    );
    return (
      (await this.forPage(identity, [{ id: documentId, generation }])).get(documentId) ?? UPLOADED
    );
  }
```

In `forgetDocument` add `await opaqueIds.loadUser(identity);` as its first line. In `drain()` and `close()` add `await this.gate.idle();` as the first line of each (the queued folds must finish before the model is drained).

- [ ] **Step 6: The chat parsers and the turn ids**

`apps/server/app/chats/ids.ts`: the file now starts with these imports, and everything from `declare const chatConversation` through the end of the file is replaced (the constants between them, `CHAT_FLOW_ID` through `isChatFlowId`, are unchanged):

```ts
import { type ChatConversationId, UUID_PATTERN, legacyIds, opaqueIds } from "../opaqueIds";

export { UUID_PATTERN };
export type { ChatConversationId };
```

```ts
export const isChatFlowId = (id: string): boolean => id === CHAT_FLOW_ID || id === CHAT_GK_FLOW_ID;

/**
 * The Loom conversation id of a chat. PHASE 2 switches this to `UserIds.conversation` (`h_<H>.c-<C>`); until then chats keep the old
 * `u_<user>.c-<chat>` (Loom ids may not contain a colon, so the `u_<uuid>:` form is not available). `subjectOfExecution` and
 * `chatIdOfConversation` read both formats, so every event of the chat (its generations `~n`, its inbox) is sealed under the owner's key.
 */
export function chatConversationId(userId: string, chatId: string): ChatConversationId {
  return legacyIds.conversation(userId, chatId);
}

/** The user and chat of a conversation or generation id of either format, or null when it is neither (or the new format's user is not cached). */
export function chatIdOfConversation(id: string): { userId: string; chatId: string } | null {
  const p = opaqueIds.parse(id);
  return p?.family === "conversation" ? { userId: p.userId, chatId: p.chatId as string } : null;
}

/** The execution of a chat's auto title (either format), from its shape alone. */
export const isChatTitleExecution = (id: string): boolean => opaqueIds.family(id) === "chatTitle";

/** A chat conversation (any generation) of either format, from its shape alone: no key, so recovery and compaction never miss on a cold cache. */
export const isChatConversation = (id: string): boolean => opaqueIds.family(id) === "conversation";

/** Every chat execution boot recovery may re-drive: a conversation (any generation) or a title flow (ruling P5). */
export const isRecoverableChatExecution = (id: string): boolean =>
  isChatConversation(id) || isChatTitleExecution(id);
```

`apps/server/app/chats/activity.ts`: add `import { opaqueIds } from "../opaqueIds";`, `import { ensureGate } from "../status/ensureGate";` and `isChatConversation` to the `./ids` import; replace `isChatExecution` with `export const isChatExecution = (executionId: string): boolean => isChatConversation(executionId);` (shape only); replace the class header with:

```ts
export class ChatActivity {
  private readonly service: ReadModelService;
  private readonly report: (err: unknown) => void;
  private readonly gate: ReturnType<typeof ensureGate>;

  constructor(private readonly o: ChatActivityOptions) {
    this.report = o.onError ?? logClass;
    this.gate = ensureGate((err) => this.report(err));
    this.service = new ReadModelService(o.writer, {
      liveSource: o.source,
      sensitive: o.sensitive,
      onError: (err) => this.report(err),
    });
  }
```

and the `onEvent`, `drain` and `close` members (the `forgetUser` member is the one from Task 3) with:

```ts
  /** `observability.onEvent` fan-out sink: synchronous, never throws. Only chat conversations are folded. */
  onEvent = (event: EventEnvelope): void => {
    if (!isChatConversation(event.executionId)) return;
    // A new-format id hides its user and chat in its tokens: the gate fills the key cache for a cold user first, and keeps log order.
    this.gate(opaqueIds.handleOf(event.executionId), () => this.service.handleEvent(event));
  };

  /** Wait for every fold scheduled so far. */
  /** User erasure: tombstones every chat-activity row of the user, the neutral rows of their ingest and title executions included. */
  forgetUser(userId: string, handle?: string | null): Promise<number> {
    return forgetUserRows(
      this.service,
      CHAT_ACTIVITY_MODEL,
      userId,
      this.o.userExecutions,
      this.o.source,
      handle,
    );
  }

  async drain(): Promise<void> {
    await this.gate.idle();
    await this.service.drain();
  }

  /** Callers detach the event feed first: events fed afterwards are not awaited. */
  async close(): Promise<void> {
    await this.gate.idle();
    await this.service.drain();
  }
}
```

with `await this.gate.idle();` added as the first line of `drain()` and `close()`.

`apps/server/app/flows/visualize-document/runs.ts`: add `import { opaqueIds } from "../../opaqueIds";` and `isVisualizeExecution` to the `../../status/model` import, and replace `onEvent` (the recorder classifies from the shape, then resolves the user inside its own chain, after `ensure`):

```ts
    onEvent(e) {
      if (
        e.eventType !== "EXECUTION_COMPLETED" &&
        e.eventType !== "EXECUTION_FAILED" &&
        e.eventType !== "EXECUTION_CANCELLED"
      )
        return;
      if (!isVisualizeExecution(e.executionId)) return; // from the id's shape alone: no key
      const end = endOf(e);
      if (!end) return;
      const legacy = o.legacyRuns?.delete(e.executionId) === true;
      const handle = opaqueIds.handleOf(e.executionId);
      chain = chain
        .then(async () => {
          // A new-format id hides its user and document: fill the key cache for a cold user first (an outage throws into `report`, and
          // the boot reconcile repairs a run whose end was not recorded). An erased user's run has no one to record for.
          if (handle !== null) await opaqueIds.ensure(handle);
          const id = parseVisualizeExecution(e.executionId);
          if (!id) return;
          await o.runs.record(
            {
              userId: id.userId,
              documentId: id.documentId,
              generation: id.generation,
              run: id.rerun,
            },
            end.state,
            end.code,
            ...(end.state === "done" && !legacy ? [factFormatFingerprint()] : []),
            // A run of the legacy 1.0.0 flow (in flight at deploy) derived no structure, so it is not stamped: the row keeps its
            // previous (older or NULL) stamp, stays stale, and the next boot re-plans it once with the structure derived.
            // A committed run (outcome done) is stamped with the format it planned over. Only this live feed stamps: a run
            // repaired at boot (`reconcile`) is not, since that process cannot know which code wrote it. The row keeps the
            // PREVIOUS stamp (COALESCE in the SQL), so a stale re-run whose end event was lost is still stale and is
            // re-planned once more at the next boot (one bounded extra planner call). A NULL stamp counts as stale (migration 0032), so a
            // document never stamped is re-planned at each boot until a live end event stamps it.
          );
          if (end.state === "failed" && end.notify)
            o.bus.publish(
              { userId: id.userId },
              { documentId: id.documentId, status: "ready", step: "finalize", visuals: "failed" },
            );
        })
        .catch(report);
    },
```

`apps/server/app/flows/visualize-turn/ids.ts` becomes (the builders keep the old format until phase 2 and say so; the parsers read both):

```ts
import { RecordOrd } from "@docmind/contracts";
import { UUID_PATTERN, type UserExecutionId, legacyIds, opaqueIds } from "../../opaqueIds";

/** What a visualize-turn run is about: ids only. `ord` is the assistant record's ordinal (`ChatMessageDto.id`). */
export interface TurnRef {
  tenantId: string;
  userId: string;
  chatId: string;
  ord: RecordOrd;
}

export const TURN_FLOW_ID = "visualize-turn";
const CANONICAL_UUID = new RegExp(`^${UUID_PATTERN}$`);
const MAX_RERUN = 999;

const checkOrd = (ord: number) => {
  if (!RecordOrd.safeParse(ord).success)
    throw new RangeError("ord must be an integer from 1 to 999999999999999");
};
const checkUuid = (what: string, id: string) => {
  if (!CANONICAL_UUID.test(id)) throw new RangeError(`${what} must be a canonical lower-case uuid`);
};

/**
 * The execution of a turn's one automatic pass (Loom starts a caller-chosen id once, so it is also the idempotency key); `rerun` makes
 * `-r<n>`, an on-demand run. PHASE 2 switches this to `UserIds.turnVisualize` (`h_<H>:visualize-turn-<C>-<ord>[-rN]`); until then it is the
 * old format. Ids only.
 */
export function turnExecutionId(
  userId: string,
  chatId: string,
  ord: number,
  rerun?: number,
): UserExecutionId {
  checkOrd(ord);
  if (rerun !== undefined && (!Number.isSafeInteger(rerun) || rerun < 1 || rerun > MAX_RERUN))
    throw new RangeError("rerun must be an integer from 1 to 999");
  return legacyIds.turnVisualize(userId, chatId.toLowerCase(), ord, rerun);
}

/**
 * The lineage line of a turn's visuals. PHASE 2 switches this to `UserIds.turnLineage` (`turnvisuals-<H>-<C>-<ord>`); until then it is the old
 * format. Ids only: stored in plaintext, and it survives erasure (the subject mapping parses it back to the owner).
 */
export const turnExperienceId = (r: { userId: string; chatId: string; ord: number }): string => {
  checkUuid("userId", r.userId);
  checkUuid("chatId", r.chatId);
  checkOrd(r.ord);
  return legacyIds.turnLineage(r.userId, r.chatId, r.ord);
};

/** What a turn-visualize execution id names, in either format; null for any other id (or a new-format id whose user is not cached). */
export function parseTurnExecution(
  id: string,
): { userId: string; chatId: string; ord: number; rerun?: number } | null {
  const p = opaqueIds.parse(id);
  if (p?.family !== "turnVisualize") return null;
  return {
    userId: p.userId,
    chatId: p.chatId as string,
    ord: p.ord as number,
    ...(p.rerun !== undefined && { rerun: p.rerun }),
  };
}
/** A turn-visualize execution of either format, from its shape alone (no key). */
export const isTurnVisualizeExecution = (id: string): boolean =>
  opaqueIds.family(id) === "turnVisualize";
```

`apps/server/app/flows/visualize-turn/trigger.ts`: add `import { opaqueIds } from "../../opaqueIds";` and, before `const ids = chatIdOfConversation(e.conversationId);`:

```ts
  // A new-format conversation id hides its user and chat: fill the key cache for it first (this is an async entry point).
  const handle = opaqueIds.handleOf(e.conversationId);
  if (handle !== null) await opaqueIds.ensure(handle);
```

`apps/server/app/flows/suggest-tags/start.ts`: replace the regex constant and `isSuggestTagsExecution` with `export const isSuggestTagsExecution = (id: string): boolean => opaqueIds.family(id) === "suggestTags";` (add `import { opaqueIds } from "../../opaqueIds";` and drop the `UUID_PATTERN` import).

- [ ] **Step 7: The snapshot pruner walks both ranges**

In `apps/server/app/snapshots/pruner.ts`: add `import { USER_ID_PREFIXES } from "../opaqueIds";`, delete the `USER_PREFIX` constant, and replace the `try { ... }` block of `sweepChatSnapshots` (from `try {` through `return report;` before the `finally`) with:

```ts
  try {
    // The two id formats are two runs of the log (`u_<uuid>` before the deploy, `h_<handle>` after); the log pages ids in code-point order.
    for (const prefix of USER_ID_PREFIXES) {
      let cursor: string = prefix; // strictly-after: every id of the run sorts after the bare prefix
      scan: for (;;) {
        const page = await deps.listExecutionsPage({ cursor, limit: pageSize });
        for (const executionId of page.executionIds) {
          if (!executionId.startsWith(prefix)) break scan; // past this prefix's range
          if (!isChatExecution(executionId)) continue;
          if (signal?.aborted || release.lost?.aborted) {
            report.stopped = true;
            return report;
          }
          report.executions += 1;
          try {
            report.deleted += await deps.prune(executionId);
          } catch (err) {
            report.failed += 1;
            const cls = className(err);
            report.failedByClass[cls] = (report.failedByClass[cls] ?? 0) + 1;
          }
        }
        if (page.nextCursor === undefined) break;
        cursor = page.nextCursor;
      }
    }
    return report;
  } finally {
```

and change the doc comment's first sentence to "One sweep: under the lock, page the `u_` executions and then the `h_` executions and prune each chat conversation (of either format), one at a time."

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd apps/server && pnpm exec vitest run app/status app/chats app/flows/visualize-document/runs.test app/flows/visualize-turn app/snapshots app/bootIngest app/subject app/executionIds`
Expected: PASS (the existing suites included: the old-format cases are the regression control; `chats/startRatchet.test.ts` still finds `chatConversationId` as a function declaration).

- [ ] **Step 9: Typecheck, lint, commit**

Run: `pnpm exec biome check --write apps/server/app && pnpm typecheck && pnpm typecheck:tests && pnpm lint`
Expected: no errors.

```bash
git add apps/server/app
git commit -m "feat(ids): dual-format parsers everywhere, the ensure gate, and a pruner that walks both id ranges"
```

---

### Task 5: The document-flow builders: ingest, visualize-document, suggest-tags and the document lineage (O3, O4, O7, F5, F6)

**Files:**
- Create: `apps/server/app/documents/executionCandidates.ts`, `apps/server/app/flows/visualize-document/testSupport.ts`, `apps/server/app/flows/suggest-tags/flowHash.test.ts`, `apps/server/app/flows/chat-title/flowHash.test.ts`
- Modify: `apps/server/app/documents/ingest.ts` (remove `ingestExecutionId`; `loomIngest` takes `ids`), `apps/server/app/flows/visualize-document/start.ts` (remove `visualizeExecutionId`; the starter takes `ids` and `executions`; `hasVisualsHead` takes `ids`), `apps/server/app/flows/visualize-document/lineage.ts` (remove `experienceIdOf`; `commitPlan` takes `ids`), `commit.ts`, `deps.ts`, `apps/server/app/flows/suggest-tags/start.ts` (remove `suggestTagsExecutionId`; the starter takes `ids`), `apps/server/app/ui/routes.ts` (`headOf`), `apps/server/app/compose.ts`, and the tests listed in step 5
- Test: `apps/server/app/documents/executionCandidates.test.ts`, `documents/ingest.test.ts`, `flows/suggest-tags/start.test.ts`, `flows/visualize-document/start.test.ts`, the two flow hash tests, `flows/ingest-document/flowHash.test.ts` and `flows/visualize-document/flowHash.test.ts` (already pinned; rerun)

**Interfaces:**
- Consumes: Tasks 1 and 2 (`UserIds`, `OpaqueIds.ensureUser/load/cached`, `ExecutionRecorder`, `PgExecutionRecorder`), `legacyIds`.
- Produces:
  - `documents/executionCandidates.ts`: `type UserIdSource = Pick<OpaqueIds, "ensureUser" | "load" | "cached">`; `existingUser(ids: Pick<OpaqueIds, "load" | "cached">, who: { tenantId: string; userId: string }): Promise<UserIds | undefined>` (never mints); `ingestCandidates(userId, documentId, generation, user?)`, `visualizeCandidates(userId, documentId, generation, rerun, user?)`, `suggestTagsCandidates(userId, documentId, run, user?)` (each the old id first, then the new id when the user has a handle), `documentLineageCandidates(userId, documentId, user?)` (the new line first, then the old).
  - `loomIngest(runtime: Pick<WorkflowRuntime, "start" | "cancel">, o: { ids: UserIdSource; executions?: ExecutionRecorder }): IngestPort`.
  - `VisualsStarterOptions.ids: UserIdSource` (required) and `.executions?: ExecutionRecorder`; `hasVisualsHead(lineage: Pick<Lineage, "head">, ids: Pick<UserIdSource, "load" | "cached">)`; `commitPlan(lineage, ids: Pick<UserIdSource, "ensureUser">, ref, plan, now)`; `VisualizeDeps.ids`; `loomSuggestTagsStarter(runtime, o: { ids: UserIdSource; enabled?: () => boolean })`; `UiRouteDeps.ids: Pick<UserIdSource, "load" | "cached">`; `ComposeOptions.ids?: OpaqueIds` (a test seam) and the `ids` member of what `buildServer` returns.
  - `flows/visualize-document/testSupport.ts`: `lineageTestIds` (a shared `testIdSource()`) and `async experienceIdOf(ref)` (the new-format line a test commits to and reads back).

Behaviour: a start awaits `ensureUser` (a key-store outage throws before Loom sees anything), builds the new-format id, records it on the document (ingest and visualize run 0, before the start), then starts. A cancel or a state read tries the candidates of both formats and never mints a key. The commit writes the new line, a read tries the new line first and falls back to the old. Flow hashes do not move (F5): the tests below pin them.

- [ ] **Step 1: Write the failing tests**

`apps/server/app/documents/executionCandidates.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { legacyIds } from "../opaqueIds";
import { testOpaqueIds } from "../opaqueIds/testing";
import {
  documentLineageCandidates,
  existingUser,
  ingestCandidates,
  suggestTagsCandidates,
  visualizeCandidates,
} from "./executionCandidates";

const T = "00000000-0000-0000-0000-0000000000aa";
const U = "11111111-1111-4111-8111-111111111111";
const D = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("candidates", () => {
  it("are the old id alone for a user with no handle, and the old then the new id for one with a handle", async () => {
    const t = testOpaqueIds();
    t.store.add(U, T);
    expect(await existingUser(t.ids, { tenantId: T, userId: U })).toBeUndefined();
    expect(await t.keys.get(U)).toBeNull(); // looking did not mint a key
    expect(ingestCandidates(U, D, 2)).toEqual([legacyIds.ingest(U, D, 2)]);

    const user = await t.ids.ensureUser({ tenantId: T, userId: U });
    const found = await existingUser(t.ids, { tenantId: T, userId: U });
    expect(found?.handle).toBe(user.handle);
    expect(ingestCandidates(U, D, 2, found)).toEqual([
      legacyIds.ingest(U, D, 2),
      user.ingest(D, 2),
    ]);
    expect(visualizeCandidates(U, D, 3, undefined, found)).toEqual([
      legacyIds.visualize(U, D, 3),
      user.visualize(D, 3),
    ]);
    expect(visualizeCandidates(U, D, 3, 2, found)).toEqual([
      legacyIds.visualize(U, D, 3, 2),
      user.visualize(D, 3, 2),
    ]);
    expect(suggestTagsCandidates(U, D, 4, found)).toEqual([
      legacyIds.suggestTags(U, D, 4),
      user.suggestTags(D, 4),
    ]);
    expect(documentLineageCandidates(U, D, found)).toEqual([
      user.documentLineage(D),
      legacyIds.documentLineage(U, D),
    ]);
    expect(documentLineageCandidates(U, D)).toEqual([legacyIds.documentLineage(U, D)]);
  });

  it("a destroyed key is no user: nothing new-format can still be running", async () => {
    const t = testOpaqueIds();
    t.store.add(U, T);
    await t.ids.ensureUser({ tenantId: T, userId: U });
    await t.keys.destroy(U);
    t.ids.forget(U);
    expect(await existingUser(t.ids, { tenantId: T, userId: U })).toBeUndefined();
  });
});
```

`apps/server/app/flows/suggest-tags/flowHash.test.ts`:

```ts
import { flowContentHash } from "@loom/core";
import { describe, expect, it } from "vitest";
import { suggestTagsFlow } from "./flow";

describe("the suggest-tags flow identity", () => {
  /**
   * Loom's flow hash covers the flow id and version, the ordered steps (id, tool id, timeout, retry) and the deadline, and nothing
   * else: no execution id, no input, no handler (packages/core/src/flowHash.ts at Loom 4af27eaa; DocMind sets no codeFingerprint).
   * The opaque execution ids (R14) therefore change no hash and no version. This literal is the hash on main before the change,
   * computed with `flowContentHash`.
   */
  it("is unchanged by the opaque execution ids", () => {
    expect(suggestTagsFlow.definition.version).toBe("1.0.0");
    expect(flowContentHash(suggestTagsFlow.definition)).toBe(
      "sha256:3d99db0fdaf88f4bbeb69d371610811f5fcf57d208ff31494e2235d81490189b",
    );
  });
});
```

`apps/server/app/flows/chat-title/flowHash.test.ts`:

```ts
import { flowContentHash } from "@loom/core";
import { describe, expect, it } from "vitest";
import { chatTitleFlow } from "./flow";

describe("the chat-title flow identity", () => {
  /**
   * Loom's flow hash reads no execution id (packages/core/src/flowHash.ts at Loom 4af27eaa), so the opaque execution ids (R14) change
   * no hash and no version. This literal is the hash on main before the change, computed with `flowContentHash`.
   */
  it("is unchanged by the opaque execution ids", () => {
    expect(chatTitleFlow.definition.version).toBe("1.0.0");
    expect(flowContentHash(chatTitleFlow.definition)).toBe(
      "sha256:f56568832761a1d68e89a5daf6b8edcf299eeadce26c916438f5f83a2cfa2007",
    );
  });
});
```

Append to `apps/server/app/documents/ingest.test.ts` (add `import { FieldKeyStoreError } from "../crypto/fields";`):

```ts
describe("loomIngest across the two id formats", () => {
  it("records the id on the document BEFORE the start, so a crash in between leaves an id the sweep re-starts", async () => {
    const order: string[] = [];
    const runtime = {
      start: async (_f: unknown, _i: unknown, o: { executionId: string }) => {
        order.push(`start:${o.executionId}`);
        return {} as never;
      },
      cancel: async () => {},
    } as unknown as Pick<WorkflowRuntime, "start" | "cancel">;
    const ids = testIdSource();
    const executions = {
      recordIngest: async (_w: unknown, d: string, g: number, id: string) => {
        order.push(`record:${d}:${g}:${id}`);
      },
      recordVisualize: async () => {},
    };
    await loomIngest(runtime, { ids, executions }).start(IDENTITY, DOC, 3);
    const id = (await ids.ensureUser(IDENTITY)).ingest(DOC, 3);
    expect(order).toEqual([`record:${DOC}:3:${id}`, `start:${id}`]);
  });

  it("a key-store outage fails the start before Loom sees it, and never falls back to an id with the plain UUIDs", async () => {
    const { runtime, calls } = fakeRuntime();
    const ids = {
      ensureUser: async () => {
        throw new FieldKeyStoreError();
      },
      load: async () => false,
      cached: () => undefined,
    };
    await expect(loomIngest(runtime, { ids }).start(IDENTITY, DOC, 2)).rejects.toBeInstanceOf(
      FieldKeyStoreError,
    );
    expect(calls.starts).toEqual([]);
  });

  it("cancel tries the old and the new id of each generation when the user has a handle, old first", async () => {
    const ids = testIdSource();
    const user = await ids.ensureUser(IDENTITY);
    const { runtime, calls } = fakeRuntime({
      unknown: [legacyIngestId(IDENTITY.userId, DOC, 3), user.ingest(DOC, 4)],
    });
    await loomIngest(runtime, { ids }).cancel(IDENTITY, DOC, 4);
    expect(calls.cancels).toEqual([
      legacyIngestId(IDENTITY.userId, DOC, 3),
      user.ingest(DOC, 3),
      legacyIngestId(IDENTITY.userId, DOC, 4),
      user.ingest(DOC, 4),
    ]);
  });

  it("cancel never creates a key or a handle for a user who has none", async () => {
    const ids = testIdSource();
    const { runtime, calls } = fakeRuntime();
    await loomIngest(runtime, { ids }).cancel(IDENTITY, DOC, 2);
    expect(calls.cancels).toEqual([1, 2].map((g) => legacyIngestId(IDENTITY.userId, DOC, g)));
    expect(ids.cached(IDENTITY.userId)).toBeUndefined();
  });
});
```

In `apps/server/app/flows/suggest-tags/start.test.ts`: replace the `describe("suggestTagsExecutionId", ...)` block with:

```ts
describe("suggest-tags execution ids", () => {
  it("a start names the run h_<handle>:suggest-tags-<token>-r<n>, with no plain user or document id", async () => {
    const started: string[] = [];
    const start = vi.fn(async (_f: unknown, _i: unknown, o: { executionId: string }) => {
      started.push(o.executionId);
      return never;
    });
    const ids = testIdSource();
    const r = ref();
    await loomSuggestTagsStarter({ start } as never, { ids }).start(r);
    const user = await ids.ensureUser(r);
    expect(started).toEqual([user.suggestTags(r.documentId, 1)]);
    expect(started[0]).toMatch(/^h_[a-z2-7]{26}:suggest-tags-[a-z2-7]{52}-r1$/);
    expect(started[0]).not.toContain(r.userId);
    expect(started[0]).not.toContain(r.documentId);
  });
});
```

and replace the three cancel tests (`cancel stops every run number this process took...` and `cancel finds the runs of an earlier process...`, plus this new third one) with:

```ts
  it("cancel tries both id formats of every run number this process took, and ignores one Loom does not hold", async () => {
    const r = ref();
    const ids = testIdSource();
    const user = await ids.ensureUser(r);
    const held = new Set<string>([user.suggestTags(r.documentId, 2)]);
    const cancel = vi.fn(async (id: string, _reason: string) => {
      if (!held.has(id)) throw new Error(`No execution found for id: ${id}`);
      return true;
    });
    const finished = { waitForCompletion: () => Promise.resolve() } as unknown as ExecutionHandle;
    const starter = loomSuggestTagsStarter(
      { start: vi.fn(async () => finished), cancel } as never,
      { ids },
    );
    expect(await starter.start(r)).toEqual({ kind: "started", run: 1 });
    await vi.waitFor(async () =>
      expect(await starter.start(r)).toEqual({ kind: "started", run: 2 }),
    );
    await starter.cancel(r, r.documentId, "erased");
    const both = (n: number) => [
      legacySuggestTagsId(r.userId, r.documentId, n),
      user.suggestTags(r.documentId, n),
    ];
    // Runs 1 and 2 are this process's; run 3 is the first past its counter for which neither format exists: it ends the walk.
    expect(cancel.mock.calls.map((c) => c[0])).toEqual([...both(1), ...both(2), ...both(3)]);
    expect(new Set(cancel.mock.calls.map((c) => c[1]))).toEqual(new Set(["erased"]));
  });

  it("cancel finds the runs of an earlier process from Loom, not from this process's counter", async () => {
    const r = ref();
    const ids = testIdSource();
    const user = await ids.ensureUser(r);
    const held = new Set<string>([1, 2, 3].map((n) => user.suggestTags(r.documentId, n)));
    const cancel = vi.fn(async (id: string) => {
      if (!held.has(id)) throw new Error(`No execution found for id: ${id}`);
      return true;
    });
    const starter = loomSuggestTagsStarter({ start: vi.fn(), cancel } as never, { ids }); // a fresh process: counter at 0
    await starter.cancel(r, r.documentId, "erased");
    expect(cancel.mock.calls.map((c) => c[0])).toEqual(
      [1, 2, 3, 4].flatMap((n) => [
        legacySuggestTagsId(r.userId, r.documentId, n),
        user.suggestTags(r.documentId, n),
      ]),
    );
  });

  it("a user with no handle is cancelled under the old format only, and cancel mints nothing", async () => {
    const r = ref();
    const ids = testIdSource();
    const cancel = vi.fn(async (id: string) => {
      throw new Error(`No execution found for id: ${id}`);
    });
    await loomSuggestTagsStarter({ start: vi.fn(), cancel } as never, { ids }).cancel(
      r,
      r.documentId.toUpperCase(), // a caller's spelling: ids are lower-case
      "erased",
    );
    expect(cancel.mock.calls.map((c) => c[0])).toEqual([
      legacySuggestTagsId(r.userId, r.documentId, 1),
    ]);
    expect(ids.cached(r.userId)).toBeUndefined();
  });
```

In `apps/server/app/flows/visualize-document/start.test.ts`: replace the two builder `describe("visualizeExecutionId", ...)` and `describe("visualizeExecutionId re-runs", ...)` blocks with:

```ts
describe("the visualize execution ids a start builds", () => {
  it("are h_<handle>:visualize-<token>[.<gen>][-r<n>], with no plain user or document id and the generation in the clear", () => {
    const r = ref();
    const user = deterministicUser(r.userId);
    expect(user.visualize(r.documentId, 1)).toMatch(/^h_[a-z2-7]{26}:visualize-[a-z2-7]{52}$/);
    expect(user.visualize(r.documentId, 3)).toMatch(/^h_[a-z2-7]{26}:visualize-[a-z2-7]{52}\.3$/);
    expect(user.visualize(r.documentId, 3, 999)).toMatch(/\.3-r999$/);
    for (const id of [user.visualize(r.documentId, 3), user.visualize(r.documentId, 1, 2)]) {
      expect(id).not.toContain(r.userId);
      expect(id).not.toContain(r.documentId);
    }
  });

  it("refuse a generation outside 1..999999999 and a re-run outside 1..999", () => {
    const r = ref();
    const user = deterministicUser(r.userId);
    for (const g of [0, -1, 1.5, 1_000_000_000])
      expect(() => user.visualize(r.documentId, g)).toThrow(RangeError);
    for (const n of [0, -1, 1.5, 1000])
      expect(() => user.visualize(r.documentId, 1, n)).toThrow(RangeError);
  });
});
```

and append:

```ts
describe("the visualize starter across the two id formats", () => {
  const flow = visualizeDocumentFlow();
  const fake = () => {
    const events: string[] = [];
    const runtime = {
      start: vi.fn(async (_f: unknown, _i: unknown, o: { executionId: string }) => {
        events.push(`start:${o.executionId}`);
        return {
          executionId: o.executionId,
          waitForCompletion: () => new Promise<void>(() => {}),
        } as never;
      }),
      cancel: vi.fn(async (id: string) => {
        events.push(`cancel:${id}`);
        throw new Error(`No execution found for id: ${id}`);
      }),
    };
    return { runtime: runtime as unknown as Pick<WorkflowRuntime, "start" | "cancel">, events };
  };

  it("records the automatic run's id on the document BEFORE it starts, and never a re-run's", async () => {
    const { runtime, events } = fake();
    const executions = {
      recordIngest: async () => {},
      recordVisualize: async (_w: unknown, d: string, g: number, id: string) => {
        events.push(`record:${d}:${g}:${id}`);
      },
    };
    const starter = loomVisualsStarter(runtime, flow, { ids: testIdSource(), executions });
    const r = ref();
    const id = deterministicUser(r.userId).visualize(r.documentId, 2);
    await starter.start(r, 2);
    expect(events).toEqual([`record:${r.documentId}:2:${id}`, `start:${id}`]);
    events.length = 0;
    await starter.rerun(ref(), 2); // another document, so the first run's in-flight guard does not answer
    expect(events.map((e) => e.split(":")[0])).toEqual(["start"]); // a re-run is never swept: nothing recorded
  });

  it("a key-store outage fails the start before Loom sees it", async () => {
    const { runtime, events } = fake();
    const ids = {
      ensureUser: async () => {
        throw new FieldKeyStoreError();
      },
      load: async () => false,
      cached: () => undefined,
    };
    await expect(loomVisualsStarter(runtime, flow, { ids }).start(ref(), 2)).rejects.toBeInstanceOf(
      FieldKeyStoreError,
    );
    expect(events).toEqual([]);
  });

  it("cancel tries the old and the new id of the run, its generation and the one before, old first, when the user has a handle", async () => {
    const { runtime, events } = fake();
    const ids = testIdSource();
    const starter = loomVisualsStarter(runtime, flow, { ids });
    const r = ref();
    await ids.ensureUser(r);
    const user = deterministicUser(r.userId);
    await starter.cancel(r, r.documentId.toUpperCase(), 3, "erased"); // a caller's spelling: ids are lower-case
    expect(events).toEqual(
      [2, 3].flatMap((g) => [
        `cancel:${legacyVisualizeId(r.userId, r.documentId, g)}`,
        `cancel:${user.visualize(r.documentId, g)}`,
      ]),
    );
  });

  it("cancel for a user with no handle tries the old format only and mints nothing", async () => {
    const { runtime, events } = fake();
    const ids = testIdSource();
    const r = ref();
    await loomVisualsStarter(runtime, flow, { ids }).cancel(r, r.documentId, 2, "erased");
    expect(events).toEqual(
      [1, 2].map((g) => `cancel:${legacyVisualizeId(r.userId, r.documentId, g)}`),
    );
    expect(ids.cached(r.userId)).toBeUndefined();
  });

  it("reconcile reads a new-format run's state, and an old-format run's, whichever the run started under", async () => {
    const r = ref();
    const ids = testIdSource();
    await ids.ensureUser(r);
    const states = new Map<string, unknown>([
      [
        deterministicUser(r.userId).visualize(r.documentId, 2),
        { status: "completed", variables: { _output: { outcome: "done" } } },
      ],
    ]);
    const loadState = vi.fn(async (id: string) => states.get(id) ?? null);
    const record = vi.fn(async () => {});
    const runtime = { start: vi.fn(), cancel: vi.fn(), loadState } as unknown as Pick<
      WorkflowRuntime,
      "start" | "cancel" | "loadState"
    >;
    const starter = loomVisualsStarter(runtime, flow, {
      ids,
      runs: { record, last: async () => null },
    });
    const repaired = await starter.reconcile(r, 2, { run: 0, state: "running", code: null });
    expect(repaired).toMatchObject({ run: 0, state: "done" });
    expect(loadState.mock.calls.map((c) => c[0])).toEqual([
      legacyVisualizeId(r.userId, r.documentId, 2),
      deterministicUser(r.userId).visualize(r.documentId, 2),
    ]);
  });
});

describe("hasVisualsHead across the two lineage lines", () => {
  it("finds a head on the new line or on the old line, and none when neither has one", async () => {
    const r = ref();
    const ids = testIdSource();
    await ids.ensureUser(r);
    const newLine = deterministicUser(r.userId).documentLineage(r.documentId);
    const oldLine = legacyIds.documentLineage(r.userId, r.documentId);
    const lineageWith = (heads: Record<string, string | null>) =>
      ({ head: async (id: string) => ({ ok: true, value: heads[id] ?? null }) }) as never;
    expect(await hasVisualsHead(lineageWith({ [newLine]: "h" }), ids)(r)).toBe(true);
    expect(await hasVisualsHead(lineageWith({ [oldLine]: "h" }), ids)(r)).toBe(true); // visualized before the deploy
    expect(await hasVisualsHead(lineageWith({}), ids)(r)).toBe(false);
  });

  it("a user with no handle is looked up on the old line only", async () => {
    const r = ref();
    const asked: string[] = [];
    const lineage = {
      head: async (id: string) => {
        asked.push(id);
        return { ok: true, value: null };
      },
    } as never;
    expect(await hasVisualsHead(lineage, testIdSource())(r)).toBe(false);
    expect(asked).toEqual([legacyIds.documentLineage(r.userId, r.documentId)]);
  });
});
```

(imports for these: `import { FieldKeyStoreError } from "../../crypto/fields";`, `import { legacyIds } from "../../opaqueIds";`, `import { deterministicUser, legacyIngestId, legacyVisualizeId, testIdSource } from "../../opaqueIds/testing";`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/server && pnpm exec vitest run app/documents/executionCandidates app/documents/ingest.test app/flows/suggest-tags app/flows/chat-title/flowHash app/flows/visualize-document/start.test`
Expected: FAIL (`executionCandidates` does not exist; `loomIngest`, `loomSuggestTagsStarter` and `loomVisualsStarter` take no `ids`).

- [ ] **Step 3: The candidates module**

`apps/server/app/documents/executionCandidates.ts`:

```ts
import { type OpaqueIds, type UserIds, legacyIds } from "../opaqueIds";

/** What a starter, a canceller or a reader needs of the id cache: build for a user (minting), and find an existing user's builders (never minting). */
export type UserIdSource = Pick<OpaqueIds, "ensureUser" | "load" | "cached">;

/**
 * The user's builders when the user has a handle and a live key; undefined otherwise (no new-format run exists, or the key is destroyed).
 * Readers and cancellers use this, never `ensureUser`: they must not create a key or a handle.
 */
export async function existingUser(
  ids: Pick<OpaqueIds, "load" | "cached">,
  who: { tenantId: string; userId: string },
): Promise<UserIds | undefined> {
  return (await ids.load(who)) ? ids.cached(who.userId) : undefined;
}

/**
 * The ids a run of the document may exist under: the old-format id (a run from before the deploy) and, when the user has a handle, the
 * new-format id. Reads and cancels try each; a start builds the new-format one only.
 */
export const ingestCandidates = (
  userId: string,
  documentId: string,
  generation: number,
  user?: UserIds,
): string[] => [
  legacyIds.ingest(userId, documentId, generation),
  ...(user ? [user.ingest(documentId, generation)] : []),
];

export const visualizeCandidates = (
  userId: string,
  documentId: string,
  generation: number,
  rerun: number | undefined,
  user?: UserIds,
): string[] => [
  legacyIds.visualize(userId, documentId, generation, rerun),
  ...(user ? [user.visualize(documentId, generation, rerun)] : []),
];

export const suggestTagsCandidates = (
  userId: string,
  documentId: string,
  run: number,
  user?: UserIds,
): string[] => [
  legacyIds.suggestTags(userId, documentId, run),
  ...(user ? [user.suggestTags(documentId, run)] : []),
];

/** The lineage lines a document's visuals may live on, newest format first: reads take the first with a head, commits write the first. */
export const documentLineageCandidates = (
  userId: string,
  documentId: string,
  user?: UserIds,
): string[] => [
  ...(user ? [user.documentLineage(documentId)] : []),
  legacyIds.documentLineage(userId, documentId),
];
```

- [ ] **Step 4: Move the builders**

`apps/server/app/documents/ingest.ts`: delete `ingestExecutionId` (and its doc comment), replace the import of `executionIdFor` with `import { type UserIdSource, existingUser, ingestCandidates } from "./executionCandidates";` and `import type { ExecutionRecorder } from "./executionIds";`, and replace everything from `const target = (identity: Identity` to the end of the file with (`INGEST_GENERATION`, `ingestStartInput`, `checkGeneration` and the `IngestPort` interface above it stay):

```ts
const target = (identity: Identity, documentId: string, generation: number) => {
  const ref = ingestStartInput(identity, documentId);
  return {
    ref,
    generation: checkGeneration(generation),
    principal: { tenant: ref.tenantId, actor: ref.userId },
  };
};

// A fixed reason: the cancel reason is recorded in the log, so it never names the document.
const CANCEL_REASON = "document-deleted";

export interface LoomIngestOptions {
  /** The id cache: a start builds the new-format id with the user's key; a cancel also tries the old format. */
  ids: UserIdSource;
  /** Records the id of the generation's execution on the document before it starts (migration 0038); absent in tests that need no sweep. */
  executions?: ExecutionRecorder;
}

export function loomIngest(
  runtime: Pick<WorkflowRuntime, "start" | "cancel">,
  o: LoomIngestOptions,
): IngestPort {
  return {
    async start(identity, documentId, generation) {
      const { ref, principal, generation: g } = target(identity, documentId, generation);
      // A key-store outage throws here, before Loom sees anything: a start never falls back to an id with the plain UUIDs.
      const user = await o.ids.ensureUser({ tenantId: ref.tenantId, userId: ref.userId });
      const executionId = user.ingest(ref.documentId, g);
      // Recorded BEFORE the start: a crash in between leaves an id with no status row, which the stale-upload sweep lists and starts again.
      await o.executions?.recordIngest(
        { tenantId: ref.tenantId, userId: ref.userId },
        ref.documentId,
        g,
        executionId,
      );
      try {
        return await runtime.start(ingestDocumentFlow, ref, { executionId, principal });
      } catch (err) {
        if (err instanceof ExecutionAlreadyExistsError) return null;
        throw err;
      }
    },
    async cancel(identity, documentId, generation) {
      const { ref, principal, generation: top } = target(identity, documentId, generation);
      // Old-format runs (from before the deploy) and new-format runs may both exist: cancel every candidate that does.
      const user = await existingUser(o.ids, identity);
      for (let g = Math.max(1, top - 1); g <= top; g++) {
        for (const executionId of ingestCandidates(ref.userId, ref.documentId, g, user)) {
          try {
            await runtime.cancel(executionId, CANCEL_REASON, { principal });
          } catch (err) {
            // Loom throws a plain Error (no class or code) for an execution that never existed in
            // this generation; match its exact message for this id and nothing else.
            if (
              !(err instanceof Error && err.message === `No execution found for id: ${executionId}`)
            ) {
              throw err;
            }
          }
        }
      }
    },
  };
}
```

`apps/server/app/flows/visualize-document/start.ts`:

1. Imports: remove `import { type UserExecutionId, executionIdFor } from "../../subject";` and `experienceIdOf` from the `./lineage` import; add

```ts
import {
  type UserIdSource,
  documentLineageCandidates,
  existingUser,
  visualizeCandidates,
} from "../../documents/executionCandidates";
import type { ExecutionRecorder } from "../../documents/executionIds";
```

2. Delete `const MAX_GENERATION = 999_999_999;` and the whole `visualizeExecutionId` function with its doc comment (the new builder validates the generation and the run number itself).
3. Replace `hasVisualsHead` (its doc comment included) with:

```ts
/**
 * True when the document's visuals line has a head (it was visualized with visuals), on its new-format line or, for a document visualized before the
 * deploy, its old one. A confirmed-erased line is "no head". Any other refusal or an unreadable line throws (the caller logs the class and skips the document).
 */
export const hasVisualsHead =
  (lineage: Pick<Lineage, "head">, ids: Pick<UserIdSource, "load" | "cached">) =>
  async (ref: VisualizeRef): Promise<boolean> => {
    const user = await existingUser(ids, ref);
    for (const experienceId of documentLineageCandidates(ref.userId, ref.documentId, user)) {
      try {
        const head = await lineage.head(experienceId);
        if (head.ok) {
          if (head.value !== null) return true;
          continue;
        }
        const { refusal } = head;
        const code = refusal.kind === "refused" ? refusal.finding.code : refusal.kind;
        if (code === "line-erased") continue;
        throw new LineageRefusedError(code);
      } catch (err) {
        if (err instanceof LineErasedError) continue;
        throw err;
      }
    }
    return false;
  };
```

4. In `VisualsStarterOptions` add before `runs?`:

```ts
  /** The id cache: a start builds the new-format id with the user's key; a read or a cancel also tries the old format. Required: there is no id without it. */
  ids: UserIdSource;
  /** Records the automatic run's id on the document before it starts (migration 0038), so the boot sweeps can compare it with the status rows. */
  executions?: ExecutionRecorder;
```

make the `options` parameter of `loomVisualsStarter` required (`options: VisualsStarterOptions,`, no `= {}`), and add `ids,` and `executions,` to its destructuring.
5. In `startOne`, replace the line `const executionId = visualizeExecutionId(...)` with:

```ts
    // A key-store outage throws here, before Loom sees anything: a start never falls back to an id with the plain UUIDs.
    const user = await ids.ensureUser({ tenantId: input.tenantId, userId: input.userId });
    const executionId = user.visualize(input.documentId, generation, rerun);
    // The automatic run's id goes on the document BEFORE the start (the boot sweeps compare it with the status rows); a re-run is never swept.
    if (rerun === undefined)
      await executions?.recordVisualize(
        { tenantId: input.tenantId, userId: input.userId },
        input.documentId,
        generation,
        executionId,
      );
```

6. Add `stateOf` before `reconcile` and use it in `reconcile` and `recordUnvisualized` (the old inline `loadState(visualizeExecutionId(...))` calls become `await stateOf(ref, generation, last.run === 0 ? undefined : last.run)` and `await stateOf(d, d.generation, undefined)`):

```ts
  /** The state of a run under whichever id format it started with (the old-format id first), or null when neither exists. */
  const stateOf = async (ref: VisualizeRef, generation: number, rerun: number | undefined) => {
    const user = await existingUser(ids, ref);
    for (const executionId of visualizeCandidates(
      ref.userId,
      ref.documentId,
      generation,
      rerun,
      user,
    )) {
      const state = await runtime.loadState?.(executionId, {
        principal: { tenant: ref.tenantId, actor: ref.userId },
      });
      if (state) return state;
    }
    return null;
  };
```

7. In `rerunWith`, after the `enabled` check add `const user = await ids.ensureUser(ref);` and replace the two `visualizeExecutionId(ref.userId, ref.documentId, generation, n)` calls (the `afterDone.add` and the `reextract.add`) with `user.visualize(ref.documentId, generation, n)`: they must equal the id `startOne` builds.
8. Replace `cancel` (the last member of the returned object) with:

```ts
    async cancel(identity, documentId, generation, reason) {
      const principal = { tenant: identity.tenantId, actor: identity.userId };
      // Loom throws a plain Error (no class) for an execution that never existed; match its exact message for this id only.
      const cancelOne = async (executionId: string): Promise<boolean> => {
        try {
          await runtime.cancel(executionId, reason, { principal });
          return true;
        } catch (err) {
          if (
            !(err instanceof Error && err.message === `No execution found for id: ${executionId}`)
          )
            throw err;
          return false;
        }
      };
      // A run may be under the old id format (from before the deploy) or the new one: cancel every candidate that exists.
      const user = await existingUser(ids, identity);
      const doc = documentId.toLowerCase(); // ids are lower-case; a caller's spelling may not be
      const candidates = (g: number, rerun?: number) =>
        visualizeCandidates(identity.userId, doc, g, rerun, user);
      for (let g = Math.max(1, generation - 1); g <= generation; g++) {
        for (const executionId of candidates(g)) await cancelOne(executionId);
        // The re-runs: numbers are taken in order, up to the highest one this process started or the table recorded.
        const top = Math.max(
          tracker.last(genKey(identity.userId, documentId, g)),
          (await runs?.last(identity, documentId, g))?.run ?? 0,
        );
        for (let n = 1; n <= Math.min(top, MAX_RERUNS); n++)
          for (const executionId of candidates(g, n)) await cancelOne(executionId);
      }
    },
  };
}
```

`apps/server/app/flows/visualize-document/lineage.ts`: delete `experienceIdOf` (the old `visuals-<userId>-<documentId>` builder), add `import type { UserIdSource } from "../../documents/executionCandidates";`, and replace `commitPlan` with:

```ts
/**
 * Commits the plan to the document's NEW-format line (`visuals-<H>-<D>`; the old line, if the document was visualized before the deploy, is left
 * as it is and superseded: a read tries the new line first). Needs the user's key to build the id, so it takes the id cache.
 */
export const commitPlan = async (
  lineage: Lineage,
  ids: Pick<UserIdSource, "ensureUser">,
  ref: VisualizeRef,
  plan: CommitPlan,
  now: () => string,
) => {
  const user = await ids.ensureUser(ref);
  return commitPlanTo(
    lineage,
    {
      experienceId: user.documentLineage(ref.documentId),
      intent: VISUALS_INTENT,
      sourceKind: "document-visuals",
    },
    plan,
    now,
  );
};
```

`apps/server/app/flows/visualize-document/commit.ts`: add `import type { UserIdSource } from "../../documents/executionCandidates";`, add `ids: Pick<UserIdSource, "ensureUser">;` to the `deps` type of `commitEffect` (beside `lineage`) and change the call to `commitPlan(deps.lineage, deps.ids, input, input, deps.now)`. `deps.ts`: add `ids: Pick<UserIdSource, "ensureUser">;` with a one-line comment to `VisualizeDeps` after `lineage: Lineage;` (the import is `import type { UserIdSource } from "../../documents/executionCandidates";`).

`apps/server/app/flows/suggest-tags/start.ts`: delete `suggestTagsExecutionId` and the `executionIdFor` import, add `import { type UserIdSource, existingUser, suggestTagsCandidates } from "../../documents/executionCandidates";`, change the starter's second parameter to `o: { ids: UserIdSource; enabled?: () => boolean },`, and in `start` add `const user = await o.ids.ensureUser({ tenantId: input.tenantId, userId: input.userId });` before `tracker.probe` and build the id with `user.suggestTags(input.documentId, n)`. Replace `cancel` with:

```ts
    async cancel(identity, documentId, reason) {
      const principal = { tenant: identity.tenantId, actor: identity.userId };
      // Run numbers are taken in order, so the durable runs of a document are normally r1..rK: walk up from r1 until Loom
      // has no such execution (a restart forgets this process's counter, so it cannot be trusted alone). A start that failed
      // after taking a number can leave a gap and stop the walk early; recovery ownership then re-drives or ends that run.
      const seen = Math.min(tracker.last(keyOf(identity.userId, documentId)), MAX_RERUNS);
      // A run may be under either id format (from before the deploy, or after): cancel every candidate that exists. The walk stops at the
      // first number past this process's counter for which neither format exists.
      const user = await existingUser(o.ids, identity);
      const doc = documentId.toLowerCase(); // ids are lower-case; a caller's spelling may not be
      for (let n = 1; n <= MAX_RERUNS; n++) {
        let found = false;
        for (const executionId of suggestTagsCandidates(identity.userId, doc, n, user)) {
          try {
            await runtime.cancel(executionId, reason, { principal });
            found = true;
          } catch (err) {
            // Loom throws a plain Error (no class) for an execution that never existed; match its exact message for this id only.
            if (
              !(err instanceof Error && err.message === `No execution found for id: ${executionId}`)
            )
              throw err;
          }
        }
        if (!found && n > seen) break;
      }
    },
```

`apps/server/app/ui/routes.ts`: delete the `experienceIdOf` import, add `import { type UserIdSource, documentLineageCandidates, existingUser } from "../documents/executionCandidates";`, add `ids: Pick<UserIdSource, "load" | "cached">;` (with a one-line comment: the document's line is looked up under both formats, the new one first) to `UiRouteDeps`, and replace `headOf` with:

```ts
  /** The document's visuals head, or null when there is none (empty, erased or unreadable lines all serve the static detail). */
  const headOf = async (identity: Identity, documentId: string): Promise<Experience | null> => {
    try {
      // The new-format line first; a document visualized before the deploy still has its old-format line.
      const user = await existingUser(deps.ids, identity);
      for (const experienceId of documentLineageCandidates(identity.userId, documentId, user)) {
        const latest = await deps.lineage.resolveLatest(experienceId);
        if (latest.ok) return latest.value;
      }
      return null;
    } catch (err) {
      console.error(
        "visuals head unavailable",
        err instanceof Error ? err.constructor.name : typeof err,
      );
      return null;
    }
  };
```

`apps/server/app/compose.ts`: add the imports `import { PgExecutionRecorder } from "./documents/executionIds";`, `import { OpaqueIds, opaqueIds } from "./opaqueIds";` and `import { PgHandleStore } from "./opaqueIds/pgHandles";`; add `ids?: OpaqueIds;` (a test seam with a doc comment) to `ComposeOptions`; after `const fields = new FieldCrypto(keys);` add

```ts
  // The id module (R14): the per-user key cache and the handle store. Installed process-wide so the synchronous parsers (the status fold, the
  // stores' subject mapping) can read new-format ids; `bootIngest` warms it before anything runs. `executions` records each document's current ids.
  const ids = options.ids ?? new OpaqueIds(keys, new PgHandleStore(pool));
  opaqueIds.install(ids);
  const executions = new PgExecutionRecorder(pool);
```

and wire `ids` into: `visualize.deps` (`ids,` after `lineage: visualsLineageOf,`), `loomSuggestTagsStarter(app.runtime, { ids, enabled: ... })`, `loomVisualsStarter(app.runtime, visualize.flow, { ids, executions, ... visualized: hasVisualsHead(visualsLineageOf, ids), ... })`, `loomIngest(app.runtime, { ids, executions })` (both branches of the `wrapIngest` ternary), `erasureDeps({ ..., ids, ... })` (the erasure parts' `ids`, from Task 3), `uiRoutes({ ..., ids, ... })`, and add `ids,` (with a doc comment: `bootIngest` warms it before the status model boots) as the third member of the object `buildServer` returns, after `app` and `server`. The two pg-backed `sql` members already come from `pgErasureSql`, whose `handleOf` Task 3 added.

- [ ] **Step 5: Move every existing caller to the new builders**

Typecheck now lists every caller: `pnpm typecheck:tests` reports about 180 errors in about 45 files, all of the five kinds below. Fix them in this order; each rule is mechanical and the compiler lists what is left.

1. **Removed old builders.** `ingestExecutionId`, `visualizeExecutionId` and `suggestTagsExecutionId` are gone; `experienceIdOf` is gone from `lineage.ts`. A test that wants the OLD id (a status row or a run "from before the deploy") imports `legacyIngestId`, `legacyVisualizeId` or `legacySuggestTagsId` from `opaqueIds/testing` (same argument order as before; `legacyIngestId`'s generation still defaults to 2). Run this once from `apps/server/app` to rewrite the imports and calls (it is idempotent):

```bash
python3 - <<'PY'
import os, re, subprocess
names = {"ingestExecutionId": "legacyIngestId", "visualizeExecutionId": "legacyVisualizeId", "suggestTagsExecutionId": "legacySuggestTagsId"}
files = subprocess.check_output("grep -rlE 'ingestExecutionId|visualizeExecutionId|suggestTagsExecutionId' . --include='*.ts'", shell=True, text=True).split()
for f in files:
    s = open(f).read()
    used = set()
    def drop(m):
        keep = []
        for item in [x.strip() for x in m.group(1).split(",") if x.strip()]:
            if item.replace("type ", "") in names: used.add(item.replace("type ", ""))
            else: keep.append(item)
        return f'import {{ {", ".join(keep)} }} from "{m.group(2)}";\n' if keep else ""
    s = re.sub(r'import \{([^}]*)\} from "([^"]+)";\n?', drop, s)
    if not used: continue
    for old, new in names.items(): s = re.sub(r"\b" + old + r"\(", new + "(", s)
    rel = os.path.relpath("opaqueIds/testing", os.path.dirname(f))
    rel = rel if rel.startswith(".") else "./" + rel
    imp = f'import {{ {", ".join(sorted(names[u] for u in used))} }} from "{rel}";\n'
    last = [m.end() for m in re.finditer(r"^import [^;]*;\n", s, re.M)][-1]
    open(f, "w").write(s[:last] + imp + s[last:])
PY
```

   Where a test asserts the id a STARTER built (a `starts` list, a `started` set, a cancel list for a user who has a handle), the expected value is the new-format id, not the old one: use `deterministicUser(userId).visualize(documentId, generation, rerun)` (or `.ingest`, `.suggestTags`), which equals what a starter given `testIdSource()` builds, with no await. Keep `legacyVisualizeId` where the test seeds an old-format run on purpose (a reconcile or a cancel for a user with no handle).
2. **Starters need `ids`.** `loomIngest(runtime)` becomes `loomIngest(runtime, { ids: testIdSource() })`, `loomSuggestTagsStarter(runtime, opts)` becomes `loomSuggestTagsStarter(runtime, { ids: testIdSource(), ...opts })`, and `loomVisualsStarter(runtime, flow, opts)` becomes `loomVisualsStarter(runtime, flow, { ids: testIdSource(), ...opts })` (a call with no options gets the object). Import `testIdSource` from `opaqueIds/testing`. A test that also needs the user's ids afterwards (`cancel` for a user with a handle, a reconcile of a new-format run) creates `const ids = testIdSource()`, passes it, and calls `await ids.ensureUser(ref)` first.
3. **The lineage tests.** `experienceIdOf` now lives in `flows/visualize-document/testSupport.ts` as an async helper, and `commitPlan` takes the id cache as its second argument. In `flows/visualize-document/{lineage,commit,flow,recovery,rollout.pg,lineage.erasure.pg}.test.ts`, `ui/{routes,visuals.e2e}.test.ts`, `storage/{pgContentStore.pg,lineageGc.pg}.test.ts` and `documents/visuals.e2e.pg.test.ts`: import `experienceIdOf` and `lineageTestIds` from `testSupport`, write `await experienceIdOf(ref)`, and write `commitPlan(lineage, lineageTestIds, ref, plan, now)`. A sync arrow that called `experienceIdOf` becomes `async` and its callers `await` it (`lineage.erasure.pg.test.ts` has one: `streamOf`). Deps objects typed `VisualizeDeps` or passed to `commitEffect` and `uiRoutes` get `ids: lineageTestIds` beside their `lineage`.
4. **Tests with a stub pool.** `buildServer` now builds a `PgHandleStore` over `options.pool`. A test whose pool is a stub (`status/compose.test.ts`) passes the new seam `ids: new OpaqueIds(keys, new AutoHandleStore())` and the same `keys` it gives `buildServer` (`AutoHandleStore` and `OpaqueIds` come from `opaqueIds/testing` and `opaqueIds`).
5. **`hasVisualsHead`** takes the id cache as its second argument: `hasVisualsHead(lineage, testIdSource())`.

`flows/ingest-document/testing.ts`, `recoveryHarness.ts`, `ui/testSupport.ts` and `documents/testHarness.ts` are support files with the same errors: `loomIngest(runtime, { ids: testIdSource() })` in the harness, and the old-format helper for the rows they seed. The harness's `loomIngest` call is the one the pg and e2e suites use: it must pass the stack's own id cache (`composed.ids`, the member `buildServer` returns), not a fresh one, so a test that reads an execution's log by id builds the id from the same keys.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `set -a; . ./.env; set +a; cd apps/server && pnpm exec vitest run app/documents app/flows app/ui app/storage app/status app/erasure`
Expected: PASS, with the pg and e2e tests run (not skipped), after the next paragraph's edits.

A pg or e2e test that reads or seeds an execution the REAL code started (an upload's ingest, a visualize run, a suggest-tags run) used to build its old-format id; the real code now starts the new-format one, so such a test finds no events ("no events to check", a `waitFor` that times out at 30 s or 60 s on `EXECUTION_COMPLETED`). Give the stack the ids its own cache builds. In `apps/server/app/documents/ingestStack.ts` add to the `IngestStack` interface:

```ts
  /** The ids of the runs the real code starts for a user (the new format): what a test reads a run's log or state by. */
  runIds: {
    ingest(who: { tenantId: string; userId: string }, documentId: string, generation?: number): Promise<string>;
    visualize(who: { tenantId: string; userId: string }, documentId: string, generation?: number, rerun?: number): Promise<string>;
    suggestTags(who: { tenantId: string; userId: string }, documentId: string, run?: number): Promise<string>;
  };
```

and, in the object `startIngestStack` returns (beside `composed`):

```ts
      runIds: {
        ingest: async (who, documentId, generation = 2) =>
          (await composed.ids.ensureUser(who)).ingest(documentId, generation),
        visualize: async (who, documentId, generation = 2, rerun) =>
          (await composed.ids.ensureUser(who)).visualize(documentId, generation, rerun),
        suggestTags: async (who, documentId, run = 1) =>
          (await composed.ids.ensureUser(who)).suggestTags(documentId, run),
      },
```

(`2` is `INGEST_GENERATION`, a new document's first generation.) Then, in each failing test, replace the old-format helper that names a real run with `await st.runIds.<family>(identity, ...)`: the test keeps `legacyIngestId`, `legacyVisualizeId` and `legacySuggestTagsId` only where it seeds an old-format run on purpose (a status row, a reconcile). The files that fail this way on a first run are `documents/ingest.e2e.pg.test.ts`, `documents/visuals.e2e.pg.test.ts`, `documents/tags.e2e.pg.test.ts`, `flows/ingest-document/providers.pg.test.ts`, `flows/ingest-document/eventLog.pg.test.ts` (only where it reads a run an upload started), `chats/golden.e2e.pg.test.ts`, `chats/summary.e2e.pg.test.ts`, `erasure/erasure.after.e2e.pg.test.ts` and `erasure/suggestTags.restart.e2e.pg.test.ts`; a test that starts a run itself with `runtime.start(..., { executionId: legacyIngestId(...) })` (the flow-level tests) is unaffected, because it chose the id. The suites that seed status rows directly (`flows/visualize-document/{ready,rollout,runs}.pg.test.ts`, `documents/sweepSql.pg.test.ts`, `storage/lineageGc.pg.test.ts`) fail the other way: a sweep lists no document because its row has no stored id; each `INSERT INTO read_model_state` into those suites is followed by `await backfillExecutionIds(owner);` (Task 2 step 6), and a lineage test reads the line through `await experienceIdOf(ref)` (step 5, rule 3).

- [ ] **Step 7: Typecheck, lint, commit**

Run: `pnpm exec biome check --write apps/server/app && pnpm typecheck && pnpm typecheck:tests && pnpm lint`
Expected: no errors.

```bash
git add apps/server/app
git commit -m "feat(ids): the document flows build opaque ids; reads and cancels try both formats"
```

---

### Task 6: Connections SQL, sealed flow-input ids and the boot warm-up (O2, F4, F6, F11)

**Files:**
- Modify: `apps/server/app/ui/connections.ts:19-27,50,86` (`EXEC_KEY`, `RELATED_SQL`, `ENTITIES_SQL`), `apps/server/app/bootIngest.ts` (the warm-up before the status boot), `apps/server/app/sensitive.ts` (seal the id fields of flow inputs), `apps/server/app/flows/ingest-document/testing.ts` (the raw-log proof accepts them sealed)
- Test: `apps/server/app/ui/connections.pg.test.ts`, `apps/server/app/bootIngest.test.ts`, `apps/server/app/sensitive.test.ts`, `apps/server/app/flows/ingest-document/eventLog.pg.test.ts`

**Interfaces:**
- Consumes: Task 2 (`documents.ingest_execution_id`), Task 5 (`buildServer().ids`), Task 1 (`OpaqueIds.warm`).
- Produces: the connections reader no longer builds an id in SQL (the only remaining `'u_' ||` expression in the application's TypeScript is gone); `bootIngest` warms the key cache before the status model boots; `FLOW_INPUT_IDS` in `sensitive.ts`: the `tenantId`, `userId`, `documentId` and `chatId` of a flow's start input and of every step's input are sealed under the subject key.

Decision (hard question 6, F6): connections STORES. It compares the document's `ingest_execution_id` (recorded by the application when it starts the ingest; backfilled by migration 0038 for a run that began before the deploy), exactly as the five sweep functions now do, instead of computing the id in application code: a computation needs a second query per request and an over-fetch to keep `LIMIT $3` correct (the readiness filter decides which documents count), for no gain. The comparison stays a key lookup: the id is a plain column in the lateral subquery's output, which keeps the "leakproof comparison" property the existing comment relies on.

Decision (F11, a gap in the spec found while planning): new-format ids keep the user, the document and the chat out of the execution id, the lineage id, the timers and the leases, but every flow's start input (`EXECUTION_STARTED.payload.input`) and every step's input (`STEP_STARTED.payload.input`) is `{ tenantId, userId, documentId }` or `{ tenantId, userId, chatId }` in PLAINTEXT today (`sensitive.ts`: "a flow's start input carries ids only", pinned by a test and allow-listed by the erasure scan as by-design residue). A scan of `loom.events` after an erasure would still find the user and document UUIDs of every new run, so spec section 6 and the section 8 scan (`none of the user's, documents', chats' UUIDs from new runs`) cannot hold with the ids alone. Sealing those four input fields under the subject key (`h_<H>` for a new run) closes it: they are destroyed with the key, they open transparently while it lives (the status fold's ready hook, recovery and the guards read them through the decrypting store), and the read-model sensitive-state guard is unaffected (a folded state holds enums and counts, never an id). Verified in a scratch copy: with the sealing, the erasure e2e passes once the harness knows the two formats (Task 8), and the ingest raw-log proof passes with the two edits below.

- [ ] **Step 1: Write the failing tests**

In `apps/server/app/ui/connections.pg.test.ts`: change the harness import to `import { T1, T2, U1, U1B, U2, seedRow } from "../documents/testHarness";` and the support import to `import { READY_STATE, connectionsSeeder } from "./testSupport";`, add this test before `it("returns at most 8 related documents, the strongest"`:

```ts
  it("counts a document ready under either id format (the stored id decides), and not one whose stored id is missing", async () => {
    await seed("a", { chunks: 4 });
    await seed("old"); // ready under an old-format id, as the migration's backfill (or `seed`) stores it
    await seed("fresh", { ready: false });
    await seed("unrecorded", { ready: false });
    const opaque = (name: string) =>
      `h_${"a".repeat(26)}:ingest-${id(name).replaceAll("-", "").padEnd(52, "b")}.2`;
    // A new-format run: a status row under the opaque id and the same id recorded on the document.
    await seedRow(fx.db.owner, opaque("fresh"), id("fresh"), A1.userId, READY_STATE);
    await fx.db.owner.query("UPDATE documents SET ingest_execution_id = $2 WHERE id = $1", [
      id("fresh"),
      opaque("fresh"),
    ]);
    // A ready status row, but the document has no recorded id: SQL cannot build one, so it is not ready.
    await seedRow(fx.db.owner, opaque("unrecorded"), id("unrecorded"), A1.userId, READY_STATE);
    await link(ch("a", 0), ch("old", 0), 0.9);
    await link(ch("a", 1), ch("fresh", 0), 0.8);
    await link(ch("a", 2), ch("unrecorded", 0), 0.7);
    expect((await read("a"))?.related.map((r) => r.documentId)).toEqual([id("old"), id("fresh")]);
    // The same through the entity query's readiness join.
    const shared = await entity("Acme", [
      ch("a", 3),
      ch("old", 1),
      ch("fresh", 1),
      ch("unrecorded", 1),
    ]);
    expect(shared).toBeTruthy();
    const names = (await read("a"))?.entities.flatMap((e) => e.documents.map((d) => d.documentId));
    expect(names?.sort()).toEqual([id("fresh"), id("old")].sort());
  });
```

and, in the scale test's `beforeAll` (the one that bulk-inserts `read_model_state` rows with `'u_' || d.owner_id::text || ':ingest-' ...`), add right after that insert (the seeded documents must carry the id the readiness join compares):

```ts
        // The readiness join compares the id stored on the document (migration 0038), so the seeded documents carry it.
        await c.query(
          `UPDATE documents SET ingest_execution_id = 'u_' || owner_id::text || ':ingest-' || id::text || '.' || ingest_generation::text`,
        );
```

(The existing plan-shape assertions in that file stay: the lookup is still a key lookup. If one of them fails after this change, the comparison is no longer reaching `read_model_state`'s primary key: check the `exec_key` column is selected from the lateral `documents` row.)

In `apps/server/app/sensitive.test.ts`, replace the test `leaves an ingest execution's events untouched` (it pinned the plaintext ids this task seals) with:

```ts
  it("seals the ids of a flow's start input and of a step's input, opens them again, and leaves outcomes and counts in the clear", async () => {
    const ingest = `u_${U}:ingest-${C}`;
    const input = { tenantId: "tenant-id-0001", userId: U, documentId: C };
    const { raw, plain } = await roundTrip(ingest, [
      { eventType: "EXECUTION_STARTED", payload: { input } },
      { eventType: "STEP_STARTED", payload: { stepId: "ingest-parse", input } },
      {
        eventType: "STEP_COMPLETED",
        payload: { stepId: "ingest-parse", output: { outcome: "done", count: 1 } },
      },
    ]);
    for (const e of raw.slice(0, 2)) {
      const sealedInput = (e.payload as { input: Record<string, unknown> }).input;
      expect(
        [sealedInput.tenantId, sealedInput.userId, sealedInput.documentId].map(isSealed),
      ).toEqual([true, true, true]);
    }
    // No plain user, tenant or document id is left in any payload of the raw log (the execution id is the id module's business).
    const payloads = JSON.stringify(raw.map((e) => e.payload));
    for (const plainId of [U, C, "tenant-id-0001"]) expect(payloads).not.toContain(plainId);
    expect(plain[0]?.payload).toEqual({ input });
    expect(raw[2]?.payload).toEqual({
      stepId: "ingest-parse",
      output: { outcome: "done", count: 1 },
    });
  });
```

In `apps/server/app/bootIngest.test.ts`: the fake build gets an id cache. Add `ids: { warm: warmIds },` to the `built` object of `parts()` (before `vectors: {},`), declare `let warmIds: () => Promise<number> = async () => 0;` above `beforeEach`, reset it there (`warmIds = async () => 0;`), and append:

```ts
describe("bootIngest: the id key cache", () => {
  it("is warmed before the status model boots, so before recovery, the fold or any observer", async () => {
    warmIds = async () => {
      calls.push("warmIds");
      return 3;
    };
    await bootIngest(parts());
    expect(calls.indexOf("warmIds")).toBeGreaterThan(-1);
    expect(calls.indexOf("warmIds")).toBeLessThan(calls.indexOf("bootStatus"));
  });

  it("a failed warm-up cleans up with the fixed label, never serves and never starts recovery", async () => {
    warmIds = async () => {
      throw new Error("key store down: u_secret");
    };
    await expect(bootIngest(parts())).rejects.toThrow("id keys failed to boot");
    expect(calls).not.toContain("bootStatus");
    expect(calls).toContain("closeApp");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `set -a; . ./.env; set +a; cd apps/server && pnpm exec vitest run app/ui/connections.pg app/bootIngest`
Expected: FAIL (the connections reader still builds `'u_' || ...` in SQL, so a document with a new-format id is never ready; `bootIngest` does not call `warm`).

- [ ] **Step 3: Connections compares the stored id**

In `apps/server/app/ui/connections.ts` replace the `EXEC_KEY` constant and the doc comment above `READY_ROW` with:

```ts
/**
 * "Ready" is what the status read model says (`documents.status` is not maintained): the same rule as `docmind_ready_documents`
 * (migration 0028), through the app role's tenant-scoped `SELECT` on `read_model_state`.
 * The key is the document's stored `ingest_execution_id` (migration 0038: the id of its current generation's ingest, recorded by the
 * application when it starts one), carried in a subquery's output: row-level security only lets a leakproof comparison of plain values
 * reach the primary key (model_id, execution_id), and a plain column is one. SQL no longer builds the id from the user and document
 * UUIDs (a new-format id cannot be built there: it needs the user's key); a document with no recorded id is not ready.
 */
const READY_ROW = (key: string): string => `EXISTS (
    SELECT 1 FROM read_model_state s
     WHERE s.model_id = 'ingest-status' AND s.execution_id = ${key}
       AND NOT s.erased AND s.state ->> 'status' = 'ready')`;
```

and, in `RELATED_SQL` and in `ENTITIES_SQL` (the two lateral subqueries), replace `${EXEC_KEY("d")} AS exec_key` with `d.ingest_execution_id AS exec_key`. Nothing else in the file changes.

- [ ] **Step 4: Warm the key cache at boot**

In `apps/server/app/bootIngest.ts`, between `await verifyVectors(vectors, cleanup);` and the status boot, add (the `ids` member of `built` is the one `buildServer` returns, Task 5; `bootStatus` is the existing wrapper that cleans up and throws a fixed label):

```ts
  // The id key cache is warmed before the status model boots, so before recovery, the fold or any observer reads a new-format id (R14). A
  // key-store outage fails the boot here (with the fixed label, never an id): nothing falls back to an old-format id.
  await bootStatus(
    {
      boot: async () => {
        // Counts only, so a slow boot on many users is explained (the cache is in memory).
        console.info("id keys warmed", { users: await built.ids.warm() });
      },
    },
    cleanup,
    "id keys",
  );
```

Warming happens before `bootStatus(status, cleanup)`, so it runs before the status fold, before recovery and before any observer reads a new-format id; the `h_` runs recovery re-drives need no key (ownership is from the shape), but the fold's key and scope do.

- [ ] **Step 5: Seal the id fields of flow inputs**

At the very top of `apps/server/app/sensitive.ts` (above the file's header comment) add:

```ts
/**
 * The id fields of a flow's start input (and of each step's input, which is the same ref). They are ids, not content, but the ids of a user, a
 * document and a chat in a plaintext payload would link an erased user's records after the key is gone (R14), so they are sealed with the rest.
 */
const FLOW_INPUT_IDS = [
  "input.tenantId",
  "input.userId",
  "input.documentId",
  "input.chatId",
] as const;
```

and spread `...FLOW_INPUT_IDS,` as the last member of the `STEP_STARTED` list (after `"input.report"`) and of the `EXECUTION_STARTED` list (after `"input.pending"`). Update the first rule in the header comment ("a flow's start input carries ids only") to end "...never a filename, title or text; the ids themselves are sealed (`FLOW_INPUT_IDS`), so no plain user, document or chat id is left in a payload once the key is gone".

`apps/server/app/flows/ingest-document/testing.ts` (the raw-log proof `assertEventsAreContentFree`): in `payloads`, replace the `ids` shape with `const ids: Shape = { documentId: sealed, tenantId: sealed, userId: sealed };` (a comment: sealed under the user's key, `sensitive.ts` `FLOW_INPUT_IDS`), and in `SEAL.covers` extend the accepted paths regex to `/^(EXECUTION_STARTED\.principal\.identity\.(actor|tenant)|(EXECUTION|STEP)_STARTED\.input\.(tenantId|userId|documentId)|(STEP|EXECUTION)_FAILED\.error)$/`. Any other proof helper that walks raw payloads and fails with "`<path>` is not an id" (chat, visualize and suggest-tags suites, `erasure/e2eSupport.ts`) accepts a sealed envelope at that path in the same way: the failure names the path and the helper, and the shape of a sealed leaf is the `sealed` predicate above.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `set -a; . ./.env; set +a; cd apps/server && pnpm exec vitest run app/ui app/bootIngest app/db app/sensitive app/documents/sweepSql app/flows/visualize-document/ready.pg app/flows/ingest-document/eventLog.pg`
Expected: PASS (pg tests run, not skipped).

- [ ] **Step 7: Typecheck, lint, commit**

Run: `pnpm exec biome check --write apps/server/app && pnpm typecheck && pnpm typecheck:tests && pnpm lint`
Expected: no errors.

```bash
git add apps/server/app
git commit -m "feat(ids): connections compares the stored ingest id, flow-input ids are sealed, and boot warms the key cache first"
```

---

### Task 7: The ratchet, the last old builders and the chat call sites (O5, F9)

**Files:**
- Modify: `apps/server/app/subject.ts` (remove the `executionIdFor` alias), `apps/server/app/flows/chat-title/start.ts` (the title id, old format until phase 2), the tests that import `executionIdFor` (list in step 3), `apps/server/app/executionIds.test.ts`
- Test: `apps/server/app/executionIds.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 6 (every non-chat caller has moved; the chat builders `chatConversationId`, `turnExecutionId`, `turnExperienceId` already call `legacyIds`).
- Produces: no non-test code outside `app/opaqueIds/` (and `erasure/e2eSupport.ts`) names an id's shape; `executionIdFor` is gone (tests use `legacyIds.named`).

Decision: the second ratchet reads every non-test source file as syntax (not text) and reports any string, template, template part or regex literal that has an id's shape, so a comment, a failure code (`visuals-model-unavailable`) or a step id (`visualize-extract`) never trips it, and a control proves it bites. `erasure/e2eSupport.ts` is the one named exception: it is the test-support module that asserts about the ids themselves (what survives an erasure). Phase 2's chat builders already go through `legacyIds.*` here, so the scan is clean without an allow-list for them.

- [ ] **Step 1: Write the failing test**

In `apps/server/app/executionIds.test.ts`: change the first two imports to `import { readFileSync, readdirSync } from "node:fs";` and `import { join, resolve, sep } from "node:path";`; in the virtual snippet replace the `executionIdFor` import with `legacyIds` and use `legacyIds.named(...)` in the bodies (the snippet header keeps its line count, so the `__virtual__.ts:4` expectation stands):

```ts
const VIRTUAL = join(APP, "__virtual__.ts");
const snippet = (body: string) =>
  scanStarts(
    [],
    new Map([
      [
        VIRTUAL,
        `import type { WorkflowRuntime } from "@loom/workflow-runtime";
         import { legacyIds } from "./opaqueIds";
         declare const rt: WorkflowRuntime; declare const flow: never; declare const user: string;
         export async function f() { ${body} }`,
      ],
    ]),
  );
```

Rename the first test to `accepts a start and a fork whose executionId comes from an id builder`, change its two bodies to `{ executionId: legacyIds.named(user, "n") }` and `const id = legacyIds.named(user, "n"); ...`, and append:

```ts
/**
 * Where an id is built or parsed outside `opaqueIds` (R14, spec O5): every string, template, template part or regex literal that carries
 * an id's shape, and every import of Loom UI's lineage stream prefix. `virtual` adds in-memory files so the scan itself can be tested.
 */
const ID_SHAPES: readonly RegExp[] = [
  /^\^?[uh]_/, // the user prefixes: `u_<uuid>` and `h_<handle>`
  /:(?:ingest|visualize|suggest-tags|chat-title)-/, // a flow name after a user prefix
  /\.c-/, // a conversation id
  /^\^?(?:turn)?visuals-(?:\(|$)/, // a lineage line: the head of `visuals-${...}` or of a regex `^visuals-(...)`
];

function idShapesIn(files: string[], virtual = new Map<string, string>()): string[] {
  const hits = new Set<string>();
  const scan = (name: string, text: string) => {
    const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      let literal: string | undefined;
      if (
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node) ||
        ts.isRegularExpressionLiteral(node)
      )
        literal = node.text ?? node.getText(sf);
      const imported = ts.isImportSpecifier(node) && node.name.text === "LINEAGE_STREAM_PREFIX";
      if (
        imported ||
        (literal !== undefined && ID_SHAPES.some((shape) => shape.test(literal as string)))
      ) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        hits.add(`${name.startsWith(APP) ? name.slice(APP.length + 1) : name}:${line}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  };
  for (const file of files) scan(file, readFileSync(file, "utf8"));
  for (const [name, text] of virtual) scan(name, text);
  return [...hits];
}

/** The one named file outside `opaqueIds/` that may name an id's shape: it asserts about the ids themselves (what survives an erasure). */
const MAY_NAME_IDS = new Set(["erasure/e2eSupport.ts"]);

describe("no id is built or parsed outside opaqueIds", () => {
  it.each([
    ["an old-format user prefix", "export const a = `u_${user}:ingest-${doc}`;"],
    ["a new-format prefix", 'export const a = "h_" + handle;'],
    ["a flow name", 'export const a = ":visualize-" + doc;'],
    ["a conversation separator", "export const a = `${prefix}.c-${chat}`;"],
    ["a lineage template", "export const a = `visuals-${user}-${doc}`;"],
    ["a turn lineage regex", "export const a = new RegExp(`^turnvisuals-(${U})`);"],
    ["the lineage stream prefix", 'import { LINEAGE_STREAM_PREFIX } from "@loom-ui/lineage";'],
  ])("flags %s (the scan is not blind)", (_name, body) => {
    expect(idShapesIn([], new Map([[join(APP, "__virtual__.ts"), body]]))).toEqual([
      "__virtual__.ts:1",
    ]);
  });

  it("does not flag a failure code, a step id or ordinary text that only starts like a lineage word", () => {
    const body = [
      'export const a = "visuals-model-unavailable";',
      'export const b = "visualize-extract";',
      'export const c = "chat-title";',
      'export const d = "the h_ prefix is documented elsewhere";',
    ].join("\n");
    expect(idShapesIn([], new Map([[join(APP, "__virtual__.ts"), body]]))).toEqual([]);
  });

  it("finds none in the real sources, beyond opaqueIds and the one named support file", () => {
    const real = sources(APP).filter(
      (f) =>
        !f.startsWith(join(APP, "opaqueIds") + sep) && !MAY_NAME_IDS.has(f.slice(APP.length + 1)),
    );
    expect(real.length).toBeGreaterThan(100); // the scan reads the program, not an empty list
    expect(idShapesIn(real)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to see what the scan finds**

Run: `cd apps/server && pnpm exec vitest run app/executionIds`
Expected: the controls pass and the real-sources test FAILS listing `file:line` of any remaining id literal outside `opaqueIds` (before this task: `subject.ts` and the `executionIdFor` callers; none else if Tasks 3 to 6 are done). Each hit is moved into `opaqueIds` or, for a literal that is not an id (it cannot be, today), explained in the test's allow-list: there are none.

- [ ] **Step 3: Remove the last old builder and move the chat title**

`apps/server/app/subject.ts`: delete the `executionIdFor` alias and its doc comment, and the `legacyIds` import (the file is then the `subjectOfExecution` function and the three re-exports).

`apps/server/app/flows/chat-title/start.ts`: replace `import { executionIdFor } from "../../subject";` with `import { legacyIds } from "../../opaqueIds";` and the `executionId` of the start with:

```ts
        // One title execution per chat: Loom starts a caller-chosen id once. PHASE 2 builds it with `UserIds.chatTitle` (`h_<H>:chat-title-<C>`); until then it is the old format.
        executionId: legacyIds.chatTitle(input.userId, input.chatId),
```

Every test that imported `executionIdFor` keeps its calls through a local alias of the old builder (the generic `u_<user>:<name>` shape its assertions are about). Run from `apps/server/app` (idempotent):

```bash
python3 - <<'PY'
import re, subprocess
for f in subprocess.check_output("grep -rl 'executionIdFor' . --include='*.ts'", shell=True, text=True).split():
    s = open(f).read()
    if "const executionIdFor = legacyIds.named" in s: continue
    s2 = re.sub(r'import \{ executionIdFor \} from "([./]*)subject";\n',
                lambda m: f'import {{ legacyIds }} from "{m.group(1)}opaqueIds";\n\nconst executionIdFor = legacyIds.named;\n', s)
    s2 = re.sub(r'import \{([^}]*)\bexecutionIdFor\b,?([^}]*)\} from "([./]*)subject";',
                lambda m: f'import {{{m.group(1)}{m.group(2)}}} from "{m.group(3)}subject";\nimport {{ legacyIds }} from "{m.group(3)}opaqueIds";\n\nconst executionIdFor = legacyIds.named;', s2)
    if s2 != s: open(f, "w").write(s2)
PY
```

then run `pnpm exec biome check --write apps/server/app`: biome sorts the imports, and if a file now imports `legacyIds` twice, delete the duplicate line. The files are `retention.test.ts`, `storage.test.ts`, `erasure/{wire,tolerantSource,compliance}.test.ts`, `erasure/{bootAfterErase,wiring}.pg.test.ts`, `flows/visualize-turn/ids.test.ts`, `flows/visualize-document/{start,plan,commit}.test.ts` and `executionIds.test.ts` itself.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/server && pnpm exec vitest run app/executionIds app/subject app/retention app/storage.test app/erasure app/chats/startRatchet app/flows/visualize-turn app/flows/chat-title`
Expected: PASS (the start/fork ratchet still finds every real start and fork, the id-shape ratchet finds none).

- [ ] **Step 5: Typecheck, lint, commit**

Run: `pnpm exec biome check --write apps/server/app && pnpm typecheck && pnpm typecheck:tests && pnpm lint`
Expected: no errors.

```bash
git add apps/server/app
git commit -m "test(ids): a ratchet that keeps id building and parsing inside opaqueIds; drop the last old builder"
```

---

### Task 8: End to end (upload, visualize, suggest tags, erase; a cold restart), the erasure scan, and the docs (spec section 8, F10)

**Files:**
- Create: `apps/server/app/erasure/opaqueIds.e2e.pg.test.ts`
- Modify: `apps/server/app/erasure/e2eSupport.ts` (`Seeded.handle`, `Who.handle`, `isUserExecution`, `ID_VALUE`, the key checks of `assertErased`), `apps/server/app/erasure/suggestTags.restart.e2e.pg.test.ts` and `apps/server/app/documents/tags.e2e.pg.test.ts` (they read a run's log by id: now the new-format id), `docs/architecture.md`, `docs/operations/cloud-deploy.md`, `docs/codebase-guide.md`

**Interfaces:**
- Consumes: Tasks 1 to 7; the existing erasure e2e harness (`seedUser`, `eraseMe`, `waitErased`, `assertErased`, `needlesOf`, `scanTables`) and `startIngestStack` (its `composed` member is `buildServer()`'s result, so `st.composed.ids` is the stack's id cache).
- Produces: `Seeded.handle: string | null` (the user's `users.id_handle` once seeded), `Who.handle?: string | null`; the new e2e proves spec section 8's end-to-end and recovery claims for the document flows; the docs describe the new ids, the two subjects, the residuals and the rollback rule.

- [ ] **Step 1: The erasure harness knows both id formats**

In `apps/server/app/erasure/e2eSupport.ts`:

1. `Seeded` gains `/** The user's id handle (users.id_handle) once a document flow has started for them: the h_<handle> of their new-format executions. */ handle: string | null;` and `seedUser` fills it just before it returns:

```ts
  const handle =
    ((
      await st.db.owner.query("SELECT id_handle FROM users WHERE id = $1", [who.userId])
    ).rows[0]?.id_handle as string | null | undefined) ?? null;
```

   and adds `handle,` to the returned object.
2. `Who` gains `handle?: string | null;` and `assertErased` fills it from `user.handle` when it builds `who`.
3. `isUserExecution` accepts the new format (it is how the allow-list recognises "the user's own execution"):

```ts
const isUserExecution = (id: unknown, who: Who) =>
  typeof id === "string" &&
  (id.startsWith(`u_${who.userId}`) || (!!who.handle && id.startsWith(`h_${who.handle}`)));
```

4. `ID_VALUE` accepts an `h_<handle>` id value (the ids-only payload check):

```ts
const ID_VALUE = new RegExp(
  `^(${UUID_RE}|u_${UUID_RE}([:.~][A-Za-z0-9_.:~-]*)?|h_[a-z2-7]{26}([:.~][A-Za-z0-9_.:~-]*)?)$`,
);
```

5. In `assertErased`, after the user key claim (`3. The key: destroyed, remembered as destroyed...`), add the handle's key and the cache:

```ts
  // 3b. The handle's subject key is destroyed too, remembered as destroyed, and its tombstone holds no key material; the handle
  //     went with the user row, and the cached id key went with the key.
  if (user.handle) {
    const subject = `h_${user.handle}`;
    expect(await keys.wasDestroyed(subject)).toBe(true);
    expect(await keys.get(subject)).toBeNull();
    const handleKey = await db.owner.query(
      "SELECT wrapped_dek IS NULL AS no_key, destroyed_at IS NOT NULL AS gone FROM data_keys WHERE subject_id = $1",
      [subject],
    );
    expect(handleKey.rows).toEqual([{ no_key: true, gone: true }]);
    expect(
      (await db.owner.query("SELECT count(*)::int AS n FROM users WHERE id_handle = $1", [user.handle]))
        .rows[0].n,
    ).toBe(0);
    expect(st.composed.ids.knows(user.handle)).toBe(false);
  }
```

6. In the tombstone check (`2. The read models`), the query that looks for tombstones by `starts_with(execution_id, u_<user>)` stays (the chats are still old-format in phase 1); add the handle's rows to its second argument so a new-format ingest tombstone is found too:

```ts
      "SELECT DISTINCT model_id FROM read_model_state WHERE (starts_with(execution_id, $1) OR ($2::text IS NOT NULL AND starts_with(execution_id, 'h_' || $2))) AND erased AND state IS NULL",
      [`u_${user.userId}`, user.handle],
```

   (the file's allow-list owns the one remaining `h_` literal outside `opaqueIds`; the ratchet of Task 7 names this file for that reason).

7. `assertLogUnreadable` walks every execution of the user and asserts each id holds the user's UUID (it did, for every old-format id). A new-format id holds the handle instead. In its `ids` list replace the `executionIds(st)` filter with

```ts
      ...(await executionIds(st)).filter(
        (id) => id.includes(gone.userId) || (!!gone.handle && id.includes(gone.handle)),
      ),
```

   and the loop's first assertion (`expect(id.includes(gone.userId)).toBe(true);`) with

```ts
    // keyed outside the user's subjects: unshreddable
    expect(id.includes(gone.userId) || (!!gone.handle && id.includes(gone.handle))).toBe(true);
```

`apps/server/app/erasure/suggestTags.restart.e2e.pg.test.ts` and `apps/server/app/documents/tags.e2e.pg.test.ts` read a run the real starter began: Task 5 step 6 moves them to `st.runIds.suggestTags(...)` (`second.runIds.suggestTags({ tenantId, userId }, documentId, 1)` there).

- [ ] **Step 2: Write the end-to-end test**

`apps/server/app/erasure/opaqueIds.e2e.pg.test.ts`:

```ts
import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { PG_URL } from "../db/testSupport";
import { type IngestStack, startIngestStack } from "../documents/ingestStack";
import { opaqueIds } from "../opaqueIds";
import { assertErased, eraseMe, seedUser, waitErased } from "./e2eSupport";

const WAIT = 240_000;
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe.skipIf(!PG_URL)("opaque execution ids, end to end (needs DOCMIND_TEST_PG_URL)", () => {
  const stacks: IngestStack[] = [];
  const dbs = new Set<IngestStack["db"]>();
  const roots = new Set<string>();
  const track = (s: IngestStack) => {
    stacks.push(s);
    dbs.add(s.db);
    roots.add(s.root);
    return s;
  };
  afterAll(async () => {
    for (const s of stacks.splice(0)) await s.close({ keepDb: true });
    for (const db of dbs) await db.drop();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it(
    "upload, visualize, tags and chat leave h_<handle> executions with no plain uuid; the erasure destroys both subject keys and the handle, and nothing of the user is left",
    async () => {
      const st = track(await startIngestStack({ chat: true }));
      const login = await st.signUpAndLogIn("opaque@example.com");
      const user = await seedUser(st, login, "opaque@example.com");

      // The control: the new format is really in the log, and the old format (the chat, until phase 2) is too, so the scan has both to judge.
      expect(user.handle).toMatch(/^[a-z2-7]{26}$/);
      const fresh = user.executions.filter((id) => id.startsWith(`h_${user.handle}`));
      expect(fresh.some((id) => id.includes(":ingest-"))).toBe(true);
      for (const id of fresh) {
        expect(id).not.toMatch(UUID_ANYWHERE);
        for (const plain of [user.userId, user.documentId, user.chatId]) expect(id).not.toContain(plain);
      }
      expect(user.executions.some((id) => id.startsWith(`u_${user.userId}`))).toBe(true);
      // The document's recorded ids are the ones that ran: the sweeps and the connections reader compare them.
      const row = await st.db.owner.query(
        "SELECT ingest_execution_id AS i FROM documents WHERE id = $1",
        [user.documentId],
      );
      expect(fresh).toContain(row.rows[0].i);
      // The id parses back to the document while the key is cached, and to nothing afterwards.
      const ingestId = row.rows[0].i as string;
      expect(opaqueIds.parse(ingestId)).toMatchObject({ userId: user.userId, documentId: user.documentId });

      expect((await eraseMe(st, login.cookie)).status).toBe(202);
      await waitErased(st, user.userId, 120_000);
      await assertErased(st, user, { tenantGone: true });
      expect(opaqueIds.parse(ingestId)).toBeNull(); // the handle and the key are gone: the id names nothing
    },
    WAIT,
  );

  it(
    "after a restart with a cold cache, the boot warm-up makes the user's new-format runs fold: the document is still ready",
    async () => {
      const first = track(await startIngestStack({ chat: true }));
      const login = await first.signUpAndLogIn("cold@example.com");
      const user = await seedUser(first, login, "cold@example.com");
      await first.close({ keepDb: true });
      stacks.splice(stacks.indexOf(first), 1);
      const second = track(
        await startIngestStack({
          chat: true,
          resume: { db: first.db, kek: first.kek, root: first.root },
        }),
      );
      expect(second.composed.ids.cached(user.userId)?.handle).toBe(user.handle); // warmed at boot, before the status model
      const res = await second.chatReq(login.cookie, "GET", `/api/documents/${user.documentId}`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { status: string }).status).toBe("ready");
    },
    WAIT,
  );
});
```

(`first.kek`, `first.root` and `first.db` are the members `suggestTags.restart.e2e.pg.test.ts` already uses to resume a stack.)

- [ ] **Step 3: Run the suites**

Run: `set -a; . ./.env; set +a; cd apps/server && pnpm exec vitest run app/erasure app/documents app/flows app/ui app/storage app/status app/chats app/db app/opaqueIds app/snapshots app/bootIngest app/executionIds`
Expected: PASS, with the pg and e2e tests run (not skipped). The erasure suites (`erasure.e2e`, `erasure.resume.e2e`, `erasure.after.e2e`, `suggestTags.restart.e2e`) are the regression control for the old-format chat paths beside the new document paths.

- [ ] **Step 4: Docs**

`docs/architecture.md`:

1. Boot order, step 4: replace "These are the `ingest-status` and `chat-activity` folded models. Loom's subject index is rebuilt from the execution ids." with "The per-user id key cache is warmed first (every user with an `id_handle`, before anything reads an id). Then the `ingest-status` and `chat-activity` folded models boot. Loom's subject index is rebuilt from the execution ids of both formats (`u_` and `h_`), which need no key."
2. In section 7.3 (Tags), the "Suggestions" bullet: replace `u_<user>:suggest-tags-<doc>-r<n>` with `h_<handle>:suggest-tags-<token>-r<n>` (the execution id is opaque: see 10.1).
3. In section 10 (Account erasure), add a subsection after its last paragraph:

```markdown
### 10.1 Opaque execution and lineage ids

Loom stores execution ids and lineage ids in plaintext and they outlive an erasure, so an id that holds a user, document or chat UUID would link an erased user's records for good. Every execution the document flows start (ingest, visualize-document, suggest-tags) and the document's visuals lineage line is therefore named with keyed, reversible pseudonyms from `apps/server/app/opaqueIds/`:

- `h_<H>` replaces `u_<userId>`. `H` is a 128-bit handle, `base32(HMAC(idKey, "user"))`, stored in `users.id_handle` (migration 0038) when the user's first new-format run starts.
- A document or chat id becomes a 52-character token, `base32(IV || AES-256-CTR(uuid))` with a synthetic IV (`HMAC-SHA256` over a family label and the uuid): deterministic, authenticated and reversible only with the per-user id key. Node's `crypto` has no AES-SIV, so this is the standard SIV composition from its primitives. The id key is derived with HKDF from the user's data key under `docmind-id-v1` (the `TagKeys` and `EntityKeys` mechanism, its own label); the generation, the run number and the turn ordinal stay in the clear.
- `h_<H>:ingest-<D>[.g]`, `h_<H>:visualize-<D>[.g][-rN]`, `h_<H>:suggest-tags-<D>-rN` and `visuals-<H>-<D>` are the phase 1 shapes; the chat shapes (`h_<H>.c-<C>[~n]`, `h_<H>:chat-title-<C>`, `h_<H>:visualize-turn-<C>-<ord>[-rN]`, `turnvisuals-<H>-<C>-<ord>`) are parsed already and built from phase 2. Runs from before the deploy keep their `u_<userId>...` ids and are read through the same module (dual-format parsing); nothing is renamed.
- **One module.** `opaqueIds` builds and parses every id family in both formats; `executionIds.test.ts` fails any other file that names an id's shape. The erasure subject of an execution is read from the id alone (`subjectOfExecution`): the user UUID for an old-format id, `h_<H>` for a new one. Loom therefore keeps two keys per user, and erasure calls `eraseSubject` for both, destroys the user's data key and `h_<H>`'s key, deletes `users.id_handle` with the user row and evicts the cached id key.
- **The key cache.** A synchronous parser reads an in-memory map from handle to user and id key. Boot warms it (every user with a handle) before the status model; a start awaits `ensureUser`; a reader awaits `load` (it never mints a key); a live event of a cold user goes through `status/ensureGate.ts`, which keeps log order and folds only after the cache is filled. Classification, the ingest generation, recovery ownership and the subject need no key.
- **SQL does not build ids.** `documents.ingest_execution_id` and `visualize_execution_id` hold the current generation's ids (recorded by the application before it starts an execution, cleared with a generation bump, backfilled for runs from before the deploy), and the five boot and sweep functions and the connections reader compare them with the status rows.
- **Residual.** Old-format ids stay readable after an erasure. Run counts and timing remain as records. The `data_keys` tombstones of the user's UUID and of `h_<H>` carry near-equal `destroyed_at`, so a reader of the table could pair them by time. `read_model_state` (a DocMind table) keeps `app_key` and `scope` as plain ids until the erasure tombstones them, as before.
```

`docs/operations/cloud-deploy.md`: add, after the tags-release bullet, a bullet:

```markdown
- **Do not roll back past the opaque-ids release (migration 0038, phase 1) once any `h_` run exists.** Older code cannot parse a new-format id: it would fold such an ingest as no document, never start its visuals, and read its events under no subject. Migration 0038 itself is additive and safe under old code, but the `documents.ingest_execution_id` and `visualize_execution_id` columns are then ignored, so the old sweeps would list every new-format document as unstarted. Roll forward. After the release, the first start of a user creates their id key and handle (`users.id_handle`); a key-store outage fails that start and is retried like any other.
```

`docs/codebase-guide.md`: add the row `| apps/server/app/opaqueIds/ | Opaque execution and lineage ids (R14): the id module, the per-user key cache, the handle store |` beside the `erasure/` row, and change "Ordered SQL migrations 0001–0036" to "0001–0038".

- [ ] **Step 5: Verify the plan's own hygiene, typecheck, lint, build, commit**

Run: `pnpm exec biome check --write apps/server/app && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm build`
Expected: no errors.

Run: `grep -rnE "executionIdFor|ingestExecutionId|visualizeExecutionId|suggestTagsExecutionId|experienceIdOf" apps/server/app --include='*.ts' | grep -vE "const executionIdFor = legacyIds.named|testSupport|\.test\.ts"`
Expected: no output (only the test-local aliases and the test support remain).

Browser check before the PR (the repo's rule, `docmind-workflow-preferences`): start the app, upload a document, open its Visuals tab and Connections, press Suggest tags, and confirm in the Postgres of the dev database (`SELECT execution_id FROM loom.events ... LIMIT 20`) that the new document's executions are `h_...` and the page, the tags and the connections all work; then delete the account and check the same query returns no row of that user.

```bash
git add apps/server/app docs
git commit -m "test(ids): end to end opaque ids with a cold restart and an erasure; docs"
```

---

## Phase 2 handoff (a separate plan)

Phase 1 leaves exactly these for phase 2, all builder-side (every parser already reads the new chat shapes):

- `chats/ids.ts` `chatConversationId`, `flows/visualize-turn/ids.ts` `turnExecutionId` and `turnExperienceId`, and `flows/chat-title/start.ts`: switch from `legacyIds.*` to `UserIds.conversation`, `.turnVisualize`, `.turnLineage` and `.chatTitle` (each call site awaits `ensureUser` first: the chat routes, the title starter, the turn starter and the turn commit).
- The chat entry points that parse a conversation id synchronously (`chats/scope.ts`, `reasoningStore.ts`) get their user cached by the route's `ensureUser`; the turn trigger and the activity model already `ensure`.
- Reads of turn lineage (`chats/turnHeads.ts`, `ui/routes.ts` `turnHead`, `visualize-turn/commit.ts`) read the new line first and fall back to the old, as the document line does.
- The chat `principal.actor`, `chat_sessions` ids in Loom inbox sender copies and the archived inbox keep the plain user UUID in sealed or tombstoned form: check the e2e scan once the chat ids move.
- Erasure's chat cancellation (`wire.ts` `stopChat`, `cancelTitle`) already tries both formats.

---
## Self-review

**1. Spec coverage** (every decision and section of `docs/specs/2026-11-10-opaque-ids-design.md`, and the task that implements it):

| Spec | Task |
|---|---|
| O1 keyed, reversible pseudonyms, no lookup table | Task 1 (the token is the id; the only table is `users.id_handle`) |
| O2 per-user id key, HKDF from the data key, distinct label, cached | Task 1 (`deriveIdKey`, `OpaqueIds.ensureUser/load/warm`), F1 and F2 |
| O3 handle `H`, `users.id_handle` nullable unique, migration 0038, created lazily | Tasks 1 and 2 (`handleOfKey`, `PgHandleStore.claim`, the migration) |
| O4 tokens (SIV of the uuid), generation, run and ordinal in clear | Task 1 (`sealToken`, `UserIds`, known-answer vectors) |
| O5 one module, a ratchet | Tasks 1 and 7 |
| O6 Loom subject `h_<H>` and the UUID; erasure destroys both keys, the data key and the handle | Task 3 (`subjectOfId`, `Eraser` shred, rows and key steps, `forgetSubject`) |
| O7 old `u_` runs keep working, no backfill of ids | Tasks 4 and 5 (dual parse, candidates); Task 2's backfill stores existing ids, it renames none |
| O8 phase 1 scope | all eight tasks; the phase 2 handoff is listed |
| 3 id shapes (all eight families, both formats) | Task 1 (`ids.ts`, `opaqueIds.test.ts`) |
| 4 parse and the key cache; the parsers that move; the prefix walks; SQL | Tasks 1, 3, 4, 6 (and the five sweep functions in Task 2) |
| 5 failures: key outage, handle race, erased id parses null | Tasks 1, 2, 5 (`HandleMismatchError`, `claim`, `ensureUser` throws, `ensureGate`) |
| 6 privacy and erasure, the residual, the rollback note | Tasks 3, 6 (the flow inputs' plain ids, F11, are sealed so no plain UUID is left in a new run's log), 8 (docs) |
| 8 unit tests, ratchet, Postgres tests, recovery, mixed history, end to end | Tasks 1 to 8; mixed history is covered per piece (fold in Task 4, starters and cancels in Task 5, sweeps in Task 2, connections in Task 6) rather than by one e2e, because the upload route cannot be made to start an old-format run |

**2. Placeholder scan.** No "TBD", "TODO", "implement later" or "similar to Task N" remains. Code that is mechanical across many test files (Task 5 step 5) is given as a script plus the five error kinds the compiler reports, not as a list of lines, because the lines are the compiler's.

**3. Type consistency.** Names used across tasks: `OpaqueIds` (`ensureUser`, `ensureHandle`, `load`, `warm`, `cached`, `knows`, `forget`, `forgetSubject`, `parse`, `parseLineage`), `UserIds` (`ingest`, `visualize`, `suggestTags`, `turnVisualize`, `chatTitle`, `conversation`, `documentLineage`, `turnLineage`), `HandleStore` (`read`, `claim`, `userOf`, `page`), `ExecutionRecorder` (`recordIngest`, `recordVisualize`), `UserIdSource`, `existingUser`, the four `*Candidates` functions, `legacyIds` (`named`, `ingest`, `visualize`, `suggestTags`, `turnVisualize`, `chatTitle`, `conversation`, `documentLineage`, `turnLineage`), the facade `opaqueIds` (`install`, `current`, `parse`, `parseLineage`, `clear`, `family`, `subjectOf`, `subjectOfHandle`, `handleOf`, `known`, `loadUser`, `ensure`), `ensureGate`, `USER_ID_PREFIXES`, `userPrefixes`, `isOwnedBy`, `listerPrefixes`, and the test support `testOpaqueIds`, `testIdSource`, `deterministicUser`, `AutoHandleStore`, `legacyIngestId`, `legacyVisualizeId`, `legacySuggestTagsId`, `lineageTestIds`, `experienceIdOf` (async, test only). A task's Interfaces block names only what the task before it produced.
