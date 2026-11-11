# Opaque Execution and Lineage Ids, Phase 2 (R14, the chat flows) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every chat a user creates after this deploy runs under opaque ids (the conversation `h_<H>.c-<C>[~n]`, the title `h_<H>:chat-title-<C>`, a turn's visuals `h_<H>:visualize-turn-<C>-<ord>[-rN]`, its lineage `turnvisuals-<H>-<C>-<ord>`), while every chat created before it keeps its `u_<uuid>` ids for its whole life, so an erased user's new chats leave nothing linkable and the old ones keep working.

**Architecture:** Phase 1 already parses all chat shapes and builds them in `opaqueIds`; this phase switches the builders. Because a chat's ids cannot be derived from its UUID alone (a chat has no id of its own to probe), the format is stored: migration 0039 adds `chat_sessions.id_format` (`'legacy'` for every existing row, `'opaque'` for a chat the create route makes). A new `ChatIds` resolver (`chats/chatIds.ts`) turns a chat row (or a `ChatRef`) into one set of builders in the chat's own format; every chat route, the title flow and the turn-visuals flow get their ids from it, so one chat never mixes formats. Two event fields Loom's conversation writes in plaintext (`EXECUTION_STARTED.input.owner`, `MESSAGE_CONSUMED.sender`) carry the user and tenant UUIDs; they are sealed (an experiment in the pre-flight record found them), which closes the last link between an erased handle and a UUID.

**Tech Stack:** TypeScript, Postgres (RLS, `withTenant`), Loom (`@loom/conversation`, `@loom/plugin-crypto` sensitive paths, `@loom-ui/lineage`), vitest, pnpm/turbo, biome. No new dependency.

**Spec:** `docs/specs/2026-11-10-opaque-ids-design.md` (binding; read it first, with the phase 1 plan `docs/superpowers/plans/2026-11-10-opaque-ids-phase1.md` for the module this phase builds on). The spec amendments this plan makes are marked "Spec amendment" below and written into the spec in Task 6.

## Pre-flight record (read before starting)

Everything below was verified against `main` 78e34cc (this worktree's base; `pnpm install --frozen-lockfile && pnpm build` ran clean) and the Loom checkout at `/Users/such/workspace/loom` (HEAD 370d7a7, which contains the pin cc90b33). One experiment was run and reverted (`git checkout -- .`, tree clean): the chat builders were switched to `h_` through the process-wide cache in a scratch edit, and `erasure.e2e.pg.test.ts` plus the chat, title, turn-visuals and erasure suites were run. Its findings are F5, F6 and F8.

| Id | Finding | Where handled |
|---|---|---|
| F1 | **Every site that builds a chat id** (all call the old `legacyIds.*` today): `chats/ids.ts:35-43` `chatConversationId` (callers: `chats/routes.ts:155`, `messages.ts:95`, `reasoningRoutes.ts:35`, `stream.ts:132`, `manageRoutes.ts:64,95`, `messageRoutes.ts:54,87`, `flows/visualize-turn/readTurn.ts:48`, `flows/chat-title/step.ts:75`); `flows/visualize-turn/ids.ts:29-39` `turnExecutionId` (caller `visualize-turn/start.ts:58`); `ids.ts:45-50` `turnExperienceId` (callers `visualize-turn/commit.ts:59`, `chats/turnHeads.ts:27`, `ui/routes.ts:119`); `flows/chat-title/start.ts:39` `legacyIds.chatTitle`. **Every site that parses one** (all through `opaqueIds`, all already dual-format): `chats/ids.ts:46-59` (`chatIdOfConversation`, `isChatTitleExecution`, `isChatConversation`, `isRecoverableChatExecution`), `chats/scope.ts:37` (`scopeOfEffect`), `chats/activity.ts:46-50,162-164` (key, scope, `ensureGate`), `chats/reasoningStore.ts:39`, `flows/visualize-turn/trigger.ts:30-33` (awaits `opaqueIds.ensure`), `visualize-turn/ids.ts:53-67`, `bootIngest.ts:32-33` and `flows/ingest-document/recovery.ts:223` (shape-only), `subject.ts` (`subjectOfId`, shape-only). **Both formats are built** in `erasure/wire.ts:97-98,114-115` (`stopChat`, `cancelTitle`). No parser needs a change. | Tasks 1, 4 |
| F2 | **`@loom/conversation` and the charset question (settled).** `isValidConversationId` is `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` and not `__loom_`-prefixed; a generation is `<chainId>~<n>` (`conversationIdOf` splits at the first `~`); `::` is the child separator. Loom never lower-cases or otherwise folds an id, and derives no subject: the erasure subject comes from DocMind's `subjectOfExecution` (shape only: `^h_(H)(?::\|\.c-\|$)`), and the principal is whatever the route passes (`{ tenant, actor: userId }`). A new conversation id is `h_` + 26 + `.c-` + 52 = 83 characters, 93 with a nine-digit generation: under the 128 limit. Base32 lower-case `[a-z2-7]` has no `~`, `:` or `.` and starts with `h`: **no conflict.** `UserIds.conversation` (phase 1) already throws if `isValidConversationId` is false, and `opaqueIds.test.ts` already pins the shape. The open question is closed; the only thing the conversation id forces is that the `u_<uuid>:` form is unavailable (a colon), which both formats already respect. | Global Constraints, Task 4 |
| F3 | **An existing chat cannot be recognised from its row, so the format is stored (decision 1).** `chat_sessions` has no conversation id and the old id is a pure function of `(user, chat)`; the new id is a pure function of `(user key, chat)`. Nothing in the row says which one a chat started under, and probing Loom for "does `h_<H>.c-<C>` exist, else try `u_`" would be an async lookup in every route and a race at creation. A chat's generations (`~n`), its inbox streams, its title and its turn visuals all hang off the one id. So migration 0039 adds `id_format text NOT NULL DEFAULT 'legacy' CHECK (id_format IN ('legacy','opaque'))`: the default is exactly right for every row that exists (they were all created under `u_`), the create route writes `'opaque'`, and a row inserted without the column (a test, an old pod during a deploy) is legacy, which matches what old code starts. The column holds no id (nothing links it to a handle). A metadata-only `ADD COLUMN` (constant default): no rewrite. | Task 1 |
| F4 | **Routes map the URL's chat UUID to the conversation id in one place.** Every route calls `loadChat` (a `chat_sessions` read by `(id, user_id)`) first, so the row (with `id_format`) is in hand; the id is then `await deps.chatIds.forRow(identity, row)`. For an opaque chat `forRow` calls `existingUser` (`opaqueIds.load`, never mints) and builds synchronously from the cached `UserIds`; for a legacy chat it needs nothing. Callers that hold only a `ChatRef` (the title starter, the turn starter, the turn commit, the turn reader, the turn heads, the visuals head route) use `forRef`, which reads `id_format` once per chat (cached: a chat's format never changes) and returns `null` for a chat that is not the owner's. Only the create route mints (`forNew` → `ensureUser`). The title step already reads the row, so it uses `forRow`. | Tasks 1, 4 |
| F5 | **The conversation writes the owner's plain ids into its own log (experiment).** With the builders switched, the erasure scan failed on `loom.events.payload` for the `h_<H>.c-<C>` execution only: `EXECUTION_STARTED` `input.owner = { actor, tenant }` and `MESSAGE_CONSUMED` `sender = { actor, tenant }` hold the user and tenant UUID in plaintext. Loom seals `principal`, the inbox `payload` and the inbox `sender` (sender-handle sealing) itself, not these two. Beside the new handle they link it to the user and the tenant after the key is gone: the exact link spec section 1 removes. **Decision:** register `input.owner` (`EXECUTION_STARTED`) and `sender` (`MESSAGE_CONSUMED`) in `SENSITIVE_EVENT_PATHS`. `INBOX_MESSAGE.sender` is not registered: Loom already seals it under the sender subject (`SenderHandles`, ADR 0139 N6, on by default), which is why the scan found only these two (I1). Tried in the scratch copy: the chat, title, turn-visuals and erasure suites pass with them sealed (a log that mixes plaintext and sealed consumptions reads fine, as Loom documents for `MESSAGE_CONSUMED.payload`), and the one test that pins the exact path map (`flows/ingest-document/flow.test.ts`, "the map holds only the conversation event types") must list the one new type (`MESSAGE_CONSUMED`). Sealing applies to legacy chats' new events too; their old events stay plaintext (O7). | Task 2 |
| F6 | **The erasure harness assumes a `u_` chat in six places (experiment).** After the flip the scan itself was clean once F5 was fixed, but: (a) `assertErased` expects `u_` tombstones for `chat-activity` and `ingest-status`; a new chat leaves none under `u_` (its rows are under `h_<H>`); (b) `assertLogUnreadable` insists every execution it lists contains the user UUID or starts with `h_<H>`, which fails for `__loom_inbox__:h_<H>.c-...` and `__loom_ui_lineage__:turnvisuals-<H>-...`; (c) `leafOk` refuses any UUID-shaped leaf on an `h_` row, and the chat's fixed system prompt (`chats/agent.ts:23`) contains the nil UUID as a citation example (`[[00000000-0000-0000-0000-000000000000]]`); (d) `golden.e2e.pg.test.ts:246` expects subjects `[ada, h_<H>]`, and `erasure.resume.e2e.pg.test.ts:69,287`, `erasure.noPair.e2e.pg.test.ts:119` and `opaqueIds.e2e.pg.test.ts:296` rely on the user's UUID subject owning a running turn, which only a `u_` chat gives. | Task 3 |
| F7 | **Erasure already covers `h_` chats.** `eraser.ts:475-477` (`stopWork`) walks `work.chatIds` (every `chat_sessions` row of the user, deleted ones included: `pgSteps.ts:58`) and calls `stopChat` and `cancelTitle`; `wire.ts:92-122` builds BOTH the old id and (when `existingUser` finds the handle) the new id for each and stops/closes/cancels both, ignoring "not found". The chat's turn-visualize runs are not cancelled by id: they end through `PgTurnGuard` (`visualize-turn/guard.ts`: `users.erasing_at IS NOT NULL` makes the next step "gone"), and a running one parks the shred, which the repeated stop and `record: false` park (phase 1) already handle. The subject index, `forgetUser`, the `rows` step's timers and leases, the snapshot pruner and the `chat-activity` tombstone scrub (`scope`, `app_key` set to NULL under `h_<H>`) are phase 1 and prefix- or range-based, so they cover `h_<H>.c-...`, `h_<H>:chat-title-...` and `h_<H>:visualize-turn-...` as they are. **No change to what the erasure steps stop, close or cancel is needed;** the one eraser-side change is evicting the user from the resolver's format cache after the shred (I2, Task 1: `ChatIdResolver.forgetUser`, called from `forgetActivity` in `erasure/wire.ts`). Task 5 proves the rest with a chat that is parked mid-turn. | Task 5 |
| F8 | **What the e2e scan's chat allow-list becomes.** `e2eSupport.ts` `ALLOWED` has one chat entry from phase 1 ("phase 1: the old-format id of the user's own chat-turn visuals lineage", `__loom_ui_lineage__:turnvisuals-<user>-`). It stays only for a user who has a legacy chat (`Who.legacyChats`), under the reason "O7: a legacy chat's turn visuals line"; for a user with new chats only, the entry does not apply and any `turnvisuals-<userId>-` row fails the scan. `ownExecution`/`isUserExecution` already accept both prefixes. `needlesOf` does include `h_<H>`, but a lineage id holds the bare `<H>` after `turnvisuals-` (no `h_` prefix), so the scan does not hit `turnvisuals-<H>-<C>-<ord>`; Task 5 asserts the new lines exist, hold no UUID, and refuse as `line-erased` afterwards. | Tasks 3, 5 |
| F9 | **Flow hashes do not move.** `flowContentHash` hashes the definition id, version, deadline and steps only (phase 1 F5): `chat-title` 1.0.0 stays `sha256:f56568832761a1d68e89a5daf6b8edcf299eeadce26c916438f5f83a2cfa2007` (pinned in `flows/chat-title/flowHash.test.ts`); no flow version changes. | none |
| F10 | **Turn lineage needs no new-then-old fallback (a change from the phase 1 handoff).** The handoff said turn-lineage reads should try the new line then fall back to the old, as the document line does. A document is re-visualized in place, so its head moves from the old line to the new one; a chat never changes format, so its lines are all in one format and the read goes straight to the chat's own line. This is simpler and cannot show a stale line. | Task 4 |

**Pre-flight rulings applied** (the second pre-flight scan, `.superpowers/sdd/2026-11-11-opaque-ids-phase2/preflight.md`; every suggested ruling was accepted and is written into the tasks above): C1 (ratchet allow-list of four files), C2 (`sealedIds.pg.test.ts` judges payloads only), C3 (format cache keyed by tenant), C4 (`hasOpaqueChat` in the harness), I1 (`INBOX_MESSAGE.sender` not registered, Loom seals it), I2 (`ChatIdResolver.forgetUser`, called from `forgetActivity` in `erasure/wire.ts`, tested in Task 1), I3 (the exact `seedUser` calls to pin, and the phase 1 comment kept), I4 (`stubPaymentVisuals` in the new e2e tests), I5 (the real chat harness in Task 4 step 1), I6 (`visualsE2eSupport.ts` excluded from the production tsconfig), M1 (regression guards labelled), M2 (tautology test dropped), M3 (`oldChatToken` assertion that can fail), M4 (`TitleStarter.start` doc), M5 (`legacyChatConversationId` flagged by the ratchet, with its own allow-list of the resolver and the chat test support), M6 (`TurnGoneError` swallowed in `onSettled`), M7 (F8 wording), M8 (Amendments A and C), M9 (the test-only legacy turn builders keep the old strictness), M10 (rolling-deploy note), M11 (`deniedOnHandle` in the parked test).

## How the earlier scans' defects are avoided here

| Defect class | Design |
|---|---|
| Schemas capped too low | `id_format` is a two-value CHECK; the new ids are 83 characters (conversation) and under 140 bytes (every family), asserted by `within` in `UserIds` (phase 1) and re-pinned in `chatIds.test.ts`. |
| Planner and sample mismatches | No planner, catalogue or sample is touched. The only SQL is a column added and read by primary key and owner. |
| Flaky EXPLAIN tests | None added. |
| Random-UUID ordering | Tests use fixed UUIDs (`T1`, `U1`, `C`) or sorted sets; the e2e tests compare sets of ids, never order. |
| Vacuous assertions | Every "no UUID" check has a control: the e2e proves `h_` chat executions and `turnvisuals-<H>` lines exist and that the user's ids are findable (`rowsLinkingHandleToIds` contains `read_model_state` before the erasure) before it asserts absence; the ratchet is run against virtual files that must be flagged; the mixed-history test asserts the legacy chat's ids still contain the user UUID. |
| Redeclared constants | `UUID_PATTERN`, the handle and token shapes stay in `opaqueIds/ids.ts`; `chats/chatIds.ts` imports `ChatConversationId`, `UserExecutionId` and `legacyIds`; the nil UUID is declared once in `e2eSupport.ts`. |
| SQL without owner and tenant predicates | The one new query reads `id_format` with `WHERE id = $1 AND user_id = $2` inside `withTenant` (RLS adds the tenant); the create route's insert names tenant and user. |
| Biome failures in pasted code | Each commit step runs `pnpm exec biome check --write apps/server/app` first. |
| Typecheck gates that need a later task | Task 1 renames `chatConversationId` everywhere in one step and adds `ChatIds` without using it; Task 4 removes `turnExecutionId`/`turnExperienceId` in the same task that moves their last production caller, and moves the old signatures to `visualize-turn/testing.ts` for the tests. |
| Tests that pass on both sides of a switch | Task 3 makes the harness derive a chat's format from its row, so it is green before the flip (Task 4) and after. |
| Unclosed or nested code fences | Every fence in this plan is closed and none opens inside another; Task 6's last step runs the same `awk` state check as phase 1. |

## Global Constraints

Every task's requirements include these (copied verbatim from the spec as amended by phase 1, and from the phase 1 plan; the amendments are marked "Amendment"):

**From the spec (`docs/specs/2026-11-10-opaque-ids-design.md`):**

- §1: After a user is erased, the Loom execution ids and lineage ids left behind must reveal nothing linkable: no user, document or chat UUID. The record of how many runs happened and when may remain.
- O1 **Keyed, reversible pseudonyms.** No lookup table of ids.
- O3 **A user handle.** `H = base32(HMAC(idKey, "user"))`, 128 bits. It is stored in a new `users.id_handle` column (nullable, unique; migration 0038). The handle is created lazily on the user's first new-format start. New ids use `h_<H>` where they used `u_<userId>`.
- O4 **Id tokens.** Document and chat ids become `base32(IV || AES-256-CTR(encKey, IV, uuid))`: deterministic, authenticated, and reversible while the key exists. Generation (`.g`), run (`-rN`) and chat ordinal stay in clear. **Amendment:** the token is the SIV composition from Node primitives: `IV = HMAC-SHA256(macKey, family || 0x00 || uuid)[0..16]`, with `macKey` and `encKey` separate HKDF outputs under `docmind-id-v1/mac` and `docmind-id-v1/enc`. The family (`doc` or `chat`) is authenticated with the token.
- O5 **One module, `opaqueIds`.** It builds and parses every id family in both the old and the new format. A ratchet test forbids any other code from building or parsing ids.
- O6 **Loom subject.** It is `h_<H>` for new ids and the user UUID for old ids. Erasure destroys both subject keys, the user's data key and the handle.
- O7 **Compatibility.** Old `u_` executions keep working indefinitely, through dual-format parsing. New runs use the new format from deploy. There is no backfill. The old ids stay readable after erasure; this is a documented residual.
- O8 **Two phases, one PR each.** Phase 2 covers the chat flows.
- §3 Id shapes (the chat rows; `D` and `C` are tokens, every new id stays well under Loom's 1024-byte limit):

| Family | Old | New |
|---|---|---|
| Turn visuals | `u_<u>:visualize-turn-<c>-<ord>[-rN]` | `h_<H>:visualize-turn-<C>-<ord>[-rN]` |
| Chat title | `u_<u>:chat-title-<c>` | `h_<H>:chat-title-<C>` |
| Chat conversation | `u_<u>.c-<c>[~n]` | `h_<H>.c-<C>[~n]` |
| Turn lineage | `turnvisuals-<u>-<c>-<ord>` | `turnvisuals-<H>-<C>-<ord>` |

- §4: `opaqueIds.parse(id)` is synchronous; an unknown handle, or a token that fails authentication, gives `null`. **Amendment:** `subjectOfExecution` does not depend on the cache: the subject is shape-only (`h_<H>` for an `h_<H>...` id, the user UUID for a `u_<uuid>...` id, "no subject" for a lineage id of any other shape). A start fills the cache for its user; boot warms it before recovery, the status fold or any observer; a miss outside boot does an async lookup through an awaited `opaqueIds.ensure(handle)` at the async entry points.
- §5: A key-store outage while deriving the id key fails the start, which is retried like any other key outage. A start never falls back to a plaintext-UUID id. An id from an erased user (handle gone) parses to `null`, and nothing is written under it.
- §6: No new execution id, lineage id, Loom timer or lease row, or log line contains a plain user, document or chat UUID. **Amendment, flow inputs:** every flow's start input and step inputs carry `userId` and `documentId` or `chatId` in plaintext in the event log; they are sealed under the subject key (`FLOW_INPUT_IDS`). **Amendment, tombstones:** erasure scrubs `scope` and `app_key` on the erased rows under `h_<H>` before the handle is deleted. Erasure computes or reads `H` while the keys exist; stops and cancels executions under both prefixes; destroys the data key, the `h_<H>` subject key and the cached id key; deletes `users.id_handle` along with the user.
- §8 (phase 2): unit tests; ratchet extension; Postgres tests; recovery after a restart with a cold cache (`h_` runs are recovered and their status folds correctly); a mixed history; end to end "chat, title, turn visuals, then erase; the same holds" (nothing linkable remains, including no row that holds the handle and any UUID); a browser check before the PR.

**From phase 1 (binding values):**

- A handle is exactly `^[a-z2-7]{25}[aeimquy4]$` (26 characters, the one canonical spelling of 128 bits). A token is exactly 52 characters, `[a-z2-7]{51}[aq]` (the one canonical spelling of 256 bits). Generation `[1-9][0-9]{0,8}`, run `[1-9][0-9]{0,2}`, ordinal up to 15 digits (`ORD_PATTERN`). A new-format `~n` is the same `GEN` as the old.
- Loom's execution id limit is `MAX_EXECUTION_ID_BYTES` (1024). A Loom conversation id must satisfy `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` and not start with `__loom_` (`isValidConversationId`): the new conversation id is 83 characters before a generation.
- **No plaintext user, tenant, document or chat UUID in any execution id, lineage id, timer or lease row, or log line** a new chat produces. Log lines name errors by class only, never an id.
- Only `apps/server/app/opaqueIds/` builds or parses an id's shape; `chats/chatIds.ts`, `erasure/wire.ts`, `chats/ids.ts` (the legacy conversation builder) and `flows/visualize-turn/testing.ts` (the test-only legacy turn builders) are the only other files that may call a chat family's builder (Task 5's ratchet), and `legacyChatConversationId` is called only by `chats/chatIds.ts` and the chat test support (M5).
- Readers and cancellers never mint a key or a handle (`existingUser`/`load`); only a create or a start mints (`ensureUser`).

**Environment rules (every task):**

- Postgres suites run with `set -a; . /Users/such/workspace/docmind/.env; set +a` in the same shell, which sets `DOCMIND_TEST_PG_URL`. Never point a test at `DATABASE_URL` or `DOCMIND_MIGRATE_URL`. Never print a value from `.env`.
- The worktree is `/Users/such/workspace/docmind/.worktrees/opaque-ids-p2`; run `pnpm install --frozen-lockfile && pnpm build` once before the first test (already done for this plan; repeat only after a pull).
- Commit trailers (every commit step):

```
Co-Authored-By: <model> <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011uGukQihQRMMZgAPLXQiX6
```

## Plan decisions (where the spec is silent or the code constrains it)

- **Decision 1: the format is stored on the chat row** (`chat_sessions.id_format`), not inferred, probed or stored as a conversation id. See F3. A stored conversation id was rejected: it would have to be passed to the callers that hold only a `ChatRef` anyway, and the format is all they need.
- **Decision 2: a chat's title, turn visuals and lineage follow the chat's format, not "new for any new run".** The title execution id is the once-per-chat guard (Loom starts a caller-chosen id once): an old chat whose title started as `u_<u>:chat-title-<c>` would start a second title under `h_<H>:chat-title-<C>` if the title followed the user instead of the chat. The turn rerun counter (`-rN`) and the lineage head likewise live in one format per chat.
- **Decision 3: the builders are a resolver, not globals.** `ChatIdResolver` (`forRow`, `forRef`, `forNew`) returns `ChatIdBuilders` (`conversationId()`, `titleExecutionId()`, `turnExecutionId(ord, rerun?)`, `turnExperienceId(ord)`). The method names differ from `UserIds`/`legacyIds` (`conversation`, `chatTitle`, `turnVisualize`, `turnLineage`) so Task 5's ratchet can flag a direct call by name.
- **Decision 4: `chatConversationId` is renamed `legacyChatConversationId`** (same body: it still refuses a non-canonical chat id), in one mechanical step in Task 1. Production code stops using it in Task 4; tests keep it to build the id of a legacy chat. `turnExecutionId` and `turnExperienceId` are removed in Task 4 and re-exported with their old signatures from `flows/visualize-turn/testing.ts` as `legacyTurnExecutionId` and `legacyTurnExperienceId`.
- **Decision 5: `insertChat` takes the format as an optional last argument defaulting to `"legacy"`** (the column default). The create route passes `"opaque"` explicitly; `create.pg.test.ts` pins that, and the default keeps the dozen test helpers that insert rows unchanged.
- **Decision 6: seal `MESSAGE_CONSUMED.sender`; leave `INBOX_MESSAGE.sender` to Loom.** The scan found `MESSAGE_CONSUMED.sender` in plaintext. `INBOX_MESSAGE.sender` is already sealed by Loom under the sender-handle subject (ADR 0139 N6, default on), so registering it would nest a second envelope inside the first, and `archive.ts` (`maskSender`, `senderDigestOf`, `sameReservedEnvelope`) was never exercised against that. It is not registered (I1).
- **Decision 7: the harness is made format-agnostic before the flip** (Task 3), so Task 4 is a pure behaviour change with green tests on both sides. A test that needs a `u_` chat asks for one (`seedUser(..., { chat: "legacy" })`, `createLegacyChat`).
- **Decision 8: no change to what the eraser stops or cancels** (F7); the only eraser-side change is that `forgetActivity` also calls the resolver's `forgetUser` (I2, Task 1), because the resolver caches `tenant:user:chat` formats that must not outlive the user. The erasure e2e in Task 5 includes a chat parked mid-turn to prove the rest.

**Spec amendments** (written into the spec in Task 6):

- **Spec amendment A (section 6, residual bullet).** The sentence "Until phase 2, a chat's executions and its turn visuals lineage ... keep old-format ids ..." becomes: a chat created before the phase 2 deploy keeps `u_<user>` ids for all of its executions and its turn visuals lineage for its whole life, including the executions it creates after the deploy (conversation and generations, title, turn visuals, reruns, lineage); a chat created after it is opaque. The end-to-end scan proves "no linkable id" for new chats; a legacy chat's ids are an allow-listed residual in the scan (only for a user who has one).
- **Spec amendment B (section 6, flow inputs).** The conversation's `EXECUTION_STARTED.input.owner` and `MESSAGE_CONSUMED.sender` carry `{ actor, tenant }` in plaintext; they are sealed under the subject key like the flow inputs (F5). `INBOX_MESSAGE.sender` is already sealed by Loom (ADR 0139 N6) and is not registered.
- **Spec amendment C (sections 3 and 4).** A chat's id format is stored (`chat_sessions.id_format`, migration 0039) and all of a chat's ids follow it (Decisions 1 and 2); turn lineage is read from the chat's own line with no fallback (F10). O7's "new runs use the new format from deploy" applies per chat: a legacy chat's new runs stay old-format.
- **Spec amendment D (section 8, mixed history).** Phase 2 tests the mixed history as one scenario (an old chat that continues in the old format beside a new chat), because a chat can be made legacy by a test helper; phase 1's piecewise tests stay.

## File Structure

Created:
- `infra/migrations/0039_chat_id_format.sql`.
- `apps/server/app/chats/chatIds.ts`: `ChatIdFormat`, `ChatIdBuilders`, `ChatIdResolver`, `legacyBuilders`, `opaqueBuilders`, `PgChatIds`.
- `apps/server/app/chats/chatIds.test.ts`, `apps/server/app/chats/chatIds.pg.test.ts`, `apps/server/app/db/chatIdFormat.pg.test.ts`.
- `apps/server/app/chats/sealedIds.pg.test.ts` (the conversation log holds no plain owner or sender).
- `apps/server/app/chats/visualsE2eSupport.ts` (the visuals e2e helpers, moved out of `visuals.e2e.pg.test.ts` so other e2e tests can reuse them; test-only, excluded from the production tsconfig).

Modified (production): `apps/server/tsconfig.json` (exclude), `chats/{ids,sessions,access,routes,messages,messageRoutes,reasoningRoutes,stream,manageRoutes,turnHeads,testing}.ts`, `flows/visualize-turn/{ids,start,commit,readTurn,testing}.ts`, `flows/chat-title/{start,step}.ts`, `ui/routes.ts`, `subject.ts`, `sensitive.ts`, `compose.ts`, `erasure/wire.ts`, `docs/architecture.md`, `docs/specs/2026-11-10-opaque-ids-design.md`, `docs/operations/cloud-deploy.md`.

Modified (tests and support): `erasure/e2eSupport.ts`, `erasure/{opaqueIds.e2e,erasure.resume.e2e,erasure.noPair.e2e}.pg.test.ts`, `chats/{golden.e2e,restart.e2e,visuals.e2e,startRatchet,e2eSupport,testHarness,testStack,messages}...`, `executionIds.test.ts`, `flows/ingest-document/flow.test.ts`, `erasure/wire.test.ts`, `db/chatSessions.pg.test.ts`, `chats/create.pg.test.ts`, and the tests named per task.

---

### Task 1: Migration 0039, the `ChatIds` resolver, the legacy rename (F3, F4; Decisions 1, 3, 4, 5)

**Files:**
- Create: `infra/migrations/0039_chat_id_format.sql`, `apps/server/app/chats/chatIds.ts`, `apps/server/app/chats/chatIds.test.ts`, `apps/server/app/chats/chatIds.pg.test.ts`, `apps/server/app/db/chatIdFormat.pg.test.ts`
- Modify: `apps/server/app/chats/ids.ts` (rename), `apps/server/app/chats/sessions.ts` (`id_format` in the row, `COLUMNS`, `insertChat`, `listChats`), `apps/server/app/subject.ts` (re-export), `apps/server/app/chats/testing.ts` (`fixedChatIds`), `apps/server/app/compose.ts` (build and expose `chatIds`; hand it to the eraser), `apps/server/app/erasure/wire.ts` (evict the resolver's cache of the user after the shred, I2), `apps/server/app/erasure/wire.test.ts`, every file that names `chatConversationId` (rename script)
- Test: the three new test files and `erasure/wire.test.ts`

**Interfaces:**
- Consumes: phase 1: `UserIds` (`conversation`, `chatTitle`, `turnVisualize`, `turnLineage`), `legacyIds`, `OpaqueIds` (`ensureUser`, `load`, `cached`), `existingUser` and `UserIdSource` (`documents/executionCandidates.ts`), `withTenant`, `ChatRef` (`chats/turnItems.ts`).
- Produces (later tasks rely on these exact names):
  - `type ChatIdFormat = "legacy" | "opaque"`.
  - `interface ChatIdBuilders { readonly format: ChatIdFormat; conversationId(): ChatConversationId; titleExecutionId(): UserExecutionId; turnExecutionId(ord: number, rerun?: number): UserExecutionId; turnExperienceId(ord: number): string }`.
  - `interface ChatIdResolver { forRow(who: ChatOwner, chat: { id: string; id_format: ChatIdFormat }): Promise<ChatIdBuilders | null>; forRef(ref: ChatRef): Promise<ChatIdBuilders | null>; forNew(who: ChatOwner, chatId: string): Promise<ChatIdBuilders>; forgetUser(userId: string): void }` with `ChatOwner = { tenantId: string; userId: string }`. `forgetUser` drops every format the resolver cached for that user (the eraser calls it after the shred, I2).
  - `legacyBuilders(userId, chatId)`, `opaqueBuilders(user: UserIds, chatId)`, `class PgChatIds implements ChatIdResolver` (constructor `(pool: Pool, ids: UserIdSource)`; its format cache is keyed `tenantId:userId:chatId`).
  - `ErasureParts.chatIds?: Pick<ChatIdResolver, "forgetUser">` (`erasure/wire.ts`): `forgetActivity` evicts the user from it.
  - `ChatSessionRow.id_format: ChatIdFormat`; `insertChat(tx, tenantId, userId, id, scope, idFormat: ChatIdFormat = "legacy")`.
  - `legacyChatConversationId(userId, chatId): ChatConversationId` (the old `chatConversationId`).
  - `fixedChatIds(format?, ids?)` in `chats/testing.ts`; `composed.chatIds: ChatIdResolver`.

- [ ] **Step 1: Write the failing migration test**

Create `apps/server/app/db/chatIdFormat.pg.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { T1, U1 } from "../documents/testHarness";
import { type PgFixture, startPgFixture } from "../flows/ingest-document/pgFixture";
import { PG_URL } from "./testSupport";

describe.skipIf(!PG_URL)("chat_sessions.id_format (0039) (needs DOCMIND_TEST_PG_URL)", () => {
  let fx: PgFixture;
  beforeAll(async () => {
    fx = await startPgFixture();
  });
  afterAll(async () => {
    await fx?.close();
  });

  it("is legacy for a row inserted without it (every chat that existed before 0039, and an old pod's insert)", async () => {
    const id = randomUUID();
    await fx.db.owner.query(
      "INSERT INTO chat_sessions (id, tenant_id, user_id) VALUES ($1, $2, $3)",
      [id, T1, U1],
    );
    const { rows } = await fx.db.owner.query("SELECT id_format FROM chat_sessions WHERE id = $1", [
      id,
    ]);
    expect(rows[0]).toEqual({ id_format: "legacy" });
  });

  it("accepts opaque and refuses any other value, by constraint name", async () => {
    const insert = (format: string) =>
      fx.db.owner.query(
        "INSERT INTO chat_sessions (id, tenant_id, user_id, id_format) VALUES ($1, $2, $3, $4)",
        [randomUUID(), T1, U1, format],
      );
    await insert("opaque");
    await expect(insert("h_")).rejects.toThrow(/chat_sessions_id_format_check/);
    await expect(insert("")).rejects.toThrow(/chat_sessions_id_format_check/);
  });

  it("cannot be null", async () => {
    await expect(
      fx.db.owner.query(
        "INSERT INTO chat_sessions (id, tenant_id, user_id, id_format) VALUES ($1, $2, $3, NULL)",
        [randomUUID(), T1, U1],
      ),
    ).rejects.toThrow(/null value in column "id_format"/);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `cd apps/server && set -a; . /Users/such/workspace/docmind/.env; set +a; pnpm exec vitest run app/db/chatIdFormat`
Expected: FAIL (`column "id_format" of relation "chat_sessions" does not exist`).

- [ ] **Step 3: Write the migration**

Create `infra/migrations/0039_chat_id_format.sql`:

```sql
-- 0039: the id format of a chat (R14 phase 2, docs/specs/2026-11-10-opaque-ids-design.md).
--
-- A chat's Loom ids (its conversation and every generation `~n`, its title execution, its turn visuals executions and its turn lineage
-- lines) are built by one of two formats: `legacy` (`u_<user>.c-<chat>`, the plain UUIDs every chat created before this migration used)
-- or `opaque` (`h_<H>.c-<C>`, keyed pseudonyms). The format cannot be derived from the chat's UUID, and one chat must never mix them, so it
-- is stored. Every row that exists now was created under the old format, which is exactly what the default says; the create route writes
-- `opaque` for a chat made after the deploy. A row inserted without the column (an old pod during a deploy, a test) is legacy, which is
-- what that code would have started. The column holds no id and nothing that links a chat to a handle.
--
-- A constant default is a metadata-only change (no table rewrite). Rolling back after the first `opaque` chat exists is not supported
-- (older code cannot parse its ids; see docs/operations/cloud-deploy.md).
ALTER TABLE chat_sessions
  ADD COLUMN id_format text NOT NULL DEFAULT 'legacy'
    CONSTRAINT chat_sessions_id_format_check CHECK (id_format IN ('legacy', 'opaque'));
```

- [ ] **Step 4: Run the migration test**

Run: `cd apps/server && set -a; . /Users/such/workspace/docmind/.env; set +a; pnpm exec vitest run app/db/chatIdFormat app/db/chatSessions app/db/migrate`
Expected: PASS.

- [ ] **Step 5: Write the failing resolver tests**

Create `apps/server/app/chats/chatIds.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deterministicUser } from "../opaqueIds/testing";
import { legacyBuilders, opaqueBuilders } from "./chatIds";

const U = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const C = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
const HANDLE_RE = /^[a-z2-7]{25}[aeimquy4]$/;
const TOKEN = "[a-z2-7]{51}[aq]";

describe("legacyBuilders", () => {
  const b = legacyBuilders(U, C);
  it("builds the four old shapes", () => {
    expect(b.format).toBe("legacy");
    expect(b.conversationId()).toBe(`u_${U}.c-${C}`);
    expect(b.titleExecutionId()).toBe(`u_${U}:chat-title-${C}`);
    expect(b.turnExecutionId(7)).toBe(`u_${U}:visualize-turn-${C}-7`);
    expect(b.turnExecutionId(7, 2)).toBe(`u_${U}:visualize-turn-${C}-7-r2`);
    expect(b.turnExperienceId(7)).toBe(`turnvisuals-${U}-${C}-7`);
  });
  it.each([
    ["an upper-case chat", () => legacyBuilders(U, C.toUpperCase()).conversationId()],
    ["a generation suffix", () => legacyBuilders(U, `${C}~1`).conversationId()],
    ["ord 0", () => legacyBuilders(U, C).turnExecutionId(0)],
    ["rerun 1000", () => legacyBuilders(U, C).turnExecutionId(7, 1000)],
  ])("refuses %s", (_name, build) => {
    expect(build).toThrow(RangeError);
  });
});

describe("opaqueBuilders", () => {
  const user = deterministicUser(U);
  const b = opaqueBuilders(user, C);
  it("builds the four new shapes: the handle and a 52-character token, no uuid", () => {
    expect(b.format).toBe("opaque");
    expect(user.handle).toMatch(HANDLE_RE);
    const conv = new RegExp(`^h_${user.handle}\\.c-${TOKEN}$`);
    expect(b.conversationId()).toMatch(conv);
    expect(b.titleExecutionId()).toMatch(new RegExp(`^h_${user.handle}:chat-title-${TOKEN}$`));
    expect(b.turnExecutionId(7)).toMatch(
      new RegExp(`^h_${user.handle}:visualize-turn-${TOKEN}-7$`),
    );
    expect(b.turnExecutionId(7, 2)).toMatch(
      new RegExp(`^h_${user.handle}:visualize-turn-${TOKEN}-7-r2$`),
    );
    expect(b.turnExperienceId(7)).toMatch(new RegExp(`^turnvisuals-${user.handle}-${TOKEN}-7$`));
    for (const id of [b.conversationId(), b.titleExecutionId(), b.turnExperienceId(7)]) {
      expect(id).not.toContain(U);
      expect(id).not.toContain(C);
    }
  });
  it("uses one token per chat in every family and is deterministic", () => {
    const token = (id: string) => new RegExp(TOKEN).exec(id)?.[0];
    expect(token(b.conversationId())).toBe(token(b.titleExecutionId()));
    expect(token(b.conversationId())).toBe(token(b.turnExecutionId(1)));
    expect(token(b.conversationId())).toBe(token(b.turnExperienceId(1)));
    expect(opaqueBuilders(user, C).conversationId()).toBe(b.conversationId());
  });
  it("is a valid Loom conversation id and a generation keeps it valid, under the byte limit", () => {
    expect(b.conversationId()).toHaveLength(83);
    expect(`${b.conversationId()}~999999999`).toHaveLength(93);
    for (const id of [b.conversationId(), b.titleExecutionId(), b.turnExecutionId(999_999_999_999_999, 999)])
      expect(Buffer.byteLength(id)).toBeLessThan(140);
  });
});
```

Create `apps/server/app/chats/chatIds.pg.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../db/tenant";
import { PG_URL } from "../db/testSupport";
import { T1, T2, U1, U2 } from "../documents/testHarness";
import { type PgFixture, startPgFixture } from "../flows/ingest-document/pgFixture";
import { OpaqueIds } from "../opaqueIds";
import { AutoHandleStore, DeterministicKeyStore, deterministicUser } from "../opaqueIds/testing";
import { PgChatIds } from "./chatIds";
import { insertChat } from "./sessions";

describe.skipIf(!PG_URL)("PgChatIds (needs DOCMIND_TEST_PG_URL)", () => {
  let fx: PgFixture;
  beforeAll(async () => {
    fx = await startPgFixture();
  });
  afterAll(async () => {
    await fx?.close();
  });
  const make = () => {
    const keys = new DeterministicKeyStore();
    const ids = new OpaqueIds(keys, new AutoHandleStore());
    return { keys, ids, chatIds: new PgChatIds(fx.app, ids) };
  };
  const chat = (tenant: string, user: string, format: "legacy" | "opaque") =>
    withTenant(fx.app, tenant, (tx) => insertChat(tx, tenant, user, randomUUID(), "all", format));

  it("builds the old ids for a legacy row and needs no key for it", async () => {
    const { chatIds, ids } = make();
    const row = await chat(T1, U1, "legacy");
    const b = await chatIds.forRow({ tenantId: T1, userId: U1 }, row);
    expect(b?.format).toBe("legacy");
    expect(b?.conversationId()).toBe(`u_${U1}.c-${row.id}`);
    expect(ids.cached(U1)).toBeUndefined(); // nothing was minted or loaded
  });

  it("builds the new ids for an opaque row, from the cached user, and never mints", async () => {
    const { chatIds, ids } = make();
    const row = await chat(T1, U1, "opaque");
    expect(await chatIds.forRow({ tenantId: T1, userId: U1 }, row)).toBeNull(); // no handle yet: a reader never mints
    await ids.ensureUser({ tenantId: T1, userId: U1 });
    const b = await chatIds.forRow({ tenantId: T1, userId: U1 }, row);
    expect(b?.conversationId()).toBe(deterministicUser(U1).conversation(row.id));
  });

  it("forRef reads the format from the row once, and answers null for a chat that is not the owner's", async () => {
    const { chatIds, ids } = make();
    await ids.ensureUser({ tenantId: T1, userId: U1 });
    const legacy = await chat(T1, U1, "legacy");
    const opaque = await chat(T1, U1, "opaque");
    const ref = (c: { id: string }, tenantId = T1, userId = U1) => ({
      tenantId,
      userId,
      chatId: c.id,
    });
    expect((await chatIds.forRef(ref(legacy)))?.format).toBe("legacy");
    expect((await chatIds.forRef(ref(opaque)))?.format).toBe("opaque");
    expect(await chatIds.forRef({ tenantId: T1, userId: U1, chatId: randomUUID() })).toBeNull();
    // another user, another tenant: the same answer as an unknown chat
    expect(await chatIds.forRef(ref(legacy, T1, U2))).toBeNull();
    expect(await chatIds.forRef(ref(legacy, T2, U1))).toBeNull();
  });

  it("keys its format cache by tenant too: a hit for (T1, U1) does not answer for (T2, U1)", async () => {
    const { chatIds } = make();
    const row = await chat(T1, U1, "legacy");
    expect((await chatIds.forRef({ tenantId: T1, userId: U1, chatId: row.id }))?.format).toBe("legacy"); // fills the cache
    expect(await chatIds.forRef({ tenantId: T2, userId: U1, chatId: row.id })).toBeNull(); // not a cache hit
  });

  it("forgetUser drops a user's cached formats: a cached answer may outlive a deleted row for one process, and no longer after the eraser forgets the user", async () => {
    const { chatIds } = make();
    const mine = await chat(T1, U1, "legacy");
    const theirs = await chat(T1, U2, "legacy");
    const ref = (c: { id: string }, userId: string) => ({ tenantId: T1, userId, chatId: c.id });
    expect((await chatIds.forRef(ref(mine, U1)))?.format).toBe("legacy");
    expect((await chatIds.forRef(ref(theirs, U2)))?.format).toBe("legacy");
    await fx.db.owner.query("DELETE FROM chat_sessions WHERE id = ANY($1)", [[mine.id, theirs.id]]);
    expect((await chatIds.forRef(ref(mine, U1)))?.format).toBe("legacy"); // cached: the row is gone, the answer stays
    chatIds.forgetUser(U1);
    expect(await chatIds.forRef(ref(mine, U1))).toBeNull(); // forgotten: asks the database, finds nothing
    expect((await chatIds.forRef(ref(theirs, U2)))?.format).toBe("legacy"); // another user's entry is untouched
  });

  it("answers null for an opaque chat whose owner's key is destroyed, and the legacy chat of that owner still builds", async () => {
    const { chatIds, ids, keys } = make();
    await ids.ensureUser({ tenantId: T1, userId: U1 });
    const opaque = await chat(T1, U1, "opaque");
    const legacy = await chat(T1, U1, "legacy");
    ids.forgetSubject(`h_${deterministicUser(U1).handle}`); // what the eraser does: evicts the handle's entry and its user's
    await keys.destroy(U1);
    const who = { tenantId: T1, userId: U1 };
    expect(await chatIds.forRow(who, opaque)).toBeNull();
    expect((await chatIds.forRow(who, legacy))?.conversationId()).toBe(`u_${U1}.c-${legacy.id}`);
  });

  it("forNew mints the handle and builds a new-format id", async () => {
    const { chatIds, ids } = make();
    const id = randomUUID();
    const b = await chatIds.forNew({ tenantId: T1, userId: U2 }, id);
    expect(b.format).toBe("opaque");
    expect(ids.cached(U2)?.handle).toBe(deterministicUser(U2).handle);
    expect(b.conversationId()).toBe(deterministicUser(U2).conversation(id));
  });
});
```

Append to `apps/server/app/erasure/wire.test.ts` inside its `describe("erasureDeps", ...)` (it already has `parts`, `USER`; I2):

```ts
  it("evicts the chat id resolver's memory of the user whenever the user's chat activity is forgotten, even if that throws", async () => {
    const forgotten: string[] = [];
    const chatIds = { forgetUser: (userId: string) => void forgotten.push(userId) };
    await erasureDeps(parts({ chatIds }).parts).forgetActivity(USER, "h");
    expect(forgotten).toEqual([USER]);
    const failing = parts({
      chatIds,
      activity: {
        forgetUser: async () => {
          throw new Error("down");
        },
      },
    }).parts;
    await expect(erasureDeps(failing).forgetActivity(USER)).rejects.toThrow("down");
    expect(forgotten).toEqual([USER, USER]); // a retried step evicts again
  });

  it("forgets no chat ids when the resolver is not wired", async () => {
    await expect(erasureDeps(parts().parts).forgetActivity(USER, null)).resolves.toBe(0); // the activity port's own answer, no resolver involved
  });
```

- [ ] **Step 6: Run the resolver tests to see them fail**

Run: `cd apps/server && set -a; . /Users/such/workspace/docmind/.env; set +a; pnpm exec vitest run app/chats/chatIds app/erasure/wire`
Expected: FAIL (module `./chatIds` not found; `ErasureParts` has no `chatIds`, so `forgetActivity` evicts nothing).

- [ ] **Step 7: Rename the legacy builder everywhere**

In `apps/server/app/chats/ids.ts` rename the function and its doc (the body is unchanged; it keeps the canonical check):

```ts
/**
 * The OLD-format Loom conversation id of a chat, `u_<user>.c-<chat>`: what every chat created before phase 2 runs under, and what
 * `ChatIds` (`chats/chatIds.ts`) builds for a chat whose `id_format` is `legacy`. Production code gets a chat's ids from the resolver, never
 * from here. Loom ids may not contain a colon, so the `u_<uuid>:` form is not available.
 */
export function legacyChatConversationId(userId: string, chatId: string): ChatConversationId {
```

Then run from `apps/server/app` (idempotent):

```bash
python3 - <<'PY'
import re, subprocess
files = subprocess.check_output("grep -rlw 'chatConversationId' . || true", shell=True, text=True).split()
for f in files:
    s = open(f).read()
    s2 = re.sub(r'\bchatConversationId\b', 'legacyChatConversationId', s)
    if s2 != s:
        open(f, "w").write(s2)
print(len(files), "files")
PY
cd .. && pnpm exec biome check --write app
```

`subject.ts` re-exports the renamed name, so tests importing it from `../subject` keep working. Expected: about 45 files change, only in imports and call sites.

- [ ] **Step 8: Write the migration's consumers (`sessions.ts`)**

In `apps/server/app/chats/sessions.ts`:

```ts
import type { ChatIdFormat } from "./chatIds";

export interface ChatSessionRow {
  id: string;
  title_enc: unknown | null;
  title_source: "none" | "auto" | "user";
  scope: ChatScope;
  /** Which id format all of this chat's Loom ids use (migration 0039): fixed at creation, never changed. */
  id_format: ChatIdFormat;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

const COLUMNS = "id, title_enc, title_source, scope, id_format, created_at, updated_at, deleted_at";
```

`insertChat` gets the parameter and writes it:

```ts
export async function insertChat(
  tx: PoolClient,
  tenantId: string,
  userId: string,
  id: string,
  scope: ChatScope,
  /** `"opaque"` from the create route; a row without it is `legacy`, the column default (Decision 5). */
  idFormat: ChatIdFormat = "legacy",
): Promise<ChatSessionRow> {
  const { rows } = await tx.query<ChatSessionRow>(
    `INSERT INTO chat_sessions (id, tenant_id, user_id, scope, id_format) VALUES ($1, $2, $3, $4::jsonb, $5)
     RETURNING ${COLUMNS}`,
    [id, tenantId, userId, JSON.stringify(scope), idFormat],
  );
  return checked(rows[0] as ChatSessionRow);
}
```

and in `listChats` the select list becomes `SELECT c.id, c.title_enc, c.title_source, c.scope, c.id_format, c.created_at, ...` (add `c.id_format` after `c.scope`).

- [ ] **Step 9: Write `chats/chatIds.ts`**

```ts
import type { Pool } from "pg";
import { withTenant } from "../db/tenant";
import { type UserIdSource, existingUser } from "../documents/executionCandidates";
import {
  type ChatConversationId,
  type UserExecutionId,
  type UserIds,
  legacyIds,
} from "../opaqueIds";
import { legacyChatConversationId } from "./ids";
import type { ChatRef } from "./turnItems";

/** The id format of one chat (`chat_sessions.id_format`, migration 0039): fixed when the chat is created. */
export type ChatIdFormat = "legacy" | "opaque";

export interface ChatOwner {
  tenantId: string;
  userId: string;
}

/**
 * Every Loom id one chat has, in the chat's own format. All four come from one format, so a chat never mixes them: its conversation (and its
 * generations `~n`, which Loom derives from this id), its title execution, a turn's visuals execution and that turn's lineage line.
 */
export interface ChatIdBuilders {
  readonly format: ChatIdFormat;
  conversationId(): ChatConversationId;
  titleExecutionId(): UserExecutionId;
  /** `rerun` makes `-r<n>`, an on-demand run (1 to 999). */
  turnExecutionId(ord: number, rerun?: number): UserExecutionId;
  turnExperienceId(ord: number): string;
}

export interface ChatIdResolver {
  /** The builders of a chat the caller has loaded (its row carries the format). Null: an opaque chat whose owner has no live id key (erased, or never given one). Never mints. */
  forRow(who: ChatOwner, chat: { id: string; id_format: ChatIdFormat }): Promise<ChatIdBuilders | null>;
  /** The builders of a chat the caller only has a reference to: reads the format. Null when the chat row is not found for this owner (a cached answer may outlive a deleted row for one process), or as `forRow`. Never mints. */
  forRef(ref: ChatRef): Promise<ChatIdBuilders | null>;
  /** The builders of a chat about to be created: always the new format, minting the user's key and handle on their first use. A key-store outage throws. */
  forNew(who: ChatOwner, chatId: string): Promise<ChatIdBuilders>;
  /** Drops everything remembered about a user's chats (the eraser calls it after the shred, so a cached answer cannot outlive the user's rows). Never throws. */
  forgetUser(userId: string): void;
}

export const legacyBuilders = (userId: string, chatId: string): ChatIdBuilders => ({
  format: "legacy",
  conversationId: () => legacyChatConversationId(userId, chatId),
  titleExecutionId: () => legacyIds.chatTitle(userId, chatId),
  turnExecutionId: (ord, rerun) => legacyIds.turnVisualize(userId, chatId, ord, rerun),
  turnExperienceId: (ord) => legacyIds.turnLineage(userId, chatId, ord),
});

export const opaqueBuilders = (user: UserIds, chatId: string): ChatIdBuilders => ({
  format: "opaque",
  conversationId: () => user.conversation(chatId),
  titleExecutionId: () => user.chatTitle(chatId),
  turnExecutionId: (ord, rerun) => user.turnVisualize(chatId, ord, rerun),
  turnExperienceId: (ord) => user.turnLineage(chatId, ord),
});

const FORMAT_CACHE_MAX = 5000;

/**
 * The Postgres resolver. A chat's format never changes, so a found format is cached (bounded, oldest first out), keyed by tenant, user and
 * chat; a missing chat is never cached. The cache holds ids of people, so `forgetUser` evicts a user's entries when they are erased.
 */
export class PgChatIds implements ChatIdResolver {
  private readonly formats = new Map<string, ChatIdFormat>();

  constructor(
    private readonly pool: Pool,
    private readonly ids: UserIdSource,
  ) {}

  /** `tenant:user:chat` (UUIDs hold no colon, so `forgetUser` can read the user back from the key). */
  private key(ref: { tenantId: string; userId: string }, chatId: string): string {
    return `${ref.tenantId}:${ref.userId}:${chatId}`;
  }

  private remember(key: string, format: ChatIdFormat): void {
    this.formats.delete(key);
    if (this.formats.size >= FORMAT_CACHE_MAX) {
      const oldest = this.formats.keys().next().value;
      if (oldest !== undefined) this.formats.delete(oldest);
    }
    this.formats.set(key, format);
  }

  private async build(
    who: ChatOwner,
    chatId: string,
    format: ChatIdFormat,
  ): Promise<ChatIdBuilders | null> {
    if (format === "legacy") return legacyBuilders(who.userId, chatId);
    const user = await existingUser(this.ids, who);
    return user ? opaqueBuilders(user, chatId) : null;
  }

  async forRow(
    who: ChatOwner,
    chat: { id: string; id_format: ChatIdFormat },
  ): Promise<ChatIdBuilders | null> {
    this.remember(this.key(who, chat.id), chat.id_format);
    return this.build(who, chat.id, chat.id_format);
  }

  async forRef(ref: ChatRef): Promise<ChatIdBuilders | null> {
    const key = this.key(ref, ref.chatId);
    let format = this.formats.get(key);
    if (format === undefined) {
      const row = await withTenant(this.pool, ref.tenantId, async (tx) =>
        (
          await tx.query<{ id_format: ChatIdFormat }>(
            "SELECT id_format FROM chat_sessions WHERE id = $1 AND user_id = $2",
            [ref.chatId, ref.userId],
          )
        ).rows[0],
      );
      if (!row) return null;
      format = row.id_format;
      this.remember(key, format);
    }
    return this.build(ref, ref.chatId, format);
  }

  async forNew(who: ChatOwner, chatId: string): Promise<ChatIdBuilders> {
    return opaqueBuilders(await this.ids.ensureUser(who), chatId);
  }

  forgetUser(userId: string): void {
    for (const key of [...this.formats.keys()]) if (key.split(":")[1] === userId) this.formats.delete(key);
  }
}
```

(The query deliberately has no `deleted_at` predicate: a deleted chat's turn runs, title and erasure still need its ids.)

- [ ] **Step 10: Add the test resolver, wire the resolver into `compose.ts` and the eviction into the eraser**

Append to `apps/server/app/chats/testing.ts` (add the imports it needs: `ChatIdFormat`, `ChatIdResolver`, `legacyBuilders`, `opaqueBuilders` from `./chatIds`, `UserIdSource` from `../documents/executionCandidates`, `existingUser` likewise):

```ts
/**
 * A resolver with no database: `format` decides per chat (default legacy, what every existing test assumes), `forRow` trusts the row, and an
 * opaque chat needs `ids`. For unit tests that pass a resolver to a route, a starter or a step.
 */
export function fixedChatIds(
  format: (userId: string, chatId: string) => ChatIdFormat = () => "legacy",
  ids?: UserIdSource,
): ChatIdResolver {
  const build = async (who: { tenantId: string; userId: string }, chatId: string, f: ChatIdFormat) => {
    if (f === "legacy") return legacyBuilders(who.userId, chatId);
    const user = ids && (await existingUser(ids, who));
    return user ? opaqueBuilders(user, chatId) : null;
  };
  return {
    forRow: (who, chat) => build(who, chat.id, chat.id_format),
    forRef: (ref) => build(ref, ref.chatId, format(ref.userId, ref.chatId)),
    forNew: async (who, chatId) => {
      if (!ids) throw new Error("fixedChatIds: forNew needs an id source");
      return opaqueBuilders(await ids.ensureUser(who), chatId);
    },
    forgetUser: () => {},
  };
}
```

In `apps/server/app/compose.ts`, import `PgChatIds` and, right after `const ids = options.ids ?? new OpaqueIds(...)` (line ~184) add `const chatIds = new PgChatIds(pool, ids);`; add `/** Builds a chat's Loom ids in the chat's own format (migration 0039). */ chatIds,` to the returned object next to `ids` (line ~638), and pass `chatIds` to the `erasureDeps({ ... })` call (next to `ids,`, line ~490). Nothing else uses it yet.

The eviction (I2). The resolver's format cache holds `tenant:user:chat` keys, and `ids.forgetSubject` (called in `erasure/wire.ts` `eraseSubject` and `keys.destroy`) only knows a subject, never the user's UUID, so the eviction hangs on the one eraser hook that is keyed by user and runs after the shred: `forgetActivity(userId, handle)` (the Eraser calls it in the `readModels` step and again in `rows`, both after the `shred` step). In `apps/server/app/erasure/wire.ts` add `import type { ChatIdResolver } from "../chats/chatIds";`, add to `ErasureParts` after `ids?`:

```ts
  /** The chat id resolver: its cached chat formats name a user's chats, so the user is evicted from it after the shred (a late `forRef` must ask the database, which no longer has the rows). Absent: nothing to evict. */
  chatIds?: Pick<ChatIdResolver, "forgetUser">;
```

and replace the `forgetActivity` line of `erasureDeps` with:

```ts
    forgetActivity: async (userId, handle) => {
      try {
        return await p.activity.forgetUser(userId, handle);
      } finally {
        // After the shred and the activity tombstones, and even if they threw (the step is retried and evicts again).
        p.chatIds?.forgetUser(userId);
      }
    },
```

- [ ] **Step 11: Run the tests, typecheck, lint, commit**

Run: `cd apps/server && set -a; . /Users/such/workspace/docmind/.env; set +a; pnpm exec vitest run app/chats/chatIds app/erasure/wire app/db app/chats/ids app/chats/sessions app/chats/startRatchet`
Expected: PASS. Then `cd ../.. && pnpm exec biome check --write apps/server/app && pnpm typecheck && pnpm typecheck:tests && pnpm lint` (no errors), and the focused suites that touch the rename: `cd apps/server && set -a; . /Users/such/workspace/docmind/.env; set +a; pnpm exec vitest run app/chats app/erasure app/flows/chat-title app/flows/visualize-turn` (all pass: nothing changed behaviour).

```bash
git add infra/migrations/0039_chat_id_format.sql apps/server/app
git commit -m "feat(ids): a chat's id format is stored (0039) and a resolver builds its ids; rename the legacy conversation builder"
```

(append the two trailers)

---

### Task 2: Seal the conversation's owner and sender ids (F5; Spec amendment B)

**Files:**
- Modify: `apps/server/app/sensitive.ts`, `apps/server/app/sensitive.test.ts`, `apps/server/app/flows/ingest-document/flow.test.ts`
- Create: `apps/server/app/chats/sealedIds.pg.test.ts`

**Interfaces:**
- Consumes: `SENSITIVE_EVENT_PATHS` (`sensitive.ts`), the chat test stack `startIngestStack({ chat: true })`.
- Produces: `EXECUTION_STARTED` seals `input.owner`; `MESSAGE_CONSUMED` seals `sender` (`INBOX_MESSAGE.sender` is already sealed by Loom and is not registered). Applies to every conversation (legacy included) from now on.

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/app/sensitive.test.ts` (inside its top-level `describe`, or as a new one; the file already imports `SENSITIVE_EVENT_PATHS`):

```ts
describe("the conversation's own ids (R14 phase 2)", () => {
  it("seals the owner of a conversation's start and the sender of its consumed messages", () => {
    expect(SENSITIVE_EVENT_PATHS.EXECUTION_STARTED).toContain("input.owner");
    expect(SENSITIVE_EVENT_PATHS.MESSAGE_CONSUMED).toEqual(["sender"]);
    // The inbox copy of the sender is sealed by Loom itself (sender-handle sealing, ADR 0139 N6): registering it would double-seal it.
    expect(SENSITIVE_EVENT_PATHS.INBOX_MESSAGE).toBeUndefined();
  });
});
```

Create `apps/server/app/chats/sealedIds.pg.test.ts`:

```ts
import { rmSync } from "node:fs";
import { ChatSessionDto } from "@docmind/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { PG_URL } from "../db/testSupport";
import { type IngestStack, startIngestStack } from "../documents/ingestStack";
import { collectUntil, isReply, scriptChat } from "./e2eSupport";

const isEnvelope = (v: unknown) => (v as { __loomEnc?: unknown } | null)?.__loomEnc === "loom/aes-256-gcm";

describe.skipIf(!PG_URL)("a conversation's log holds no plain owner or sender (needs DOCMIND_TEST_PG_URL)", () => {
  let st: IngestStack | undefined;
  afterAll(async () => {
    await st?.close({ keepDb: true });
    await st?.db.drop();
    if (st) rmSync(st.root, { recursive: true, force: true });
  });

  it("seals input.owner and sender, and the decrypting store still reads them", async () => {
    st = await startIngestStack({ chat: true });
    const claude = st.claude;
    if (!claude) throw new Error("no fake Claude");
    const who = await st.signUpAndLogIn("sealed@example.com");
    scriptChat(claude, () => ({ stream: { steps: [{ text: "Hello." }, { stop: "end_turn" }] } }));
    const chat = ChatSessionDto.parse(
      await (await st.chatReq(who.cookie, "POST", "/api/chats", {})).json(),
    );
    const stream = await st.openChat(who.cookie, chat.id);
    try {
      const sent = await st.chatReq(who.cookie, "POST", `/api/chats/${chat.id}/messages`, {
        text: "Hi",
      });
      expect(sent.status).toBe(202);
      await collectUntil(stream, isReply);
    } finally {
      stream.close();
    }
    const all = (await st.durable.raw.eventStore.listExecutions?.()) ?? [];
    const conversation = all.find((id) => id.includes(".c-") && !id.includes("::") && !id.startsWith("__loom"));
    expect(conversation).toBeDefined();
    const raw = await st.durable.raw.eventStore.read(conversation as string);
    const started = raw.find((e) => e.eventType === "EXECUTION_STARTED");
    const consumed = raw.filter((e) => e.eventType === "MESSAGE_CONSUMED");
    expect(consumed.length).toBeGreaterThan(0); // the control: the events the claim is about exist
    expect(isEnvelope((started?.payload as { input?: { owner?: unknown } }).input?.owner)).toBe(true);
    for (const e of consumed) expect(isEnvelope((e.payload as { sender?: unknown }).sender)).toBe(true);
    // The payloads hold neither the user's nor the tenant's id outside a sealed envelope. Only the payloads are judged: the envelope's
    // `executionId` is `u_<user>.c-<chat>` until Task 4 flips the chat builders, and is judged by the Task 4 and 5 tests.
    const plain = JSON.stringify(
      [started?.payload, ...consumed.map((e) => e.payload)],
      (_k, v) => (isEnvelope(v) ? "sealed" : v),
    );
    expect(plain).not.toContain(who.userId);
    expect(plain).not.toContain(who.tenantId);
    // the owner's own key still opens them, as Loom needs
    const opened = await st.durable.sealed.eventStore.read(conversation as string);
    const openedStart = opened.find((e) => e.eventType === "EXECUTION_STARTED");
    expect((openedStart?.payload as { input: { owner: { actor: string } } }).input.owner.actor).toBe(
      who.userId,
    );
  }, 120_000);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd apps/server && set -a; . /Users/such/workspace/docmind/.env; set +a; pnpm exec vitest run app/sensitive app/chats/sealedIds`
Expected: FAIL (`input.owner` not in the list; the owner is a plain object).

- [ ] **Step 3: Register the paths**

In `apps/server/app/sensitive.ts`, in `SENSITIVE_EVENT_PATHS`, add `"input.owner",` to `EXECUTION_STARTED` (before `...FLOW_INPUT_IDS`) and one entry after it:

```ts
  EXECUTION_STARTED: [
    "input.turns[].user",
    "input.turns[].assistant",
    "input.summary",
    "input.pending",
    // The conversation's own owner identity (`{ actor, tenant }`: the user and tenant UUIDs). Loom does not seal it with `principal`, and
    // beside an `h_<H>` execution id it would link the erased handle to the user for good (R14 phase 2).
    "input.owner",
    ...FLOW_INPUT_IDS,
  ],
  // The sender of a consumed conversation message is its owner's identity too: the same `{ actor, tenant }`. Loom seals only this event's
  // `payload`. (`INBOX_MESSAGE.sender` is not listed: Loom already seals it under the sender subject, ADR 0139 N6.)
  MESSAGE_CONSUMED: ["sender"],
```

and add a sentence to the rules comment above the map: `*  - the conversation's own owner and sender identities are ids too and are sealed (EXECUTION_STARTED.input.owner, MESSAGE_CONSUMED.sender), for the same reason as FLOW_INPUT_IDS;`.

- [ ] **Step 4: Update the test that pins the exact map**

In `apps/server/app/flows/ingest-document/flow.test.ts` find the test "ingest marks nothing; the map holds only the conversation event types" (`grep -n "holds only the conversation event types" apps/server/app/flows/ingest-document/flow.test.ts`) and add `"MESSAGE_CONSUMED"` (only that one; it sorts after `"LLM_REASONING_CAPTURED"` and before `"STEP_COMPLETED"`) to the sorted array of event types it expects.

- [ ] **Step 5: Run the tests, then the suites that read conversations**

Run: `cd apps/server && set -a; . /Users/such/workspace/docmind/.env; set +a; pnpm exec vitest run app/sensitive app/chats app/flows/ingest-document/flow app/erasure`
Expected: PASS. If an erasure or log-proof test fails because a legacy chat's NEW events are now sealed where a test expected a plaintext `sender`, fix that test's expectation (a sealed `sender` is the new rule); do not weaken `sensitive.ts`.

- [ ] **Step 6: Typecheck, lint, commit**

Run: `pnpm exec biome check --write apps/server/app && pnpm typecheck && pnpm typecheck:tests && pnpm lint`

```bash
git add apps/server/app
git commit -m "feat(ids): seal a conversation's owner and sender identities in the event log"
```

(append the two trailers)

---

### Task 3: Make the erasure harness format-agnostic and pin the tests that need a `u_` chat (F6, F8; Decision 7)

**Files:**
- Modify: `apps/server/app/erasure/e2eSupport.ts`, `apps/server/app/chats/e2eSupport.ts` (add `createLegacyChat`), `apps/server/app/erasure/{erasure.resume.e2e,erasure.noPair.e2e,opaqueIds.e2e}.pg.test.ts`, `apps/server/app/chats/golden.e2e.pg.test.ts`
- Test: those files (they are the tests); every e2e must stay GREEN in this task, before the flip

**Interfaces:**
- Consumes: Task 1 (`insertChat(..., "legacy")`, `legacyChatConversationId`, `composed.chat.conversations`).
- Produces: `createLegacyChat(st, who): Promise<ChatSessionDto>` (`chats/e2eSupport.ts`); `seedUser(st, who, email, opts?: { chat?: "legacy" })`; `Seeded.chatFormat: "legacy" | "opaque"` (read from the chat row, so it is right on both sides of the flip) and `Seeded.moreChatIds?: string[]`; `Who.legacyChats?: boolean`.

- [ ] **Step 1: Add `createLegacyChat`**

Append to `apps/server/app/chats/e2eSupport.ts` (add the imports `randomUUID` from `node:crypto`, `ChatSessionDto` from `@docmind/contracts`, `withTenant` from `../db/tenant`, `IngestStack` type from `../documents/ingestStack`, `insertChat` from `./sessions`, `legacyChatConversationId` from `./ids`; check for an import cycle with `ingestStack` by using `import type`):

```ts
/**
 * A chat made the way every chat before phase 2 was: a row with `id_format = 'legacy'` and a Loom conversation `u_<user>.c-<chat>`. The chat
 * API makes new-format chats now, so a test that needs an old one (an upgrade, a mixed history, a `u_` subject that owns a running turn)
 * starts it here; every route then reads its format from the row and carries on in it.
 */
export async function createLegacyChat(
  st: IngestStack,
  who: { cookie: string; userId: string; tenantId: string },
): Promise<ChatSessionDto> {
  const id = randomUUID();
  await withTenant(st.app, who.tenantId, (tx) =>
    insertChat(tx, who.tenantId, who.userId, id, "all", "legacy"),
  );
  if (!st.composed.chat) throw new Error("the stack has no chat");
  await st.composed.chat.conversations.start({
    conversationId: legacyChatConversationId(who.userId, id),
    principal: { tenant: who.tenantId, actor: who.userId },
  });
  return ChatSessionDto.parse(await (await st.chatReq(who.cookie, "GET", `/api/chats/${id}`)).json());
}
```

(If `st.app` is not the app-role pool name in this repo, use the one `PgDocumentResults(st.app, st.fields)` in `opaqueIds.e2e.pg.test.ts` already uses: it is `st.app`.)

- [ ] **Step 2: Make `seedUser` and `Seeded` format-aware**

In `apps/server/app/erasure/e2eSupport.ts`:

```ts
export interface Seeded {
  // ...existing fields...
  chatId: string;
  /** Which id format the seeded chat runs under, read from its row (so it is right whatever the create route does). */
  chatFormat: "legacy" | "opaque";
  /** Chats a test added after seeding, for the scan's needles and the linking check. */
  moreChatIds?: string[];
```

Change the signature to `seedUser(st, who, email, opts: { chat?: "legacy" } = {})`, replace the chat creation (`const chat = ChatSessionDto.parse(await (await st.chatReq(who.cookie, "POST", "/api/chats", {})).json());`) with:

```ts
  const chat =
    opts.chat === "legacy"
      ? await createLegacyChat(st, who)
      : ChatSessionDto.parse(await (await st.chatReq(who.cookie, "POST", "/api/chats", {})).json());
  const chatFormat = (
    await st.db.owner.query("SELECT id_format FROM chat_sessions WHERE id = $1", [chat.id])
  ).rows[0].id_format as "legacy" | "opaque";
```

and add `chatFormat,` to the returned object (next to `chatId: chat.id`). Import `createLegacyChat` from `../chats/e2eSupport`.

`needlesOf` gets the extra chats: `gone.chatId,` becomes `gone.chatId, ...(gone.moreChatIds ?? []),`. In `assertErased`'s step 3c list add `...(user.moreChatIds ?? [])` after `user.chatId`.

- [ ] **Step 3: The harness edits (each is a no-op for today's legacy chats)**

(a) The nil UUID. Above `leafOk` declare `const NIL_UUID = "00000000-0000-0000-0000-000000000000";` and change the guard to ignore it (the chat's fixed system prompt cites it as an example; it cannot be anyone's id):

```ts
const leafOk = (key: string, value: string, handle: string | undefined, opaque: boolean): boolean =>
  !(opaque && ANY_UUID.test(value.replaceAll(NIL_UUID, ""))) &&
  checkFor(key, handle, opaque)?.test(value) === true;
```

(b) Which executions name the user. Add next to `isUserExecution`:

```ts
/** Whether an execution names the user: the UUID (an old-format id, its inbox stream, its lineage line) or, for a new-format id, the handle (`h_<H>...`, `__loom_inbox__:h_<H>.c-...`). A new-format lineage line is judged on its own (`line-erased`), not here. */
const namesUser = (id: string, userId: string, handle: string | undefined): boolean =>
  id.includes(userId) ||
  (handle !== undefined && !id.startsWith("__loom_ui_lineage__:") && id.includes(handle));
```

and in `assertLogUnreadable` use it in both places: the `.filter((id) => namesUser(id, gone.userId, handle))` that builds `ids`, and the per-id `expect(namesUser(id, gone.userId, handle)).toBe(true)` (replacing `id.includes(gone.userId) || (handle !== undefined && id.startsWith(...))`). But the loop's `ids` also contains `gone.executions` unfiltered; filter those the same way: `...gone.executions.filter((id) => !id.startsWith("__loom_ui_lineage__:") || id.includes(gone.userId))`.

(c) The tombstones by format. Replace the block under `// 2. The read models` (the `u_` query and its `expect(...).toEqual(["chat-activity", "ingest-status"])`) with:

```ts
    const tomb = await db.owner.query(
      "SELECT DISTINCT model_id FROM read_model_state WHERE starts_with(execution_id, $1) AND erased AND state IS NULL",
      [`u_${user.userId}`],
    );
    // A legacy chat leaves both models' tombstones under `u_<user>` (its conversation and its title); a new chat leaves none there.
    expect(tomb.rows.map((r) => r.model_id).sort()).toEqual(
      user.chatFormat === "legacy" || user.moreChatIds !== undefined
        ? ["chat-activity", "ingest-status"]
        : [],
    );
```

(`moreChatIds !== undefined` marks a mixed user, who has a legacy chat plus others.) In the `if (who.handle !== undefined)` block that follows add, after the existing `ingest-status` assertion:

```ts
      // A new chat's activity row sits under the handle. A mixed user (`moreChatIds`) has a new chat beside the legacy one.
      const hasOpaqueChat = user.chatFormat === "opaque" || user.moreChatIds !== undefined;
      expect(hRows.rows.some((r) => r.model_id === "chat-activity")).toBe(hasOpaqueChat);
```

(d) The one chat entry of `ALLOWED` (F8). `Who` gets `legacyChats?: boolean` ("the user has a chat under the old format: its turn visuals lineage names the user"), `assertErased` sets `legacyChats: user.chatFormat === "legacy" || user.moreChatIds !== undefined` when building `who`, and the entry becomes:

```ts
  // O7 (spec section 6): a LEGACY chat's turn visuals lineage line is old-format (`__loom_ui_lineage__:turnvisuals-<user>-<chat>-<ord>`),
  // so its plaintext id names the user and the chat. Its content is sealed under the destroyed key; here only that the row is the user's
  // own line, with a sealed author and no content. It applies only to a user who has a legacy chat: for a user with new chats only, the
  // same row fails the scan.
  ...["id", "execution_id", "payload"].map((column) => ({
    table: "loom.events",
    column,
    reason:
      "O7: the old-format id of a legacy chat's turn visuals lineage; author sealed, no content",
    ok: (row: Row, who: Who) =>
      who.legacyChats === true &&
      typeof row.execution_id === "string" &&
      row.execution_id.startsWith(`__loom_ui_lineage__:turnvisuals-${who.userId}-`) &&
      sealed((row.payload as { by?: unknown } | null)?.by) &&
      payloadIsIdsOnly(row.payload, "", undefined, true) &&
      noContent(row, who),
  })),
```

- [ ] **Step 4: Pin the tests that need a `u_` chat**

Pin exactly these `seedUser` calls (each becomes `seedUser(first, login, email, { chat: "legacy" })` with the comment `// the user's UUID subject must own a running turn: an old chat`; the argument names are the file's own):

- `erasure.resume.e2e.pg.test.ts`: line 55 (`eve`) and line 200 (`const user = await seedUser(st, login, email)` inside `parkedErasure`). Not line 112 (`gus`: that test expects the handle subject to own every run, "the user's UUID subject owns none").
- `erasure.noPair.e2e.pg.test.ts`: line 55 (`ida`).
- `opaqueIds.e2e.pg.test.ts`: line 205, the SECOND test (`opaque@example.com`, the one with the `u_` assertion at line 296 and the suggest-tags run after a cold restart). Not line 102 (`hana@example.com`, the first test, which hangs the summary model).
- `golden.e2e.pg.test.ts` (line ~246, the expected subject set `[ada.userId, handleSubject]`): create that test's chat with `createLegacyChat(st, ada)` instead of `POST /api/chats` and use the returned `id`.

- [ ] **Step 5: Run the erasure and chat e2e suites (still the old behaviour)**

Run: `cd apps/server && set -a; . /Users/such/workspace/docmind/.env; set +a; pnpm exec vitest run app/erasure app/chats/golden app/chats/restart app/flows/chat-title`
Expected: PASS (every chat is legacy; the harness now derives that from the row).

- [ ] **Step 6: Typecheck, lint, commit**

Run: `pnpm exec biome check --write apps/server/app && pnpm typecheck && pnpm typecheck:tests && pnpm lint`

```bash
git add apps/server/app
git commit -m "test(ids): the erasure harness reads a chat's id format and takes a legacy chat on request"
```

(append the two trailers)

---

### Task 4: Flip the chat builders: routes, title, turn visuals, lineage (O7, F1, F4, F10; Decisions 2, 3, 4)

**Files:**
- Modify (production): `apps/server/app/chats/{access,routes,messages,messageRoutes,reasoningRoutes,stream,manageRoutes,turnHeads}.ts`, `apps/server/app/flows/visualize-turn/{ids,start,commit,readTurn,testing}.ts`, `apps/server/app/flows/chat-title/{start,step}.ts`, `apps/server/app/ui/routes.ts`, `apps/server/app/compose.ts`
- Modify (tests and support): `chats/{startRatchet.test,testHarness,testStack,messages.test,turnHeads.test,create.pg.test,restart.e2e.pg}`, `flows/visualize-turn/{start,commit,readTurn,ids,flow,trigger,compose}.test.ts`, `flows/chat-title/{start.test,step.pg.test,flow.pg.test,compose.pg.test}`, `ui/routes.test.ts`, `storage/lineageGc.pg.test.ts`, `flows/visualize-document/lineage.test.ts`
- Test: as listed per step

**Interfaces:**
- Consumes: Task 1 (`ChatIdResolver`, `PgChatIds`, `fixedChatIds`, `composed.chatIds`, `ChatSessionRow.id_format`).
- Produces: a chat created through `POST /api/chats` is `opaque`; every id of an `opaque` chat is new-format and of a `legacy` chat old-format; `ChatRouteDeps.chatIds: ChatIdResolver`; `loadChatWithIds(deps, identity, ctx): Promise<{ chat: ChatSessionRow; ids: ChatIdBuilders } | null>` (`chats/access.ts`); `TurnStarterOptions.chatIds`, `ChatTitleDeps.chatIds`, `TurnReadDeps.chatIds`, turn commit deps `chatIds` (each `Pick<ChatIdResolver, "forRef">`, the title step `Pick<ChatIdResolver, "forRow">`), `loomTitleStarter(runtime, chatIds, onError?)`, `TurnHeads.has(ref: ChatRef, ords)`; `legacyTurnExecutionId` and `legacyTurnExperienceId` (`flows/visualize-turn/testing.ts`).

- [ ] **Step 1: Write the failing tests**

(a) `create.pg.test.ts` (its harness is `startChatServer()` as `h`: `h.req(user, method, path, body)`, `h.fake.calls`, `h.fake.ownerOf`, `h.owner` (the owner-role pool), `h.app`; Step 5b adds `h.ids`, the harness's `OpaqueIds`). Add the imports `withTenant` from `../db/tenant`, `deterministicUser` from `../opaqueIds/testing`, `insertChat` from `./sessions` and `legacyChatConversationId` from `./ids`.

First update the existing first test ("creates a chat: 201 ..."): its hard-coded ``const conversationId = `u_${U1}.c-${dto.id}`;`` (line 37) would break at the flip. Replace it with the opaque id, keeping the two assertions after it:

```ts
      const conversationId = deterministicUser(U1).conversation(dto.id); // a new chat starts under h_<H>.c-<token>
      expect(h.fake.calls).toContain(`start:${conversationId}`);
      expect(h.fake.ownerOf(conversationId)).toBe(`${T1}|${U1}`);
```

(and rename its title to "... and a conversation started for its owner under the opaque id"). Then add to the describe:

```ts
    it("makes a new chat opaque: the row says so, the conversation is h_<H>.c-<token>, and no id holds a uuid", async () => {
      const res = await h.req("alice", "POST", "/api/chats", {});
      expect(res.status).toBe(201);
      const { id } = ChatSessionDto.parse(await res.json());
      const row = await h.owner.query("SELECT id_format FROM chat_sessions WHERE id = $1", [id]);
      expect(row.rows).toEqual([{ id_format: "opaque" }]);
      const handle = deterministicUser(U1).handle; // the harness's id source is deterministic, so the test can name the handle
      expect(handle).toMatch(/^[a-z2-7]{25}[aeimquy4]$/);
      expect(h.ids.cached(U1)?.handle).toBe(handle); // the create route minted it
      const conversationId = deterministicUser(U1).conversation(id);
      expect(h.fake.calls).toContain(`start:${conversationId}`);
      expect(conversationId).toMatch(/^h_[a-z2-7]{25}[aeimquy4]\.c-[a-z2-7]{51}[aq]$/);
      expect(h.fake.calls.filter((c) => c.includes(id) || c.includes(U1))).toEqual([]); // no call names a uuid
    });

    it("regression guard (green before and after the flip): a chat inserted without a format stays on the old ids, u_<user>.c-<chat>", async () => {
      const id = randomUUID();
      await withTenant(h.app, T1, (tx) => insertChat(tx, T1, U1, id, "all"));
      await h.fake.api.start({
        conversationId: legacyChatConversationId(U1, id),
        principal: { tenant: T1, actor: U1 },
      });
      const row = await h.owner.query("SELECT id_format FROM chat_sessions WHERE id = $1", [id]);
      expect(row.rows).toEqual([{ id_format: "legacy" }]);
      const messages = await h.req("alice", "GET", `/api/chats/${id}/messages`);
      expect(messages.status).toBe(200); // the route found the conversation under the old id
    });
```

(b) A resolver-driven route test in `chats/send.pg.test.ts` (its harness `h`, `send(user, chatId, body)` and `seedChat`; a chat from `seedChat` is inserted without a format, so it is legacy), next to the existing send tests:

```ts
  it("regression guard (green before and after the flip): a message to a chat that began under the old ids goes to u_<user>.c-<chat>", async () => {
    const chatId = await seedChat(h, ALICE);
    const res = await send("alice", chatId, { text: "Hi" });
    expect(res.status).toBe(202);
    expect(h.fake.calls).toContain(`send:${legacyChatConversationId(ALICE.userId, chatId)}`);
    expect(h.fake.calls.filter((c) => c.startsWith("send:h_"))).toEqual([]);
  });
```

(import `legacyChatConversationId` from `./ids`).

(c) Turn-visuals unit tests: in `flows/visualize-turn/start.test.ts` (it already has `fake()` (`f.runtime`, `f.start`, `f.started`), `options(over)`, `ref`, `settled()`, `flow`, `user`, `chat`; add `chatIds: fixedChatIds()` to the defaults of `options`, and the imports `fixedChatIds` from `../../chats/testing`, `testIdSource` from `../../opaqueIds/testing`, `TurnGoneError` from `./errors`; `turnExecutionId` there is the legacy builder after Step 5a):

```ts
describe("the turn starter: the chat's own format", () => {
  it("starts the turn run under the chat's own format: u_ for a legacy chat, h_ for an opaque one", async () => {
    const f = fake();
    const ids = testIdSource();
    await ids.ensureUser(ref);
    const legacy = loomTurnStarter(f.runtime, flow, options({ chatIds: fixedChatIds(() => "legacy", ids) }));
    const opaque = loomTurnStarter(f.runtime, flow, options({ chatIds: fixedChatIds(() => "opaque", ids) }));
    await legacy.visualize(ref);
    await opaque.visualize({ ...ref, chatId: randomUUID() });
    const [first, second] = [...f.started];
    expect(first).toBe(turnExecutionId(user, chat, 4, 1));
    expect(second).toMatch(/^h_[a-z2-7]{25}[aeimquy4]:visualize-turn-[a-z2-7]{51}[aq]-4-r1$/);
    expect(second).not.toContain(user);
  });

  it("starts nothing for a chat the resolver does not know: a request is refused as gone, a settled turn is dropped without a log line", async () => {
    const f = fake();
    const onError = vi.fn();
    const s = loomTurnStarter(
      f.runtime,
      flow,
      options({ onError, chatIds: { forRef: async () => null } }),
    );
    await expect(s.visualize(ref)).rejects.toBeInstanceOf(TurnGoneError);
    s.onSettled(settled());
    await s.idle();
    expect(f.start).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled(); // an erased chat is not an error on every settle (M6)
  });
});
```

(d) Title unit test in `flows/chat-title/start.test.ts` (its existing calls `loomTitleStarter({ start } as never)` become `loomTitleStarter({ start } as never, fixedChatIds())`; add the imports `fixedChatIds` from `../../chats/testing` and `deterministicUser`, `testIdSource` from `../../opaqueIds/testing`): the starter takes the resolver and starts `h_<H>:chat-title-<C>` for an opaque chat, `u_<u>:chat-title-<c>` for a legacy one, and `null` (no start) for an unknown chat.

```ts
  it("starts the title under the chat's own format, and nothing for a chat that is not the owner's", async () => {
    const ids = testIdSource();
    await ids.ensureUser(ref);
    const start = vi.fn(async () => handle);
    const executionId = () =>
      (start.mock.calls.at(-1) as unknown as [unknown, unknown, { executionId: string }])[2].executionId;
    await loomTitleStarter({ start } as never, fixedChatIds(() => "legacy", ids)).start(ref);
    expect(executionId()).toBe(`u_${ref.userId}:chat-title-${ref.chatId}`);
    await loomTitleStarter({ start } as never, fixedChatIds(() => "opaque", ids)).start(ref);
    expect(executionId()).toBe(deterministicUser(ref.userId).chatTitle(ref.chatId));
    expect(executionId()).not.toContain(ref.userId);
    const none = loomTitleStarter({ start } as never, { forRef: async () => null });
    expect(await none.start(ref)).toBeNull();
    expect(start).toHaveBeenCalledTimes(2);
  });
```

Run: `cd apps/server && set -a; . /Users/such/workspace/docmind/.env; set +a; pnpm exec vitest run app/chats/create app/flows/visualize-turn/start app/flows/chat-title/start`
Expected: FAIL (the options have no `chatIds`; the create route makes legacy chats).

- [ ] **Step 2: `access.ts`, `routes.ts` (the create route and the deps)**

`apps/server/app/chats/access.ts`: add

```ts
import type { ChatIdBuilders } from "./chatIds";

/**
 * The caller's live chat with the id builders of its own format, or null for anything `loadChat` refuses and for an opaque chat whose owner
 * has no live id key (erased): all alike a 404.
 */
export async function loadChatWithIds(
  deps: Pick<ChatRouteDeps, "pool" | "chatIds">,
  identity: Identity,
  ctx: RouteContext,
): Promise<{ chat: ChatSessionRow; ids: ChatIdBuilders } | null> {
  const chat = await loadChat(deps, identity, ctx);
  if (!chat) return null;
  const ids = await deps.chatIds.forRow(identity, chat);
  return ids ? { chat, ids } : null;
}
```

`apps/server/app/chats/routes.ts`: add `chatIds: ChatIdResolver;` to `ChatRouteDeps` (doc: "Builds a chat's Loom ids in its own format (migration 0039)."); replace the create route's body from `const id = randomUUID();` as follows (import `ChatIdResolver` type from `./chatIds`, drop the `chatConversationId`/`legacyChatConversationId` import):

```ts
      const id = randomUUID();
      // The new chat's ids: the new format, minting the user's id key and handle on their first chat. A key-store outage throws here,
      // before any row exists, and is retried like any other (spec section 5); nothing falls back to a plaintext-UUID id.
      const ids = await deps.chatIds.forNew(identity, id);
      const row = await withTenant(deps.pool, identity.tenantId, async (tx) =>
        (await scopeIsOwned(tx, identity.userId, scope))
          ? insertChat(tx, identity.tenantId, identity.userId, id, scope, "opaque")
          : null,
      );
      if (!row)
        return sendError(res, 400, "invalid_scope", "scope names a document that is not yours");
      try {
        // The only place a chat conversation starts (startRatchet.test.ts checks this exact argument).
        await deps.chat.conversations.start({
          conversationId: ids.conversationId(),
          principal: principalOf(identity),
        });
      } catch (err) {
```

(the rollback `catch` body is unchanged).

- [ ] **Step 3: The other chat routes**

`messageRoutes.ts`: in both handlers replace `const chat = await loadChat(deps, identity, ctx); if (!chat) return notFound(res);` with

```ts
        const loaded = await loadChatWithIds(deps, identity, ctx);
        if (!loaded) return notFound(res);
        const { chat, ids } = loaded;
```

and `chatConversationId(identity.userId, chat.id)` (two places) with `ids.conversationId()`. In the history handler pass the id on: `toMessageDtos(deps, identity, { id: chat.id, conversationId: ids.conversationId() }, page.entries)`; import `loadChatWithIds` from `./access`.

`messages.ts`: change the signature to `toMessageDtos(deps, identity, chat: { id: string; conversationId: ChatConversationId }, history)`, set `const chatId = chat.id;` at the top, the reasoning read to `deps.reasoning.forReplies(ref, chat.conversationId, replies)`, and the heads call to `deps.heads.has({ tenantId: identity.tenantId, userId: identity.userId, chatId }, citedOrds)`; drop its `chatConversationId` import.

`reasoningRoutes.ts`: `loadChatWithIds`; the call `chatConversationId(identity.userId, chat.id)` becomes `ids.conversationId()`.

`stream.ts`: add `"chatIds"` to the `Pick` list of `ChatStreamDeps`; in the route use `loadChatWithIds`; `const conversationId = ids.conversationId();`; at the message batch call `toMessageDtos(deps, identity, { id: chatId, conversationId }, entries)`.

`manageRoutes.ts`: in `DELETE` and `POST .../stop` use `loadChatWithIds` and `ids.conversationId()` (both places); the `PATCH`/`GET` handlers keep `loadChat`.

`ui/routes.ts`: add `chatIds: Pick<ChatIdResolver, "forRef">;` to `UiRouteDeps`; `turnHead` becomes

```ts
  const turnHead = async (identity: Identity, chatId: string, ord: number) => {
    let visuals: Experience;
    try {
      const ids = await deps.chatIds.forRef({ tenantId: identity.tenantId, userId: identity.userId, chatId });
      if (!ids) return null; // not the owner's chat: no head
      const latest = await deps.lineage.resolveLatest(ids.turnExperienceId(ord));
      if (!latest.ok) return null;
      visuals = latest.value;
    } catch (err) {
```

(drop the `turnExperienceId` import; the rest of `turnHead` is unchanged).

`turnHeads.ts`: `lineageTurnHeads(lineage, chatIds, concurrency = 8)`; `has(ref: ChatRef, ords)` resolves `const ids = await chatIds.forRef(ref); if (!ids) return new Set();` once, then each worker reads `lineage.resolveLatest(ids.turnExperienceId(ord))`.

- [ ] **Step 4: The title and turn-visuals flows**

`flows/chat-title/start.ts` (the `TitleStarter.start` doc becomes "`null`: already started, or not the owner's chat. Throws on a malformed ref or a Loom failure."; callers must not read `null` as "a title exists"):

```ts
import type { ChatIdResolver } from "../../chats/chatIds";

export function loomTitleStarter(
  runtime: Pick<WorkflowRuntime, "start">,
  chatIds: Pick<ChatIdResolver, "forRef">,
  onError: (err: unknown) => void = logClass,
): TitleStarter {
  ...
  const start = async (ref: ChatRef): Promise<ExecutionHandle | null> => {
    const input = ChatTitleInput.parse({ tenantId: ref.tenantId, userId: ref.userId, chatId: ref.chatId });
    // The chat's own format: a chat that began under `u_<user>` starts (once) under it, never a second title under `h_<H>` (Decision 2).
    const ids = await chatIds.forRef(input);
    if (!ids) return null; // not the owner's chat any more
    try {
      return await runtime.start(chatTitleFlow, input, {
        // One title execution per chat: Loom starts a caller-chosen id once.
        executionId: ids.titleExecutionId(),
        principal: { tenant: input.tenantId, actor: input.userId },
      });
```

(remove the `legacyIds` import). `flows/chat-title/step.ts`: `ChatTitleDeps` gets `chatIds: Pick<ChatIdResolver, "forRow">`; after the existing row read, replace `const conversationId = chatConversationId(ref.userId, ref.chatId);` with

```ts
      const ids = await deps.chatIds.forRow(ref, row);
      if (!ids) return SKIPPED; // an opaque chat whose owner's key is gone
      const conversationId = ids.conversationId();
```

`flows/visualize-turn/start.ts`: `TurnStarterOptions` gets `chatIds: Pick<ChatIdResolver, "forRef">`; in `onSettled` an erased chat must not log "visualize-turn start failed" on every settle (M6), so the enqueue becomes

```ts
      enqueue(
        turnToVisualize(e, o).then(async (ref) => {
          if (!ref) return;
          try {
            await startOne(ref);
          } catch (err) {
            if (!(err instanceof TurnGoneError)) throw err; // the chat went (erased): nothing to start, nothing to report
          }
        }),
      );
```

(`visualize` still lets `TurnGoneError` reach its caller). In `startOne` replace `const executionId = turnExecutionId(...)` with

```ts
    const ids = await o.chatIds.forRef(ref);
    if (!ids) throw new TurnGoneError(); // the chat went (erased): a number probe must not treat it as "id taken"
    const executionId = ids.turnExecutionId(input.ord, rerun);
```

(import `TurnGoneError` from `./errors`). `flows/visualize-turn/readTurn.ts`: `TurnReadDeps` gets `chatIds: Pick<ChatIdResolver, "forRef">`; in `findReply` `const ids = await deps.chatIds.forRef(ref); if (!ids) return null; const conversationId = ids.conversationId();`. `commit.ts`: the effect's deps get `chatIds: Pick<ChatIdResolver, "forRef">` and the target becomes

```ts
        const ids = await deps.chatIds.forRef(input);
        if (!ids) throw new TurnGoneError();
        const target = {
          experienceId: ids.turnExperienceId(input.ord),
          intent: TURN_INTENT,
          sourceKind: "turn-visuals",
        };
```

`flows/visualize-turn/ids.ts`: delete `turnExecutionId`, `turnExperienceId`, `checkOrd`, `checkUuid`, `MAX_RERUN`, `CANONICAL_UUID` and the `legacyIds` and `UUID_PATTERN` imports (keep `TurnRef`, `TURN_FLOW_ID`, `parseTurnExecution`, `isTurnVisualizeExecution`; `RecordOrd` stays imported for `TurnRef`). `flows/visualize-turn/testing.ts` gains the old signatures for tests, with the old builders' full strictness (M9: the canonical lower-case check, the ord check and the rerun range moved with them, so `ids.test.ts` keeps its refusals):

```ts
import { RecordOrd } from "@docmind/contracts";
import { UUID_PATTERN, legacyIds } from "../../opaqueIds";

const CANONICAL_UUID = new RegExp(`^${UUID_PATTERN}$`);
const MAX_RERUN = 999;
const checkOrd = (ord: number) => {
  if (!RecordOrd.safeParse(ord).success)
    throw new RangeError("ord must be an integer from 1 to 999999999999999");
};
const checkUuid = (what: string, id: string) => {
  if (!CANONICAL_UUID.test(id)) throw new RangeError(`${what} must be a canonical lower-case uuid`);
};

/** The old-format turn execution id, with the old builder's signature and checks: tests that seed or read a legacy chat's turn run. */
export const legacyTurnExecutionId = (userId: string, chatId: string, ord: number, rerun?: number) => {
  checkOrd(ord);
  if (rerun !== undefined && (!Number.isSafeInteger(rerun) || rerun < 1 || rerun > MAX_RERUN))
    throw new RangeError("rerun must be an integer from 1 to 999");
  return legacyIds.turnVisualize(userId, chatId.toLowerCase(), ord, rerun);
};
/** The old-format turn lineage id, with the old builder's strictness (canonical lower-case user and chat ids, a valid ord). */
export const legacyTurnExperienceId = (r: { userId: string; chatId: string; ord: number }): string => {
  checkUuid("userId", r.userId);
  checkUuid("chatId", r.chatId);
  checkOrd(r.ord);
  return legacyIds.turnLineage(r.userId, r.chatId, r.ord);
};
```

(The production resolver's `legacyBuilders.conversationId` stays the one canonical-chat check of the legacy conversation builder; the test-only turn builders above keep their own so the three legacy builders do not silently differ in strictness.)

`compose.ts`: pass `chatIds` to `visualizeTurn.deps` (read and commit deps: `chatIds`), to `turnRead` (`readTurn({ reader, items, pool, fields, chatIds }, ...)`), to `loomTurnStarter` options, to `chatTitle` deps, to `loomTitleStarter(app.runtime, chatIds)`, to `chatRoutes` and `chatStreamRoutes` deps, to `lineageTurnHeads(lineage, chatIds)`, and to the UI routes deps. Because `chatTitle` and `visualizeTurn` are built before `app`, move `const chatIds = new PgChatIds(pool, ids);` (Task 1) above them if it is not already (it sits right after `ids`).

- [ ] **Step 5: Migrate the tests and the test support**

(a) The turn builders in tests (run from `apps/server/app`, idempotent):

```bash
python3 - <<'PY'
import re, subprocess
files = subprocess.check_output(
    "grep -rlE '\\b(turnExecutionId|turnExperienceId)\\b' . | grep -E 'test|testing' || true", shell=True, text=True).split()
for f in files:
    if f.endswith("flows/visualize-turn/testing.ts"): continue
    s = open(f).read()
    rel = "./testing" if "/visualize-turn/" in f else None
    if "legacyTurn" in s: continue
    # import { turnExecutionId, X } from ".../ids"  ->  keep X, add an aliased import from visualize-turn/testing
    def fix(m):
        names = [n.strip() for n in m.group(1).split(",") if n.strip()]
        keep = [n for n in names if n not in ("turnExecutionId", "turnExperienceId")]
        alias = [f"legacyTurnExecutionId as turnExecutionId" if n == "turnExecutionId" else "legacyTurnExperienceId as turnExperienceId" for n in names if n in ("turnExecutionId", "turnExperienceId")]
        base = m.group(2).rsplit("/ids", 1)[0]
        out = ""
        if keep: out += f'import {{ {", ".join(keep)} }} from "{m.group(2)}";\n'
        out += f'import {{ {", ".join(alias)} }} from "{base}/testing";\n'
        return out
    s2 = re.sub(r'import \{([^}]*\b(?:turnExecutionId|turnExperienceId)\b[^}]*)\} from "([^"]*visualize-turn/ids|\./ids)";\n', fix, s)
    if s2 != s: open(f, "w").write(s2)
print(files)
PY
cd .. && pnpm exec biome check --write app && pnpm typecheck:tests
```

If `typecheck:tests` names a file the script missed (a differently shaped import), add the aliased import by hand. The tests keep calling `turnExecutionId(...)`/`turnExperienceId(...)` unchanged, now backed by the legacy builders.

(b) Every test or harness that constructs the route, starter, step or reader deps gets `chatIds`: `chats/testHarness.ts` builds `const ids = testIdSource(); const chatIds = new PgChatIds(app, ids);`, adds `chatIds` to its `deps` and exposes `ids` on `ChatHarness` (`ids: OpaqueIds`; its `seedChat` keeps inserting legacy rows), and `chats/testStack.ts` (the `ChatRouteDeps` and the title/turn deps it builds) uses `new PgChatIds(pool, ids)` where it has a pool and an id source and `fixedChatIds()` elsewhere; `chats/turnHeads.test.ts` passes `fixedChatIds()`; the `ui/routes.test.ts` deps get `chatIds: fixedChatIds()`; `flows/chat-title/*.test.ts`, `flows/visualize-turn/{start,commit,readTurn,compose,trigger,flow}.test.ts` pass `chatIds: fixedChatIds()` where their deps types now require it, and `loomTitleStarter(runtime, fixedChatIds(), onError)` in `chat-title/start.test.ts`. `chats/messages.test.ts`: the 12 calls `toMessageDtos(deps, IDENTITY, C, ...)` become `toMessageDtos(deps, IDENTITY, CHAT, ...)` with `const CHAT = { id: C, conversationId: legacyChatConversationId(IDENTITY.userId, C) };` at the top (and `deps.heads.has` fakes take the new ref). Let `pnpm typecheck:tests` drive the remainder: each error is one of these four shapes.

(c) `chats/startRatchet.test.ts`: the callee check follows the new source of the argument. Set `const IDS = join(APP, "chats", "chatIds.ts");` and replace `isChatConversationId` with:

```ts
  /** The callee is the `conversationId` member of `ChatIdBuilders` declared in app/chats/chatIds.ts, however it is reached. */
  const isChatConversationId = (callee: ts.Expression): boolean => {
    let symbol = checker.getSymbolAtLocation(callee);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return (
      symbol?.declarations?.some(
        (d) =>
          (ts.isMethodSignature(d) || ts.isPropertyAssignment(d) || ts.isMethodDeclaration(d)) &&
          ts.isIdentifier(d.name) &&
          d.name.text === "conversationId" &&
          d.getSourceFile().fileName === IDS,
      ) ?? false
    );
  };
```

Update the virtual snippet header and the test names: the import line becomes `declare const ids: import("./chats/chatIds").ChatIdBuilders;` (the virtual file sits at the app root, so the path is `./chats/chatIds`; drop the `chatConversationId` import), and `chatConversationId(user, chat)` becomes `ids.conversationId()` in the accepted case, the "a variable" case (`const id = ids.conversationId(); ...`), the "a spread" case, the "without a principal" case and the test titles (the real call in `routes.ts` is `conversationId: ids.conversationId()`). Keep the control that a literal id, a cast, `legacyIds.conversation(...)` and `userIds.conversation(...)` arguments are flagged. Rewrite the negative test "flags a start whose callee only looks like chatConversationId" to look-alike the new name:

```ts
  it("flags a start whose callee only looks like ChatIdBuilders.conversationId", () => {
    const fake = scanStarts(
      [],
      new Map([
        [
          VIRTUAL,
          `import type { Conversations } from "@loom/conversation";
           declare const ids: { conversationId(): string };
           declare const c: Conversations; declare const p: never;
           export async function f() { await c.start({ conversationId: ids.conversationId() as never, principal: p }); }`,
        ],
      ]),
    );
    expect(fake.map((c) => c.ok)).toEqual([false]);
  });
```

(d) `restart.e2e.pg.test.ts`: turn the "restart in the middle of a tool loop" test into a parametrised pair, the new chat and an old one (the `legacy` variant is a regression guard: green before and after the flip; the `opaque` variant is the one that fails first): replace `it("a restart in the middle ...", async () => {` with `it.each([["an h_ chat", "opaque"], ["a u_ chat", "legacy"]] as const)("a restart in the middle of a tool loop keeps the thinking block (%s): ...", async (_name, format) => {`, create the chat with `format === "legacy" ? await createLegacyChat(first, ada) : ChatSessionDto.parse(...)`, and after the restart (before opening `stream2`) assert the recovery ran on a cold cache and the id format is right:

```ts
      const conversations = ((await second.durable.raw.eventStore.listExecutions?.()) ?? []).filter(
        (id) => id.includes(".c-") && !id.startsWith("__loom") && !id.includes("::"),
      );
      expect(conversations).toHaveLength(1);
      expect(conversations[0]?.startsWith(format === "legacy" ? "u_" : "h_")).toBe(true);
      expect(second.composed.ids.cached(ada.userId) !== undefined).toBe(format === "opaque"); // warmed at boot, before recovery
```

(the legacy variant: no handle is minted by a legacy chat, so the cache holds nothing for the user; the document flows were not used in this test).

- [ ] **Step 6: Run the tests**

Run: `cd apps/server && set -a; . /Users/such/workspace/docmind/.env; set +a; pnpm exec vitest run app/chats app/flows/chat-title app/flows/visualize-turn app/ui app/executionIds app/storage app/erasure`
Expected: PASS: the new chats are opaque; `golden`, `resume`, `noPair` and the first `opaqueIds` test (pinned legacy in Task 3) still pass; `erasure.e2e` and the rest of the erasure e2e now run on `h_` chats and pass with the Task 2 sealing and the Task 3 harness. If a test fails because it hard-codes a `u_` conversation for a chat created through the API, fix it to read the id from the stack or to create a legacy chat; do not weaken the production code.

- [ ] **Step 7: Typecheck, lint, commit**

Run: `pnpm exec biome check --write apps/server/app && pnpm typecheck && pnpm typecheck:tests && pnpm lint`

```bash
git add apps/server/app
git commit -m "feat(ids): new chats run under opaque ids; a chat keeps its own format for its conversation, title, turn visuals and lineage"
```

(append the two trailers)

---

### Task 5: The ratchet, the mixed history and the phase 2 end to end (spec section 8; F7, F8)

**Files:**
- Modify: `apps/server/app/executionIds.test.ts`, `apps/server/app/erasure/opaqueIds.e2e.pg.test.ts`, `apps/server/app/chats/visuals.e2e.pg.test.ts`, `apps/server/app/documents/ingestStack.ts` (`runIds` for chats), `apps/server/tsconfig.json` (exclude the new test support from the production build)
- Create: `apps/server/app/chats/visualsE2eSupport.ts`
- Test: those files

**Interfaces:**
- Consumes: Tasks 1 to 4; `seedUser`, `eraseMe`, `waitErased`, `assertErased`, `rowsLinkingHandleToIds`, `scanTables`, `createLegacyChat`, `startIngestStack({ chat: true, visuals: true })`, `visualsLineage` (`flows/visualize-document/lineage.ts`).
- Produces: a ratchet that forbids a direct call of a chat family's builder outside the resolver, the eraser, the legacy conversation builder (`chats/ids.ts`) and the test-only legacy turn builders (`flows/visualize-turn/testing.ts`), and a call of `legacyChatConversationId` outside the resolver and the chat test support; `stack.runIds.chat(who, chatId): Promise<ChatIdBuilders | null>` for tests; `visualsE2eSupport.ts` exports `FIGURE_DOC`, `LABEL`, `stubVisuals(claude, state)`, `readyDocument(st, cookie)`, `askChat(st, cookie, chatId, text)` and is excluded from the production tsconfig.

- [ ] **Step 1: The ratchet, written first**

Append to `apps/server/app/executionIds.test.ts` (it already has `ts`, `readFileSync`, `join`, `sep`, `APP`, `sources`):

```ts
/**
 * Where a chat family's builder is called directly (`UserIds.conversation|chatTitle|turnVisualize|turnLineage`, or the same names on
 * `legacyIds`) outside `opaqueIds`. Phase 2: only the resolver (`chats/chatIds.ts`), the eraser (`erasure/wire.ts`, which must name both
 * formats of a chat), the legacy conversation builder (`chats/ids.ts`) and the test-only legacy turn builders
 * (`flows/visualize-turn/testing.ts`) may; everything else asks `ChatIdResolver`, so no call site can pick a format of its own.
 */
const CHAT_BUILDERS = new Set(["conversation", "chatTitle", "turnVisualize", "turnLineage"]);
const MAY_BUILD_CHAT_IDS = new Set([
  "chats/chatIds.ts",
  "erasure/wire.ts",
  "chats/ids.ts",
  "flows/visualize-turn/testing.ts",
]);
/**
 * `legacyChatConversationId` is a plain function, not a builder method, so it is flagged by name: outside tests only the resolver and the
 * chat test support (which builds a legacy chat on purpose) may call it. Production code asks the resolver.
 */
const LEGACY_CONVERSATION = "legacyChatConversationId";
const MAY_CALL_LEGACY_CONVERSATION = new Set([
  "chats/chatIds.ts",
  "chats/testing.ts",
  "chats/testStack.ts",
  "chats/testHarness.ts",
  "chats/e2eSupport.ts",
]);

type CalleeRule = (callee: ts.Expression) => boolean;
const isBuilderCall: CalleeRule = (callee) =>
  ts.isPropertyAccessExpression(callee) && CHAT_BUILDERS.has(callee.name.text);
const isLegacyConversationCall: CalleeRule = (callee) =>
  ts.isIdentifier(callee) && callee.text === LEGACY_CONVERSATION;

function chatBuilderCalls(
  files: string[],
  virtual = new Map<string, string>(),
  flagged: CalleeRule = isBuilderCall,
): string[] {
  const hits: string[] = [];
  const scan = (name: string, text: string) => {
    const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && flagged(node.expression)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        hits.push(`${name.startsWith(APP) ? name.slice(APP.length + 1) : name}:${line}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  };
  for (const file of files) scan(file, readFileSync(file, "utf8"));
  for (const [name, text] of virtual) scan(name, text);
  return hits;
}

describe("no chat id is built outside the resolver and the eraser", () => {
  it.each([
    ["a legacy conversation", "legacyIds.conversation(user, chat);"],
    ["a legacy title", "legacyIds.chatTitle(user, chat);"],
    ["a legacy turn run", "legacyIds.turnVisualize(user, chat, 1);"],
    ["a legacy turn line", "legacyIds.turnLineage(user, chat, 1);"],
    ["a new-format conversation", "ids.conversation(chat);"],
    ["a new-format title", "userIds.chatTitle(chat);"],
    ["a new-format turn run", "userIds.turnVisualize(chat, 1, 2);"],
    ["a new-format turn line", "userIds.turnLineage(chat, 1);"],
  ])("flags %s (the scan is not blind)", (_name, body) => {
    expect(chatBuilderCalls([], new Map([[join(APP, "__virtual__.ts"), `export const x = () => { ${body} };`]]))).toEqual([
      "__virtual__.ts:1",
    ]);
  });

  it("flags a direct call of the legacy conversation builder, by name", () => {
    const body = "export const x = () => { legacyChatConversationId(user, chat); };";
    expect(
      chatBuilderCalls([], new Map([[join(APP, "__virtual__.ts"), body]]), isLegacyConversationCall),
    ).toEqual(["__virtual__.ts:1"]);
  });

  it("does not flag the resolver's own method names or a document builder", () => {
    const body =
      "export const x = () => { ids.conversationId(); ids.titleExecutionId(); ids.turnExecutionId(1); ids.turnExperienceId(1); user.ingest(d, 1); };";
    expect(chatBuilderCalls([], new Map([[join(APP, "__virtual__.ts"), body]]))).toEqual([]);
  });

  it("finds none in the real sources beyond opaqueIds, the resolver, the eraser, the legacy conversation builder and the test-only legacy turn builders", () => {
    const real = sources(APP).filter(
      (f) =>
        !f.startsWith(join(APP, "opaqueIds") + sep) && !MAY_BUILD_CHAT_IDS.has(f.slice(APP.length + 1)),
    );
    expect(real.length).toBeGreaterThan(100);
    expect(chatBuilderCalls(real)).toEqual([]);
  });

  it("finds no call of legacyChatConversationId in the real sources beyond the resolver and the chat test support", () => {
    const real = sources(APP).filter((f) => !MAY_CALL_LEGACY_CONVERSATION.has(f.slice(APP.length + 1)));
    expect(real.length).toBeGreaterThan(100);
    expect(chatBuilderCalls(real, new Map(), isLegacyConversationCall)).toEqual([]);
  });
});
```

Run: `cd apps/server && pnpm exec vitest run app/executionIds app/chats/startRatchet`
Expected: PASS (the allowed files are the resolver, the eraser, the legacy conversation builder and the test-only legacy turn builders; every other call moved behind the resolver in Task 4).

- [ ] **Step 2: Share the visuals e2e helpers**

Create `apps/server/app/chats/visualsE2eSupport.ts` by moving `LABEL`, `FIGURE_DOC`, `CHUNK_ID`, `stubVisuals` and the two helpers `ready` and `ask` out of `chats/visuals.e2e.pg.test.ts` (export them as `readyDocument` and `askChat`; they take the stack explicitly already) and import them back in that file; the bodies are moved verbatim. This file imports `vitest` and `@docmind/llm-anthropic/testing`, and the production tsconfig's `exclude` matches `**/e2eSupport.ts` only by that exact basename, so add `"**/visualsE2eSupport.ts"` to the `exclude` list of `apps/server/tsconfig.json` next to `"**/e2eSupport.ts"` (otherwise `pnpm build` pulls both into the production program):

```json
    "**/e2eSupport.ts",
    "**/visualsE2eSupport.ts",
    "**/testStack.ts",
```

The file:

```ts
import { randomUUID } from "node:crypto";
import type { UploadDocumentResponse } from "@docmind/contracts";
import type { FakeAnthropic } from "@docmind/llm-anthropic/testing";
import { expect } from "vitest";
import type { IngestStack } from "../documents/ingestStack";
import { DOC, collectUntil, isReply } from "./e2eSupport";

export const LABEL = "Zebra-Quarterly-Takings";
export const FIGURE_DOC = `${DOC} ${LABEL} reached 7391.25 in the last quarter.`;
const CHUNK_ID = /\[\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]\]/;

/** A `visuals` model that finds the figure in whatever it is shown while `state.extract` is on, and plans a KeyFigure bound to the first offered fact. */
export function stubVisuals(claude: FakeAnthropic, state: { extract: boolean; calls: number }) {
  claude.reply((body) => {
    state.calls++;
    const system = typeof body.system === "string" ? body.system : JSON.stringify(body.system);
    const text = JSON.stringify(body.messages);
    if (system.includes("You extract facts")) {
      const chunk = CHUNK_ID.exec(text)?.[1];
      if (!state.extract || !chunk || !text.includes(LABEL)) return { text: '{"facts":[]}' };
      return {
        text: JSON.stringify({
          facts: [{ kind: "figure", label: LABEL, value: 7391.25, unit: "USD", chunkIds: [chunk] }],
        }),
      };
    }
    return {
      text: JSON.stringify({
        summary: "A headline figure",
        nodes: [
          {
            id: "headline",
            type: "KeyFigure",
            label: LABEL,
            span: 4,
            props: {},
            binding: { capability: "fact-0", arguments: {}, path: "value", priority: "P0" },
          },
        ],
      }),
    };
  });
}

/** Uploads the figure document and waits until it is ready; the passage id the chat model will cite. */
export async function readyDocument(st: IngestStack, cookie: string) {
  const events = await st.events(cookie);
  try {
    const up = await st.upload(cookie, "report.txt", Buffer.from(FIGURE_DOC));
    expect(up.status).toBe(201);
    const documentId = ((await up.json()) as UploadDocumentResponse).document.id;
    await st.until(events, documentId, (s) => s === "ready" || s === "failed");
    const chunks = await st.db.owner.query("SELECT id FROM chunks WHERE document_id = $1", [documentId]);
    return { documentId, passageId: chunks.rows[0].id as string };
  } finally {
    events.close();
  }
}

/** Asks one question; resolves with the reply frame's data. */
export async function askChat(st: IngestStack, cookie: string, chatId: string, text: string) {
  const stream = await st.openChat(cookie, chatId);
  try {
    const sent = await st.chatReq(cookie, "POST", `/api/chats/${chatId}/messages`, {
      text,
      messageId: randomUUID(),
    });
    expect(sent.status).toBe(202);
    const frames = await collectUntil(stream, isReply);
    return frames.find(isReply)?.data as { id: string; hasVisuals?: boolean; citations: unknown[] };
  } finally {
    stream.close();
  }
}
```

In `visuals.e2e.pg.test.ts` delete the moved definitions and import `{ FIGURE_DOC, LABEL, askChat as ask, readyDocument as ready, stubVisuals } from "./visualsE2eSupport"` (the file's `ready(st, cookie)` and `ask(st, cookie, chatId, text)` calls keep working); the file's other uses of `LABEL`, `FIGURE_DOC` and `CHUNK_ID` keep their names (re-declare `CHUNK_ID` locally there if it still uses it). Run `pnpm exec vitest run app/chats/visuals` (PASS) before going on.

- [ ] **Step 3: `runIds` for chats**

In `apps/server/app/documents/ingestStack.ts` add to the `runIds` object and its type (the interface above the factory, `runIds:` next to `suggestTags`):

```ts
        /** The id builders of a chat in its own format (read from its row): what a test needs to name the chat's conversation, title, turn run or lineage line. */
        chat: (who, chatId) => composed.chatIds.forRef({ tenantId: who.tenantId, userId: who.userId, chatId }),
```

with the type `chat(who: { tenantId: string; userId: string }, chatId: string): Promise<ChatIdBuilders | null>`.

- [ ] **Step 4: The phase 2 end-to-end tests, written first**

In `apps/server/app/erasure/opaqueIds.e2e.pg.test.ts` add the imports (`createLegacyChat` from `../chats/e2eSupport`, `ChatSessionDto, ListMessagesResponse` from `@docmind/contracts`) and a new `describe` after the phase 1 one:

```ts
describe.skipIf(!PG_URL)("opaque ids phase 2: the chat flows, end to end (needs DOCMIND_TEST_PG_URL)", () => {
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
  const HANDLE = "[a-z2-7]{25}[aeimquy4]";
  const TOKEN = "[a-z2-7]{51}[aq]";

  /** Waits for the visuals head of a turn: the line resolves, so the turn run committed. */
  async function lineageHead(st: IngestStack, line: string) {
    const lineage = visualsLineage({
      events: st.durable.storage.eventStore,
      content: st.composed.lineageContent,
      keys: st.keys,
      subjectOf: subjectOfExecution,
    });
    await vi.waitFor(async () => expect((await lineage.resolveLatest(line)).ok).toBe(true), {
      timeout: 60_000,
      interval: 100,
    });
    return lineage;
  }
  /** The ord of a chat's one assistant reply (the turn the visuals belong to). */
  const replyOrd = async (st: IngestStack, cookie: string, chatId: string) =>
    Number(
      ListMessagesResponse.parse(
        await (await st.chatReq(cookie, "GET", `/api/chats/${chatId}/messages`)).json(),
      ).items.find((m) => m.role === "assistant")?.id,
    );

  it(
    "a new chat: the conversation, the title and the turn visuals are opaque (across a cold restart); erasing leaves nothing linkable",
    async () => {
      const first = track(await startIngestStack({ chat: true, visuals: true }));
      stubPaymentVisuals(first.visualsClaude as FakeAnthropic);
      const login = await first.signUpAndLogIn("chatids@example.com");
      const user = await seedUser(first, login, "chatids@example.com"); // a chat turn with a citation and a title, on a stack with visuals on
      expect(user.chatFormat).toBe("opaque");
      const who = { tenantId: user.tenantId, userId: user.userId };
      const ids = await first.runIds.chat(who, user.chatId);
      expect(ids?.format).toBe("opaque");
      const ord = await replyOrd(first, login.cookie, user.chatId);
      const line = ids?.turnExperienceId(ord) as string;
      await lineageHead(first, line);
      const handle = new RegExp(`^h_(${HANDLE})`).exec(ids?.conversationId() as string)?.[1] as string;

      // A cold restart: the chat continues (recovery and the cache warm-up read the new ids), a second turn is answered and titled once.
      await first.close({ keepDb: true });
      stacks.splice(stacks.indexOf(first), 1);
      const st = track(
        await startIngestStack({
          chat: true,
          visuals: true,
          resume: { db: first.db, kek: first.kek, root: first.root },
        }),
      );
      stubPaymentVisuals(st.visualsClaude as FakeAnthropic);
      expect(st.composed.ids.cached(user.userId)?.handle).toBe(handle); // warmed at boot
      const history = ListMessagesResponse.parse(
        await (await st.chatReq(login.cookie, "GET", `/api/chats/${user.chatId}/messages`)).json(),
      );
      expect(history.items.map((m) => m.role)).toEqual(["user", "assistant"]);
      expect(history.items.find((m) => m.role === "assistant")?.hasVisuals).toBe(true); // the head reads back through the opaque line

      // Every id of the chat, before the erasure: built from the handle and tokens, no uuid anywhere.
      const all = (await st.durable.raw.eventStore.listExecutions?.()) ?? [];
      const conv = all.filter((id) => id.startsWith(`h_${handle}.c-`));
      const title = all.filter((id) => id.startsWith(`h_${handle}:chat-title-`));
      const turn = all.filter((id) => id.startsWith(`h_${handle}:visualize-turn-`));
      const lines = all.filter((id) => id.startsWith("__loom_ui_lineage__:turnvisuals-"));
      expect(conv.length).toBeGreaterThanOrEqual(1);
      expect(title).toHaveLength(1);
      expect(turn.length).toBeGreaterThanOrEqual(1);
      expect(lines).toHaveLength(1);
      expect(conv[0]).toMatch(new RegExp(`^h_${HANDLE}\\.c-${TOKEN}(~\\d+)?$`));
      expect(title[0]).toMatch(new RegExp(`^h_${HANDLE}:chat-title-${TOKEN}$`));
      expect(turn[0]).toMatch(new RegExp(`^h_${HANDLE}:visualize-turn-${TOKEN}-\\d+(-r\\d+)?$`));
      expect(lines[0]).toMatch(new RegExp(`^__loom_ui_lineage__:turnvisuals-${HANDLE}-${TOKEN}-\\d+$`));
      for (const id of [...conv, ...title, ...turn, ...lines]) {
        expect(id).not.toMatch(UUID_ANYWHERE);
        for (const plain of [user.userId, user.chatId, user.documentId, user.tenantId])
          expect(id).not.toContain(plain);
      }
      expect(all.some((id) => id.startsWith(`u_${user.userId}.c-`))).toBe(false); // no old-format chat execution was made
      // The control: before the erasure the status rows link the handle to the user, so the linking helper is not blind.
      expect(
        await rowsLinkingHandleToIds(st.db.owner, handle, [user.userId, user.chatId]),
      ).toContain("public.read_model_state");

      user.executions = all.filter(
        (id) => namesUserForTest(id, user, handle) && !id.startsWith("__loom_ui_lineage__:"),
      );
      expect((await eraseMe(st, login.cookie)).status).toBe(202);
      await waitErased(st, user.userId, 120_000);
      await assertErased(st, user, { tenantGone: true });
      expect(await rowsLinkingHandleToIds(st.db.owner, handle, [user.userId, user.chatId, user.documentId])).toEqual([]);
      expect((await scanTables(st.db.owner, [user.chatId])).hits.filter((h) => h.table !== "public.erasure_requests")).toEqual([]);
      // The turn's line is erased with the handle's key.
      const lineage = visualsLineage({
        events: st.durable.storage.eventStore,
        content: st.composed.lineageContent,
        keys: st.keys,
        subjectOf: subjectOfExecution,
      });
      expect(await lineage.resolveLatest(line)).toMatchObject({
        ok: false,
        refusal: { kind: "refused", finding: { code: "line-erased" } },
      });
    },
    WAIT,
  );

  it(
    "a mixed history: an old chat continues in the old format beside a new chat; erasing removes both",
    async () => {
      const first = track(await startIngestStack({ chat: true, visuals: true }));
      stubPaymentVisuals(first.visualsClaude as FakeAnthropic);
      const login = await first.signUpAndLogIn("mixed@example.com");
      // The old chat, as every chat before this release: seeded with a turn, a title and (visuals on) a turn visuals line under `u_`.
      const user = await seedUser(first, login, "mixed@example.com", { chat: "legacy" });
      expect(user.chatFormat).toBe("legacy");
      const who = { tenantId: user.tenantId, userId: user.userId };
      const oldIds = await first.runIds.chat(who, user.chatId);
      expect(oldIds?.format).toBe("legacy");
      expect(oldIds?.conversationId()).toBe(`u_${user.userId}.c-${user.chatId}`);
      const oldOrd = await replyOrd(first, login.cookie, user.chatId);
      await lineageHead(first, oldIds?.turnExperienceId(oldOrd) as string);

      // A new chat of the same user, then a cold restart.
      const fresh = ChatSessionDto.parse(
        await (await first.chatReq(login.cookie, "POST", "/api/chats", {})).json(),
      );
      user.moreChatIds = [fresh.id];
      await first.close({ keepDb: true });
      stacks.splice(stacks.indexOf(first), 1);
      const st = track(
        await startIngestStack({
          chat: true,
          visuals: true,
          resume: { db: first.db, kek: first.kek, root: first.root },
        }),
      );
      stubPaymentVisuals(st.visualsClaude as FakeAnthropic);
      const claude = st.claude;
      if (!claude) throw new Error("no fake Claude");
      scriptChat(claude, () => ({ stream: { steps: [{ text: "More." }, { stop: "end_turn" }] } }));
      const ask = async (chatId: string) => {
        const stream = await st.openChat(login.cookie, chatId);
        try {
          const sent = await st.chatReq(login.cookie, "POST", `/api/chats/${chatId}/messages`, { text: "And then?" });
          expect(sent.status).toBe(202);
          await collectUntil(stream, (f) => isReply(f) && (f.data as { text?: string }).text === "More.");
        } finally {
          stream.close();
        }
      };
      await ask(user.chatId); // the old chat continues
      await ask(fresh.id); // the new chat answers

      const all = (await st.durable.raw.eventStore.listExecutions?.()) ?? [];
      const oldConv = all.filter((id) => id.startsWith(`u_${user.userId}.c-${user.chatId}`));
      expect(oldConv.length).toBeGreaterThanOrEqual(1); // one chat never mixes formats: only u_ ids belong to the old chat
      const newIds = await st.runIds.chat(who, fresh.id);
      expect(newIds?.format).toBe("opaque");
      const handle = new RegExp(`^h_(${HANDLE})`).exec(newIds?.conversationId() as string)?.[1] as string;
      expect(all.some((id) => id.startsWith(`h_${handle}.c-${TOKEN}`) && id.includes(".c-"))).toBe(true);
      // no h_ execution belongs to the old chat and no u_ execution to the new one
      const userIds = st.composed.ids.cached(user.userId);
      if (!userIds) throw new Error("the new chat should have minted the user's handle");
      const oldChatToken = opaqueBuilders(userIds, user.chatId).conversationId().split(".c-")[1] as string;
      expect(oldChatToken).toMatch(new RegExp(`^${TOKEN}$`)); // the control: the token the old chat WOULD have under h_ is a real token
      expect(all.filter((id) => id.startsWith("h_") && id.includes(".c-") && id.includes(oldChatToken))).toEqual([]);
      expect(all.filter((id) => id.startsWith(`u_${user.userId}`) && id.includes(fresh.id))).toEqual([]);
      expect(all.some((id) => id.startsWith(`u_${user.userId}:chat-title-${user.chatId}`))).toBe(true); // the old chat's title stayed old
      expect(all.filter((id) => id.startsWith(`h_${handle}:chat-title-`))).toHaveLength(1); // one title for the new chat, none doubled for the old one

      user.executions = all.filter((id) => namesUserForTest(id, user, handle) && !id.startsWith("__loom_ui_lineage__:"));
      expect((await eraseMe(st, login.cookie)).status).toBe(202);
      await waitErased(st, user.userId, 120_000);
      await assertErased(st, user, { tenantGone: true }); // legacy chat: its lineage line is the allow-listed residual (Who.legacyChats)
      expect(await rowsLinkingHandleToIds(st.db.owner, handle, [user.userId, user.chatId, fresh.id])).toEqual([]);
    },
    WAIT,
  );

  it(
    "a chat parked mid-turn when the erasure starts: the stop closes the h_ conversation and the erasure completes with nothing linkable",
    async () => {
      const first = track(await startIngestStack({ chat: true }));
      const claude = first.claude;
      if (!claude) throw new Error("no fake Claude");
      const login = await first.signUpAndLogIn("parked@example.com");
      const user = await seedUser(first, login, "parked@example.com");
      expect(user.chatFormat).toBe("opaque");
      scriptChat(claude, () => ({ stream: { steps: [{ text: "Due " }, { hold: true }, { text: "now." }, { stop: "end_turn" }] } }));
      const sent = await first.chatReq(login.cookie, "POST", `/api/chats/${user.chatId}/messages`, { text: "Hold on" });
      expect(sent.status).toBe(202);
      const gate = await claude.streamHold(); // the model call is under way
      const handle = handleOfExecutions(user.executions) as string;
      try {
        expect((await eraseMe(first, login.cookie)).status).toBe(202);
        await waitErased(first, user.userId, 120_000);
      } finally {
        gate.release();
      }
      user.executions = ((await first.durable.raw.eventStore.listExecutions?.()) ?? []).filter(
        (id) => namesUserForTest(id, user, handle) && !id.startsWith("__loom_ui_lineage__:"),
      );
      await assertErased(first, user, { tenantGone: true });
      expect(await rowsLinkingHandleToIds(first.db.owner, handle, [user.userId, user.chatId])).toEqual([]);
      // The stop repeated after the park cancels only under live subjects: no denial naming the actor was written on the shredded h_ stream.
      expect(await deniedOnHandle(first, handle)).toBe(0);
    },
    WAIT,
  );
});

/** Every EXECUTION_DENIED row on any `h_<handle>` stream: a denied cancel would put the actor's UUID there in the clear (as `erasure.resume.e2e.pg.test.ts` checks for its parked tests). */
const deniedOnHandle = async (st: IngestStack, handle: string) =>
  (
    await st.db.owner.query(
      "SELECT count(*)::int AS n FROM loom.events WHERE execution_id LIKE $1 AND event_type = 'EXECUTION_DENIED'",
      [`h_${handle}%`],
    )
  ).rows[0].n as number;

/** Whether an execution id names the user (the UUID) or the handle: the executions to judge after the erasure. */
const namesUserForTest = (id: string, user: { userId: string }, handle: string) =>
  id.includes(user.userId) || id.includes(handle);
```

Add the imports the block needs: `handleOfExecutions` from `./e2eSupport`; `scriptChat`, `collectUntil`, `isReply` from `../chats/e2eSupport`; `ChatSessionDto`, `ListMessagesResponse` from `@docmind/contracts`; `opaqueBuilders` from `../chats/chatIds`. The phase 1 test's `stubVisuals(claude)` of this file (it labels `Payment-due-days` and, unlike the shared `stubVisuals` of `visualsE2eSupport.ts`, extracts a fact from whatever document it is shown) is what the new tests need: `seedUser`'s document is `DOC` plus a sentinel, with no `LABEL`, so the shared LABEL-gated stub would extract no fact and no turn visuals could ever commit. Rename the local function `stubPaymentVisuals` (its definition and its one phase 1 call at `stubVisuals(st.visualsClaude as FakeAnthropic)`), call it in the new tests, and do not import the shared stub here (import it, as `stubFigureVisuals`, only into a test that uploads `FIGURE_DOC`). In the phase 1 test, its comment "Seeded on a chat-only stack: a chat turn's visuals lineage is still old-format until phase 2, and is judged by its own tests." becomes "Seeded on a chat-only stack with a legacy chat (pinned in Task 3): its turn visuals lineage is old-format (O7) and is judged by its own tests.", and the control comment "the old-format chat still holds the user" stays as it is (the pinned test still has a legacy chat, and its `.some(id.startsWith("u_<user>"))` assertion stays true).

- [ ] **Step 5: Run the end to end tests**

Run: `cd apps/server && set -a; . /Users/such/workspace/docmind/.env; set +a; pnpm exec vitest run app/erasure/opaqueIds.e2e app/chats/visuals`
Expected: PASS. Failures to expect and how to read them: a `loom.events.payload` hit on a chat execution means a conversation field is still plain (Task 2); a `u_` execution for a chat created through the API means a call site still builds legacy ids (Task 4); `turnvisuals-<userId>` hits for the new chat mean the allow-list entry still applies to it (Task 3 step 3d); a lineage id without an erasure refusal means the turn commit wrote the wrong line.

- [ ] **Step 6: Run the whole server suite**

Run: `cd apps/server && set -a; . /Users/such/workspace/docmind/.env; set +a; pnpm exec vitest run`
Expected: PASS (about 200 seconds). Any failure that names a `u_` expectation for a chat made through the API is a test to migrate (read the chat's format from the stack), not a regression.

- [ ] **Step 7: Typecheck, lint, commit**

Run: `pnpm exec biome check --write apps/server/app && pnpm typecheck && pnpm typecheck:tests && pnpm lint`

```bash
git add apps/server/app
git commit -m "test(ids): a ratchet for the chat builders; the chat, title and turn visuals end to end, a mixed history and a parked turn, then erase"
```

(append the two trailers)

---

### Task 6: Docs, the spec amendments and the browser check (spec section 6; Spec amendments A to D)

**Files:**
- Modify: `docs/specs/2026-11-10-opaque-ids-design.md`, `docs/architecture.md`, `docs/operations/cloud-deploy.md`, `docs/codebase-guide.md`
- Test: a fence check and the full suite

**Interfaces:**
- Consumes: everything above.
- Produces: the written record. No code.

- [ ] **Step 1: The spec**

Run from the repo root (each replacement must match exactly once; the script asserts it):

```bash
python3 - <<'PY'
p = "docs/specs/2026-11-10-opaque-ids-design.md"
s = open(p).read()
old = s[s.index("  - Until phase 2, a chat's executions"):s.index("- `cloud-deploy.md` notes")]
new = """  - **Legacy chats (phase 2).** A chat created before the phase 2 deploy keeps `u_<user>` ids for all of its executions and its turn visuals lineage for its whole life (its conversation and generations, its title, its turn visuals, its lineage: one chat never mixes formats, so `chat_sessions.id_format` stores which one it uses, migration 0039). That includes the executions such a chat creates after the deploy (a generation, a turn run, a rerun): O7's "new runs use the new format from deploy" applies per chat, not per run. Their content is sealed under the user's key, which erasure destroys, but the ids name the user and the chat and stay readable (O7). A chat created after the deploy is opaque. The end-to-end scan (`opaqueIds.e2e.pg.test.ts`) proves "no linkable id" for new chats and allow-lists a legacy chat's ids only for a user who has one.
"""
s = s.replace(old, new)
amend = """- **Amendment, conversation identities (phase 2):** a conversation writes its owner's `{ actor, tenant }` in plaintext in `EXECUTION_STARTED.input.owner` and in the `sender` of `MESSAGE_CONSUMED`. They are sealed under the subject key like the flow inputs, so a new chat's events hold no plain user or tenant UUID beside its `h_<H>` id. (`INBOX_MESSAGE.sender` is already sealed by Loom under the sender subject, ADR 0139 N6.)
"""
anchor = "- **Amendment, tombstones:**"
assert s.count(anchor) == 1
s = s.replace(anchor, amend + anchor)
old3 = "| Chat conversation | `u_<u>.c-<c>[~n]` | `h_<H>.c-<C>[~n]` |\n"
assert s.count(old3) == 1
note = """
**Amendment (phase 2):** a chat's ids cannot be derived from its UUID, so its format is stored (`chat_sessions.id_format`, `legacy` for every chat that existed at the phase 2 deploy, `opaque` for a chat created after it) and every id of a chat (conversation and generations, title, turn visuals, turn lineage) follows it. A turn's lineage is read from the chat's own line, with no new-then-old fallback (a chat never changes format). O7's "new runs use the new format from deploy" applies per chat: a legacy chat's new runs stay old-format. A Loom conversation id must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`: the new one is 83 characters (93 with a nine-digit generation), and the base32 alphabet `[a-z2-7]` conflicts with nothing in Loom's id rules (no case folding, no `~`, no `::`).
"""
marker = "`D` and `C` are tokens."
assert s.count(marker) == 1
i = s.index(marker)
j = s.index("\n", i)
s = s[: j + 1] + note + s[j + 1 :]
old8 = "**Amendment:** phase 1 tests these piecewise"
assert s.count(old8) == 1
s = s.replace("rather than as one scenario test.", "rather than as one scenario test. Phase 2 adds the one scenario (an old chat continues in the old format beside a new chat, across a cold restart, then both are erased).")
open(p, "w").write(s)
PY
grep -c "Legacy chats (phase 2)" docs/specs/2026-11-10-opaque-ids-design.md
```

Expected: prints `1`. Also update the spec's status line at the top: add "and the phase 2 amendments (a stored chat id format, sealed conversation identities, the legacy-chat residual)" to the parenthesis.

- [ ] **Step 2: `docs/architecture.md`**

```bash
python3 - <<'PY'
p = "docs/architecture.md"
s = open(p).read()
def rep(old, new):
    global s
    assert s.count(old) == 1, old
    s = s.replace(old, new)
rep("Last updated 2026-11-10.", "Last updated 2026-11-11.")
rep("with the id `u_<user>.c-<chat>`", "with the id `h_<H>.c-<C>` (a chat created before phase 2 keeps `u_<user>.c-<chat>` for life; 10.1)")
rep("starts `visualize-turn-<chatId>-<ord>`", "starts `visualize-turn-<chat>-<ord>` (its execution id is `h_<H>:visualize-turn-<C>-<ord>[-rN]` for a new chat; 10.1)")
rep("`turnvisuals-<userId>-<chatId>-<ord>`", "`turnvisuals-<H>-<C>-<ord>` (`turnvisuals-<userId>-<chatId>-<ord>` for a chat created before phase 2)")
old = s[s.index("- **Shapes.** Phase 1 builds"):s.index("- **One module.**")]
new = """- **Shapes.** `h_<H>:ingest-<D>[.g]`, `h_<H>:visualize-<D>[.g][-rN]`, `h_<H>:suggest-tags-<D>-rN` and the lineage line `visuals-<H>-<D>` (phase 1); and, for a chat created after phase 2, the conversation `h_<H>.c-<C>[~n]`, the title `h_<H>:chat-title-<C>`, a turn's visuals `h_<H>:visualize-turn-<C>-<ord>[-rN]` and its lineage `turnvisuals-<H>-<C>-<ord>`. Runs from before the deploy keep their old ids and are read through the same module (dual-format parsing); nothing is renamed.
- **A chat has one format.** `chat_sessions.id_format` (migration 0039) is `legacy` for every chat that existed at the phase 2 deploy and `opaque` for a chat the create route makes. `chats/chatIds.ts` (`ChatIdResolver`) turns a chat row or `ChatRef` into one set of builders in that format (`forRow`, `forRef`; `forNew` mints), and every chat route, the title flow and the turn-visuals flow get their ids from it, so a chat's conversation (and its generations), title, turn runs and lineage line never mix formats. A legacy chat keeps `u_<user>` ids for life, and its turn lineage is read from its own line. Only the resolver and the eraser call a chat family's builder (`executionIds.test.ts`).
"""
s = s.replace(old, new)
rep("- **Flow inputs are sealed.** The user, tenant and document ids in a new-format flow's input are sealed in the log, so no plain UUID appears in an `h_` execution.",
    "- **Flow inputs and conversation identities are sealed.** The user, tenant, document and chat ids in a new-format flow's input are sealed in the log, and so are a conversation's `EXECUTION_STARTED.input.owner` and the `sender` of its `MESSAGE_CONSUMED` events (`sensitive.ts`; Loom itself seals the inbox copy of the sender), so no plain UUID appears in an `h_` execution.")
rep("- **Residuals.** Old-format ids stay readable after an erasure;", "- **Residuals.** Old-format ids stay readable after an erasure, and that includes every execution and turn visuals line of a chat created before phase 2;")
open(p, "w").write(s)
PY
```

- [ ] **Step 3: `cloud-deploy.md` and the codebase guide**

In `docs/operations/cloud-deploy.md`, directly after the migration `0038` bullet add:

```markdown
- Migration `0039` (chat id format) adds `chat_sessions.id_format` (`NOT NULL DEFAULT 'legacy'`, a constant default, so no rewrite and a
  brief lock). Every existing chat is `legacy` and keeps its `u_` ids for life; a chat created after the release is `opaque` and its
  conversation, title and turn visuals are `h_<handle>` ids. Rolling back after the first `opaque` chat exists is not supported for the
  same reason as `0038` (older code cannot parse its ids, and would answer 404 for it); roll forward with a fix release. During a rolling
  deploy a chat created by a new pod answers 404 on an old pod until that pod drains.
```

In `docs/codebase-guide.md` add one row after the `opaqueIds/` row: `| apps/server/app/chats/chatIds.ts | Builds a chat's Loom ids in the chat's own format (legacy or opaque, chat_sessions.id_format) |`.

- [ ] **Step 4: Check the fences and run everything**

Run: `awk '/^```/{ if (open) { open=0 } else { open=1 } } END { if (open) { print "unclosed fence"; exit 1 } }' docs/superpowers/plans/2026-11-11-opaque-ids-phase2.md && pnpm exec biome check . && pnpm typecheck && pnpm typecheck:tests && cd apps/server && set -a; . /Users/such/workspace/docmind/.env; set +a; pnpm exec vitest run`
Expected: no output from `awk`, lint and typechecks clean, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add docs
git commit -m "docs(ids): phase 2 of the opaque ids: the chat flows, the stored chat format, the legacy-chat residual"
```

(append the two trailers)

- [ ] **Step 6: The browser check (the controller runs it; the user approves it before the PR)**

This task step describes the check; it changes no file. Preconditions: the branch's migrations applied (the dev server runs them on boot), chat and the visuals role configured in `.env` as for the earlier visuals checks, a dev database with at least one chat created BEFORE this branch (an old chat) and one document with a figure. Start the server from the worktree with the usual run script; do not point it at the test database.

1. **An old chat continues in the old format.** Open an existing chat in the browser, send a message, wait for the reply and (if the chat was untitled) the title, then use "Visualize" on a cited reply. Expected: the reply streams, the history reloads intact, visuals render. Then, read-only against the dev database: `SELECT id_format FROM chat_sessions WHERE id = '<that chat id>'` is `legacy`, and every `loom.events.execution_id` that contains that chat's UUID (`SELECT DISTINCT execution_id FROM loom.events WHERE execution_id LIKE '%<chat id>%'`) starts with `u_` or `__loom_ui_lineage__:turnvisuals-<user id>-`; none starts with `h_`.
2. **A new chat is opaque.** Create a new chat, ask a question that cites the figure document, and watch it stream. Expected: the reply, the citation chips, the auto title (within a few seconds) and the visuals strip (automatic pass, then on-demand "Visualize" for another turn) all work as before; reload the page mid-answer and the stream resumes. Read-only: that chat's row is `opaque`; `SELECT DISTINCT execution_id FROM loom.events WHERE execution_id LIKE 'h\_%' AND execution_id ~ '\.c-|chat-title|visualize-turn|turnvisuals'` lists `h_<handle>.c-<token>`, `h_<handle>:chat-title-<token>`, `h_<handle>:visualize-turn-<token>-<ord>` and `__loom_ui_lineage__:turnvisuals-<handle>-<token>-<ord>`, and a regex for a UUID (`[0-9a-f]{8}-[0-9a-f]{4}-`) matches none of them.
3. **Both chats side by side.** The chat list shows both, with titles and counts; open each, send one more message to each; stop a running answer in the new chat with the Stop button (it must interrupt), delete the new chat (the list drops it, no error in the console).
4. **Erasure of a throwaway account (never the real one).** Sign up a second account, create a chat, ask a cited question, wait for the title and visuals, then delete the account in Settings. Expected: logged out, login refused. Read-only: `SELECT count(*) FROM loom.events WHERE execution_id LIKE 'h\_<that handle>%' AND payload::text ~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'` is `0` (take the handle from `SELECT id_handle FROM users` BEFORE the deletion), `SELECT count(*) FROM read_model_state WHERE execution_id LIKE 'h\_<handle>%' AND (scope IS NOT NULL OR app_key IS NOT NULL)` is `0`, and `public.data_keys` holds a destroyed row for `h_<handle>` with the epoch `created_at` and `destroyed_at`.
5. Browser console: no errors beyond the usual dev-server noise; the server log shows no `chat title start failed`, `visualize-turn start failed` or `recovery failed` lines.

Report each of the five with a screenshot or the query result (ids only, no content) and wait for the user's approval before opening the PR.

---

## Self-review

**1. Spec coverage** (the task that implements each):

| Spec | Task |
|---|---|
| §3 rows Turn visuals, Chat title, Chat conversation, Turn lineage (build, both formats) | Task 4 (the builders are `UserIds.*` behind `ChatIdBuilders`; the parse side is phase 1) |
| O7 old `u_` chats keep working, no backfill | Tasks 1 (the stored format; the default is legacy for every existing row; nothing is renamed), 4 (every route, the title and the turn flows follow the row), 5 (the mixed-history scenario) |
| §4 cache fill at the async entry points | Task 4 (`forNew` ensures at create, `forRow`/`forRef` load without minting, the trigger already ensures; boot warm and the ensure gate are phase 1), Task 5 (cold restart) |
| §5 key outage fails the start; erased id is null | Task 4 (`forNew` throws before any row exists; `forRow`/`forRef` return null for an erased owner), Task 1 test |
| §6 no UUID in a new id, timer, lease or log line | Tasks 1, 4, 5 (shapes and regexes asserted on live ids) |
| §6 flow inputs sealed | phase 1 (`input.chatId` is in `FLOW_INPUT_IDS`) plus Task 2 for the conversation's own owner and sender |
| §6 erasure covers both prefixes, stops and cancels chats | Task 5 (F7: the existing stop, close and cancel of both formats, with a parked mid-turn chat), Task 1 (the resolver's cache is evicted after the shred, I2) |
| §6 residual bullet amended | Task 6 (Spec amendment A) |
| §8 unit | Task 1 (`chatIds.test.ts`), Task 4 (starter, title, route tests), Task 2 (paths) |
| §8 ratchet | Task 5 step 1 (`chatBuilderCalls`), Task 4 step 5c (`startRatchet`) |
| §8 Postgres | Tasks 1 (`chatIdFormat.pg`, `chatIds.pg`), 2 (`sealedIds.pg`), 4 (`create.pg`, route tests) |
| §8 recovery after a cold restart | Task 4 step 5d (the tool-loop restart, for `h_` and `u_`), Task 5 (restart before the erasure) |
| §8 mixed history | Task 5 (one scenario, Spec amendment D) |
| §8 phase 2 end to end (chat, title, turn visuals, erase, nothing linkable) | Task 5 |
| §8 browser check | Task 6 step 6 |
| docs: architecture.md, spec, cloud-deploy | Task 6 |

**2. Placeholder scan.** No "TBD", "TODO", "implement later" or "similar to Task N" remains. Two steps give a transformation plus the compiler's list rather than every line, because the lines are the compiler's: Task 1 step 7 (a mechanical identifier rename with a script) and Task 4 step 5 (a script for the turn builders, then "let `typecheck:tests` drive the remainder": each remaining error is one of four named shapes). Task 4 step 1 uses the real names of the existing harnesses (`create.pg.test.ts`: `h.req`, `h.fake.calls`, `h.owner`, `h.ids`; `start.test.ts`: `fake()`, `options()`, `ref`, `settled()`), and gives the test bodies and assertions in full.

**3. Type consistency.** Names used across tasks: `ChatIdFormat`, `ChatOwner`, `ChatIdBuilders` (`format`, `conversationId`, `titleExecutionId`, `turnExecutionId`, `turnExperienceId`), `ChatIdResolver` (`forRow`, `forRef`, `forNew`), `legacyBuilders`, `opaqueBuilders`, `PgChatIds`, `fixedChatIds`, `loadChatWithIds`, `legacyChatConversationId`, `legacyTurnExecutionId`, `legacyTurnExperienceId`, `createLegacyChat`, `ChatIdResolver.forgetUser`, `ErasureParts.chatIds`, `stubPaymentVisuals`, `Seeded.chatFormat`, `Seeded.moreChatIds`, `Who.legacyChats`, `composed.chatIds`, `runIds.chat`, `insertChat(..., idFormat)`, `ChatSessionRow.id_format`. The resolver's method names (`conversationId`, `titleExecutionId`, `turnExecutionId`, `turnExperienceId`) are deliberately not the names the Task 5 ratchet flags (`conversation`, `chatTitle`, `turnVisualize`, `turnLineage`). A task's Interfaces block names only what the earlier tasks produced.
