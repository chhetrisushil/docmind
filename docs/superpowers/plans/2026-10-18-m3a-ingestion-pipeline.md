# DocMind M3 part 1 (Ingestion pipeline on txt) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After M3 part 1, uploading a `.txt` file takes a document from `uploaded` to `ready` through the real durable `ingest-document` flow: the original is read from the encrypted blob store, parsed in a resource-limited child process, split into section-bounded chunks (~600 tokens, ~15% overlap, each with a locator) that are stored with sealed text, embedded in batches of 64 by a local Ollama model, and the vectors are stored in pgvector by chunk id. a document's status is a durable Loom folded-state read model of the flow's events (`documents.status` is gone), progress streams to the browser over `GET /api/documents/events` (SSE), and the analyze, summarize and link steps exist as named no-op placeholders that part 2 fills. A sweep restarts documents stranded in `uploaded`, a delete that races a running step stops it cleanly, and the M2 stub is retired. This covers spec §9 items 12, 13, 14, 21, 22 and 23.

**Architecture:** One flow, `ingest-document`, with a durable `step$` per spec §5.2 plus `link` (linked-retrieval design note): `parse -> chunk -> embed -> analyze -> summarize -> link -> finalize`. Loom has no per-flow dependency argument, so each step's effect is registered by `buildApp` from an `IngestDeps` bundle that the composition root builds (blob store factory, `FieldCrypto`, parser registry and runner, chunk and vector stores, embedder, status store). Every effect is built by one wrapper, `stepEffect`, which turns "document, row, key or blob is gone" into the clean outcome `document_gone`, turns a permanent content problem into a terminal `failed` outcome with a fixed code, and rethrows anything else with a fixed message. No step writes a status: an `ingest-status` folded model (`@loom/plugin-read-model`, ADR 0132, in DocMind's own `public` tables under row-level security) folds the flow's events, feeds the SSE bus after each fold, and is what the list and detail routes read (Revision 2026-10-19). Steps pass ids and counts only; the parsed text travels between `parse` and `chunk` through a sealed row (`parsed_documents`) that the chunk step deletes, so no document text is ever in the event log. Parsers run in a short-lived Node child process under the Node permission model (no filesystem or process access), a heap limit and a wall-clock kill.

**Tech Stack:** everything in M0-M2, plus Node >=22.13 (`--permission` child processes), `@loom/plugin-read-model` (folded-state read models, with the Postgres store from `@loom/plugin-postgres`), `@loom/memory` (the `EmbeddingProvider` type), `@loom/classify` (`sensitive(...)`), `@loom/conformance` (`runEmbeddingProviderConformance`), `typescript` (compiler API, used by one test), Ollama's `/api/embed` over `fetch`, and the Postgres `vector` extension (pgvector). Loom is linked from `../loom` at the commit CI pins: `8f9eab2492c85bb994d746855f06d2eccc9f45db` until Task 74b moves the pin to `006dfdaf63319fa61594c42e2d5b2c8b87add2ca` (ADR 0132, folded-state read models).

**Spec:** `/Users/such/workspace/docmind/docs/specs/2026-10-18-docmind-design.md` (§3 layout and interfaces, §4.2 tables, §4.3 tenancy, §4.4 crypto-shredding, §5.2 flow, §5.3 parsers, §8 gates and PR rules, §9 items 12-14 and 21-23). Accepted design note this plan must not block: `/Users/such/workspace/docmind/docs/design/linked-retrieval.md`. Model plan for structure: `/Users/such/workspace/docmind/docs/superpowers/plans/2026-10-18-m2-document-storage.md` (its sizes were badly low; the sizes here are counted, see the note under the task index). Executors read all of them.

## Revision 2026-10-19: the document status is a Loom folded-state read model

This section **replaces Finding F5 and owner decision 4**. Loom now has durable per-execution projections: `@loom/plugin-read-model` folded models (ADR 0132, Accepted), merged at Loom `main` `006dfdaf63319fa61594c42e2d5b2c8b87add2ca` and built. The owner decided that DocMind's document status must use them. Everything below was read from that checkout (`docs/adr/0132-folded-state-read-model.md`, `docs/plugins.md` "Folded-state models", `docs/api-reference.org`, `plugins/read-model/src/*`, `plugins/postgres/src/{foldedState,PostgresReadModelStore,index}.ts`) and from DocMind `main` (`50010f6`: `compose.ts`, `main.ts`, `config.ts`, `storage.ts`, `documents/*`, `flows/ingest-document/*`, `subject.ts`, `infra/migrations`, `db/{tenant,pool,migrate}.ts`). Where this section and an older task text disagree, this section wins and the task has been rewritten to match.

**Design (R1 to R9).**

- **R1. The model.** `ingest-status` is a `projection$` (`version: "1"`) registered with `ReadModelService.registerFolded({ projection, keyOf, scopeOf })`. State: `{ status: DocumentStatus; step: IngestStep | null; code: FailureCode | "internal" | null }`, enums only. Handlers: `EXECUTION_STARTED` (creates the row), `STEP_STARTED` (the step's status, Decision D7), `STEP_COMPLETED` (`outcome: "failed"` -> `failed` with the code; `ingest-finalize` with `outcome: "done"` -> `ready`), `EXECUTION_FAILED` (-> `failed`, code `internal`, unless a specific code is already there). `keyOf(executionId)` = the document id parsed from `u_<userId>:ingest-<documentId>[.<generation>]` (so `.2` maps to the same document); `scopeOf` = the user id; both return `undefined` for any other execution id. Loom keeps one row per execution (per generation); the reader picks the highest generation. Every value is recomputed from the log: `rebuild` equals incremental, and a version bump re-folds at boot.
- **R2. Which database and which role.** The folded tables live in **DocMind's own schema, `public`**, as `read_model_state` and `read_model_folds`, created by DocMind migration `0012` from the exact text of `foldedStateDdl({ schema: "public" })` (D10) and owned by the migrator. Not in schema `loom`: `assertUnprivilegedRole` (which `main` already runs on the `LOOM_DATABASE_URL` pool) refuses a role that owns a table with row-level security, so `docmind_loom` may not own these tables; and the policy must read `users` (public), and `docmind_app` must not gain access to schema `loom`. **Writer:** `ReadModelService` over `new PostgresReadModelStore(loomPool, { schema: "public", manageSchema: false })`, running on the pool `openDurableStorage` already opens (`LOOM_DATABASE_URL`, role `docmind_loom`, which gets `SELECT, INSERT, UPDATE, DELETE` on exactly these two tables and a `FOR ALL USING (true) WITH CHECK (true)` policy). **Reader:** a per-request `PostgresReadModelStore` over a pool-like whose `query` runs inside `withTenant` on the `docmind_app` pool (`manageSchema: false`), so the policy `tenant_read` (`scope` -> `users.id` -> `tenant_id = app_tenant_id()`) sees the caller's tenant; `docmind_app` has `SELECT` on `read_model_state` only. A `CHECK` constraint pins `scope` to a canonical uuid so the policy's `scope::uuid` cannot raise. The writer role can read every tenant's status rows (ids and enums only); it can already append to every tenant's log.
- **R3. Feed and boot order.** `observability.onEvent` (through `FlowDeps.onEvent` in `buildApp`) calls `IngestStatus.onEvent`, which calls `service.handleEvent`. `IngestStatus.boot()` runs `register -> catchUp([eventStore])`, and `main` awaits it after `buildServer` and before `listen` (the `onEvent` hook is already installed by then and is a no-op until `registerFolded` has run; events in between are healed by `catchUp`, ADR 0132 D13). `liveSource` is the node's own (decrypting) event store, because DocMind resumes executions and a resumed execution's first event on a fresh node is not sequence 0 (`plugins.md` note 4). A `catchUp` failure (poison event, sensitive-state refusal, gap) makes `boot()` throw, so the server does not start (Open question R5).
- **R4. Sensitive map and compaction.** `ReadModelService` gets `sensitive` = `mergeSensitive(sensitivePathsFromSteps(allFlowSteps), sensitiveMapFromCovers(eventStore.sealingCapability()?.covers ?? []))`, computed **after** `defineConfig`, because only then have the framework-sealed paths (`EXECUTION_STARTED` `principal.identity.*`, `OUTCOME_RECORDED.recordedBy`) been registered with the encrypting store. Editing the map re-folds the model automatically (the version digest includes it). `buildApp` also sets `durability.retention.compactionExempt` to "is an ingest execution" (a fold needs the contiguous log; DocMind configures no retention yet, so this is the one line that keeps a later retention from breaking the model).
- **R5. Reads.** The list fetches its page under tenant RLS (unchanged), then asks the **reader store** `getFoldedByKey("ingest-status", pageDocIds)` and `foldedStates(...)` (the recipe of `plugins.md`; every `service.*` call runs as the writer role, which has no tenant policy, so the list does not use it). One round trip, at most 100 keys. A document with no row yet is `uploaded`. `GET /api/documents/:id` and the duplicate-upload response read-repair the one document the request touched: `service.getMany("ingest-status", [executionId], { refreshFrom: [eventStore] })`, one log-tail read, then the reader.
- **R6. SSE.** `IngestStatus.onEvent` calls `service.handleEvent(event)` and then schedules a publish on a single promise chain: `await service.drain()`, then `bus.publish(...)`. The progress event is derived by a pure function (`progressOf`) from the same handlers the model folds with. Chosen over publishing from the step effect (the previous design) because the effect runs **before** its `STEP_COMPLETED` is appended and cannot see crash recovery, resumed executions or a failure the kernel records; publishing after the node's durable apply means a client that refetches on an event never reads an older status, and the effects stay free of any bus (Open question R3). Limits: `drain()` waits for every in-flight apply on the node, so latency is the slowest concurrent apply (a database write); an apply that fails is reported to `onError` and the event is still published, since the log is the authority and the next `catchUp` heals the row; an unexpected `EXECUTION_FAILED` moves the state to `failed` but emits no SSE event in part 1 because the contract's `step` is required.
- **R7. `documents.status` and `documents.error` are dropped** (migration `0013`, Task 79c). The status of a document is the model's state; a document with no row is `uploaded`; `error` is a fixed message derived from the code at read time. Only the pre-flow state needed anything stored, and it needs no column: the stale-upload sweep (Task 93) finds documents whose generation-2 execution has no row in `read_model_state`, by one anti-join in a `SECURITY DEFINER` function (both tables are in `public`). The sweep calling `start` for a document whose row has not been folded yet is harmless: `start` is start-once. Keeping a column that nothing writes would only be a second source of truth that can disagree (Open question R2).
- **R8. Erasure.** The delete route cancels the flow, then `forgetDocument` = `purgeFolded("ingest-status", { key: documentId })` (a tombstone that keeps `sequence`, `execution_id`, `scope`, and nulls the state; later events cannot resurrect it), then removes the row and blob. User erasure (M5) does rows, then blobs, then the key, **then `purgeFolded({ scope: userId })`** (`IngestStatus.forgetUser`); the table has no foreign key to `users`, so deleting the user does not cascade. Task 74e proves both. Carry-forward for M5: a model rebuild reads the log through the decrypting store; after a key is destroyed that read must use a shredding-tolerant source (the handlers already skip `{ $shredded: true }` payloads).
- **R9. Pins and dependencies.** DocMind's CI `LOOM_REF` moves from `8f9eab24` to `006dfdaf63319fa61594c42e2d5b2c8b87add2ca` (Task 74b), `@loom/plugin-read-model` joins the root `pnpm.overrides` and `apps/server` dependencies, and `@loom/event-runtime` joins both as a dev dependency for tests (Task 74b).

**What does not change.** The step effects still do the work and nothing else; a step still stops with `document_gone` when its document is gone (a `StepGuard` check replaces the status write that used to double as that check); the flow returns early on `document_gone` or `failed`; execution ids, the ids-only start input and the content-free log are untouched.

**Loom API notes (things that did not fit DocMind as built).** (1) A folded model folds **every** execution's handled events: the definition has no execution filter and ignores `sourceFlowId`, so any other flow (chat in M4) would write a `read_model_state` row per execution (`state` = the initial state, `app_key` and `scope` NULL because `keyOf`/`scopeOf` return `undefined`). Those rows are inert (no tenant can read a NULL scope) but are not free; the proposal for Loom is an optional `accepts(executionId): boolean`. (2) `getManyByKey` returns one record per generation, so DocMind owns the "highest generation wins" rule. (3) `getManyByKey(..., { refreshFrom })` cannot discover an execution that has no row, so the one-document path refreshes by execution id. (4) `catchUp` scans every execution at every boot (cost grows with history) and is shared, so one poisoned execution stops the whole scan. (5) The service is bound to one store, so every `service.*` call runs as the writer role with no tenant RLS; the read-only request path has to use a second store's `getFoldedByKey` plus `foldedStates` (and `service.getMany` is used only for the one document a route has already authorised). (6) Sealing covers can only be read after `defineConfig`, so `onEvent` must be a closure over a service constructed afterwards.

## Global Constraints

Copied from the spec and the owner's standing rules; every task includes them.

- **PR size:** at most **200 changed lines and 10 files** per PR (one task = one PR). `pnpm-lock.yaml`, the generated `apps/server/app/loom.gen.ts` and binary fixtures do not count but are listed in the PR description. Tests ship in the same PR as the code they test. The sizes in the task index were estimated by counting fenced code lines per task and adding 12% for Biome formatting; if `git diff --stat` shows more than 200 lines or 10 files, split along the seam named in that task's close-out step instead of trimming tests. Target is 120-160 lines.
- **PR rules:** each PR leaves `main` green and has no half-built **reachable** path (an unreachable library that a later task wires up is fine); branch names `feat/<area>-<thing>`; Conventional Commits; PRs are **stacked** (each branch is cut from the previous task's branch), opened as **drafts** (`gh pr create --draft`; CI skips drafts), and the owner merges them with **rebase and merge** (`gh pr merge --rebase`, never squash or a merge commit). Executors never merge.
- **Commit trailer:** every commit ends with the line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Every PR description ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **The local gate is the merge gate**, run with `DOCMIND_TEST_PG_URL` exported **in the same shell command** so the Postgres suites run instead of skipping:
  `export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:55432/postgres && pnpm lint:fix && pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`.
  Suites that need pgvector (Tasks 84, 89, 95a and 95b) additionally need a database with the `vector` extension; see Preconditions. A task whose Postgres suite is skipped has not passed its gate, and the PR description must say which tests skipped and why.
- **Test hygiene (Loom's AGENTS.md and the M2 lessons):**
  - Every rejection assertion pins its error: `rejects.toBeInstanceOf(X)` or `rejects.toMatchObject({ name, code })`, `toThrow(/exact text/)`; never a bare `toThrow()` or `rejects.toThrow()`.
  - No sleeps and no timing assertions. Wait on a condition (a promise the code under test settles, an event, a gate the test opens). A configured limit that the code enforces with a timer (a child process wall clock) is set small in the test and awaited as a rejection; the test never asserts how long it took.
  - No "plaintext absent" probes over random ciphertext (a random blob can never contain a short string, so the probe proves nothing). Prove sealing positively: read through the sealed store and get the value, read the raw store and get an envelope (`__loomEnc`), and assert the raw JSON lacks the value only for text long enough to be unmistakable (>= 12 characters).
  - Test servers bind `127.0.0.1`; every Postgres suite makes its own database with `createTestDb()`; test files are typechecked.
  - Untrusted streams (child process stdio, HTTP response bodies, SSE sockets, upload bodies) are drained or closed on every path, including errors; a test per path proves the handle is released (`child.exitCode !== null`, socket `destroyed`).
- **Never log, print, return in an error, or put in a test name or snapshot:** connection strings, passwords, the KEK or any data key, emails, session tokens, **filenames, titles, document text, chunk text, summaries, or ids that sit beside content**. Logs carry the error class and the method and path only (`console.error("sweep failed", err instanceof Error ? err.constructor.name : typeof err)`). Error messages name variables (`DOCMIND_PARSE_TIMEOUT_MS must be a positive integer`), never values. A flow step failure message lands in the event log, so `stepEffect` rethrows with a fixed message.
- **Tenancy:** RLS on every table (`tenant_id = app_tenant_id()`), every query runs inside `withTenant`, owner scoping (`owner_id = $user`, or a join to `documents`) on every read and write of a user's rows; nothing downstream accepts a tenant or user id from the client; the app role owns nothing and has no `BYPASSRLS`. The two folded-state tables (Task 74a) carry no `tenant_id`: their policies map `scope` (a user id) to the tenant through `users`. The cross-tenant paths are exactly two: the status model's writer (the `docmind_loom` role, a `FOR ALL` policy on those two tables only) and the sweep (Task 93), which goes through a narrow `SECURITY DEFINER` function with `SET search_path = pg_catalog, pg_temp`, schema-qualified names, `REVOKE ALL ... FROM PUBLIC` and an explicit `GRANT EXECUTE ... TO docmind_app`.
- **Encryption (spec §4.4):** `chunks.text_enc` and `parsed_documents.body_enc` are sealed with `FieldCrypto` under the owning user's data key, bound to row and column (`chunk:<id>:text`, `document:<id>:parsed`). `chunks.embedding` is plaintext by design (pgvector compares raw vectors) and is hard-deleted with its row. **Heading text is content**, so the plaintext `chunks.locator` holds only numbers and a kind (see Decision D3); heading paths live inside `text_enc`.
- **Event payloads (M1 and M2 carry-forward):** a flow's start input is `{tenantId, userId, documentId}` and nothing else. Step outputs carry only `outcome`, a `count`, a `model` id and a fixed failure `code`. Any step whose input or output could carry content must mark it `sensitive(...)` and the matching paths must be registered through `apps/server/app/sensitive.ts` **in the same PR**; Task 81 proves, with a raw event-log read like M2's, that nothing sensitive is needed, and Tasks 83, 91 and 92 re-run that proof when they add steps. Execution ids are plaintext and survive erasure: `u_<userId>:ingest-<documentId>.<generation>` only. The `ingest-status` state holds enums and a failure code only; Loom's sensitive-state guard refuses anything else, and its sensitive map is the union of the steps' `sensitive(...)` paths and the encrypting store's sealing covers (Task 79b).
- **Flow lifecycle:** the ingest execution is started **after** the upload transaction commits, never inside it, and a failed start never fails the upload. A delete **cancels the flow first**, then removes the row and blob, but the cancel does not wait for a running step, so **every step treats a missing document row, a foreign-key violation, a destroyed user key and a blob `get() -> null` as `document_gone`** (a clean stop, not a failure). That rule lives in one place (`stepEffect`, Task 73a) so a step cannot forget it. **Steps write no status** (Revision 2026-10-19): a document's status is the `ingest-status` folded model's state, recomputed from the log; routes read it through `IngestStatus` (Tasks 74c, 79c), and a document with no row is `uploaded`.
- **Erasure shape:** `chunks` and `parsed_documents` reference `documents` with a composite `ON DELETE CASCADE` foreign key, so erasing a user (rows, then blobs, then key) removes them with the documents. The status table has no foreign key to `users`, so user erasure also runs `IngestStatus.forgetUser(userId)` (`purgeFolded` by scope, Task 74e); a document delete runs `forgetDocument` after cancelling the flow. `documents.updated_at` has no trigger and nothing updates it after the upload.
- **Migrations:** never edit an applied migration; the next free number is `0010`. This plan adds `0010` (documents composite key), `0011` (chunks and parsed_documents), `0012` (the folded-state tables and their row-level security, Task 74a), `0013` (drops `documents.status` and `error`, Task 79c), `0014` (embedding column, needs pgvector) and `0015` (stale-upload function). Every table has RLS enabled (the M0 guard test fails otherwise). A migration that touches the `vector` type declares `-- requires-extension: vector` (Task 84).
- **Dependency rules:** packages never import from apps; only `loom.config.ts`, `app/config.ts`, `app/compose.ts` and `app/main.ts` choose which implementation backs an interface; no process globals (the parser registry, embedder, vector store, runner and progress bus are constructed in `compose.ts` and passed down; so is the `IngestStatus`, from the stores `main.ts` chooses).
- **Toolchain pins:** `pnpm@9.14.4`, `@biomejs/biome` `1.9.4` (exact), `typescript` `^5.6.3`, `vitest` `^2.1.8`, Node `>=22.13.0` from Task 69 on (the first task that spawns a `--permission` child; CI already runs Node 22).
- **Loom pin:** the `ingest-status` model needs Loom at or after `006dfdaf63319fa61594c42e2d5b2c8b87add2ca` (ADR 0132); Task 74b moves the CI `LOOM_REF`, adds `@loom/plugin-read-model` (and, for tests, `@loom/event-runtime`) to `pnpm.overrides`, and runs the whole gate against it.
- **Document status:** only the `ingest-status` model says what a document's status is; no code reads or writes a `documents.status` column (it is dropped in Task 79c), and no step effect publishes progress.
- **Ollama and pgvector are never required by a default test run.** Ollama tests use a fake HTTP server that passes the same conformance suite; a real-Ollama suite runs only when `DOCMIND_TEST_OLLAMA_URL` is set. pgvector tests skip dynamically when the extension is absent (Task 84 provides the helper).

---

## Findings that shape this plan (verified 2026-10-18)

Read from `/Users/such/workspace/loom` (HEAD `8f9eab24`) and `main` of this repo (`2b2af7a`); the status design was revised on 2026-10-19 against Loom `006dfdaf` and this repo's `50010f6` (see Revision 2026-10-19). Where a finding contradicts the spec, the task that acts on it also fixes the spec line, and the owner decision is in the Open questions.

| # | Finding | Consequence |
|---|---|---|
| F1 | `@loom/plugin-sandbox` is a **QuickJS-in-WASM evaluator of content-addressed JS scripts** (`SandboxWorkerPool`, `SandboxEvalEffect`, `sandboxEval$`; limits `memoryBytes`, `interruptBudget`, `wallClockMs`, `maxInputBytes`, `maxOutputBytes`). Input is JSON; there is no filesystem, no Node, no `Buffer`, no way to load `mammoth`, `unpdf`, `remark` or `word-extractor`. Spec §3.2 assumed it can run parsers. | It cannot host the parsers (part 2 needs real libraries and binary input). Tasks 69-70 build `ParseRunner`: a short-lived `child_process.fork` under `node --permission` (verified on this machine: with `--allow-fs-read` for the runner dir only, both a read of `/etc/hosts` and a write to `/tmp` fail with `ERR_ACCESS_DENIED`, and IPC still works), `--max-old-space-size`, a wall-clock `SIGKILL`, input and output caps. The spec gets a one-line correction. Network is not covered by Node 22/24's permission model (residual risk, Open question 1). |
| F2 | `@loom/knowledge`'s chunker is `packParagraphs(maxChars)`: it returns plain strings, collapses whitespace, has no overlap, no token budget, no offsets. | It cannot give locators or overlap, so Tasks 71-72 write an app-local chunker (pure, section-bounded, offset-preserving). It does not use `KnowledgeBase`/`MemoryStore` either: spec §4.2 puts chunks in Postgres. |
| F3 | `@loom/memory` has `EmbeddingProvider { modelId, dimensions, maxBatchSize?, embed(texts, {signal}) }` and `VectorIndex { add(key,id,vector), remove, clear, search(key,query,limit,minScore), size }`; `@loom/conformance` ships `runEmbeddingProviderConformance` and `runVectorIndexConformance`. **No Ollama provider exists in Loom.** | We implement `EmbeddingProvider` for Ollama and run Loom's real kit against it (Tasks 85-86). |
| F4 | `VectorIndex` cannot be implemented over `chunks.embedding`: `add` must accept any id (the kit invents ids like `"x"`), but an embedding is a column on an existing chunk row; and `search` has no document-scope filter that M4's `search_docs` needs. | `@docmind/vector-pg` exposes its own narrow `ChunkVectorStore` port (Task 87) with an in-memory twin and one shared conformance suite, as spec §3.1 requires ("each interface has one shared conformance suite"). Spec §3.1's row is corrected. |
| F5 | **Superseded 2026-10-19 (see Revision 2026-10-19).** Originally: Loom's `ProjectionRuntime` folds were in-memory and its durable read models indexed rows, so the status had to be written by each step's effect. Loom now has durable folded-state read models (`@loom/plugin-read-model`, ADR 0132). | The status is the `ingest-status` folded model over the flow's events; steps write nothing; `documents.status` is dropped. |
| F6 | `step$` supports `retry`, `timeoutMs`, `errors` (typed failure channels) and a tool-level `idempotent` flag. An effect is at-least-once: a crash between the effect and its `STEP_COMPLETED` append re-runs it. | Every effect is written to be idempotent (deterministic chunk ids, delete-then-insert, `embedding IS NULL` work lists). Retry policy is part 2. |
| F7 | `packages/contracts` already has `DocumentStatus`, `IngestStep` and `DocumentProgressEvent`, but `IngestStep` has no `link`. | Task 65 adds `link` (after `summarize`, before `finalize`) and the numeric `Locator` union. |
| F8 | The test database on `127.0.0.1:55432` (PostgreSQL 17.2, superuser `docmind`) has **no `vector` extension** (`pg_available_extensions` returns 0 rows for it). CI and `docker-compose.yml` use `pgvector/pgvector:pg16`. | Migration `0014` is applied only where pgvector exists; locally it is skipped by an explicit, test-only switch and the vector suites skip dynamically (Task 84). Everything else (flow, chunk, embed logic) is tested against an in-memory `ChunkVectorStore` that passes the same conformance suite. |
| F9 | `documents.updated_at` has no trigger (and, since 2026-10-19, nothing updates it after the upload); `documents` has no `UNIQUE (tenant_id, id)`, so a composite FK from `chunks` is impossible yet. | Migration `0010` (Task 64). |
| F10 | `loomIngest.start` awaits `runtime.start`, which appends `EXECUTION_STARTED` to Postgres before returning; the upload handler awaits it before answering. | Task 77 makes the start fire-and-log with a drainable tracker; the sweep (Task 93) is the safety net. |
| F11 | The `executionIdFor` ratchet (`executionIds.test.ts`) is a per-file regex: `runtime.start(` anywhere plus `executionIdFor(` anywhere in the same file passes, and `const { start } = runtime`, `runtime["start"](...)`, or a fork in a file that mentions `executionIdFor` once for something else all slip through. | Task 63 replaces it with a type-checker scan: every call that resolves to `WorkflowRuntime.start` or `.fork` must pass an `executionId` whose *type* is the branded `UserExecutionId` that only `executionIdFor` returns. |

## Decisions made in this plan

- **D1. The sandbox is a child process, not `@loom/plugin-sandbox`** (F1). `ParseRunner` is the one place parsers run. `@loom/plugin-sandbox` stays reserved for part 2 if a pure-JS, JSON-in/JSON-out transform is ever worth running in QuickJS; nothing in part 1 needs it.
- **D2. Parsed text between `parse` and `chunk` lives in a sealed table row, not in the event log and not in a derived blob.** `parsed_documents (tenant_id, document_id PK, body_enc)`: cascade-deleted with the document, removed by the chunk step once chunks exist, hard-deleted on erasure, no blob lifecycle to get wrong. Cost: a 50 MB text becomes a ~70 MB sealed JSON value for a moment; `ParseRunner` caps parsed characters (default 20 M) and a larger result is the permanent failure `too_large`.
- **D3. Locators are numeric.** `chunks.locator` is `{kind: "chars", start, end} | {kind: "section", index} | {kind: "page", page} | {kind: "paragraphs", from, to} | {kind: "region", page, x, y, w, h}`. The heading path (content) is sealed inside `text_enc` as `{text, headingPath}`. `chunks.section_ordinal` (plaintext integer) is the section tree's id for linked retrieval's `structure` links; it reveals grouping only. This deviates from spec §4.2's `locator jsonb` holding heading paths; Open question 5.
- **D4. Chunk ids are deterministic**: `chunkIdFor(documentId, ordinal)` = UUID built from `sha256("docmind-chunk-v1:" + documentId + ":" + ordinal)`. A re-run of `chunk` writes the same ids, and embedding "idempotent by chunkId" is therefore literal. `chunk_links` (part 2) can FK them.
- **D5. Execution ids get a generation**: `u_<userId>:ingest-<documentId>.<n>`; the M2 stub used the bare `ingest-<documentId>` (generation 1, still used by delete's cancel). Part 1 starts generation 2. A restart in part 2 bumps the generation, which is how "cancel and restart under a name with a counter, never content" works. The stub execution (which completes in milliseconds and writes nothing) is never migrated; see Task 76.
- **D6. `stepEffect` is the only way to build an ingest effect** (Task 73), and it owns three behaviors: `document_gone` mapping, fixed-message rethrow, and `PermanentIngestError` -> a `{ outcome: "failed", code }` step result (the status model folds it). A transient error class exists (`TransientIngestError`) but part 1 treats it like any unexpected error (the step fails); part 2 adds the retry policy that reads it.
- **D7. Status mapping:** `parse`, `chunk` -> `parsing`; `embed`, `analyze`, `summarize`, `link` -> `embedding` (the spec's enum has no "analyzing"; the finer position is in the SSE event's `step`); `finalize` -> `embedding` while it runs and `ready` when its `STEP_COMPLETED` (outcome `done`) is folded; a permanent failure -> `failed` with a fixed human message derived from its code (`STATUS_MESSAGES`); an execution that fails without a code -> `failed` with code `internal`. All of it is computed by the `ingest-status` model (Revision R1), not written by steps.
- **D8. The progress bus is in-process.** One server process in v1 (spec §5.2 "Scaling": a worker split is configuration later). `ProgressBus` is an interface so a Postgres `LISTEN/NOTIFY` bus can replace it. It is fed by `IngestStatus` after each fold (Revision R6), not by the steps.
- **D9. No `deriveKey(dek, label)` generalisation in part 1.** Nothing in part 1 needs a second derived key (parsed and chunk text use the user's data key directly through `FieldCrypto`); the `link` step's entity `name_key` in part 2 is the trigger.

## Preconditions

- **Postgres:** `DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:55432/postgres` (superuser, PostgreSQL 17.2). Verified: `select * from pg_available_extensions where name='vector'` returns no rows there.
- **pgvector suites:** Tasks 84, 89, 95a and 95b contain tests that need the `vector` extension. Where it is missing they **skip with a stated reason** (`ctx.skip()`), the in-memory twin still covers the logic, and CI (`pgvector/pgvector:pg16`) is the proof for the SQL. **Installed 2026-10-19:** pgvector 0.8.0 is built into the EDB PostgreSQL 17 at `/Library/PostgreSQL/17` that serves 55432 (verified: `CREATE EXTENSION vector` and a distance query succeed), so these suites run locally. To rebuild it, EDB's `pg_config` names a missing SDK (`MacOSX15.1.sdk`), so pass the local one: `make PG_CONFIG=/Library/PostgreSQL/17/bin/pg_config PG_SYSROOT="$(xcrun --show-sdk-path)"`, then `sudo make install` with the same variables. Executors do not install anything on the host.
- **Built Loom** at `/Users/such/workspace/loom`, **at or after `006dfdaf63319fa61594c42e2d5b2c8b87add2ca`** (ADR 0132; `pnpm build` there), as for M0-M2. DocMind's CI pin moves to that commit in Task 74b.
- **Node >= 22.13** for the child-process runner (`node -v` is 24.18.0 here).
- **No Ollama needed.** The opt-in real suite: `DOCMIND_TEST_OLLAMA_URL=http://127.0.0.1:11434` after `docker compose exec ollama ollama pull nomic-embed-text`.

## File structure

```
packages/parsers/                       NEW  @docmind/parsers: DocumentParser, ParsedDocument, registry, txt, ParseRunner
  src/types.ts registry.ts index.ts
  src/txt.ts                            decode + validate + one section
  src/runner/{ParseRunner,child,protocol}.ts   fork + --permission + limits
  src/testing/conformance.ts            runDocumentParserConformance (exported as @docmind/parsers/testing)
packages/embeddings/                    NEW  @docmind/embeddings: OllamaEmbeddingProvider + fake server for tests
packages/vector-pg/                     NEW  @docmind/vector-pg: ChunkVectorStore port, InMemory twin, PgChunkVectorStore, conformance
packages/contracts/src/documents.ts     + Locator, IngestStep gains "link"
apps/server/app/
  subject.ts                            + UserExecutionId brand
  flows/ingest-document/
    flow.ts deps.ts                     steps, runner, IngestDeps (grows per task)
    stepEffect.ts errors.ts             document_gone / failed / fixed-message wrapper
    chunker.ts                          pure chunker
    pgParsed.ts pgChunks.ts pgSource.ts pgGuard.ts   tenant-scoped ports
    steps/{parse,chunk,embed,placeholders}.ts   one effect each
  documents/{progress,events,startScheduler,sweep}.ts   bus, SSE route, fire-and-log, stale-upload sweep
  status/{model,ingestStatus,pgStores,wire,testing}.ts   the ingest-status folded model, its service, the Postgres stores, wiring helpers
infra/migrations/0010..0015
```

## Task index

Numbering continues from M2 (Task 62). "Est." is changed lines (see the note below the table); the file count includes new test files.

| # | Branch | What | Est. lines / files |
|---|---|---|---|
| 63 | `test/server-execution-id-ratchet` | type-checker ratchet for execution starts (carry-forward 6) | ~140 / 3 |
| 64 | `feat/db-chunks-schema` | `0010` documents composite key, `0011` chunks and parsed_documents, Postgres test fixture (carry-forward 3) | ~180 / 4 |
| 65 | `feat/contracts-locator` | `Locator` union, `link` in `IngestStep` | ~65 / 2 |
| 66 | `feat/parsers-registry` | `packages/parsers` scaffold, `DocumentParser`, `ParsedDocument`, registry | ~135 / 9 |
| 67 | `feat/parsers-conformance` | `runDocumentParserConformance` with positive and negative self-tests | ~150 / 3 |
| 68 | `feat/parsers-txt` | txt parser: BOM/UTF-16 detection, strict decode, binary rejection (carry-forward 9) | ~170 / 3 |
| 69a | `feat/parsers-runner` | `ParseRunner` core: fork, protocol, wall clock, shape validation | ~195 / 6 |
| 69b | `feat/parsers-runner-chars` | runner input cap, character cap, live-child count, noisy stdio | ~50 / 2 |
| 70 | `feat/parsers-runner-limits` | runner heap limit, permission denial, concurrency cap, abort; spec §3.2 correction | ~95 / 4 |
| 71 | `feat/ingest-chunker` | pure chunker: section-bounded packing, hard splits, exact locators | ~180 / 2 |
| 72 | `feat/ingest-chunker-overlap` | ~15% overlap inside sections; deterministic chunk ids | ~95 / 2 |
| 73a | `feat/ingest-step-effect` | `stepEffect` (`StepGuard`, `document_gone` / `failed` result / fixed message) and ingest errors (carry-forward 2) | ~145 / 3 |
| 73b | `feat/ingest-progress-bus` | `ProgressBus` (scope is the user id) | ~85 / 2 |
| 74a | `feat/db-ingest-status-tables` | `0012` folded-state tables and their tenant row-level security (Revision R2) | ~120 / 2 |
| 74b | `feat/status-model` | the `ingest-status` fold, id parsers and view; Loom pin bump and plugin dependency (Revision R1, R9) | ~185 / 6 |
| 74c | `feat/status-service` | `IngestStatus`: register, live feed, catch-up, page and one-document reads (R3, R5) | ~185 / 3 |
| 74d | `feat/status-progress` | `progressOf`, and publish to the SSE bus after the fold (R6) | ~120 / 4 |
| 74e | `feat/status-pg-stores` | Postgres writer and tenant-bound reader stores; `forgetDocument` / `forgetUser` (R2, R8) | ~150 / 4 |
| 75a | `feat/ingest-pg-parsed` | `PgParsedStore`: sealed parsed text | ~135 / 2 |
| 75b | `feat/ingest-document-source` | `PgDocumentSource`: type lookup, blob read, null is gone | ~80 / 2 |
| 75c | `feat/ingest-pg-guard` | `PgStepGuard`: the existence check every step runs first | ~80 / 2 |
| 76 | `feat/ingest-execution-generations` | `ingestExecutionId(user, doc, generation)`, delete cancels both generations (carry-forward 1) | ~55 / 3 |
| 77 | `feat/upload-fire-and-log-start` | start tracker: upload answers without waiting for Loom (carry-forward 8) | ~110 / 6 |
| 78 | `feat/ingest-parse-step` | `parse` step effect over ports | ~120 / 3 |
| 79 | `feat/ingest-wiring` | ingest dependencies through `buildServer` and `main` (carry-forward 5) | ~90 / 7 |
| 79b | `feat/status-wiring` | the status model through `buildApp`, `buildServer` and `main`: feed, sensitive map, compaction exemption, boot order (R3, R4) | ~175 / 7 |
| 79c | `feat/documents-status-from-model` | routes read the model; delete forgets it; `0013` drops `documents.status` and `error` (R5, R7, R8) | ~145 / 9 |
| 80 | `feat/ingest-flow-v2-parse` | flow v2 with the `parse` step, stub retired (size exception, Open question 11) | ~260 / 9 |
| 81 | `test/ingest-event-log-content-free` | raw event-log proof: ids, counts, codes only, and the status model folds the real log (carry-forward 4) | ~105 / 2 |
| 82 | `feat/ingest-pg-chunks` | `PgChunkStore`: delete-then-insert, sealed text, gone on missing | ~160 / 2 |
| 83 | `feat/ingest-chunk-step` | `chunk` step in the flow | ~130 / 9 |
| 84 | `feat/db-embedding-column` | `0014` pgvector column + HNSW; migrations that require an extension | ~110 / 6 |
| 85 | `feat/embeddings-ollama` | `packages/embeddings`: `OllamaEmbeddingProvider` | ~150 / 8 |
| 86 | `feat/embeddings-conformance` | fake Ollama server, Loom's provider kit, opt-in real suite | ~145 / 4 |
| 87 | `feat/vector-store-port` | `packages/vector-pg`: `ChunkVectorStore` port and in-memory twin; spec §3.1 correction | ~110 / 9 |
| 88 | `test/vector-store-conformance` | shared `ChunkVectorStore` conformance suite | ~140 / 2 |
| 89 | `feat/vector-pg` | `PgChunkVectorStore` (needs pgvector) | ~190 / 5 |
| 90 | `feat/ingest-embed-step` | `embed` step effect: batches of 64, resumable | ~135 / 4 |
| 91 | `feat/ingest-embed-in-flow` | `embed` in the flow; embedder and vectors through the composition root | ~130 / 6 |
| 92 | `feat/ingest-placeholders-finalize` | analyze/summarize/link placeholders; `finalize` completes the flow (the model folds `ready`) | ~110 / 7 |
| 93 | `feat/ingest-stale-upload-sweep` | `0015` stale-upload function (documents with no generation-2 status row) and sweeper (carry-forward 1) | ~135 / 4 |
| 94a | `feat/api-event-stream-writer` | SSE stream writer with backpressure and heartbeat | ~120 / 2 |
| 94b | `feat/api-document-events` | `GET /api/documents/events` route, per-user cap | ~175 / 4 |
| 95a | `test/api-ingest-acceptance` | acceptance stack on the real roles; txt upload to `ready`; list through the RLS reader; isolation | ~195 / 5 |
| 95b | `test/api-ingest-acceptance-delete-sweep` | acceptance: failures, delete, race, sweep; tombstones; `.env.example` | ~120 / 2 |

**How the sizes were estimated.** For each task the fenced code lines (tests, implementation, SQL) were counted by script and multiplied by 1.12 for Biome's formatting; edits described in prose rather than printed (harness wiring, `flow.ts` appends, package manifests) were added by hand. The code was not replayed, so treat every figure as +/-15%. Tasks 69, 73, 75, 94 and 95 were split into lettered pairs up front because their counted size exceeded the limit, and the 2026-10-19 revision added 74a-74e, 75c, 79b and 79c (sized the same way: counted fenced lines x 1.12, plus the edits described in prose); Task 80 is the one task that cannot be split (see Open question 11). If a task still overflows when measured, split along these seams rather than trimming tests, keeping the number with the next letter: 63 -> the `it.each` negative cases after the positive ones; 66 -> `registry.ts` and its test after the types; 68 -> BOM-less and big-endian UTF-16 after UTF-8 and BOM'd UTF-16; 71 -> hard splitting of oversize paragraphs after packing; 74b -> `viewOf`, `STATUS_MESSAGES` and the view test after the fold; 74c -> the generation and read-repair cases after boot and the live feed; 74d -> the failing-store case after the gated publish; 74e -> the erasure cases after the RLS read tests; 79c -> the harness and existing-test edits after the routes; 82 -> `read` after `replace` and `count`; 85 -> the three config files and `index.ts` first; 86 -> the real-Ollama block; 89 -> `verify` and the HNSW case after the kit-driven run; 94b -> the per-user cap after the happy path; 95a -> the isolation test.

---

## Close-out procedure (the last step of every task)

Each task's final step names a branch, a commit subject and a PR title; the commands are always these (this is a procedure, not code to adapt):

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:55432/postgres
pnpm lint:fix && pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
git diff --stat $(git merge-base HEAD <previous task's branch, or main for the first>)...HEAD   # at most 200 lines, 10 files (lockfile, loom.gen.ts, binary fixtures excluded)
git switch -c <branch>            # cut from the previous task's branch
git add <the files the task lists>
git commit -m "<subject>

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
gh pr create --draft --base <previous task's branch> --title "<PR title>" --body "<what and why, tests that skipped and why, files excluded from the count>

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

If the gate shows a skipped Postgres or pgvector suite that the task says must run, stop and fix the environment (Preconditions); do not open the PR.

---

## Part A: guards and schema (Tasks 63-65)

### Task 63: type-checker ratchet for execution starts

Closes carry-forward 6. The M2 ratchet is a per-file regex; it passes a file that mentions `executionIdFor(` once for something else, and misses `const { start } = runtime`, `runtime["start"](...)`, and a fork under another receiver name. This replaces it with a scan that asks the TypeScript checker which calls resolve to `WorkflowRuntime.start` or `.fork` and requires the `executionId` argument's **type** to be a new branded `UserExecutionId` that only `executionIdFor` (and helpers returning it) can produce. It must land before any new start or fork is written.

**Files:**
- Modify: `apps/server/app/subject.ts` (the `UserExecutionId` brand and `executionIdFor`'s return type)
- Modify: `apps/server/app/executionIds.test.ts` (replace the regex with the checker scan)
- Modify: `apps/server/app/documents/ingest.ts` (annotate `ingestExecutionId`'s return type; one line)

**Interfaces:**
- Consumes: `executionIdFor(userId: string, name: string)` (M1/M2).
- Produces: `type UserExecutionId` and `executionIdFor(...): UserExecutionId` from `app/subject.ts`; `ingestExecutionId(...): UserExecutionId`. The scan `scanStarts(files, virtual?)` is internal to the test file.

- [ ] **Step 1: Write the failing test**

Replace `apps/server/app/executionIds.test.ts`:

```ts
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const APP = resolve(__dirname);
const ROOT = resolve(APP, "..");
const CREATORS = new Set(["start", "fork"]);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    const isSource = path.endsWith(".ts") && !path.endsWith(".test.ts");
    return isSource && entry.name !== "loom.gen.ts" ? [path] : [];
  });
}

/**
 * Every call that the type checker resolves to WorkflowRuntime.start or .fork, with the verdict on
 * its `executionId`. `virtual` adds in-memory files so the scan itself can be tested.
 */
export function scanStarts(files: string[], virtual = new Map<string, string>()) {
  const config = ts.findConfigFile(ROOT, ts.sys.fileExists, "tsconfig.json") as string;
  const options = ts.parseJsonConfigFileContent(
    ts.readConfigFile(config, ts.sys.readFile).config,
    ts.sys,
    ROOT,
  ).options;
  const host = ts.createCompilerHost(options);
  const realSource = host.getSourceFile.bind(host);
  const realExists = host.fileExists.bind(host);
  host.fileExists = (name) => virtual.has(name) || realExists(name);
  host.getSourceFile = (name, lang, ...rest) =>
    virtual.has(name)
      ? ts.createSourceFile(name, virtual.get(name) as string, lang)
      : realSource(name, lang, ...rest);
  const program = ts.createProgram([...files, ...virtual.keys()], options, host);
  const checker = program.getTypeChecker();
  const found: { at: string; ok: boolean }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const decl = checker.getResolvedSignature(node)?.declaration;
      const owner = decl?.parent;
      const name = decl && "name" in decl && decl.name ? (decl.name as ts.Identifier).text : "";
      if (
        owner &&
        ts.isClassDeclaration(owner) &&
        owner.name?.text === "WorkflowRuntime" &&
        CREATORS.has(name)
      ) {
        const sf = node.getSourceFile();
        const options = node.arguments[node.arguments.length - 1];
        const prop = options && checker.getTypeAtLocation(options).getProperty("executionId");
        const type = prop && checker.getTypeOfSymbolAtLocation(prop, options as ts.Node);
        const ok = !!type && checker.getNonNullableType(type).aliasSymbol?.name === "UserExecutionId";
        const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        found.push({ at: `${sf.fileName.slice(APP.length + 1)}:${line}`, ok });
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const file of [...files, ...virtual.keys()]) {
    const sf = program.getSourceFile(file);
    if (sf) visit(sf);
  }
  return found;
}

const VIRTUAL = join(APP, "__virtual__.ts");
const snippet = (body: string) =>
  scanStarts(
    [],
    new Map([
      [
        VIRTUAL,
        `import type { WorkflowRuntime } from "@loom/workflow-runtime";
         import { executionIdFor } from "./subject";
         declare const rt: WorkflowRuntime; declare const flow: never; declare const user: string;
         export async function f() { ${body} }`,
      ],
    ]),
  );

describe("execution ids", () => {
  it("accepts a start and a fork whose executionId comes from executionIdFor", () => {
    expect(snippet(`await rt.start(flow, {}, { executionId: executionIdFor(user, "n") });`)).toEqual([
      { at: "__virtual__.ts:4", ok: true },
    ]);
    const forked = `const id = executionIdFor(user, "n"); await rt.fork("e", 3, { executionId: id });`;
    expect(snippet(forked).map((c) => c.ok)).toEqual([true]);
  });

  it.each([
    ["a literal id", `await rt.start(flow, {}, { executionId: "x" });`],
    ["no id at all", `await rt.start(flow, {}, {});`],
    ["a fork with a template id", "await rt.fork('e', 3, { executionId: `${user}:x` });"],
    ["an element-access call", `await rt["start"](flow, {}, { executionId: String(1) });`],
    ["an aliased method", `const s = rt.start; await s(flow, {}, { executionId: user });`],
  ])("flags %s", (_name, body) => {
    expect(snippet(body).map((c) => c.ok)).toEqual([false]);
  });

  it("finds at least one real start, and every real start and fork passes", () => {
    const calls = scanStarts(sources(APP));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((c) => !c.ok).map((c) => c.at)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @docmind/server exec vitest run app/executionIds.test.ts`
Expected: FAIL. The "accepts" cases fail because `executionIdFor` returns `string`, so every call reports `ok: false` (and `loomIngest.start`, which gets its id from `ingestExecutionId`, is flagged in the real-source test).

- [ ] **Step 3: Implement**

In `apps/server/app/subject.ts` add above `executionIdFor` and change the signature and return:

```ts
declare const userExecution: unique symbol;
/**
 * An execution id built by `executionIdFor`. A plain string is not assignable to it, so a start or
 * fork that passes `executionId` from anywhere else is caught by the ratchet in executionIds.test.ts.
 */
export type UserExecutionId = string & { readonly [userExecution]: true };
```

```ts
export function executionIdFor(userId: string, name: string): UserExecutionId {
  if (!CANONICAL_USER_ID.test(userId)) {
    throw new RangeError("userId must be a canonical lowercase UUID (8-4-4-4-12 hex digits)");
  }
  const executionId = `u_${userId}:${name}`;
  const bytes = Buffer.byteLength(executionId, "utf8");
  if (bytes > MAX_EXECUTION_ID_BYTES) {
    throw new RangeError(
      `execution id is ${bytes} bytes, over the ${MAX_EXECUTION_ID_BYTES}-byte limit; shorten the name`,
    );
  }
  return executionId as UserExecutionId;
}
```

In `apps/server/app/documents/ingest.ts` change the signature only:

```ts
import { type UserExecutionId, executionIdFor } from "../subject";

export const ingestExecutionId = (userId: string, documentId: string): UserExecutionId =>
  executionIdFor(userId, `ingest-${documentId.toLowerCase()}`);
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @docmind/server exec vitest run app/executionIds.test.ts app/subject.test.ts app/documents`
Expected: PASS. If `loomIngest.start` is still flagged, its `executionId` came through the destructured `target()` result: give `target()` an explicit return type `{ ref; executionId: UserExecutionId; principal }`.

- [ ] **Step 5: Close-out**

Branch `test/server-execution-id-ratchet` (cut from `main`); subject `test(server): type-checker ratchet for execution starts and forks`; PR title the same. Files: `apps/server/app/subject.ts`, `apps/server/app/executionIds.test.ts`, `apps/server/app/documents/ingest.ts`. If over the limit: move the `it.each` negative cases to a second PR.

---

### Task 64: `chunks` and `parsed_documents` tables

Closes carry-forward 3. `documents` gets `UNIQUE (tenant_id, id)` so child tables can carry a composite foreign key that cannot pair a document with the wrong tenant. `chunks` (spec §4.2, without the embedding column, which Task 84 adds only where pgvector exists) and `parsed_documents` (Decision D2) cascade with the document.

**Files:**
- Create: `infra/migrations/0010_documents_tenant_key.sql`
- Create: `infra/migrations/0011_chunks.sql`
- Create: `apps/server/app/db/chunks.pg.test.ts`
- Create: `apps/server/app/flows/ingest-document/pgFixture.ts` (the Postgres test fixture Tasks 74, 75a, 75b, 81, 82 and 83 share)

**Interfaces:**
- Consumes: `documents` (0009), `app_tenant_id()`, `docmind_app` default privileges (0001).
- Produces: `startPgFixture(): Promise<PgFixture>` with `interface PgFixture { db: TestDb; app: Pool; keys: InMemoryKeyStore; fields: FieldCrypto; doc(fingerprint: string): Promise<IngestStartInput>; close(): Promise<void> }` (a migrated database with the harness tenants and users, the `docmind_app` pool, a `FieldCrypto` over an `InMemoryKeyStore`, and `doc()` inserting an `ALICE` document and returning its flow reference; it imports `IngestStartInput` from the existing stub `flow.ts`, which keeps that type through Task 80); tables `chunks (id uuid PK, tenant_id, document_id, ordinal, section_ordinal, text_enc jsonb, locator jsonb, token_count, created_at)` with `UNIQUE (tenant_id, id)` and `UNIQUE (tenant_id, document_id, ordinal)`, and `parsed_documents (tenant_id, document_id, body_enc jsonb, created_at)` with primary key `(tenant_id, document_id)`. Both: composite FK to `documents (tenant_id, id) ON DELETE CASCADE`, RLS `tenant_isolation`.

- [ ] **Step 1: Write the failing test**

Create `apps/server/app/db/chunks.pg.test.ts`:

```ts
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { T1, T2, U1, seedUsers } from "../documents/testHarness";
import { migrate, setAppRolePassword } from "./migrate";
import { withTenant } from "./tenant";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "./testSupport";

const DOC = "d0d0d0d0-d0d0-4d0d-8d0d-d0d0d0d0d0d0";
const CHUNK = (n: number) => `c${n}c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0`;
const insertChunk = (tx: { query: Pool["query"] }, id: string, tenant: string, doc: string, ordinal = 0) =>
  tx.query(
    `INSERT INTO chunks (id, tenant_id, document_id, ordinal, section_ordinal, text_enc, locator, token_count)
     VALUES ($1, $2, $3, $4, 0, '{"x":1}', '{"kind":"chars","start":0,"end":5}', 2)`,
    [id, tenant, doc, ordinal],
  );

describe.skipIf(!PG_URL)("chunks and parsed_documents (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;
  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await seedUsers(db.owner);
    await db.owner.query(
      `INSERT INTO documents (id, tenant_id, owner_id, title_enc, filename_enc, mime, size_bytes, content_address, fingerprint)
       VALUES ($1, $2, $3, '{"x":1}', '{"x":2}', 'text/plain', 5, $4, $5)`,
      [DOC, T1, U1, `hmac-sha256:${"a".repeat(64)}`, "a".repeat(64)],
    );
    app = new Pool({ connectionString: db.appUrl });
  });
  afterAll(async () => {
    await app?.end();
    await db?.drop();
  });

  it("stores a chunk and a parsed body under their document, in their tenant", async () => {
    await withTenant(app, T1, async (tx) => {
      await insertChunk(tx, CHUNK(1), T1, DOC);
      await tx.query("INSERT INTO parsed_documents (tenant_id, document_id, body_enc) VALUES ($1, $2, '{\"x\":1}')", [T1, DOC]);
    });
    const { rows } = await withTenant(app, T1, (tx) => tx.query("SELECT count(*)::int AS n FROM chunks"));
    expect(rows[0].n).toBe(1);
  });

  it("refuses a chunk that pairs a document with another tenant (composite foreign key)", async () => {
    await expect(withTenant(app, T2, (tx) => insertChunk(tx, CHUNK(2), T2, DOC))).rejects.toMatchObject({
      code: "23503",
      constraint: "chunks_document_fkey",
    });
  });

  it("refuses a second chunk with the same ordinal in a document", async () => {
    await expect(withTenant(app, T1, (tx) => insertChunk(tx, CHUNK(3), T1, DOC, 0))).rejects.toMatchObject({
      code: "23505",
      constraint: "chunks_document_ordinal_key",
    });
  });

  it("hides another tenant's rows and refuses to write them", async () => {
    const seen = await withTenant(app, T2, (tx) => tx.query("SELECT 1 FROM chunks UNION ALL SELECT 1 FROM parsed_documents"));
    expect(seen.rowCount).toBe(0);
    await expect(withTenant(app, T2, (tx) => insertChunk(tx, CHUNK(4), T1, DOC, 9))).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("deletes chunks and the parsed body with their document", async () => {
    await db.owner.query("DELETE FROM documents WHERE id = $1", [DOC]);
    const { rows } = await db.owner.query(
      "SELECT (SELECT count(*) FROM chunks)::int AS c, (SELECT count(*) FROM parsed_documents)::int AS p",
    );
    expect(rows[0]).toEqual({ c: 0, p: 0 });
  });

});
```

- [ ] **Step 2: Run to verify it fails**

Run: `export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:55432/postgres && pnpm --filter @docmind/server exec vitest run app/db/chunks.pg.test.ts`
Expected: FAIL with `relation "chunks" does not exist` (beforeAll inserts a document fine; the first test fails).

- [ ] **Step 3: Write the migrations**

`infra/migrations/0010_documents_tenant_key.sql`:

```sql
-- Child tables reference a document together with its tenant, so a foreign key can never pair a
-- document with the wrong tenant. `id` is already the primary key; this adds no new restriction on
-- the data, only a key the composite foreign keys of 0011 (and later chunk_links) can point at.
ALTER TABLE documents ADD CONSTRAINT documents_tenant_id_id_key UNIQUE (tenant_id, id);
```

`infra/migrations/0011_chunks.sql`:

```sql
-- Chunks of a parsed document (spec 4.2). text_enc holds {text, headingPath} sealed under the owner's
-- data key; heading text is content, so the plaintext locator carries only numbers (kind + offsets).
-- section_ordinal is the chunker's section index (an integer; linked retrieval's `structure` links).
-- The embedding column is added by 0014, only where the pgvector extension exists.
CREATE TABLE chunks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  section_ordinal integer NOT NULL CHECK (section_ordinal >= 0),
  text_enc jsonb NOT NULL,
  locator jsonb NOT NULL,
  token_count integer NOT NULL CHECK (token_count > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chunks_document_fkey FOREIGN KEY (tenant_id, document_id)
    REFERENCES documents (tenant_id, id) ON DELETE CASCADE,
  -- chunk_links (part 2) references chunks with a composite key too.
  CONSTRAINT chunks_tenant_id_id_key UNIQUE (tenant_id, id),
  -- Also the (tenant_id, document_id) B-tree of spec 4.2: its leading columns.
  CONSTRAINT chunks_document_ordinal_key UNIQUE (tenant_id, document_id, ordinal)
);
ALTER TABLE chunks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chunks USING (tenant_id = app_tenant_id());

-- The parser's output on its way from the parse step to the chunk step. Sealed, and removed by the
-- chunk step once the chunks exist; cascade-deleted with the document either way.
CREATE TABLE parsed_documents (
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  body_enc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, document_id),
  CONSTRAINT parsed_documents_document_fkey FOREIGN KEY (tenant_id, document_id)
    REFERENCES documents (tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE parsed_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON parsed_documents USING (tenant_id = app_tenant_id());
```

The fixture, `apps/server/app/flows/ingest-document/pgFixture.ts` (used by later tasks; add it here because it needs only the tables above):

```ts
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { Pool } from "pg";
import { FieldCrypto } from "../../crypto/fields";
import { migrate, setAppRolePassword } from "../../db/migrate";
import { withTenant } from "../../db/tenant";
import { APP_PASSWORD, type TestDb, createTestDb } from "../../db/testSupport";
import { insertDocument } from "../../documents/repo";
import { T1, U1, newDocument, seedUsers } from "../../documents/testHarness";
import type { IngestStartInput } from "./flow";

export interface PgFixture {
  db: TestDb;
  app: Pool;
  keys: InMemoryKeyStore;
  fields: FieldCrypto;
  doc(fingerprint: string): Promise<IngestStartInput>;
  close(): Promise<void>;
}

export async function startPgFixture(): Promise<PgFixture> {
  const db = await createTestDb();
  await migrate(db.owner);
  await setAppRolePassword(db.owner, APP_PASSWORD);
  await seedUsers(db.owner);
  const app = new Pool({ connectionString: db.appUrl });
  const keys = new InMemoryKeyStore();
  const fields = new FieldCrypto(keys);
  return {
    db,
    app,
    keys,
    fields,
    async doc(fingerprint) {
      const d = await newDocument(fields, T1, U1, fingerprint);
      await withTenant(app, T1, (tx) => insertDocument(tx, d));
      return { tenantId: T1, userId: U1, documentId: d.id };
    },
    async close() {
      await app.end();
      await db.drop();
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:55432/postgres && pnpm --filter @docmind/server exec vitest run app/db`
Expected: PASS, including the M0 guard that every table has RLS.

- [ ] **Step 5: Close-out**

Branch `feat/db-chunks-schema`; subject `feat(db): chunks and parsed_documents with a composite document key`. Files: the two migrations and the test. Seam if over: `0011` and its test after `0010`.

---

### Task 65: `Locator` and the `link` ingest step in the contracts

**Files:**
- Modify: `packages/contracts/src/documents.ts`
- Modify: `packages/contracts/src/documents.test.ts`

**Interfaces:**
- Consumes: zod.
- Produces: `Locator` (zod) and `type Locator`, a discriminated union on `kind` (D3); `IngestStep` is now `parse | chunk | embed | analyze | summarize | link | finalize`.

- [ ] **Step 1: Write the failing test**

Append to `packages/contracts/src/documents.test.ts` (add `IngestStep, Locator` to the existing import from `./documents`):

```ts
describe("Locator", () => {
  it.each([
    { kind: "chars", start: 0, end: 10 },
    { kind: "section", index: 3 },
    { kind: "page", page: 1 },
    { kind: "paragraphs", from: 2, to: 4 },
    { kind: "region", page: 1, x: 0, y: 0, w: 10, h: 10 },
  ])("accepts %j", (locator) => {
    expect(Locator.parse(locator)).toEqual(locator);
  });

  it.each([
    [{ kind: "chars", start: 5, end: 4 }, "end before start"],
    [{ kind: "chars", start: -1, end: 4 }, "negative offset"],
    [{ kind: "page", page: 0 }, "page numbers start at 1"],
    [{ kind: "heading", path: ["Intro"] }, "heading text is content and has no place in a locator"],
    [{ kind: "chars", start: 0, end: 4, text: "secret" }, "extra field"],
  ])("rejects %j (%s)", (locator) => {
    expect(Locator.safeParse(locator).success).toBe(false);
  });
});

describe("IngestStep", () => {
  it("lists the steps in flow order, with link after summarize", () => {
    expect(IngestStep.options).toEqual([
      "parse", "chunk", "embed", "analyze", "summarize", "link", "finalize",
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @docmind/contracts exec vitest run src/documents.test.ts`
Expected: FAIL (`Locator` is not exported; `IngestStep.options` lacks `link`).

- [ ] **Step 3: Implement**

In `packages/contracts/src/documents.ts` replace the `IngestStep` line and add `Locator` above `DocumentStats`:

```ts
export const IngestStep = z.enum([
  "parse", "chunk", "embed", "analyze", "summarize", "link", "finalize",
]);
```

```ts
const Count = z.number().int().nonnegative();
/**
 * Where a chunk or section sits in its source. Numbers only: a heading path is content, so it is
 * kept (sealed) beside the text and never in a locator that is stored or logged in the clear.
 * `chars` offsets are UTF-16 code units into the parsed text.
 */
export const Locator = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("chars"), start: Count, end: Count }).strict(),
    z.object({ kind: z.literal("section"), index: Count }).strict(),
    z.object({ kind: z.literal("page"), page: z.number().int().min(1) }).strict(),
    z.object({ kind: z.literal("paragraphs"), from: Count, to: Count }).strict(),
    z
      .object({
        kind: z.literal("region"),
        page: z.number().int().min(1),
        x: z.number().nonnegative(),
        y: z.number().nonnegative(),
        w: z.number().nonnegative(),
        h: z.number().nonnegative(),
      })
      .strict(),
  ])
  .superRefine((l, ctx) => {
    const [a, b] = l.kind === "chars" ? [l.start, l.end] : l.kind === "paragraphs" ? [l.from, l.to] : [0, 0];
    if (b < a) ctx.addIssue({ code: "custom", message: "end must not precede start" });
  });
export type Locator = z.infer<typeof Locator>;
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @docmind/contracts exec vitest run && pnpm --filter @docmind/server typecheck`
Expected: PASS; nothing else in the repo switches exhaustively over `IngestStep` yet.

- [ ] **Step 5: Close-out**

Branch `feat/contracts-locator`; subject `feat(contracts): numeric Locator and the link ingest step`.

---

## Part B: parsers and the sandboxed runner (Tasks 66-70)

### Task 66: `packages/parsers`: `DocumentParser`, `ParsedDocument`, registry

Spec §9 item 12, first half. Package layout follows `packages/blob-store` (CommonJS build, `src/testing` excluded from the build because it imports `vitest`).

**Files:**
- Create: `packages/parsers/package.json`
- Create: `packages/parsers/tsconfig.json`
- Create: `packages/parsers/tsconfig.test.json`
- Create: `packages/parsers/vitest.config.ts`
- Create: `packages/parsers/src/types.ts`
- Create: `packages/parsers/src/registry.ts`
- Create: `packages/parsers/src/registry.test.ts`
- Create: `packages/parsers/src/index.ts`
- Modify: `pnpm-lock.yaml` (not counted)

**Interfaces:**
- Consumes: `Locator` from `@docmind/contracts` (Task 65).
- Produces (all from `@docmind/parsers`):
  - `ParsedSection`, `ParsedMedia`, `ParsedDocument` (zod schemas, each with an inferred type): `ParsedDocument = { text: string; sections: { headingPath: string[]; text: string; locator: Locator }[]; media: { mime: string; locator: Locator }[] }`.
  - `interface DocumentParser { readonly id: string; accepts(mime: string, ext?: string): boolean; parse(bytes: Uint8Array): ParsedDocument | Promise<ParsedDocument> }`.
  - `const PARSE_REJECT_CODES = ["unsupported_content", "corrupt_content", "too_large"] as const`, `type ParseRejectCode`, `class ParseRejectedError extends Error { readonly code: ParseRejectCode }` (message is the fixed `parse rejected: <code>`).
  - `class ParserRegistry { constructor(parsers: readonly DocumentParser[]); select(mime: string, ext?: string): DocumentParser | undefined; byId(id: string): DocumentParser | undefined; ids(): string[] }`.

- [ ] **Step 1: Write the failing test**

`packages/parsers/src/registry.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ParserRegistry } from "./registry";
import { type DocumentParser, ParseRejectedError, ParsedDocument } from "./types";

const parser = (id: string, mime: string, ext?: string): DocumentParser => ({
  id,
  accepts: (m, e) => m === mime || (ext !== undefined && e === ext),
  parse: () => ({ text: "", sections: [], media: [] }),
});

describe("ParserRegistry", () => {
  const reg = new ParserRegistry([parser("a", "text/plain", "txt"), parser("b", "text/markdown")]);

  it("selects the first parser that accepts the type, by mime or by extension", () => {
    expect(reg.select("text/markdown")?.id).toBe("b");
    expect(reg.select("application/octet-stream", "txt")?.id).toBe("a");
    expect(reg.select("image/png")).toBeUndefined();
  });

  it("finds a parser by id and lists ids in registration order", () => {
    expect(reg.byId("b")?.id).toBe("b");
    expect(reg.byId("nope")).toBeUndefined();
    expect(reg.ids()).toEqual(["a", "b"]);
  });

  it("refuses two parsers with the same id, naming the id's position not a value", () => {
    expect(() => new ParserRegistry([parser("a", "x"), parser("a", "y")])).toThrow(
      /duplicate parser id at position 1/,
    );
  });
});

describe("types", () => {
  it("ParsedDocument rejects a heading path that is not an array of strings", () => {
    const bad = { text: "t", sections: [{ headingPath: "Intro", text: "t", locator: { kind: "section", index: 0 } }], media: [] };
    expect(ParsedDocument.safeParse(bad).success).toBe(false);
  });

  it("ParseRejectedError carries a code and a fixed message", () => {
    const err = new ParseRejectedError("corrupt_content");
    expect(err).toMatchObject({ name: "ParseRejectedError", code: "corrupt_content", message: "parse rejected: corrupt_content" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm install && pnpm --filter @docmind/parsers exec vitest run`
Expected: FAIL (modules not found) once the scaffold files below exist empty; before that `pnpm` reports no such workspace package.

- [ ] **Step 3: Scaffold and implement**

`packages/parsers/package.json`:

```json
{
  "name": "@docmind/parsers",
  "version": "0.0.0",
  "private": true,
  "description": "DocumentParser interface, registry and parsers; runs untrusted bytes in a resource-limited child process.",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "engines": { "node": ">=22.13.0" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "tsc -p tsconfig.json && vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "typecheck:tests": "tsc -p tsconfig.test.json"
  },
  "dependencies": { "@docmind/contracts": "workspace:*", "zod": "^3.23.8" },
  "devDependencies": { "@types/node": "^22.0.0", "vitest": "^2.1.8" }
}
```

`tsconfig.json` and `tsconfig.test.json` copy `packages/blob-store`'s (`rootDir: src`, `types: ["node"]`, exclude `src/testing`, `**/*.test.ts`, `dist`; the test config extends it with `noEmit` and includes `src`). `vitest.config.ts` copies `packages/blob-store/vitest.config.ts`. The `test` script builds first because Task 69's tests run the compiled child entry.

`packages/parsers/src/types.ts`:

```ts
import { Locator } from "@docmind/contracts";
import { z } from "zod";

export const ParsedSection = z.object({
  headingPath: z.array(z.string().max(500)).max(16),
  text: z.string(),
  locator: Locator,
});
export type ParsedSection = z.infer<typeof ParsedSection>;

export const ParsedMedia = z.object({ mime: z.string().max(100), locator: Locator });
export type ParsedMedia = z.infer<typeof ParsedMedia>;

/** What every parser produces (spec 5.2). `text` is the whole document; sections slice it by locator. */
export const ParsedDocument = z.object({
  text: z.string(),
  sections: z.array(ParsedSection),
  media: z.array(ParsedMedia),
});
export type ParsedDocument = z.infer<typeof ParsedDocument>;

export interface DocumentParser {
  readonly id: string;
  /** The sniffed mime is authoritative; `ext` is only a hint and may be absent. */
  accepts(mime: string, ext?: string): boolean;
  parse(bytes: Uint8Array): ParsedDocument | Promise<ParsedDocument>;
}

export const PARSE_REJECT_CODES = ["unsupported_content", "corrupt_content", "too_large"] as const;
export type ParseRejectCode = (typeof PARSE_REJECT_CODES)[number];

/** The bytes are not a document this parser can read. Permanent: retrying the same bytes cannot help. */
export class ParseRejectedError extends Error {
  constructor(readonly code: ParseRejectCode) {
    super(`parse rejected: ${code}`);
    this.name = "ParseRejectedError";
  }
}
```

`packages/parsers/src/registry.ts`:

```ts
import type { DocumentParser } from "./types";

/** Parsers by id. Built by the composition root; there is no global registry. */
export class ParserRegistry {
  constructor(private readonly parsers: readonly DocumentParser[]) {
    const seen = new Set<string>();
    parsers.forEach((p, i) => {
      if (seen.has(p.id)) throw new Error(`duplicate parser id at position ${i}`);
      seen.add(p.id);
    });
  }
  select(mime: string, ext?: string): DocumentParser | undefined {
    return this.parsers.find((p) => p.accepts(mime, ext));
  }
  byId(id: string): DocumentParser | undefined {
    return this.parsers.find((p) => p.id === id);
  }
  ids(): string[] {
    return this.parsers.map((p) => p.id);
  }
}
```

`packages/parsers/src/index.ts`: `export * from "./types"; export { ParserRegistry } from "./registry";` (Tasks 68-69 add their exports).

Add `"@docmind/parsers": "workspace:*"` to `apps/server/package.json` dependencies in Task 71, the first task that imports it.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @docmind/parsers build && pnpm --filter @docmind/parsers exec vitest run`
Expected: PASS.

- [ ] **Step 5: Close-out**

Branch `feat/parsers-registry`; subject `feat(parsers): DocumentParser, ParsedDocument and the registry`. Seam if over: the three config files are mechanical; if the count is the problem move `registry.ts` + its test to the next PR.

---

### Task 67: `runDocumentParserConformance`

Spec §3.1 requires one shared conformance suite per interface. It follows Loom's pattern: the checks are plain functions returning a problem string (so they can be tested against deliberately broken parsers), and `run...` registers one `it` per check.

**Files:**
- Create: `packages/parsers/src/testing/conformance.ts`
- Create: `packages/parsers/src/testing/conformance.test.ts`
- Modify: `packages/parsers/package.json` (an `exports` entry `"./testing"` is **not** added: the kit imports `vitest` and is consumed by relative path inside the package and by the server tests through the same alias trick `@docmind/auth/testing` uses, added when a second package needs it)

**Interfaces:**
- Consumes: `DocumentParser`, `ParsedDocument`, `ParseRejectedError` (Task 66).
- Produces: `interface ParserFixtures { valid: { name: string; bytes: Uint8Array; mime: string; ext?: string }[]; rejected: { name: string; bytes: Uint8Array }[] }`; `const CHECKS: Record<string, (parser: DocumentParser, fixtures: ParserFixtures) => Promise<string | undefined>>`; `runDocumentParserConformance(factory: () => DocumentParser, fixtures: ParserFixtures, label?: string): void`.

- [ ] **Step 1: Write the failing test**

`packages/parsers/src/testing/conformance.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { type DocumentParser, ParseRejectedError } from "../types";
import { CHECKS, type ParserFixtures, runDocumentParserConformance } from "./conformance";

const bytes = (s: string) => new TextEncoder().encode(s);
const good: DocumentParser = {
  id: "toy",
  accepts: (m, e) => m === "text/plain" || e?.toLowerCase() === "toy",
  parse(input) {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(input);
    if (text.includes("\0")) throw new ParseRejectedError("unsupported_content");
    return { text, sections: [{ headingPath: [], text, locator: { kind: "chars", start: 0, end: text.length } }], media: [] };
  },
};
const fixtures: ParserFixtures = {
  valid: [{ name: "plain", bytes: bytes("hello\nworld"), mime: "text/plain", ext: "toy" }],
  rejected: [{ name: "nul", bytes: new Uint8Array([104, 0, 105]) }],
};

runDocumentParserConformance(() => good, fixtures, "toy parser");

describe("the kit catches broken parsers", () => {
  const broken = (over: Partial<DocumentParser>): DocumentParser => ({ ...good, ...over });
  it("a locator that does not slice to the section text", async () => {
    const p = broken({ parse: (b) => ({ text: "abc", sections: [{ headingPath: [], text: "abc", locator: { kind: "chars", start: 0, end: 2 } }], media: [] }) });
    expect(await CHECKS["section locators slice the text"]?.(p, fixtures)).toBe("plain: section 0 does not equal text.slice(0, 2)");
  });
  it("a parser that mutates its input", async () => {
    const p = broken({ parse: (b) => { b[0] = 0; return good.parse(bytes("x")); } });
    expect(await CHECKS["does not modify its input"]?.(p, fixtures)).toBe("plain: the input bytes were modified");
  });
  it("a parser that accepts garbage", async () => {
    const p = broken({ parse: () => ({ text: "", sections: [], media: [] }) });
    expect(await CHECKS["rejects what it cannot read with ParseRejectedError"]?.(p, fixtures)).toBe("nul: did not reject");
  });
  it("a parser that throws a plain Error for garbage", async () => {
    const p = broken({ parse: () => { throw new Error("boom"); } });
    expect(await CHECKS["rejects what it cannot read with ParseRejectedError"]?.(p, fixtures)).toBe("nul: threw Error, not ParseRejectedError");
  });
  it("a parser that claims every type", async () => {
    expect(await CHECKS["accepts its own types and not others"]?.(broken({ accepts: () => true }), fixtures)).toBe("accepts application/x-docmind-unknown");
  });
  it("a parser whose output changes between runs", async () => {
    let n = 0;
    const p = broken({ parse: () => ({ text: `t${n++}`, sections: [], media: [] }) });
    expect(await CHECKS["is deterministic"]?.(p, fixtures)).toBe("plain: two parses differ");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @docmind/parsers exec vitest run src/testing`
Expected: FAIL (`./conformance` not found).

- [ ] **Step 3: Implement**

`packages/parsers/src/testing/conformance.ts`:

```ts
import { describe, expect, it } from "vitest";
import { type DocumentParser, PARSE_REJECT_CODES, ParseRejectedError, ParsedDocument } from "../types";

export interface ParserFixtures {
  valid: { name: string; bytes: Uint8Array; mime: string; ext?: string }[];
  /** Bytes of the right container but unreadable content, or plain garbage. */
  rejected: { name: string; bytes: Uint8Array }[];
}
type Check = (parser: DocumentParser, fixtures: ParserFixtures) => Promise<string | undefined>;

const copy = (b: Uint8Array) => Uint8Array.from(b);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export const CHECKS: Record<string, Check> = {
  "has a non-empty id": async (p) => (p.id.length > 0 ? undefined : "empty id"),

  "accepts its own types and not others": async (p, f) => {
    for (const v of f.valid) {
      if (!p.accepts(v.mime, v.ext)) return `${v.name}: does not accept ${v.mime}`;
      if (v.ext && !p.accepts("application/octet-stream", v.ext.toUpperCase())) return `${v.name}: extension match is case sensitive`;
    }
    return p.accepts("application/x-docmind-unknown") ? "accepts application/x-docmind-unknown" : undefined;
  },

  "produces a valid ParsedDocument": async (p, f) => {
    for (const v of f.valid) {
      const out = ParsedDocument.safeParse(await p.parse(copy(v.bytes)));
      if (!out.success) return `${v.name}: output fails the ParsedDocument schema`;
    }
    return undefined;
  },

  "section locators slice the text": async (p, f) => {
    for (const v of f.valid) {
      const doc = await p.parse(copy(v.bytes));
      for (const [i, s] of doc.sections.entries()) {
        if (s.locator.kind !== "chars") continue;
        if (doc.text.slice(s.locator.start, s.locator.end) !== s.text) {
          return `${v.name}: section ${i} does not equal text.slice(${s.locator.start}, ${s.locator.end})`;
        }
      }
    }
    return undefined;
  },

  "is deterministic": async (p, f) => {
    for (const v of f.valid) {
      if (!same(await p.parse(copy(v.bytes)), await p.parse(copy(v.bytes)))) return `${v.name}: two parses differ`;
    }
    return undefined;
  },

  "does not modify its input": async (p, f) => {
    for (const v of f.valid) {
      const input = copy(v.bytes);
      await p.parse(input);
      if (!same([...input], [...v.bytes])) return `${v.name}: the input bytes were modified`;
    }
    return undefined;
  },

  "rejects what it cannot read with ParseRejectedError": async (p, f) => {
    for (const r of f.rejected) {
      try {
        await p.parse(copy(r.bytes));
        return `${r.name}: did not reject`;
      } catch (err) {
        if (!(err instanceof ParseRejectedError)) {
          return `${r.name}: threw ${err instanceof Error ? err.constructor.name : typeof err}, not ParseRejectedError`;
        }
        if (!PARSE_REJECT_CODES.includes(err.code)) return `${r.name}: unknown code`;
      }
    }
    return undefined;
  },
};

export function runDocumentParserConformance(
  factory: () => DocumentParser,
  fixtures: ParserFixtures,
  label = "DocumentParser",
): void {
  describe(`${label} conformance (DocumentParser)`, () => {
    for (const [name, check] of Object.entries(CHECKS)) {
      it(name, async () => expect(await check(factory(), fixtures)).toBeUndefined());
    }
  });
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @docmind/parsers exec vitest run`
Expected: PASS (the kit's own suite for `toy`, plus the six negative cases).

- [ ] **Step 5: Close-out**

Branch `feat/parsers-conformance`; subject `test(parsers): shared DocumentParser conformance suite`.

---

### Task 68: txt parser

Spec §5.3 txt row and carry-forward 9. M2's sniffer accepts any file with a UTF-16 BOM as text without looking further, so a binary starting `FF FE` reaches here. The parser is the real gate: strict decoding, a control-character and noncharacter check on the decoded text, and a rejection (not a replacement character) for anything that is not text. Locators are UTF-16 code-unit offsets into the **normalised** text (`\r\n` and lone `\r` become `\n`); the whole file is one section (a txt file has no headings; the chunker splits within it by paragraph).

**Files:**
- Create: `packages/parsers/src/txt.ts`
- Create: `packages/parsers/src/txt.test.ts`
- Modify: `packages/parsers/src/index.ts` (export `txtParser`, `createDefaultParsers`)

**Interfaces:**
- Consumes: `DocumentParser`, `ParseRejectedError` (66), `runDocumentParserConformance` (67).
- Produces: `const txtParser: DocumentParser` (`id: "txt"`, accepts mime `text/plain` or extension `txt`, case-insensitive); `createDefaultParsers(): DocumentParser[]` (`[txtParser]` now; part 2 appends).

- [ ] **Step 1: Write the failing test**

`packages/parsers/src/txt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ParseRejectedError } from "./types";
import { runDocumentParserConformance } from "./testing/conformance";
import { txtParser } from "./txt";

const utf8 = (s: string) => new TextEncoder().encode(s);
const utf16le = (s: string, bom = true) => {
  const b = Buffer.alloc((bom ? 2 : 0) + s.length * 2);
  if (bom) b.writeUInt16LE(0xfeff, 0);
  for (let i = 0; i < s.length; i++) b.writeUInt16LE(s.charCodeAt(i), (bom ? 2 : 0) + i * 2);
  return new Uint8Array(b);
};
const utf16be = (s: string) => {
  const le = utf16le(s);
  const out = new Uint8Array(le.length);
  for (let i = 0; i < le.length; i += 2) [out[i], out[i + 1]] = [le[i + 1] as number, le[i] as number];
  out[0] = 0xfe; out[1] = 0xff;
  return out;
};

runDocumentParserConformance(() => txtParser, {
  valid: [
    { name: "ascii", bytes: utf8("one\n\ntwo\n"), mime: "text/plain", ext: "txt" },
    { name: "utf-8 with BOM", bytes: Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8("héllo")]), mime: "text/plain" },
    { name: "utf-16le", bytes: utf16le("héllo wörld"), mime: "text/plain" },
  ],
  rejected: [
    { name: "nul bytes", bytes: Uint8Array.from([0x68, 0, 0x69, 0, 0, 0xff, 0]) },
    { name: "invalid utf-8", bytes: Uint8Array.from([0xc3, 0x28]) },
    { name: "UTF-16 BOM over binary", bytes: Uint8Array.from([0xff, 0xfe, 0x00, 0xd8, 0x41, 0x00]) },
  ],
}, "txt");

describe("txtParser", () => {
  it("decodes UTF-8, UTF-8 with BOM, UTF-16 LE and BE (with BOM), and BOM-less UTF-16", async () => {
    for (const bytes of [utf8("naïve café"), Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8("naïve café")]), utf16le("naïve café"), utf16be("naïve café"), utf16le("naïve café", false)]) {
      expect((await txtParser.parse(bytes)).text).toBe("naïve café");
    }
  });

  it("normalises line endings and gives one section whose locator covers the text", async () => {
    const doc = await txtParser.parse(utf8("a\r\nb\rc\n"));
    expect(doc.text).toBe("a\nb\nc\n");
    expect(doc.sections).toEqual([{ headingPath: [], text: "a\nb\nc\n", locator: { kind: "chars", start: 0, end: 6 } }]);
  });

  it("treats an empty or whitespace-only file as an empty document, not an error", async () => {
    expect(await txtParser.parse(new Uint8Array())).toEqual({ text: "", sections: [], media: [] });
    expect((await txtParser.parse(utf8(" \n\t\n"))).sections).toEqual([]);
  });

  it.each([
    ["a NUL byte", Uint8Array.from([0x41, 0x00, 0x42, 0x43])],
    ["a C0 control", utf8("ok\u0001bad")],
    ["a noncharacter (UTF-16 binary tends to decode to these)", utf16le("a￿b")],
    ["a lone surrogate in UTF-16", Uint8Array.from([0xff, 0xfe, 0x00, 0xd8])],
    ["an odd-length UTF-16 body", Uint8Array.from([0xff, 0xfe, 0x41])],
  ])("rejects %s with ParseRejectedError", async (_n, bytes) => {
    await expect(Promise.resolve().then(() => txtParser.parse(bytes))).rejects.toBeInstanceOf(ParseRejectedError);
  });

  it("keeps tab, form feed and escape (log files), which the sniffer also allows", async () => {
    expect((await txtParser.parse(utf8("a\tb\fc\u001b[0m"))).text).toBe("a\tb\fc\u001b[0m");
  });

  it("matches by mime or case-insensitive extension", () => {
    expect(txtParser.accepts("text/plain")).toBe(true);
    expect(txtParser.accepts("application/octet-stream", "TXT")).toBe(true);
    expect(txtParser.accepts("text/markdown")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @docmind/parsers exec vitest run src/txt.test.ts`
Expected: FAIL (`./txt` not found).

- [ ] **Step 3: Implement**

`packages/parsers/src/txt.ts`:

```ts
import { type DocumentParser, ParseRejectedError, type ParsedDocument } from "./types";

const reject = (code: "unsupported_content" | "corrupt_content"): never => {
  throw new ParseRejectedError(code);
};

function strict(label: "utf-8" | "utf-16le", bytes: Uint8Array): string {
  try {
    return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return reject("corrupt_content");
  }
}

function utf16(bytes: Uint8Array, bigEndian: boolean): string {
  if (bytes.length % 2 !== 0) reject("corrupt_content");
  if (!bigEndian) return strict("utf-16le", bytes);
  const swapped = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 2) {
    swapped[i] = bytes[i + 1] as number;
    swapped[i + 1] = bytes[i] as number;
  }
  return strict("utf-16le", swapped);
}

/** UTF-16 written without a BOM has a NUL in every other byte of ASCII-range text. */
function bomlessUtf16(bytes: Uint8Array): "le" | "be" | undefined {
  const n = Math.min(bytes.length, 4096) & ~1;
  let even = 0;
  let odd = 0;
  for (let i = 0; i < n; i += 2) {
    if (bytes[i] === 0) even++;
    if (bytes[i + 1] === 0) odd++;
  }
  const pairs = n / 2;
  if (pairs < 2) return undefined;
  if (odd >= pairs * 0.3 && even === 0) return "le";
  if (even >= pairs * 0.3 && odd === 0) return "be";
  return undefined;
}

function decode(bytes: Uint8Array): string {
  const [a, b, c] = bytes;
  if (a === 0xff && b === 0xfe) return utf16(bytes.subarray(2), false);
  if (a === 0xfe && b === 0xff) return utf16(bytes.subarray(2), true);
  if (a === 0xef && b === 0xbb && c === 0xbf) return strict("utf-8", bytes.subarray(3));
  const guess = bomlessUtf16(bytes);
  if (guess) return utf16(bytes, guess === "be");
  return strict("utf-8", bytes);
}

const ALLOWED_CONTROLS = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1b]);
const UNASSIGNED_OR_PRIVATE = /[\p{Cn}\p{Co}\p{Cs}]/u;

/** Binary data decodes to controls, noncharacters or unassigned code points; real text does not. */
function assertText(text: string): void {
  for (let i = 0; i < text.length; i++) {
    const cu = text.charCodeAt(i);
    if (cu < 0x20 ? !ALLOWED_CONTROLS.has(cu) : cu >= 0x7f && cu <= 0x9f) reject("unsupported_content");
    if (cu < 0x7f) continue; // ASCII fast path
    const ch = String.fromCodePoint(text.codePointAt(i) as number);
    if (UNASSIGNED_OR_PRIVATE.test(ch)) reject("unsupported_content");
    if (ch.length === 2) i++;
  }
}

export const txtParser: DocumentParser = {
  id: "txt",
  accepts: (mime, ext) => mime === "text/plain" || ext?.toLowerCase() === "txt",
  parse(bytes): ParsedDocument {
    const text = decode(bytes).replace(/\r\n?/g, "\n");
    assertText(text);
    if (text.trim() === "") return { text: "", sections: [], media: [] };
    return {
      text,
      sections: [{ headingPath: [], text, locator: { kind: "chars", start: 0, end: text.length } }],
      media: [],
    };
  },
};
```

Notes the implementer must keep: U+FFFE and U+FFFF are `Cn` (so rejected); `ignoreBOM: true` keeps a leading U+FEFF out of the text because the BOM bytes were already sliced off; an odd-length body and a lone surrogate both land in `corrupt_content`; nothing here echoes a byte or a character into a message. Residual limit (stated in the test name, not hidden): a handful of random bytes after a UTF-16 BOM can decode to valid assigned CJK characters and is accepted as (gibberish) text; the 20 M character cap and the rest of the pipeline treat it as any other text.

`packages/parsers/src/index.ts` gains: `export { txtParser } from "./txt"; import { txtParser } from "./txt"; export const createDefaultParsers = (): DocumentParser[] => [txtParser];` (import `DocumentParser` as a type).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @docmind/parsers exec vitest run`
Expected: PASS, including the kit's checks over the three valid and three rejected fixtures. If the "UTF-16 BOM over binary" fixture is accepted, the lone surrogate `D800` is not reaching the fatal decoder: check `ignoreBOM`/`fatal` are both set.

- [ ] **Step 5: Close-out**

Branch `feat/parsers-txt`; subject `feat(parsers): txt parser with strict decoding and binary rejection`. Seam if over: BOM-less/BE UTF-16 detection (`bomlessUtf16`, `utf16`'s swap) and its cases go to a follow-up PR.

---

### Task 69a: `ParseRunner` core

Spec §9 item 13. Runs one parser on one input in a fresh `child_process.fork` and returns a validated `ParsedDocument`. This task: the process, the message protocol, the wall-clock kill, shape validation, and cleanup on every path (no zombie, no listener left). Task 69b adds the input cap, the output character cap and the noisy-stdio proof; Task 70 adds the heap limit, permission-denial proof, concurrency and abort. See Finding F1 for why this is not `@loom/plugin-sandbox`.

**Files:**
- Create: `packages/parsers/src/runner/protocol.ts`
- Create: `packages/parsers/src/runner/child.ts`
- Create: `packages/parsers/src/runner/ParseRunner.ts`
- Create: `packages/parsers/src/runner/ParseRunner.test.ts`
- Create: `packages/parsers/test-fixtures/hostile.cjs`
- Modify: `packages/parsers/src/index.ts` (exports; move `createDefaultParsers` to `src/defaults.ts` and re-export it)

**Interfaces:**
- Consumes: `ParserRegistry`, `ParsedDocument`, `ParseRejectedError`, `createDefaultParsers` (66, 68).
- Produces:
  - `interface ParseLimits { wallClockMs: number; memoryMb: number }` (69b adds `maxInputBytes` and `maxChars`).
  - `interface ParseRunnerOptions { limits: ParseLimits; childEntry?: string; parserModule?: string }` (`parserModule`: a CommonJS file exporting `parsers: DocumentParser[]`, replaces the default parsers in the child; used by tests).
  - `class ParseRunner { constructor(options: ParseRunnerOptions); run(parserId: string, bytes: Uint8Array): Promise<ParsedDocument> }`.
  - Errors, both `extends Error` with fixed messages: `ParseTimeoutError` (`parse timed out`), `ParseCrashedError` (`parse crashed`); `ParseRejectedError` is re-thrown for `rejected` replies.

- [ ] **Step 1: Write the failing test**

`packages/parsers/test-fixtures/hostile.cjs`:

```js
// Parsers a hostile or broken document could drive a real parser into. Test-only.
const ok = (text) => ({ text, sections: [], media: [] });
exports.parsers = [
  { id: "echo", accepts: () => true, parse: (b) => ok(Buffer.from(b).toString("utf8")) },
  { id: "spin", accepts: () => true, parse: () => { for (;;) {} } },
  { id: "exit", accepts: () => true, parse: () => process.exit(3) },
];
```

`packages/parsers/src/runner/ParseRunner.test.ts`:

```ts
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ParseCrashedError, ParseRunner, ParseTimeoutError } from "./ParseRunner";

const LIMITS = { wallClockMs: 10_000, memoryMb: 256 };
const hostile = resolve(__dirname, "../../test-fixtures/hostile.cjs");
const runner = (over: Partial<typeof LIMITS> = {}, parserModule: string | undefined = hostile) =>
  new ParseRunner({ limits: { ...LIMITS, ...over }, ...(parserModule ? { parserModule } : {}) });
const bytes = (s: string) => new TextEncoder().encode(s);

describe("ParseRunner", () => {
  it("runs the real txt parser in a child and returns a validated document", async () => {
    const r = runner({}, undefined);
    const doc = await r.run("txt", bytes("hello\nworld"));
    expect(doc.text).toBe("hello\nworld");
    expect(doc.sections).toHaveLength(1);
  });

  it("maps a parser's rejection to ParseRejectedError with its code", async () => {
    await expect(runner({}, undefined).run("txt", Uint8Array.from([0x41, 0, 0x42]))).rejects.toMatchObject({
      name: "ParseRejectedError",
      code: "unsupported_content",
    });
  });

  it("kills a parser that never returns", async () => {
    const r = runner({ wallClockMs: 200 });
    await expect(r.run("spin", bytes("x"))).rejects.toBeInstanceOf(ParseTimeoutError);
  });

  it("reports a child that exits without answering as a crash", async () => {
    const r = runner();
    await expect(r.run("exit", bytes("x"))).rejects.toBeInstanceOf(ParseCrashedError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @docmind/parsers build 2>&1 | tail -3; pnpm --filter @docmind/parsers exec vitest run src/runner`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`packages/parsers/src/runner/protocol.ts`:

```ts
import type { ParseRejectCode, ParsedDocument } from "../types";

/** Parent to child. `module` (tests only) replaces the default parser list. */
export interface ChildRequest {
  parserId: string;
  bytes: Uint8Array;
  module?: string;
}
/** Child to parent. Nothing but a document, a rejection code or "failed": never a message or stack. */
export type ChildReply =
  | { ok: true; doc: ParsedDocument }
  | { ok: false; kind: "rejected"; code: ParseRejectCode }
  | { ok: false; kind: "failed" };
```

`packages/parsers/src/runner/child.ts` (compiled to `dist/runner/child.js`, the process entry):

```ts
import { createDefaultParsers } from "../defaults";
import { ParserRegistry } from "../registry";
import { type DocumentParser, ParseRejectedError } from "../types";
import type { ChildReply, ChildRequest } from "./protocol";

const reply = (message: ChildReply) => process.send?.(message, () => process.exit(0));

process.once("message", async (request: ChildRequest) => {
  try {
    const parsers: DocumentParser[] = request.module
      ? (require(request.module) as { parsers: DocumentParser[] }).parsers
      : createDefaultParsers();
    const parser = new ParserRegistry(parsers).byId(request.parserId);
    if (!parser) return reply({ ok: false, kind: "failed" });
    reply({ ok: true, doc: await parser.parse(request.bytes) });
  } catch (err) {
    reply(err instanceof ParseRejectedError ? { ok: false, kind: "rejected", code: err.code } : { ok: false, kind: "failed" });
  }
});
```

`packages/parsers/src/runner/ParseRunner.ts`:

```ts
import { type ChildProcess, fork } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { ParseRejectedError, ParsedDocument } from "../types";
import type { ChildReply, ChildRequest } from "./protocol";

export interface ParseLimits {
  wallClockMs: number;
  memoryMb: number;
}
export interface ParseRunnerOptions {
  limits: ParseLimits;
  /** The compiled child entry. Default: `dist/runner/child.js` next to or above this file. */
  childEntry?: string;
  /** Tests only: a CommonJS file exporting `parsers`. */
  parserModule?: string;
}

export class ParseTimeoutError extends Error {
  constructor() {
    super("parse timed out");
    this.name = "ParseTimeoutError";
  }
}
export class ParseCrashedError extends Error {
  constructor() {
    super("parse crashed");
    this.name = "ParseCrashedError";
  }
}
/** The real (symlink-resolved) directory of a dependency, which the permission model needs spelled out. */
const packageRoot = (name: string): string => dirname(require.resolve(`${name}/package.json`));

const defaultEntry = (): string => {
  const sibling = join(__dirname, "child.js");
  return existsSync(sibling) ? sibling : join(__dirname, "../../dist/runner/child.js");
};

/**
 * Runs a parser on untrusted bytes in a fresh Node process: no filesystem beyond its own code, no
 * child processes, no inherited environment (the KEK and database URLs never reach it), stdio
 * ignored so a parser cannot block on a full pipe, killed with SIGKILL at the wall clock. Network
 * access is not covered by Node's permission model (see Open question 1).
 */
export class ParseRunner {
  constructor(private readonly options: ParseRunnerOptions) {}

  async run(parserId: string, bytes: Uint8Array): Promise<ParsedDocument> {
    const { limits } = this.options;
    const entry = this.options.childEntry ?? defaultEntry();
    const readable = [
      dirname(dirname(entry)), // the compiled package: the child's own code
      packageRoot("@docmind/contracts"),
      packageRoot("zod"),
      ...(this.options.parserModule ? [dirname(this.options.parserModule)] : []),
    ];
    const child = fork(entry, [], {
      execArgv: ["--permission", ...readable.map((p) => `--allow-fs-read=${p}`), `--max-old-space-size=${limits.memoryMb}`],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "advanced",
      env: {},
      cwd: dirname(entry),
    });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    try {
      return await this.exchange(child, { parserId, bytes, module: this.options.parserModule });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  }

  private exchange(child: ChildProcess, request: ChildRequest): Promise<ParsedDocument> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new ParseTimeoutError()), this.options.limits.wallClockMs);
      const done = () => clearTimeout(timer);
      child.once("message", (raw: ChildReply) => {
        done();
        if (raw && raw.ok === true) {
          const doc = ParsedDocument.safeParse(raw.doc);
          return doc.success ? resolve(doc.data) : reject(new ParseCrashedError());
        }
        if (raw && raw.ok === false && raw.kind === "rejected") return reject(new ParseRejectedError(raw.code));
        reject(new ParseCrashedError());
      });
      child.once("exit", () => {
        done();
        reject(new ParseCrashedError()); // ignored when a message already settled the promise
      });
      child.once("error", () => {
        done();
        reject(new ParseCrashedError());
      });
      child.send(request, (err) => {
        if (err) {
          done();
          reject(new ParseCrashedError());
        }
      });
    });
  }
}
```

Export from `index.ts`: `ParseRunner`, `ParseLimits`, `ParseRunnerOptions`, the two error classes, `createDefaultParsers` (from `defaults.ts`).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @docmind/parsers build && pnpm --filter @docmind/parsers exec vitest run`
Expected: PASS. The child reads only `dist` (its own code), the contracts package and zod; Task 70's permission probe proves nothing else is readable. `require.resolve` returns real paths, which is what `--allow-fs-read` needs under pnpm's symlinked `node_modules`; `@docmind/contracts` has no `exports` map and `zod` exports `package.json`.

- [ ] **Step 5: Close-out**

Branch `feat/parsers-runner`; subject `feat(parsers): resource-limited child-process parse runner`.

---

### Task 69b: input cap, character cap and noisy stdio

The cap on what may go into a parse (`maxInputBytes`, refused before any process starts), Decision D2's cap on how much text a parse may return (the sealed `parsed_documents` row is bounded by it), and the proof that a parser writing megabytes to stdout and stderr cannot wedge the runner (stdio is not piped at all).

**Files:**
- Modify: `packages/parsers/src/runner/protocol.ts`, `child.ts`, `ParseRunner.ts`
- Modify: `packages/parsers/test-fixtures/hostile.cjs`, `packages/parsers/src/runner/ParseRunner.test.ts`

**Interfaces:**
- Consumes: Task 69a.
- Produces: `ParseRunner.active(): number` (children currently alive); `ParseLimits.maxInputBytes: number` and `ParseLimits.maxChars: number`; `class ParseLimitError { readonly limit: "input" }` (message `parse input over limit`); `ChildRequest.maxChars`; an input over `maxInputBytes` is refused with `ParseLimitError` before any process starts; a parse whose `text.length` exceeds `maxChars` is `ParseRejectedError("too_large")`, checked in the child (before the reply is serialised) and again in the parent.

- [ ] **Step 1: Write the failing test**

Append to `hostile.cjs`'s list:

```js
  { id: "badshape", accepts: () => true, parse: () => ({ text: 7 }) },
  { id: "big", accepts: () => true, parse: () => ok("x".repeat(1000)) },
  { id: "noisy", accepts: () => true, parse: () => { for (let i = 0; i < 4000; i++) { process.stdout.write("x".repeat(1000)); process.stderr.write("y".repeat(1000)); } return ok("done"); } },
```

In `ParseRunner.test.ts` change `LIMITS` to `{ wallClockMs: 10_000, memoryMb: 256, maxInputBytes: 1024, maxChars: 500 }`, import `ParseLimitError`, and add:

```ts
  it("refuses an input over the limit before any process is started", async () => {
    const r = new ParseRunner({ limits: { ...LIMITS, maxInputBytes: 4 }, childEntry: "/nonexistent/child.js" });
    await expect(r.run("txt", bytes("12345"))).rejects.toMatchObject({ name: "ParseLimitError", limit: "input" });
  });

  it("treats an answer of the wrong shape as a crash, not as a document", async () => {
    await expect(runner().run("badshape", bytes("x"))).rejects.toBeInstanceOf(ParseCrashedError);
  });

  it("answers an unknown parser id as a crash, without naming the id", async () => {
    await expect(runner().run("nope", bytes("x"))).rejects.toThrow(/^parse crashed$/);
  });

  it("has fixed error messages", () => {
    expect([new ParseTimeoutError().message, new ParseCrashedError().message, new ParseLimitError("input").message]).toEqual([
      "parse timed out",
      "parse crashed",
      "parse input over limit",
    ]);
  });

  it("rejects text over maxChars as too_large", async () => {
    await expect(runner({ maxChars: 100 }).run("big", bytes("x"))).rejects.toMatchObject({ name: "ParseRejectedError", code: "too_large" });
  });

  it("accepts text at the cap", async () => {
    expect((await runner({ maxChars: 1000 }).run("big", bytes("x"))).text).toHaveLength(1000);
  });

  it("leaves no child behind after a success, a timeout or a crash", async () => {
    const r = runner({ wallClockMs: 200 });
    await r.run("echo", bytes("x"));
    await expect(r.run("spin", bytes("x"))).rejects.toBeInstanceOf(ParseTimeoutError);
    await expect(r.run("exit", bytes("x"))).rejects.toBeInstanceOf(ParseCrashedError);
    expect(r.active()).toBe(0);
  });

  it("is not blocked by a parser that writes megabytes to stdout and stderr (stdio is not piped)", async () => {
    const r = runner();
    expect((await r.run("noisy", bytes("x"))).text).toBe("done");
    expect(r.active()).toBe(0);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @docmind/parsers build 2>&1 | tail -3; pnpm --filter @docmind/parsers exec vitest run src/runner`
Expected: FAIL (`ParseLimitError` is not exported; the 1000-character result is accepted under `maxChars: 100`).

- [ ] **Step 3: Implement**

`ParseRunner.ts`: add `private readonly live = new Set<ChildProcess>();` with `active(): number { return this.live.size; }`, `this.live.add(child)` after the fork and `this.live.delete(child)` after `await exited`; add `class ParseLimitError extends Error { constructor(readonly limit: "input") { super(`parse ${limit} over limit`); this.name = "ParseLimitError"; } }`, `maxInputBytes` to `ParseLimits`, and `if (bytes.byteLength > limits.maxInputBytes) throw new ParseLimitError("input");` as the first line of `run`. `protocol.ts`: `ChildRequest` gains `maxChars: number`. `child.ts`: after `parse`, `const doc = await parser.parse(request.bytes); if (doc.text.length > request.maxChars) return reply({ ok: false, kind: "rejected", code: "too_large" }); reply({ ok: true, doc });`. `ParseLimits` gains `maxChars`; `exchange` is passed `maxChars: limits.maxChars`; on a valid shape the parent also checks `doc.data.text.length > this.options.limits.maxChars` and rejects with `new ParseRejectedError("too_large")` (a compromised child cannot skip the check).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @docmind/parsers build && pnpm --filter @docmind/parsers exec vitest run`
Expected: PASS.

- [ ] **Step 5: Close-out**

Branch `feat/parsers-runner-chars`; subject `feat(parsers): runner character cap, noisy-stdio proof`.

---

### Task 70: runner limits: heap, permission denial, concurrency, abort

**Files:**
- Modify: `packages/parsers/src/runner/ParseRunner.ts` (semaphore, `AbortSignal`, out-of-memory mapping, `ParseMemoryError`, `ParseAbortedError`)
- Modify: `packages/parsers/src/runner/ParseRunner.test.ts` (new cases)
- Modify: `packages/parsers/test-fixtures/hostile.cjs` (`hog`, `probe`)
- Modify: `docs/specs/2026-10-18-docmind-design.md` (§3.2 sandbox row, §5.2 parse row)

**Interfaces:**
- Consumes: Task 69.
- Produces: `ParseRunnerOptions.maxConcurrent?: number` (default 2); `active()` now counts runs that hold a slot (including one whose child is still starting), `queued()` runs waiting for one; `ParseRunner.run(parserId, bytes, opts?: { signal?: AbortSignal })`; `ParseRunner.queued(): number`; `class ParseMemoryError`, `class ParseAbortedError` (fixed messages `parse ran out of memory`, `parse aborted`).

- [ ] **Step 1: Write the failing test**

Append to `hostile.cjs`'s list:

```js
  { id: "hog", accepts: () => true, parse: () => { const keep = []; for (;;) keep.push(new Array(1_000_000).fill(1)); } },
  {
    id: "probe",
    accepts: () => true,
    parse: () => {
      const fs = require("node:fs");
      const code = (f) => { try { f(); return "allowed"; } catch (e) { return e.code; } };
      const result = {
        read: code(() => fs.readFileSync("/etc/hosts")),
        write: code(() => fs.writeFileSync(require("node:os").tmpdir() + "/dm-probe", "x")),
        spawn: code(() => require("node:child_process").execSync("true")),
        envKeys: Object.keys(process.env).length,
      };
      return ok(JSON.stringify(result));
    },
  },
```

Append to `ParseRunner.test.ts`:

```ts
import { ParseAbortedError, ParseMemoryError } from "./ParseRunner";

describe("ParseRunner limits", () => {
  it("kills a parser that exhausts its heap and reports ParseMemoryError", async () => {
    const r = runner({ memoryMb: 32 });
    await expect(r.run("hog", bytes("x"))).rejects.toBeInstanceOf(ParseMemoryError);
    expect(r.active()).toBe(0);
  });

  it("denies the child the filesystem, child processes and the parent's environment", async () => {
    process.env.DOCMIND_PROBE_SECRET = "must-not-reach-the-child";
    const out = JSON.parse((await runner().run("probe", bytes("x"))).text);
    delete process.env.DOCMIND_PROBE_SECRET;
    expect(out).toEqual({ read: "ERR_ACCESS_DENIED", write: "ERR_ACCESS_DENIED", spawn: "ERR_ACCESS_DENIED", envKeys: 0 });
  });

  it("runs at most maxConcurrent children and queues the rest, in order", async () => {
    const r = new ParseRunner({ limits: LIMITS, parserModule: hostile, maxConcurrent: 1 });
    const gate = new AbortController();
    const first = r.run("spin", bytes("x"), { signal: gate.signal });
    const second = r.run("echo", bytes("queued"));
    expect([r.active(), r.queued()]).toEqual([1, 1]);
    gate.abort();
    await expect(first).rejects.toBeInstanceOf(ParseAbortedError);
    expect((await second).text).toBe("queued");
    expect([r.active(), r.queued()]).toEqual([0, 0]);
  });

  it("drops an aborted run that is still waiting for a slot without ever starting a child", async () => {
    const r = new ParseRunner({ limits: LIMITS, parserModule: hostile, maxConcurrent: 1 });
    const hold = new AbortController();
    const first = r.run("spin", bytes("x"), { signal: hold.signal });
    const waiting = new AbortController();
    const second = r.run("echo", bytes("x"), { signal: waiting.signal });
    waiting.abort();
    await expect(second).rejects.toBeInstanceOf(ParseAbortedError);
    expect(r.queued()).toBe(0);
    hold.abort();
    await expect(first).rejects.toBeInstanceOf(ParseAbortedError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @docmind/parsers build 2>&1 | tail -2; pnpm --filter @docmind/parsers exec vitest run src/runner`
Expected: FAIL (`ParseMemoryError` etc. not exported; `maxConcurrent` unknown).

- [ ] **Step 3: Implement**

In `ParseRunner.ts`: add the two error classes (same shape as Task 69's); add `maxConcurrent?: number` to the options; add a private waiting list and `queued()`; make `run` take `opts?: { signal?: AbortSignal }`, acquire a slot before forking, release it in `finally`, and handle abort:

```ts
  private slots = 0;
  private readonly waiting: { start: () => void; drop: () => void }[] = [];
  queued(): number {
    return this.waiting.length;
  }
  private acquire(signal?: AbortSignal): Promise<void> {
    const max = this.options.maxConcurrent ?? 2;
    if (signal?.aborted) return Promise.reject(new ParseAbortedError());
    if (this.slots < max) {
      this.slots++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const entry = {
        start: () => { signal?.removeEventListener("abort", entry.drop); resolve(); },
        drop: () => { this.waiting.splice(this.waiting.indexOf(entry), 1); reject(new ParseAbortedError()); },
      };
      signal?.addEventListener("abort", entry.drop, { once: true });
      this.waiting.push(entry);
    });
  }
  private release(): void {
    const next = this.waiting.shift();
    if (next) next.start(); // the slot passes straight to the next run
    else this.slots--;
  }
```

`active()` now returns `this.slots`. `run` becomes: `await this.acquire(signal); try { the whole body of `run` from Task 69a } finally { this.release(); }`. In `exchange`, add an `abort` listener that kills the child and rejects `ParseAbortedError` (remove it when settled). In the `exit` handler, map a V8 out-of-memory abort to `ParseMemoryError`: `(code, signal) => reject(signal === "SIGABRT" || code === 134 ? new ParseMemoryError() : new ParseCrashedError())`. In `run`'s `finally`, kill the child on abort too (already done by the existing guard).

Spec edits: in `docs/specs/2026-10-18-docmind-design.md` §3.2 change the `@loom/plugin-sandbox` row to `| Parsers run in a resource-limited child process (Node permission model, heap limit, wall-clock kill) | DocMind \`ParseRunner\` (\`@loom/plugin-sandbox\` evaluates JSON-in/JSON-out QuickJS scripts and cannot host parser libraries) |`; in §5.2 the parse row change "Runs in `@loom/plugin-sandbox` with time and memory limits" to "Runs in a resource-limited child process (`ParseRunner`) with time and memory limits".

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @docmind/parsers build && pnpm --filter @docmind/parsers exec vitest run`
Expected: PASS. Verified on Node 24.18 while writing this plan: a forked child under `--permission --max-old-space-size=32` that allocates without bound exits with `code: null, signal: "SIGABRT"`, which is what the mapping above keys on; with `env: {}`, `stdio: ["ignore", "ignore", "ignore", "ipc"]` and `serialization: "advanced"` the IPC round trip works and file reads and writes fail with `ERR_ACCESS_DENIED`.

- [ ] **Step 5: Close-out**

Branch `feat/parsers-runner-limits`; subject `feat(parsers): runner heap limit, permission and concurrency tests`. Seam if over: abort and queue tests to a follow-up.

---

## Part C: the chunker (Tasks 71-72)

### Task 71: section-bounded chunker with locators

Spec §9 item 21, first half; Finding F2 explains why this is not `packParagraphs`. Pure and app-local (`apps/server/app/flows/ingest-document/chunker.ts`). Token count is estimated as `ceil(characters / 4)` (Open question 3); ~600 tokens is 2400 characters. A chunk's text is always an **exact slice** of its section's text, so the locator is exact and nothing is re-spaced.

**Files:**
- Create: `apps/server/app/flows/ingest-document/chunker.ts`
- Create: `apps/server/app/flows/ingest-document/chunker.test.ts`

**Interfaces:**
- Consumes: `ParsedDocument` from `@docmind/parsers`; `Locator` from `@docmind/contracts`. (Add `"@docmind/parsers": "workspace:*"` to `apps/server/package.json` here, since this is the first server import; lockfile not counted.)
- Produces:
  - `interface Chunk { ordinal: number; sectionOrdinal: number; headingPath: string[]; text: string; tokenCount: number; locator: Locator }`.
  - `interface ChunkOptions { targetTokens?: number; overlap?: number }` (defaults 600 and 0.15; Task 72 implements `overlap`).
  - `chunkDocument(doc: ParsedDocument, options?: ChunkOptions): Chunk[]`; `estimateTokens(text: string): number`.

- [ ] **Step 1: Write the failing test**

`chunker.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ParsedDocument } from "@docmind/parsers";
import { chunkDocument, estimateTokens } from "./chunker";

const doc = (...sections: { text: string; headingPath?: string[]; page?: number }[]): ParsedDocument => {
  let at = 0;
  const parts = sections.map((s) => {
    const start = at;
    at += s.text.length + 2;
    return {
      headingPath: s.headingPath ?? [],
      text: s.text,
      locator: s.page ? ({ kind: "page", page: s.page } as const) : ({ kind: "chars", start, end: start + s.text.length } as const),
    };
  });
  return { text: sections.map((s) => s.text).join("\n\n"), sections: parts, media: [] };
};
const para = (n: number, size = 400) => `Paragraph ${n} ${"word ".repeat(size / 5)}`.trim();

describe("chunkDocument", () => {
  it("makes one chunk for a short section, with the exact text and a chars locator", () => {
    const d = doc({ text: "Short text." });
    expect(chunkDocument(d, { overlap: 0 })).toEqual([
      { ordinal: 0, sectionOrdinal: 0, headingPath: [], text: "Short text.", tokenCount: 3, locator: { kind: "chars", start: 0, end: 11 } },
    ]);
  });

  it("packs paragraphs up to the target and starts a new chunk after it", () => {
    const text = [1, 2, 3, 4, 5, 6, 7].map((n) => para(n)).join("\n\n"); // ~400 chars each
    const chunks = chunkDocument(doc({ text }), { overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(2400);
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
    expect(chunks.map((c) => c.text).join("\n\n")).toBe(text); // no overlap: they tile the section
  });

  it("never lets a chunk cross a section boundary and carries each section's heading path", () => {
    const chunks = chunkDocument(doc({ text: "Alpha body.", headingPath: ["A"] }, { text: "Beta body.", headingPath: ["B", "B1"] }), { overlap: 0 });
    expect(chunks.map((c) => [c.sectionOrdinal, c.headingPath, c.text])).toEqual([
      [0, ["A"], "Alpha body."],
      [1, ["B", "B1"], "Beta body."],
    ]);
  });

  it("splits a paragraph longer than the target at whitespace, never mid-word, never mid-surrogate", () => {
    const text = `${"😀 ".repeat(1500)}end`;
    const chunks = chunkDocument(doc({ text }), { overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(2400);
      expect(c.text).not.toMatch(/[\ud800-\udbff]$/);
      expect(c.text).not.toMatch(/^[\udc00-\udfff]/);
    }
  });

  it("gives chars locators that slice the parsed text, and passes a page locator through", () => {
    const d = doc({ text: [1, 2, 3, 4].map((n) => para(n, 1000)).join("\n\n") });
    for (const c of chunkDocument(d, { overlap: 0 })) {
      expect(c.locator.kind).toBe("chars");
      if (c.locator.kind === "chars") expect(d.text.slice(c.locator.start, c.locator.end)).toBe(c.text);
    }
    expect(chunkDocument(doc({ text: "On a page.", page: 4 }), { overlap: 0 })[0]?.locator).toEqual({ kind: "page", page: 4 });
  });

  it("makes no chunks for an empty document and ignores whitespace-only sections", () => {
    expect(chunkDocument({ text: "", sections: [], media: [] })).toEqual([]);
    expect(chunkDocument(doc({ text: " \n\n " }))).toEqual([]);
  });

  it("honours a smaller target", () => {
    const chunks = chunkDocument(doc({ text: para(1, 1200) }), { targetTokens: 100, overlap: 0 });
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(400);
  });
});

describe("estimateTokens", () => {
  it("estimates four characters per token, at least one", () => {
    expect([estimateTokens("a"), estimateTokens("abcd"), estimateTokens("abcde")]).toEqual([1, 1, 2]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm install && pnpm --filter @docmind/server exec vitest run app/flows/ingest-document/chunker.test.ts`
Expected: FAIL (`./chunker` not found).

- [ ] **Step 3: Implement**

`chunker.ts`:

```ts
import type { Locator } from "@docmind/contracts";
import type { ParsedDocument } from "@docmind/parsers";

export interface Chunk {
  ordinal: number;
  sectionOrdinal: number;
  headingPath: string[];
  text: string;
  tokenCount: number;
  locator: Locator;
}
export interface ChunkOptions {
  targetTokens?: number;
  /** Fraction of the target repeated at the start of the next chunk of the same section. */
  overlap?: number;
}

const CHARS_PER_TOKEN = 4;
export const DEFAULT_TARGET_TOKENS = 600;
export const DEFAULT_OVERLAP = 0.15;

export const estimateTokens = (text: string): number => Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));

interface Span {
  start: number;
  end: number;
}

/** Non-empty paragraph spans (blank-line separated) of `text`, each at most `max` long. */
function units(text: string, max: number): Span[] {
  const out: Span[] = [];
  for (const m of text.matchAll(/\S[\s\S]*?(?=\n\s*\n|$)/g)) {
    let start = m.index as number;
    const end = start + m[0].trimEnd().length;
    while (end - start > max) {
      let cut = text.lastIndexOf(" ", start + max);
      if (cut <= start + max / 2) cut = start + max; // no usable space: hard cut
      if (/[\ud800-\udbff]/.test(text[cut - 1] ?? "")) cut--; // not between surrogates
      out.push({ start, end: cut });
      start = cut;
      while (start < end && /\s/.test(text[start] as string)) start++;
    }
    if (end > start) out.push({ start, end });
  }
  return out;
}

export function chunkDocument(doc: ParsedDocument, options: ChunkOptions = {}): Chunk[] {
  const max = (options.targetTokens ?? DEFAULT_TARGET_TOKENS) * CHARS_PER_TOKEN;
  const chunks: Chunk[] = [];
  doc.sections.forEach((section, sectionOrdinal) => {
    const spans = packed(units(section.text, max), max);
    for (const span of spans) {
      const text = section.text.slice(span.start, span.end);
      const base = section.locator.kind === "chars" ? section.locator.start : 0;
      chunks.push({
        ordinal: chunks.length,
        sectionOrdinal,
        headingPath: section.headingPath,
        text,
        tokenCount: estimateTokens(text),
        locator: section.locator.kind === "chars" ? { kind: "chars", start: base + span.start, end: base + span.end } : section.locator,
      });
    }
  });
  return chunks;
}

/** Greedy packing of consecutive units; a chunk spans from its first unit's start to its last unit's end. */
function packed(all: Span[], max: number): Span[] {
  const out: Span[] = [];
  let cur: Span | undefined;
  for (const u of all) {
    if (cur && u.end - cur.start > max) {
      out.push(cur);
      cur = undefined;
    }
    cur = cur ? { start: cur.start, end: u.end } : u;
  }
  if (cur) out.push(cur);
  return out;
}
```

The `overlap` option is accepted and ignored until Task 72; the tests above pass `overlap: 0` explicitly so Task 72 can switch the default on without touching them.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/ingest-document/chunker.test.ts`
Expected: PASS.

- [ ] **Step 5: Close-out**

Branch `feat/ingest-chunker`; subject `feat(server): section-bounded chunker with exact locators`. Files: `chunker.ts`, `chunker.test.ts`, and `apps/server/package.json` (+ lockfile).

---

### Task 72: ~15% overlap inside a section, and deterministic chunk ids

**Files:**
- Modify: `apps/server/app/flows/ingest-document/chunker.ts` (`packed` takes the overlap)
- Modify: `apps/server/app/flows/ingest-document/chunker.test.ts` (new cases)

**Interfaces:**
- Consumes: Task 71's `chunkDocument`, `ChunkOptions.overlap`.
- Produces: `chunkIdFor(documentId: string, ordinal: number): string` (Decision D4: a deterministic UUID, so a re-run of the chunk step writes the same ids and embedding is idempotent by id). `chunkDocument` keeps its signature; with the default `overlap` of 0.15, consecutive chunks **of one section** share about 15% of the target size (up to `floor(max * overlap)` characters); the first chunk of a section never starts earlier than the section start; a chunk never exceeds `max` characters including its overlap.

- [ ] **Step 1: Write the failing test**

Append to `chunker.test.ts` (and change its import to `import { chunkDocument, chunkIdFor, estimateTokens } from "./chunker";`):

```ts
describe("chunkIdFor", () => {
  it("derives a stable, well-formed UUID per document and ordinal, different for each", () => {
    const d = "11111111-1111-4111-8111-111111111111";
    const id = chunkIdFor(d, 0);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(chunkIdFor(d, 0)).toBe(id);
    expect(new Set([id, chunkIdFor(d, 1), chunkIdFor("22222222-2222-4222-8222-222222222222", 0)]).size).toBe(3);
  });
});

describe("overlap", () => {
  const long = (n: number) => Array.from({ length: n }, (_, i) => para(i + 1)).join("\n\n");

  it("starts each later chunk of a section inside the end of the previous one, by up to 15% of the target", () => {
    const d = doc({ text: long(12) });
    const chunks = chunkDocument(d);
    expect(chunks.length).toBeGreaterThan(2);
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!.locator;
      const cur = chunks[i]!.locator;
      if (prev.kind !== "chars" || cur.kind !== "chars") throw new Error("expected chars locators");
      const shared = prev.end - cur.start;
      expect(shared).toBeGreaterThan(0);
      expect(shared).toBeLessThanOrEqual(360);
      expect(chunks[i]!.text.length).toBeLessThanOrEqual(2400);
    }
  });

  it("does not start a chunk mid-word and still covers every character of the section", () => {
    const d = doc({ text: long(12) });
    const chunks = chunkDocument(d);
    for (const c of chunks.slice(1)) {
      if (c.locator.kind === "chars") expect(d.text[c.locator.start - 1] === " " || d.text[c.locator.start - 1] === "\n").toBe(true);
    }
    const covered = new Array<boolean>(d.text.length).fill(false);
    for (const c of chunks) if (c.locator.kind === "chars") for (let i = c.locator.start; i < c.locator.end; i++) covered[i] = true;
    expect(d.text.split("").every((ch, i) => /\s/.test(ch) || covered[i])).toBe(true);
  });

  it("does not carry text across sections", () => {
    const chunks = chunkDocument(doc({ text: long(8) }, { text: long(8) }));
    const second = chunks.filter((c) => c.sectionOrdinal === 1);
    const firstOfSecond = second[0]!;
    const lastOfFirst = chunks.filter((c) => c.sectionOrdinal === 0).at(-1)!;
    expect(firstOfSecond.locator.kind === "chars" && lastOfFirst.locator.kind === "chars" && firstOfSecond.locator.start >= lastOfFirst.locator.end).toBe(true);
  });

  it("is deterministic and equals the no-overlap tiling when overlap is 0", () => {
    const d = doc({ text: long(10) });
    expect(chunkDocument(d)).toEqual(chunkDocument(d));
    expect(chunkDocument(d, { overlap: 0 }).map((c) => c.text).join("\n\n")).toBe(d.text);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/ingest-document/chunker.test.ts`
Expected: FAIL (`shared` is 0 or negative: the chunks tile without overlap).

- [ ] **Step 3: Implement**

In `chunker.ts` add `import { createHash } from "node:crypto";` and

```ts
/** Deterministic, so a re-run of the chunk step writes the same ids and embedding is idempotent by id. */
export function chunkIdFor(documentId: string, ordinal: number): string {
  const h = createHash("sha256").update(`docmind-chunk-v1:${documentId}:${ordinal}`).digest();
  h[6] = ((h[6] as number) & 0x0f) | 0x50; // version 5 layout
  h[8] = ((h[8] as number) & 0x3f) | 0x80; // RFC 4122 variant
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}
```

and change `packed` to take `text` and `overlapChars` and, when it closes a chunk, start the next one earlier:

```ts
function packed(all: Span[], max: number, overlapChars: number, text: string): Span[] {
  const out: Span[] = [];
  let cur: Span | undefined;
  for (const u of all) {
    if (cur && u.end - cur.start > max) {
      out.push(cur);
      cur = { start: overlapStart(text, cur, u, overlapChars, max), end: u.end };
      continue;
    }
    cur = cur ? { start: cur.start, end: u.end } : u;
  }
  if (cur) out.push(cur);
  return out;
}

/** Where the next chunk begins: up to `overlapChars` before `next`, on a word start, within `max`, after the previous start. */
function overlapStart(text: string, prev: Span, next: Span, overlapChars: number, max: number): number {
  let at = Math.max(prev.start + 1, next.start - overlapChars, next.end - max);
  if (at >= next.start) return next.start;
  while (at < next.start && !/\s/.test(text[at - 1] as string)) at++; // snap forward to a word start
  return Math.min(at, next.start);
}
```

and in `chunkDocument` pass `Math.floor(max * (options.overlap ?? DEFAULT_OVERLAP))` and `section.text`. A chunk that starts at a unit boundary (no room to overlap) keeps `next.start`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/ingest-document/chunker.test.ts`
Expected: PASS (Task 71's cases pass `overlap: 0` and are unchanged).

- [ ] **Step 5: Close-out**

Branch `feat/ingest-chunker-overlap`; subject `feat(server): chunk overlap within a section`.

---

## Part D: flow foundations (Tasks 73-81)

### Task 73a: `stepEffect` and the ingest errors

The one place that decides what a step does when its document disappears (carry-forward 2), what a permanent content problem does, and what an unexpected error leaks into the event log (nothing). Every ingest effect from Task 78 on is built with it. **Revised 2026-10-19:** a step no longer writes any status. It first runs a `StepGuard` (is the document still there?) and a permanent failure is simply returned as the step's result, `{ outcome: "failed", code }`; the `ingest-status` model (Tasks 74b-74d) folds that result out of `STEP_COMPLETED`.

**Files:**
- Create: `apps/server/app/flows/ingest-document/errors.ts`
- Create: `apps/server/app/flows/ingest-document/stepEffect.ts`
- Create: `apps/server/app/flows/ingest-document/stepEffect.test.ts`

**Interfaces:**
- Consumes: `IngestStartInput` (`flow.ts`, M2), `IngestStep` (contracts), `FieldKeyUnavailableError` (`crypto/fields.ts`), `BlobKeyUnavailableError` (`@docmind/blob-store`), `Effect` (`@loom/effect-runtime`).
- Produces:
  - `errors.ts`: `class DocumentGoneError`; `class PermanentIngestError { readonly code: FailureCode }`; `FAILURE_CODES = ["unsupported_content", "corrupt_content", "too_large"] as const`, `type FailureCode`; `isDocumentGone(err: unknown): boolean` (true for `DocumentGoneError`, `FieldKeyUnavailableError`, `BlobKeyUnavailableError`, or any error whose `code` is Postgres `23503`).
  - `stepEffect.ts`: `StepResult` (zod, strict: `{ outcome: "done" | "document_gone" | "failed"; count?: number; model?: string; code?: FailureCode }`), `interface StepGuard { begin(ref: IngestStartInput, step: IngestStep): Promise<void> }` (throws `DocumentGoneError` when the document or its owner row is gone; writes nothing), and `stepEffect(step: IngestStep, guard: StepGuard, work: (ref: IngestStartInput) => Promise<{ count?: number; model?: string } | void>): Effect<IngestStartInput, StepResult>`.

- [ ] **Step 1: Write the failing tests**

`stepEffect.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { BlobKeyUnavailableError } from "@docmind/blob-store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FieldKeyUnavailableError } from "../../crypto/fields";
import { DocumentGoneError, PermanentIngestError } from "./errors";
import type { IngestStartInput } from "./flow";
import { type StepGuard, stepEffect } from "./stepEffect";

const ref = (): IngestStartInput => ({ tenantId: randomUUID(), userId: randomUUID(), documentId: randomUUID() });
const guard = () => {
  const calls: string[] = [];
  const port: StepGuard = { begin: async (_r, step) => void calls.push(`begin:${step}`) };
  return { port, calls };
};
const run = (work: Parameters<typeof stepEffect>[2], port: StepGuard) => stepEffect("chunk", port, work).execute(ref(), {} as never);

afterEach(() => vi.restoreAllMocks());

describe("stepEffect", () => {
  it("checks the document first, runs the work, and reports done with its count", async () => {
    const { port, calls } = guard();
    expect(await run(async () => ({ count: 3 }), port)).toEqual({ outcome: "done", count: 3 });
    expect(calls).toEqual(["begin:chunk"]);
  });

  it.each([
    ["DocumentGoneError", () => new DocumentGoneError()],
    ["a destroyed user key", () => new FieldKeyUnavailableError()],
    ["a destroyed blob key", () => new BlobKeyUnavailableError()],
    ["a foreign-key violation", () => Object.assign(new Error("insert or update violates foreign key"), { code: "23503" })],
  ])("treats %s as document_gone, not a failure", async (_n, make) => {
    const { port } = guard();
    expect(await run(async () => { throw make(); }, port)).toEqual({ outcome: "document_gone" });
  });

  it("treats a document that is gone at the check as document_gone and runs no work", async () => {
    const work = vi.fn();
    const port: StepGuard = { begin: async () => { throw new DocumentGoneError(); } };
    expect(await run(work, port)).toEqual({ outcome: "document_gone" });
    expect(work).not.toHaveBeenCalled();
  });

  it("returns a permanent failure as the step's result with its code, writing nothing itself", async () => {
    const { port, calls } = guard();
    const out = await run(async () => { throw new PermanentIngestError("corrupt_content"); }, port);
    expect(out).toEqual({ outcome: "failed", code: "corrupt_content" });
    expect(calls).toEqual(["begin:chunk"]); // the status model folds the code out of STEP_COMPLETED
  });

  it("rethrows anything else with a fixed message that names the step only, and logs the class", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { port } = guard();
    await expect(run(async () => { throw new TypeError("Quarterly report.txt: secret sentence"); }, port)).rejects.toThrow(
      /^ingest step failed: chunk$/,
    );
    expect(spy).toHaveBeenCalledWith("ingest step failed", "chunk", "TypeError");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/ingest-document/stepEffect.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`errors.ts`:

```ts
import { BlobKeyUnavailableError } from "@docmind/blob-store";
import { FieldKeyUnavailableError } from "../../crypto/fields";

/** The document, its row or its blob is gone (deleted or erased while a step ran): stop quietly. */
export class DocumentGoneError extends Error {
  constructor() {
    super("the document is gone");
    this.name = "DocumentGoneError";
  }
}

export const FAILURE_CODES = ["unsupported_content", "corrupt_content", "too_large"] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

/** Retrying the same bytes cannot help (spec 5.2 "permanent"). */
export class PermanentIngestError extends Error {
  constructor(readonly code: FailureCode) {
    super(`permanent ingest failure: ${code}`);
    this.name = "PermanentIngestError";
  }
}

const FK_VIOLATION = "23503";

export function isDocumentGone(err: unknown): boolean {
  return (
    err instanceof DocumentGoneError ||
    err instanceof FieldKeyUnavailableError ||
    err instanceof BlobKeyUnavailableError ||
    (typeof err === "object" && err !== null && (err as { code?: unknown }).code === FK_VIOLATION)
  );
}
```

`stepEffect.ts`:

```ts
import type { IngestStep } from "@docmind/contracts";
import type { Effect } from "@loom/effect-runtime";
import { z } from "zod";
import { FAILURE_CODES, PermanentIngestError, isDocumentGone } from "./errors";
import type { IngestStartInput } from "./flow";

/** What every step returns, and so what the event log holds: an outcome, a count, a model id, a code. Never text. */
export const StepResult = z
  .object({
    outcome: z.enum(["done", "document_gone", "failed"]),
    count: z.number().int().nonnegative().optional(),
    model: z.string().max(200).optional(),
    code: z.enum(FAILURE_CODES).optional(),
  })
  .strict();
export type StepResult = z.infer<typeof StepResult>;

/**
 * Called first by every step. Throws DocumentGoneError when the document (or its owner row) is
 * gone, and writes nothing: the document's status is the `ingest-status` model's job, folded from
 * the step events (Revision 2026-10-19).
 */
export interface StepGuard {
  begin(ref: IngestStartInput, step: IngestStep): Promise<void>;
}

const gone: StepResult = { outcome: "document_gone" };

export function stepEffect(
  step: IngestStep,
  guard: StepGuard,
  work: (ref: IngestStartInput) => Promise<{ count?: number; model?: string } | void>,
): Effect<IngestStartInput, StepResult> {
  return {
    kind: "tool",
    execute: async (ref) => {
      try {
        await guard.begin(ref, step);
        return { outcome: "done", ...((await work(ref)) ?? {}) };
      } catch (err) {
        if (isDocumentGone(err)) return gone;
        if (err instanceof PermanentIngestError) return { outcome: "failed", code: err.code };
        throw failure(step, err);
      }
    },
  };
}

/** A step failure's message is written to the event log: fixed text, the class goes to the process log. */
function failure(step: IngestStep, cause: unknown): Error {
  console.error("ingest step failed", step, cause instanceof Error ? cause.constructor.name : typeof cause);
  return new Error(`ingest step failed: ${step}`);
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/ingest-document`
Expected: PASS (the old stub tests are untouched).

- [ ] **Step 5: Close-out**

Branch `feat/ingest-step-effect`; subject `feat(server): stepEffect and the ingest errors`.

---

### Task 73b: `ProgressBus`

The in-process fan-out the status model's publisher (Task 74d) publishes to and the SSE route (Task 94b) reads from (Decision D8). It validates every event against the contract, so only the contract's fields can ever reach a client. **Revised 2026-10-19:** the scope is the user id alone. `users.id` is the table's global primary key, and the progress event is derived from an event whose plaintext execution id carries the user id but not the tenant id.

**Files:**
- Create: `apps/server/app/documents/progress.ts`
- Create: `apps/server/app/documents/progress.test.ts`

**Interfaces:**
- Consumes: `DocumentProgressEvent` (contracts).
- Produces: `interface ProgressScope { userId: string }`, `interface ProgressBus { publish(scope: ProgressScope, event: DocumentProgressEvent): void; subscribe(scope: ProgressScope, listener: (event: DocumentProgressEvent) => void): () => void }`, `class InMemoryProgressBus implements ProgressBus` (`publish` throws `Error("invalid progress event")` for an event that fails the contract and strips fields the contract does not know).

- [ ] **Step 1: Write the failing test**

`progress.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { InMemoryProgressBus } from "./progress";

const scope = () => ({ userId: randomUUID() });
const event = (documentId = randomUUID()) => ({ documentId, step: "parse", status: "parsing" }) as const;

describe("InMemoryProgressBus", () => {
  it("delivers to subscribers of the same user only", () => {
    const bus = new InMemoryProgressBus();
    const a = scope();
    const seenA: unknown[] = [];
    const seenOther: unknown[] = [];
    bus.subscribe(a, (e) => seenA.push(e));
    bus.subscribe(scope(), (e) => seenOther.push(e));
    const e = event();
    bus.publish(a, e);
    expect(seenA).toEqual([e]);
    expect(seenOther).toEqual([]);
  });

  it("stops delivering after unsubscribe, and a throwing listener does not stop the others", () => {
    const bus = new InMemoryProgressBus();
    const s = scope();
    const seen: unknown[] = [];
    bus.subscribe(s, () => { throw new Error("bad listener"); });
    const off = bus.subscribe(s, (e) => seen.push(e));
    bus.publish(s, event());
    off();
    bus.publish(s, event());
    expect(seen).toHaveLength(1);
  });

  it("refuses an event with a field outside the contract, naming no value", () => {
    const bus = new InMemoryProgressBus();
    expect(() => bus.publish(scope(), { ...event(), step: "nope" } as never)).toThrow(/invalid progress event/);
  });

  it("strips fields the contract does not know before delivering", () => {
    const bus = new InMemoryProgressBus();
    const s = scope();
    const seen: unknown[] = [];
    bus.subscribe(s, (e) => seen.push(e));
    bus.publish(s, { ...event(), filename: "secret.txt" } as never);
    expect(Object.keys(seen[0] as object).sort()).toEqual(["documentId", "status", "step"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @docmind/server exec vitest run app/documents/progress.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`progress.ts`:

```ts
import { DocumentProgressEvent } from "@docmind/contracts";

export interface ProgressScope {
  userId: string;
}
export interface ProgressBus {
  publish(scope: ProgressScope, event: DocumentProgressEvent): void;
  subscribe(scope: ProgressScope, listener: (event: DocumentProgressEvent) => void): () => void;
}

/** In-process (Decision D8). A Postgres LISTEN/NOTIFY bus can replace it behind the same interface. */
export class InMemoryProgressBus implements ProgressBus {
  private readonly listeners = new Map<string, Set<(event: DocumentProgressEvent) => void>>();

  publish(scope: ProgressScope, event: DocumentProgressEvent): void {
    const parsed = DocumentProgressEvent.safeParse(event);
    if (!parsed.success) throw new Error("invalid progress event");
    for (const listener of [...(this.listeners.get(scope.userId) ?? [])]) {
      try {
        listener(parsed.data);
      } catch {
        // one subscriber's failure must not stop the publisher or the other subscribers
      }
    }
  }

  subscribe(scope: ProgressScope, listener: (event: DocumentProgressEvent) => void): () => void {
    const set = this.listeners.get(scope.userId) ?? new Set();
    set.add(listener);
    this.listeners.set(scope.userId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(scope.userId);
    };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @docmind/server exec vitest run app/documents/progress.test.ts`
Expected: PASS.

- [ ] **Step 5: Close-out**

Branch `feat/ingest-progress-bus`; subject `feat(server): in-process progress bus`.

---

### Task 74a: `0012` folded-state tables and their row-level security

Revision R2. DocMind's own migration creates the tables Loom's folded read models write, from Loom's DDL text (`foldedStateDdl`, D10), and gives each role exactly what it needs: the Loom role writes every tenant's rows, the app role reads its tenant's. Nothing uses the tables yet.

**Files:**
- Create: `infra/migrations/0012_ingest_status_model.sql`
- Create: `apps/server/app/db/ingestStatusTables.pg.test.ts`

**Interfaces:**
- Consumes: `app_tenant_id()` (`0002`), `users` (`0002`), the `docmind_loom` role (`0008`), `foldedStateDdl` (`@loom/plugin-postgres`), `MIGRATIONS_DIR`, `migrate`, `setAppRolePassword`, `setRolePassword`, `createTestDb`, `seedUsers`, `T1`, `T2`, `U1`, `U1B`, `U2` (the harness).
- Produces: tables `public.read_model_folds` and `public.read_model_state` (Loom's folded-state layout: `model_id, execution_id, app_key, scope, sequence, state, erased`), the check `read_model_state_scope_uuid`, policies `ingest_all` (both tables, `TO docmind_loom`, `FOR ALL`) and `tenant_read` (`read_model_state`, `TO docmind_app`, `FOR SELECT`), and these privileges: `docmind_loom` `SELECT, INSERT, UPDATE, DELETE` on both tables; `docmind_app` `SELECT` on `read_model_state` only.

- [ ] **Step 1: Write the failing test**

`ingestStatusTables.pg.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { foldedStateDdl } from "@loom/plugin-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { T1, T2, U1, U1B, U2, seedUsers } from "../documents/testHarness";
import { MIGRATIONS_DIR, migrate, setAppRolePassword, setRolePassword } from "./migrate";
import { withTenant } from "./tenant";
import { APP_PASSWORD, LOOM_PASSWORD, PG_URL, type TestDb, createTestDb } from "./testSupport";

const squash = (sql: string) => sql.replace(/\s+/g, " ").trim();

describe.skipIf(!PG_URL)("0012 ingest-status tables (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;
  let loom: Pool;
  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await setRolePassword(db.owner, "docmind_loom", LOOM_PASSWORD);
    await seedUsers(db.owner);
    app = new Pool({ connectionString: db.appUrl });
    loom = new Pool({ connectionString: db.loomUrl });
    for (const [key, scope] of [["d1", U1], ["d2", U1B], ["d3", U2], ["d4", null]] as const) {
      await db.owner.query(
        "INSERT INTO public.read_model_state (model_id, execution_id, app_key, scope, sequence) VALUES ('ingest-status', $1, $2, $3, 0)",
        [`e-${key}`, key, scope],
      );
    }
  });
  afterAll(async () => {
    await app?.end();
    await loom?.end();
    await db?.drop();
  });

  it("contains the text of Loom's foldedStateDdl for schema public, so a Loom change shows up here", () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, "0012_ingest_status_model.sql"), "utf8");
    expect(squash(sql)).toContain(squash(foldedStateDdl({ schema: "public" })));
  });

  it("gives the Loom role write access to both tables and the app role read access to the state table only", async () => {
    const has = async (role: string, table: string, privilege: string) =>
      (await db.owner.query("SELECT has_table_privilege($1, $2, $3) AS ok", [role, `public.${table}`, privilege])).rows[0].ok as boolean;
    const privileges = ["SELECT", "INSERT", "UPDATE", "DELETE"];
    for (const table of ["read_model_state", "read_model_folds"]) {
      expect(await Promise.all(privileges.map((p) => has("docmind_loom", table, p)))).toEqual([true, true, true, true]);
    }
    expect(await Promise.all(privileges.map((p) => has("docmind_app", "read_model_state", p)))).toEqual([true, false, false, false]);
    expect(await has("docmind_app", "read_model_folds", "SELECT")).toBe(false);
  });

  it("shows the app role only rows whose scope is a user of the transaction's tenant, and none without a tenant", async () => {
    const keys = (tenant: string) =>
      withTenant(app, tenant, async (tx) => (await tx.query("SELECT app_key FROM read_model_state ORDER BY app_key")).rows.map((r) => r.app_key));
    expect(await keys(T1)).toEqual(["d1", "d2"]);
    expect(await keys(T2)).toEqual(["d3"]);
    expect((await app.query("SELECT app_key FROM read_model_state")).rows).toEqual([]);
  });

  it("lets the Loom role see and change every tenant's rows, and refuses a scope that is not a canonical uuid", async () => {
    expect((await loom.query("SELECT count(*)::int AS n FROM public.read_model_state")).rows[0].n).toBe(4);
    expect((await loom.query("UPDATE public.read_model_state SET sequence = 1 WHERE app_key = 'd3'")).rowCount).toBe(1);
    await expect(
      loom.query("INSERT INTO public.read_model_state (model_id, execution_id, scope, sequence) VALUES ('m', 'x', 'not-a-uuid', 0)"),
    ).rejects.toThrow(/read_model_state_scope_uuid/);
  });

  it("refuses the app role any write, and any access to the folds table", async () => {
    await expect(app.query("DELETE FROM public.read_model_state")).rejects.toThrow(/permission denied for table read_model_state/);
    await expect(app.query("SELECT * FROM public.read_model_folds")).rejects.toThrow(/permission denied for table read_model_folds/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:55432/postgres && pnpm --filter @docmind/server exec vitest run app/db/ingestStatusTables.pg.test.ts`
Expected: FAIL (no such migration file; no such table).

- [ ] **Step 3: Implement**

`infra/migrations/0012_ingest_status_model.sql` (the first statement block is Loom's `foldedStateDdl({ schema: "public" })` verbatim; the test pins that):

```sql
-- Durable status of a document's ingest, folded from the flow's events by Loom's read-model
-- plugin (ADR 0132). The two tables are Loom's folded-state layout, created here (D10) so the
-- migrator owns them: docmind_loom must never own a table with row-level security (the server
-- refuses to start if it does), and the policy below reads users, which lives in this schema.
CREATE TABLE IF NOT EXISTS "public"."read_model_folds" (
  model_id TEXT PRIMARY KEY,
  version TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS "public"."read_model_state" (
  model_id TEXT NOT NULL,
  execution_id TEXT COLLATE "C" NOT NULL,
  app_key TEXT,
  scope TEXT,
  sequence BIGINT NOT NULL,
  state JSONB,
  erased BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (model_id, execution_id)
);
CREATE INDEX IF NOT EXISTS "read_model_state_key_idx" ON "public"."read_model_state" (model_id, app_key) WHERE app_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS "read_model_state_scope_idx" ON "public"."read_model_state" (model_id, scope) WHERE scope IS NOT NULL;

-- scope is a user id (the model's scopeOf) or NULL; the policy casts it, so nothing else may be stored.
ALTER TABLE "public"."read_model_state" ADD CONSTRAINT read_model_state_scope_uuid
  CHECK (scope IS NULL OR scope ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

-- 0001's default privileges give docmind_app every right on new tables; take them back.
REVOKE ALL ON "public"."read_model_state", "public"."read_model_folds" FROM PUBLIC, docmind_app;
GRANT USAGE ON SCHEMA public TO docmind_loom;
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."read_model_state", "public"."read_model_folds" TO docmind_loom;
GRANT SELECT ON "public"."read_model_state" TO docmind_app;

ALTER TABLE "public"."read_model_state" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."read_model_folds" ENABLE ROW LEVEL SECURITY;

-- The Loom role (the service's writer: live feed, catch-up, refresh, purge) writes every tenant's
-- rows. FOR ALL, because INSERT ... ON CONFLICT needs to see the row it conflicts with.
CREATE POLICY ingest_all ON "public"."read_model_state" FOR ALL TO docmind_loom USING (true) WITH CHECK (true);
CREATE POLICY ingest_all ON "public"."read_model_folds" FOR ALL TO docmind_loom USING (true) WITH CHECK (true);

-- The app role reads the rows of the users of its transaction's tenant (app_tenant_id() is NULL
-- without a tenant, which matches nothing).
CREATE POLICY tenant_read ON "public"."read_model_state" FOR SELECT TO docmind_app
  USING (scope IS NOT NULL AND EXISTS (
    SELECT 1 FROM "public"."users" u WHERE u.id = scope::uuid AND u.tenant_id = app_tenant_id()));
```

- [ ] **Step 4: Run to verify it passes**

Run: `export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:55432/postgres && pnpm --filter @docmind/server exec vitest run app/db`
Expected: PASS, including M0's "row-level security on every table" guard and the `docmind_loom` role tests (it still cannot read `users` or `data_keys`).

- [ ] **Step 5: Close-out**

Branch `feat/db-ingest-status-tables`; subject `feat(db): folded-state tables for the ingest status model, with tenant row-level security`.

---

### Task 74b: the `ingest-status` model: the fold, the key, the scope, the view

Revision R1 and R9. The pure half of the status design: one `projection$` fold over the ingest flow's events, the two id parsers Loom's folded model needs, and the mapping from a state to what the API returns. No database, no Loom service yet (`progressOf`, the SSE event derived from the same handlers, joins in Task 74d). This task also moves DocMind onto the Loom commit that has ADR 0132 and adds the plugin as a dependency.

**Files:**
- Create: `apps/server/app/status/model.ts`
- Create: `apps/server/app/status/model.test.ts`
- Create: `apps/server/app/status/testing.ts` (event builders, shared by Tasks 74c, 74e, 79c, 94b; Task 74c adds the in-memory log)
- Modify: `.github/workflows/ci.yml` (`LOOM_REF`)
- Modify: `package.json` (`pnpm.overrides`: `@loom/plugin-read-model`, `@loom/event-runtime`)
- Modify: `apps/server/package.json` (dependency `@loom/plugin-read-model`, dev dependency `@loom/event-runtime`)

**Interfaces:**
- Consumes: `FAILURE_CODES`, `FailureCode` (73a), `DocumentStatus`, `IngestStep` (contracts; `IngestStep` has `link` from Task 65), `projection$`, `EventEnvelope` (`@loom/core`).
- Produces (all in `status/model.ts`):
  - `INGEST_STATUS_MODEL = "ingest-status"`; `type StatusCode = FailureCode | "internal"`; `interface IngestStatusState { status: DocumentStatus; step: IngestStep | null; code: StatusCode | null }`; `INITIAL_STATUS`.
  - `STATUS_OF_STEP: Record<IngestStep, DocumentStatus>` (Decision D7, amended: `finalize` is `embedding` while it runs; `ready` is set by its completion); `STATUS_MESSAGES: Record<StatusCode, string>` (the fixed text shown for a failure; never content).
  - `ingestKeyOf(executionId): string | undefined` (the document id; the `.<generation>` suffix is dropped), `ingestScopeOf(executionId): string | undefined` (the user id), `generationOf(executionId): number` (no suffix is generation 1), `isIngestExecution(executionId): boolean`.
  - `ingestHandlers` (event type -> `(state, event) => state`), `ingestStatus` (the `projection$` definition, `version: "1"`), `foldIngestStatus(events: readonly EventEnvelope[]): IngestStatusState` (pure; for tests and for proving the model against a real log).
  - `interface StatusView { status: DocumentStatus; step: IngestStep | null; error: string | null }`, `UPLOADED: StatusView`, `viewOf(state: IngestStatusState): StatusView`.
- Produces (`status/testing.ts`): `evt(executionId, sequence, eventType, payload?): EventEnvelope`; `ingestRun(executionId, spec: "started" | "parsed" | "ready" | "failed:<code>"): EventEnvelope[]` (a realistic run from sequence 0).

- [ ] **Step 1: Write the failing test**

`status/model.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { FAILURE_CODES } from "../flows/ingest-document/errors";
import {
  INITIAL_STATUS, STATUS_MESSAGES, STATUS_OF_STEP, UPLOADED, foldIngestStatus, generationOf, ingestKeyOf,
  ingestScopeOf, ingestStatus, isIngestExecution, viewOf,
} from "./model";
import { evt, ingestRun } from "./testing";

const U = randomUUID();
const D = randomUUID();
const exec = (suffix = "") => `u_${U}:ingest-${D}${suffix}`;

describe("execution ids", () => {
  it.each([[""], [".2"], [".12"]])("maps generation suffix %j to the document and the user", (suffix) => {
    expect([ingestKeyOf(exec(suffix)), ingestScopeOf(exec(suffix)), isIngestExecution(exec(suffix))]).toEqual([D, U, true]);
  });
  it.each([[`u_${U}:chat-${D}`], [`u_${U}:ingest-${D}.x`], [`u_${U}:ingest-${D.toUpperCase()}`], [`x:ingest-${D}`], [""]])("treats %j as no ingest execution", (id) => {
    expect([ingestKeyOf(id), ingestScopeOf(id), isIngestExecution(id)]).toEqual([undefined, undefined, false]);
  });
  it("reads the generation, with no suffix meaning 1", () => {
    expect([exec(""), exec(".2"), exec(".10")].map(generationOf)).toEqual([1, 2, 10]);
  });
});

describe("the fold", () => {
  it("starts at uploaded and follows the steps: parse and chunk are parsing, the rest embedding, finalize's completion is ready", () => {
    expect(Object.values(STATUS_OF_STEP).filter((v) => v === "embedding")).toHaveLength(5); // embed, analyze, summarize, link, finalize
    expect(foldIngestStatus([])).toEqual(INITIAL_STATUS);
    expect(foldIngestStatus(ingestRun(exec(), "started"))).toEqual({ status: "uploaded", step: null, code: null });
    expect(foldIngestStatus(ingestRun(exec(), "parsed"))).toEqual({ status: "parsing", step: "parse", code: null });
    expect(foldIngestStatus(ingestRun(exec(), "ready"))).toEqual({ status: "ready", step: "finalize", code: null });
  });

  it("ends failed with the code of a permanent failure, and the view carries the fixed message", () => {
    const state = foldIngestStatus(ingestRun(exec(), "failed:corrupt_content"));
    expect(state).toEqual({ status: "failed", step: "parse", code: "corrupt_content" });
    expect(viewOf(state)).toEqual({ status: "failed", step: "parse", error: STATUS_MESSAGES.corrupt_content });
  });

  it("maps an unknown failure code to internal, and an execution failure to failed/internal without overwriting a specific code", () => {
    const odd = [...ingestRun(exec(), "parsed"), evt(exec(), 9, "STEP_COMPLETED", { stepId: "ingest-parse", output: { outcome: "failed", code: "whatever" } })];
    expect(foldIngestStatus(odd)).toMatchObject({ status: "failed", code: "internal" });
    const crashed = [...ingestRun(exec(), "parsed"), evt(exec(), 9, "EXECUTION_FAILED", {})];
    expect(foldIngestStatus(crashed)).toMatchObject({ status: "failed", code: "internal", step: "parse" });
    const specific = [...ingestRun(exec(), "failed:too_large"), evt(exec(), 9, "EXECUTION_FAILED", {})];
    expect(foldIngestStatus(specific).code).toBe("too_large");
  });

  it("ignores document_gone and plain done outcomes, steps that are not ingest steps, other event kinds and shredded payloads", () => {
    const events = [
      ...ingestRun(exec(), "parsed"),
      evt(exec(), 10, "STEP_COMPLETED", { stepId: "ingest-parse", output: { outcome: "done", count: 3 } }),
      evt(exec(), 11, "STEP_COMPLETED", { stepId: "ingest-chunk", output: { outcome: "document_gone" } }),
      evt(exec(), 12, "STEP_STARTED", { stepId: "something-else" }),
      evt(exec(), 13, "TIMER_FIRED", {}),
      evt(exec(), 14, "STEP_STARTED", { $shredded: true }),
      evt(exec(), 15, "STEP_COMPLETED", { stepId: "ingest-finalize", output: "[redacted]" }),
    ];
    expect(foldIngestStatus(events)).toEqual({ status: "parsing", step: "parse", code: null });
  });

  it("is registered as one durable fold, with enums and codes only: a message per code, no content", () => {
    expect([ingestStatus.id, ingestStatus.version, ingestStatus.initialState]).toEqual(["ingest-status", "1", INITIAL_STATUS]);
    expect(Object.keys(ingestStatus.handlers).sort()).toEqual(["EXECUTION_FAILED", "EXECUTION_STARTED", "STEP_COMPLETED", "STEP_STARTED"]);
    expect(Object.keys(STATUS_MESSAGES).sort()).toEqual([...FAILURE_CODES, "internal"].sort());
    expect(UPLOADED).toEqual({ status: "uploaded", step: null, error: null });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @docmind/server exec vitest run app/status/model.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

First the dependency and pin changes. Root `package.json` `pnpm.overrides` gains `"@loom/event-runtime": "link:../loom/packages/event-runtime"` and `"@loom/plugin-read-model": "link:../loom/plugins/read-model"`; `apps/server/package.json` gains `"@loom/plugin-read-model": "*"` under `dependencies` and `"@loom/event-runtime": "*"` under `devDependencies`; `.github/workflows/ci.yml` line `LOOM_REF: 8f9eab2492c85bb994d746855f06d2eccc9f45db` becomes `LOOM_REF: 006dfdaf63319fa61594c42e2d5b2c8b87add2ca`. Then, with `../loom` at that commit and built (`git -C ../loom rev-parse HEAD`), run `pnpm install` and commit the lockfile.

`status/model.ts`:

```ts
import type { DocumentStatus, IngestStep } from "@docmind/contracts";
import { type EventEnvelope, projection$ } from "@loom/core";
import { FAILURE_CODES, type FailureCode } from "../flows/ingest-document/errors";

export const INGEST_STATUS_MODEL = "ingest-status";

export type StatusCode = FailureCode | "internal";

export interface IngestStatusState {
  status: DocumentStatus;
  step: IngestStep | null;
  code: StatusCode | null;
}
export const INITIAL_STATUS: IngestStatusState = { status: "uploaded", step: null, code: null };

/** Decision D7. The spec's enum has no "analyzing"; `finalize` is `embedding` until it completes. */
export const STATUS_OF_STEP: Record<IngestStep, DocumentStatus> = {
  parse: "parsing", chunk: "parsing", embed: "embedding", analyze: "embedding",
  summarize: "embedding", link: "embedding", finalize: "embedding",
};

/** Fixed text shown to the user for a failed document. It never includes content. */
export const STATUS_MESSAGES: Record<StatusCode, string> = {
  unsupported_content: "This file's content is not a supported document.",
  corrupt_content: "This file could not be read; it may be damaged or use an unsupported encoding.",
  too_large: "This document is too large to process.",
  internal: "Processing failed. Please try again later.",
};

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const INGEST_EXECUTION = new RegExp(`^u_(${UUID}):ingest-(${UUID})(?:\\.(\\d+))?$`);

export const ingestKeyOf = (executionId: string): string | undefined => INGEST_EXECUTION.exec(executionId)?.[2];
export const ingestScopeOf = (executionId: string): string | undefined => INGEST_EXECUTION.exec(executionId)?.[1];
export const isIngestExecution = (executionId: string): boolean => INGEST_EXECUTION.test(executionId);
export const generationOf = (executionId: string): number => Number(INGEST_EXECUTION.exec(executionId)?.[3] ?? 1);

const STEP_OF_ID = new Map<string, IngestStep>(
  (Object.keys(STATUS_OF_STEP) as IngestStep[]).map((step) => [`ingest-${step}`, step]),
);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// The handler sees a masked copy of the event; a shredded payload is `{ $shredded: true }` (skip it, ADR 0132 D12).
const payloadOf = (e: EventEnvelope): Record<string, unknown> => (isRecord(e.payload) && e.payload.$shredded !== true ? e.payload : {});
const stepOf = (p: Record<string, unknown>): IngestStep | undefined => STEP_OF_ID.get(String(p.stepId));
const codeOf = (v: unknown): StatusCode => ((FAILURE_CODES as readonly unknown[]).includes(v) ? (v as FailureCode) : "internal");

type Handler = (state: IngestStatusState, event: EventEnvelope) => IngestStatusState;

export const ingestHandlers = {
  // The row exists from the start of the execution; that is also what the stale-upload sweep looks for.
  EXECUTION_STARTED: (s) => s,
  STEP_STARTED: (s, e) => {
    const step = stepOf(payloadOf(e));
    return step ? { status: STATUS_OF_STEP[step], step, code: null } : s;
  },
  STEP_COMPLETED: (s, e) => {
    const p = payloadOf(e);
    const step = stepOf(p);
    const out = isRecord(p.output) ? p.output : {};
    if (!step) return s;
    if (out.outcome === "failed") return { status: "failed", step, code: codeOf(out.code) };
    if (step === "finalize" && out.outcome === "done") return { status: "ready", step, code: null };
    return s;
  },
  EXECUTION_FAILED: (s) => (s.status === "failed" ? s : { ...s, status: "failed", code: "internal" }),
} satisfies Record<string, Handler>;

/** The durable fold (ADR 0132). Bump `version` when a handler's meaning changes: Loom re-folds at boot. */
export const ingestStatus = projection$<IngestStatusState>({
  id: INGEST_STATUS_MODEL,
  name: "IngestStatus",
  version: "1",
  initialState: INITIAL_STATUS,
  handlers: ingestHandlers,
});

export function foldIngestStatus(events: readonly EventEnvelope[]): IngestStatusState {
  const handlers: Record<string, Handler> = ingestHandlers;
  return events.reduce((state, e) => handlers[e.eventType]?.(state, e) ?? state, INITIAL_STATUS);
}

export interface StatusView {
  status: DocumentStatus;
  step: IngestStep | null;
  error: string | null;
}
export const UPLOADED: StatusView = { status: "uploaded", step: null, error: null };

export const viewOf = (s: IngestStatusState): StatusView => ({
  status: s.status,
  step: s.step,
  error: s.code === null ? null : STATUS_MESSAGES[s.code],
});
```

`status/testing.ts`:

```ts
import type { EventEnvelope } from "@loom/core";

/** An event the way Loom writes one (fields as in `EventEnvelope`). */
export const evt = (executionId: string, sequence: number, eventType: string, payload: unknown = {}): EventEnvelope => ({
  id: `${executionId}-${sequence}`,
  workflowId: "ingest-document",
  executionId,
  eventType,
  sequence,
  timestamp: 1_000 + sequence,
  payload,
});

/** The events of one ingest execution, from sequence 0: just started, parsing, ready, or failed with a code. */
export function ingestRun(executionId: string, spec: "started" | "parsed" | "ready" | `failed:${string}`): EventEnvelope[] {
  const out: EventEnvelope[] = [evt(executionId, 0, "EXECUTION_STARTED", { input: {} })];
  const step = (type: string, stepId: string, output?: unknown) =>
    out.push(evt(executionId, out.length, type, output === undefined ? { stepId } : { stepId, output }));
  if (spec === "started") return out;
  step("STEP_STARTED", "ingest-parse");
  if (spec === "parsed") return out;
  if (spec.startsWith("failed:")) {
    step("STEP_COMPLETED", "ingest-parse", { outcome: "failed", code: spec.slice(7) });
    return out;
  }
  step("STEP_COMPLETED", "ingest-parse", { outcome: "done", count: 1 });
  step("STEP_STARTED", "ingest-finalize");
  step("STEP_COMPLETED", "ingest-finalize", { outcome: "done", count: 1 });
  return out;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @docmind/server exec vitest run app/status/model.test.ts && pnpm typecheck`
Expected: PASS. The event type names (`STEP_STARTED`, `STEP_COMPLETED`, `EXECUTION_STARTED`, `EXECUTION_FAILED`) and the payload keys `stepId` and `output` are the kernel's (`@loom/replay-vm` `eventHandlers.ts`); Task 81 proves them against a real log.

- [ ] **Step 5: Close-out**

Branch `feat/status-model`; subject `feat(server): the ingest-status fold, keys and view`. Files excluded from the count: `pnpm-lock.yaml`. The `LOOM_REF` bump follows the procedure in the workflow's own comment: rebuild `../loom` at that commit, run the whole gate, then change the line.

---

### Task 74c: `IngestStatus`: register, feed, catch up, read

Revision R3 and R5. One class owns the Loom `ReadModelService` for the `ingest-status` model: boot (register, then catch up), the live feed (`onEvent`), and the two read paths (a page, and the one document a request touched). It is written against Loom's `ReadModelStore` interface and tested over `InMemoryReadModelStore`; Task 74d adds the SSE publisher, Task 74e the Postgres stores and the erasure methods.

**Files:**
- Create: `apps/server/app/status/ingestStatus.ts`
- Create: `apps/server/app/status/ingestStatus.test.ts`
- Modify: `apps/server/app/status/testing.ts` (`MemoryLog`)

**Interfaces:**
- Consumes: `ReadModelService`, `ReadModelStore`, `ReadModelEventSource`, `SensitiveMap`, `foldedStates` (`@loom/plugin-read-model`); `INGEST_STATUS_MODEL`, `ingestStatus`, `ingestKeyOf`, `ingestScopeOf`, `generationOf`, `viewOf`, `UPLOADED`, `StatusView`, `IngestStatusState`, `evt`, `ingestRun` (74b); `ingestExecutionId(userId, documentId)` (`documents/ingest.ts`; the current generation, which Task 76 turns into generation 2); `Identity` (`@docmind/auth`).
- Produces: `interface IngestStatusOptions { writer: ReadModelStore; readerFor(identity: Identity): ReadModelStore; source: ReadModelEventSource; sensitive: SensitiveMap; onError?(err: unknown): void }` and `class IngestStatus` with `boot(): Promise<{ rebuilt: boolean; executionsScanned: number }>`, `onEvent: (event: EventEnvelope) => void` (an arrow property: pass it as is; it never throws), `forPage(identity, documentIds: readonly string[]): Promise<Map<string, StatusView>>`, `forDocument(identity, documentId): Promise<StatusView>`, `close(): Promise<void>`; and, in `status/testing.ts`, `class MemoryLog implements ReadModelEventSource { append(...events: EventEnvelope[]): void; listExecutions(): Promise<string[]>; readFrom(id, from): Promise<EventEnvelope[]> }`.

- [ ] **Step 1: Write the failing tests**

`status/ingestStatus.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { Identity } from "@docmind/auth";
import { InMemoryReadModelStore } from "@loom/plugin-read-model";
import { describe, expect, it } from "vitest";
import { ingestExecutionId } from "../documents/ingest";
import { IngestStatus, type IngestStatusOptions } from "./ingestStatus";
import { INGEST_STATUS_MODEL, STATUS_MESSAGES, UPLOADED } from "./model";
import { MemoryLog, ingestRun } from "./testing";

const U = randomUUID();
const [D1, D2] = [randomUUID(), randomUUID()];
const ALICE: Identity = { tenantId: randomUUID(), userId: U };
const exec = (documentId: string) => ingestExecutionId(U, documentId);

function setup(over: Partial<IngestStatusOptions> = {}) {
  const store = new InMemoryReadModelStore();
  const log = new MemoryLog();
  const errors: unknown[] = [];
  const status = new IngestStatus({ writer: store, readerFor: () => store, source: log, sensitive: {}, onError: (e) => errors.push(e), ...over });
  /** What Loom does: persist the event, then call onEvent. */
  const feed = (...events: ReturnType<typeof ingestRun>) => { for (const e of events) { log.append(e); status.onEvent(e); } };
  return { store, log, errors, status, feed };
}

describe("IngestStatus", () => {
  it("boot registers the model and catches up what the log holds from before", async () => {
    const { log, status, errors } = setup();
    log.append(...ingestRun(exec(D1), "ready"), ...ingestRun(exec(D2), "failed:too_large"));
    expect(await status.boot()).toMatchObject({ executionsScanned: 2 });
    const views = await status.forPage(ALICE, [D1, D2]);
    expect(views.get(D1)).toEqual({ status: "ready", step: "finalize", error: null });
    expect(views.get(D2)).toEqual({ status: "failed", step: "parse", error: STATUS_MESSAGES.too_large });
    expect(errors).toEqual([]);
  });

  it("folds the live feed after boot", async () => {
    const { status, feed } = setup();
    await status.boot();
    feed(...ingestRun(exec(D1), "parsed"));
    await status.close();
    expect((await status.forPage(ALICE, [D1])).get(D1)).toMatchObject({ status: "parsing", step: "parse" });
  });

  it("forPage is one plain read; forDocument first folds the log tail the live feed missed, and an unknown document is uploaded", async () => {
    const { log, status } = setup();
    await status.boot();
    log.append(...ingestRun(exec(D1), "ready")); // persisted, but onEvent never saw it
    expect((await status.forPage(ALICE, [D1])).size).toBe(0);
    expect(await status.forDocument(ALICE, D1)).toEqual({ status: "ready", step: "finalize", error: null });
    expect(await status.forDocument(ALICE, D2)).toEqual(UPLOADED);
  });

  it("takes the highest generation of a document", async () => {
    const { log, status } = setup();
    const gen1 = `u_${U}:ingest-${D1}`; // the M2 stub's bare name
    const gen2 = `u_${U}:ingest-${D1}.2`;
    log.append(...ingestRun(gen1, "started"), ...ingestRun(gen2, "parsed"), ...ingestRun(`u_${U}:ingest-${D2}`, "started"));
    await status.boot();
    const views = await status.forPage(ALICE, [D1, D2]);
    expect([views.get(D1)?.status, views.get(D2)]).toEqual(["parsing", UPLOADED]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @docmind/server exec vitest run app/status/ingestStatus.test.ts`
Expected: FAIL (`./ingestStatus` not found).

- [ ] **Step 3: Implement**

`status/ingestStatus.ts`:

```ts
import type { Identity } from "@docmind/auth";
import type { EventEnvelope } from "@loom/core";
import {
  type ReadModelEventSource,
  ReadModelService,
  type ReadModelStore,
  type SensitiveMap,
  foldedStates,
} from "@loom/plugin-read-model";
import { ingestExecutionId } from "../documents/ingest";
import {
  INGEST_STATUS_MODEL,
  type IngestStatusState,
  type StatusView,
  UPLOADED,
  generationOf,
  ingestKeyOf,
  ingestScopeOf,
  ingestStatus,
  viewOf,
} from "./model";

export interface IngestStatusOptions {
  /** Registers, folds, refreshes, purges: the Loom role's store (every tenant's rows). */
  writer: ReadModelStore;
  /** A read-only store for one caller; in production every query runs inside that caller's tenant transaction. */
  readerFor(identity: Identity): ReadModelStore;
  /** The decrypting event store: the live source for holes and the source of boot's catch-up. */
  source: ReadModelEventSource;
  /** `sensitivePathsFromSteps(...)` unioned with `sensitiveMapFromCovers(...)`, computed after `defineConfig` (R4). */
  sensitive: SensitiveMap;
  onError?(err: unknown): void;
}

// Class name only: the message of a database or fold error could carry anything.
const logClass = (err: unknown) =>
  console.error("ingest status failed", err instanceof Error ? err.constructor.name : typeof err);

export class IngestStatus {
  private readonly service: ReadModelService;
  private readonly report: (err: unknown) => void;

  constructor(private readonly o: IngestStatusOptions) {
    this.report = o.onError ?? logClass;
    this.service = new ReadModelService(o.writer, {
      liveSource: o.source,
      sensitive: o.sensitive,
      onError: (err) => this.report(err),
    });
  }

  /** Register (a changed version or sensitive map rebuilds), then catch up. Throws on a poison event: do not serve. */
  async boot(): Promise<{ rebuilt: boolean; executionsScanned: number }> {
    const { rebuilt } = await this.service.registerFolded({
      projection: ingestStatus,
      keyOf: ingestKeyOf,
      scopeOf: ingestScopeOf,
    });
    const { executionsScanned } = await this.service.catchUp([this.o.source]);
    return { rebuilt, executionsScanned };
  }

  /** `observability.onEvent`: synchronous and never throws; the fold is applied asynchronously (ADR 0132 D4). */
  onEvent = (event: EventEnvelope): void => {
    this.service.handleEvent(event);
  };

  /** One query for one page of documents, under the caller's tenant: absent documents are simply missing. */
  async forPage(identity: Identity, documentIds: readonly string[]): Promise<Map<string, StatusView>> {
    const views = new Map<string, StatusView>();
    if (documentIds.length === 0) return views;
    const reader = this.o.readerFor(identity);
    if (reader.getFoldedByKey === undefined) throw new TypeError("the status reader store has no folded-state support");
    const best = new Map<string, number>();
    for (const row of foldedStates(await reader.getFoldedByKey(INGEST_STATUS_MODEL, documentIds))) {
      if (row.key === null) continue;
      const generation = generationOf(row.executionId);
      if (generation < (best.get(row.key) ?? 0)) continue;
      best.set(row.key, generation);
      views.set(row.key, viewOf(row.state as IngestStatusState));
    }
    return views;
  }

  /**
   * The document a request just touched: fold its log tail first (one read of the log, ADR 0132 D8),
   * then read it like a page. A document with no row is `uploaded`.
   */
  async forDocument(identity: Identity, documentId: string): Promise<StatusView> {
    await this.service.getMany(INGEST_STATUS_MODEL, [ingestExecutionId(identity.userId, documentId)], {
      refreshFrom: [this.o.source],
    });
    return (await this.forPage(identity, [documentId])).get(documentId) ?? UPLOADED;
  }

  /** Wait for every fold scheduled so far (shutdown, tests). */
  async close(): Promise<void> {
    await this.service.drain();
  }
}
```

`status/testing.ts` gains:

```ts
import type { ReadModelEventSource } from "@loom/plugin-read-model";

/** A tiny event log for tests: what Loom's event store is to the model (live source and catch-up source). */
export class MemoryLog implements ReadModelEventSource {
  private readonly byExecution = new Map<string, EventEnvelope[]>();
  append(...events: EventEnvelope[]): void {
    for (const e of events) {
      const list = this.byExecution.get(e.executionId) ?? [];
      list.push(e);
      this.byExecution.set(e.executionId, list);
    }
  }
  async listExecutions(): Promise<string[]> {
    return [...this.byExecution.keys()];
  }
  async readFrom(executionId: string, fromSequence: number): Promise<EventEnvelope[]> {
    return (this.byExecution.get(executionId) ?? []).filter((e) => e.sequence >= fromSequence);
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @docmind/server exec vitest run app/status`
Expected: PASS.

- [ ] **Step 5: Close-out**

Branch `feat/status-service`; subject `feat(server): IngestStatus registers, feeds, catches up and reads the ingest-status model`.

---

### Task 74d: progress events: `progressOf`, and publish after the fold

Revision R6. The SSE half of the status design. `progressOf` derives the contract's progress event from one log event with the same handlers the model folds with; `IngestStatus` publishes it on one promise chain **after** `drain()`, so a client that refetches on an event never reads an older status, and events leave in log order. The step effects publish nothing.

**Files:**
- Modify: `apps/server/app/status/model.ts` (`progressOf`)
- Modify: `apps/server/app/status/model.test.ts`
- Modify: `apps/server/app/status/ingestStatus.ts` (`bus` option, the publish chain)
- Modify: `apps/server/app/status/ingestStatus.test.ts`

**Interfaces:**
- Consumes: `ProgressBus` (73b), `foldIngestStatus`, `ingestKeyOf`, `ingestScopeOf` (74b), `IngestStatus` (74c), `DocumentProgressEvent` (contracts).
- Produces: `progressOf(event: EventEnvelope): { userId: string; progress: DocumentProgressEvent } | null`; `IngestStatusOptions.bus: ProgressBus` (required); `IngestStatus.onEvent` now also schedules the publish.

- [ ] **Step 1: Write the failing tests**

Append to `status/model.test.ts` (add `progressOf` to its import from `./model`):

```ts
describe("progressOf", () => {
  it("derives the SSE event for a step start, a permanent failure and finalize's completion", () => {
    const e = (type: string, payload: unknown) => evt(exec(".2"), 3, type, payload);
    expect(progressOf(e("STEP_STARTED", { stepId: "ingest-embed" }))).toEqual({ userId: U, progress: { documentId: D, step: "embed", status: "embedding" } });
    expect(progressOf(e("STEP_COMPLETED", { stepId: "ingest-parse", output: { outcome: "failed", code: "unsupported_content" } }))).toEqual({
      userId: U, progress: { documentId: D, step: "parse", status: "failed", detail: "unsupported_content" },
    });
    expect(progressOf(e("STEP_COMPLETED", { stepId: "ingest-finalize", output: { outcome: "done" } }))).toEqual({
      userId: U, progress: { documentId: D, step: "finalize", status: "ready" },
    });
  });

  it("derives nothing for events that do not move the status, for other executions, or for an execution failure", () => {
    expect(progressOf(evt(exec(), 1, "EXECUTION_STARTED", {}))).toBeNull();
    expect(progressOf(evt(exec(), 2, "STEP_COMPLETED", { stepId: "ingest-parse", output: { outcome: "done" } }))).toBeNull();
    expect(progressOf(evt(exec(), 3, "EXECUTION_FAILED", {}))).toBeNull(); // the contract's `step` is required
    expect(progressOf(evt(`u_${U}:chat-${D}`, 1, "STEP_STARTED", { stepId: "ingest-parse" }))).toBeNull();
  });
});
```

In `status/ingestStatus.test.ts`: add `import { type FoldedApply, InMemoryReadModelStore } from "@loom/plugin-read-model";` (replacing the plain import), `import { InMemoryProgressBus } from "../documents/progress";` and `evt` to the `./testing` import; replace the first lines of `setup` so that it creates and records the bus:

```ts
  const bus = new InMemoryProgressBus();
  const seen: unknown[] = [];
  bus.subscribe({ userId: U }, (e) => seen.push(e));
  const status = new IngestStatus({ writer: store, readerFor: () => store, source: log, sensitive: {}, bus, onError: (e) => errors.push(e), ...over });
```

(and `return { store, log, bus, errors, seen, status, feed };`), add this class above the `describe`, and these tests inside it:

```ts
/** A store whose first durable write waits at a gate, so a test can look at the world while a fold is in flight. */
class GatedStore extends InMemoryReadModelStore {
  readonly arrived: Promise<void>;
  release: () => void = () => {};
  private enter: () => void = () => {};
  private readonly gate: Promise<void>;
  constructor() {
    super();
    this.arrived = new Promise((resolve) => (this.enter = resolve));
    this.gate = new Promise((resolve) => (this.release = resolve));
  }
  override async applyFolded(a: FoldedApply) {
    this.enter();
    await this.gate;
    return super.applyFolded(a);
  }
}

  it("publishes a progress event only after its fold has landed, and in log order", async () => {
    const store = new GatedStore();
    const { status, feed, seen } = setup({ writer: store, readerFor: () => store });
    await status.boot();
    feed(...ingestRun(exec(D1), "ready"));
    await store.arrived; // the first durable write is now waiting at the gate
    expect(seen).toEqual([]); // so no progress event can be out yet
    store.release();
    await status.close();
    expect(seen).toEqual([
      { documentId: D1, step: "parse", status: "parsing" },
      { documentId: D1, step: "finalize", status: "embedding" },
      { documentId: D1, step: "finalize", status: "ready" },
    ]);
    expect((await store.getFolded(INGEST_STATUS_MODEL, [exec(D1)]))[0]?.state).toMatchObject({ status: "ready" });
  });

  it("still publishes when a fold fails, and reports the error; the log is the authority and catch-up heals the row", async () => {
    class Failing extends InMemoryReadModelStore {
      override async applyFolded(): Promise<never> {
        throw new RangeError("write failed");
      }
    }
    const store = new Failing();
    const { status, feed, seen, errors } = setup({ writer: store, readerFor: () => store });
    await status.boot();
    feed(...ingestRun(exec(D1), "parsed"));
    await status.close();
    expect(seen).toEqual([{ documentId: D1, step: "parse", status: "parsing" }]);
    expect(errors.some((e) => e instanceof RangeError)).toBe(true);
  });

  it("publishes nothing for another flow's execution", async () => {
    const { status, feed, seen } = setup();
    await status.boot();
    feed(...ingestRun(`u_${U}:chat-${D1}`, "ready"));
    await status.close();
    expect(seen).toEqual([]);
  });
```

(`GatedStore` goes at module level, the three tests go inside `describe("IngestStatus", ...)`.)

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @docmind/server exec vitest run app/status`
Expected: FAIL (`progressOf` is not exported; nothing is published).

- [ ] **Step 3: Implement**

`status/model.ts` gains (add `DocumentProgressEvent` to the `import type` from `@docmind/contracts`):

```ts
/** The SSE event one log event produces, from the same handlers the model folds with. Pure. */
export function progressOf(e: EventEnvelope): { userId: string; progress: DocumentProgressEvent } | null {
  const documentId = ingestKeyOf(e.executionId);
  const userId = ingestScopeOf(e.executionId);
  if (documentId === undefined || userId === undefined) return null;
  const next = foldIngestStatus([e]);
  if (next.step === null) return null; // not a step transition (the contract's `step` is required)
  const detail = next.status === "failed" && next.code !== null ? { detail: next.code } : {};
  return { userId, progress: { documentId, step: next.step, status: next.status, ...detail } };
}
```

`status/ingestStatus.ts`: import `type { ProgressBus } from "../documents/progress"` and `progressOf`; `IngestStatusOptions` gains `bus: ProgressBus;`; the class gains `private publishing: Promise<void> = Promise.resolve();`; `onEvent` and `close` become

```ts
  /**
   * `observability.onEvent`: synchronous and never throws. Folds the event (asynchronously), then
   * publishes its progress event on one chain, after `drain()`: a client that refetches on the event
   * never reads an older status, and events leave in log order. A fold that failed is reported to
   * `onError` and the event is still published (the log is the authority; the next catch-up heals the row).
   */
  onEvent = (event: EventEnvelope): void => {
    this.service.handleEvent(event);
    const derived = progressOf(event);
    if (derived === null) return;
    this.publishing = this.publishing
      .then(() => this.service.drain())
      .then(() => this.o.bus.publish({ userId: derived.userId }, derived.progress))
      .catch((err) => this.report(err));
  };

  /** Wait for every fold and publish scheduled so far (shutdown, tests). */
  async close(): Promise<void> {
    await this.publishing;
    await this.service.drain();
  }
```

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @docmind/server exec vitest run app/status`
Expected: PASS.

- [ ] **Step 5: Close-out**

Branch `feat/status-progress`; subject `feat(server): progress events follow the fold`.

---

### Task 74e: the Postgres stores (writer and tenant reader), and erasure of status rows

Revision R2 and R8. The two real stores behind `IngestStatus`: the writer on the Loom pool and a reader bound to one caller's tenant on the app pool, proven against the real roles and the `0012` policies. The same task adds `forgetDocument` and `forgetUser` (Loom's `purgeFolded`) and the `DocumentStatusReads` interface the routes will take.

**Files:**
- Create: `apps/server/app/status/pgStores.ts`
- Create: `apps/server/app/status/pgStores.pg.test.ts`
- Modify: `apps/server/app/status/ingestStatus.ts` (`DocumentStatusReads`, `forgetDocument`, `forgetUser`)
- Modify: `apps/server/app/status/ingestStatus.test.ts` (the erasure cases)

**Interfaces:**
- Consumes: `PostgresReadModelStore` (`@loom/plugin-postgres`), `ReadModelStore`, `ReadModelService`, `foldedStates` (`@loom/plugin-read-model`), `withTenant`, `IngestStatus` (74c, 74d), the model (74b), `0012` (74a).
- Produces: `pgStatusWriter(loomPool: Pool): ReadModelStore` (schema `public`, `manageSchema: false`); `pgStatusReaderFor(appPool: Pool): (identity: { tenantId: string }) => ReadModelStore` (every query runs in `withTenant`, so the `tenant_read` policy applies; nothing is created or closed); `interface DocumentStatusReads { forPage(identity, documentIds: readonly string[]): Promise<Map<string, StatusView>>; forDocument(identity, documentId): Promise<StatusView>; forgetDocument(identity, documentId): Promise<void> }` implemented by `IngestStatus`; `IngestStatus.forgetDocument(identity, documentId)` = `purgeFolded(INGEST_STATUS_MODEL, { key: documentId })` and `IngestStatus.forgetUser(userId): Promise<number>` = `purgeFolded(INGEST_STATUS_MODEL, { scope: userId })` (rows newly tombstoned).

- [ ] **Step 1: Write the failing tests**

Append to `status/ingestStatus.test.ts` (inside the `describe`; the helpers are the ones above):

```ts
  it("forgetDocument tombstones the document's rows: gone from reads, and later events cannot bring it back", async () => {
    const { store, log, status, feed } = setup();
    log.append(...ingestRun(exec(D1), "parsed"));
    await status.boot();
    await status.forgetDocument(ALICE, D1);
    expect((await status.forPage(ALICE, [D1])).size).toBe(0);
    feed(evt(exec(D1), 2, "STEP_COMPLETED", { stepId: "ingest-parse", output: { outcome: "failed", code: "too_large" } }));
    await status.close();
    expect((await status.forPage(ALICE, [D1])).size).toBe(0);
    expect((await store.getFolded(INGEST_STATUS_MODEL, [exec(D1)]))[0]).toMatchObject({ erased: true, state: null, scope: U, sequence: 2 });
  });

  it("forgetUser tombstones every row of one user and no other user's", async () => {
    const { log, status } = setup();
    const other = randomUUID();
    const doc3 = randomUUID();
    log.append(...ingestRun(exec(D1), "ready"), ...ingestRun(exec(D2), "parsed"), ...ingestRun(`u_${other}:ingest-${doc3}`, "parsed"));
    await status.boot();
    expect(await status.forgetUser(U)).toBe(2);
    expect(await status.forgetUser(U)).toBe(0); // a retry changes nothing
    expect((await status.forPage(ALICE, [D1, D2])).size).toBe(0);
    expect((await status.forPage({ tenantId: ALICE.tenantId, userId: other }, [doc3])).get(doc3)?.status).toBe("parsing");
  });
```

`status/pgStores.pg.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { ReadModelService, foldedStates } from "@loom/plugin-read-model";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword, setRolePassword } from "../db/migrate";
import { withTenant } from "../db/tenant";
import { APP_PASSWORD, LOOM_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";
import { T1, T2, U1, U1B, U2, seedUsers } from "../documents/testHarness";
import { INGEST_STATUS_MODEL, ingestKeyOf, ingestScopeOf, ingestStatus } from "./model";
import { pgStatusReaderFor, pgStatusWriter } from "./pgStores";
import { evt, ingestRun } from "./testing";

describe.skipIf(!PG_URL)("ingest-status over Postgres, with the two real roles (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;
  let loom: Pool;
  let service: ReadModelService;
  const [D1, D2, D3] = [randomUUID(), randomUUID(), randomUUID()];
  const exec = (user: string, doc: string) => `u_${user}:ingest-${doc}.2`;
  const reader = (tenantId: string) => pgStatusReaderFor(app)({ tenantId });
  const keys = async (tenantId: string, ...docs: string[]) =>
    (await reader(tenantId).getFoldedByKey?.(INGEST_STATUS_MODEL, docs))?.filter((r) => !r.erased).map((r) => r.key);

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await setRolePassword(db.owner, "docmind_loom", LOOM_PASSWORD);
    await seedUsers(db.owner);
    app = new Pool({ connectionString: db.appUrl });
    loom = new Pool({ connectionString: db.loomUrl });
    service = new ReadModelService(pgStatusWriter(loom), { onError: (e) => { throw e; } });
    await service.registerFolded({ projection: ingestStatus, keyOf: ingestKeyOf, scopeOf: ingestScopeOf });
    for (const [user, doc] of [[U1, D1], [U1B, D2], [U2, D3]] as const) {
      for (const e of ingestRun(exec(user, doc), "parsed")) service.handleEvent(e);
    }
    service.handleEvent(evt(`u_${U1}:chat-1`, 0, "EXECUTION_STARTED", {})); // another flow's execution
    await service.drain();
  });
  afterAll(async () => {
    await app?.end();
    await loom?.end();
    await db?.drop();
  });

  it("shows each tenant's reader its own users' documents only, as folded states", async () => {
    expect(await keys(T1, D1, D2, D3)).toEqual([D1, D2]);
    expect(await keys(T2, D1, D2, D3)).toEqual([D3]);
    const states = foldedStates((await reader(T1).getFoldedByKey?.(INGEST_STATUS_MODEL, [D1])) ?? []);
    expect(states[0]?.state).toEqual({ status: "parsing", step: "parse", code: null });
  });

  it("gives another flow's rows no key and no scope, so no tenant can read them", async () => {
    const { rows } = await db.owner.query("SELECT app_key, scope FROM read_model_state WHERE execution_id = $1", [`u_${U1}:chat-1`]);
    expect(rows).toEqual([{ app_key: null, scope: null }]);
    const visible = await withTenant(app, T1, async (tx) => (await tx.query("SELECT count(*)::int AS n FROM read_model_state WHERE app_key IS NULL")).rows[0].n);
    expect(visible).toBe(0);
  });

  it("cannot write through the reader: the app role holds no write privilege", async () => {
    await expect(
      reader(T1).applyFolded?.({ modelId: INGEST_STATUS_MODEL, executionId: exec(U1, D1), upToSequence: 99, state: {}, key: D1, scope: U1, foldVersion: "1" }),
    ).rejects.toThrow(/permission denied/);
  });

  it("purges one user's rows by scope: tombstones that keep the ids, leave other users alone, and survive a later event", async () => {
    expect(await service.purgeFolded(INGEST_STATUS_MODEL, { scope: U1 })).toBe(1); // the chat row has no scope
    expect(await keys(T1, D1, D2)).toEqual([D2]);
    expect((await db.owner.query("SELECT erased, state, scope, sequence FROM read_model_state WHERE app_key = $1", [D1])).rows).toEqual([
      { erased: true, state: null, scope: U1, sequence: "1" },
    ]);
    service.handleEvent(evt(exec(U1, D1), 2, "STEP_STARTED", { stepId: "ingest-chunk" }));
    await service.drain();
    expect(await keys(T1, D1, D2)).toEqual([D2]);
    expect((await db.owner.query("SELECT erased, state, sequence FROM read_model_state WHERE app_key = $1", [D1])).rows[0]).toEqual({ erased: true, state: null, sequence: "2" });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:55432/postgres && pnpm --filter @docmind/server exec vitest run app/status`
Expected: FAIL (`./pgStores` not found; `forgetDocument` is not a function).

- [ ] **Step 3: Implement**

`status/pgStores.ts`:

```ts
import { PostgresReadModelStore } from "@loom/plugin-postgres";
import type { ReadModelStore } from "@loom/plugin-read-model";
import type { Pool } from "pg";
import { withTenant } from "../db/tenant";

// The tables are DocMind's own (migration 0012), so no DDL runs here and the schema is explicit:
// the Loom pool's search_path is `loom`.
const PLACEMENT = { schema: "public", manageSchema: false } as const;

/** The service's store: the Loom role writes every tenant's rows under the `ingest_all` policy. */
export const pgStatusWriter = (loomPool: Pool): ReadModelStore => new PostgresReadModelStore(loomPool, PLACEMENT);

/**
 * A store for one caller's reads. Each query runs inside `withTenant`, so `app.tenant_id` is set and
 * the `tenant_read` policy limits the rows to the tenant's users. Cheap to build per request; it
 * owns nothing, so there is nothing to close.
 */
export function pgStatusReaderFor(appPool: Pool): (identity: { tenantId: string }) => ReadModelStore {
  return ({ tenantId }) => {
    const tenantPool = {
      query: (text: unknown, values?: unknown) =>
        withTenant(appPool, tenantId, (tx) => tx.query(text as string, values as unknown[])),
      connect: appPool.connect.bind(appPool),
      end: async () => {},
    };
    return new PostgresReadModelStore(tenantPool as never, PLACEMENT); // PoolLike's query is pg's overloaded signature
  };
}
```

`status/ingestStatus.ts` gains:

```ts
/** What the document routes need from the status model. */
export interface DocumentStatusReads {
  forPage(identity: Identity, documentIds: readonly string[]): Promise<Map<string, StatusView>>;
  forDocument(identity: Identity, documentId: string): Promise<StatusView>;
  /** The document is being deleted: tombstone its rows (call after the flow is cancelled). */
  forgetDocument(identity: Identity, documentId: string): Promise<void>;
}
```

`export class IngestStatus implements DocumentStatusReads`, and two methods before `close()`:

```ts
  /** Erasure by key: a tombstone keeps the sequence, execution id and scope (ids, not state) and nulls the state. */
  async forgetDocument(_identity: Identity, documentId: string): Promise<void> {
    await this.service.purgeFolded(INGEST_STATUS_MODEL, { key: documentId });
  }

  /** User erasure (M5), after rows, blobs and key: the table has no foreign key to `users`, so nothing cascades. */
  forgetUser(userId: string): Promise<number> {
    return this.service.purgeFolded(INGEST_STATUS_MODEL, { scope: userId });
  }
```

- [ ] **Step 4: Run to verify they pass**

Run: `export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:55432/postgres && pnpm --filter @docmind/server exec vitest run app/status app/db`
Expected: PASS.

- [ ] **Step 5: Close-out**

Branch `feat/status-pg-stores`; subject `feat(server): Postgres stores for the ingest status model, and erasure of its rows`. M5's user erasure calls `forgetUser` after the key is destroyed (Revision R8).

---

### Task 75a: `PgParsedStore`

The parse step's write port and the chunk step's read port. `PgParsedStore` seals the parsed document into `parsed_documents`, reads it back and drops it. `put` replaces an existing row (a re-run of parse).

**Files:**
- Create: `apps/server/app/flows/ingest-document/pgParsed.ts`
- Create: `apps/server/app/flows/ingest-document/pgParsed.pg.test.ts`

**Interfaces:**
- Consumes: `FieldCrypto.forUser(userId): UserFieldCipher` (`seal(bind, value)`, `open(bind, envelope)`), `withTenant`, `DocumentGoneError`, `ParsedDocument`, `startPgFixture` (Task 64).
- Produces: `parsedBind(documentId: string): string` = `` `document:${documentId}:parsed` ``; `interface ParsedStore { put(ref, parsed: ParsedDocument): Promise<void>; take(ref): Promise<ParsedDocument | undefined>; drop(ref): Promise<void> }`; `class PgParsedStore implements ParsedStore { constructor(pool: Pool, fields: FieldCrypto) }`. A missing document (or another owner's) is `DocumentGoneError` from all three methods; `take` returns `undefined` when no row exists **for an existing document**.

- [ ] **Step 1: Write the failing test**

`pgParsed.pg.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { ParsedDocument } from "@docmind/parsers";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FieldCrypto } from "../../crypto/fields";
import { PG_URL } from "../../db/testSupport";
import { U1B } from "../../documents/testHarness";
import { DocumentGoneError } from "./errors";
import { PgParsedStore } from "./pgParsed";
import { type PgFixture, startPgFixture } from "./pgFixture";

const parsed: ParsedDocument = {
  text: "A distinctive sentence about quarterly revenue.",
  sections: [{ headingPath: ["Intro"], text: "A distinctive sentence about quarterly revenue.", locator: { kind: "chars", start: 0, end: 46 } }],
  media: [],
};

describe.skipIf(!PG_URL)("PgParsedStore (needs DOCMIND_TEST_PG_URL)", () => {
  let f: PgFixture;
  beforeAll(async () => {
    f = await startPgFixture();
  });
  afterAll(async () => {
    await f?.close();
  });

  it("stores the parsed document sealed: the owner reads it back, the row holds only an envelope", async () => {
    const ref = await f.doc("3".repeat(64));
    const store = new PgParsedStore(f.app, f.fields);
    await store.put(ref, parsed);
    expect(await store.take(ref)).toEqual(parsed);
    const raw = (await f.db.owner.query("SELECT body_enc FROM parsed_documents WHERE document_id = $1", [ref.documentId])).rows[0].body_enc;
    expect(Object.keys(raw).sort()).toEqual(["__loomEnc", "data", "iv", "tag"]);
    expect(raw.__loomEnc).toBe("loom/aes-256-gcm");
  });

  it("does not open without the owner's data key (a destroyed or unknown key reads as the document being gone)", async () => {
    const ref = await f.doc("4".repeat(64));
    await new PgParsedStore(f.app, f.fields).put(ref, parsed);
    const strangers = new FieldCrypto(new InMemoryKeyStore());
    await expect(new PgParsedStore(f.app, strangers).take(ref)).rejects.toMatchObject({ name: "FieldKeyUnavailableError" });
  });

  it("replaces on a re-run, returns undefined once dropped, and drop is idempotent", async () => {
    const ref = await f.doc("5".repeat(64));
    const store = new PgParsedStore(f.app, f.fields);
    await store.put(ref, parsed);
    await store.put(ref, { ...parsed, text: "second" });
    expect((await store.take(ref))?.text).toBe("second");
    await store.drop(ref);
    await store.drop(ref);
    expect(await store.take(ref)).toBeUndefined();
  });

  it.each(["put", "take", "drop"] as const)("%s throws DocumentGoneError for a deleted document and for another owner's", async (op) => {
    const ref = await f.doc(randomUUID().replaceAll("-", "").repeat(2));
    const store = new PgParsedStore(f.app, f.fields);
    const call = (r: typeof ref) => (op === "put" ? store.put(r, parsed) : op === "take" ? store.take(r) : store.drop(r));
    await expect(call({ ...ref, userId: U1B })).rejects.toBeInstanceOf(DocumentGoneError);
    await f.db.owner.query("DELETE FROM documents WHERE id = $1", [ref.documentId]);
    await expect(call(ref)).rejects.toBeInstanceOf(DocumentGoneError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:55432/postgres && pnpm --filter @docmind/server exec vitest run app/flows/ingest-document/pgParsed.pg.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`pgParsed.ts`:

```ts
import { ParsedDocument as ParsedDocumentSchema, type ParsedDocument } from "@docmind/parsers";
import type { Pool } from "pg";
import type { FieldCrypto } from "../../crypto/fields";
import { withTenant } from "../../db/tenant";
import { DocumentGoneError } from "./errors";
import type { IngestStartInput } from "./flow";

export const parsedBind = (documentId: string) => `document:${documentId}:parsed`;

export interface ParsedStore {
  put(ref: IngestStartInput, parsed: ParsedDocument): Promise<void>;
  take(ref: IngestStartInput): Promise<ParsedDocument | undefined>;
  drop(ref: IngestStartInput): Promise<void>;
}

const OWNED = "EXISTS (SELECT 1 FROM documents d WHERE d.id = $1 AND d.owner_id = $2)";

export class PgParsedStore implements ParsedStore {
  constructor(private readonly pool: Pool, private readonly fields: FieldCrypto) {}

  async put(ref: IngestStartInput, parsed: ParsedDocument): Promise<void> {
    const sealed = await this.fields.forUser(ref.userId).seal(parsedBind(ref.documentId), parsed);
    await withTenant(this.pool, ref.tenantId, async (tx) => {
      // INSERT ... SELECT, so a document that is not this owner's inserts nothing; the FK covers a delete race.
      const { rowCount } = await tx.query(
        `INSERT INTO parsed_documents (tenant_id, document_id, body_enc)
         SELECT d.tenant_id, d.id, $3::jsonb FROM documents d WHERE d.id = $1 AND d.owner_id = $2
         ON CONFLICT (tenant_id, document_id) DO UPDATE SET body_enc = EXCLUDED.body_enc`,
        [ref.documentId, ref.userId, JSON.stringify(sealed)],
      );
      if (!rowCount) throw new DocumentGoneError();
    });
  }

  async take(ref: IngestStartInput): Promise<ParsedDocument | undefined> {
    const body = await withTenant(this.pool, ref.tenantId, async (tx) => {
      const { rows } = await tx.query<{ owned: boolean; body_enc: unknown }>(
        `SELECT ${OWNED} AS owned, (SELECT body_enc FROM parsed_documents WHERE document_id = $1) AS body_enc`,
        [ref.documentId, ref.userId],
      );
      if (!rows[0]?.owned) throw new DocumentGoneError();
      return rows[0].body_enc;
    });
    if (body == null) return undefined;
    return ParsedDocumentSchema.parse(await this.fields.forUser(ref.userId).open(parsedBind(ref.documentId), body));
  }

  async drop(ref: IngestStartInput): Promise<void> {
    await withTenant(this.pool, ref.tenantId, async (tx) => {
      const { rows } = await tx.query<{ owned: boolean }>(
        `WITH gone AS (DELETE FROM parsed_documents p USING documents d
           WHERE p.document_id = d.id AND p.tenant_id = d.tenant_id AND d.id = $1 AND d.owner_id = $2 RETURNING 1)
         SELECT ${OWNED} AS owned`,
        [ref.documentId, ref.userId],
      );
      if (!rows[0]?.owned) throw new DocumentGoneError();
    });
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `export DOCMIND_TEST_PG_URL=... && pnpm --filter @docmind/server exec vitest run app/flows/ingest-document/pgParsed.pg.test.ts`
Expected: PASS.

- [ ] **Step 5: Close-out**

Branch `feat/ingest-pg-parsed`; subject `feat(server): sealed parsed-document store`.

---

### Task 75b: the document source reader

`DocumentSource` answers "what type is this document and where are its bytes" and reads them; `get() -> null` is `DocumentGoneError` (carry-forward 2: delete removes the blob before or while a step runs).

**Files:**
- Create: `apps/server/app/flows/ingest-document/pgSource.ts`
- Create: `apps/server/app/flows/ingest-document/pgSource.pg.test.ts`

**Interfaces:**
- Consumes: `withTenant`, `DocumentGoneError`, `startPgFixture`.
- Produces: `interface DocumentSource { meta(ref): Promise<{ mime: string; contentAddress: string }>; read(ref, contentAddress: string): Promise<Uint8Array> }`; `class PgDocumentSource implements DocumentSource { constructor(pool: Pool, blobs: (identity: { tenantId: string; userId: string }) => { get(ref: { __loomContent: string }): Promise<Uint8Array | null> }) }`.

- [ ] **Step 1: Write the failing test**

```ts
describe.skipIf(!PG_URL)("PgDocumentSource (needs DOCMIND_TEST_PG_URL)", () => {
  let f: PgFixture;
  beforeAll(async () => {
    f = await startPgFixture();
  });
  afterAll(async () => {
    await f?.close();
  });
  const none = () => ({ get: async () => null });

  it("meta returns the mime and the content address of the owner's document", async () => {
    const ref = await f.doc("6".repeat(64));
    expect(await new PgDocumentSource(f.app, none).meta(ref)).toEqual({ mime: "application/pdf", contentAddress: `hmac-sha256:${"6".repeat(64)}` });
  });

  it("meta throws DocumentGoneError for a deleted document and for another owner's", async () => {
    const ref = await f.doc("7".repeat(64));
    const source = new PgDocumentSource(f.app, none);
    await expect(source.meta({ ...ref, userId: U1B })).rejects.toBeInstanceOf(DocumentGoneError);
    await f.db.owner.query("DELETE FROM documents WHERE id = $1", [ref.documentId]);
    await expect(source.meta(ref)).rejects.toBeInstanceOf(DocumentGoneError);
  });

  it("read returns the bytes the blob store holds, for the right identity", async () => {
    const seen: unknown[] = [];
    const source = new PgDocumentSource(f.app, (identity) => (seen.push(identity), { get: async () => Uint8Array.of(1, 2) }));
    const ref = { tenantId: T1, userId: U1, documentId: randomUUID() };
    expect([...(await source.read(ref, "hmac-sha256:x"))]).toEqual([1, 2]);
    expect(seen).toEqual([{ tenantId: T1, userId: U1 }]);
  });

  it("read treats a blob that is gone as DocumentGoneError", async () => {
    const ref = { tenantId: T1, userId: U1, documentId: randomUUID() };
    await expect(new PgDocumentSource(f.app, none).read(ref, "hmac-sha256:x")).rejects.toBeInstanceOf(DocumentGoneError);
  });
});
```

(imports as in Task 75a, plus `T1`, `U1`, `U1B` from the harness and `PgDocumentSource`.)

- [ ] **Step 2: Run to verify it fails**

Run: `export DOCMIND_TEST_PG_URL=... && pnpm --filter @docmind/server exec vitest run app/flows/ingest-document/pgSource.pg.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`pgSource.ts`:

```ts
import type { Pool } from "pg";
import { withTenant } from "../../db/tenant";
import { DocumentGoneError } from "./errors";
import type { IngestStartInput } from "./flow";

export interface DocumentSource {
  meta(ref: IngestStartInput): Promise<{ mime: string; contentAddress: string }>;
  read(ref: IngestStartInput, contentAddress: string): Promise<Uint8Array>;
}

type Blobs = (identity: { tenantId: string; userId: string }) => {
  get(ref: { __loomContent: string }): Promise<Uint8Array | null>;
};

export class PgDocumentSource implements DocumentSource {
  constructor(private readonly pool: Pool, private readonly blobs: Blobs) {}

  async meta(ref: IngestStartInput) {
    const row = await withTenant(this.pool, ref.tenantId, async (tx) => {
      const { rows } = await tx.query<{ mime: string; content_address: string }>(
        "SELECT mime, content_address FROM documents WHERE id = $1 AND owner_id = $2",
        [ref.documentId, ref.userId],
      );
      return rows[0];
    });
    if (!row) throw new DocumentGoneError();
    return { mime: row.mime, contentAddress: row.content_address };
  }

  async read(ref: IngestStartInput, contentAddress: string): Promise<Uint8Array> {
    const bytes = await this.blobs({ tenantId: ref.tenantId, userId: ref.userId }).get({ __loomContent: contentAddress });
    if (bytes === null) throw new DocumentGoneError(); // delete removed the blob first, or erasure did
    return bytes;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `export DOCMIND_TEST_PG_URL=... && pnpm --filter @docmind/server exec vitest run app/flows/ingest-document/pgSource.pg.test.ts`
Expected: PASS.

- [ ] **Step 5: Close-out**

Branch `feat/ingest-document-source`; subject `feat(server): document source reader treats a missing blob as gone`.

---

### Task 75c: `PgStepGuard`

The existence check every step runs first (`StepGuard`, Task 73a): tenant-scoped, owner-scoped, ids in, nothing out. It is the M2 stub's `documentExists` query as a guard, kept as its own file so the stub's `pgDeps.ts` and its test stay untouched until Task 80 swaps the flow. **Added 2026-10-19:** this is what is left of the old status store once the status is the model's job.

**Files:**
- Create: `apps/server/app/flows/ingest-document/pgGuard.ts`
- Create: `apps/server/app/flows/ingest-document/pgGuard.pg.test.ts`

**Interfaces:**
- Consumes: `StepGuard` (73a), `DocumentGoneError` (73a), `IngestStartInput` (`flow.ts`), `withTenant`, `createTestDb`, the harness (`T1`, `T2`, `U1`, `U1B`, `newDocument`, `seedUsers`).
- Produces: `class PgStepGuard implements StepGuard { constructor(pool: Pool) }`.

- [ ] **Step 1: Write the failing test**

`pgGuard.pg.test.ts` (the stub's two tests, with `documentExists` replaced by `begin`):

```ts
import { randomUUID } from "node:crypto";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FieldCrypto } from "../../crypto/fields";
import { migrate, setAppRolePassword } from "../../db/migrate";
import { withTenant } from "../../db/tenant";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../../db/testSupport";
import { insertDocument } from "../../documents/repo";
import { T1, T2, U1, U1B, newDocument, seedUsers } from "../../documents/testHarness";
import { DocumentGoneError } from "./errors";
import { PgStepGuard } from "./pgGuard";

describe.skipIf(!PG_URL)("PgStepGuard (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;
  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await seedUsers(db.owner);
    app = new Pool({ connectionString: db.appUrl });
  });
  afterAll(async () => {
    await app?.end();
    await db?.drop();
  });

  it("passes for a document's owner in its own tenant, and throws DocumentGoneError for anyone else or once it is deleted", async () => {
    const doc = await newDocument(new FieldCrypto(new InMemoryKeyStore()), T1, U1, "e".repeat(64));
    await withTenant(app, T1, (tx) => insertDocument(tx, doc));
    const guard = new PgStepGuard(app);
    const ref = { tenantId: T1, userId: U1, documentId: doc.id };
    await expect(guard.begin(ref, "parse")).resolves.toBeUndefined();
    await expect(guard.begin({ ...ref, userId: U1B }, "parse")).rejects.toBeInstanceOf(DocumentGoneError); // colleague
    await expect(guard.begin({ ...ref, tenantId: T2 }, "parse")).rejects.toBeInstanceOf(DocumentGoneError); // other tenant
    await expect(guard.begin({ ...ref, documentId: randomUUID() }, "parse")).rejects.toBeInstanceOf(DocumentGoneError);
    await db.owner.query("DELETE FROM documents WHERE id = $1", [doc.id]);
    await expect(guard.begin(ref, "parse")).rejects.toBeInstanceOf(DocumentGoneError); // gone
  });

  it("fails with a fixed message that carries none of the ids", async () => {
    const bad = "not-a-uuid-marker";
    const err = await new PgStepGuard(app).begin({ tenantId: T1, userId: U1, documentId: bad }, "parse").catch((e: unknown) => e);
    expect(err).toEqual(new Error("document existence check failed"));
    expect((err as Error).message).not.toContain(bad);
    expect((err as Error).cause).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:55432/postgres && pnpm --filter @docmind/server exec vitest run app/flows/ingest-document/pgGuard.pg.test.ts`
Expected: FAIL (`./pgGuard` not found).

- [ ] **Step 3: Implement**

`pgGuard.ts`:

```ts
import type { IngestStep } from "@docmind/contracts";
import type { Pool } from "pg";
import { withTenant } from "../../db/tenant";
import { DocumentGoneError } from "./errors";
import type { IngestStartInput } from "./flow";
import type { StepGuard } from "./stepEffect";

/**
 * Is the document still there for its owner? Tenant- and owner-scoped; ids in, nothing out. A failure
 * is rethrown with a fixed message, because a step failure's message lands in the event log and the
 * driver's error can carry ids or SQL parameters.
 */
export class PgStepGuard implements StepGuard {
  constructor(private readonly pool: Pool) {}

  async begin({ tenantId, userId, documentId }: IngestStartInput, _step: IngestStep): Promise<void> {
    let found: boolean;
    try {
      found = await withTenant(this.pool, tenantId, async (tx) => {
        const { rowCount } = await tx.query("SELECT 1 FROM documents WHERE id = $1 AND owner_id = $2", [documentId, userId]);
        return (rowCount ?? 0) > 0;
      });
    } catch {
      throw new Error("document existence check failed");
    }
    if (!found) throw new DocumentGoneError();
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:55432/postgres && pnpm --filter @docmind/server exec vitest run app/flows/ingest-document/pgGuard.pg.test.ts`
Expected: PASS.

- [ ] **Step 5: Close-out**

Branch `feat/ingest-pg-guard`; subject `feat(server): PgStepGuard checks the document is still there`.

---

### Task 76: execution id generations; delete cancels every generation

Decision D5 and carry-forward 1. The M2 stub used `u_<user>:ingest-<doc>`; its execution is start-once, so a new flow could never start for a document the stub already saw. Generation 2 uses `u_<user>:ingest-<doc>.2`. Delete cancels generation 1 and 2 (and any later generation, up to the current one), so a part-2 restart never leaves an orphan.

**Files:**
- Modify: `apps/server/app/documents/ingest.ts`
- Modify: `apps/server/app/documents/ingest.test.ts`
- Modify: `apps/server/app/documents/testHarness.ts` (only the `calls` expectations that name an execution id, if any)

**Interfaces:**
- Consumes: `executionIdFor` / `UserExecutionId` (Task 63).
- Produces: `INGEST_GENERATION = 2`; `ingestExecutionId(userId, documentId, generation = INGEST_GENERATION): UserExecutionId` (generation 1 is `ingest-<doc>`, n >= 2 is `ingest-<doc>.<n>`); `IngestPort.start` starts the current generation; `IngestPort.cancel` cancels generations `1..INGEST_GENERATION`, ignoring "No execution found".

- [ ] **Step 1: Write the failing test**

Add to `ingest.test.ts` (it already builds a fake runtime with recorded `start`/`cancel` calls; use its helper):

```ts
  it("names generation 1 as the M2 stub did and later generations with a counter, never content", () => {
    const [u, d] = [randomUUID(), randomUUID()];
    expect(ingestExecutionId(u, d, 1)).toBe(`u_${u}:ingest-${d}`);
    expect(ingestExecutionId(u, d)).toBe(`u_${u}:ingest-${d}.2`);
    expect(ingestExecutionId(u, d, 3)).toBe(`u_${u}:ingest-${d}.3`);
  });

  it("starts the current generation", async () => {
    const { runtime, calls } = fakeRuntime();
    await loomIngest(runtime).start(IDENTITY, DOC);
    expect(calls.starts.map((s) => s.executionId)).toEqual([ingestExecutionId(IDENTITY.userId, DOC)]);
  });

  it("cancels every generation, tolerating one that never existed, and still throws a real failure", async () => {
    const { runtime, calls } = fakeRuntime({ unknown: [ingestExecutionId(IDENTITY.userId, DOC, 1)] });
    await loomIngest(runtime).cancel(IDENTITY, DOC);
    expect(calls.cancels.map((c) => c.executionId)).toEqual([
      ingestExecutionId(IDENTITY.userId, DOC, 1),
      ingestExecutionId(IDENTITY.userId, DOC, 2),
    ]);
    const boom = fakeRuntime({ failWith: new Error("storage down") });
    await expect(loomIngest(boom.runtime).cancel(IDENTITY, DOC)).rejects.toThrow(/^storage down$/);
  });
```

(`fakeRuntime` and `IDENTITY`, `DOC` exist in the current `ingest.test.ts`, which records `start`/`cancel` and can be told to throw `Error("No execution found for id: ...")` for given ids; extend it with `unknown` and `failWith` options in this step.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @docmind/server exec vitest run app/documents/ingest.test.ts`
Expected: FAIL (`ingestExecutionId` takes two arguments and returns the bare id; cancel cancels one id).

- [ ] **Step 3: Implement**

In `ingest.ts`:

```ts
/** 1 is the M2 stub's execution (bare name); a restart in part 2 bumps this. */
export const INGEST_GENERATION = 2;

export const ingestExecutionId = (userId: string, documentId: string, generation = INGEST_GENERATION): UserExecutionId => {
  const id = documentId.toLowerCase();
  return executionIdFor(userId, generation === 1 ? `ingest-${id}` : `ingest-${id}.${generation}`);
};
```

`target()` uses the default generation; `cancel` loops:

```ts
    async cancel(identity, documentId) {
      const { ref, principal } = target(identity, documentId);
      for (let generation = 1; generation <= INGEST_GENERATION; generation++) {
        try {
          await runtime.cancel(ingestExecutionId(ref.userId, ref.documentId, generation), CANCEL_REASON, { principal });
        } catch (err) {
          // Never started in this generation: nothing to cancel.
          if (!(err instanceof Error && err.message.startsWith("No execution found for id"))) throw err;
        }
      }
    },
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @docmind/server exec vitest run app/documents app/executionIds.test.ts`
Expected: PASS; if `ingestStart.pg.test.ts` pins the old id it passes unchanged, because it calls `ingestExecutionId(U1, id)` with the default.

- [ ] **Step 5: Close-out**

Branch `feat/ingest-execution-generations`; subject `feat(server): ingest execution generations and cancel across them`.

---

### Task 77: upload answers without waiting for Loom to start the flow

Carry-forward 8 (Finding F10). The M2 handler awaits `ingest.start`, so a slow event store holds the HTTP response. Decision: **fire and log** with a tracker the tests and shutdown can drain; the stale-upload sweep (Task 91) is the safety net for a start that never lands.

**Files:**
- Create: `apps/server/app/documents/startScheduler.ts`
- Create: `apps/server/app/documents/startScheduler.test.ts`
- Modify: `apps/server/app/documents/routes.ts` (use the scheduler)
- Modify: `apps/server/app/compose.ts` (build it, pass it)
- Modify: `apps/server/app/documents/testHarness.ts` (expose `starts`, add a start gate)
- Modify: `apps/server/app/documents/ingestStart.pg.test.ts` (await `h.starts.idle()` before asserting starts)

**Interfaces:**
- Consumes: `IngestPort` (`start`, `cancel`).
- Produces: `class StartScheduler { constructor(port: IngestPort); fire(identity: Identity, documentId: string): void; idle(): Promise<void> }`; `DocumentRoutesDeps.starts: StartScheduler` (required); `DocumentHarness.starts` and `IngestProbe.holdStart()` / `releaseStart()`.

- [ ] **Step 1: Write the failing tests**

`startScheduler.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IngestPort } from "./ingest";
import { StartScheduler } from "./startScheduler";

const IDENTITY = { tenantId: randomUUID(), userId: randomUUID() };
afterEach(() => vi.restoreAllMocks());

const port = (start: IngestPort["start"]): IngestPort => ({ start, cancel: async () => {} });

describe("StartScheduler", () => {
  it("returns from fire() before the start settles, and idle() waits for it", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const started: string[] = [];
    const s = new StartScheduler(port(async (_i, doc) => { await gate; started.push(doc); return null; }));
    s.fire(IDENTITY, "doc-1");
    expect(started).toEqual([]);
    release();
    await s.idle();
    expect(started).toEqual(["doc-1"]);
  });

  it("logs only the error class and the route when a start fails, never the message or ids", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const s = new StartScheduler(port(async () => { throw new RangeError("secret-name.txt"); }));
    s.fire(IDENTITY, "doc-2");
    await s.idle();
    expect(spy).toHaveBeenCalledWith("ingest start failed", "RangeError", "POST /api/documents");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("secret-name");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("doc-2");
  });

  it("idle() is already resolved when nothing is pending, and covers starts fired while waiting", async () => {
    const s = new StartScheduler(port(async () => null));
    await s.idle();
    s.fire(IDENTITY, "a");
    const waiting = s.idle();
    s.fire(IDENTITY, "b");
    await waiting;
    await s.idle();
  });
});
```

In `ingestStart.pg.test.ts` add `await h.starts.idle();` after each `await created(...)`/`h.upload(...)` whose start the test then asserts (first, second, fourth test), and add a new test:

```ts
  it("answers the upload while the flow start is still pending, then starts it", async () => {
    h.ingest.holdStart();
    const { res, body } = await created("slow.txt", TEXT("slow start"));
    expect(res.status).toBe(201);
    expect(h.ingest.handles.has(body.document.id)).toBe(false);
    h.ingest.releaseStart();
    await h.starts.idle();
    expect(h.ingest.handles.has(body.document.id)).toBe(true);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `export DOCMIND_TEST_PG_URL=... && pnpm --filter @docmind/server exec vitest run app/documents/startScheduler.test.ts app/documents/ingestStart.pg.test.ts`
Expected: FAIL (`./startScheduler` not found; `h.starts` undefined).

- [ ] **Step 3: Implement**

`startScheduler.ts`:

```ts
import type { Identity } from "@docmind/auth";
import type { IngestPort } from "./ingest";

/**
 * Starts ingest executions without making the upload wait for Loom's event store. A failed start is
 * logged by class and route only; the stale-upload sweep restarts it. `idle()` lets tests and
 * shutdown wait for everything fired so far (and anything fired while waiting).
 */
export class StartScheduler {
  private readonly pending = new Set<Promise<void>>();
  constructor(private readonly port: IngestPort) {}

  fire(identity: Identity, documentId: string): void {
    const run = (async () => {
      try {
        await this.port.start(identity, documentId);
      } catch (err) {
        console.error("ingest start failed", err instanceof Error ? err.constructor.name : typeof err, "POST /api/documents");
      }
    })();
    this.pending.add(run);
    void run.finally(() => this.pending.delete(run));
  }

  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }
}
```

`routes.ts`: replace the `await deps.ingest.start(...).catch(...)` block with `deps.starts.fire(identity, document.id);` (keeping the `!duplicate || document.status === "uploaded"` condition and the comment about start-once); `DocumentRoutesDeps` gains `starts: StartScheduler`. `compose.ts`: `const starts = new StartScheduler(ingest);`, pass `starts`, return `starts` from `buildServer` so `main` can drain it. `testHarness.ts`: build `new StartScheduler(ingest.port)`, pass it and expose it as `h.starts`; add `holdStart()`/`releaseStart()` to `IngestProbe` (a second gate awaited at the top of the probe's `start`); drain in `close()`.

- [ ] **Step 4: Run to verify they pass**

Run: `export DOCMIND_TEST_PG_URL=... && pnpm --filter @docmind/server exec vitest run app/documents`
Expected: PASS.

- [ ] **Step 5: Close-out**

Branch `feat/upload-fire-and-log-start`; subject `feat(api): upload answers without waiting for the flow start`. `main.ts` drains `starts.idle()` before `app.close()` in Task 79 (where `main.ts` is next edited). Seam if over: the harness edits plus `ingestStart.pg.test.ts` follow the scheduler PR.

---

### Task 78: the `parse` step effect

Spec §5.2 parse, as a library over ports (not yet reachable; Task 80 puts it in the flow). Reads the document's type, picks a parser, reads the bytes (`null` is gone), runs the parser in the sandbox, seals the result, and reports the section count.

**Files:**
- Create: `apps/server/app/flows/ingest-document/steps/parse.ts`
- Create: `apps/server/app/flows/ingest-document/steps/parse.test.ts`
- Modify: `apps/server/package.json` (`@docmind/parsers` already added in Task 71)

**Interfaces:**
- Consumes: `stepEffect`, `StepGuard`, `DocumentSource`, `ParsedStore`, `ParserRegistry`, `ParseRunner`, the runner's errors, `PermanentIngestError`.
- Produces: `interface ParseDeps { guard: StepGuard; source: DocumentSource; parsed: ParsedStore; registry: ParserRegistry; runner: Pick<ParseRunner, "run"> }` and `parseEffect(deps: ParseDeps): Effect<IngestStartInput, StepResult>`. Mapping: no parser for the mime -> `PermanentIngestError("unsupported_content")`; `ParseRejectedError` -> `PermanentIngestError(err.code)`; `ParseTimeoutError`, `ParseMemoryError`, `ParseLimitError` -> `PermanentIngestError("too_large")`; `ParseCrashedError`/`ParseAbortedError` propagate (unexpected: the step fails).

- [ ] **Step 1: Write the failing test**

`parse.test.ts` (fake ports, no database, no process; a `calls` array records the order):

```ts
import { randomUUID } from "node:crypto";
import { ParseAbortedError, ParseCrashedError, ParseLimitError, ParseMemoryError, ParseRejectedError, ParseTimeoutError, ParserRegistry, createDefaultParsers } from "@docmind/parsers";
import { describe, expect, it } from "vitest";
import { DocumentGoneError } from "../errors";
import type { IngestStartInput } from "../flow";
import { type ParseDeps, parseEffect } from "./parse";

const ref = (): IngestStartInput => ({ tenantId: randomUUID(), userId: randomUUID(), documentId: randomUUID() });
const parsedDoc = { text: "hi", sections: [{ headingPath: [], text: "hi", locator: { kind: "chars", start: 0, end: 2 } }], media: [] } as const;

function deps(over: Partial<ParseDeps> = {}) {
  const calls: string[] = [];
  const stored: unknown[] = [];
  const d: ParseDeps = {
    guard: { begin: async (_r, step) => void calls.push(`begin:${step}`) },
    source: {
      meta: async () => ({ mime: "text/plain", contentAddress: "hmac-sha256:x" }),
      read: async () => { calls.push("read"); return new Uint8Array([104, 105]); },
    },
    parsed: { put: async (_r, p) => void stored.push(p), take: async () => undefined, drop: async () => {} },
    registry: new ParserRegistry(createDefaultParsers()),
    runner: { run: async (id) => { calls.push(`run:${id}`); return parsedDoc as never; } },
    ...over,
  };
  return { d, calls, stored };
}
const run = (d: ParseDeps) => parseEffect(d).execute(ref(), {} as never);

describe("parse step", () => {
  it("reads, parses with the parser chosen by mime, stores the result, and reports the section count", async () => {
    const { d, calls, stored } = deps();
    expect(await run(d)).toEqual({ outcome: "done", count: 1 });
    expect(calls).toEqual(["begin:parse", "read", "run:txt"]);
    expect(stored).toEqual([parsedDoc]);
  });

  it("fails permanently as unsupported_content when no parser accepts the mime, before reading the blob", async () => {
    const { d, calls } = deps({ source: { meta: async () => ({ mime: "application/x-nothing", contentAddress: "a" }), read: async () => { throw new Error("must not read"); } } });
    expect(await run(d)).toEqual({ outcome: "failed", code: "unsupported_content" });
    expect(calls).toEqual(["begin:parse"]);
  });

  it.each([
    [new ParseRejectedError("corrupt_content"), "corrupt_content"],
    [new ParseRejectedError("too_large"), "too_large"],
    [new ParseTimeoutError(), "too_large"],
    [new ParseMemoryError(), "too_large"],
    [new ParseLimitError("input"), "too_large"],
  ])("maps %s to the failure code %s", async (error, code) => {
    const { d } = deps({ runner: { run: async () => { throw error; } } });
    expect(await run(d)).toEqual({ outcome: "failed", code });
  });

  it.each([new ParseCrashedError(), new ParseAbortedError()])("lets %s fail the step: not the document's fault", async (error) => {
    const { d } = deps({ runner: { run: async () => { throw error; } } });
    await expect(run(d)).rejects.toThrow(/^ingest step failed: parse$/);
  });

  it("stops as document_gone, running no parser, when the blob is gone", async () => {
    const { d, calls } = deps({ source: { meta: async () => ({ mime: "text/plain", contentAddress: "a" }), read: async () => { throw new DocumentGoneError(); } } });
    expect(await run(d)).toEqual({ outcome: "document_gone" });
    expect(calls).toEqual(["begin:parse"]);
  });

  it("stops as document_gone when the document is deleted while the result is being stored", async () => {
    const { d } = deps({ parsed: { put: async () => { throw Object.assign(new Error("fk"), { code: "23503" }); }, take: async () => undefined, drop: async () => {} } });
    expect(await run(d)).toEqual({ outcome: "document_gone" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/ingest-document/steps/parse.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
import { ParseAbortedError, ParseLimitError, ParseMemoryError, ParseRejectedError, ParseTimeoutError, type ParseRunner, type ParserRegistry } from "@docmind/parsers";
import type { Effect } from "@loom/effect-runtime";
import { PermanentIngestError } from "../errors";
import type { IngestStartInput } from "../flow";
import type { ParsedStore } from "../pgParsed";
import type { DocumentSource } from "../pgSource";
import { type StepGuard, type StepResult, stepEffect } from "../stepEffect";

export interface ParseDeps {
  guard: StepGuard;
  source: DocumentSource;
  parsed: ParsedStore;
  registry: ParserRegistry;
  runner: Pick<ParseRunner, "run">;
}

const RESOURCE_LIMITS = [ParseTimeoutError, ParseMemoryError, ParseLimitError] as const;

export function parseEffect(deps: ParseDeps): Effect<IngestStartInput, StepResult> {
  return stepEffect("parse", deps.guard, async (ref) => {
    const { mime, contentAddress } = await deps.source.meta(ref);
    const parser = deps.registry.select(mime);
    if (!parser) throw new PermanentIngestError("unsupported_content");
    const bytes = await deps.source.read(ref, contentAddress);
    let parsed;
    try {
      parsed = await deps.runner.run(parser.id, bytes);
    } catch (err) {
      if (err instanceof ParseRejectedError) throw new PermanentIngestError(err.code);
      if (RESOURCE_LIMITS.some((limit) => err instanceof limit)) throw new PermanentIngestError("too_large");
      throw err; // a crash or an abort is the system's problem, not the document's
    }
    await deps.parsed.put(ref, parsed);
    return { count: parsed.sections.length };
  });
}
```

(`ParseAbortedError` is imported only if the implementer's lint needs it; the `throw err` path covers it. Remove the unused import.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/ingest-document/steps/parse.test.ts`
Expected: PASS.

- [ ] **Step 5: Close-out**

Branch `feat/ingest-parse-step`; subject `feat(server): parse step effect over ports`.

---

### Task 79: ingest dependencies through `buildServer` and `main`

Carry-forward 5. `ComposeOptions` gains the parser registry, the runner, the progress bus and the parse limits' loader; `main.ts` builds them from the environment; `testHarness` builds fakes. Nothing uses them until Task 80, so `main` stays green.

**Files:**
- Create: `apps/server/app/flows/ingest-document/limits.ts`
- Create: `apps/server/app/flows/ingest-document/limits.test.ts`
- Modify: `apps/server/app/documents/limits.ts` (export `positiveInt`; one word)
- Modify: `apps/server/app/compose.ts` (`ComposeOptions.ingest`, returned `bus` and `starts`)
- Modify: `apps/server/app/main.ts` (build the wiring; drain `starts.idle()` at shutdown)
- Modify: `apps/server/app/documents/testHarness.ts` and `documents.e2e.pg.test.ts` (pass the wiring)

**Interfaces:**
- Consumes: `ParseRunner`, `ParserRegistry`, `createDefaultParsers`, `InMemoryProgressBus`.
- Produces: `interface IngestWiring { registry: ParserRegistry; runner: ParseRunner; bus: ProgressBus }`; `loadParseLimits(env = process.env): ParseLimits` (the concurrency variable goes to the runner, not the limits) reading `DOCMIND_PARSE_TIMEOUT_MS` (default 30000), `DOCMIND_PARSE_MEMORY_MB` (512), `maxInputBytes` from `DOCMIND_MAX_UPLOAD_BYTES` (the upload limit, 52428800 by default, so nothing the upload accepted is refused here), `DOCMIND_PARSE_MAX_CHARS` (20000000), `DOCMIND_PARSE_CONCURRENCY` (2); `createIngestWiring(env?): IngestWiring`; `ComposeOptions.ingest: IngestWiring`.

- [ ] **Step 1: Write the failing test**

`limits.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createIngestWiring, loadParseLimits } from "./limits";

describe("loadParseLimits", () => {
  it("has defaults", () => {
    expect(loadParseLimits({})).toEqual({ wallClockMs: 30_000, memoryMb: 512, maxInputBytes: 52_428_800, maxChars: 20_000_000 });
  });
  it("reads overrides", () => {
    expect(loadParseLimits({ DOCMIND_PARSE_TIMEOUT_MS: "5000", DOCMIND_PARSE_MEMORY_MB: "128" })).toMatchObject({ wallClockMs: 5000, memoryMb: 128 });
  });
  it.each([
    ["DOCMIND_PARSE_TIMEOUT_MS", "0"],
    ["DOCMIND_PARSE_MEMORY_MB", "-1"],
    ["DOCMIND_PARSE_MAX_CHARS", "abc"],
    ["DOCMIND_PARSE_CONCURRENCY", "1.5"],
  ])("rejects %s=%s naming the variable but not the value", (name, value) => {
    expect(() => loadParseLimits({ [name]: value })).toThrow(new RegExp(`^${name} must be a positive integer$`));
  });
});

describe("createIngestWiring", () => {
  it("builds a registry with the txt parser, a runner and a bus", () => {
    const w = createIngestWiring({});
    expect(w.registry.ids()).toEqual(["txt"]);
    expect(w.runner.active()).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/ingest-document/limits.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`limits.ts` reuses `documents/limits.ts`'s `positiveInt(env, name, fallback)` (message `X must be a positive integer`, never the value):

```ts
export interface IngestWiring {
  registry: ParserRegistry;
  runner: ParseRunner;
  bus: ProgressBus;
}

export function loadParseLimits(env: NodeJS.ProcessEnv = process.env): ParseLimits {
  return {
    wallClockMs: positiveInt(env, "DOCMIND_PARSE_TIMEOUT_MS", 30_000),
    memoryMb: positiveInt(env, "DOCMIND_PARSE_MEMORY_MB", 512),
    maxInputBytes: positiveInt(env, "DOCMIND_MAX_UPLOAD_BYTES", 50 * 1024 * 1024),
    maxChars: positiveInt(env, "DOCMIND_PARSE_MAX_CHARS", 20_000_000),
  };
}

export function createIngestWiring(env: NodeJS.ProcessEnv = process.env): IngestWiring {
  const limits = loadParseLimits(env);
  return {
    registry: new ParserRegistry(createDefaultParsers()),
    runner: new ParseRunner({ limits, maxConcurrent: positiveInt(env, "DOCMIND_PARSE_CONCURRENCY", 2) }),
    bus: new InMemoryProgressBus(),
  };
}
```

`compose.ts`: add `ingest: IngestWiring` to `ComposeOptions`, return it as `ingest` from `buildServer` (so routes added later and tests can reach `bus`). `main.ts`: `const ingest = createIngestWiring();` and pass it; in `stop()` call `await starts.idle()` before `app.close()` (`buildServer` returns `starts`). `testHarness.ts` and `documents.e2e.pg.test.ts` pass `createIngestWiring({})` (or fakes) so they compile.

- [ ] **Step 4: Run to verify it passes**

Run: `export DOCMIND_TEST_PG_URL=... && pnpm --filter @docmind/server exec vitest run`
Expected: PASS (the whole server suite: wiring is additive).

- [ ] **Step 5: Close-out**

Branch `feat/ingest-wiring`; subject `feat(server): ingest dependencies flow through buildServer and main`. `.env.example` gets the `DOCMIND_PARSE_*` and embedding variables in Task 95b.

---

### Task 79b: the status model through `buildApp`, `buildServer` and `main`

Revision R3 and R4. The composition root gets the live feed (`observability.onEvent`), the compaction exemption, the sensitive map (computed after `defineConfig`), the writer and reader stores, and the boot order: register, catch up, then serve. Nothing reads the model yet (Task 79c does), so `main` stays green and the document API is unchanged.

**Files:**
- Create: `apps/server/app/status/wire.ts`
- Create: `apps/server/app/status/wire.test.ts`
- Create: `apps/server/app/status/compose.test.ts`
- Modify: `apps/server/app/config.ts` (`FlowDeps.onEvent`, `observability`, `durability.retention.compactionExempt`)
- Modify: `apps/server/app/compose.ts` (`ComposeOptions.status`, build `IngestStatus`, return it)
- Modify: `apps/server/app/main.ts` (build the stores, boot, close)
- Modify: `apps/server/app/storage.ts` (`DurableStorage.pool`)

**Interfaces:**
- Consumes: `IngestStatus` (74c, 74d), `pgStatusWriter`, `pgStatusReaderFor` (74e), `isIngestExecution` (74b), `IngestWiring` (79; its `bus`), `sensitivePathsFromSteps` (`@loom/plugin-crypto`), `mergeSensitive`, `sensitiveMapFromCovers` (`@loom/plugin-read-model`), `EventStore` (`@loom/event-runtime`).
- Produces: `flowSteps()` (the steps of every registered flow; today `ingestDocumentFlow.definition.steps`; add each new flow here), `statusSensitive(steps, store: Pick<EventStore, "sealingCapability">): SensitiveMap`; `interface StatusStores { writer: ReadModelStore; readerFor(identity: Identity): ReadModelStore; source: EventStore }`; `ComposeOptions.status: StatusStores`; `buildServer` also returns `status: IngestStatus`; `DurableStorage.pool: Pool`; `FlowDeps.onEvent?: (event: EventEnvelope) => void`.

- [ ] **Step 1: Write the failing tests**

`status/wire.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { EncryptingEventStore, InMemoryKeyStore, sensitivePathsFromSteps } from "@loom/plugin-crypto";
import { describe, expect, it } from "vitest";
import { buildApp } from "../config";
import { ingestDocumentFlow } from "../flows/ingest-document/flow";
import { SENSITIVE_EVENT_PATHS } from "../sensitive";
import { subjectOfExecution } from "../subject";
import { isIngestExecution } from "./model";
import { flowSteps, statusSensitive } from "./wire";

describe("the status model's sensitive map", () => {
  it("includes the framework-sealed paths that only the encrypting store knows after defineConfig, which the steps alone miss", () => {
    const events = new EncryptingEventStore(new InMemoryAsyncEventStore(), new InMemoryKeyStore(), {
      sensitive: { ...SENSITIVE_EVENT_PATHS },
      subjectOf: subjectOfExecution,
    });
    const app = buildApp({ kind: "custom", eventStore: events }, { events });
    const fromSteps = sensitivePathsFromSteps(flowSteps());
    expect(fromSteps.EXECUTION_STARTED).toBeUndefined();
    expect(statusSensitive(flowSteps(), events).EXECUTION_STARTED).toEqual(
      expect.arrayContaining(["principal.identity.actor", "principal.identity.onBehalfOf", "principal.identity.tenant"]),
    );
    void app.close();
  });

  it("is the steps' map alone when the store seals nothing", () => {
    expect(statusSensitive(flowSteps(), new InMemoryAsyncEventStore())).toEqual(sensitivePathsFromSteps(flowSteps()));
  });
});

describe("flows and retention", () => {
  it("lists the steps of every registered flow, so a new flow's sensitive outputs reach the model", () => {
    expect(flowSteps().map((s) => s.id)).toEqual(ingestDocumentFlow.definition.steps.map((s) => s.id));
  });

  it("exempts every generation of an ingest execution from compaction, and nothing else", () => {
    const [u, d] = [randomUUID(), randomUUID()];
    expect([`u_${u}:ingest-${d}`, `u_${u}:ingest-${d}.2`, `u_${u}:chat-${d}`].map(isIngestExecution)).toEqual([true, true, false]);
  });
});
```

`status/compose.test.ts` (the real composition over in-memory stores; the database pool is a stub because the step fails before it would use it):

```ts
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { InMemoryReadModelStore } from "@loom/plugin-read-model";
import type { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { buildServer } from "../compose";
import { createIngestWiring } from "../flows/ingest-document/limits";
import { ingestDocumentFlow } from "../flows/ingest-document/flow";
import { loadBlobRoot, loadLimits } from "../documents/limits";
import { ingestExecutionId, ingestStartInput } from "../documents/ingest";
import { STATUS_MESSAGES } from "./model";

const root = mkdtempSync(join(tmpdir(), "dm-compose-status-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("buildServer and the ingest-status model", () => {
  it("feeds the model from Loom's onEvent and boots it before serving", async () => {
    const eventStore = new InMemoryAsyncEventStore();
    const store = new InMemoryReadModelStore();
    const composed = buildServer({
      pool: {} as Pool, // never reached: the flow fails at its first step
      keys: new InMemoryKeyStore(),
      storage: { kind: "custom", eventStore },
      limits: loadLimits({}),
      blobRoot: loadBlobRoot({ DOCMIND_BLOB_DIR: root }),
      secureCookies: false,
      trustProxy: false,
      ingest: createIngestWiring({}),
      status: { writer: store, readerFor: () => store, source: eventStore },
    });
    await composed.status.boot();
    const identity = { tenantId: randomUUID(), userId: randomUUID() };
    const documentId = randomUUID();
    const ref = ingestStartInput(identity, documentId);
    const handle = await composed.app.runtime.start(ingestDocumentFlow, ref, {
      executionId: ingestExecutionId(identity.userId, documentId),
      principal: { tenant: identity.tenantId, actor: identity.userId },
    });
    await handle.waitForCompletion().catch(() => {}); // the stub step cannot reach the stub pool, so the execution fails
    await composed.status.close();
    const views = await composed.status.forPage(identity, [documentId]);
    expect(views.get(documentId)).toMatchObject({ status: "failed", error: STATUS_MESSAGES.internal });
    await composed.app.close();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @docmind/server exec vitest run app/status/wire.test.ts app/status/compose.test.ts`
Expected: FAIL (`./wire` not found; `buildServer` takes no `status` and returns none).

- [ ] **Step 3: Implement**

`status/wire.ts`:

```ts
import type { StepDefinition } from "@loom/core";
import type { EventStore } from "@loom/event-runtime";
import { sensitivePathsFromSteps } from "@loom/plugin-crypto";
import { type SensitiveMap, mergeSensitive, sensitiveMapFromCovers } from "@loom/plugin-read-model";
import { ingestDocumentFlow } from "../flows/ingest-document/flow";

/** The steps of every flow the app registers. Add a flow here so its `sensitive(...)` outputs reach the model's guard (ADR 0132 D11). */
export const flowSteps = (): readonly StepDefinition[] => [ingestDocumentFlow].flatMap((flow) => flow.definition.steps);

/**
 * The paths a folded handler must never see: the steps' `sensitive(...)` outputs UNION what the
 * encrypting store seals. Call it after `defineConfig`: only then have the framework-sealed paths
 * (`EXECUTION_STARTED` `principal.identity.*`, `OUTCOME_RECORDED.recordedBy`) been registered.
 */
export const statusSensitive = (steps: readonly StepDefinition[], store: Pick<EventStore, "sealingCapability">): SensitiveMap =>
  mergeSensitive(sensitivePathsFromSteps(steps), sensitiveMapFromCovers(store.sealingCapability?.()?.covers ?? []));
```

`config.ts`: import `type { EventEnvelope } from "@loom/core"` and `isIngestExecution` from `./status/model`; `FlowDeps` gains `onEvent?: (event: EventEnvelope) => void;` and `defineConfig({...})` gains

```ts
    observability: { ...(deps.onEvent && { onEvent: deps.onEvent }) },
    // The status model folds each ingest execution's log from its first event, so compaction must never
    // remove an ingest execution's prefix (ADR 0132; plugins.md note 8). DocMind configures no retention yet.
    durability: { retention: { compactionExempt: isIngestExecution } },
```

`compose.ts`:

```ts
import type { Identity } from "@docmind/auth";
import type { EventStore } from "@loom/event-runtime";
import type { ReadModelStore } from "@loom/plugin-read-model";
import { IngestStatus } from "./status/ingestStatus";
import { flowSteps, statusSensitive } from "./status/wire";

/** The stores behind the ingest-status model (Revision R2): in production the Loom-pool writer and the tenant-bound reader. */
export interface StatusStores {
  writer: ReadModelStore;
  readerFor(identity: Identity): ReadModelStore;
  /** The decrypting event store the model reads (live source and catch-up source); its sealing covers feed the sensitive map. */
  source: EventStore;
}
```

`ComposeOptions` gains `status: StatusStores;`. In `buildServer`, the `buildApp` call becomes

```ts
  let status: IngestStatus | undefined; // built after defineConfig, which the sensitive map needs; onEvent reads it by closure
  const app = buildApp(options.storage, options.crypto, {
    ingest: pgIngestDeps(pool),
    onEvent: (event) => status?.onEvent(event),
  });
  status = new IngestStatus({
    writer: options.status.writer,
    readerFor: options.status.readerFor,
    source: options.status.source,
    sensitive: statusSensitive(flowSteps(), options.status.source),
    bus: options.ingest.bus,
  });
```

and the returned object gains `status`. (`pgIngestDeps(pool)` is whatever Task 79 and Task 80 make it at the time; this task changes only the extra `onEvent` property.)

`storage.ts`: `DurableStorage` gains `pool: Pool;` and `createDurableStorage` returns `pool` (the Loom pool it already builds; `close` still ends it).

`main.ts`: after `buildServer`, before `server.listen`:

```ts
  // The status model: its writer shares the Loom pool, its reader is the app pool (every read inside withTenant).
  // Boot order (ADR 0132 D13): register, then catch up on what the log holds, before anything is served.
  try {
    await status.boot();
  } catch (err) {
    await app.close();
    await durable.close();
    await pool.end();
    throw err;
  }
```

with `status: { writer: pgStatusWriter(durable.pool), readerFor: pgStatusReaderFor(pool), source: durable.storage.eventStore }` added to the `buildServer({...})` options and `status` destructured from its result; in `stop()` add `await status.close();` right before `await app.close();`.

- [ ] **Step 4: Run to verify they pass**

Run: `export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:55432/postgres && pnpm --filter @docmind/server exec vitest run`
Expected: PASS. `documents.e2e.pg.test.ts` and the harness gain a `status` option in Task 79c; until then the M2 e2e test passes `status: { writer, readerFor, source }` over `InMemoryReadModelStore` and the `InMemoryAsyncEventStore` it also uses as `storage` (a three-line edit in this task).

- [ ] **Step 5: Close-out**

Branch `feat/status-wiring`; subject `feat(server): the ingest-status model through buildApp, buildServer and main`.

---

### Task 79c: the document API reads its status from the model; `documents.status` and `documents.error` are dropped

Revision R5, R7 and R8. The list, `GET /:id` and the duplicate-upload answer take their status from `IngestStatus`; the delete route forgets the document's status rows after cancelling its flow; the two columns nothing will ever write again are removed. Until Task 80 the flow is still the M2 stub, which never moves a document out of `uploaded`, so the API answers exactly what it answered before.

**Files:**
- Create: `infra/migrations/0013_documents_drop_status.sql`
- Modify: `apps/server/app/documents/repo.ts` (columns, `DocumentRow`, `toDto`)
- Modify: `apps/server/app/documents/routes.ts` (list, get, duplicate upload, delete)
- Modify: `apps/server/app/compose.ts` (pass `status` to `documentRoutes`)
- Modify: `apps/server/app/documents/testHarness.ts` (in-memory event store, status model; exposes `status`, `statusStore` and `bus`)
- Modify: `apps/server/app/db/documents.pg.test.ts` (the `status` column is gone)
- Modify: `apps/server/app/documents/ingestStart.pg.test.ts` (the stub test reads the model)
- Modify: `apps/server/app/documents/documents.e2e.pg.test.ts` (custom in-memory storage and status stores)
- Create: `apps/server/app/documents/status.pg.test.ts`

**Interfaces:**
- Consumes: `DocumentStatusReads` (74e), `UPLOADED`, `StatusView`, `INGEST_STATUS_MODEL` (74b), `IngestStatus` (74c, 74d), `evt`, `ingestRun` (74b).
- Produces: `toDto(row: DocumentRow, cipher: UserFieldCipher, view: StatusView): Promise<DocumentDto>` (the view is required, so no caller can forget it); `DocumentRoutesDeps.status: DocumentStatusReads`; `DocumentHarness.status: IngestStatus`, `DocumentHarness.statusStore: InMemoryReadModelStore` and `DocumentHarness.bus: InMemoryProgressBus` (the bus the status publisher uses; Task 94b mounts the event route on it); migration `0013`.

- [ ] **Step 1: Write the failing tests**

`documents/status.pg.test.ts`:

```ts
import type { DocumentDto, ListDocumentsResponse } from "@docmind/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FieldCrypto } from "../crypto/fields";
import { withTenant } from "../db/tenant";
import { PG_URL } from "../db/testSupport";
import { INGEST_STATUS_MODEL, STATUS_MESSAGES } from "../status/model";
import { ingestRun } from "../status/testing";
import { insertDocument } from "./repo";
import { ALICE, BOB, type DocumentHarness, TEXT, U1, newDocument, startDocumentServer } from "./testHarness";

describe.skipIf(!PG_URL)("document status comes from the ingest-status model (needs DOCMIND_TEST_PG_URL)", () => {
  let h: DocumentHarness;
  beforeAll(async () => {
    h = await startDocumentServer();
  });
  afterAll(async () => {
    await h?.close();
  });

  /** A document row with no flow running for it, so a test decides what the model knows. */
  const seed = async (who: typeof ALICE, fingerprint: string) => {
    const doc = await newDocument(new FieldCrypto(h.keys), who.tenantId, who.userId, fingerprint);
    await withTenant(h.app, who.tenantId, (tx) => insertDocument(tx, doc));
    return doc.id;
  };
  /** Feed the model the way Loom's onEvent does. */
  const feed = async (who: typeof ALICE, id: string, spec: Parameters<typeof ingestRun>[1]) => {
    for (const e of ingestRun(`u_${who.userId}:ingest-${id}.2`, spec)) h.status.onEvent(e);
    await h.status.close();
  };
  const json = async (user: string, path: string) => (await fetch(`${h.base}${path}`, { headers: { "x-test-user": user } })).json();

  it("lists each document's status and failure message from the model, and uploaded for one with no row", async () => {
    const fresh = await seed(ALICE, "1".repeat(64));
    const parsing = await seed(ALICE, "2".repeat(64));
    const failed = await seed(ALICE, "3".repeat(64));
    const bobs = await seed(BOB, "4".repeat(64));
    await feed(ALICE, parsing, "parsed");
    await feed(ALICE, failed, "failed:corrupt_content");
    await feed(BOB, bobs, "ready");
    const by = new Map(((await json("alice", "/api/documents")) as ListDocumentsResponse).items.map((d) => [d.id, d]));
    expect([fresh, parsing, failed].map((id) => [by.get(id)?.status, by.get(id)?.error])).toEqual([
      ["uploaded", null],
      ["parsing", null],
      ["failed", STATUS_MESSAGES.corrupt_content],
    ]);
    expect(by.has(bobs)).toBe(false);
  });

  it("shows the same status on GET /api/documents/:id, and a 404 to another user", async () => {
    const id = await seed(ALICE, "5".repeat(64));
    await feed(ALICE, id, "ready");
    expect(await json("alice", `/api/documents/${id}`)).toMatchObject({ id, status: "ready", error: null });
    expect((await fetch(`${h.base}/api/documents/${id}`, { headers: { "x-test-user": "bob" } })).status).toBe(404);
  });

  it("answers a fresh upload as uploaded with no error", async () => {
    const body = (await (await h.upload("alice", "n.txt", TEXT("fresh status"))).json()) as { document: DocumentDto };
    expect([body.document.status, body.document.error]).toEqual(["uploaded", null]);
  });

  it("deleting a document tombstones its status rows", async () => {
    const id = await seed(ALICE, "6".repeat(64));
    await feed(ALICE, id, "ready");
    expect((await fetch(`${h.base}/api/documents/${id}`, { method: "DELETE", headers: { "x-test-user": "alice" } })).status).toBe(204);
    const [row] = await h.statusStore.getFolded(INGEST_STATUS_MODEL, [`u_${U1}:ingest-${id}.2`]);
    expect(row).toMatchObject({ erased: true, state: null });
    expect((await h.status.forPage(ALICE, [id])).size).toBe(0);
  });
});
```

Edits to existing tests, each the smallest that states the new behaviour:
- `db/documents.pg.test.ts`: the `insert` helper loses the `status` column (`... content_address, fingerprint) VALUES ($1, $2, $3, '{"x":1}', '{"x":2}', 'text/plain', $4, $5, $6)`, the seventh parameter and `extra.status`), its `extra` type becomes `{ size?: number; address?: string }`, and the line `await expect(bad(HEX("d"), { status: "done" })).rejects.toThrow(/status/);` is deleted.
- `ingestStart.pg.test.ts`, first test: the last three lines (the comment, the `SELECT status` query and its assertion) become `expect(await h.status.forDocument(ALICE, id)).toEqual(UPLOADED); // the stub writes nothing`, with `ALICE` from the harness and `UPLOADED` from `../status/model`.
- `documents.e2e.pg.test.ts`: `storage: { kind: "memory" }` becomes `storage: { kind: "custom", eventStore }` with `const eventStore = new InMemoryAsyncEventStore(); const statusStore = new InMemoryReadModelStore();` above it, and `buildServer` gets `ingest: createIngestWiring({})` (if Task 79 has not added it yet) and `status: { writer: statusStore, readerFor: () => statusStore, source: eventStore }`; after `buildServer` the test awaits `composed.status.boot()`.

- [ ] **Step 2: Run to verify they fail**

Run: `export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:55432/postgres && pnpm --filter @docmind/server exec vitest run app/documents/status.pg.test.ts`
Expected: FAIL (`h.status` is undefined; the list still reads `documents.status`).

- [ ] **Step 3: Implement**

`infra/migrations/0013_documents_drop_status.sql`:

```sql
-- A document's status is the ingest-status model's state (0012): a document with no row there is
-- `uploaded`, and the failure text is derived from the failure code at read time. A column that
-- nothing writes would only be a second source of truth that can disagree with the log.
ALTER TABLE documents DROP COLUMN status, DROP COLUMN error;
```

`repo.ts`: `DOCUMENT_COLUMNS` drops `status, error,`; `DocumentRow` loses `status` and `error` (and the `DocumentStatus` import); `toDto` becomes

```ts
export async function toDto(row: DocumentRow, cipher: UserFieldCipher, view: StatusView): Promise<DocumentDto> {
  return {
    id: row.id,
    title: await cipher.openText(titleBind(row.id), row.title_enc),
    filename: await cipher.openText(filenameBind(row.id), row.filename_enc),
    mime: row.mime,
    sizeBytes: Number(row.size_bytes),
    status: view.status,
    error: view.error,
    // stats, summary, createdAt, updatedAt: unchanged
  };
}
```

`routes.ts` (`import { UPLOADED } from "../status/model"` and `type DocumentStatusReads` from `../status/ingestStatus`): `DocumentRoutesDeps` gains `status: DocumentStatusReads;`. In `register`, both `toDto(...)` calls pass `UPLOADED` (inside the tenant transaction no status is read). In `upload`, right after the quota branch:

```ts
  const { duplicate } = result;
  let { document } = result;
  // A duplicate is an existing document, so its status is the model's (one log-tail read); a new one is `uploaded`.
  if (duplicate) {
    const view = await deps.guard.forDocument(identity, document.id);
    document = { ...document, status: view.status, error: view.error };
  }
```

(the existing `!duplicate || document.status === "uploaded"` start condition and the `json(...)` answer then use this `document`). The list handler becomes

```ts
      const views = await deps.guard.forPage(identity, page.rows.map((row) => row.id));
      json(res, 200, {
        items: await Promise.all(page.rows.map((row) => toDto(row, cipher, views.get(row.id) ?? UPLOADED))),
        nextCursor: page.next ? encodeCursor(page.next) : null,
      } satisfies ListDocumentsResponse);
```

`GET /api/documents/:id` calls `await deps.guard.forDocument(identity, row.id)` and passes the view to `toDto`. In `DELETE`, between the cancel and the row removal: `await deps.guard.forgetDocument(identity, mine.id);` with a comment that the flow is already cancelled, so the purge drains the node's in-flight folds first. `compose.ts` passes `status` (the `IngestStatus` built in Task 79b) to `documentRoutes`.

`testHarness.ts`: `makeIngest` builds `const eventStore = new InMemoryAsyncEventStore(); const statusStore = new InMemoryReadModelStore();`, builds its Loom app with `buildApp({ kind: "custom", eventStore }, undefined, { ingest: ..., onEvent: (e) => status?.onEvent(e) })`, creates `status = new IngestStatus({ writer: statusStore, readerFor: () => statusStore, source: eventStore, sensitive: {}, bus: new InMemoryProgressBus(), onError: () => {} })`, returns it with `statusStore` and its bus, and `startDocumentServer` awaits `status.boot()`, passes `status` to `documentRoutes`, and exposes all three on the harness; `close()` awaits `status.close()` before closing Loom.

- [ ] **Step 4: Run to verify they pass**

Run: `export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:55432/postgres && pnpm --filter @docmind/server exec vitest run`
Expected: PASS: the whole server suite, including every M2 document test (a document answers `uploaded` with no error, as before).

- [ ] **Step 5: Close-out**

Branch `feat/documents-status-from-model`; subject `feat(api): document status comes from the ingest-status model; drop documents.status and error`. Seam if over: the harness and the three existing-test edits after the routes.

---

### Task 80: `ingest-document` v2 with the `parse` step; the stub is retired

Spec §9 item 14 (skeleton). The flow becomes `[parse]` here; Tasks 83, 91 and 92 append `chunk`, `embed` and the rest. Until Task 92 a document that parses stays `parsing`; nothing reaches `ready` by accident. The stub (`ingest-begin`, `IngestDeps.documentExists`, `pgIngestDeps(pool)`) is deleted.

**Size exception (Open question 11).** This is the one task that cannot be split without leaving `main` red: the new `pgIngestDeps` signature, the harness that builds it, the stub's assertions in the two pg tests, and the flow swap must land together. Counting deletions (the stub's `flow.test.ts` assertions and `pgDeps.pg.test.ts`, about 170 lines), expect **about 250 changed lines in 9 to 10 files**. The plan asks the owner for a one-time waiver; the executor keeps the diff as small as possible by editing `flow.test.ts` in place (keep the start-once, no-principal and ids-only tests, change only what they run against) rather than rewriting it, and by changing the pg tests' assertions with the smallest edits that state the v2 behaviour.

**Files:**
- Modify: `apps/server/app/flows/ingest-document/flow.ts`
- Modify: `apps/server/app/flows/ingest-document/deps.ts`
- Modify: `apps/server/app/flows/ingest-document/pgDeps.ts`
- Modify: `apps/server/app/config.ts`
- Modify: `apps/server/app/security.ts`
- Modify: `apps/server/app/compose.ts`
- Modify: `apps/server/app/flows/ingest-document/flow.test.ts` (rewritten)
- Delete: `apps/server/app/flows/ingest-document/pgDeps.pg.test.ts` (superseded by Tasks 75a-75c)
- Modify: `apps/server/app/documents/testHarness.ts`, `ingestStart.pg.test.ts`, `documents.e2e.pg.test.ts` (what they assert about the stub)

**Interfaces:**
- Consumes: `parseEffect`/`ParseDeps` (78), `StepGuard` (73a), `PgStepGuard` (75c), `IngestStatus` (74c-74d, wired by 79b), `PgParsedStore` (75a), `PgDocumentSource` (75b), `IngestWiring` (79), `StepResult` (73).
- Produces:
  - `flow.ts`: `IngestStartInput` (unchanged), `IngestOutput = z.object({ outcome: StepResult.shape.outcome, code: StepResult.shape.code }).strict()`, `ingestParseStep` (`id: "ingest-parse"`, input `IngestStartInput`, output `StepResult`), `INGEST_STEPS` (an ordered array, `[ingestParseStep]` now), the flow `ingestDocumentFlow` (version `2.0.0`) whose runner runs each step in order and returns early on `document_gone` or `failed`.
  - `deps.ts`: `interface IngestDeps extends ParseDeps {}` (grows by one interface per later task) and `ingestEffects(deps: IngestDeps): Record<string, Effect<IngestStartInput, StepResult>>` keyed by step id.
  - `pgDeps.ts`: `pgIngestDeps(args: { pool: Pool; fields: FieldCrypto; blobs: Blobs; wiring: IngestWiring }): IngestDeps`.
  - `security.ts`: `authorizer` lists `"ingest-document": ["ingest-parse"]`.

- [ ] **Step 1: Write the failing tests**

Rewrite `flow.test.ts` (in-memory Loom app with fake `IngestDeps`, as the stub's did):

```ts
import { randomUUID } from "node:crypto";
import { sensitivePathsFromSteps } from "@loom/plugin-crypto";
import { ExecutionAlreadyExistsError, ExecutionDeniedError } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../config";
import { SENSITIVE_EVENT_PATHS } from "../../sensitive";
import { executionIdFor } from "../../subject";
import { ingestExecutionId } from "../../documents/ingest";
import { ParseRejectedError, ParserRegistry, createDefaultParsers } from "@docmind/parsers";
import { DocumentGoneError } from "./errors";
import { INGEST_STEPS, IngestOutput, IngestStartInput, ingestDocumentFlow } from "./flow";
import type { IngestDeps } from "./deps";
import { StepResult } from "./stepEffect";

const ids = (): IngestStartInput => ({ tenantId: randomUUID(), userId: randomUUID(), documentId: randomUUID() });

function fakeDeps(over: Partial<{ gone: boolean; reject: boolean }> = {}) {
  const seen: string[] = [];
  const deps: IngestDeps = {
    guard: { begin: async (_r, step) => { seen.push(`begin:${step}`); if (over.gone) throw new DocumentGoneError(); } },
    source: { meta: async () => ({ mime: "text/plain", contentAddress: "a" }), read: async () => new Uint8Array([104]) },
    parsed: { put: async () => {}, take: async () => undefined, drop: async () => {} },
    registry: new ParserRegistry(createDefaultParsers()),
    runner: { run: async () => { if (over.reject) throw new ParseRejectedError("corrupt_content"); return { text: "h", sections: [{ headingPath: [], text: "h", locator: { kind: "chars", start: 0, end: 1 } }], media: [] }; } },
  };
  return { deps, seen };
}
type App = ReturnType<typeof buildApp>;
const start = (input: IngestStartInput, app: App) =>
  app.runtime.start(ingestDocumentFlow, input, {
    executionId: ingestExecutionId(input.userId, input.documentId),
    principal: { tenant: input.tenantId, actor: input.userId },
  });

describe("ingest-document flow v2", () => {
  it("runs the parse step and completes done", async () => {
    const { deps, seen } = fakeDeps();
    const app = buildApp({ kind: "memory" }, undefined, { ingest: deps });
    const state = await (await start(ids(), app)).waitForCompletion();
    expect(state.status).toBe("completed");
    expect(state.variables._output).toEqual({ outcome: "done" });
    expect(seen).toEqual(["begin:parse"]);
    await app.close();
  });

  it("stops cleanly, not as a failure, when the document is gone at any step", async () => {
    const { deps } = fakeDeps({ gone: true });
    const app = buildApp({ kind: "memory" }, undefined, { ingest: deps });
    const state = await (await start(ids(), app)).waitForCompletion();
    expect([state.status, state.variables._output]).toEqual(["completed", { outcome: "document_gone" }]);
    await app.close();
  });

  it("ends with outcome failed and the code for a permanent content problem", async () => {
    const { deps } = fakeDeps({ reject: true });
    const app = buildApp({ kind: "memory" }, undefined, { ingest: deps });
    const state = await (await start(ids(), app)).waitForCompletion();
    expect(state.variables._output).toEqual({ outcome: "failed", code: "corrupt_content" });
    await app.close();
  });

  it("is start-once per document and generation", async () => {
    const { deps } = fakeDeps();
    const app = buildApp({ kind: "memory" }, undefined, { ingest: deps });
    const input = ids();
    await (await start(input, app)).waitForCompletion();
    await expect(start(input, app)).rejects.toBeInstanceOf(ExecutionAlreadyExistsError);
    await app.close();
  });

  it("fails at its step, not silently, when the app was built without ingest deps", async () => {
    const app = buildApp({ kind: "memory" });
    await expect((await start(ids(), app)).waitForCompletion()).rejects.toThrow(/No effect registered for toolId: "ingest-parse"/);
    await app.close();
  });

  it("is refused for a caller with no principal", async () => {
    const app = buildApp({ kind: "memory" }, undefined, { ingest: fakeDeps().deps });
    const input = ids();
    await expect(app.runtime.start(ingestDocumentFlow, input, { executionId: ingestExecutionId(input.userId, input.documentId) })).rejects.toBeInstanceOf(ExecutionDeniedError);
    await app.close();
  });
});

describe("what the flow may carry", () => {
  it("accepts exactly three UUIDs as start input and refuses any other field", () => {
    const input = ids();
    expect(Object.keys(IngestStartInput.shape).sort()).toEqual(["documentId", "tenantId", "userId"]);
    for (const extra of ["filename", "title", "content", "text", "summary", "mime"]) {
      expect(IngestStartInput.safeParse({ ...input, [extra]: "tax-return.pdf" }).success, extra).toBe(false);
    }
  });

  it("gives every step the same content-free result shape and the flow a two-field output", () => {
    expect(Object.keys(StepResult.shape).sort()).toEqual(["code", "count", "model", "outcome"]);
    expect(Object.keys(IngestOutput.shape).sort()).toEqual(["code", "outcome"]);
    for (const step of INGEST_STEPS) expect(step.outputSchema).toBe(StepResult);
  });

  it("marks nothing sensitive, because nothing it carries is content", () => {
    expect(sensitivePathsFromSteps(ingestDocumentFlow.definition.steps)).toEqual({});
    expect(SENSITIVE_EVENT_PATHS).toEqual({});
  });

  it("keeps the execution id free of content: u_<user>:ingest-<document uuid>.<generation> only", () => {
    const input = ids();
    expect(ingestExecutionId(input.userId, input.documentId)).toMatch(/^u_[0-9a-f-]{36}:ingest-[0-9a-f-]{36}\.2$/);
    expect(executionIdFor(input.userId, "ingest-x")).toMatch(/^u_/);
  });
});
```

For the harness and the existing pg tests: `makeIngest` in `testHarness.ts` builds its Loom app with `pgIngestDeps({ pool: app, fields, blobs, wiring })` over the harness's real blob root, wrapping `guard.begin` with the `probe` gate (where `documentExists` was gated). `ingestStart.pg.test.ts`'s first test now expects, after `waitForCompletion` for a `.txt` upload, `_output` `{ outcome: "done" }` and `await h.status.forDocument(ALICE, id)` equal to `{ status: "parsing", step: "parse", error: null }`; uploads of non-txt types (the harness `PDF`/`PNG` helpers) end `{ status: "failed", step: "parse", error: STATUS_MESSAGES.unsupported_content }`, and the tests that only care about start/cancel use `TEXT(...)`. `documents.e2e.pg.test.ts`: "the stub leaves the document uploaded" assertions become the txt expectations.

- [ ] **Step 2: Run to verify they fail**

Run: `export DOCMIND_TEST_PG_URL=... && pnpm --filter @docmind/server exec vitest run app/flows/ingest-document/flow.test.ts`
Expected: FAIL (`INGEST_STEPS` undefined; `StepResult` not the step output).

- [ ] **Step 3: Implement**

`flow.ts`:

```ts
import { flow$, step$ } from "@loom/core";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";
import { StepResult } from "./stepEffect";

/** Start input: ids only (never a filename, title or text), strict so a field added later fails loudly. */
export const IngestStartInput = z
  .object({ tenantId: z.string().uuid(), userId: z.string().uuid(), documentId: z.string().uuid() })
  .strict();
export type IngestStartInput = z.infer<typeof IngestStartInput>;

export const IngestOutput = z.object({ outcome: StepResult.shape.outcome, code: StepResult.shape.code }).strict();
export type IngestOutput = z.infer<typeof IngestOutput>;

const stepOf = (id: string, name: string) =>
  step$({ id, name, inputSchema: IngestStartInput, outputSchema: StepResult });

// A step id doubles as its tool id; `security.ts` grants exactly these.
export const ingestParseStep = stepOf("ingest-parse", "IngestParse");
/** Spec 5.2 order. Later tasks append chunk, embed, analyze, summarize, link, finalize. */
export const INGEST_STEPS = [ingestParseStep];

const runner: FlowRunner<IngestStartInput, IngestOutput> = async (ctx, input) => {
  for (const step of INGEST_STEPS) {
    const result = await ctx.run(step, input);
    if (result.outcome !== "done") return { outcome: result.outcome, code: result.code };
  }
  return { outcome: "done" };
};

export const ingestDocumentFlow: RegisteredFlow = {
  definition: flow$({
    id: "ingest-document",
    name: "IngestDocument",
    version: "2.0.0",
    inputSchema: IngestStartInput,
    outputSchema: IngestOutput,
    steps: INGEST_STEPS,
  }),
  runner: runner as FlowRunner<unknown, unknown>,
};
```

`deps.ts`:

```ts
import type { Effect } from "@loom/effect-runtime";
import type { IngestStartInput } from "./flow";
import { type ParseDeps, parseEffect } from "./steps/parse";
import type { StepResult } from "./stepEffect";

/** What the flow's steps need from the outside world, registered per app as effects (Loom has no per-flow dependency argument). */
export interface IngestDeps extends ParseDeps {}

export const ingestEffects = (deps: IngestDeps): Record<string, Effect<IngestStartInput, StepResult>> => ({
  "ingest-parse": parseEffect(deps),
});
```

`pgDeps.ts` replaces the stub:

```ts
export interface PgIngestArgs {
  pool: Pool;
  fields: FieldCrypto;
  blobs: (identity: { tenantId: string; userId: string }) => { get(ref: { __loomContent: string }): Promise<Uint8Array | null> };
  wiring: IngestWiring;
}
export const pgIngestDeps = ({ pool, fields, blobs, wiring }: PgIngestArgs): IngestDeps => ({
  guard: new PgStepGuard(pool),
  source: new PgDocumentSource(pool, blobs),
  parsed: new PgParsedStore(pool, fields),
  registry: wiring.registry,
  runner: wiring.runner,
});
```

`config.ts`: `registerEffects` loops `for (const [id, effect] of Object.entries(ingestEffects(deps.ingest))) effects.register(id, effect)`. `security.ts`: `"ingest-document": ["ingest-parse"]`. `compose.ts`: build `blobs` once (it already is a closure for the routes), call `pgIngestDeps({ pool, fields: new FieldCrypto(keys), blobs, wiring: options.ingest })`.

- [ ] **Step 4: Run to verify it passes**

Run: `export DOCMIND_TEST_PG_URL=... && pnpm --filter @docmind/server exec vitest run`
Expected: PASS. The M2 acceptance test passes with the harness updates above. If Loom refuses to start because a stale in-memory app registered `ingest-begin`, search for the string and delete it; nothing outside the files above may mention `ingest-begin` afterwards (`grep -rn "ingest-begin\|documentExists" apps/ docs/superpowers/plans/2026-10-18-m3a*` must find only this plan).

- [ ] **Step 5: Close-out**

Branch `feat/ingest-flow-v2-parse`; subject `feat(server): ingest-document v2 with a real parse step, stub retired`. If the owner declines the waiver, the only split that keeps `main` green is to move the "what the flow may carry" describe block of `flow.test.ts` (about 30 lines, it asserts schema shapes only) into a PR before this one that tests the new `StepResult` and `IngestOutput` schemas in a new file, and to keep the rest together.

---

### Task 81: the event log holds ids, counts and codes only

Carry-forward 4, proven the way M2 did: a real Loom app on the durable (Postgres) storage, a raw read of the event store, and a structural assertion over every event. This PR adds no production code; it is the standing proof that Tasks 83, 91 and 92 extend.

**Files:**
- Create: `apps/server/app/flows/ingest-document/testing.ts` (`assertEventsAreContentFree`, shared with Task 95a)
- Create: `apps/server/app/flows/ingest-document/eventLog.pg.test.ts`

**Interfaces:**
- Consumes: `openDurableStorage` (`storage.ts`), `buildApp`, `pgIngestDeps`, `createIngestWiring`, `startPgFixture` (Task 64; `f.keys` is its `InMemoryKeyStore`), `EncryptedFsContentStore`, `setRolePassword`, `foldIngestStatus` (74b; it proves the status model's handlers and step ids against the kernel's real events).
- Produces: `assertEventsAreContentFree(events: { eventType: string; payload: any }[]): void` from `testing.ts`.

- [ ] **Step 1: Write the failing test**

`testing.ts`:

```ts
import { expect } from "vitest";

const ALLOWED_OUTPUT_KEYS = new Set(["outcome", "count", "model", "code"]);
const REF_KEYS = ["documentId", "tenantId", "userId"];

/** Every start input, step input and step output in the raw log is ids, an outcome, counts, a model id or a code. */
export function assertEventsAreContentFree(events: { eventType: string; payload: any }[]): void {
  const started = events.find((e) => e.eventType === "EXECUTION_STARTED");
  expect(Object.keys(started?.payload.input ?? {}).sort()).toEqual(REF_KEYS);
  for (const e of events.filter((e) => e.eventType === "STEP_STARTED")) {
    expect(Object.keys(e.payload.input).sort()).toEqual(REF_KEYS);
  }
  for (const e of events.filter((e) => e.eventType === "STEP_COMPLETED")) {
    const out = e.payload.output;
    expect(Object.keys(out).every((k) => ALLOWED_OUTPUT_KEYS.has(k))).toBe(true);
    expect(typeof out.outcome).toBe("string");
    if ("count" in out) expect(Number.isInteger(out.count)).toBe(true);
  }
}
```

`eventLog.pg.test.ts`:

```ts
const SENTENCE = "Nocturne quarterly revenue forecast: seventeen thousand dollars";

describe.skipIf(!PG_URL)("the ingest event log holds ids, counts and codes only (needs DOCMIND_TEST_PG_URL)", () => {
  let f: PgFixture;
  let durable: Awaited<ReturnType<typeof openDurableStorage>>;
  let app: ReturnType<typeof buildApp>;
  let root: string;
  const blobs = (id: { tenantId: string; userId: string }) =>
    new EncryptedFsContentStore({ root, tenantId: id.tenantId, userId: id.userId, keys: f.keys, maxBytes: 1 << 20 });

  beforeAll(async () => {
    f = await startPgFixture();
    await setRolePassword(f.db.owner, "docmind_loom", LOOM_PASSWORD);
    durable = await openDurableStorage({ loomUrl: f.db.loomUrl, keys: f.keys });
    root = mkdtempSync(join(tmpdir(), "dm-eventlog-"));
    app = buildApp(durable.storage, durable.crypto, {
      ingest: pgIngestDeps({ pool: f.app, fields: f.fields, blobs, wiring: createIngestWiring({}) }),
    });
  });
  afterAll(async () => {
    await app?.close();
    await durable?.close();
    await f?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** A txt document of ALICE whose text is `SENTENCE` repeated, with its blob stored, as an upload would leave it. */
  async function seedTxt(fingerprint: string) {
    const bytes = Buffer.from(Array.from({ length: 4 }, () => SENTENCE).join("\n\n"));
    const ref = await blobs({ tenantId: T1, userId: U1 }).put(bytes);
    const doc = await newDocument(f.fields, T1, U1, fingerprint, { contentAddress: ref.__loomContent, mime: "text/plain", sizeBytes: bytes.length });
    await withTenant(f.app, T1, (tx) => insertDocument(tx, doc));
    return { tenantId: T1, userId: U1, documentId: doc.id };
  }
  const run = async (ref: IngestStartInput) => {
    const executionId = ingestExecutionId(ref.userId, ref.documentId);
    const handle = await app.runtime.start(ingestDocumentFlow, ref, { executionId, principal: { tenant: ref.tenantId, actor: ref.userId } });
    await handle.waitForCompletion();
    return durable.raw.eventStore.read(executionId);
  };

  it("holds only ids, outcomes and counts for a txt ingest; the text is only in the sealed row", async () => {
    const ref = await seedTxt("a".repeat(64));
    const raw = await run(ref);
    assertEventsAreContentFree(raw);
    expect(raw.some((e) => e.eventType === "STEP_COMPLETED")).toBe(true);
    expect(raw.filter((e) => e.eventType === "STEP_STARTED").map((e) => e.payload.stepId)).toEqual(["ingest-parse"]); // the ids the status model reads
    expect(foldIngestStatus(raw)).toEqual({ status: "parsing", step: "parse", code: null }); // the model's handlers match the kernel's real events
    const sealed = (await f.db.owner.query("SELECT body_enc FROM parsed_documents WHERE document_id = $1", [ref.documentId])).rows[0].body_enc;
    expect(sealed.__loomEnc).toBe("loom/aes-256-gcm");
    expect((await new PgParsedStore(f.app, f.fields).take(ref))?.text).toContain(SENTENCE); // opens for its owner
    expect(JSON.stringify(raw)).not.toContain(SENTENCE.slice(0, 30)); // meaningful: raw events are plain JSON, so a leak would show
  });

  it("the check itself fails for an event that carries text (positive control)", () => {
    expect(() =>
      assertEventsAreContentFree([
        { eventType: "EXECUTION_STARTED", payload: { input: { tenantId: "t", userId: "u", documentId: "d" } } },
        { eventType: "STEP_COMPLETED", payload: { output: { outcome: "done", text: SENTENCE } } },
      ]),
    ).toThrow(/expected false to be true/);
  });

  it("a permanent failure leaves a code in the log, not a message", async () => {
    const ref = await seedTxt("b".repeat(64));
    await f.db.owner.query("UPDATE documents SET mime = 'application/x-nothing' WHERE id = $1", [ref.documentId]);
    const raw = await run(ref);
    assertEventsAreContentFree(raw);
    const outputs = raw.filter((e) => e.eventType === "STEP_COMPLETED").map((e) => (e.payload as { output: unknown }).output);
    expect(outputs).toEqual([{ outcome: "failed", code: "unsupported_content" }]);
    expect(foldIngestStatus(raw)).toEqual({ status: "failed", step: "parse", code: "unsupported_content" });
  });
});
```

(Imports: `mkdtempSync`, `rmSync`, `tmpdir`, `join`, `describe/it/expect/beforeAll/afterAll`, `buildApp`, `openDurableStorage`, `EncryptedFsContentStore`, `PG_URL`, `LOOM_PASSWORD`, `setRolePassword`, `withTenant`, `insertDocument`, `newDocument`, `T1`, `U1`, `createIngestWiring`, `pgIngestDeps`, `PgParsedStore`, `foldIngestStatus`, `ingestDocumentFlow`, `IngestStartInput`, `ingestExecutionId`, `startPgFixture`, `PgFixture`, `assertEventsAreContentFree`.)

- [ ] **Step 2: Run to verify it fails**

Run: `export DOCMIND_TEST_PG_URL=... && pnpm --filter @docmind/server exec vitest run app/flows/ingest-document/eventLog.pg.test.ts`
Expected: FAIL only if Task 80's flow leaks (it should not); a first run that passes is the expected outcome for a proof-only task. To see the proof bite, temporarily make `parseEffect` return `{ count: 1, model: parsed.text }`, confirm the first test fails, then revert.

- [ ] **Step 3: Implement**

Nothing in production code. If the proof fails, fix the leak in `stepEffect`/`parse.ts`, not the test.

- [ ] **Step 4: Run to verify it passes**

Run: `export DOCMIND_TEST_PG_URL=... && pnpm --filter @docmind/server exec vitest run app/flows/ingest-document/eventLog.pg.test.ts`
Expected: PASS.

- [ ] **Step 5: Close-out**

Branch `test/ingest-event-log-content-free`; subject `test(server): the ingest event log holds ids, counts and outcomes only`.

---

## Part E: chunk step, embeddings and vectors (Tasks 82-91)

### Task 82: `PgChunkStore`

The chunk table's only writer and reader. `replace` is idempotent for one document: it deletes the document's chunks and inserts the new set under deterministic ids, in one transaction, after taking a `FOR KEY SHARE` lock on the document row so a concurrent delete either waits (and then cascades our rows away) or has already run (and we report `DocumentGoneError`).

**Files:**
- Create: `apps/server/app/flows/ingest-document/pgChunks.ts`
- Create: `apps/server/app/flows/ingest-document/pgChunks.pg.test.ts`

**Interfaces:**
- Consumes: `Chunk`, `chunkIdFor` (71), `FieldCrypto`, `withTenant`, `DocumentGoneError`.
- Produces: `chunkBind(chunkId: string): string` = `` `chunk:${id}:text` ``; `interface ChunkStore { replace(ref: IngestStartInput, chunks: Chunk[]): Promise<number>; count(ref): Promise<number>; read(ref, ids: string[]): Promise<{ id: string; text: string }[]> }` (`read` returns opened texts in ordinal order for the ids that exist; `count` and `read` throw `DocumentGoneError` when the document is gone); `class PgChunkStore implements ChunkStore { constructor(pool: Pool, fields: FieldCrypto) }`.

- [ ] **Step 1: Write the failing test**

`pgChunks.pg.test.ts` (a `describe.skipIf(!PG_URL)` block with `let f: PgFixture`, `beforeAll(async () => { f = await startPgFixture(); })` and `afterAll(async () => { await f?.close(); })`, exactly as in Task 75b's test; below, `doc` is `f.doc`, `app` is `f.app`, `fields` is `f.fields` and `db` is `f.db`; the imports are `randomUUID`, `ParsedDocument`, `U1B`, `DocumentGoneError`, `chunkDocument`, `chunkIdFor`, `PgChunkStore`, `chunkBind`):

```ts
const sample = (n: number): ParsedDocument => {
  const text = Array.from({ length: n }, (_, i) => `Paragraph ${i} ${"lorem ipsum ".repeat(60)}`).join("\n\n");
  return { text, sections: [{ headingPath: ["Intro", "Part"], text, locator: { kind: "chars", start: 0, end: text.length } }], media: [] };
};

it("stores sealed chunks under deterministic ids, with numeric locators and plaintext counts", async () => {
  const ref = await doc("7".repeat(64));
  const chunks = chunkDocument(sample(8));
  const store = new PgChunkStore(app, fields);
  expect(await store.replace(ref, chunks)).toBe(chunks.length);
  const rows = (await db.owner.query("SELECT id, ordinal, section_ordinal, text_enc, locator, token_count FROM chunks WHERE document_id = $1 ORDER BY ordinal", [ref.documentId])).rows;
  expect(rows.map((r) => r.id)).toEqual(chunks.map((c) => chunkIdFor(ref.documentId, c.ordinal)));
  expect(rows[0].text_enc.__loomEnc).toBe("loom/aes-256-gcm");
  expect(rows[0].locator).toEqual(chunks[0]?.locator);
  expect(JSON.stringify(rows[0].locator)).not.toContain("Intro"); // the heading path is sealed with the text
  expect(rows[0].token_count).toBe(chunks[0]?.tokenCount);
  const opened = await fields.forUser(ref.userId).open(chunkBind(rows[0].id), rows[0].text_enc);
  expect(opened).toEqual({ text: chunks[0]?.text, headingPath: ["Intro", "Part"] });
});

it("is idempotent: replacing again leaves the same ids and count; a shorter set removes the rest", async () => {
  const ref = await doc("8".repeat(64));
  const store = new PgChunkStore(app, fields);
  const long = chunkDocument(sample(8));
  await store.replace(ref, long);
  await store.replace(ref, long);
  expect(await store.count(ref)).toBe(long.length);
  await store.replace(ref, long.slice(0, 1));
  expect(await store.count(ref)).toBe(1);
  await store.replace(ref, []);
  expect(await store.count(ref)).toBe(0);
});

it("reads opened texts for the ids asked, in ordinal order, ignoring ids that do not exist", async () => {
  const ref = await doc("9".repeat(64));
  const store = new PgChunkStore(app, fields);
  const chunks = chunkDocument(sample(8));
  await store.replace(ref, chunks);
  const ids = [chunkIdFor(ref.documentId, 2), chunkIdFor(ref.documentId, 0), randomUUID()];
  const got = await store.read(ref, ids);
  expect(got.map((g) => g.id)).toEqual([chunkIdFor(ref.documentId, 0), chunkIdFor(ref.documentId, 2)]);
  expect(got[0]?.text).toBe(chunks[0]?.text);
});

it.each(["replace", "count", "read"] as const)("%s throws DocumentGoneError once the document is deleted, and for another owner", async (op) => {
  const ref = await doc(randomUUID().replaceAll("-", "").repeat(2));
  const store = new PgChunkStore(app, fields);
  const call = (r: typeof ref) => (op === "replace" ? store.replace(r, []) : op === "count" ? store.count(r) : store.read(r, []));
  await expect(call({ ...ref, userId: U1B })).rejects.toBeInstanceOf(DocumentGoneError);
  await db.owner.query("DELETE FROM documents WHERE id = $1", [ref.documentId]);
  await expect(call(ref)).rejects.toBeInstanceOf(DocumentGoneError);
});

it("a delete that lands after the lock takes the chunks with it (cascade), and a late replace is gone", async () => {
  const ref = await doc(randomUUID().replaceAll("-", "").repeat(2));
  const store = new PgChunkStore(app, fields);
  await store.replace(ref, chunkDocument(sample(3)));
  await db.owner.query("DELETE FROM documents WHERE id = $1", [ref.documentId]);
  expect((await db.owner.query("SELECT 1 FROM chunks WHERE document_id = $1", [ref.documentId])).rowCount).toBe(0);
  await expect(store.replace(ref, chunkDocument(sample(3)))).rejects.toBeInstanceOf(DocumentGoneError);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `export DOCMIND_TEST_PG_URL=... && pnpm --filter @docmind/server exec vitest run app/flows/ingest-document/pgChunks.pg.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
import type { Pool, PoolClient } from "pg";
import type { FieldCrypto } from "../../crypto/fields";
import { withTenant } from "../../db/tenant";
import { type Chunk, chunkIdFor } from "./chunker";
import { DocumentGoneError } from "./errors";
import type { IngestStartInput } from "./flow";

export const chunkBind = (chunkId: string) => `chunk:${chunkId}:text`;

export interface ChunkStore {
  replace(ref: IngestStartInput, chunks: Chunk[]): Promise<number>;
  count(ref: IngestStartInput): Promise<number>;
  read(ref: IngestStartInput, ids: string[]): Promise<{ id: string; text: string }[]>;
}

/** The lock also keeps a concurrent DELETE of the document from interleaving: it waits, then cascades. */
async function lockDocument(tx: PoolClient, ref: IngestStartInput): Promise<void> {
  const { rowCount } = await tx.query(
    "SELECT 1 FROM documents WHERE id = $1 AND owner_id = $2 FOR KEY SHARE",
    [ref.documentId, ref.userId],
  );
  if (!rowCount) throw new DocumentGoneError();
}

export class PgChunkStore implements ChunkStore {
  constructor(private readonly pool: Pool, private readonly fields: FieldCrypto) {}

  async replace(ref: IngestStartInput, chunks: Chunk[]): Promise<number> {
    const cipher = this.fields.forUser(ref.userId);
    const ids = chunks.map((c) => chunkIdFor(ref.documentId, c.ordinal));
    const sealed = await Promise.all(
      chunks.map((c, i) => cipher.seal(chunkBind(ids[i] as string), { text: c.text, headingPath: c.headingPath })),
    );
    await withTenant(this.pool, ref.tenantId, async (tx) => {
      await lockDocument(tx, ref);
      await tx.query("DELETE FROM chunks WHERE document_id = $1", [ref.documentId]);
      if (chunks.length === 0) return;
      await tx.query(
        `INSERT INTO chunks (id, tenant_id, document_id, ordinal, section_ordinal, text_enc, locator, token_count)
         SELECT u.id, $1, $2, u.ordinal, u.section, u.text_enc::jsonb, u.locator::jsonb, u.tokens
           FROM unnest($3::uuid[], $4::int[], $5::int[], $6::text[], $7::text[], $8::int[])
             AS u(id, ordinal, section, text_enc, locator, tokens)`,
        [
          ref.tenantId,
          ref.documentId,
          ids,
          chunks.map((c) => c.ordinal),
          chunks.map((c) => c.sectionOrdinal),
          sealed.map((s) => JSON.stringify(s)),
          chunks.map((c) => JSON.stringify(c.locator)),
          chunks.map((c) => c.tokenCount),
        ],
      );
    });
    return chunks.length;
  }

  count(ref: IngestStartInput): Promise<number> {
    return withTenant(this.pool, ref.tenantId, async (tx) => {
      await lockDocument(tx, ref);
      const { rows } = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM chunks WHERE document_id = $1", [ref.documentId]);
      return rows[0]?.n ?? 0;
    });
  }

  async read(ref: IngestStartInput, ids: string[]): Promise<{ id: string; text: string }[]> {
    const rows = await withTenant(this.pool, ref.tenantId, async (tx) => {
      await lockDocument(tx, ref);
      const res = await tx.query<{ id: string; text_enc: unknown }>(
        "SELECT id, text_enc FROM chunks WHERE document_id = $1 AND id = ANY($2::uuid[]) ORDER BY ordinal",
        [ref.documentId, ids],
      );
      return res.rows;
    });
    const cipher = this.fields.forUser(ref.userId);
    return Promise.all(
      rows.map(async (r) => ({ id: r.id, text: ((await cipher.open(chunkBind(r.id), r.text_enc)) as { text: string }).text })),
    );
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `export DOCMIND_TEST_PG_URL=... && pnpm --filter @docmind/server exec vitest run app/flows/ingest-document/pgChunks.pg.test.ts`
Expected: PASS.

- [ ] **Step 5: Close-out**

Branch `feat/ingest-pg-chunks`; subject `feat(server): PgChunkStore with sealed text and idempotent replace`. Seam if over: `read` and its test after `replace`/`count`.

---

### Task 83: the `chunk` step

Spec §9 item 21, second half. Reads the sealed parsed document, chunks it, stores the chunks, drops the parsed row. At-least-once safe in both crash windows (see the comments in the code), and the flow gains its second step.

**Files:**
- Create: `apps/server/app/flows/ingest-document/steps/chunk.ts`
- Create: `apps/server/app/flows/ingest-document/steps/chunk.test.ts`
- Create: `apps/server/app/flows/ingest-document/steps/chunk.pg.test.ts`
- Modify: `apps/server/app/flows/ingest-document/flow.ts` (`ingestChunkStep`, appended to `INGEST_STEPS`)
- Modify: `apps/server/app/flows/ingest-document/deps.ts` (`IngestDeps extends ParseDeps, ChunkDeps`; effect map)
- Modify: `apps/server/app/flows/ingest-document/pgDeps.ts` (`chunks: new PgChunkStore(pool, fields)`)
- Modify: `apps/server/app/security.ts` (grant `ingest-chunk`)
- Modify: `apps/server/app/flows/ingest-document/flow.test.ts` (fake deps gain `chunks`; expectation `begin:parse, begin:chunk`)
- Modify: `apps/server/app/flows/ingest-document/eventLog.pg.test.ts` (nothing new is allowed in outputs; add the chunk count assertion; the folded status of the log becomes `{ status: "parsing", step: "chunk", code: null }`)

**Interfaces:**
- Consumes: `chunkDocument` (71-72), `ParsedStore`, `ChunkStore` (75, 82), `stepEffect`.
- Produces: `interface ChunkDeps { guard: StepGuard; parsed: ParsedStore; chunks: ChunkStore }`, `chunkEffect(deps: ChunkDeps): Effect<IngestStartInput, StepResult>`, `ingestChunkStep` (`id: "ingest-chunk"`).

- [ ] **Step 1: Write the failing test**

`chunk.test.ts` (fake ports, plus one pg-backed case in `eventLog.pg.test.ts`):

```ts
const parsed = { text: "Hello world.", sections: [{ headingPath: ["H"], text: "Hello world.", locator: { kind: "chars", start: 0, end: 12 } }], media: [] } as const;
function deps(over: Partial<ChunkDeps> = {}) {
  const calls: string[] = [];
  const d: ChunkDeps = {
    guard: { begin: async (_r, s) => void calls.push(`begin:${s}`) },
    parsed: { put: async () => {}, take: async () => { calls.push("take"); return parsed as never; }, drop: async () => void calls.push("drop") },
    chunks: { replace: async (_r, c) => { calls.push(`replace:${c.length}`); return c.length; }, count: async () => { calls.push("count"); return 7; }, read: async () => [] },
    ...over,
  };
  return { d, calls };
}
const run = (d: ChunkDeps) => chunkEffect(d).execute(ref(), {} as never);

it("chunks the parsed document, stores the chunks, then drops the parsed row, in that order", async () => {
  const { d, calls } = deps();
  expect(await run(d)).toEqual({ outcome: "done", count: 1 });
  expect(calls).toEqual(["begin:chunk", "take", "replace:1", "drop"]);
});

it("after a crash between the store and the event, finds no parsed row and reports the chunks that exist", async () => {
  const { d, calls } = deps({ parsed: { put: async () => {}, take: async () => undefined, drop: async () => {} } });
  expect(await run(d)).toEqual({ outcome: "done", count: 7 });
  expect(calls).toEqual(["begin:chunk", "count"]);
});

it("after a crash between replace and drop, stores the same chunks again and drops", async () => {
  const { d, calls } = deps();
  await run(d);
  await run(d);
  expect(calls.filter((c) => c === "replace:1")).toHaveLength(2);
});

it("an empty document yields zero chunks and still drops the parsed row", async () => {
  const empty = { text: "", sections: [], media: [] };
  const { d, calls } = deps({ parsed: { put: async () => {}, take: async () => empty as never, drop: async () => void 0 } });
  expect(await run(d)).toEqual({ outcome: "done", count: 0 });
  expect(calls).toContain("replace:0");
});

it.each([
  ["the parsed read", { parsed: { put: async () => {}, take: async () => { throw new DocumentGoneError(); }, drop: async () => {} } }],
  ["the chunk write", { chunks: { replace: async () => { throw Object.assign(new Error("fk"), { code: "23503" }); }, count: async () => 0, read: async () => [] } }],
  ["the parsed drop", { parsed: { put: async () => {}, take: async () => parsed as never, drop: async () => { throw new DocumentGoneError(); } } }],
])("stops as document_gone when the document vanishes at %s", async (_n, over) => {
  expect(await run(deps(over as Partial<ChunkDeps>).d)).toEqual({ outcome: "document_gone" });
});
```

`chunk.pg.test.ts` holds the delete race against the real Postgres ports (no Loom; `startPgFixture` as in Task 82, with `doc` = `f.doc`, `app` = `f.app`, `fields` = `f.fields`, `db` = `f.db`, and `parsed` the one-section document from `chunk.test.ts`): the parsed store is wrapped so that `take` returns and then waits at a gate, the test deletes the document, opens the gate, and the effect must stop cleanly:

```ts
it("a document deleted between reading the parsed text and storing the chunks stops the step as document_gone", async () => {
  const ref = await doc("c".repeat(64));
  const real = new PgParsedStore(app, fields);
  await real.put(ref, parsed);
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => (open = resolve));
  let taken: () => void = () => {};
  const tookIt = new Promise<void>((resolve) => (taken = resolve));
  const gated: ParsedStore = {
    put: (r, p) => real.put(r, p),
    take: async (r) => {
      const out = await real.take(r);
      taken();
      await gate;
      return out;
    },
    drop: (r) => real.drop(r),
  };
  const pending = chunkEffect({ guard: new PgStepGuard(app), parsed: gated, chunks: new PgChunkStore(app, fields) }).execute(ref, {} as never);
  await tookIt;
  await db.owner.query("DELETE FROM documents WHERE id = $1", [ref.documentId]);
  open();
  expect(await pending).toEqual({ outcome: "document_gone" });
  expect((await db.owner.query("SELECT 1 FROM chunks WHERE document_id = $1", [ref.documentId])).rowCount).toBe(0);
});
```

Extend `eventLog.pg.test.ts`'s first case: after completion the flow has run `ingest-parse` then `ingest-chunk`; `chunks` for the document number `>= 1`, `parsed_documents` has no row for it, and `assertEventsAreContentFree` still passes.

- [ ] **Step 2: Run to verify it fails**

Run: `export DOCMIND_TEST_PG_URL=... && pnpm --filter @docmind/server exec vitest run app/flows/ingest-document`
Expected: FAIL (`./chunk` not found; the flow has no chunk step).

- [ ] **Step 3: Implement**

```ts
import type { Effect } from "@loom/effect-runtime";
import { chunkDocument } from "../chunker";
import type { IngestStartInput } from "../flow";
import type { ParsedStore } from "../pgParsed";
import type { ChunkStore } from "../pgChunks";
import { type StepGuard, type StepResult, stepEffect } from "../stepEffect";

export interface ChunkDeps {
  guard: StepGuard;
  parsed: ParsedStore;
  chunks: ChunkStore;
}

export function chunkEffect(deps: ChunkDeps): Effect<IngestStartInput, StepResult> {
  return stepEffect("chunk", deps.guard, async (ref) => {
    const parsed = await deps.parsed.take(ref);
    // No parsed row for a document that exists: an earlier run stored the chunks and dropped it, and
    // crashed before its STEP_COMPLETED was appended. The chunks are the result.
    if (!parsed) return { count: await deps.chunks.count(ref) };
    const count = await deps.chunks.replace(ref, chunkDocument(parsed)); // deterministic ids: a re-run overwrites
    await deps.parsed.drop(ref); // after the chunks exist, never before
    return { count };
  });
}
```

`flow.ts`: `export const ingestChunkStep = stepOf("ingest-chunk", "IngestChunk"); export const INGEST_STEPS = [ingestParseStep, ingestChunkStep];`. `deps.ts`: `export interface IngestDeps extends ParseDeps, ChunkDeps {}` with `"ingest-chunk": chunkEffect(deps)` in the map. `security.ts`: `["ingest-parse", "ingest-chunk"]`. `pgDeps.ts`: `chunks: new PgChunkStore(pool, fields)`. In `flow.test.ts`'s `fakeDeps`, add `chunks` and a `parsed.take` that returns a document; the first test now expects `["begin:parse", "begin:chunk"]`.

- [ ] **Step 4: Run to verify it passes**

Run: `export DOCMIND_TEST_PG_URL=... && pnpm --filter @docmind/server exec vitest run`
Expected: PASS (whole server suite; the harness-based tests now end `parsing` after the chunk step).

- [ ] **Step 5: Close-out**

Branch `feat/ingest-chunk-step`; subject `feat(server): chunk step stores sealed chunks and drops the parsed row`. Seam if over: the pg-backed `eventLog` extension to its own PR.

---

### Task 84: `0014` embedding column, and migrations that need an extension

Spec §4.2: `chunks.embedding vector(N)` with an HNSW cosine index, `N` fixed per deployment by migration. **N = 768** (`nomic-embed-text`; Open question 2). Finding F8: the local test database has no pgvector, so the runner learns to recognise `-- requires-extension: <name>`. In production, a missing extension is a hard error. In tests only, `DOCMIND_MIGRATE_SKIP_MISSING_EXTENSIONS=true` skips such a migration without recording it, so it applies later when the extension appears. A migration that declares a requirement may be followed by ones that do not depend on it.

**Files:**
- Create: `infra/migrations/0014_chunk_embeddings.sql`
- Modify: `apps/server/app/db/migrate.ts`
- Modify: `apps/server/app/db/migrate.test.ts`
- Modify: `apps/server/app/db/testSupport.ts` (`hasVector`)
- Modify: `apps/server/vitest.config.ts` (`test.env`)
- Create: `apps/server/app/db/embeddings.pg.test.ts`

**Interfaces:**
- Consumes: `migrate(pool, dir)` (M0).
- Produces: `hasVector(owner: Pool): Promise<boolean>` (is the extension installed in this database); `migrate` honours the header and env switch; `chunks.embedding vector(768)`, `chunks.embedding_model text`, constraint `chunks_embedding_pair` (both null or both set), index `chunks_embedding_hnsw` (`vector_cosine_ops`) exist exactly when the extension does.

- [ ] **Step 1: Write the failing tests**

Add to `migrate.test.ts` (it already creates temp migration directories and a test database):

```ts
  describe("requires-extension", () => {
    const dirWith = (files: Record<string, string>) => {
      const dir = mkdtempSync(join(tmpdir(), "dm-mig-"));
      for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
      return dir;
    };
    const FILES = {
      "0001_a.sql": "CREATE TABLE a (x int);",
      "0002_needs.sql": "-- requires-extension: docmind_no_such_extension\nCREATE TABLE needs (x int);",
      "0003_c.sql": "CREATE TABLE c (x int);",
    };

    it("refuses to run a migration whose extension the server does not offer, naming file and extension", async () => {
      await expect(migrate(owner, dirWith(FILES))).rejects.toThrow(
        /^migration 0002_needs\.sql needs the docmind_no_such_extension extension, which this server does not offer$/,
      );
      expect((await owner.query("SELECT name FROM schema_migrations ORDER BY name")).rows.map((r) => r.name)).toEqual(["0001_a.sql"]);
    });

    it("with the test switch, skips it unrecorded and still applies the files after it", async () => {
      process.env.DOCMIND_MIGRATE_SKIP_MISSING_EXTENSIONS = "true";
      try {
        expect(await migrate(owner, dirWith(FILES))).toEqual(["0001_a.sql", "0003_c.sql"]);
      } finally {
        delete process.env.DOCMIND_MIGRATE_SKIP_MISSING_EXTENSIONS;
      }
      expect((await owner.query("SELECT to_regclass('needs') AS t")).rows[0].t).toBeNull();
    });

    it("applies it when the extension is available (plpgsql always is)", async () => {
      const dir = dirWith({ "0001_p.sql": "-- requires-extension: plpgsql\nCREATE TABLE p (x int);" });
      expect(await migrate(owner, dir)).toEqual(["0001_p.sql"]);
    });
  });
```

(Each case needs a fresh database; the existing file already provides `createTestDb()` per `it` or `beforeEach`; follow it.)

`embeddings.pg.test.ts`:

```ts
it("has the embedding column, pair constraint and HNSW index exactly when the extension is installed", async () => {
  const have = await hasVector(db.owner);
  const col = await db.owner.query("SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = 'chunks'::regclass AND attname = 'embedding'");
  const idx = await db.owner.query("SELECT 1 FROM pg_indexes WHERE tablename = 'chunks' AND indexname = 'chunks_embedding_hnsw'");
  expect(col.rows.map((r) => r.t)).toEqual(have ? ["vector(768)"] : []);
  expect(idx.rowCount).toBe(have ? 1 : 0);
});

it("requires a model whenever there is a vector (needs pgvector)", async (ctx) => {
  if (!(await hasVector(db.owner))) ctx.skip();
  await expect(insertChunkWithVector(db.owner, { embeddingModel: null })).rejects.toMatchObject({ code: "23514", constraint: "chunks_embedding_pair" });
  await expect(insertChunkWithVector(db.owner, { embeddingModel: "m", dims: 3 })).rejects.toMatchObject({ code: "22000" });
  await expect(insertChunkWithVector(db.owner, { embeddingModel: "m" })).resolves.toBeUndefined();
});
```

```ts
// A document and one chunk carrying `dims` numbers as its embedding; the owner role bypasses RLS.
async function insertChunkWithVector(owner: Pool, o: { embeddingModel: string | null; dims?: number }) {
  const doc = randomUUID();
  await owner.query(`INSERT INTO tenants (id, name) VALUES ($1, 'x') ON CONFLICT DO NOTHING`, [T1]);
  await owner.query(`INSERT INTO users (id, tenant_id, email, password_hash) VALUES ($1, $2, $3, 'x') ON CONFLICT DO NOTHING`, [U1, T1, "u@example.com"]);
  await owner.query(
    `INSERT INTO documents (id, tenant_id, owner_id, title_enc, filename_enc, mime, size_bytes, content_address, fingerprint)
     VALUES ($1, $2, $3, '{}', '{}', 'text/plain', 1, $4, $5)`,
    [doc, T1, U1, `hmac-sha256:${doc.replaceAll("-", "").repeat(2)}`, doc.replaceAll("-", "").repeat(2)],
  );
  const vector = `[${Array.from({ length: o.dims ?? 768 }, () => "0.5").join(",")}]`;
  await owner.query(
    `INSERT INTO chunks (id, tenant_id, document_id, ordinal, section_ordinal, text_enc, locator, token_count, embedding, embedding_model)
     VALUES ($1, $2, $3, 0, 0, '{}', '{"kind":"section","index":0}', 1, $4::vector, $5)`,
    [randomUUID(), T1, doc, vector, o.embeddingModel],
  );
}
```

pgvector reports a wrong-size vector as `22000` ("expected 768 dimensions, not 3"); confirm on the first run against pgvector and pin what it reports. (`T1`, `U1` are the harness constants; import them from `../documents/testHarness`.)

- [ ] **Step 2: Run to verify they fail**

Run: `export DOCMIND_TEST_PG_URL=... && pnpm --filter @docmind/server exec vitest run app/db/migrate.test.ts app/db/embeddings.pg.test.ts`
Expected: FAIL (`hasVector` missing; the runner applies `0002_needs.sql` and fails with Postgres' own error).

- [ ] **Step 3: Implement**

`infra/migrations/0014_chunk_embeddings.sql`:

```sql
-- requires-extension: vector
-- The embedding is stored in the clear on purpose (spec 4.4): pgvector must compare raw vectors. It
-- is hard-deleted with its row on erasure and survives only in backups, for their retention window.
-- 768 is nomic-embed-text's dimension; changing the model's size is a new migration plus a re-embed.
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE chunks
  ADD COLUMN embedding vector(768),
  ADD COLUMN embedding_model text,
  ADD CONSTRAINT chunks_embedding_pair CHECK ((embedding IS NULL) = (embedding_model IS NULL));

CREATE INDEX chunks_embedding_hnsw ON chunks USING hnsw (embedding vector_cosine_ops);
```

`migrate.ts` inside the loop, before `BEGIN`:

```ts
      const sql = readFileSync(join(dir, file), "utf8");
      const needs = /^-- requires-extension: ([a-z_]+)\s*$/m.exec(sql)?.[1];
      if (needs && !(await extensionAvailable(client, needs))) {
        if (process.env.DOCMIND_MIGRATE_SKIP_MISSING_EXTENSIONS === "true") continue; // tests only; not recorded, so it applies once the extension exists
        throw new Error(`migration ${file} needs the ${needs} extension, which this server does not offer`);
      }
```

with `const extensionAvailable = async (client: PoolClient, name: string) => ((await client.query("SELECT 1 FROM pg_available_extensions WHERE name = $1", [name])).rowCount ?? 0) > 0;` and `await client.query(sql)` using the already-read text. `testSupport.ts`: `export const hasVector = async (owner: Pool) => ((await owner.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'")).rowCount ?? 0) > 0;`. `vitest.config.ts`: `test: { ..., env: { DOCMIND_MIGRATE_SKIP_MISSING_EXTENSIONS: "true" } }`. Production never sets it (`main`'s `db:migrate` path), so a server without pgvector refuses to migrate.

- [ ] **Step 4: Run to verify they pass**

Run: `export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:55432/postgres && pnpm --filter @docmind/server exec vitest run app/db`
Expected: PASS on 55432 with the second `embeddings` test **skipped** (state it in the PR). Re-run once against a pgvector database (`docker compose up -d postgres`, `DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/postgres`) and confirm it runs and passes; if Docker is unavailable, say so in the PR and rely on CI.

- [ ] **Step 5: Close-out**

Branch `feat/db-embedding-column`; subject `feat(db): chunk embeddings column and extension-aware migrations`. Files: the six above.

---

### Task 85: `packages/embeddings`: `OllamaEmbeddingProvider`

Spec §9 item 22, first half. Implements Loom's `EmbeddingProvider` (Finding F3) over Ollama's `POST /api/embed`. It never logs or throws a URL, a body or a text; a failure is one of two classes so part 2's retry policy can tell them apart: `EmbeddingUnavailableError` (transient: network failure, timeout, 429, 5xx) and `EmbeddingError` from `@loom/memory` (permanent: 4xx other than 429, wrong shape or dimensions, non-finite values).

**Files:**
- Create: `packages/embeddings/package.json`
- Create: `packages/embeddings/tsconfig.json`
- Create: `packages/embeddings/tsconfig.test.json`
- Create: `packages/embeddings/vitest.config.ts`
- Create: `packages/embeddings/src/ollama.ts`
- Create: `packages/embeddings/src/ollama.test.ts`
- Create: `packages/embeddings/src/index.ts`
- Modify: `package.json` (root `pnpm.overrides`: `"@loom/memory": "link:../loom/packages/memory"`), `pnpm-lock.yaml` (not counted)

**Interfaces:**
- Consumes: `EmbeddingProvider`, `EmbedOptions`, `EmbeddingError` from `@loom/memory`.
- Produces: `interface OllamaOptions { baseUrl: string; model: string; dimensions: number; maxBatchSize?: number; timeoutMs?: number; fetch?: typeof fetch }`; `class OllamaEmbeddingProvider implements EmbeddingProvider` (`modelId` = `ollama/<model>`, `dimensions`, `maxBatchSize` default 64, `embed(texts, opts)`); `class EmbeddingUnavailableError extends EmbeddingError`.

- [ ] **Step 1: Write the failing test**

`ollama.test.ts` drives the provider with an injected `fetch` that returns `Response` objects (a real HTTP server arrives in Task 86):

```ts
import { EmbeddingError } from "@loom/memory";
import { describe, expect, it } from "vitest";
import { EmbeddingUnavailableError, OllamaEmbeddingProvider } from "./ollama";

const vec = (n: number, seed = 1) => Array.from({ length: n }, (_, i) => seed + i);
const ok = (embeddings: number[][]) => new Response(JSON.stringify({ embeddings }), { status: 200, headers: { "content-type": "application/json" } });
const provider = (fetch: typeof globalThis.fetch, over: Partial<ConstructorParameters<typeof OllamaEmbeddingProvider>[0]> = {}) =>
  new OllamaEmbeddingProvider({ baseUrl: "http://127.0.0.1:11434", model: "m", dimensions: 3, fetch, ...over });

describe("OllamaEmbeddingProvider", () => {
  it("posts the model and the batch to /api/embed and returns the vectors in order", async () => {
    const seen: { url: string; body: unknown }[] = [];
    const p = provider(async (url, init) => { seen.push({ url: String(url), body: JSON.parse(String(init?.body)) }); return ok([vec(3, 1), vec(3, 2)]); });
    expect(await p.embed(["a", "b"])).toEqual([vec(3, 1), vec(3, 2)]);
    expect(seen).toEqual([{ url: "http://127.0.0.1:11434/api/embed", body: { model: "m", input: ["a", "b"], truncate: true } }]);
    expect(p).toMatchObject({ modelId: "ollama/m", dimensions: 3, maxBatchSize: 64 });
  });

  it("returns nothing for nothing, without calling the server", async () => {
    expect(await provider(async () => { throw new Error("must not be called"); }).embed([])).toEqual([]);
  });

  it("splits a batch over maxBatchSize into sequential requests and keeps the order", async () => {
    const sizes: number[] = [];
    const p = provider(async (_u, init) => { const n = (JSON.parse(String(init?.body)).input as string[]).length; sizes.push(n); return ok(Array.from({ length: n }, () => vec(3))); }, { maxBatchSize: 2 });
    expect((await p.embed(["a", "b", "c", "d", "e"])).length).toBe(5);
    expect(sizes).toEqual([2, 2, 1]);
  });

  it.each([429, 500, 503])("treats HTTP %s as transient: EmbeddingUnavailableError", async (status) => {
    await expect(provider(async () => new Response("x", { status })).embed(["a"])).rejects.toBeInstanceOf(EmbeddingUnavailableError);
  });

  it("treats a network failure and a timeout as transient", async () => {
    await expect(provider(async () => { throw new TypeError("fetch failed"); }).embed(["a"])).rejects.toBeInstanceOf(EmbeddingUnavailableError);
    const never = (_u: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
    await expect(provider(never as typeof fetch, { timeoutMs: 1 }).embed(["a"])).rejects.toBeInstanceOf(EmbeddingUnavailableError);
  });

  it("treats 404 (model not pulled) and 400 as permanent, not transient", async () => {
    for (const status of [400, 404]) {
      const err = await provider(async () => new Response("model not found", { status })).embed(["a"]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EmbeddingError);
      expect(err).not.toBeInstanceOf(EmbeddingUnavailableError);
    }
  });

  it.each([
    ["a wrong count", [vec(3)]],
    ["a wrong dimension", [vec(2), vec(2)]],
    ["a non-number value (JSON has no NaN; a server may send null)", [vec(3), [1, null, 3]]],
  ])("rejects %s with a permanent EmbeddingError", async (_n, embeddings) => {
    const err = await provider(async () => ok(embeddings as number[][])).embed(["a", "b"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingError);
    expect(err).not.toBeInstanceOf(EmbeddingUnavailableError);
  });

  it("never puts the url, the text or the response body into an error message", async () => {
    const err = await provider(async () => new Response("secret body", { status: 500 }), { baseUrl: "http://user:pw@127.0.0.1:1" }).embed(["secret text"]).catch((e: Error) => e);
    expect((err as Error).message).toBe("the embedding service is unavailable");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm install && pnpm --filter @docmind/embeddings exec vitest run`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`package.json` copies `packages/parsers`'s shape (`@docmind/embeddings`, `main: dist/index.js`, scripts as in blob-store: `build`, `test: vitest run`, `typecheck`, `typecheck:tests`; dependencies `"@loom/memory": "*"`, `"zod": "^3.23.8"`; devDependencies node types, vitest; `tsconfig.json` excludes `src/testing`). `src/ollama.ts`:

```ts
import { type EmbedOptions, EmbeddingError, type EmbeddingProvider } from "@loom/memory";
import { z } from "zod";

/** Worth retrying: the service is down, slow or overloaded. Permanent problems are plain EmbeddingError. */
export class EmbeddingUnavailableError extends EmbeddingError {
  constructor() {
    super("the embedding service is unavailable");
    this.name = "EmbeddingUnavailableError";
  }
}

export interface OllamaOptions {
  baseUrl: string;
  model: string;
  dimensions: number;
  maxBatchSize?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const Response_ = z.object({ embeddings: z.array(z.array(z.number().finite())) });

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly modelId: string;
  readonly dimensions: number;
  readonly maxBatchSize: number;
  constructor(private readonly options: OllamaOptions) {
    this.modelId = `ollama/${options.model}`;
    this.dimensions = options.dimensions;
    this.maxBatchSize = options.maxBatchSize ?? 64;
  }

  async embed(texts: readonly string[], opts: EmbedOptions = {}): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.maxBatchSize) {
      out.push(...(await this.request(texts.slice(i, i + this.maxBatchSize), opts.signal)));
    }
    return out;
  }

  private async request(batch: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 30_000);
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(`${this.options.baseUrl.replace(/\/$/, "")}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: this.options.model, input: batch, truncate: true }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      throw new EmbeddingUnavailableError(); // connection refused, DNS, timeout, abort
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {}); // never leave the body open
      if (response.status === 429 || response.status >= 500) throw new EmbeddingUnavailableError();
      throw new EmbeddingError(`the embedding service refused the request (HTTP ${response.status})`);
    }
    let parsed: z.infer<typeof Response_>;
    try {
      parsed = Response_.parse(await response.json());
    } catch {
      throw new EmbeddingError("the embedding service answered with an unexpected shape");
    }
    if (parsed.embeddings.length !== batch.length || parsed.embeddings.some((v) => v.length !== this.dimensions)) {
      throw new EmbeddingError("the embedding service returned the wrong number or size of vectors");
    }
    return parsed.embeddings;
  }
}
```

`index.ts` re-exports. A caller's own abort (`opts.signal`) is also reported as `EmbeddingUnavailableError`, because from the caller's side the call did not complete; the embed step never aborts today.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @docmind/embeddings build && pnpm --filter @docmind/embeddings exec vitest run`
Expected: PASS.

- [ ] **Step 5: Close-out**

Branch `feat/embeddings-ollama`; subject `feat(embeddings): Ollama EmbeddingProvider with transient and permanent failures`. Seam if over: the three config files plus `index.ts` in a scaffold PR first.

---

### Task 86: provider conformance over a fake Ollama server, and the opt-in real suite

Spec §9 item 22, second half; "each interface has one shared conformance suite". Loom already ships `runEmbeddingProviderConformance`; it runs here against a fake HTTP server (a real `fetch` path, no Ollama needed) and, when `DOCMIND_TEST_OLLAMA_URL` is set, against a real one.

**Files:**
- Create: `packages/embeddings/src/testing/fakeOllama.ts`
- Create: `packages/embeddings/src/conformance.test.ts`
- Create: `packages/embeddings/src/http.test.ts`
- Modify: `packages/embeddings/package.json` (devDependency `@loom/conformance`)

**Interfaces:**
- Consumes: `OllamaEmbeddingProvider` (85); `runEmbeddingProviderConformance` from `@loom/conformance`; `HashingEmbeddingProvider` from `@loom/memory` (the fake server's embedding function).
- Produces: `startFakeOllama(options: { dimensions: number; model?: string }): Promise<{ url: string; close(): Promise<void>; batches: number[]; failNext(status: number): void; hold(): void; release(): void }>` (`batches` records each request's input count, never the texts). Server binds `127.0.0.1`, answers `POST /api/embed`, 404 for any other path or unknown model.

- [ ] **Step 1: Write the failing tests**

`conformance.test.ts`:

```ts
import { runEmbeddingProviderConformance } from "@loom/conformance";
import { afterAll, beforeAll, describe } from "vitest";
import { OllamaEmbeddingProvider } from "./ollama";
import { type FakeOllama, startFakeOllama } from "./testing/fakeOllama";

let fake: FakeOllama;
beforeAll(async () => { fake = await startFakeOllama({ dimensions: 64 }); });
afterAll(async () => { await fake?.close(); });

runEmbeddingProviderConformance(
  () => new OllamaEmbeddingProvider({ baseUrl: fake.url, model: "fake-embed", dimensions: 64 }),
  "OllamaEmbeddingProvider over the fake server",
);

// The same kit against a real Ollama: opt in with DOCMIND_TEST_OLLAMA_URL (after `ollama pull nomic-embed-text`).
describe.skipIf(!process.env.DOCMIND_TEST_OLLAMA_URL)("real Ollama", () => {
  runEmbeddingProviderConformance(
    () => new OllamaEmbeddingProvider({
      baseUrl: process.env.DOCMIND_TEST_OLLAMA_URL as string,
      model: process.env.DOCMIND_TEST_OLLAMA_MODEL ?? "nomic-embed-text",
      dimensions: Number(process.env.DOCMIND_TEST_OLLAMA_DIMENSIONS ?? 768),
    }),
    "OllamaEmbeddingProvider over real Ollama",
  );
});
```

`http.test.ts` (what only a real socket can show):

```ts
it("sends at most maxBatchSize texts per request", async () => {
  const p = new OllamaEmbeddingProvider({ baseUrl: fake.url, model: "fake-embed", dimensions: 64, maxBatchSize: 64 });
  await p.embed(Array.from({ length: 150 }, (_, i) => `text ${i}`));
  expect(fake.batches.slice(-3)).toEqual([64, 64, 22]);
});
it("reports an unreachable server as transient, and an HTTP 503 too", async () => {
  const dead = await startFakeOllama({ dimensions: 64 });
  const url = dead.url;
  await dead.close();
  await expect(new OllamaEmbeddingProvider({ baseUrl: url, model: "m", dimensions: 64 }).embed(["a"])).rejects.toBeInstanceOf(EmbeddingUnavailableError);
  fake.failNext(503);
  await expect(good().embed(["a"])).rejects.toBeInstanceOf(EmbeddingUnavailableError);
  expect((await good().embed(["a"])).length).toBe(1); // and the next call is fine
});
it("treats an unknown model as a permanent error", async () => {
  const err = await new OllamaEmbeddingProvider({ baseUrl: fake.url, model: "not-pulled", dimensions: 64 }).embed(["a"]).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(EmbeddingError);
  expect(err).not.toBeInstanceOf(EmbeddingUnavailableError);
});
it("stops waiting when the caller aborts, without leaving the request open", async () => {
  const arrived = fake.hold();
  const controller = new AbortController();
  const pending = good().embed(["a"], { signal: controller.signal });
  await arrived; // the request is on the server, parked at the gate
  controller.abort();
  await expect(pending).rejects.toBeInstanceOf(EmbeddingUnavailableError);
  fake.release();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @docmind/embeddings exec vitest run`
Expected: FAIL (`./testing/fakeOllama` not found).

- [ ] **Step 3: Implement**

`fakeOllama.ts`:

```ts
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { HashingEmbeddingProvider } from "@loom/memory";

export interface FakeOllama {
  url: string;
  batches: number[];
  close(): Promise<void>;
  failNext(status: number): void;
  /** Holds the next request(s) at the gate; the promise resolves when one has arrived there. */
  hold(): Promise<void>;
  release(): void;
}

const MAX_BODY = 8 * 1024 * 1024;

export async function startFakeOllama(options: { dimensions: number; model?: string }): Promise<FakeOllama> {
  const model = options.model ?? "fake-embed";
  const embedder = new HashingEmbeddingProvider({ dimensions: options.dimensions });
  const batches: number[] = [];
  const failures: number[] = [];
  let gate: Promise<void> | null = null;
  let open: () => void = () => {};
  let arrive: () => void = () => {};
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/api/embed") {
      req.resume();
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on("end", async () => {
      const failure = failures.shift();
      if (failure) return void res.writeHead(failure).end();
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model: string; input: string[] };
      if (body.model !== model) return void res.writeHead(404).end();
      if (gate) {
        arrive();
        await gate;
      }
      batches.push(body.input.length);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ embeddings: await embedder.embed(body.input) }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    batches,
    failNext: (status) => void failures.push(status),
    hold() {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return new Promise<void>((resolve) => {
        arrive = resolve;
      });
    },
    release() {
      open();
      gate = null;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
```

No `exports` entry is needed for it: the server's `vitest.config.ts` aliases `@docmind/embeddings/testing` to `packages/embeddings/src/testing/fakeOllama.ts` (Task 91), as it already does for `@docmind/auth/testing`.

- [ ] **Step 4: Run to verify they pass**

Run: `pnpm --filter @docmind/embeddings build && pnpm --filter @docmind/embeddings exec vitest run`
Expected: PASS; the "real Ollama" block reports as skipped. If the Loom kit's "very long text" case exceeds the fake's body cap, raise the cap rather than skip the case.

- [ ] **Step 5: Close-out**

Branch `feat/embeddings-conformance`; subject `test(embeddings): Loom's EmbeddingProvider kit over a fake Ollama, opt-in real suite`.

---

### Task 87: `packages/vector-pg`: the `ChunkVectorStore` port and an in-memory twin

Spec §9 item 23, first part. Finding F4 explains why this is not Loom's `VectorIndex`. The port has exactly what ingestion and M4 retrieval need; `upsert` writes onto **existing** chunk rows (the chunk step created them), so "idempotent by chunkId" is an update of a known row; `missing` is the embed step's work list.

**Files:**
- Create: `packages/vector-pg/package.json`
- Create: `packages/vector-pg/tsconfig.json`
- Create: `packages/vector-pg/tsconfig.test.json`
- Create: `packages/vector-pg/vitest.config.ts`
- Create: `packages/vector-pg/src/types.ts`
- Create: `packages/vector-pg/src/inMemory.ts`
- Create: `packages/vector-pg/src/inMemory.test.ts`
- Create: `packages/vector-pg/src/index.ts`
- Modify: `docs/specs/2026-10-18-docmind-design.md` (§3.1 `VectorIndex` row)

**Interfaces:**
- Produces (from `@docmind/vector-pg`):
  - `interface VectorScope { tenantId: string; ownerId: string }`.
  - `interface ChunkVectorStore { readonly modelId: string; readonly dimensions: number; upsert(scope: VectorScope, documentId: string, items: { chunkId: string; vector: readonly number[] }[]): Promise<{ written: number; missing: string[] }>; missing(scope: VectorScope, documentId: string, limit: number): Promise<string[]>; search(scope: VectorScope, query: readonly number[], limit: number, minScore?: number): Promise<{ chunkId: string; score: number }[]> }`.
  - `class VectorDimensionError extends Error` (fixed message `vector has the wrong size or a non-finite value`).
  - `class InMemoryChunkVectors implements ChunkVectorStore { constructor(options: { modelId: string; dimensions: number; chunkIds: (scope: VectorScope, documentId: string) => Promise<string[]>; shared?: Map<string, { vector: number[]; model: string }> }) }` where `chunkIds` lists the document's chunk ids in ordinal order (the stand-in for the `chunks` table), and `shared` lets two instances with different `modelId` see the same rows (to test re-embedding).

- [ ] **Step 1: Write the failing test**

`inMemory.test.ts` covers the twin's own behaviour briefly; the shared suite is Task 88:

```ts
const SCOPE = { tenantId: "t1", ownerId: "u1" };
const ids = ["c0", "c1", "c2"];
const twin = (over = {}) => new InMemoryChunkVectors({ modelId: "m", dimensions: 3, chunkIds: async () => ids, ...over });

it("lists the chunks without a vector in ordinal order, limited, and shrinks as vectors arrive", async () => {
  const s = twin();
  expect(await s.missing(SCOPE, "d", 2)).toEqual(["c0", "c1"]);
  expect(await s.upsert(SCOPE, "d", [{ chunkId: "c0", vector: [1, 0, 0] }])).toEqual({ written: 1, missing: [] });
  expect(await s.missing(SCOPE, "d", 10)).toEqual(["c1", "c2"]);
});
it("reports ids with no chunk row as missing and writes nothing for them", async () => {
  const s = twin();
  expect(await s.upsert(SCOPE, "d", [{ chunkId: "ghost", vector: [1, 0, 0] }, { chunkId: "c1", vector: [0, 1, 0] }])).toEqual({ written: 1, missing: ["ghost"] });
});
it("refuses a wrong-size or non-finite vector with VectorDimensionError", async () => {
  await expect(twin().upsert(SCOPE, "d", [{ chunkId: "c0", vector: [1, 0] }])).rejects.toBeInstanceOf(VectorDimensionError);
  await expect(twin().search(SCOPE, [Number.NaN, 0, 0], 1)).rejects.toBeInstanceOf(VectorDimensionError);
});
it("ranks by cosine similarity and applies the floor", async () => {
  const s = twin();
  await s.upsert(SCOPE, "d", [{ chunkId: "c0", vector: [1, 0, 0] }, { chunkId: "c1", vector: [0.9, 0.1, 0] }, { chunkId: "c2", vector: [0, 1, 0] }]);
  expect((await s.search(SCOPE, [1, 0, 0], 3)).map((h) => h.chunkId)).toEqual(["c0", "c1", "c2"]);
  expect((await s.search(SCOPE, [1, 0, 0], 3, 0.5)).map((h) => h.chunkId)).toEqual(["c0", "c1"]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm install && pnpm --filter @docmind/vector-pg exec vitest run`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`types.ts` carries the interfaces above. `inMemory.ts`: a `Map<chunkId, {vector, model}>`; `upsert` validates every vector first (`VectorDimensionError`), asks `chunkIds(scope, documentId)` for the set of existing chunks, writes the ones in the set with `model = this.modelId`, returns `{ written, missing: ids not in the set }`; `missing` returns `chunkIds(...)` filtered to those with no row or a row whose model differs from `modelId`, sliced to `limit`; `search` scans the rows whose model equals `modelId` and whose id is in the scope's chunk ids (the twin has only the per-document lister, so `search` takes the union over documents the twin has seen via `upsert`/`missing`; document that limitation in a comment: the twin's search is for tests of ranking, not for scope), ranks by cosine, applies `minScore`, slices to `limit`. Package config as in Task 85 (`dependencies` none; devDependencies node types, vitest, and `@types/pg` for Task 89). Spec §3.1: replace the `VectorIndex` row with `| \`ChunkVectorStore\` | packages/vector-pg | \`upsert\`, \`missing\`, \`search\` over the \`chunks\` rows (Loom's \`VectorIndex\` cannot add a vector for an id that has no row, and has no document scope) | pgvector |`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @docmind/vector-pg build && pnpm --filter @docmind/vector-pg exec vitest run`
Expected: PASS.

- [ ] **Step 5: Close-out**

Branch `feat/vector-store-port`; subject `feat(vector-pg): ChunkVectorStore port and in-memory twin`.

---

### Task 88: the shared `ChunkVectorStore` conformance suite

**Files:**
- Create: `packages/vector-pg/src/testing/conformance.ts`
- Create: `packages/vector-pg/src/testing/conformance.test.ts`

**Interfaces:**
- Consumes: `ChunkVectorStore`, `VectorScope`, `VectorDimensionError`, `InMemoryChunkVectors`.
- Produces: `interface VectorHarness { store: ChunkVectorStore; /** makes `ids` exist as the chunk rows of `documentId`, in ordinal order, for this scope */ seed(scope: VectorScope, documentId: string, ids: string[]): Promise<void>; /** a second store over the same rows with a different modelId */ withModel(modelId: string): ChunkVectorStore }`; `runChunkVectorStoreConformance(factory: () => Promise<VectorHarness>, label?: string): void`.

- [ ] **Step 1: Write the failing test**

`conformance.test.ts` runs the kit against the twin, with the twin's `chunkIds` backed by a `Map` that `seed` fills:

```ts
runChunkVectorStoreConformance(async () => {
  const registry = new Map<string, string[]>(); // `${tenant}|${owner}|${doc}` -> ids
  const shared = new Map();
  const make = (modelId: string) => new InMemoryChunkVectors({ modelId, dimensions: 4, shared, chunkIds: async (s, d) => registry.get(`${s.tenantId}|${s.ownerId}|${d}`) ?? [] });
  return { store: make("m1"), withModel: make, seed: async (s, d, ids) => void registry.set(`${s.tenantId}|${s.ownerId}|${d}`, ids) };
}, "InMemoryChunkVectors");
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @docmind/vector-pg exec vitest run src/testing`
Expected: FAIL (`./conformance` not found).

- [ ] **Step 3: Implement**

`testing/conformance.ts`:

```ts
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type ChunkVectorStore, VectorDimensionError, type VectorScope } from "../types";

export interface VectorHarness {
  store: ChunkVectorStore;
  /** Makes `ids` exist as the chunk rows of `documentId` (ordinals in array order) for this scope. */
  seed(scope: VectorScope, documentId: string, ids: string[]): Promise<void>;
  /** A second store over the same rows with another model id. */
  withModel(modelId: string): ChunkVectorStore;
}

// UUIDs, because the Postgres implementation's columns are uuid.
export const A: VectorScope = { tenantId: "11111111-1111-4111-8111-111111111111", ownerId: "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1" };
export const B: VectorScope = { tenantId: A.tenantId, ownerId: "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2" }; // same tenant, other user
export const C: VectorScope = { tenantId: "22222222-2222-4222-8222-222222222222", ownerId: "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3" }; // other tenant
export const DOC_A = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1";
export const DOC_B = "d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2";
export const DOC_C = "d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3";

const basis = (d: number, i: number, scale = 1): number[] => {
  const v = new Array<number>(d).fill(0);
  v[i % d] = scale;
  return v;
};
const uuids = (n: number) => Array.from({ length: n }, () => randomUUID());

export function runChunkVectorStoreConformance(
  factory: () => Promise<VectorHarness>,
  label = "ChunkVectorStore",
  options: { skip?: () => boolean | Promise<boolean> } = {},
): void {
  const test = (name: string, body: (h: VectorHarness) => Promise<void>) =>
    it(name, async (ctx) => {
      if (await options.skip?.()) ctx.skip();
      await body(await factory());
    });

  describe(`${label} conformance (ChunkVectorStore)`, () => {
    test("missing lists the chunks without a vector in ordinal order, honours the limit, and shrinks as vectors arrive", async ({ store, seed }) => {
      const ids = uuids(3);
      await seed(A, DOC_A, ids);
      const d = store.dimensions;
      expect(await store.missing(A, DOC_A, 2)).toEqual(ids.slice(0, 2));
      expect(await store.upsert(A, DOC_A, [{ chunkId: ids[0] as string, vector: basis(d, 0) }])).toEqual({ written: 1, missing: [] });
      expect(await store.missing(A, DOC_A, 10)).toEqual(ids.slice(1));
    });

    test("upsert is idempotent by chunk id: the second vector replaces the first", async ({ store, seed }) => {
      const [id] = uuids(1) as [string];
      await seed(A, DOC_A, [id]);
      const d = store.dimensions;
      await store.upsert(A, DOC_A, [{ chunkId: id, vector: basis(d, 0) }]);
      expect(await store.upsert(A, DOC_A, [{ chunkId: id, vector: basis(d, 1) }])).toEqual({ written: 1, missing: [] });
      expect((await store.search(A, basis(d, 1), 10, 0.9)).map((h) => h.chunkId)).toEqual([id]);
      expect(await store.search(A, basis(d, 0), 10, 0.9)).toEqual([]);
    });

    test("upsert reports an id with no chunk row as missing and still writes the rest", async ({ store, seed }) => {
      const [real] = uuids(1) as [string];
      const ghost = randomUUID();
      await seed(A, DOC_A, [real]);
      const d = store.dimensions;
      expect(await store.upsert(A, DOC_A, [{ chunkId: ghost, vector: basis(d, 0) }, { chunkId: real, vector: basis(d, 1) }])).toEqual({ written: 1, missing: [ghost] });
    });

    test("a wrong-size or non-finite vector rejects with VectorDimensionError and writes none of the batch", async ({ store, seed }) => {
      const ids = uuids(2);
      await seed(A, DOC_A, ids);
      const d = store.dimensions;
      await expect(store.upsert(A, DOC_A, [{ chunkId: ids[0] as string, vector: basis(d, 0) }, { chunkId: ids[1] as string, vector: new Array(d + 1).fill(1) }])).rejects.toBeInstanceOf(VectorDimensionError);
      await expect(store.upsert(A, DOC_A, [{ chunkId: ids[0] as string, vector: basis(d, 0).map(() => Number.NaN) }])).rejects.toBeInstanceOf(VectorDimensionError);
      await expect(store.search(A, new Array(d - 1).fill(1), 5)).rejects.toBeInstanceOf(VectorDimensionError);
      expect(await store.missing(A, DOC_A, 10)).toEqual(ids);
    });

    test("search ranks by cosine similarity, best first, applies the floor, and limit 0 is empty", async ({ store, seed }) => {
      const [x, near, y] = uuids(3) as [string, string, string];
      await seed(A, DOC_A, [x, near, y]);
      const d = store.dimensions;
      const nearVec = basis(d, 0);
      nearVec[1] = 0.1;
      await store.upsert(A, DOC_A, [{ chunkId: x, vector: basis(d, 0) }, { chunkId: near, vector: nearVec }, { chunkId: y, vector: basis(d, 1) }]);
      expect((await store.search(A, basis(d, 0), 10)).map((h) => h.chunkId)).toEqual([x, near, y]);
      expect((await store.search(A, basis(d, 0), 10, 0.5)).map((h) => h.chunkId)).toEqual([x, near]);
      expect(await store.search(A, basis(d, 0), 0)).toEqual([]);
      const scores = (await store.search(A, basis(d, 0), 10)).map((h) => h.score);
      expect(scores).toEqual([...scores].sort((p, q) => q - p));
    });

    test("never reads or writes across users or tenants", async ({ store, seed }) => {
      const [mine] = uuids(1) as [string];
      await seed(A, DOC_A, [mine]);
      await seed(B, DOC_B, []);
      await seed(C, DOC_C, []);
      const d = store.dimensions;
      await store.upsert(A, DOC_A, [{ chunkId: mine, vector: basis(d, 0) }]);
      expect(await store.upsert(B, DOC_A, [{ chunkId: mine, vector: basis(d, 1) }])).toEqual({ written: 0, missing: [mine] });
      expect(await store.upsert(C, DOC_A, [{ chunkId: mine, vector: basis(d, 1) }])).toEqual({ written: 0, missing: [mine] });
      expect(await store.search(B, basis(d, 0), 10)).toEqual([]);
      expect(await store.search(C, basis(d, 0), 10)).toEqual([]);
      expect(await store.missing(B, DOC_A, 10)).toEqual([]);
      expect((await store.search(A, basis(d, 0), 10)).map((h) => h.chunkId)).toEqual([mine]);
    });

    test("a store with another model id sees the chunks as unembedded and finds nothing until they are rewritten", async ({ store, seed, withModel }) => {
      const [id] = uuids(1) as [string];
      await seed(A, DOC_A, [id]);
      const d = store.dimensions;
      await store.upsert(A, DOC_A, [{ chunkId: id, vector: basis(d, 0) }]);
      const other = withModel("another-model");
      expect(await other.missing(A, DOC_A, 10)).toEqual([id]);
      expect(await other.search(A, basis(d, 0), 10)).toEqual([]);
      await other.upsert(A, DOC_A, [{ chunkId: id, vector: basis(d, 0) }]);
      expect(await other.missing(A, DOC_A, 10)).toEqual([]);
      expect(await store.missing(A, DOC_A, 10)).toEqual([id]); // and the first model's vector is gone: one vector per chunk
    });
  });
}
```

(Last case: the Postgres column holds one vector per chunk, so rewriting under a new model replaces the old one. The twin must behave the same: its `shared` map is keyed by chunk id, so a write under model B overwrites the model A entry.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @docmind/vector-pg exec vitest run`
Expected: PASS. Any twin bug the kit finds is fixed in `inMemory.ts` in this PR.

- [ ] **Step 5: Close-out**

Branch `test/vector-store-conformance`; subject `test(vector-pg): shared ChunkVectorStore conformance suite`.

---

### Task 89: `PgChunkVectorStore`

Spec §9 item 23, second part. Runs the Task 88 kit against pgvector. **Needs the `vector` extension**: where it is missing the cases skip dynamically (Preconditions). The test lives in the server app, where the real migrations and `withTenant` already are (a package must not import an app, and must not copy the schema).

**Files:**
- Create: `packages/vector-pg/src/pg.ts`
- Modify: `packages/vector-pg/src/index.ts` (export), `packages/vector-pg/package.json` (`pg` dependency)
- Create: `apps/server/app/flows/ingest-document/pgVectors.pg.test.ts`
- Modify: `apps/server/vitest.config.ts` (alias `@docmind/vector-pg/testing` to `packages/vector-pg/src/testing/conformance.ts`, as `@docmind/auth/testing` is)
- Modify: `apps/server/package.json` (`@docmind/vector-pg` dependency)

**Interfaces:**
- Consumes: `ChunkVectorStore`, `VectorDimensionError` (87), the kit (88).
- Produces: `interface PgVectorOptions { tenant: <T>(tenantId: string, fn: (tx: PoolClient) => Promise<T>) => Promise<T>; modelId: string; dimensions: number }`; `class PgChunkVectorStore implements ChunkVectorStore` with an extra `verify(tenantId: string): Promise<void>` that throws `Error("chunks.embedding is not vector(<dimensions>)")` when the column is missing or another size (called once at boot). The server composes `tenant` as `(t, fn) => withTenant(pool, t, fn)`, so RLS and `set_config` stay in one place.

- [ ] **Step 1: Write the failing test**

`pgVectors.pg.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { PgChunkVectorStore } from "@docmind/vector-pg";
import { type VectorHarness, runChunkVectorStoreConformance } from "@docmind/vector-pg/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword } from "../../db/migrate";
import { withTenant } from "../../db/tenant";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb, hasVector } from "../../db/testSupport";

describe.skipIf(!PG_URL)("PgChunkVectorStore (needs DOCMIND_TEST_PG_URL; the cases need pgvector)", () => {
  let db: TestDb;
  let app: Pool;
  let vector = false;
  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    vector = await hasVector(db.owner);
    app = new Pool({ connectionString: db.appUrl });
  });
  afterAll(async () => {
    await app?.end();
    await db?.drop();
  });

  const make = (modelId: string, dimensions = 768) =>
    new PgChunkVectorStore({ tenant: (t, fn) => withTenant(app, t, fn), modelId, dimensions });

  // The tenant, user, document and chunk rows the kit asks for, written as the owner role.
  const seed: VectorHarness["seed"] = async (scope, documentId, ids) => {
    const hex = documentId.replaceAll("-", "").repeat(2);
    await db.owner.query("INSERT INTO tenants (id, name) VALUES ($1, 'kit') ON CONFLICT DO NOTHING", [scope.tenantId]);
    await db.owner.query(
      "INSERT INTO users (id, tenant_id, email, password_hash) VALUES ($1, $2, $3, 'x') ON CONFLICT DO NOTHING",
      [scope.ownerId, scope.tenantId, `${scope.ownerId}@example.com`],
    );
    await db.owner.query(
      `INSERT INTO documents (id, tenant_id, owner_id, title_enc, filename_enc, mime, size_bytes, content_address, fingerprint)
       VALUES ($1, $2, $3, '{}', '{}', 'text/plain', 1, $4, $5) ON CONFLICT DO NOTHING`,
      [documentId, scope.tenantId, scope.ownerId, `hmac-sha256:${hex}`, hex],
    );
    for (const [ordinal, id] of ids.entries()) {
      await db.owner.query(
        `INSERT INTO chunks (id, tenant_id, document_id, ordinal, section_ordinal, text_enc, locator, token_count)
         VALUES ($1, $2, $3, $4, 0, '{}', '{"kind":"section","index":0}', 1)`,
        [id, scope.tenantId, documentId, ordinal],
      );
    }
  };

  runChunkVectorStoreConformance(
    async () => ({ store: make("m1"), withModel: (m) => make(m), seed }),
    "PgChunkVectorStore",
    { skip: () => !vector },
  );

  it("verify() accepts the column it was built for and rejects another size (needs pgvector)", async (ctx) => {
    if (!vector) ctx.skip();
    await expect(make("m").verify(randomUUID())).resolves.toBeUndefined();
    await expect(make("m", 8).verify(randomUUID())).rejects.toThrow(/^chunks\.embedding is not vector\(8\)$/);
  });

  it("verify() reports a database without the column (no pgvector) the same way", async (ctx) => {
    if (vector) ctx.skip();
    await expect(make("m").verify(randomUUID())).rejects.toThrow(/^chunks\.embedding is not vector\(768\)$/);
  });

  it("a cosine search can use the HNSW index (needs pgvector)", async (ctx) => {
    if (!vector) ctx.skip();
    const client = await db.owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      const plan = await client.query(
        `EXPLAIN SELECT id FROM chunks ORDER BY embedding <=> '[${new Array(768).fill(0.1).join(",")}]'::vector LIMIT 5`,
      );
      expect(plan.rows.map((r) => r["QUERY PLAN"]).join("\n")).toContain("chunks_embedding_hnsw");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `export DOCMIND_TEST_PG_URL=<pgvector url> && pnpm --filter @docmind/server exec vitest run app/flows/ingest-document/pgVectors.pg.test.ts`
Expected: FAIL (`@docmind/vector-pg` exports no `PgChunkVectorStore`). On 55432 the kit cases skip and only the "no pgvector" `verify` case runs; do the failing-first check against a pgvector URL.

- [ ] **Step 3: Implement**

`packages/vector-pg/src/pg.ts`:

```ts
import type { PoolClient } from "pg";
import { type ChunkVectorStore, VectorDimensionError, type VectorScope } from "./types";

export interface PgVectorOptions {
  tenant: <T>(tenantId: string, fn: (tx: PoolClient) => Promise<T>) => Promise<T>;
  modelId: string;
  dimensions: number;
}

const literal = (v: readonly number[]) => `[${v.join(",")}]`;
const JOIN_OWNER = "JOIN documents d ON d.id = c.document_id AND d.tenant_id = c.tenant_id";

export class PgChunkVectorStore implements ChunkVectorStore {
  readonly modelId: string;
  readonly dimensions: number;
  constructor(private readonly options: PgVectorOptions) {
    this.modelId = options.modelId;
    this.dimensions = options.dimensions;
  }

  private check(v: readonly number[]): void {
    if (v.length !== this.dimensions || !v.every(Number.isFinite)) throw new VectorDimensionError();
  }

  async upsert(scope: VectorScope, documentId: string, items: { chunkId: string; vector: readonly number[] }[]) {
    for (const item of items) this.check(item.vector);
    if (items.length === 0) return { written: 0, missing: [] as string[] };
    return this.options.tenant(scope.tenantId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `UPDATE chunks c SET embedding = u.v::vector, embedding_model = $4
           FROM unnest($1::uuid[], $2::text[]) AS u(id, v), documents d
          WHERE c.id = u.id AND c.document_id = $3 AND d.id = c.document_id AND d.tenant_id = c.tenant_id AND d.owner_id = $5
          RETURNING c.id`,
        [items.map((i) => i.chunkId), items.map((i) => literal(i.vector)), documentId, this.modelId, scope.ownerId],
      );
      const written = new Set(rows.map((r) => r.id));
      return { written: written.size, missing: items.map((i) => i.chunkId).filter((id) => !written.has(id)) };
    });
  }

  missing(scope: VectorScope, documentId: string, limit: number): Promise<string[]> {
    return this.options.tenant(scope.tenantId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT c.id FROM chunks c ${JOIN_OWNER}
          WHERE c.document_id = $1 AND d.owner_id = $2 AND (c.embedding IS NULL OR c.embedding_model <> $3)
          ORDER BY c.ordinal LIMIT $4`,
        [documentId, scope.ownerId, this.modelId, limit],
      );
      return rows.map((r) => r.id);
    });
  }

  async search(scope: VectorScope, query: readonly number[], limit: number, minScore = -1) {
    this.check(query);
    if (limit <= 0) return [];
    return this.options.tenant(scope.tenantId, async (tx) => {
      const { rows } = await tx.query<{ id: string; score: number }>(
        `SELECT c.id, 1 - (c.embedding <=> $1::vector) AS score FROM chunks c ${JOIN_OWNER}
          WHERE d.owner_id = $2 AND c.embedding_model = $3 AND 1 - (c.embedding <=> $1::vector) >= $4
          ORDER BY c.embedding <=> $1::vector LIMIT $5`,
        [literal(query), scope.ownerId, this.modelId, minScore, limit],
      );
      return rows.map((r) => ({ chunkId: r.id, score: Number(r.score) }));
    });
  }

  /** Boot check. `tenantId` only opens a tenant transaction; any uuid that owns no rows will do. */
  async verify(tenantId: string): Promise<void> {
    const found = await this.options.tenant(tenantId, async (tx) => {
      const { rows } = await tx.query<{ t: string }>(
        "SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = 'chunks'::regclass AND attname = 'embedding'",
      );
      return rows[0]?.t;
    });
    if (found !== `vector(${this.dimensions})`) throw new Error(`chunks.embedding is not vector(${this.dimensions})`);
  }
}
```

(The twin's ordering of `search` ties and pgvector's may differ; the kit never relies on tie order.)

- [ ] **Step 4: Run to verify it passes**

Run: `export DOCMIND_TEST_PG_URL=<pgvector url> && pnpm --filter @docmind/server exec vitest run app/flows/ingest-document/pgVectors.pg.test.ts`
Expected: PASS against pgvector. On 55432: the seven kit cases, the size check and the HNSW case report skipped with the reason "pgvector not installed", and the no-pgvector `verify` case passes; say so in the PR.

- [ ] **Step 5: Close-out**

Branch `feat/vector-pg`; subject `feat(vector-pg): pgvector ChunkVectorStore passing the shared suite`. Seam if over: `verify()` and the HNSW case after the kit-driven run.

---

### Task 90: the `embed` step effect

Spec §5.2 embed: batches of 64, idempotent by `chunkId`, the log records `{count, model}` only. A library over ports (like Task 78); Task 91 puts it in the flow.

**Files:**
- Create: `apps/server/app/flows/ingest-document/steps/embed.ts`
- Create: `apps/server/app/flows/ingest-document/steps/embed.test.ts`
- Modify: `apps/server/package.json` (`@docmind/vector-pg`, `@docmind/embeddings`, `@loom/memory`)
- Modify: `apps/server/app/flows/ingest-document/errors.ts` (`TransientIngestError`)

**Interfaces:**
- Consumes: `StepGuard`, `ChunkStore` (82), `ChunkVectorStore` (87), `EmbeddingProvider` (`@loom/memory`), `EmbeddingUnavailableError` (85), `DocumentGoneError`.
- Produces also: `class TransientIngestError` in `errors.ts` (message `transient ingest failure`; part 2's retry policy reads it, part 1 treats it like any unexpected error):

  ```ts
  /** Worth retrying (embedder or LLM 429/5xx, timeouts). */
  export class TransientIngestError extends Error {
    constructor() {
      super("transient ingest failure");
      this.name = "TransientIngestError";
    }
  }
  ```
- Produces: `EMBED_BATCH = 64`; `interface EmbedDeps { guard: StepGuard; chunks: ChunkStore; vectors: ChunkVectorStore; embedder: EmbeddingProvider }`; `embedEffect(deps: EmbedDeps): Effect<IngestStartInput, StepResult>` whose result is `{ outcome: "done", count: <chunks in the document>, model: embedder.modelId }`.

- [ ] **Step 1: Write the failing test**

`embed.test.ts` builds a document of N chunk ids with the Task 87 twin (`chunkIds` returns them) and a fake `ChunkStore` (`read` returns `{id, text: "t-"+id}` for the ids asked, `count` returns N). The embedder is `HashingEmbeddingProvider({dimensions: 8})` wrapped by a spy that records each call's size and can be told to throw once.

```ts
it("embeds in batches of 64 and reports {count, model}", async () => {
  const h = harness(150);
  expect(await run(h.deps)).toEqual({ outcome: "done", count: 150, model: "hashing-8" });
  expect(h.embedCalls).toEqual([64, 64, 22]);
  expect(await h.deps.vectors.missing(SCOPE, DOC, 1000)).toEqual([]);
});
it("is idempotent: a second run embeds nothing and reports the same result", async () => {
  const h = harness(70);
  await run(h.deps);
  h.embedCalls.length = 0;
  expect(await run(h.deps)).toEqual({ outcome: "done", count: 70, model: h.deps.embedder.modelId });
  expect(h.embedCalls).toEqual([]);
});
it("resumes after a failure in the second batch: only the unfinished chunks are embedded the next time", async () => {
  const h = harness(100);
  h.failOnCall(2, new EmbeddingUnavailableError());
  await expect(run(h.deps)).rejects.toThrow(/^ingest step failed: embed$/);
  expect(await h.deps.vectors.missing(SCOPE, DOC, 1000)).toHaveLength(36);
  h.embedCalls.length = 0;
  expect(await run(h.deps)).toMatchObject({ outcome: "done", count: 100 });
  expect(h.embedCalls).toEqual([36]);
});
it("hands the embedder exactly the texts of the chunks it is embedding", async () => {
  const h = harness(3);
  await run(h.deps);
  expect(h.embedTexts.flat()).toEqual(h.chunkIds.map((id) => `t-${id}`));
});

it("fails the step with the fixed message on an embedder outage (part 2 retries it) and on a permanent embedder error", async () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  for (const error of [new EmbeddingUnavailableError(), new EmbeddingError("bad request")]) {
    const h = harness(2);
    h.failOnCall(1, error);
    await expect(run(h.deps)).rejects.toThrow(/^ingest step failed: embed$/);
  }
  expect(spy).toHaveBeenCalledWith("ingest step failed", "embed", "TransientIngestError");
  expect(spy).toHaveBeenCalledWith("ingest step failed", "embed", "EmbeddingError");
  spy.mockRestore();
});

it("stops as document_gone when the chunk texts cannot be read for ids the vector store listed", async () => {
  const h = harness(3);
  h.deps.chunks.read = async () => [];
  expect(await run(h.deps)).toEqual({ outcome: "document_gone" });
});

it("stops as document_gone when the vector store says the chunk rows are gone (deleted or re-chunked mid-step)", async () => {
  const h = harness(3);
  h.deps.vectors.upsert = async (_s, _d, items) => ({ written: 0, missing: items.map((i) => i.chunkId) });
  expect(await run(h.deps)).toEqual({ outcome: "document_gone" });
});

it("an empty document embeds nothing and reports count 0", async () => {
  const h = harness(0);
  expect(await run(h.deps)).toEqual({ outcome: "done", count: 0, model: h.deps.embedder.modelId });
  expect(h.embedCalls).toEqual([]);
});
```

The helpers at the top of the file:

```ts
const T = randomUUID();
const U = randomUUID();
const DOC = randomUUID();
const SCOPE = { tenantId: T, ownerId: U };
const run = (d: EmbedDeps) => embedEffect(d).execute({ tenantId: T, userId: U, documentId: DOC }, {} as never);

function harness(n: number) {
  const chunkIds = Array.from({ length: n }, () => randomUUID());
  const embedCalls: number[] = [];
  const embedTexts: string[][] = [];
  let calls = 0;
  let failure: { at: number; error: Error } | undefined;
  const inner = new HashingEmbeddingProvider({ dimensions: 8 });
  const embedder: EmbeddingProvider = {
    modelId: inner.modelId,
    dimensions: 8,
    embed: async (texts) => {
      calls += 1;
      if (failure?.at === calls) throw failure.error;
      embedCalls.push(texts.length);
      embedTexts.push([...texts]);
      return inner.embed(texts);
    },
  };
  const deps: EmbedDeps = {
    guard: { begin: async () => {} },
    chunks: {
      replace: async () => n,
      count: async () => n,
      read: async (_r, ids) => ids.map((id) => ({ id, text: `t-${id}` })),
    },
    vectors: new InMemoryChunkVectors({ modelId: embedder.modelId, dimensions: 8, chunkIds: async () => chunkIds }),
    embedder,
  };
  return { deps, embedCalls, embedTexts, chunkIds, failOnCall: (at: number, error: Error) => void (failure = { at, error }) };
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/ingest-document/steps/embed.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
export const EMBED_BATCH = 64;

export function embedEffect(deps: EmbedDeps): Effect<IngestStartInput, StepResult> {
  return stepEffect("embed", deps.guard, async (ref) => {
    const scope = { tenantId: ref.tenantId, ownerId: ref.userId };
    for (;;) {
      const ids = await deps.vectors.missing(scope, ref.documentId, EMBED_BATCH);
      if (ids.length === 0) break;
      const rows = await deps.chunks.read(ref, ids);
      if (rows.length !== ids.length) throw new DocumentGoneError(); // chunks deleted or replaced under us
      const vectors = await embed(deps.embedder, rows.map((r) => r.text));
      const { missing } = await deps.vectors.upsert(scope, ref.documentId, rows.map((r, i) => ({ chunkId: r.id, vector: vectors[i] as number[] })));
      if (missing.length > 0) throw new DocumentGoneError();
    }
    return { count: await deps.chunks.count(ref), model: deps.embedder.modelId };
  });
}

async function embed(embedder: EmbeddingProvider, texts: string[]): Promise<number[][]> {
  try {
    return await embedder.embed(texts);
  } catch (err) {
    // Part 2's retry policy reads this class; part 1 fails the step like any unexpected error.
    throw err instanceof EmbeddingUnavailableError ? new TransientIngestError() : err;
  }
}
```

Termination: each loop either shrinks `missing` or throws (an `upsert` that wrote nothing and reported nothing missing cannot happen; if a store ever does, the next `missing` call returns the same ids and the loop would spin, so the code adds `if (written === 0) throw new Error("embedding made no progress")` after the upsert; it maps to the fixed step failure).

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/ingest-document/steps/embed.test.ts`
Expected: PASS.

- [ ] **Step 5: Close-out**

Branch `feat/ingest-embed-step`; subject `feat(server): embed step in batches of 64, resumable and idempotent`.

---

### Task 91: embed in the flow, and the embedder and vector store through the composition root

**Files:**
- Modify: `apps/server/app/flows/ingest-document/flow.ts` (`ingestEmbedStep`)
- Modify: `apps/server/app/flows/ingest-document/deps.ts`, `pgDeps.ts`
- Modify: `apps/server/app/flows/ingest-document/limits.ts` (embedder config, `IngestWiring.embedder`)
- Modify: `apps/server/app/security.ts`, `apps/server/app/compose.ts`, `apps/server/app/main.ts`
- Modify: `apps/server/app/documents/testHarness.ts` (fake Ollama embedder, twin vector store over the pg chunk store)
- Modify: `apps/server/app/flows/ingest-document/flow.test.ts`, `eventLog.pg.test.ts`

**Interfaces:**
- Consumes: `embedEffect` (90), `OllamaEmbeddingProvider` (85), `PgChunkVectorStore` (89), `InMemoryChunkVectors` (87).
- Produces: `ingestEmbedStep` (`id: "ingest-embed"`); `IngestDeps extends ParseDeps, ChunkDeps, EmbedDeps`; `IngestWiring.embedder: EmbeddingProvider`; `loadEmbedConfig(env): { baseUrl: string; model: string; dimensions: number; timeoutMs: number }` reading `DOCMIND_OLLAMA_URL` (default `http://127.0.0.1:11434`), `DOCMIND_EMBED_MODEL` (`nomic-embed-text`), `DOCMIND_EMBED_DIMENSIONS` (768), `DOCMIND_EMBED_TIMEOUT_MS` (30000); `ComposeOptions.vectors?: ChunkVectorStore` (test seam; default `new PgChunkVectorStore({ tenant: (t, fn) => withTenant(pool, t, fn), modelId: embedder.modelId, dimensions: embedder.dimensions })`); `main` calls `vectors.verify(NIL_TENANT)` before listening so a dimension mismatch fails the boot.

- [ ] **Step 1: Write the failing tests**

`flow.test.ts`: the fake deps gain `chunks`, `vectors` (an `InMemoryChunkVectors` whose `chunkIds` returns `[]`) and `embedder` (`HashingEmbeddingProvider({dimensions: 8})`), and the completing test expects `["begin:parse", "begin:chunk", "begin:embed"]`. `limits.test.ts` gains:

```ts
describe("loadEmbedConfig", () => {
  it("has defaults", () => {
    expect(loadEmbedConfig({})).toEqual({ baseUrl: "http://127.0.0.1:11434", model: "nomic-embed-text", dimensions: 768, timeoutMs: 30_000 });
  });
  it("reads overrides", () => {
    expect(loadEmbedConfig({ DOCMIND_OLLAMA_URL: "http://127.0.0.1:9", DOCMIND_EMBED_MODEL: "m", DOCMIND_EMBED_DIMENSIONS: "8" })).toMatchObject({ baseUrl: "http://127.0.0.1:9", model: "m", dimensions: 8 });
  });
  it("rejects a bad dimension naming the variable and not the value", () => {
    expect(() => loadEmbedConfig({ DOCMIND_EMBED_DIMENSIONS: "0" })).toThrow(/^DOCMIND_EMBED_DIMENSIONS must be a positive integer$/);
  });
});
```

and `pgDeps.test.ts` (a new unit test, no database):

```ts
it("refuses an embedder and a vector store that disagree on the model, at composition time", () => {
  const wiring = createIngestWiring({ DOCMIND_EMBED_MODEL: "a", DOCMIND_EMBED_DIMENSIONS: "8" });
  const vectors = new InMemoryChunkVectors({ modelId: "ollama/b", dimensions: 8, chunkIds: async () => [] });
  expect(() => pgIngestDeps({ pool: {} as Pool, fields: {} as FieldCrypto, blobs: () => ({ get: async () => null }), wiring, vectors })).toThrow(
    /^embedder and vector store disagree on the model$/,
  );
});
```

`eventLog.pg.test.ts` (whose folded-status assertion becomes `{ status: "embedding", step: "embed", code: null }`) stops using the default (real-Ollama) wiring: its `beforeAll` starts `startFakeOllama({ dimensions: 64, model: "fake-embed" })`, builds `wiring = createIngestWiring({ DOCMIND_OLLAMA_URL: fake.url, DOCMIND_EMBED_MODEL: "fake-embed", DOCMIND_EMBED_DIMENSIONS: "64" })` and passes `vectors: twinOverPgChunks(f.app, wiring)` to `pgIngestDeps` (and closes the fake in `afterAll`). Its first test then also asserts the embed step's output in the raw log:

```ts
const outputs = raw.filter((e) => e.eventType === "STEP_COMPLETED").map((e) => (e.payload as { output: Record<string, unknown> }).output);
expect(outputs.at(-1)).toEqual({ outcome: "done", count: expect.any(Number), model: "ollama/fake-embed" });
```

- [ ] **Step 2: Run to verify they fail**

Run: `export DOCMIND_TEST_PG_URL=... && pnpm --filter @docmind/server exec vitest run app/flows/ingest-document`
Expected: FAIL (no embed step; `loadEmbedConfig` missing).

- [ ] **Step 3: Implement**

`limits.ts` gains:

```ts
export interface EmbedConfig {
  baseUrl: string;
  model: string;
  dimensions: number;
  timeoutMs: number;
}

export function loadEmbedConfig(env: NodeJS.ProcessEnv = process.env): EmbedConfig {
  return {
    baseUrl: env.DOCMIND_OLLAMA_URL?.trim() || "http://127.0.0.1:11434",
    model: env.DOCMIND_EMBED_MODEL?.trim() || "nomic-embed-text",
    dimensions: positiveInt(env, "DOCMIND_EMBED_DIMENSIONS", 768),
    timeoutMs: positiveInt(env, "DOCMIND_EMBED_TIMEOUT_MS", 30_000),
  };
}
```

`IngestWiring` gains `embedder: EmbeddingProvider`, built in `createIngestWiring` as `new OllamaEmbeddingProvider(loadEmbedConfig(env))`. `compose.ts` builds the store and hands it to `pgIngestDeps`:

```ts
const vectors =
  options.vectors ??
  new PgChunkVectorStore({
    tenant: (tenantId, fn) => withTenant(pool, tenantId, fn),
    modelId: options.ingest.embedder.modelId,
    dimensions: options.ingest.embedder.dimensions,
  });
const ingestDeps = pgIngestDeps({ pool, fields, blobs, wiring: options.ingest, vectors });
return { app, server, store, throttle, starts, ingest: options.ingest, vectors };
```

`pgIngestDeps` adds `chunks`, `vectors`, `embedder: wiring.embedder` and refuses a mismatch at composition time:

```ts
if (vectors.modelId !== wiring.embedder.modelId || vectors.dimensions !== wiring.embedder.dimensions) {
  throw new Error("embedder and vector store disagree on the model");
}
```

`main.ts` calls `await composed.vectors.verify(NIL_TENANT)` (`NIL_TENANT = "00000000-0000-4000-8000-000000000000"`, which owns no rows) before `server.listen`, so a database whose `chunks.embedding` is not `vector(<DOCMIND_EMBED_DIMENSIONS>)` stops the boot with `chunks.embedding is not vector(768)` instead of failing the first upload. `ComposeOptions.vectors?: ChunkVectorStore` is the test seam. Add `ingestEmbedStep = stepOf("ingest-embed", "IngestEmbed")` after the chunk step, `"ingest-embed": embedEffect(deps)` to the effect map, and `"ingest-embed"` to the grants.

In `testHarness.ts` the harness starts `startFakeOllama({ dimensions: 64, model: "fake-embed" })`, builds `createIngestWiring({ DOCMIND_OLLAMA_URL: fake.url, DOCMIND_EMBED_MODEL: "fake-embed", DOCMIND_EMBED_DIMENSIONS: "64" })` and passes `vectors: new InMemoryChunkVectors({ modelId: wiring.embedder.modelId, dimensions: 64, chunkIds })` with

```ts
const chunkIds = (scope: VectorScope, documentId: string) =>
  withTenant(app, scope.tenantId, async (tx) =>
    (await tx.query<{ id: string }>("SELECT c.id FROM chunks c JOIN documents d ON d.id = c.document_id AND d.tenant_id = c.tenant_id WHERE c.document_id = $1 AND d.owner_id = $2 ORDER BY c.ordinal", [documentId, scope.ownerId])).rows.map((r) => r.id),
  );
```

so the whole pipeline runs against the real `chunks` table where pgvector is absent. `apps/server/vitest.config.ts` gains the aliases `@docmind/embeddings/testing` (to `packages/embeddings/src/testing/fakeOllama.ts`) and, from Task 89, `@docmind/vector-pg/testing`.

- [ ] **Step 4: Run to verify they pass**

Run: `export DOCMIND_TEST_PG_URL=... && pnpm --filter @docmind/server exec vitest run`
Expected: PASS (txt uploads in the harness now stop at status `embedding` until Task 92).

- [ ] **Step 5: Close-out**

Branch `feat/ingest-embed-in-flow`; subject `feat(server): embed step in the flow, embedder and vectors through the composition root`. Seam if over: `loadEmbedConfig` + its test, then the flow change.

---

## Part F: finish the skeleton, sweep, SSE, acceptance (Tasks 92-95)

### Task 92: analyze, summarize and link placeholders; `finalize` -> `ready`

Spec §9 item 14 completes the skeleton. The three placeholders are real, named, durable steps that only run the document guard; part 2 swaps their effects in `ingestEffects` and changes nothing in the flow. **Revised 2026-10-19:** no step writes a status. `ready` is what the `ingest-status` model folds out of `ingest-finalize`'s `STEP_COMPLETED` with `outcome: "done"` (Task 74b), and the progress the user sees follows the log, so `finalize` is `embedding` while it runs and `ready` when it has completed.

**Files:**
- Create: `apps/server/app/flows/ingest-document/steps/placeholders.ts`
- Create: `apps/server/app/flows/ingest-document/steps/placeholders.test.ts`
- Modify: `apps/server/app/flows/ingest-document/flow.ts`, `deps.ts`
- Modify: `apps/server/app/security.ts`
- Modify: `apps/server/app/flows/ingest-document/flow.test.ts`
- Modify: `apps/server/app/flows/ingest-document/eventLog.pg.test.ts` (the folded status of the real log)
- Modify: `apps/server/app/documents/ingestStart.pg.test.ts`

**Interfaces:**
- Consumes: `stepEffect`, `StepGuard` (73a), `ChunkStore` (82), `foldIngestStatus`, `STATUS_MESSAGES` (74b), `IngestStatus.forDocument` through the harness (79c).
- Produces: `ingestAnalyzeStep` (`ingest-analyze`), `ingestSummarizeStep` (`ingest-summarize`), `ingestLinkStep` (`ingest-link`), `ingestFinalizeStep` (`ingest-finalize`) appended in that order; `PLACEHOLDER_STEPS = ["analyze", "summarize", "link"] as const`; `placeholderEffect(step: (typeof PLACEHOLDER_STEPS)[number], guard: StepGuard)`; `finalizeEffect(deps: { guard: StepGuard; chunks: ChunkStore })` returning `{ count: chunks }`. `IngestDeps` is unchanged: the placeholders need only `guard`.

- [ ] **Step 1: Write the failing tests**

`placeholders.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DocumentGoneError } from "../errors";
import type { IngestStartInput } from "../flow";
import type { StepGuard } from "../stepEffect";
import { PLACEHOLDER_STEPS, finalizeEffect, placeholderEffect } from "./placeholders";

const ref = (): IngestStartInput => ({ tenantId: randomUUID(), userId: randomUUID(), documentId: randomUUID() });
const run = <T extends { execute: (r: IngestStartInput, c: never) => Promise<unknown> }>(effect: T) => effect.execute(ref(), {} as never);
const recorder = () => {
  const calls: string[] = [];
  const guard: StepGuard = { begin: async (_r, step) => void calls.push(step) };
  return { calls, guard };
};

describe("placeholders", () => {
  // Part 2 replaces these three names with real steps and updates this guard in the same PR.
  it("are exactly analyze, summarize and link", () => {
    expect([...PLACEHOLDER_STEPS]).toEqual(["analyze", "summarize", "link"]);
  });

  it.each(PLACEHOLDER_STEPS)("%s only checks the document and reports done", async (step) => {
    const { calls, guard } = recorder();
    expect(await run(placeholderEffect(step, guard))).toEqual({ outcome: "done" });
    expect(calls).toEqual([step]);
  });

  it("stop as document_gone when the document is gone", async () => {
    const guard: StepGuard = { begin: async () => { throw new DocumentGoneError(); } };
    expect(await run(placeholderEffect("link", guard))).toEqual({ outcome: "document_gone" });
  });
});

describe("finalize", () => {
  it("checks the document and reports the chunk count; `ready` is the model's reading of its completion", async () => {
    const { calls, guard } = recorder();
    const chunks = { replace: async () => 0, count: async () => 7, read: async () => [] };
    expect(await run(finalizeEffect({ guard, chunks }))).toEqual({ outcome: "done", count: 7 });
    expect(calls).toEqual(["finalize"]);
  });
});
```

`flow.test.ts`: the completing test now expects the guard's `begin:` calls in order `parse, chunk, embed, analyze, summarize, link, finalize`, and `INGEST_STEPS.map((s) => s.id)` equals `["ingest-parse", "ingest-chunk", "ingest-embed", "ingest-analyze", "ingest-summarize", "ingest-link", "ingest-finalize"]`.

`eventLog.pg.test.ts`: the folded-status assertion of Task 81 (which Tasks 83 and 91 moved to `chunk` and `embed`) now expects the finished run: `expect(foldIngestStatus(raw)).toEqual({ status: "ready", step: "finalize", code: null })`. This is the proof that the model's handlers match the kernel's real events.

`ingestStart.pg.test.ts`: the first test now ends with:

```ts
    const state = await handle?.waitForCompletion();
    expect(state?.variables._output).toEqual({ outcome: "done" });
    expect(await h.status.forDocument(ALICE, id)).toEqual({ status: "ready", step: "finalize", error: null });
    expect((await h.owner.query("SELECT count(*)::int AS n FROM chunks WHERE document_id = $1", [id])).rows[0].n).toBeGreaterThan(0);
```

and two new tests in the same file (`STATUS_MESSAGES` from `../status/model`; `ALICE` from the harness):

```ts
  it("ends a pdf as failed with the fixed unsupported_content message (no pdf parser until part 2)", async () => {
    const { body } = await created("report.pdf", PDF("pdf flow"));
    await h.starts.idle();
    await h.ingest.handles.get(body.document.id)?.waitForCompletion();
    expect(await h.status.forDocument(ALICE, body.document.id)).toEqual({
      status: "failed", step: "parse", error: STATUS_MESSAGES.unsupported_content,
    });
  });

  it("ends a binary file named .txt as failed with corrupt_content, never ready", async () => {
    const bytes = Buffer.from([0xff, 0xfe, 0x41, 0x00, 0xff, 0xff, 0x00, 0xd8]); // UTF-16 BOM, a noncharacter, a lone surrogate
    const { body } = await created("data.txt", bytes);
    await h.starts.idle();
    await h.ingest.handles.get(body.document.id)?.waitForCompletion();
    expect(await h.status.forDocument(ALICE, body.document.id)).toEqual({
      status: "failed", step: "parse", error: STATUS_MESSAGES.corrupt_content,
    });
  });
```

(Both read through `forDocument`, which folds the log tail first, so they never race the live feed.)

- [ ] **Step 2: Run to verify they fail**

Run: `export DOCMIND_TEST_PG_URL=... && pnpm --filter @docmind/server exec vitest run app/flows app/documents`
Expected: FAIL (no placeholders; the flow ends at embed, so the folded status is `embedding`).

- [ ] **Step 3: Implement**

```ts
export const PLACEHOLDER_STEPS = ["analyze", "summarize", "link"] as const;

/** Named, durable, and empty: part 2 replaces the effect registered under the step's id and nothing else. */
export const placeholderEffect = (step: (typeof PLACEHOLDER_STEPS)[number], guard: StepGuard) =>
  stepEffect(step, guard, async () => {});

export const finalizeEffect = (deps: { guard: StepGuard; chunks: ChunkStore }) =>
  stepEffect("finalize", deps.guard, async (ref) => ({ count: await deps.chunks.count(ref) }));
```

`flow.ts` appends the four steps; `deps.ts`'s map adds `"ingest-analyze"`, `"ingest-summarize"`, `"ingest-link"` (via `placeholderEffect(step, deps.guard)`) and `"ingest-finalize"` (via `finalizeEffect(deps)`); `security.ts` lists all seven ids.

- [ ] **Step 4: Run to verify they pass**

Run: `export DOCMIND_TEST_PG_URL=... && pnpm --filter @docmind/server exec vitest run`
Expected: PASS.

- [ ] **Step 5: Close-out**

Branch `feat/ingest-placeholders-finalize`; subject `feat(server): analyze, summarize and link placeholders; finalize completes the flow`.

---

### Task 93: sweep documents the flow never started

Carry-forward 1 (crash between the upload commit and the flow start; also a start that failed or was slow, now that Task 77 stopped waiting for it). **Revised 2026-10-19:** `documents.status` is gone (Task 79c), so "stranded" means: the document has **no row for its current-generation ingest execution** in the status model's table, and it is older than a grace period. A `SECURITY DEFINER` function finds them across tenants by one anti-join (the model's tables are in `public`, Revision R2); the sweeper asks the (start-once) port to start each. Calling start for a document whose execution exists but whose row has not been folded yet is a no-op, so the sweep needs no execution lookup and cannot double-start. Stub (generation 1) executions are not consulted: a generation-1 row does not count, because the stub never ran a real step. To keep the scan from walking the whole table every minute it looks only at documents created within a lookback window (default 7 days, newest first, using a new index on `created_at`); an operator who needs older strays swept passes a longer `lookbackMs`.

**Files:**
- Create: `infra/migrations/0015_stale_uploads.sql`
- Create: `apps/server/app/documents/sweep.ts`
- Create: `apps/server/app/documents/sweep.pg.test.ts`
- Modify: `apps/server/app/main.ts` (timer)

**Interfaces:**
- Consumes: `StartScheduler` (77), `ingestExecutionId`, `INGEST_GENERATION` (76), `read_model_state` (`0012`), `INGEST_STATUS_MODEL` (74b).
- Produces: SQL function `docmind_stale_uploads(older_than interval, lookback interval, generation integer, max_rows integer) RETURNS TABLE (tenant_id uuid, owner_id uuid, id uuid)` (newest first); `sweepStaleUploads(args: { pool: Pool; starts: StartScheduler; olderThanMs: number; lookbackMs: number; limit: number }): Promise<number>` (number started or attempted); constants `STALE_UPLOAD_MS = 120_000`, `SWEEP_LOOKBACK_MS = 604_800_000`, `SWEEP_EVERY_MS = 60_000`, `SWEEP_BATCH = 100`.

- [ ] **Step 1: Write the failing test**

`sweep.pg.test.ts` (the first two tests share one database set up like Task 74a's: `createTestDb`, `migrate`, `setAppRolePassword`, `seedUsers`, an `app` pool, a `FieldCrypto`):

```ts
const FN = "docmind_stale_uploads(make_interval(secs => 120), make_interval(secs => 604800), 2, 10)";

// A document of `who`, created `ageSeconds` ago, as the owner role.
async function seedDoc(owner: Pool, app: Pool, fields: FieldCrypto, who: Identity, fingerprint: string, ageSeconds: number) {
  const d = await newDocument(fields, who.tenantId, who.userId, fingerprint);
  await withTenant(app, who.tenantId, (tx) => insertDocument(tx, d));
  await owner.query("UPDATE documents SET created_at = now() - make_interval(secs => $2::float8) WHERE id = $1", [d.id, ageSeconds]);
  return d.id;
}
// What the status model's writer would have stored for an execution.
const seedRow = (owner: Pool, executionId: string, key: string, scope: string) =>
  owner.query("INSERT INTO read_model_state (model_id, execution_id, app_key, scope, sequence, state) VALUES ('ingest-status', $1, $2, $3, 0, '{}')", [executionId, key, scope]);

it("lists documents that are old enough, recent enough and have no generation-2 row, across tenants, newest first, limited", async () => {
  const aliceOld = await seedDoc(owner, app, fields, ALICE, "a".repeat(64), 600);
  const stubOnly = await seedDoc(owner, app, fields, ALICE, "b".repeat(64), 700);
  const bobOlder = await seedDoc(owner, app, fields, BOB, "c".repeat(64), 900);
  const started = await seedDoc(owner, app, fields, ALICE, "d".repeat(64), 800);
  await seedDoc(owner, app, fields, ALICE, "e".repeat(64), 5); // fresh: inside the grace period
  await seedDoc(owner, app, fields, ALICE, "f".repeat(64), 8 * 24 * 3600); // older than the lookback
  await seedRow(owner, ingestExecutionId(U1, stubOnly, 1), stubOnly, U1); // the M2 stub's execution does not count
  await seedRow(owner, ingestExecutionId(U1, started), started, U1); // the current generation: started, whatever its state
  const all = (await app.query(`SELECT * FROM ${FN}`)).rows;
  expect(all.map((r) => r.id)).toEqual([aliceOld, stubOnly, bobOlder]);
  expect(all[2]).toEqual({ tenant_id: T2, owner_id: U2, id: bobOlder });
  expect((await app.query(`SELECT * FROM docmind_stale_uploads(make_interval(secs => 120), make_interval(secs => 604800), 2, 1)`)).rows.map((r) => r.id)).toEqual([aliceOld]);
});
it("the app role may run the function and PUBLIC may not", async () => {
  const sig = "docmind_stale_uploads(interval, interval, integer, integer)";
  const { rows } = await owner.query(
    `SELECT has_function_privilege('docmind_app', '${sig}', 'EXECUTE') AS app, has_function_privilege('public', '${sig}', 'EXECUTE') AS pub`,
  );
  expect(rows[0]).toEqual({ app: true, pub: false });
});
it("sweepStaleUploads starts each stale document, and a second sweep asks again but creates no second execution (start-once)", async () => {
  const h = await startDocumentServer();
  const fields = new FieldCrypto(h.keys);
  const ids = [await seedDoc(h.owner, h.app, fields, ALICE, "1".repeat(64), 600), await seedDoc(h.owner, h.app, fields, BOB, "2".repeat(64), 600)];
  const args = { pool: h.app, starts: h.starts, olderThanMs: 120_000, lookbackMs: 604_800_000, limit: 10 };
  expect(await sweepStaleUploads(args)).toBe(2);
  await h.starts.idle();
  expect([...h.ingest.handles.keys()].sort()).toEqual([...ids].sort());
  const handles = [...h.ingest.handles.values()];
  await sweepStaleUploads(args); // the harness model is in memory, so these rows are still unseen by the SQL; start-once is what protects
  await h.starts.idle();
  expect([...h.ingest.handles.values()]).toEqual(handles);
  expect(h.ingest.calls.filter((c) => c.startsWith("start:"))).toHaveLength(4); // asked twice, executed once
  await Promise.all(handles.map((handle) => handle.waitForCompletion()));
  await h.close();
});
it("a failing query is logged by class only and does not throw", async () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  const broken = { query: async () => { throw new RangeError("secret relation name"); } } as unknown as Pool;
  const starts = new StartScheduler({ start: async () => null, cancel: async () => {} });
  expect(await sweepStaleUploads({ pool: broken, starts, olderThanMs: 0, lookbackMs: 1, limit: 1 })).toBe(0);
  expect(spy).toHaveBeenCalledWith("stale upload sweep failed", "RangeError");
  expect(JSON.stringify(spy.mock.calls)).not.toContain("secret");
  spy.mockRestore();
});
```

(`seedRow` uses the owner role; the seeded `execution_id` comes from the TypeScript `ingestExecutionId`, so the second assertion fails if the SQL's string and the TypeScript's ever disagree.)

- [ ] **Step 2: Run to verify it fails**

Run: `export DOCMIND_TEST_PG_URL=... && pnpm --filter @docmind/server exec vitest run app/documents/sweep.pg.test.ts`
Expected: FAIL (function does not exist).

- [ ] **Step 3: Implement**

`0015_stale_uploads.sql`:

```sql
-- Documents committed but never given a flow: the upload crashed or the start failed between COMMIT
-- and the Loom start. "No flow" = no row for the document's current-generation ingest execution in
-- the status model's table (0012). Cross-tenant by nature, so a narrow SECURITY DEFINER function
-- (owned by the migration role, which RLS does not bind) rather than a policy hole. The execution id
-- is built exactly as apps/server/app/documents/ingest.ts builds it; the sweep test pins that.
CREATE INDEX documents_created_at_idx ON documents (created_at);

CREATE FUNCTION docmind_stale_uploads(older_than interval, lookback interval, generation integer, max_rows integer)
RETURNS TABLE (tenant_id uuid, owner_id uuid, id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT d.tenant_id, d.owner_id, d.id
    FROM public.documents d
   WHERE d.created_at < now() - older_than
     AND d.created_at > now() - lookback
     AND NOT EXISTS (
       SELECT 1 FROM public.read_model_state s
        WHERE s.model_id = 'ingest-status'
          AND s.execution_id = 'u_' || d.owner_id::text || ':ingest-' || d.id::text || '.' || generation::text)
   ORDER BY d.created_at DESC
   LIMIT least(greatest(max_rows, 0), 500)
$$;
REVOKE ALL ON FUNCTION docmind_stale_uploads(interval, interval, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION docmind_stale_uploads(interval, interval, integer, integer) TO docmind_app;
```

`sweep.ts`:

```ts
import type { Pool } from "pg";
import type { StartScheduler } from "./startScheduler";
import { INGEST_GENERATION } from "./ingest";

export const STALE_UPLOAD_MS = 120_000;
export const SWEEP_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
export const SWEEP_EVERY_MS = 60_000;
export const SWEEP_BATCH = 100;

interface SweepArgs {
  pool: Pool;
  starts: StartScheduler;
  olderThanMs: number;
  lookbackMs: number;
  limit: number;
}

export async function sweepStaleUploads({ pool, starts, olderThanMs, lookbackMs, limit }: SweepArgs): Promise<number> {
  try {
    const { rows } = await pool.query<{ tenant_id: string; owner_id: string; id: string }>(
      `SELECT tenant_id, owner_id, id
         FROM docmind_stale_uploads(make_interval(secs => $1::float8), make_interval(secs => $2::float8), $3::integer, $4::integer)`,
      [olderThanMs / 1000, lookbackMs / 1000, INGEST_GENERATION, limit],
    );
    for (const r of rows) starts.fire({ tenantId: r.tenant_id, userId: r.owner_id }, r.id);
    return rows.length;
  } catch (err) {
    console.error("stale upload sweep failed", err instanceof Error ? err.constructor.name : typeof err);
    return 0;
  }
}
```

`main.ts`: run once after `server.listen` and then `setInterval(() => void sweepStaleUploads({ pool, starts, olderThanMs: STALE_UPLOAD_MS, lookbackMs: SWEEP_LOOKBACK_MS, limit: SWEEP_BATCH }), SWEEP_EVERY_MS).unref()`; clear it in `stop()`.

- [ ] **Step 4: Run to verify it passes**

Run: `export DOCMIND_TEST_PG_URL=... && pnpm --filter @docmind/server exec vitest run app/documents app/db`
Expected: PASS.

- [ ] **Step 5: Close-out**

Branch `feat/ingest-stale-upload-sweep`; subject `feat(server): sweep documents whose ingest never started`. Seam if over: the `main.ts` timer to a follow-up. Task 95b proves the Postgres-backed half end to end (a ready document is not swept, a stranded one is).

---

### Task 94a: the event stream writer

The piece of the SSE route that can be tested without a socket: `openStream` wires one response to the bus, sends each event as a frame, sends a heartbeat comment on a schedule, and ends the stream when the client stops reading or leaves. Backpressure policy (Open question 6): a write that reports a full socket buffer means the client is not reading, so the response is destroyed and the subscription ended; `EventSource` reconnects and the client re-lists documents.

**Files:**
- Create: `apps/server/app/documents/events.ts`
- Create: `apps/server/app/documents/events.test.ts`

**Interfaces:**
- Consumes: `ProgressBus`, `ProgressScope`, `InMemoryProgressBus` (73b).
- Produces: `type Schedule = (fn: () => void, ms: number) => () => void` (returns a cancel function); `intervalSchedule: Schedule` (an unref'd `setInterval`); `openStream(res: ServerResponse, onClose: (stop: () => void) => void, bus: ProgressBus, scope: ProgressScope, schedule: Schedule, heartbeatMs: number): () => void` (returns `stop`, which is idempotent).

- [ ] **Step 1: Write the failing tests**

```ts
import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { openStream } from "./events";
import { InMemoryProgressBus } from "./progress";

const bus = new InMemoryProgressBus();
const scope = { userId: randomUUID() };
const ev = (documentId = randomUUID()) => ({ documentId, step: "chunk", status: "parsing" }) as const;
const fakeResponse = (accepts: boolean) => {
  const written: string[] = [];
  const res = { write: (frame: string) => (written.push(frame), accepts), destroy: vi.fn() } as unknown as ServerResponse;
  return { res, written };
};

describe("openStream", () => {
  it("frames each event with an increasing id and the contract's JSON", () => {
    const { res, written } = fakeResponse(true);
    openStream(res, () => {}, bus, scope, () => () => {}, 15_000);
    const [a, b] = [ev(), ev()];
    bus.publish(scope, a);
    bus.publish(scope, b);
    expect(written).toEqual([
      `id: 1\nevent: progress\ndata: ${JSON.stringify(a)}\n\n`,
      `id: 2\nevent: progress\ndata: ${JSON.stringify(b)}\n\n`,
    ]);
  });

  it("sends a heartbeat comment each time the scheduler fires", () => {
    const { res, written } = fakeResponse(true);
    let beat: () => void = () => {};
    openStream(res, () => {}, bus, scope, (fn) => ((beat = fn), () => {}), 15_000);
    beat();
    expect(written).toEqual([": ping\n\n"]);
  });

  it("drops a consumer that cannot keep up: a write that reports a full buffer destroys the response and unsubscribes", () => {
    const { res, written } = fakeResponse(false);
    openStream(res, () => {}, bus, scope, () => () => {}, 15_000);
    bus.publish(scope, ev());
    bus.publish(scope, ev()); // never written: the first full buffer ended the stream
    expect(res.destroy).toHaveBeenCalledTimes(1);
    expect(written).toHaveLength(1);
  });

  it("stops the heartbeat and the subscription when the connection closes, and is safe to close twice", () => {
    const { res, written } = fakeResponse(true);
    let close: () => void = () => {};
    const cancelled = vi.fn();
    openStream(res, (fn) => (close = fn), bus, scope, () => cancelled, 15_000);
    close();
    close();
    bus.publish(scope, ev());
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(written).toEqual([]);
  });

  it("only the contract's fields reach the wire", () => {
    const { res, written } = fakeResponse(true);
    openStream(res, () => {}, bus, scope, () => () => {}, 15_000);
    bus.publish(scope, { ...ev(), filename: "secret.txt" } as never);
    expect(written[0]).not.toContain("secret");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @docmind/server exec vitest run app/documents/events.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`apps/server/app/documents/events.ts`:

```ts
import type { ServerResponse } from "node:http";
import type { ProgressBus, ProgressScope } from "./progress";

export type Schedule = (fn: () => void, ms: number) => () => void;

export const intervalSchedule: Schedule = (fn, ms) => {
  const timer = setInterval(fn, ms);
  timer.unref();
  return () => clearInterval(timer);
};

/**
 * Wires one response to the bus. Returns a function that ends it. A write that reports a full
 * socket buffer means the client is not reading: drop it (EventSource reconnects and re-lists).
 */
export function openStream(
  res: ServerResponse,
  onClose: (stop: () => void) => void,
  bus: ProgressBus,
  scope: ProgressScope,
  schedule: Schedule,
  heartbeatMs: number,
): () => void {
  let seq = 0;
  let closed = false;
  const send = (frame: string) => {
    if (closed) return;
    if (!res.write(frame)) {
      res.destroy();
      stop();
    }
  };
  const off = bus.subscribe(scope, (event) => send(`id: ${++seq}\nevent: progress\ndata: ${JSON.stringify(event)}\n\n`));
  const cancelHeartbeat = schedule(() => send(": ping\n\n"), heartbeatMs);
  function stop() {
    if (closed) return;
    closed = true;
    off();
    cancelHeartbeat();
  }
  onClose(stop);
  return stop;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @docmind/server exec vitest run app/documents/events.test.ts`
Expected: PASS.

- [ ] **Step 5: Close-out**

Branch `feat/api-event-stream-writer`; subject `feat(api): server-sent-event stream writer with backpressure`.

---

### Task 94b: `GET /api/documents/events`

Spec §5.2 progress. Authenticated by the session cookie like every route (`EventSource` sends cookies); owner-scoped (the bus key is the user); a per-user cap on open streams; no `Last-Event-ID` replay in part 1 (the document list is the source of truth after a reconnect).

**Files:**
- Modify: `apps/server/app/documents/events.ts` (the route)
- Create: `apps/server/app/documents/eventsRoute.test.ts`
- Modify: `apps/server/app/compose.ts` (mount the route)
- Modify: `apps/server/app/documents/testHarness.ts` (export `openSse`, expose `bus`, mount the route)

**Interfaces:**
- Consumes: `openStream`, `Schedule`, `intervalSchedule` (94a), `ProgressBus`, `requireAuth`, `Authenticator`.
- Produces: `documentEventRoutes(deps: { authenticator: Authenticator; bus: ProgressBus; maxStreamsPerUser?: number; heartbeatMs?: number; schedule?: Schedule }): Record<string, Handler>` defining `GET /api/documents/events`. Responses: `200 text/event-stream` (`cache-control: no-store`, `x-accel-buffering: no`), `401` from `requireAuth`, `429 {error:{code:"too_many_streams"}}` over the cap (default 4); `openSse(url, headers)` in `testHarness.ts`.

- [ ] **Step 1: Write the failing tests**

`eventsRoute.test.ts` mounts the route on `createHttpServer` with the harness `testAuthenticator` (header `x-test-user`), binds `127.0.0.1`, and reads the stream with `fetch`:

```ts
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHttpServer } from "../server";
import { documentEventRoutes } from "./events";
import { InMemoryProgressBus } from "./progress";
import { U1, U1B, U2, openSse, startDocumentServer, testAuthenticator } from "./testHarness";
import { ingestRun } from "../status/testing";

const bus = new InMemoryProgressBus();
const server = createHttpServer(documentEventRoutes({ authenticator: testAuthenticator, bus, maxStreamsPerUser: 2 }));
let base = "";
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const ev = (documentId = randomUUID()) => ({ documentId, step: "chunk", status: "parsing" }) as const;
const open = (user: string) => openSse(`${base}/api/documents/events`, { "x-test-user": user });

describe("GET /api/documents/events", () => {
  it("sends the retry hint, then each progress event of the caller's own documents as JSON", async () => {
    const s = await open("alice");
    expect(s.res.headers.get("content-type")).toBe("text/event-stream");
    expect(await s.next()).toBe("retry: 5000");
    const e = ev();
    bus.publish({ userId: U1 }, e);
    expect(await s.next()).toBe(`id: 1\nevent: progress\ndata: ${JSON.stringify(e)}`);
    s.close();
  });

  it("does not deliver another user's or another tenant's events: the first thing alice sees is her own", async () => {
    const s = await open("alice");
    await s.next();
    bus.publish({ userId: U1B }, ev()); // same tenant, other user
    bus.publish({ userId: U2 }, ev()); // other tenant
    const mine = ev();
    bus.publish({ userId: U1 }, mine);
    expect(await s.next()).toContain(mine.documentId);
    s.close();
  });

  it("answers 401 without a session", async () => {
    expect((await fetch(`${base}/api/documents/events`)).status).toBe(401);
  });

  it("allows maxStreamsPerUser streams, refuses the next with 429, and frees a slot when one closes", async () => {
    const [a, b] = [await open("alice2"), await open("alice2")];
    const refused = await fetch(`${base}/api/documents/events`, { headers: { "x-test-user": "alice2" } });
    expect([refused.status, (await refused.json()).error.code]).toEqual([429, "too_many_streams"]);
    a.close();
    await vi.waitFor(async () => {
      const again = await open("alice2");
      expect(again.res.status).toBe(200);
      again.close();
    });
    b.close();
  });

  it("is matched before the :id route, so 'events' is never treated as a document id", async () => {
    const h = await startDocumentServer(); // mounts documentRoutes and documentEventRoutes
    const res = await fetch(`${h.base}/api/documents/events`, { headers: { "x-test-user": "alice" } });
    expect([res.status, res.headers.get("content-type")]).toEqual([200, "text/event-stream"]);
    await res.body?.cancel();
    await h.close();
  });

  it("delivers what the status model publishes after it has folded real log events", async () => {
    const h = await startDocumentServer();
    const mine = await openSse(`${h.base}/api/documents/events`, { "x-test-user": "alice" });
    expect(await mine.next()).toBe("retry: 5000");
    const documentId = randomUUID();
    for (const e of ingestRun(`u_${U1}:ingest-${documentId}.2`, "parsed")) h.status.onEvent(e);
    expect(await mine.next()).toBe(`id: 1\nevent: progress\ndata: ${JSON.stringify({ documentId, step: "parse", status: "parsing" })}`);
    mine.close();
    await h.close();
  });
});
```

`alice2` maps to `ALICE2` in `testAuthenticator`, which lets the cap test use a user no other test uses. `openSse` is added to `testHarness.ts` in this task (Task 95 reuses it):

```ts
/** Opens a server-sent-event stream; `next()` resolves with the next complete frame, without its blank line. */
export async function openSse(url: string, headers: Record<string, string>) {
  const controller = new AbortController();
  const res = await fetch(url, { headers, signal: controller.signal });
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const next = async (): Promise<string> => {
    while (!buffer.includes("\n\n")) {
      const { value, done } = (await reader?.read()) ?? { done: true, value: undefined };
      if (done) throw new Error("stream ended");
      buffer += decoder.decode(value);
    }
    const end = buffer.indexOf("\n\n");
    const frame = buffer.slice(0, end);
    buffer = buffer.slice(end + 2);
    return frame;
  };
  return { res, next, close: () => controller.abort() };
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @docmind/server exec vitest run app/documents/eventsRoute.test.ts`
Expected: FAIL (`documentEventRoutes` is not exported).

- [ ] **Step 3: Implement**

Add to `events.ts` (imports `Authenticator`, `requireAuth`, `Handler`, `sendError` as in the other route files):

```ts
export interface EventRoutesDeps {
  authenticator: Authenticator;
  bus: ProgressBus;
  maxStreamsPerUser?: number;
  heartbeatMs?: number;
  schedule?: Schedule;
}

export function documentEventRoutes(deps: EventRoutesDeps): Record<string, Handler> {
  const open = new Map<string, number>(); // streams per user, owned by this route set (no module global)
  return {
    "GET /api/documents/events": requireAuth(deps.authenticator, (req, res, identity) => {
      const count = open.get(identity.userId) ?? 0;
      if (count >= (deps.maxStreamsPerUser ?? 4)) {
        return sendError(res, 429, "too_many_streams", "too many open event streams");
      }
      open.set(identity.userId, count + 1);
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      });
      res.write("retry: 5000\n\n");
      let released = false;
      openStream(
        res,
        (stop) => {
          const end = () => {
            stop();
            if (released) return;
            released = true;
            const left = (open.get(identity.userId) ?? 1) - 1;
            if (left <= 0) open.delete(identity.userId);
            else open.set(identity.userId, left);
          };
          req.on("close", end);
          res.on("close", end);
        },
        deps.bus,
        { userId: identity.userId },
        deps.schedule ?? intervalSchedule,
        deps.heartbeatMs ?? 15_000,
      );
    }),
  };
}
```

`compose.ts` spreads `...documentEventRoutes({ authenticator, bus: options.ingest.bus })` into `createHttpServer` after `documentRoutes`; `testHarness.ts` mounts the same route on `h.bus` (the bus its status model publishes to, Task 79c).

- [ ] **Step 4: Run to verify they pass**

Run: `export DOCMIND_TEST_PG_URL=... && pnpm --filter @docmind/server exec vitest run app/documents`
Expected: PASS.

- [ ] **Step 5: Close-out**

Branch `feat/api-document-events`; subject `feat(api): GET /api/documents/events progress stream`.

---

### Task 95a: acceptance stack and the txt upload to `ready`

The runnable result of part 1: sign up over real HTTP, upload a txt, watch it reach `ready` on the SSE stream, find sealed chunks with embeddings, and (in Task 95b) see failures end `failed` with fixed messages, deletes cascade and the sweep recover stranded uploads. The stack is the production composition (`buildServer`) with the real child-process parser (needs `pnpm build` first, which the gate runs), the fake Ollama server, Loom on durable Postgres storage, the pg `chunks` table, and the pgvector store when the extension exists (otherwise the in-memory twin over the real `chunks` table; the test names say which ran).

**Files:**
- Create: `apps/server/app/documents/ingestStack.ts` (shared by 95a and 95b)
- Create: `apps/server/app/documents/ingest.e2e.pg.test.ts`
- Modify: `apps/server/app/documents/testHarness.ts` (`twinOverPgChunks`)

**Interfaces:**
- Consumes: everything above; `buildServer`, `openDurableStorage`, `PostgresKeyStore`, `startFakeOllama`, `hasVector`, `createIngestWiring`, `openSse`, `pgStatusWriter`, `pgStatusReaderFor` (74e; the real two-role stores, so the acceptance test exercises the `0012` policies end to end).
- Produces: `startIngestStack(): Promise<IngestStack>` with `interface IngestStack { base: string; db: TestDb; app: Pool; keys: PostgresKeyStore; fields: FieldCrypto; durable: DurableStorage; fake: FakeOllama; composed: ReturnType<typeof buildServer>; root: string; vector: boolean; signUpAndLogIn(email: string): Promise<{ cookie: string; userId: string; tenantId: string }>; upload(cookie: string, name: string, data: Uint8Array): Promise<Response>; events(cookie: string): ReturnType<typeof openSse>; until(stream, documentId: string, done: (status: string) => boolean): Promise<{ step: string; status: string; detail?: string }[]>; close(): Promise<void> }`; `twinOverPgChunks(app: Pool, wiring: IngestWiring): InMemoryChunkVectors` (Task 91's `chunkIds` query packaged as a function); `assertEventsAreContentFree` comes from Task 81's `flows/ingest-document/testing.ts`.

- [ ] **Step 1: Write the failing test**

`ingestStack.ts` (the `beforeAll`/`afterAll` and helper bodies in one place; `PASSWORD = "correct horse battery"`; `interface IngestStack` is exactly the one under Produces):

```ts
export async function startIngestStack(): Promise<IngestStack> {
  const db = await createTestDb();
  await migrate(db.owner);
  await setAppRolePassword(db.owner, APP_PASSWORD);
  await setRolePassword(db.owner, "docmind_loom", LOOM_PASSWORD);
  const vector = await hasVector(db.owner);
  const app = new Pool({ connectionString: db.appUrl });
  const root = mkdtempSync(join(tmpdir(), "dm-ingest-e2e-"));
  const keys = new PostgresKeyStore(app, [{ id: "kek-1", key: createSecretKey(randomBytes(32)) }]);
  const fields = new FieldCrypto(keys);
  const durable = await openDurableStorage({ loomUrl: db.loomUrl, keys });
  const dimensions = vector ? 768 : 64; // the migration fixes 768 where pgvector exists
  const fake = await startFakeOllama({ dimensions, model: "fake-embed" });
  const wiring = createIngestWiring({
    DOCMIND_OLLAMA_URL: fake.url,
    DOCMIND_EMBED_MODEL: "fake-embed",
    DOCMIND_EMBED_DIMENSIONS: String(dimensions),
  });
  const composed = buildServer({
    pool: app,
    keys,
    storage: durable.storage,
    crypto: durable.crypto,
    limits: loadLimits({}),
    blobRoot: loadBlobRoot({ DOCMIND_BLOB_DIR: root }),
    secureCookies: false,
    trustProxy: false,
    ingest: wiring,
    status: { writer: pgStatusWriter(durable.pool), readerFor: pgStatusReaderFor(app), source: durable.storage.eventStore },
    // pgvector where it exists (the production store); otherwise the twin over the real chunks table
    ...(vector ? {} : { vectors: twinOverPgChunks(app, wiring) }),
  });
  await composed.status.boot(); // register, then catch up, before serving (ADR 0132 D13)
  await new Promise<void>((resolve) => composed.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(composed.server.address() as AddressInfo).port}`;

  const PASSWORD = "correct horse battery";
  async function signUpAndLogIn(email: string) {
    const post = (path: string) =>
      fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
    if ((await post("/api/auth/sign-up")).status !== 202) throw new Error("sign-up was not accepted");
    const cookie = ((await post("/api/auth/login")).headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const { rows } = await db.owner.query("SELECT id, tenant_id FROM users WHERE email = $1", [email]);
    return { cookie, userId: rows[0].id as string, tenantId: rows[0].tenant_id as string };
  }
  const upload = (cookie: string, name: string, data: Uint8Array) => {
    const form = new FormData();
    form.append("file", new Blob([data]), name);
    return fetch(`${base}/api/documents`, { method: "POST", headers: { cookie }, body: form });
  };
  const events = (cookie: string) => openSse(`${base}/api/documents/events`, { cookie });
  /** Reads progress events until one satisfies `done`, returning every event for that document. */
  async function until(stream: Awaited<ReturnType<typeof events>>, id: string, done: (status: string) => boolean) {
    const seen: { step: string; status: string; detail?: string }[] = [];
    for (;;) {
      const frame = await stream.next();
      const data = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!data) continue; // the retry hint and heartbeats
      const event = JSON.parse(data.slice(6));
      if (event.documentId !== id) continue;
      seen.push(event);
      if (done(event.status)) return seen;
    }
  }

  return {
    base, db, app, keys, fields, durable, fake, composed, root, vector,
    signUpAndLogIn, upload, events, until,
    async close() {
      await composed.starts.idle();
      await composed.status.close();
      await new Promise<void>((resolve) => {
        composed.server.close(() => resolve());
        composed.server.closeAllConnections();
      });
      await composed.app.close();
      await durable.close();
      await fake.close();
      await app.end();
      await db.drop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
```

`ingest.e2e.pg.test.ts`:

```ts
const SENTENCE = "Nocturne quarterly revenue forecast: seventeen thousand dollars.";
const LONG_TEXT = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}. ${SENTENCE} ${"lorem ipsum dolor sit amet ".repeat(14)}`).join("\n\n");
const WAIT = 30_000;

describe.skipIf(!PG_URL)("M3 part 1 acceptance: a txt upload reaches ready (needs DOCMIND_TEST_PG_URL)", () => {
  let st: IngestStack;
  beforeAll(async () => {
    st = await startIngestStack();
  });
  afterAll(async () => {
    await st?.close();
  });
  it("signs up, uploads a txt, sees progress over SSE until ready, and ends with sealed chunks and vectors", async () => {
    const ada = await st.signUpAndLogIn("ada@example.com");
    const stream = await st.events(ada.cookie);
    const res = await st.upload(ada.cookie, "notes.txt", Buffer.from(LONG_TEXT));
    expect(res.status).toBe(201);
    const id = ((await res.json()) as UploadDocumentResponse).document.id;

    const seen = await st.until(stream, id, (status) => status === "ready" || status === "failed");
    stream.close();
    // one event per step start, and `ready` when finalize's completion is folded (so finalize appears twice)
    expect(seen.map((e) => e.step)).toEqual(["parse", "chunk", "embed", "analyze", "summarize", "link", "finalize", "finalize"]);
    expect(seen.map((e) => e.status)).toEqual(["parsing", "parsing", "embedding", "embedding", "embedding", "embedding", "embedding", "ready"]);

    const doc = (await (await fetch(`${st.base}/api/documents/${id}`, { headers: { cookie: ada.cookie } })).json()) as DocumentDto;
    expect([doc.status, doc.error]).toEqual(["ready", null]); // GET /:id: the model, refreshed from the log
    // the list reads the model through the tenant-bound reader, under row-level security
    const list = (await (await fetch(`${st.base}/api/documents`, { headers: { cookie: ada.cookie } })).json()) as ListDocumentsResponse;
    expect(list.items.find((d) => d.id === id)?.status).toBe("ready");
    // and the folded row itself is keyed by the document and scoped to the user, holding enums only
    expect((await st.db.owner.query("SELECT app_key, scope, state FROM read_model_state WHERE app_key = $1", [id])).rows).toEqual([
      { app_key: id, scope: ada.userId, state: { status: "ready", step: "finalize", code: null } },
    ]);

    const chunks = (await st.db.owner.query("SELECT id, text_enc, locator FROM chunks WHERE document_id = $1 ORDER BY ordinal", [id])).rows;
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.text_enc.__loomEnc === "loom/aes-256-gcm")).toBe(true);
    expect(chunks.every((c) => c.locator.kind === "chars")).toBe(true);
    const first = (await st.fields.forUser(ada.userId).open(chunkBind(chunks[0].id), chunks[0].text_enc)) as { text: string };
    expect(first.text).toContain(SENTENCE);
    expect(await st.composed.vectors.missing({ tenantId: ada.tenantId, ownerId: ada.userId }, id, 1000)).toEqual([]); // every chunk has its vector
    expect((await st.db.owner.query("SELECT 1 FROM parsed_documents WHERE document_id = $1", [id])).rowCount).toBe(0);

    // the raw event log of that ingest holds ids, outcomes, counts and the model id only
    assertEventsAreContentFree(await st.durable.raw.eventStore.read(ingestExecutionId(ada.userId, id)));
  }, WAIT);

  it("shows another user nothing: not the document, not its events", async () => {
    const grace = await st.signUpAndLogIn("grace@example.com");
    const stream = await st.events(grace.cookie);
    const mine = await st.upload(grace.cookie, "mine.txt", Buffer.from(LONG_TEXT.replace("Nocturne", "Graceful")));
    const myId = ((await mine.json()) as UploadDocumentResponse).document.id;
    const seen = await st.until(stream, myId, (status) => status === "ready");
    stream.close();
    expect(seen.at(-1)?.status).toBe("ready");
    const ada = (await st.db.owner.query("SELECT id FROM documents WHERE owner_id <> $1", [grace.userId])).rows[0].id;
    expect((await fetch(`${st.base}/api/documents/${ada}`, { headers: { cookie: grace.cookie } })).status).toBe(404);
    const graces = (await (await fetch(`${st.base}/api/documents`, { headers: { cookie: grace.cookie } })).json()) as ListDocumentsResponse;
    expect(graces.items.map((d) => d.id)).toEqual([myId]); // her list, statuses and all, holds only her document
  }, WAIT);
});
```

Test names for the vector path say which store ran: add `${st.vector ? "pgvector" : "in-memory twin"}` to the first test's title. (Imports: `PG_URL`, `UploadDocumentResponse`, `DocumentDto`, `ListDocumentsResponse`, `chunkBind`, `ingestExecutionId`, `assertEventsAreContentFree`, `startIngestStack`, `IngestStack`, and vitest's `describe/it/expect/beforeAll/afterAll`.)

- [ ] **Step 2: Run to verify it fails**

Run: `export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:55432/postgres && pnpm build && pnpm --filter @docmind/server exec vitest run app/documents/ingest.e2e.pg.test.ts`
Expected: FAIL only where Tasks 63-94b left a gap (a missing export, a status that does not match); this file is the integration check of the stack. A first run that passes unchanged is the best outcome; investigate any pass that took a shortcut.

- [ ] **Step 3: Implement**

Fix what the run exposes in the owning module, not in the test.

- [ ] **Step 4: Run to verify it passes, twice**

Run the file on 55432 (the twin path runs) and once more against a pgvector database (`docker compose up -d postgres`, URL on 5432) so the `PgChunkVectorStore` path runs end to end. Expected: PASS both times; report both in the PR (if Docker is unavailable, say so and rely on CI's pgvector service).

- [ ] **Step 5: Close-out**

Branch `test/api-ingest-acceptance`; subject `test(api): M3 part 1 acceptance, txt upload to ready`.

---

### Task 95b: acceptance: delete, race and sweep, and `.env.example`

**Files:**
- Modify: `apps/server/app/documents/ingest.e2e.pg.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `IngestStack` (95a), `sweepStaleUploads` (93), `FakeOllama.hold/release` (86).
- Produces: `.env.example` entries `DOCMIND_PARSE_TIMEOUT_MS=30000`, `DOCMIND_PARSE_MEMORY_MB=512`, `DOCMIND_PARSE_MAX_CHARS=20000000`, `DOCMIND_PARSE_CONCURRENCY=2`, `DOCMIND_OLLAMA_URL=http://127.0.0.1:11434`, `DOCMIND_EMBED_MODEL=nomic-embed-text`, `DOCMIND_EMBED_DIMENSIONS=768`, `DOCMIND_EMBED_TIMEOUT_MS=30000`, each commented out with its default.

- [ ] **Step 1: Write the failing test**

Inside the same `describe`:

```ts
  it("ends a binary file named .txt as failed with the parser's fixed message and stores no chunks", async () => {
    const user = await st.signUpAndLogIn("binary@example.com");
    const stream = await st.events(user.cookie);
    const bytes = Uint8Array.from([0xff, 0xfe, 0x41, 0x00, 0xff, 0xff, 0x00, 0xd8]); // UTF-16 BOM, then a noncharacter and a lone surrogate
    const id = ((await (await st.upload(user.cookie, "data.txt", bytes)).json()) as UploadDocumentResponse).document.id;
    const seen = await st.until(stream, id, (status) => status === "failed");
    stream.close();
    expect(seen.at(-1)).toMatchObject({ step: "parse", status: "failed", detail: "corrupt_content" });
    const doc = (await (await fetch(`${st.base}/api/documents/${id}`, { headers: { cookie: user.cookie } })).json()) as DocumentDto;
    expect([doc.status, doc.error]).toEqual(["failed", STATUS_MESSAGES.corrupt_content]);
    expect((await st.db.owner.query("SELECT 1 FROM chunks WHERE document_id = $1", [id])).rowCount).toBe(0);
  }, WAIT);

  it("ends a pdf as failed with unsupported_content until part 2 adds the parser", async () => {
    const user = await st.signUpAndLogIn("pdf@example.com");
    const stream = await st.events(user.cookie);
    const id = ((await (await st.upload(user.cookie, "report.pdf", PDF("acceptance"))).json()) as UploadDocumentResponse).document.id;
    const seen = await st.until(stream, id, (status) => status === "failed");
    stream.close();
    expect(seen.at(-1)).toMatchObject({ step: "parse", status: "failed", detail: "unsupported_content" });
  }, WAIT);

  it("deleting a ready document removes its chunks and sealed parse by cascade and its blob", async () => {
    const user = await st.signUpAndLogIn("delete@example.com");
    const stream = await st.events(user.cookie);
    const id = ((await (await st.upload(user.cookie, "gone.txt", Buffer.from(LONG_TEXT.replace("Nocturne", "Vanishing")))).json()) as UploadDocumentResponse).document.id;
    await st.until(stream, id, (status) => status === "ready");
    stream.close();
    expect((await fetch(`${st.base}/api/documents/${id}`, { method: "DELETE", headers: { cookie: user.cookie } })).status).toBe(204);
    expect((await st.db.owner.query("SELECT 1 FROM chunks WHERE document_id = $1", [id])).rowCount).toBe(0);
    expect(filesUnder(st.root).filter((f) => f.parentPath.includes(user.userId))).toEqual([]);
    await expectTombstoned(id); // the status rows are erased, keeping ids only
  }, WAIT);

  it("a delete while the embed step is in flight cancels the execution and leaves no rows behind", async () => {
    const user = await st.signUpAndLogIn("race@example.com");
    const arrived = st.fake.hold(); // the next embed request parks at the gate
    const id = ((await (await st.upload(user.cookie, "race.txt", Buffer.from(LONG_TEXT.replace("Nocturne", "Racing")))).json()) as UploadDocumentResponse).document.id;
    await arrived; // the embed step is now waiting on the embedder
    expect((await fetch(`${st.base}/api/documents/${id}`, { method: "DELETE", headers: { cookie: user.cookie } })).status).toBe(204);
    st.fake.release();
    const principal = { tenant: user.tenantId, actor: user.userId };
    await vi.waitFor(async () => {
      const state = await st.composed.app.runtime.loadState(ingestExecutionId(user.userId, id), { principal });
      expect(state.status).toBe("cancelled");
    });
    for (const table of ["documents", "chunks", "parsed_documents"]) {
      const column = table === "documents" ? "id" : "document_id";
      expect((await st.db.owner.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [id])).rowCount).toBe(0);
    }
    await expectTombstoned(id);
  }, WAIT);

  it("the sweep starts a document stranded in uploaded and it reaches ready", async () => {
    const user = await st.signUpAndLogIn("sweep@example.com");
    // Written the way an upload would, but with no flow start: store the blob, insert the row, backdate it.
    const stream = await st.events(user.cookie);
    const store = new EncryptedFsContentStore({ root: st.root, tenantId: user.tenantId, userId: user.userId, keys: st.keys, maxBytes: 1 << 20 });
    const bytes = Buffer.from(LONG_TEXT.replace("Nocturne", "Stranded"));
    const ref = await store.put(bytes);
    const doc = await newDocument(st.fields, user.tenantId, user.userId, "9".repeat(64), { contentAddress: ref.__loomContent, mime: "text/plain", sizeBytes: bytes.length });
    await withTenant(st.app, user.tenantId, (tx) => insertDocument(tx, doc));
    await st.db.owner.query("UPDATE documents SET created_at = now() - interval '10 minutes' WHERE id = $1", [doc.id]);
    const sweep = { pool: st.app, starts: st.composed.starts, olderThanMs: 120_000, lookbackMs: 604_800_000, limit: 10 };
    expect(await sweepStaleUploads(sweep)).toBeGreaterThanOrEqual(1);
    const seen = await st.until(stream, doc.id, (status) => status === "ready");
    stream.close();
    expect(seen.at(-1)?.status).toBe("ready");
    // now it has a row in the status table, so no later sweep asks for it again (nor for any other document of this run)
    await st.composed.status.close();
    expect(await sweepStaleUploads(sweep)).toBe(0);
  }, WAIT);
});
```

Notes: `expectTombstoned(id)` is a small helper in the test file: `const rows = (await st.db.owner.query("SELECT erased, state FROM read_model_state WHERE app_key = $1", [id])).rows; expect(rows.length).toBeGreaterThan(0); expect(rows.every((r) => r.erased === true && r.state === null)).toBe(true);`. `filesUnder` is M2's helper (`readdirSync(root, { recursive: true, withFileTypes: true })` filtered to files); the sweep case imports `EncryptedFsContentStore`, `newDocument`, `insertDocument`, `withTenant` and `sweepStaleUploads`; the `mime: "application/pdf"` default of `newDocument` is overridden there because the parse step selects the parser by mime.

- [ ] **Step 2: Run to verify it fails**

Run: `export DOCMIND_TEST_PG_URL=... && pnpm build && pnpm --filter @docmind/server exec vitest run app/documents/ingest.e2e.pg.test.ts`
Expected: FAIL only where a gap remains; as in 95a.

- [ ] **Step 3: Implement**

Fix what the run exposes in the owning module. Add the `.env.example` entries.

- [ ] **Step 4: Run to verify it passes, twice**

As in 95a (twin path, then a pgvector database).

- [ ] **Step 5: Close-out**

Branch `test/api-ingest-acceptance-delete-sweep`; subject `test(api): M3 part 1 acceptance, delete race and sweep`. This is the last PR of part 1.

---

## Self-review

**Spec coverage.** Item 12 (interface, registry, conformance, txt): Tasks 66-68. Item 13 (sandboxed runner, limits): Tasks 69a-70, with the `@loom/plugin-sandbox` correction (F1, D1). Item 14 (flow skeleton, status projection, progress SSE): Tasks 73a, 74a-74e, 75c, 79b-79c, 80, 92, 94a-94b (the status projection is Loom's folded model, Revision 2026-10-19). Item 21 (chunk step, `chunks` table): Tasks 64, 71-72, 82-83. Item 22 (Ollama provider and suite): Tasks 85-86. Item 23 (`vector-pg`, embed step): Tasks 84, 87-91. Carry-forwards: 1 sweep and stub executions (Tasks 76, 93), 2 `document_gone` everywhere (Task 73a, plus each step's own tests and the pg race tests in Tasks 83 and 95b), 3 composite key (Task 64), 4 sensitive paths and the raw event-log proof (Tasks 80-81, 83, 91, 92, 95a), 5 deps through `buildServer` (Tasks 79, 91), 6 ratchet (Task 63), 7 `deriveKey` (D9, deliberately not done), 8 bounded start (Task 77), 9 UTF-16 bypass (Task 68). Linked retrieval: chunk ids are deterministic (D4), `chunks` has `ordinal`, `section_ordinal` and a numeric locator, `chunks` has `UNIQUE (tenant_id, id)` for the later `chunk_links` composite foreign keys, the `link` step exists as a placeholder, and `deriveKey` is left for the step that needs it. Out of scope and designed to slot in: md/org/docx/doc/pdf/image parsers (append to `createDefaultParsers`, add fixtures to the kit), analyze/summarize/link (replace three entries in `ingestEffects`), retry policy and retry endpoint (`TransientIngestError`, `FAILURE_CODES`, execution generations, `PermanentIngestError` -> `failed` already exist), fair scheduling (the child runner's `maxConcurrent` is the per-process cap; per-tenant fairness sits in front of `runtime.start`).

**Placeholder scan.** Tests and implementations are printed for every task except where a change is a small edit to a file shown earlier (harness wiring in Tasks 77, 79, 79b, 79c, 91 and 94b, `flow.ts` step appends in Tasks 83, 91 and 92, package manifests); those are described precisely enough to apply (file, symbol, what changes). The assertions of the M2 pg tests that Task 80 must change are named but not printed; the executor reads those files in the same step, and Task 80 is flagged as the size exception partly for that reason. Anything that turns out ambiguous on contact with the code is a question for the owner, not a guess.

**Type consistency.** `IngestStartInput` is the `ref` everywhere; `StepResult` is every step's output; `StepGuard.begin(ref, step)` matches `PgStepGuard` (75c) and every fake (78, 80, 83, 90, 92); `IngestStatus` implements `DocumentStatusReads` (74e) exactly as the routes use it (79c); `StatusView`, `UPLOADED` and `viewOf` (74b) are what `toDto` takes; `progressOf` (74d) is what the publisher sends and Task 94b frames; `ingestKeyOf`/`ingestScopeOf` (74b) parse exactly what `ingestExecutionId` (76) builds, and the sweep's SQL (93) builds the same string again, pinned by a test; `ChunkStore.replace/count/read` match Tasks 82, 83, 90, 92; `ChunkVectorStore.upsert(scope, documentId, items)` matches Tasks 87-90 (the twin, the kit, the pg store and the embed step); `ingestExecutionId(userId, documentId, generation?)` matches Tasks 63, 76, 80, 95; `ParseLimits` grows across 69a (`wallClockMs`, `memoryMb`), 69b (`maxInputBytes`, `maxChars`) and matches `loadParseLimits` in Task 79; `PgIngestArgs` is `{ pool, fields, blobs, wiring }` in Task 80 and gains `vectors` in Task 91; the step ids are `ingest-parse`, `ingest-chunk`, `ingest-embed`, `ingest-analyze`, `ingest-summarize`, `ingest-link`, `ingest-finalize` in `flow.ts`, `deps.ts` and `security.ts`.

**Revision self-review (2026-10-19).** *Spec coverage:* the brief's items map to tasks as follows: model, key and scope (74b); the tables, RLS policy on `scope`, grants and `manageSchema: false` (74a, 74e); wiring through `buildServer`, boot order, `onEvent`, `liveSource`, sensitive union, compaction exemption (79b); list page then `getFoldedByKey`, read-your-writes with `refreshFrom` (74c, 79c); SSE after the fold (74d); the `documents.status` decision (79c, `0013`); erasure by key, by scope (74e, 79c); the sweep (93); acceptance on the real roles (95a, 95b). *Loom API:* every name used exists in the Loom checkout at `006dfdaf`: `projection$` (`@loom/core`), `ReadModelService.{registerFolded, handleEvent, catchUp, getMany, purgeFolded, drain}`, `InMemoryReadModelStore`, `foldedStates`, `mergeSensitive`, `sensitiveMapFromCovers`, `ReadModelStore.{getFoldedByKey, getFolded, applyFolded}`, `FoldedApply`, `PostgresReadModelStore(pool, { schema, manageSchema })`, `foldedStateDdl` (`@loom/plugin-postgres`), `sensitivePathsFromSteps` (`@loom/plugin-crypto`), `EventStore.sealingCapability`, `defineConfig({ observability.onEvent, durability.retention.compactionExempt })`. *Not used on purpose:* `service.getManyByKey` (it runs as the writer role, Revision R5). *Placeholders:* none; the prose-only edits are the harness, `compose.ts`, `main.ts` and `config.ts` changes of 79b and 79c, each with the file, the symbol and the code that changes. *Types:* `StatusCode = FailureCode | "internal"` (74b) is the only code type the model, `STATUS_MESSAGES`, `viewOf` and the DTO use; `IngestStatusOptions.bus` becomes required in 74d, and 74c's tests are edited there.

## Owner decisions

Settled 2026-10-19: the owner accepted the recommended default for each question below (except question 4, replaced by the Revision 2026-10-19 section and the questions at the end of this file), and chose to build pgvector into the local test cluster (see Preconditions).

1. **Parser sandbox: child process instead of `@loom/plugin-sandbox` (spec §3.2, §5.2).** `@loom/plugin-sandbox` is a QuickJS evaluator of JSON-in/JSON-out scripts and cannot host `mammoth`, `unpdf` or `word-extractor`. Default: `ParseRunner`, a `child_process.fork` under Node's `--permission` (no filesystem beyond its own code, no child processes, empty environment), `--max-old-space-size` 512 MB, 30 s wall clock then `SIGKILL`, 2 concurrent. Residual risk: Node 22/24's permission model does not restrict network, so a compromised parser library could open sockets; mitigate in deployment (no secrets on the host's reachable network from that user) or move to a container per parse later. The spec lines are corrected in Task 70. Alternative: drop the permission model for a plain worker thread (weaker, simpler).
2. **Embedding model and dimension.** Default: `nomic-embed-text`, **768** dimensions, `vector(768)` fixed by migration `0014`; provider `modelId` `ollama/nomic-embed-text`. nomic recommends `search_document:` and `search_query:` prefixes; the `EmbeddingProvider` SPI has no document/query distinction, so part 1 sends texts unprefixed and M4 decides how to embed queries (a provider option or a second method). A different model size is a new migration plus the resumable re-embed (`missing` already treats a changed `modelId` as work to do).
3. **Chunk size and tokenizer.** Default: `ceil(characters / 4)` as the token estimate (no tokenizer dependency), target 600 tokens = 2400 characters, overlap 15% = 360 characters, paragraphs never split unless longer than the target. An exact tokenizer (the embedding model's) is a drop-in replacement for `estimateTokens` if retrieval quality demands it; the 8192-token nomic context makes the estimate safe.
4. **`documents.status` as a "projection". Replaced 2026-10-19 (see Revision 2026-10-19).** The owner decided that the status must use Loom's folded-state read models (ADR 0132). The status is the state of an `ingest-status` folded model, folded from the flow's events, read by the routes and published to SSE after each fold; no step writes it and `documents.status` is dropped. The questions that decision left open are at the end of this file. (The earlier answer, a status written by each step's effect, is withdrawn.)
5. **Locator content (spec §4.2).** Heading paths are content, so the plaintext `chunks.locator` holds numbers only (kind and offsets/page), the heading path is sealed inside `text_enc`, and a plaintext integer `section_ordinal` carries the section tree id for linked retrieval's `structure` links. Default: accept. Alternative: seal the whole locator and add a plaintext section column anyway.
6. **SSE auth, backpressure and resume.** Default: session cookie auth like every route; events scoped to tenant and user; at most 4 concurrent streams per user (429 beyond); heartbeat comment every 15 s; a consumer whose socket buffer fills is dropped (the browser's `EventSource` reconnects and re-lists documents); no `Last-Event-ID` replay in part 1 because the document list is authoritative; in-process bus (one server process). Alternatives: replay from a small ring buffer, or Postgres `LISTEN/NOTIFY` for multiple processes.
7. **What happens to M2 stub executions.** Default: nothing is migrated. The stub wrote nothing and completes in milliseconds; the new flow uses execution generation 2 (`...ingest-<doc>.2`), delete cancels generations 1 and 2, and the stale-upload sweep starts documents still in `uploaded`. A stub execution that is somehow still live when the new flow is deployed fails on recovery with a determinism error and writes nothing; cancel any such executions before the first deploy that contains Task 80 if there are shared dev databases. Alternative: a one-off script that cancels all generation-1 executions.
8. **Interim states between merged PRs.** Because the flow grows one step per PR (Tasks 80, 83, 91, 92), a document stays in `parsing`/`embedding` on `main` until Task 92 merges. Default: the owner merges Tasks 63-95b in order before any release; nothing is deployed from the middle of the stack. Alternative: hold the flow swap (Task 80) until the chunk and embed steps are ready and merge steps 78-92 as library code first (more half-built-but-unreachable code on `main`).
9. **Non-UTF text files.** Default: strict UTF-8 and UTF-16 (BOM or BOM-less ASCII-range), anything else is `corrupt_content`. Windows-1252 and other legacy encodings are common in old `.txt` files; a heuristic fallback is a follow-up if real uploads need it.
10. **Parsed-text size cap.** Default: 20 million characters (about the text of a 50 MB file); a larger result is the permanent failure `too_large`. It bounds the sealed `parsed_documents` row (Decision D2).
11. **Size waiver for Task 80.** The flow swap (Task 80) deletes the stub and its tests and updates the harness and two pg tests in the same change, so it is the one task expected over the line limit (about 250 changed lines, 9 to 10 files). Default: approve a one-time waiver. Alternative: the partial split described in that task's close-out, which still leaves the task near the limit.

---

## Open questions for the owner (revision)

Each has a recommended default; the plan is written to the defaults.

R1. **Which database and schema hold the folded tables?** Default: DocMind's own database, schema `public`, created by DocMind migration `0012` and owned by the migrator; written by `docmind_loom` (the existing Loom pool, `FOR ALL` policy on those two tables only) and read by `docmind_app` through a tenant policy (`scope` -> `users` -> `app_tenant_id()`). Why: the server refuses to start if `docmind_loom` owns a table with row-level security, the policy needs `users`, and the sweep can anti-join the table. Alternatives: schema `loom` (rejected for those reasons, and `docmind_app` would need access to schema `loom`), or a separate database (no policy join to `users`, no anti-join, a second connection to run and back up).
R2. **Does `documents.status` keep `uploaded`?** Default: no. Both `status` and `error` are dropped (`0013`); a document with no row in the model is `uploaded`, and the stale-upload sweep finds documents with no generation-2 row. Why: a column nothing writes after the upload is a second source of truth that can disagree with the log. Alternative: keep `status` with `CHECK (status = 'uploaded')` as a pre-flow marker and make the sweep select on it (a smaller sweep query, a column that never changes).
R3. **Where does SSE publish?** Default: `IngestStatus` publishes after the fold has landed (a chain over `drain()`), derived from the log event, so effects know nothing of the bus. Alternative: the step effect publishes after its work, as the previous design did (no `drain` latency, but progress can run ahead of the log, and nothing publishes for recovered or kernel-recorded events).
R4. **Loom's folded models fold every execution, and have no execution filter.** Default: accept inert rows (no key, no scope, state = the initial state) for non-ingest executions now, and ask Loom for an optional `accepts(executionId)` on the folded definition before the first non-ingest flow ships (M4). Alternative: hold M3a for that Loom change.
R5. **What should the server do when the boot catch-up fails?** Default: refuse to start (`IngestStatus.boot()` throws, `main` closes everything and exits). Why: catch-up is shared, so one poisoned execution would otherwise leave every status stale without a signal. Alternative: start, serve reads from whatever is folded, log the failure by class, and retry catch-up on a timer.
