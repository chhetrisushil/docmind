# DocMind M2 (Document storage) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After M2, a signed-in user can upload a document (txt, md, org, doc, docx, pdf, png, jpg, webp) to `POST /api/documents`, list their documents (`GET /api/documents`, paged), read one (`GET /api/documents/:id`) and delete one (`DELETE /api/documents/:id`); the type is decided from magic bytes, the size and the tenant's quotas are enforced while the file streams in, identical bytes from the same user are stored once (found by a **keyed** fingerprint, not a plain hash), the original bytes are envelope-encrypted under the user's data key in a filesystem `ContentStore`, titles, filenames and (later) stats and summaries are encrypted in Postgres, and everything is tenant-isolated by row-level security and shaped so that the later `DELETE /api/me` can remove a user's rows, then blobs, then key. A stub `ingest-document` Loom flow is started after each new upload commits (spec §5.1 step 4) and cancelled when the document is deleted. M2 also closes the three M1 carry-forwards (sensitive event paths, `x:` and child execution ids, `executionIdFor`).

**Architecture:** `packages/blob-store` implements Loom's `ContentStore` SPI (`@loom/plugin-content`) as one instance per user: bytes are addressed by `hmac-sha256:<fingerprint>`, where the fingerprint is HMAC-SHA256 of the plaintext under a key derived (HKDF) from the user's data key; they are sealed with a per-blob random key that is itself wrapped by the user's data key (from the `KeyStore`), and written atomically to `<root>/<tenant>/<user>/<fingerprint>`; a two-phase `stage()`/`commit()` lets the upload handler decide, inside a database transaction, whether the blob is kept. The server adds a `documents` table (migration 0009, RLS like every other table, `*_enc` columns including `stats_enc` sealed with Loom's `encryptValue` bound to the row and column), a streaming multipart reader on `busboy`, a pure magic-byte sniffer, per-tenant quotas checked under a per-tenant advisory lock, the four document routes behind `requireAuth`, and the `ingest-document` stub flow (`apps/server/app/flows/ingest-document/`) with an `IngestPort` that starts it (execution id `executionIdFor(userId, "ingest-" + documentId)`, input = ids only) after the upload transaction commits and cancels it before a delete.

**Tech Stack:** everything in M0 and M1, plus `busboy` ^1.6.0 and `@types/busboy` ^1.5.4 (multipart), `@loom/core` (flow, step and handler builders for the stub flow), and the Loom package `@loom/plugin-content` (the `ContentStore` SPI), all linked from `../loom` at commit `8f9eab2492c85bb994d746855f06d2eccc9f45db` like the others.

**Spec:** `/Users/such/workspace/docmind/docs/specs/2026-10-18-docmind-design.md` (§3 layout and interfaces, §4 tables, tenancy, quotas and crypto-shredding, §5.1 upload, §5.2 `ingest-document` flow, §6.1 conventions, §8 gates and PR rules, §9 M2 = items 9-11 and the start/cancel half of M3 item 14). M1 plan (model for structure, and source of the carry-forwards): `/Users/such/workspace/docmind/docs/superpowers/plans/2026-10-18-m1-identity-and-keys.md`. Accepted direction for M3/M4 that M2 must not block: `/Users/such/workspace/docmind/docs/design/linked-retrieval.md`. Executors read all of them.

## Global Constraints

Copied from the spec and the owner's standing rules; every task includes them.

- **PR size:** at most **200 changed lines and 10 files** per PR (one task = one PR). `pnpm-lock.yaml`, the generated `apps/server/app/loom.gen.ts` and binary fixtures do not count but are listed in the PR description. A PR that cannot fit is split, never stretched; each task's close-out step measures it and says where to split.
- **PR rules:** each PR leaves `main` green with no half-built reachable path; tests ship in the same PR as the code; branch names `feat/<area>-<thing>`; Conventional Commits; PRs are **stacked** (each branch is cut from the previous task's branch), opened as **drafts** (`gh pr create --draft`; CI skips drafts), get an independent code review, and the owner merges them with **rebase and merge** (`gh pr merge --rebase`, never squash or a merge commit). Executors never merge.
- **Commit trailer:** every commit ends with the line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Every PR description ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **The local gate is the merge gate:** `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`, with `DOCMIND_TEST_PG_URL` exported **in the same shell command** so the Postgres suites run instead of skipping (test database on `127.0.0.1:55432`, see Preconditions). A task whose Postgres suite is skipped has not passed its gate.
- **Test hygiene (Loom's AGENTS.md):** no sleeps (wait on conditions); test servers bind `127.0.0.1`; no timing assertions in `*.test.ts`; test files are typechecked (`typecheck:tests`); every Postgres suite creates its own database with `createTestDb()`.
- **Never log, print, return in an error, or put in a test name or snapshot:** `DATABASE_URL`, `LOOM_DATABASE_URL`, passwords, the KEK or any data key (including the derived fingerprint key), emails, session tokens, **filenames, titles or document content**. Error messages name variables (`DOCMIND_TENANT_MAX_BYTES must be a positive integer`), never values. `.env.example` holds placeholders only. Server logs for a failed upload or a failed flow start carry the error class and the request path, never the filename.
- **Tenancy:** RLS on every table (`tenant_id = app_tenant_id()`), every query runs inside `withTenant`; the app role `docmind_app` owns no tables and has no `BYPASSRLS`; nothing downstream accepts a tenant or user id from the client (they come from the `Authenticator`); any lookup that must happen before a tenant is known goes through a `SECURITY DEFINER` function with `SET search_path = pg_catalog, pg_temp`, schema-qualified names, `REVOKE ALL ... FROM PUBLIC` and an explicit `GRANT EXECUTE ... TO docmind_app` (M2 needs none).
- **Encryption (spec §4.4):** `*_enc` columns (`title_enc`, `filename_enc`, `stats_enc`, `summary_enc`) are AEAD under the owning user's data key (subject = the user id); blobs are envelope-encrypted under the user's data key; the blob path is `<tenant>/<user>/<fingerprint>` where **fingerprint = HMAC-SHA256(plaintext) under a key HKDF-derived from the user's data key** (label `docmind-fingerprint-v1`) - an intentional deviation from spec §5.1 step 3's "sha256 fingerprint"; deduplication happens only within one user. A key is only ever obtained from the `KeyStore`; no code path logs or returns a plaintext data key or the derived fingerprint key.
- **Untrusted input:** uploaded bytes, multipart headers, part names and filenames are untrusted. Size caps are enforced **while streaming**; the type comes from magic bytes (the extension is only a hint); **no path is ever built from a client string** (blob paths are built from validated UUIDs and a 64-hex fingerprint); filenames are sanitized before they are stored and never reach the filesystem or a log.
- **Execution ids (M1 carry-forward):** every execution start and every `runtime.fork` for a user passes an explicit `executionId` built by `executionIdFor(userId, name)`; `name` never carries user content (execution ids are plaintext and survive erasure). Task 42 adds a ratchet test; the `ingest-document` start (Tasks 54 and 56) is its first real user.
- **Event payloads (M1 carry-forward):** any event path that can carry user content (filenames, titles, document text, summaries, questions) must be registered as sensitive in `apps/server/app/sensitive.ts` (or derived from `sensitive(...)` step schemas) **in the same PR that adds the flow**; flow start inputs carry ids only, never a filename or title. The M2 `ingest-document` stub has start input `{ tenantId, userId, documentId }` (three UUIDs) and step output `{ outcome }` (a two-value enum): nothing in it can carry user content, so it registers no paths, and Task 53 pins that with tests that fail if a content-bearing field is ever added without registering it.
- **Flow lifecycle:** a document's ingest execution is started **after** the upload transaction commits (never inside it), exactly once per new document (idempotency key = the document id, realised as the caller-chosen execution id, which Loom makes start-once); a failed start never fails the upload. A delete **cancels the execution first**, then removes the row and the blob; a flow step that finds its document gone stops cleanly (outcome `document_gone`, not a failure).
- **Erasure shape:** document rows reference `users` with `ON DELETE CASCADE`; blobs live under one directory per user; so erasing a user is "delete the user (cascades their rows) -> `eraseUserBlobs` -> destroy the key", each step idempotent. The key destroyed last is also the one the fingerprints derive from, so afterwards a fingerprint can no longer be computed or tested.
- **Migrations:** never edit an applied migration; the next free number is `0009` (this plan adds exactly one). Every table has RLS enabled (the M0 guard test fails otherwise).
- **Dependency rules:** packages never import from apps; only `loom.config.ts`, `app/config.ts` and `app/main.ts` choose which implementation backs an interface.
- **Toolchain pins:** `pnpm@9.14.4`, `@biomejs/biome` `1.9.4` (exact), `typescript` `^5.6.3`, `vitest` `^2.1.8`, Node `>=20.0.0`.
- **Decision D1 (from the M1 plan):** `apps/web` consumes `@docmind/contracts` through a Vite alias to its TypeScript source, so contracts source stays free of Node-only imports. M2 changes no contracts source.

---

## Verified facts this plan relies on

Read from the Loom checkout at `/Users/such/workspace/loom` (HEAD `8f9eab24`) and from `main` of this repo (`7641d01`) on 2026-10-18. **Unlike the M1 plan, the code below was not replayed branch by branch**: it is written against the real signatures listed here, but the executor's first red/green run is the real check. The places most likely to need a small fix are listed under "Uncertain" at the end of this section.

### Loom

| Need | Real shape | Where |
|---|---|---|
| ContentStore SPI | `interface ContentStore { put(bytes: Uint8Array): Promise<ContentRef>; putStream?(stream: AsyncIterable<Uint8Array>): Promise<ContentRef>; get(ref): Promise<Uint8Array \| null>; getMany?; delete(ref): Promise<void>; deleteIfUntouchedSince?; listPage?; touchClock?; touch? }`. `ContentRef = { readonly __loomContent: string /* "sha256:<hex>" in the default scheme */; readonly size?: number; readonly codec?: string }`. `get` MUST return `null` (never throw) on absence; `delete` is idempotent physical erasure; `put` is idempotent by address. `contentAddress(bytes)` = `sha256:<hex>` of the bytes is a helper, not a requirement of the SPI; only `CachingContentStore` re-hashes, and only for addresses that start with `sha256:`. The SPI 1.3.0 optionals (`deleteIfUntouchedSince`, `listPage`, `touchClock`) are "all three or none". | `plugins/content/src/ContentStore.ts`, `content.ts`, `CachingContentStore.ts:146`; exported from `@loom/plugin-content` |
| ContentStore contract suite | `runContentStoreConformance(factory: () => ContentStoreLike, label?, { clocked? })` from `@loom/conformance` (registers vitest tests: round trip, idempotent put, distinct refs, `get` of `sha256:deadbeef` is `null`, idempotent delete, `putStream` address equals `put` address, plus optional-method checks that are skipped when a method is absent). **It compares addresses only with each other** (equal for equal bytes, different for different bytes) and never recomputes `sha256` of the plaintext, so a keyed address passes; the one literal it uses is the absent ref `sha256:deadbeef`, which our `parseAddress` rejects, so `get` answers `null`. | `packages/conformance/src/index.ts:3039` |
| Field envelope | `encryptValue(key: Buffer, value: unknown, aad?: { v: string; bind: string }): Envelope` and `decryptValue(key, envelope, bind?)` from `@loom/plugin-crypto`: AES-256-GCM, random IV, JSON value, AAD bound to a context string; `decryptValue` **passes a non-envelope through unchanged** (so DocMind checks the shape itself, Task 48). | `plugins/crypto/src/crypto.ts:76-120` |
| KeyStore | `getOrCreate(subjectId): Promise<Buffer>` (the raw 32-byte data key; refuses a destroyed subject), `get(subjectId): Promise<Buffer \| null>`, `destroy`, `wasDestroyed`. **The raw DEK is exposed**, so a purpose-specific key can be derived from it with HKDF (Node `crypto.hkdfSync`) and no `KeyStore` change or extra key table is needed. `InMemoryKeyStore` (no constructor arguments) is the test double. | `plugins/crypto/src/keystore.ts` |
| Child execution ids | A `::`-derived child is `<parent>::<segment>`; a continue-as-new successor is `<root>~<n>`; a user-owned id is `u_<uuid>:<name>`. `subjectOfExecution` (M1) matches `^u_(uuid)(?::|$)`, so children and successors of a user's execution keep the user subject; Task 42 pins that with tests. | `apps/server/app/subject.ts` |
| Sensitive event paths | `EncryptingEventStore` takes `sensitive: Record<eventType, string[]>`; `sensitivePathsFromSteps(steps)` derives `STEP_COMPLETED -> output.<path>` from `sensitive(...)` step output schemas (returns `{}` when none is marked). M1 passes `sensitive: {}`. | `plugins/crypto/src/EncryptingEventStore.ts`, `derive.ts` |
| Flows | A flow is `{ definition: flow$({ id, name, version, inputSchema, outputSchema, steps }), runner }` (`RegisteredFlow` from `@loom/workflow-runtime`); a step is `step$({ id, name, inputSchema, outputSchema, handler: handler$(async (input, ctx) => ...) })` (`flow$`, `step$`, `handler$` from `@loom/core`; `ctx` carries `executionId`, `stepId`, `attempt`); the runner calls `ctx.run(step, input)`. `loom gen --dir app` (`pnpm --filter @docmind/server gen`) scans `app/flows/<name>/flow.ts` and writes `app/loom.gen.ts`, whose `flowModules` M0 already passes to `defineConfig`. Under `security.strict` the `authorizer` (a `GrantTable` keyed by **workflow id**) must list the step ids a flow may run (a step id doubles as its tool id). | `tools/scaffold/src/templates.ts` (flow and security templates), `packages/core/src/builders/step.ts`, `packages/app/src/registerFlows.ts` |
| Start, idempotency, cancel | `runtime.start(flow, input, { executionId, principal })` returns an `ExecutionHandle` (`executionId`, `waitForCompletion`, `getState`, `cancel`) without waiting for the body. With a caller-chosen `executionId` start is **start-once**: a second start rejects with `ExecutionAlreadyExistsError` (exported from `@loom/workflow-runtime`) and nothing runs. `runtime.cancel(executionId, reason?, { principal })` cancels by id (aborts a live run, or fences then appends `EXECUTION_CANCELLED`); returns `true` if it cancelled, `false` if the execution was already terminal, and **throws `Error("No execution found for id: ...")`** for an unknown id. The M0 `executionAuthorizer` (`requireTenant: true`, `cancel: "owner"`) needs a principal `{ tenant, actor }`; the actor that started an execution owns it. | `packages/workflow-runtime/src/WorkflowRuntime.ts:2953` (`cancel`), `:3349` (`start`), `types.ts:405` (`RunOptions`), `types.ts:835`, `:1151` |

### This repo (M1, on `main`)

`createHttpServer(extraRoutes)` routes by exact `"METHOD /path"` keys (no path parameters yet: Task 58 adds them); `Handler = (req, res) => void | Promise<void>`; `json`, `sendError(res, status, code, message)` in `app/http/respond.ts`; `requireAuth(authenticator, (req, res, identity) => ...)` in `app/http/requireAuth.ts`; `Identity = { tenantId, userId }` from `@docmind/auth`; `withTenant(pool, tenantId, fn)` in `app/db/tenant.ts`; migrations `0001-0008` (last: `0008_loom_role.sql`); `createTestDb()`, `PG_URL`, `APP_PASSWORD` in `app/db/testSupport.ts`; `migrate`, `setAppRolePassword` in `app/db/migrate.ts`; `createDurableStorage({ loomUrl, keys })` in `app/storage.ts` (passes `sensitive: {}`); `buildApp(storage, crypto?)` in `app/config.ts` (already passes `flowModules` from `app/loom.gen.ts`, currently empty) and `authorizer`/`executionAuthorizer` in `app/security.ts` (`authorizer` is an empty `GrantTable`); `PostgresKeyStore` and `loadKeks` from `@docmind/keystore-pg` (a KEK rotation re-wraps data keys and leaves each DEK unchanged, so keys derived from a DEK are stable across rotations); `DocumentDto`, `UploadDocumentResponse`, `ListDocumentsQuery`, `ListDocumentsResponse`, `DocumentStats`, `DocumentSummary` already exist in `packages/contracts/src/documents.ts` and are used unchanged. The session cookie is `SameSite=Lax`, which is what keeps a cross-site HTML form (the one cross-origin way to send `multipart/form-data`) from carrying the session to `POST /api/documents`.

### Uncertain (verify on the first run; each has a stated fallback)

1. **busboy option and event names** (`defParamCharset`, `limits.*`, the `file` event signature `(name, stream, { filename })`, the `limit` event on the file stream, the `close` event). Written from busboy 1.6 documentation. If a name differs, adjust Task 51 only.
2. **`runContentStoreConformance` accepting a store with none of the SPI 1.3.0 optionals.** The kit documents them as optional ("when supported"); if it does not, implement `touchClock`/`listPage`/`deleteIfUntouchedSince` over directory mtimes in Task 45a and say so in the PR. (The keyed `hmac-sha256:` address is *not* a risk here: the kit never recomputes a sha256, see the table above.)
3. **`pnpm` resolving `@loom/plugin-content` and `@loom/core` through the new root overrides** (Task 43 adds the first, Task 53 the second, next to the others). If `pnpm install` complains, run it from the repo root with `--no-frozen-lockfile` once and commit the lockfile.
4. **Flow authoring names** (new): `flow$`/`step$`/`handler$` import paths and option names, `ctx.run(step, input)`, that `loom gen` emits `flowModules` entries for `app/flows/ingest-document/flow.ts` exporting `ingestDocumentFlow`, and that the `GrantTable` key is the workflow id (`ingest-document`) and the grant the step id (`ingest-begin`). Written from Loom's scaffold templates. If a name differs, adjust Task 53 only; the `IngestPort` hides the rest.
5. **Start and cancel semantics** (new): that `runtime.start` resolves with a handle before the step body finishes (if it waits for completion, fire it without `await` in `loomIngest` and attach `.catch`, and say so in the PR); that a caller-chosen duplicate id rejects with `ExecutionAlreadyExistsError`; the option shape `{ executionId, principal: { tenant, actor } }` for start and `{ principal }` for cancel; and that "no such execution" is only detectable by the message `No execution found for id` (there is no typed error). If the message differs, `loomIngest.cancel` must still treat "unknown execution" as success: adjust the matcher in Task 54 and keep its test.
6. **Process-global flow dependencies** (new): flows are static modules (`loom gen`), so the stub step reads its database access from a module-level holder (`setIngestDeps`). Test harnesses that coexist in one test file share the last one set; only tests that assert flow outcomes (Tasks 53, 56, 60) own the single live harness. If the executor finds a per-app injection point in `defineConfig`, prefer it and drop the holder.
7. **`hkdfSync` return type** (new): Node returns an `ArrayBuffer`; the code wraps it in `Buffer.from`. Nothing else about Node's HKDF is relied on.

## Deviations from the spec, decisions, and what is still open

Decided here (and, where it was an open question, by the owner: see "Decisions (owner, 2026-10-18)" at the end) so executors are not blocked.

1. **The blob store is one instance per user, and its addresses are keyed.** Spec §3.1 says `ContentStore` is "encrypted filesystem" with path `<tenant>/<user>/<sha256>`. `ContentStore.put(bytes)` has no user parameter, so `EncryptedFsContentStore` is constructed with `{ root, tenantId, userId, keys }` and the server builds one per request (cheap: no I/O in the constructor). **Intentional deviation from spec §5.1 step 3 and §4.1:** the "sha256 fingerprint" is replaced by `HMAC-SHA256(plaintext)` under a key derived from the user's data key. The content address is `hmac-sha256:<64 hex>`; `documents.fingerprint` is the bare hex, `documents.content_address` the full address, and the blob file name the hex. Why HKDF-from-the-DEK rather than a separate wrapped per-user fingerprint key: `KeyStore.getOrCreate` already returns the raw DEK, so deriving costs no schema change, no second key to wrap, rotate or destroy, and destroying the DEK (erasure step 4) destroys the fingerprint key with it, which is exactly "after erasure the fingerprints cannot be tested". HKDF with a fixed label keeps the HMAC key independent of the AES uses of the same DEK (Loom's event/field encryption, the blob key wrap). A separate wrapped key was rejected because it adds a table and a destroy step that could drift from the DEK's. Loom's `contentAddress()` helper and `CachingContentStore` assume `sha256:`; the store uses neither, its scheme prefix differs on purpose, and the conformance kit passes because it only compares addresses with each other.
2. **Blob format** (`DMB1`): `magic(4) | wrapIv(12) | wrapTag(16) | wrappedBlobKey(32) | bodyIv(12) | ciphertext | bodyTag(16)`. A random 32-byte blob key encrypts the body (AES-256-GCM, streamable); the user's data key wraps the blob key. Both AEAD operations authenticate `docmind-blob-v1\0<tenant>/<user>`, so a file copied into another user's directory fails to open. The keyed fingerprint is re-checked after decryption, so a file renamed to another address also fails. Loom's `encryptValue` is not used here because it seals a JSON value in memory; blobs need streaming binary.
3. **Two-phase writes (`stage` / `commit`).** The upload handler streams into a temp file (fingerprinting and sealing as it goes), then, **inside the database transaction and under a per-tenant advisory lock**, checks duplicates and quotas, inserts the row and only then renames the blob into place. Delete takes the same lock for its row and blob removal, so a delete cannot unlink a blob that a concurrent upload of the same bytes has just decided to reuse. Residual: if `COMMIT` itself fails after the blob was removed (connection loss), the row survives without its blob and a retry of the delete finishes the job; if it fails after a *new* blob was committed, the handler deletes that blob. The flow is started only after `COMMIT` succeeded, so a rolled-back upload never has an execution.
4. **`*_enc` columns are `jsonb`** holding Loom's envelope (`encryptValue`), bound to `<userId>|document:<documentId>:<column>` so an envelope moved to another row or column fails to open. This reuses Loom's cipher instead of adding another. **`stats_enc` replaces the spec's plaintext `stats jsonb`** (owner decision 6): outline, dates and numbers derive from content. M2 never writes it (the analyze step is M3); `toDto` already opens it.
5. **Sniffing rules** (Task 49): PDF `%PDF-` at offset 0; PNG, JPEG and WebP by signature (the bytes decide the type even if the extension disagrees); OLE2 (`D0CF11E0A1B11AE1`) is accepted only as `.doc` and ZIP (`PK\x03\x04`) only as `.docx` (the container alone does not say which Office format it is, and xls/pptx share them); anything else must look like text (no NUL or control bytes in the first 4 KiB, or a UTF-16 BOM) *and* have a `.txt`, `.md`/`.markdown` or `.org` extension. Empty files are rejected. Deep validation of docx/pdf happens in the M3 parsers inside the sandbox.
6. **Quotas** (Task 50/57, accepted by the owner): per file `DOCMIND_MAX_UPLOAD_BYTES` (default 50 MiB, spec §4.3), per tenant `DOCMIND_TENANT_MAX_BYTES` (default 1 GiB) and `DOCMIND_TENANT_MAX_DOCUMENTS` (default 500), plus at most `DOCMIND_MAX_CONCURRENT_UPLOADS` (default 2) uploads in flight per user per process. The same limits apply to every tenant; per-tenant overrides are not built (no schema for it yet).
7. **Statuses and the flow.** M2 inserts rows as `uploaded` and, once the transaction commits, starts the `ingest-document` stub flow (spec §5.1 step 4; owner decision 1). The stub is the smallest honest skeleton of spec §5.2: one durable step `ingest-begin` that confirms the document still exists and **writes nothing**, so the status stays `uploaded`; its output is `{ outcome: "accepted" | "document_gone" }`. **Reconciled with the spec's M3 item 14 ("flow skeleton, status projection, progress SSE")**: M2 delivers flow registration, the grants entry, the start-after-commit call, the execution id and idempotency convention, ids-only input, the sensitive-path rule and its tests, cancel-on-delete and the "document gone" clean stop. M3 item 14 therefore shrinks to: replace `ingest-begin` with the §5.2 step list (`parse`, `chunk`, `embed`, `analyze`, `summarize`, `finalize` as durable `step$`s, empty bodies in item 14), reuse the same `documentExists` guard at the top of each step, add the status projection and the progress SSE, and add the sweep that starts the flow for documents left in `uploaded` with no execution (a crash between commit and start; M2 only re-attempts the start when the same bytes are uploaded again, see Task 56). Loom pins an in-flight execution to its flow body fingerprint, so a stub execution that is still running when M3 changes the flow is not silently upgraded; M3 item 14 must decide whether to cancel and restart them (recommended: the sweep cancels stub executions of documents still `uploaded` and starts a new one under a name carrying a counter, never content).
8. **HTTP codes.** `201` new document, `200` duplicate (same `UploadDocumentResponse` shape with `duplicate: true`), `400 invalid_request` (not a single `file` part, malformed multipart), `401`, `403 quota_exceeded`, `413 payload_too_large`, `415 unsupported_media_type` (not multipart) and `415 unsupported_type` (sniffed type not supported), `429 too_many_uploads` with `Retry-After`; `GET`/`DELETE` of someone else's document or a non-UUID id is the same `404 not_found` as a missing one; `DELETE` is `204`, and `404` once the document is gone (a repeated delete is safe: it changes nothing and cancels nothing again).
9. **Known trade-offs added to spec §4.4's list** (to be copied into the M7 runbook): (a) `documents.fingerprint`, `content_address` and the blob file name are now keyed hashes, so a holder of a backup or the disk can no longer test whether a *known* file was uploaded (they would need the user's data key); backups of the rows still hold the fingerprints until retention ends, and they are meaningless once the key is destroyed. (b) `documents.stats_enc` is sealed from the start. (c) `documents.error` is plaintext, so it must only ever hold fixed, non-content messages, never a filename or document text. (d) The `ingest-document` start input and execution id carry the tenant, user and document UUIDs in plaintext in the event log (execution ids always do); they are pseudonymous identifiers, not user content, and the execution's sealed data is erased with the key.
10. **Carried to M3:** replace the stub steps as described in item 7; read blobs with `EncryptedFsContentStore.get`; register the flow's sensitive paths in `sensitive.ts` in the PR that adds any content-bearing output; write `stats_enc` from the analyze step. The execution-id convention, the cancel-on-delete and the start-after-commit are already in place.
11. **Carried to M5 (`DELETE /api/me`):** `docmind_app` cannot delete from `tenants` or `users` today (0003 revokes tenant insert/delete; user deletion needs a `SECURITY DEFINER` function), so M5 adds that function; the cascade from `users` removes `documents`; `eraseUserBlobs` (Task 46a) removes the files; `app.eraseSubject(userId)` (liveness-gated, so it waits for the user's ingest executions; the delete route's cancel does the same job per document) and `KeyStore.destroy` do the rest. Task 61 proves the cascade and the blob step in a test.

## Preconditions (once, before Task 42)

- [ ] **Step 1: Confirm M1 is on `main` and branch the stack**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git status --short && git log --oneline -1
```

Expected: no output from `status`; HEAD is `ef8eae1` or a descendant (the plan commit `docs/m2-plan` may sit on top).

- [ ] **Step 2: Loom has what M2 links to, built**

```bash
git -C /Users/such/workspace/loom rev-parse HEAD
command ls /Users/such/workspace/loom/plugins/content/dist/index.js \
  /Users/such/workspace/loom/plugins/crypto/dist/index.js \
  /Users/such/workspace/loom/packages/core/dist/index.js \
  /Users/such/workspace/loom/packages/conformance/dist/index.js
```

Expected: `8f9eab2492c85bb994d746855f06d2eccc9f45db` (or a descendant) and the four files listed. If any is missing, run `pnpm install && pnpm build` in `/Users/such/workspace/loom`.

- [ ] **Step 3: A superuser Postgres on 55432 for the test suites**

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:55432/postgres
psql "$DOCMIND_TEST_PG_URL" -c 'select 1'
```

Expected: one row. (Use whatever superuser URL the local test cluster takes; the suites create and drop a database of their own. Do not commit the URL.) Every gate command below is meant to run in a shell where this variable is exported **in the same command line** (`export ... && pnpm test`).

## PR index

| Task | Branch | Delivers | Est. changed lines / files |
|---|---|---|---|
| 42 | `feat/server-event-path-registry` | `sensitive.ts` registry wired into the event store; `x:` and child-id tests; `executionIdFor` ratchet | ~150 / 6 |
| 43 | `feat/blob-store-envelope` | `packages/blob-store` scaffold, streaming blob envelope | ~190 / 8 |
| 44 | `feat/blob-store-fingerprint` | HKDF-derived fingerprint key, HMAC fingerprint, `hmac-sha256:` address format | ~90 / 3 |
| 45a | `feat/blob-store-fs` | `EncryptedFsContentStore` (stage/commit, put, get, delete, keyed addresses) passing the ContentStore conformance suite | ~175 / 4 |
| 45b | `test/blob-store-fs-layout` | layout, keyed-address and stage/commit tests | ~70 / 1 |
| 46a | `feat/blob-store-maintenance` | `eraseUserBlobs`, `removeStaleTemp` | ~115 / 3 |
| 46b | `test/blob-store-hardening` | size cap, tamper, cross-user, hostile-ref and destroyed-key tests | ~125 / 1 |
| 47 | `feat/db-documents-table` | migration 0009 `documents` (with `stats_enc`) + RLS + isolation tests | ~145 / 2 |
| 48 | `feat/server-field-crypto` | `FieldCrypto` for `*_enc` columns | ~120 / 2 |
| 49 | `feat/server-upload-sniff` | magic-byte sniffer, filename sanitizer | ~190 / 2 |
| 50 | `feat/server-upload-limits` | limits from env, `peek`, `.env.example`, `.gitignore` | ~150 / 6 |
| 51 | `feat/server-multipart` | busboy-based single-file reader | ~200 / 5 |
| 52a | `feat/server-documents-repo` | documents repository (insert, find, DTO incl. `stats_enc`), harness basics | ~190 / 3 |
| 52b | `feat/server-documents-tenant-usage` | `lockTenantForWrite`, `usageOfTenant` | ~110 / 2 |
| 53 | `feat/flow-ingest-document-stub` | `ingest-document` stub flow, grants, `loom gen` output, ids-only and no-sensitive-path tests | ~170 / 7 |
| 54 | `feat/server-ingest-port` | `IngestPort` over the Loom runtime (start-once, cancel-by-id), Postgres deps for the stub step | ~175 / 4 |
| 55a | `feat/api-document-upload` | `POST /api/documents` (keyed dedup), upload harness | ~185 / 3 |
| 55b | `test/api-upload-dedup` | dedup, cross-user and keyed-name tests | ~75 / 1 |
| 56 | `feat/api-upload-starts-ingest` | start `ingest-document` after the upload commits; `main.ts` wiring (routes, flow deps, stale temp cleanup) | ~180 / 5 |
| 57 | `feat/api-upload-quotas` | quotas, per-user in-flight cap, rejection and cleanup tests | ~200 / 4 |
| 58 | `feat/server-route-params` | path parameters in the router | ~90 / 5 |
| 59 | `feat/api-document-read` | `GET /api/documents`, `GET /api/documents/:id` | ~200 / 4 |
| 60 | `feat/api-document-delete` | `DELETE /api/documents/:id`: cancel the flow, then row and blob; in-flight and repeated-delete tests | ~190 / 3 |
| 61 | `test/api-delete-race-erasure` | upload/delete race test and the erasure-shape test | ~90 / 1 |
| 62 | `test/api-documents-e2e` | M2 acceptance test over real auth, with the flow | ~170 / 1 |

**Sizes are estimated by eye; the code was not replayed.** Tasks 45, 46, 52 and 55 were split into a/b pairs in this revision because their counted code exceeded the limit once the owner's decisions were applied; the lettered tasks keep their place in the stack (a before b). Several others are still close to the limit and the tests are the bulk of most of them. If `git diff --stat` shows more than 200 changed lines or 10 files (lockfile and generated files excluded), split exactly as follows rather than trimming tests: Task 43 -> envelope tests in a second PR; Task 49 -> `sanitizeFilename`/`titleFromFilename` in their own PR; Task 54 -> `pgDeps.ts` and its test in their own PR before it; Task 56 -> the `main.ts` wiring and `removeStaleTemp` call in their own PR after it; Task 57 -> `inFlight.ts` and its test become their own PR before it; Task 59 -> `GET /api/documents/:id` becomes its own PR after the list endpoint; Task 60 -> the in-flight and repeated-delete tests become their own PR after it. A further split keeps its number with the next letter.

---

### Task 42: sensitive event paths, `x:` and child execution ids, and the `executionIdFor` ratchet

Closes M1 carry-forwards 1-3. M2's one flow (the `ingest-document` stub, Task 53) carries ids only, so there is nothing to register *yet*; this task makes the registry the single, tested place every later flow must extend, proves the two execution-id cases M1 left untested, and adds a guard so a runtime start or fork that bypasses `executionIdFor` fails the build.

**Files:**
- Create: `apps/server/app/sensitive.ts`
- Create: `apps/server/app/executionIds.test.ts`
- Modify: `apps/server/app/storage.ts` (the `DurableStorageOptions` interface and the `EncryptingEventStore` options)
- Modify: `apps/server/app/storage.test.ts` (add three tests)
- Modify: `apps/server/app/subject.test.ts` (add one test)

**Interfaces:**
- Consumes: `createDurableStorage({ loomUrl, keys })`, `executionIdFor`, `subjectOfExecution` (M1).
- Produces: `SENSITIVE_EVENT_PATHS: Readonly<Record<string, readonly string[]>>` from `app/sensitive.ts`; `DurableStorageOptions.sensitive?: Readonly<Record<string, readonly string[]>>` (defaults to `SENSITIVE_EVENT_PATHS`).

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/app/subject.test.ts`, inside the `describe("erasure subject of an execution", ...)` block:

```ts
  it("keeps the user for Loom's :: children and ~n continue-as-new successors", () => {
    const parent = executionIdFor(USER, "ingest-1");
    for (const executionId of [`${parent}::step#0`, `${parent}::a::b#2`, `${parent}~1`]) {
      expect(subjectOfExecution({ executionId })).toBe(USER);
    }
  });
```

Create `apps/server/app/executionIds.test.ts`:

```ts
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const APP = resolve(__dirname);
// A call that starts or forks an execution. The runtime would otherwise mint a ULID, and the
// execution's data would fall outside the user's key (see subject.ts).
// Only the runtime's own start/fork: a method named `start` on some other object (the `IngestPort` in
// Task 54, whose single implementation sits in a file that also calls `executionIdFor(`) is not one.
const STARTS = /[Rr]untime\s*\.\s*(?:start|startExecution|fork)\s*\(/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    const isSource = path.endsWith(".ts") && !path.endsWith(".test.ts");
    return isSource && entry.name !== "loom.gen.ts" ? [path] : [];
  });
}

describe("execution ids", () => {
  it("the pattern recognises a start and a fork", () => {
    expect(STARTS.test("await runtime.start(def, { executionId })")).toBe(true);
    expect(STARTS.test("runtime\n  .fork(id, 3)")).toBe(true);
    expect(STARTS.test("server.listen(0)")).toBe(false);
    expect(STARTS.test("await deps.ingest.start(identity, documentId)")).toBe(false);
  });

  it("every source file that starts or forks an execution builds the id with executionIdFor", () => {
    const offenders = sources(APP)
      .filter((file) => {
        const text = readFileSync(file, "utf8");
        return STARTS.test(text) && !text.includes("executionIdFor(");
      })
      .map((file) => file.slice(APP.length + 1));
    expect(offenders).toEqual([]);
  });
});
```

In `apps/server/app/storage.test.ts`, inside the first `describe.skipIf(!PG_URL)` block (after the "seals each user's events" test), add:

```ts
  it("seals and reads an execution no user owns, under its own x: key", async () => {
    const exec = `system-sweep-${randomUUID()}`;
    await stores.sealed.eventStore.append(note(exec, "system secret"));

    expect((await stores.sealed.eventStore.read(exec))[0]?.payload).toMatchObject({
      text: "system secret",
    });
    const stored = (await stores.raw.eventStore.read(exec))[0]?.payload as { text: object };
    expect(JSON.stringify(stored.text)).not.toContain("system secret");
    const { rows } = await db.owner.query(
      "SELECT subject_id FROM data_keys WHERE subject_id = $1",
      [`x:${exec}`],
    );
    expect(rows).toEqual([{ subject_id: `x:${exec}` }]);
  });

  it("keeps a Loom child execution of a user's execution under that user's key", async () => {
    const user = randomUUID();
    const parent = executionIdFor(user, "ingest-1");
    const child = `${parent}::step#0`;
    await stores.sealed.eventStore.append(note(child, "child secret"));

    expect((await stores.sealed.eventStore.read(child))[0]?.payload).toMatchObject({
      text: "child secret",
    });
    const { rows } = await db.owner.query(
      "SELECT subject_id FROM data_keys WHERE subject_id = ANY($1)",
      [[user, `x:${child}`]],
    );
    expect(rows).toEqual([{ subject_id: user }]);

    await shredSubject(keys, stores.raw.eventStore, child, {
      subjectId: user,
      executionIds: [child],
      snapshotStore: stores.raw.snapshotStore,
    });
    await expect(stores.sealed.eventStore.read(child)).rejects.toBeInstanceOf(PayloadShreddedError);
  });

  it("seals the paths it is given at construction, not only those registered afterwards", async () => {
    const custom = createDurableStorage({
      loomUrl: db.loomUrl,
      keys,
      sensitive: { DOC_NAMED: ["filename"] },
    });
    try {
      const exec = executionIdFor(randomUUID(), "named");
      await custom.sealed.eventStore.append({
        ...note(exec, "unused"),
        eventType: "DOC_NAMED",
        payload: { filename: "tax-return.pdf", documentId: "d1" },
      });
      const raw = (await custom.raw.eventStore.read(exec))[0]?.payload as {
        filename: object;
        documentId: string;
      };
      expect(JSON.stringify(raw.filename)).not.toContain("tax-return");
      expect(raw.documentId).toBe("d1");
    } finally {
      await custom.storage.eventStore.close?.();
      await custom.close();
    }
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `export DOCMIND_TEST_PG_URL=<superuser url> && pnpm --filter @docmind/server exec vitest run app/storage.test.ts app/subject.test.ts app/executionIds.test.ts`
Expected: the `sensitive` option test FAILS (the option is ignored, `filename` is stored in the clear, and `tsc` would also reject the unknown option); the other new tests pass already (they pin behaviour M1 shipped).

- [ ] **Step 3: Implement**

Create `apps/server/app/sensitive.ts`:

```ts
/**
 * Event paths that can carry user content, sealed in the log under the owning user's key.
 *
 * Rules for every flow, agent or tool added later (M3 onwards):
 *  - a flow's start input carries ids only (the `ingest-document` stub: `{ tenantId, userId, documentId }`), never a filename, title or text;
 *  - any step output or event field that can hold user content (document text, summaries, questions,
 *    answers) is listed here, or marked `sensitive(...)` in its schema and derived with
 *    `sensitivePathsFromSteps`; add it in the SAME PR that adds the flow, because an event written
 *    before its path is registered stays readable in the clear forever;
 *  - execution ids are plaintext and survive erasure, so they never contain user content either.
 *
 * M2's only flow (`ingest-document`, Task 53) has a start input of three UUIDs and a two-value enum
 * output, so nothing is registered yet; Task 53's tests fail if that stops being true.
 */
export const SENSITIVE_EVENT_PATHS: Readonly<Record<string, readonly string[]>> = {};
```

In `apps/server/app/storage.ts`, add the import and the option:

```ts
import { SENSITIVE_EVENT_PATHS } from "./sensitive";
```

```ts
export interface DurableStorageOptions {
  loomUrl: string;
  keys: KeyStore;
  /** Event paths to seal, per event type. Defaults to `SENSITIVE_EVENT_PATHS`. */
  sensitive?: Readonly<Record<string, readonly string[]>>;
}
```

Change the function head and the event store construction:

```ts
export function createDurableStorage({
  loomUrl,
  keys,
  sensitive = SENSITIVE_EVENT_PATHS,
}: DurableStorageOptions): DurableStorage {
```

```ts
  const events = new EncryptingEventStore(pg.eventStore, keys, {
    sensitive: { ...sensitive },
    subjectOf: subjectOfExecution,
  });
```

`openDurableStorage` already passes its whole options object to `createDurableStorage`, so it needs no change.

- [ ] **Step 4: Run to verify they pass**

Run: `export DOCMIND_TEST_PG_URL=<superuser url> && pnpm --filter @docmind/server exec vitest run app/storage.test.ts app/subject.test.ts app/executionIds.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate, measure, commit**

```bash
export DOCMIND_TEST_PG_URL=<superuser url> && pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
git diff --stat main...HEAD
```

Expected: gate green; at most 200 changed lines, 10 files.

```bash
git switch -c feat/server-event-path-registry
git add apps/server/app/sensitive.ts apps/server/app/storage.ts apps/server/app/storage.test.ts apps/server/app/subject.test.ts apps/server/app/executionIds.test.ts
git commit -m "feat(server): event path registry, x: and child execution id tests, executionIdFor guard

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
gh pr create --draft --title "feat(server): event path registry, x: and child execution id tests" --body "Closes the M1 carry-forwards. The M2 stub flow carries ids only, so the registry is empty by design (Task 53 proves it); the PR that first adds content-bearing flow output extends it.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

### Task 43: `packages/blob-store` scaffold and the streaming blob envelope

**Files:**
- Create: `packages/blob-store/package.json`
- Create: `packages/blob-store/tsconfig.json`
- Create: `packages/blob-store/tsconfig.test.json`
- Create: `packages/blob-store/src/errors.ts`
- Create: `packages/blob-store/src/envelope.ts`
- Create: `packages/blob-store/src/envelope.test.ts`
- Create: `packages/blob-store/src/index.ts`
- Modify: `package.json` (root: one `pnpm.overrides` line) and `pnpm-lock.yaml` (not counted)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (from `@docmind/blob-store`, via `src/index.ts`):
  - `interface BlobScope { tenantId: string; userId: string }`
  - `sealStream(dek: Buffer, scope: BlobScope, source: AsyncIterable<Uint8Array>): AsyncGenerator<Buffer>`: yields the header, the ciphertext chunks, then the 16-byte tag.
  - `openBytes(dek: Buffer, scope: BlobScope, sealed: Uint8Array): Buffer` (throws `BlobCorruptError`)
  - `OVERHEAD_BYTES: number` (92)
  - `class BlobCorruptError extends Error`, `class BlobTooLargeError extends Error { constructor(readonly maxBytes: number) }`, `class BlobKeyUnavailableError extends Error`

- [ ] **Step 1: Scaffold the package**

`packages/blob-store/package.json`:

```json
{
  "name": "@docmind/blob-store",
  "version": "0.0.0",
  "private": true,
  "description": "Encrypted filesystem ContentStore: per-user envelope encryption of document bytes.",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "typecheck:tests": "tsc -p tsconfig.test.json"
  },
  "dependencies": {
    "@loom/plugin-content": "*",
    "@loom/plugin-crypto": "*"
  },
  "devDependencies": {
    "@loom/conformance": "*",
    "@types/node": "^22.0.0",
    "vitest": "^2.1.8"
  }
}
```

`packages/blob-store/tsconfig.json` (same as `packages/keystore-pg/tsconfig.json`):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "types": ["node"] },
  "include": ["src"],
  "exclude": ["**/*.test.ts", "dist"]
}
```

`packages/blob-store/tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src"],
  "exclude": ["dist"]
}
```

In the root `package.json`, add this line to `pnpm.overrides`, keeping the keys sorted as they are:

```json
      "@loom/plugin-content": "link:../loom/plugins/content",
```

Run: `pnpm install`
Expected: success; `packages/blob-store/node_modules/@loom/plugin-content` links to the Loom checkout.

- [ ] **Step 2: Write the failing test**

`packages/blob-store/src/envelope.test.ts`:

```ts
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BlobCorruptError } from "./errors";
import { OVERHEAD_BYTES, openBytes, sealStream } from "./envelope";

const DEK = randomBytes(32);
const SCOPE = {
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  userId: "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1",
};

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield Buffer.from(part);
}

async function seal(dek: Buffer, ...parts: string[]): Promise<Buffer> {
  const out: Buffer[] = [];
  for await (const piece of sealStream(dek, SCOPE, chunks(...parts))) out.push(piece);
  return Buffer.concat(out);
}

describe("blob envelope", () => {
  it("round-trips a multi-chunk stream and adds a fixed overhead", async () => {
    const sealed = await seal(DEK, "hello ", "wor", "ld");
    expect(sealed.length).toBe("hello world".length + OVERHEAD_BYTES);
    expect(openBytes(DEK, SCOPE, sealed).toString()).toBe("hello world");
  });

  it("round-trips an empty stream", async () => {
    expect(openBytes(DEK, SCOPE, await seal(DEK)).length).toBe(0);
  });

  it("does not contain the plaintext and differs on every seal", async () => {
    const a = await seal(DEK, "a recognisable sentence");
    const b = await seal(DEK, "a recognisable sentence");
    expect(a.includes("recognisable")).toBe(false);
    expect(a.equals(b)).toBe(false);
  });

  it("fails to open after any single byte changes (header, body or tag)", async () => {
    const sealed = await seal(DEK, "tamper evident");
    for (const i of [0, 6, 20, 40, 70, 80, sealed.length - 1]) {
      const copy = Buffer.from(sealed);
      copy[i] = (copy[i] ?? 0) ^ 1;
      expect(() => openBytes(DEK, SCOPE, copy), `byte ${i}`).toThrow(BlobCorruptError);
    }
  });

  it("fails for another data key, another user, another tenant, and a truncated file", async () => {
    const sealed = await seal(DEK, "scoped");
    expect(() => openBytes(randomBytes(32), SCOPE, sealed)).toThrow(BlobCorruptError);
    expect(() => openBytes(DEK, { ...SCOPE, userId: "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1" }, sealed)).toThrow(
      BlobCorruptError,
    );
    expect(() => openBytes(DEK, { ...SCOPE, tenantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, sealed)).toThrow(
      BlobCorruptError,
    );
    expect(() => openBytes(DEK, SCOPE, sealed.subarray(0, sealed.length - 1))).toThrow(
      BlobCorruptError,
    );
    expect(() => openBytes(DEK, SCOPE, Buffer.from("nope"))).toThrow(BlobCorruptError);
  });

  it("error messages carry no scope values", async () => {
    const sealed = await seal(DEK, "x");
    try {
      openBytes(randomBytes(32), SCOPE, sealed);
    } catch (err) {
      expect(String(err)).not.toContain(SCOPE.userId);
      expect(String(err)).not.toContain(SCOPE.tenantId);
    }
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @docmind/blob-store exec vitest run`
Expected: FAIL (modules not found).

- [ ] **Step 4: Implement**

`packages/blob-store/src/errors.ts`:

```ts
/** The bytes on disk are not a blob this user sealed, or were changed. */
export class BlobCorruptError extends Error {
  constructor(message = "blob failed authentication") {
    super(message);
    this.name = "BlobCorruptError";
  }
}

/** A stream passed the size cap while it was being written. */
export class BlobTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`blob exceeds the ${maxBytes}-byte limit`);
    this.name = "BlobTooLargeError";
  }
}

/** The user's data key is gone (or was never created) so the blob cannot be opened. */
export class BlobKeyUnavailableError extends Error {
  constructor() {
    super("the data key for this blob's owner is unavailable");
    this.name = "BlobKeyUnavailableError";
  }
}
```

`packages/blob-store/src/envelope.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { BlobCorruptError } from "./errors";

const MAGIC = Buffer.from("DMB1");
const IV = 12;
const TAG = 16;
const KEY = 32;
const HEADER = MAGIC.length + IV + TAG + KEY + IV;

/** Bytes a sealed blob adds to its plaintext: header plus the trailing tag. */
export const OVERHEAD_BYTES = HEADER + TAG;

export interface BlobScope {
  tenantId: string;
  userId: string;
}

// Both the key wrap and the body authenticate who owns the blob, so a file copied into another
// user's (or tenant's) directory fails to open.
const aad = (scope: BlobScope): Buffer =>
  Buffer.from(`docmind-blob-v1\0${scope.tenantId}/${scope.userId}`);

/**
 * Seals a byte stream. Format: magic | wrapIv | wrapTag | wrappedBlobKey | bodyIv | ciphertext |
 * bodyTag. A fresh random key encrypts the body (AES-256-GCM, so the stream is never held in
 * memory); the user's data key wraps that key. Chunks are yielded as they are produced.
 */
export async function* sealStream(
  dek: Buffer,
  scope: BlobScope,
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<Buffer> {
  const blobKey = randomBytes(KEY);
  const wrapIv = randomBytes(IV);
  const wrap = createCipheriv("aes-256-gcm", dek, wrapIv, { authTagLength: TAG });
  wrap.setAAD(aad(scope));
  const wrapped = Buffer.concat([wrap.update(blobKey), wrap.final()]);
  const bodyIv = randomBytes(IV);
  const body = createCipheriv("aes-256-gcm", blobKey, bodyIv, { authTagLength: TAG });
  body.setAAD(aad(scope));
  yield Buffer.concat([MAGIC, wrapIv, wrap.getAuthTag(), wrapped, bodyIv]);
  for await (const chunk of source) {
    const out = body.update(chunk);
    if (out.length > 0) yield out;
  }
  const last = body.final();
  if (last.length > 0) yield last;
  yield body.getAuthTag();
}

/** Opens a sealed blob, or throws `BlobCorruptError` (wrong key, owner, or any changed byte). */
export function openBytes(dek: Buffer, scope: BlobScope, sealed: Uint8Array): Buffer {
  const buf = Buffer.from(sealed.buffer, sealed.byteOffset, sealed.byteLength);
  if (buf.length < OVERHEAD_BYTES || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new BlobCorruptError("not a DocMind blob");
  }
  let at = MAGIC.length;
  const take = (n: number): Buffer => {
    const part = buf.subarray(at, at + n);
    at += n;
    return part;
  };
  const wrapIv = take(IV);
  const wrapTag = take(TAG);
  const wrapped = take(KEY);
  const bodyIv = take(IV);
  const bodyTag = buf.subarray(buf.length - TAG);
  const ciphertext = buf.subarray(at, buf.length - TAG);
  try {
    const unwrap = createDecipheriv("aes-256-gcm", dek, wrapIv, { authTagLength: TAG });
    unwrap.setAAD(aad(scope));
    unwrap.setAuthTag(wrapTag);
    const blobKey = Buffer.concat([unwrap.update(wrapped), unwrap.final()]);
    const body = createDecipheriv("aes-256-gcm", blobKey, bodyIv, { authTagLength: TAG });
    body.setAAD(aad(scope));
    body.setAuthTag(bodyTag);
    return Buffer.concat([body.update(ciphertext), body.final()]);
  } catch {
    // The Node error can name nothing sensitive, but a fixed message keeps it that way.
    throw new BlobCorruptError();
  }
}
```

`packages/blob-store/src/index.ts`:

```ts
export { BlobCorruptError, BlobKeyUnavailableError, BlobTooLargeError } from "./errors";
export { type BlobScope, OVERHEAD_BYTES, openBytes, sealStream } from "./envelope";
```

- [ ] **Step 5: Run to verify it passes, then gate and commit**

Run: `pnpm --filter @docmind/blob-store exec vitest run`
Expected: PASS (6 tests).

```bash
export DOCMIND_TEST_PG_URL=<superuser url> && pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
git diff --stat main...HEAD
git switch -c feat/blob-store-envelope
git add package.json pnpm-lock.yaml packages/blob-store
git commit -m "feat(blob-store): package scaffold and streaming blob envelope

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
gh pr create --draft --title "feat(blob-store): package scaffold and streaming blob envelope" --body "Lockfile changes are not counted toward the size limit.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Expected: gate green; at most 200 changed lines (lockfile excluded) and 10 files. The branch is cut from Task 42's branch (stack), so use `git diff --stat feat/server-event-path-registry...HEAD` if `main` does not yet contain it.

---

### Task 44: keyed fingerprint and the `hmac-sha256:` address format

Owner decision 5: the plaintext sha256 is replaced by an HMAC keyed from the user's data key. This task is the pure, I/O-free part; Task 45a uses it. See Deviation 1 for why HKDF-from-the-DEK was chosen over a separate wrapped key.

**Files:**
- Create: `packages/blob-store/src/address.ts`
- Create: `packages/blob-store/src/address.test.ts`
- Modify: `packages/blob-store/src/index.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (Task 43 created the package).
- Produces (from `@docmind/blob-store`):
  - `FINGERPRINT_INFO = "docmind-fingerprint-v1"`, `ADDRESS_PREFIX = "hmac-sha256:"`
  - `deriveFingerprintKey(dek: Buffer): Buffer`: HKDF-SHA256, empty salt, `info = FINGERPRINT_INFO`, 32 bytes. Deterministic per DEK; never equal to the DEK.
  - `fingerprintOf(fingerprintKey: Buffer, bytes: Uint8Array): string`: HMAC-SHA256, 64 lowercase hex digits.
  - `addressOf(fingerprint: string): string` -> `hmac-sha256:<fingerprint>`; `parseAddress(address: string): string | null` returns the 64-hex fingerprint of a well-formed address and `null` for anything else (wrong scheme, wrong length, upper case, trailing characters).
  - `sameFingerprint(a: string, b: string): boolean`: constant-time comparison of two fingerprints.

- [ ] **Step 1: Write the failing test**

`packages/blob-store/src/address.test.ts`:

```ts
import { createHash, hkdfSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ADDRESS_PREFIX,
  FINGERPRINT_INFO,
  addressOf,
  deriveFingerprintKey,
  fingerprintOf,
  parseAddress,
  sameFingerprint,
} from "./address";

const DEK = randomBytes(32);
const bytes = (s: string) => Buffer.from(s);

describe("fingerprint key", () => {
  it("is deterministic per data key, 32 bytes, and not the data key itself", () => {
    const a = deriveFingerprintKey(DEK);
    expect(a.length).toBe(32);
    expect(a.equals(deriveFingerprintKey(DEK))).toBe(true);
    expect(a.equals(DEK)).toBe(false);
    expect(a.equals(deriveFingerprintKey(randomBytes(32)))).toBe(false);
  });

  it("is domain-separated by its label", () => {
    const other = Buffer.from(hkdfSync("sha256", DEK, Buffer.alloc(0), "docmind-something-else", 32));
    expect(deriveFingerprintKey(DEK).equals(other)).toBe(false);
    expect(FINGERPRINT_INFO).toBe("docmind-fingerprint-v1");
  });
});

describe("fingerprintOf", () => {
  it("is 64 lowercase hex digits, stable for equal bytes and different for different bytes", () => {
    const key = deriveFingerprintKey(DEK);
    const a = fingerprintOf(key, bytes("same"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintOf(key, bytes("same"))).toBe(a);
    expect(fingerprintOf(key, bytes("other"))).not.toBe(a);
  });

  it("is not the plain sha256, and differs between users (different data keys) for the same bytes", () => {
    const plain = createHash("sha256").update("quarterly numbers").digest("hex");
    const mine = fingerprintOf(deriveFingerprintKey(DEK), bytes("quarterly numbers"));
    const yours = fingerprintOf(deriveFingerprintKey(randomBytes(32)), bytes("quarterly numbers"));
    expect(mine).not.toBe(plain);
    expect(mine).not.toBe(yours);
  });
});

describe("addresses", () => {
  const fp = "a".repeat(64);

  it("round-trips a fingerprint", () => {
    expect(addressOf(fp)).toBe(`${ADDRESS_PREFIX}${fp}`);
    expect(parseAddress(addressOf(fp))).toBe(fp);
  });

  it("rejects everything that is not exactly hmac-sha256:<64 lowercase hex>", () => {
    for (const bad of [
      "",
      `sha256:${fp}`, // the plain scheme is not this store's
      "sha256:deadbeef",
      `${ADDRESS_PREFIX}${"A".repeat(64)}`,
      `${ADDRESS_PREFIX}${"a".repeat(63)}`,
      `${ADDRESS_PREFIX}${fp}a`,
      `${ADDRESS_PREFIX}${fp}\n`,
      `${ADDRESS_PREFIX}../${"a".repeat(61)}`,
      fp,
    ]) {
      expect(parseAddress(bad), bad).toBeNull();
    }
  });

  it("compares fingerprints without short-circuiting on length mismatches", () => {
    expect(sameFingerprint(fp, fp)).toBe(true);
    expect(sameFingerprint(fp, "b".repeat(64))).toBe(false);
    expect(sameFingerprint(fp, "a")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @docmind/blob-store exec vitest run src/address.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`packages/blob-store/src/address.ts`:

```ts
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/** HKDF `info` for the fingerprint key. A new label (v2) is a new, unrelated key. */
export const FINGERPRINT_INFO = "docmind-fingerprint-v1";
/** Scheme of this store's content addresses. Not `sha256:`: the value is keyed, not a plain hash. */
export const ADDRESS_PREFIX = "hmac-sha256:";

const FINGERPRINT = /^[0-9a-f]{64}$/;

/**
 * The key a user's fingerprints are computed under, derived from their data key. HKDF keeps it
 * independent of the AES uses of the same data key, and destroying the data key (erasure step 4)
 * destroys it too: afterwards nobody can compute a fingerprint to test a known file against. The
 * data key is uniformly random, so an empty salt is fine. Never log or return the result.
 */
export function deriveFingerprintKey(dek: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", dek, Buffer.alloc(0), FINGERPRINT_INFO, 32));
}

/** HMAC-SHA256 of the plaintext under the user's fingerprint key, as 64 lowercase hex digits. */
export function fingerprintOf(fingerprintKey: Buffer, bytes: Uint8Array): string {
  return createHmac("sha256", fingerprintKey).update(bytes).digest("hex");
}

export const addressOf = (fingerprint: string): string => `${ADDRESS_PREFIX}${fingerprint}`;

/** The fingerprint inside an address this store could have issued, or null for anything else. */
export function parseAddress(address: string): string | null {
  if (!address.startsWith(ADDRESS_PREFIX)) return null;
  const fingerprint = address.slice(ADDRESS_PREFIX.length);
  return FINGERPRINT.test(fingerprint) ? fingerprint : null;
}

export function sameFingerprint(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
```

Add to `packages/blob-store/src/index.ts`:

```ts
export {
  ADDRESS_PREFIX,
  FINGERPRINT_INFO,
  addressOf,
  deriveFingerprintKey,
  fingerprintOf,
  parseAddress,
  sameFingerprint,
} from "./address";
```

- [ ] **Step 4: Run to verify it passes, gate, commit**

Run: `pnpm --filter @docmind/blob-store exec vitest run`
Expected: PASS.

```bash
export DOCMIND_TEST_PG_URL=<superuser url> && pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
git switch -c feat/blob-store-fingerprint
git add packages/blob-store
git commit -m "feat(blob-store): keyed fingerprint and hmac-sha256 content addresses

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
gh pr create --draft --title "feat(blob-store): keyed fingerprint and hmac-sha256 content addresses" --body "Replaces the plaintext sha256 fingerprint with an HMAC keyed from the user's data key (HKDF, label docmind-fingerprint-v1). Intentional deviation from spec 5.1 step 3; see the plan's Deviation 1.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Expected: gate green; about 90 changed lines, 3 files.

---

### Task 45a: `EncryptedFsContentStore` core, passing Loom's ContentStore conformance suite

**Files:**
- Create: `packages/blob-store/src/EncryptedFsContentStore.ts`
- Create: `packages/blob-store/src/EncryptedFsContentStore.test.ts`
- Create: `packages/blob-store/vitest.config.ts`
- Modify: `packages/blob-store/src/index.ts`

**Interfaces:**
- Consumes: Task 43 (`sealStream`, `openBytes`, `BlobScope`, the three errors) and Task 44 (`deriveFingerprintKey`, `fingerprintOf`, `addressOf`, `parseAddress`, `sameFingerprint`).
- Produces:
  - `interface EncryptedFsContentStoreOptions { root: string; tenantId: string; userId: string; keys: KeyStore; maxBytes?: number }` (`root` absolute; `tenantId`/`userId` canonical lowercase UUIDs; `maxBytes` default 52428800)
  - `interface StagedBlob { readonly ref: ContentRef /* address = hmac-sha256:<fingerprint>, size = plaintext bytes */; readonly fingerprint: string /* the bare 64-hex keyed hash */; commit(): Promise<{ created: boolean }>; discard(): Promise<void> }`
  - `class EncryptedFsContentStore implements ContentStore` with `stage(source: AsyncIterable<Uint8Array>): Promise<StagedBlob>`, `put`, `putStream`, `get`, `delete`, and `readonly userDir: string`. The store **computes the keyed address itself**: callers never supply or compute one, and `get`/`delete` accept only addresses `parseAddress` accepts (anything else, including a plain `sha256:<hex>`, is "absent").
  - `commit()` renames the sealed temp file to `<root>/<tenantId>/<userId>/<fingerprint>` unless that file already exists (then the temp file is removed and `created` is `false`). `discard()` is a no-op after `commit()` or a second `discard()`.

**How the conformance suite still passes:** Loom's ContentStore contract needs equal bytes to give equal refs, distinct bytes distinct refs, `put`/`putStream` to agree, `get` of an absent ref (including the literal `sha256:deadbeef`) to be `null`, and `delete` to be idempotent. It never recomputes a sha256 of the plaintext (Verified facts), so a keyed address meets all of it: within one store instance the key is fixed, so the HMAC is a deterministic, collision-resistant function of the bytes.

- [ ] **Step 1: Write the failing test (the contract suite; the layout tests are Task 45b)**

`packages/blob-store/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  // @loom/* publish require-only `exports`; resolve them the same way under Vite.
  resolve: { conditions: ["node", "require", "default"] },
  test: {
    environment: "node",
    server: {
      deps: {
        external: [/@loom\//, /[\\/]loom[\\/]/],
        // Loom's conformance kits are ESM with extensionless imports, so Vite must load them.
        inline: [/@loom\/conformance/, /[\\/]conformance[\\/]dist/],
      },
    },
  },
});
```

`packages/blob-store/src/EncryptedFsContentStore.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runContentStoreConformance } from "@loom/conformance";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { afterAll } from "vitest";
import { EncryptedFsContentStore } from "./EncryptedFsContentStore";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";

const roots: string[] = [];
const freshRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "dm-blobs-"));
  roots.push(root);
  return root;
};

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// The same contract every ContentStore owes (Loom ADR 0046), run on a fresh directory each time.
// The addresses are keyed (hmac-sha256:), which the kit accepts: it only compares them with each other.
runContentStoreConformance(
  () => new EncryptedFsContentStore({ root: freshRoot(), tenantId: TENANT, userId: USER, keys: new InMemoryKeyStore() }),
  "EncryptedFsContentStore",
);
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @docmind/blob-store exec vitest run src/EncryptedFsContentStore.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`packages/blob-store/src/EncryptedFsContentStore.ts`:

```ts
import { createHmac, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ContentRef, ContentStore } from "@loom/plugin-content";
import type { KeyStore } from "@loom/plugin-crypto";
import { addressOf, deriveFingerprintKey, fingerprintOf, parseAddress, sameFingerprint } from "./address";
import { type BlobScope, openBytes, sealStream } from "./envelope";
import { BlobCorruptError, BlobKeyUnavailableError, BlobTooLargeError } from "./errors";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

export interface EncryptedFsContentStoreOptions {
  /** Absolute directory that holds every tenant's blobs. */
  root: string;
  /** Canonical lowercase UUIDs: they become path segments, so nothing else is accepted. */
  tenantId: string;
  userId: string;
  /** Supplies the user's data key (subject = userId). */
  keys: KeyStore;
  /** Largest plaintext a stream may have. Default 50 MiB. */
  maxBytes?: number;
}

export interface StagedBlob {
  /** Keyed address (`hmac-sha256:<fingerprint>`) of the plaintext, and its size in bytes. */
  readonly ref: ContentRef;
  /** The bare 64-hex keyed hash: `documents.fingerprint` and the blob's file name. */
  readonly fingerprint: string;
  /** Moves the sealed file to its final path. `created` is false if this user already had it. */
  commit(): Promise<{ created: boolean }>;
  /** Removes the staged file. A no-op once committed or discarded. */
  discard(): Promise<void>;
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    (err: NodeJS.ErrnoException) => (err.code === "ENOENT" ? false : Promise.reject(err)),
  );

/**
 * Loom's ContentStore for one user, on the local filesystem. Bytes are addressed by an HMAC of the
 * plaintext keyed from the user's data key (see address.ts), sealed under that data key (see
 * envelope.ts) and written to `<root>/<tenantId>/<userId>/<fingerprint>`. The store computes the
 * address itself, so Loom's sha256 `contentAddress()` is never involved. No client string ever
 * reaches a path: the segments are validated UUIDs and a 64-digit hex fingerprint.
 */
export class EncryptedFsContentStore implements ContentStore {
  readonly userDir: string;
  private readonly scope: BlobScope;
  private readonly keys: KeyStore;
  private readonly maxBytes: number;

  constructor(options: EncryptedFsContentStoreOptions) {
    if (!isAbsolute(options.root)) throw new Error("blob root must be an absolute path");
    if (!UUID.test(options.tenantId) || !UUID.test(options.userId)) {
      throw new Error("tenantId and userId must be canonical lowercase UUIDs");
    }
    this.scope = { tenantId: options.tenantId, userId: options.userId };
    this.keys = options.keys;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.userDir = join(options.root, options.tenantId, options.userId);
  }

  /**
   * Streams `source` into a sealed temp file, fingerprinting and counting the plaintext on the way
   * (throws `BlobTooLargeError` past `maxBytes`, removing the temp file). Nothing is visible at
   * the final path until `commit()`.
   */
  async stage(source: AsyncIterable<Uint8Array>): Promise<StagedBlob> {
    const dek = await this.keys.getOrCreate(this.scope.userId);
    const hash = createHmac("sha256", deriveFingerprintKey(dek));
    await mkdir(this.userDir, { recursive: true, mode: 0o700 });
    const tmp = join(this.userDir, `.tmp-${randomBytes(12).toString("hex")}`);
    const max = this.maxBytes;
    let size = 0;
    async function* counted(): AsyncGenerator<Uint8Array> {
      for await (const chunk of source) {
        if (size + chunk.byteLength > max) throw new BlobTooLargeError(max);
        size += chunk.byteLength;
        hash.update(chunk);
        yield chunk;
      }
    }
    try {
      await pipeline(
        Readable.from(sealStream(dek, this.scope, counted()), { objectMode: false }),
        createWriteStream(tmp, { flags: "wx", mode: 0o600 }),
      );
      const handle = await open(tmp, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    const fingerprint = hash.digest("hex");
    const final = join(this.userDir, fingerprint);
    let state: "staged" | "committed" | "discarded" = "staged";
    return {
      ref: { __loomContent: addressOf(fingerprint), size },
      fingerprint,
      commit: async () => {
        if (state !== "staged") throw new Error("blob is no longer staged");
        try {
          // Checked at commit, not at stage: a delete may have run in between.
          if (await exists(final)) {
            await rm(tmp, { force: true });
            state = "committed";
            return { created: false };
          }
          await rename(tmp, final);
          state = "committed";
          return { created: true };
        } catch (err) {
          await rm(tmp, { force: true });
          state = "discarded";
          throw err;
        }
      },
      discard: async () => {
        if (state !== "staged") return;
        state = "discarded";
        await rm(tmp, { force: true });
      },
    };
  }

  async put(bytes: Uint8Array): Promise<ContentRef> {
    return this.putStream(
      (async function* () {
        yield bytes;
      })(),
    );
  }

  async putStream(stream: AsyncIterable<Uint8Array>): Promise<ContentRef> {
    const staged = await this.stage(stream);
    await staged.commit();
    return staged.ref;
  }

  async get(ref: ContentRef): Promise<Uint8Array | null> {
    const fingerprint = parseAddress(ref.__loomContent);
    if (!fingerprint) return null; // not an address this store could have issued
    let sealed: Buffer;
    try {
      sealed = await readFile(join(this.userDir, fingerprint));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    const dek = await this.keys.get(this.scope.userId);
    if (!dek) throw new BlobKeyUnavailableError();
    const plain = openBytes(dek, this.scope, sealed);
    if (!sameFingerprint(fingerprintOf(deriveFingerprintKey(dek), plain), fingerprint)) {
      throw new BlobCorruptError("blob content does not match its address");
    }
    return plain;
  }

  async delete(ref: ContentRef): Promise<void> {
    const fingerprint = parseAddress(ref.__loomContent);
    if (!fingerprint) return;
    await rm(join(this.userDir, fingerprint), { force: true });
  }
}
```

Replace `packages/blob-store/src/index.ts` with:

```ts
export {
  ADDRESS_PREFIX,
  FINGERPRINT_INFO,
  addressOf,
  deriveFingerprintKey,
  fingerprintOf,
  parseAddress,
  sameFingerprint,
} from "./address";
export {
  EncryptedFsContentStore,
  type EncryptedFsContentStoreOptions,
  type StagedBlob,
} from "./EncryptedFsContentStore";
export { BlobCorruptError, BlobKeyUnavailableError, BlobTooLargeError } from "./errors";
export { type BlobScope, OVERHEAD_BYTES, openBytes, sealStream } from "./envelope";
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @docmind/blob-store exec vitest run`
Expected: PASS (the Loom contract tests, listed by name). If the conformance kit rejects a store without the SPI 1.3.0 optionals (Uncertain #2), implement `touchClock` (`Date.now()`), `listPage` (readdir of `userDir`, skipping `.tmp-*`, sorted, with `mtimeMs` as `touchedAt`; addresses via `addressOf`) and `deleteIfUntouchedSince` (stat then `rm` if `mtimeMs < cutoff`) in this task and note it in the PR. If the kit fails on the keyed address itself, that is a new finding: stop and report it to the owner rather than falling back to `sha256:`.

- [ ] **Step 5: Gate, measure, commit**

```bash
export DOCMIND_TEST_PG_URL=<superuser url> && pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
git diff --stat HEAD~0 && git switch -c feat/blob-store-fs
git add packages/blob-store
git commit -m "feat(blob-store): encrypted filesystem ContentStore with keyed addresses

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
gh pr create --draft --title "feat(blob-store): encrypted filesystem ContentStore with keyed addresses" --body "Passes Loom's ContentStore conformance suite; addresses are hmac-sha256:<fingerprint> (Task 44).

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Expected: gate green; about 175 changed lines, 4 files.

---

### Task 45b: `EncryptedFsContentStore` layout and keyed-address tests

Test-only PR (the behaviour is Task 45a's). It pins where blobs land, that addresses are keyed, that two users never share a fingerprint, and the stage/commit/discard contract.

**Files:**
- Create: `packages/blob-store/src/EncryptedFsContentStore.layout.test.ts`

**Interfaces:**
- Consumes: Task 44 (`deriveFingerprintKey`, `fingerprintOf`), Task 45a (`EncryptedFsContentStore`, `stage`).
- Produces: nothing (tests only).

- [ ] **Step 1: Write the tests**

`packages/blob-store/src/EncryptedFsContentStore.layout.test.ts`:

```ts
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { afterAll, describe, expect, it } from "vitest";
import { deriveFingerprintKey, fingerprintOf } from "./address";
import { EncryptedFsContentStore } from "./EncryptedFsContentStore";

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";

const roots: string[] = [];
const freshRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "dm-blobs-"));
  roots.push(root);
  return root;
};
const storeAt = (root: string, keys = new InMemoryKeyStore()) =>
  new EncryptedFsContentStore({ root, tenantId: TENANT, userId: USER, keys });

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("EncryptedFsContentStore layout", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  const fingerprint = async (keys: InMemoryKeyStore, user: string, s: string) =>
    fingerprintOf(deriveFingerprintKey(await keys.getOrCreate(user)), bytes(s));

  it("stores ciphertext at <root>/<tenant>/<user>/<keyed fingerprint of the plaintext>", async () => {
    const root = freshRoot();
    const keys = new InMemoryKeyStore();
    const store = storeAt(root, keys);
    const ref = await store.put(bytes("quarterly numbers"));
    const fp = await fingerprint(keys, USER, "quarterly numbers");
    expect(ref.__loomContent).toBe(`hmac-sha256:${fp}`);
    expect(ref.size).toBe(17);
    expect(fp).not.toBe(createHash("sha256").update("quarterly numbers").digest("hex"));
    expect(readdirSync(join(root, TENANT, USER))).toEqual([fp]);
    expect(readFileSync(join(root, TENANT, USER, fp)).includes("quarterly")).toBe(false);
  });

  it("stores identical bytes once for one user and leaves no temp files", async () => {
    const root = freshRoot();
    const store = storeAt(root);
    await store.put(bytes("same"));
    await store.put(bytes("same"));
    expect(readdirSync(join(root, TENANT, USER))).toHaveLength(1);
  });

  it("keeps two users' copies of the same bytes apart, under different fingerprints", async () => {
    const root = freshRoot();
    const keys = new InMemoryKeyStore();
    const other = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";
    const a = storeAt(root, keys);
    const b = new EncryptedFsContentStore({ root, tenantId: TENANT, userId: other, keys });
    const refA = await a.put(bytes("shared words"));
    expect(await b.get(refA)).toBeNull();
    const refB = await b.put(bytes("shared words"));
    expect(refB.__loomContent).not.toBe(refA.__loomContent);
    expect(readdirSync(join(root, TENANT))).toEqual([USER, other].sort());
  });

  it("stage() holds nothing at the final path until commit, and discard removes the temp file", async () => {
    const root = freshRoot();
    const store = storeAt(root);
    async function* once() {
      yield bytes("staged");
    }
    const staged = await store.stage(once());
    expect(staged.ref.__loomContent).toBe(`hmac-sha256:${staged.fingerprint}`);
    expect(await store.get(staged.ref)).toBeNull();
    await staged.discard();
    expect(readdirSync(join(root, TENANT, USER))).toEqual([]);

    const again = await store.stage(once());
    expect(await again.commit()).toEqual({ created: true });
    expect(await store.get(again.ref)).not.toBeNull();
    await again.discard(); // no-op after commit
    expect(await store.get(again.ref)).not.toBeNull();

    const dup = await store.stage(once());
    expect(await dup.commit()).toEqual({ created: false });
    expect(readdirSync(join(root, TENANT, USER))).toHaveLength(1);
  });

  it("treats a plain sha256 address, however well formed, as absent", async () => {
    const store = storeAt(freshRoot());
    await store.put(bytes("x"));
    const plain = `sha256:${createHash("sha256").update("x").digest("hex")}`;
    expect(await store.get({ __loomContent: plain })).toBeNull();
  });
});
```

- [ ] **Step 2: Run, gate, commit**

Run: `pnpm --filter @docmind/blob-store exec vitest run`
Expected: PASS (no failing-first step: these tests pin Task 45a behaviour; a failure is a Task 45a bug, fixed there).

```bash
export DOCMIND_TEST_PG_URL=<superuser url> && pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
git switch -c test/blob-store-fs-layout
git add packages/blob-store
git commit -m "test(blob-store): layout and keyed-address tests for the filesystem ContentStore

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
gh pr create --draft --title "test(blob-store): layout and keyed-address tests for the filesystem ContentStore" --body "🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Expected: gate green; about 70 changed lines, 1 file.

---

### Task 46a: erasure and stale-temp cleanup (`eraseUserBlobs`, `removeStaleTemp`)

**Files:**
- Create: `packages/blob-store/src/maintenance.ts`
- Create: `packages/blob-store/src/maintenance.test.ts`
- Modify: `packages/blob-store/src/index.ts`

**Interfaces:**
- Consumes: Task 45a (`EncryptedFsContentStore`).
- Produces:
  - `eraseUserBlobs(root: string, tenantId: string, userId: string): Promise<void>`: removes `<root>/<tenantId>/<userId>` recursively; idempotent; validates both ids as UUIDs and `root` as absolute (throws `Error` otherwise).
  - `removeStaleTemp(root: string, olderThanMs: number, now?: number): Promise<number>`: removes `.tmp-*` files older than `olderThanMs` under `<root>/<uuid>/<uuid>/`; returns how many.

- [ ] **Step 1: Write the failing tests**

`packages/blob-store/src/maintenance.test.ts`:

```ts
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { afterAll, describe, expect, it } from "vitest";
import { EncryptedFsContentStore } from "./EncryptedFsContentStore";
import { eraseUserBlobs, removeStaleTemp } from "./maintenance";

const T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const B = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";
const roots: string[] = [];
const freshRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "dm-blobs-"));
  roots.push(root);
  return root;
};
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("eraseUserBlobs", () => {
  it("removes one user's blobs, leaves the neighbour's, and is idempotent", async () => {
    const root = freshRoot();
    const keys = new InMemoryKeyStore();
    const a = new EncryptedFsContentStore({ root, tenantId: T, userId: A, keys });
    const b = new EncryptedFsContentStore({ root, tenantId: T, userId: B, keys });
    const refA = await a.put(new TextEncoder().encode("a's file"));
    const refB = await b.put(new TextEncoder().encode("b's file"));

    await eraseUserBlobs(root, T, A);
    await eraseUserBlobs(root, T, A);

    expect(await a.get(refA)).toBeNull();
    expect(await b.get(refB)).not.toBeNull();
  });

  it("refuses ids that are not canonical UUIDs, so a path can never be built from them", async () => {
    const root = freshRoot();
    for (const [t, u] of [
      ["..", A],
      [T, "../.."],
      [T, A.toUpperCase()],
      [`${T}/x`, A],
    ] as const) {
      await expect(eraseUserBlobs(root, t, u)).rejects.toThrow(/UUID/);
    }
    await expect(eraseUserBlobs("relative/dir", T, A)).rejects.toThrow(/absolute/);
  });
});

describe("removeStaleTemp", () => {
  it("removes only old .tmp- files and keeps finished blobs", async () => {
    const root = freshRoot();
    const dir = join(root, T, A);
    mkdirSync(dir, { recursive: true });
    const old = join(dir, ".tmp-old");
    const fresh = join(dir, ".tmp-fresh");
    const blob = join(dir, "a".repeat(64));
    for (const f of [old, fresh, blob]) writeFileSync(f, "x");
    utimesSync(old, 1, 1); // 1970
    const removed = await removeStaleTemp(root, 60_000, Date.now());
    expect(removed).toBe(1);
    expect(readdirSync(dir).sort()).toEqual([".tmp-fresh", "a".repeat(64)].sort());
  });

  it("ignores directories that are not <uuid>/<uuid>", async () => {
    const root = freshRoot();
    mkdirSync(join(root, "lost+found"), { recursive: true });
    writeFileSync(join(root, "lost+found", ".tmp-x"), "x");
    utimesSync(join(root, "lost+found", ".tmp-x"), 1, 1);
    expect(await removeStaleTemp(root, 1, Date.now())).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @docmind/blob-store exec vitest run src/maintenance.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`packages/blob-store/src/maintenance.ts`:

```ts
import { readdir, rm, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function check(root: string, tenantId: string, userId: string): void {
  if (!isAbsolute(root)) throw new Error("blob root must be an absolute path");
  if (!UUID.test(tenantId) || !UUID.test(userId)) {
    throw new Error("tenantId and userId must be canonical lowercase UUIDs");
  }
}

/**
 * Deletes every blob a user owns (the user's whole directory). Erasure step 3 (spec §4.4): rows
 * first, then this, then the key. Idempotent; the ids are checked so a path can never be built
 * from anything but UUIDs.
 */
export async function eraseUserBlobs(root: string, tenantId: string, userId: string): Promise<void> {
  check(root, tenantId, userId);
  await rm(join(root, tenantId, userId), { recursive: true, force: true });
}

const names = (dir: string): Promise<string[]> =>
  readdir(dir).catch((err: NodeJS.ErrnoException) =>
    err.code === "ENOENT" || err.code === "ENOTDIR" ? [] : Promise.reject(err),
  );

/**
 * Removes `.tmp-*` files older than `olderThanMs` that a crash left behind in
 * `<root>/<uuid>/<uuid>/`. Run at startup. Returns how many were removed.
 */
export async function removeStaleTemp(
  root: string,
  olderThanMs: number,
  now: number = Date.now(),
): Promise<number> {
  if (!isAbsolute(root)) throw new Error("blob root must be an absolute path");
  let removed = 0;
  for (const tenant of (await names(root)).filter((n) => UUID.test(n))) {
    for (const user of (await names(join(root, tenant))).filter((n) => UUID.test(n))) {
      const dir = join(root, tenant, user);
      for (const file of (await names(dir)).filter((n) => n.startsWith(".tmp-"))) {
        const info = await stat(join(dir, file)).catch(() => undefined);
        if (info && info.mtimeMs < now - olderThanMs) {
          await rm(join(dir, file), { force: true });
          removed++;
        }
      }
    }
  }
  return removed;
}
```

Add to `packages/blob-store/src/index.ts`:

```ts
export { eraseUserBlobs, removeStaleTemp } from "./maintenance";
```

- [ ] **Step 4: Run to verify it passes, gate, commit**

Run: `pnpm --filter @docmind/blob-store exec vitest run`
Expected: PASS.

```bash
export DOCMIND_TEST_PG_URL=<superuser url> && pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
git switch -c feat/blob-store-maintenance
git add packages/blob-store
git commit -m "feat(blob-store): erasure and stale temp cleanup

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
gh pr create --draft --title "feat(blob-store): erasure and stale temp cleanup" --body "🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Expected: gate green; about 115 changed lines, 3 files.

---

### Task 46b: blob-store hardening tests (size cap, tampering, hostile refs, destroyed key)

Test-only PR for Task 45a's behaviour, with keyed addresses.

**Files:**
- Create: `packages/blob-store/src/hardening.test.ts`

**Interfaces:**
- Consumes: Task 44 (`deriveFingerprintKey`, `fingerprintOf`), Task 45a (`EncryptedFsContentStore`, `stage`, the errors).
- Produces: nothing (tests only).

- [ ] **Step 1: Write the tests**

`packages/blob-store/src/hardening.test.ts`:

```ts
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { afterAll, describe, expect, it } from "vitest";
import { deriveFingerprintKey, fingerprintOf } from "./address";
import { EncryptedFsContentStore } from "./EncryptedFsContentStore";
import { BlobCorruptError, BlobKeyUnavailableError, BlobTooLargeError } from "./errors";

const T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const B = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";
const enc = (s: string) => new TextEncoder().encode(s);
// The file name a blob gets: the keyed fingerprint of its plaintext for that user.
const fpOf = async (keys: InMemoryKeyStore, user: string, s: string) =>
  fingerprintOf(deriveFingerprintKey(await keys.getOrCreate(user)), enc(s));
const roots: string[] = [];
const freshRoot = () => {
  const root = mkdtempSync(join(tmpdir(), "dm-blobs-"));
  roots.push(root);
  return root;
};
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
const storeFor = (root: string, userId = A, keys = new InMemoryKeyStore(), maxBytes?: number) =>
  new EncryptedFsContentStore({ root, tenantId: T, userId, keys, ...(maxBytes ? { maxBytes } : {}) });

describe("size cap", () => {
  it("rejects a stream over maxBytes while it is being written and leaves no file", async () => {
    const root = freshRoot();
    const store = storeFor(root, A, new InMemoryKeyStore(), 10);
    async function* big() {
      yield enc("12345");
      yield enc("678901"); // 11 bytes in total
    }
    await expect(store.putStream(big())).rejects.toBeInstanceOf(BlobTooLargeError);
    expect(readdirSync(join(root, T, A))).toEqual([]);
  });

  it("accepts a stream of exactly maxBytes", async () => {
    const store = storeFor(freshRoot(), A, new InMemoryKeyStore(), 10);
    const ref = await store.put(enc("0123456789"));
    expect(ref.size).toBe(10);
  });

  it("leaves no temp file when the source itself fails midway", async () => {
    const root = freshRoot();
    const store = storeFor(root);
    async function* broken() {
      yield enc("partial");
      throw new Error("client went away");
    }
    await expect(store.putStream(broken())).rejects.toThrow("client went away");
    expect(readdirSync(join(root, T, A))).toEqual([]);
  });
});

describe("tampering and misplacement", () => {
  it("throws BlobCorruptError when the stored file was changed", async () => {
    const root = freshRoot();
    const keys = new InMemoryKeyStore();
    const store = storeFor(root, A, keys);
    const ref = await store.put(enc("original"));
    const file = join(root, T, A, await fpOf(keys, A, "original"));
    const bytes = readFileSync(file);
    bytes[bytes.length - 20] = (bytes[bytes.length - 20] ?? 0) ^ 1;
    writeFileSync(file, bytes);
    await expect(store.get(ref)).rejects.toBeInstanceOf(BlobCorruptError);
  });

  it("will not open a file copied into another user's directory", async () => {
    const root = freshRoot();
    const keys = new InMemoryKeyStore();
    const a = storeFor(root, A, keys);
    const b = storeFor(root, B, keys);
    const ref = await a.put(enc("a's secret"));
    const name = await fpOf(keys, A, "a's secret");
    mkdirSync(join(root, T, B), { recursive: true });
    copyFileSync(join(root, T, A, name), join(root, T, B, name));
    await keys.getOrCreate(B);
    await expect(b.get(ref)).rejects.toBeInstanceOf(BlobCorruptError);
  });

  it("will not open a file renamed to another address", async () => {
    const root = freshRoot();
    const keys = new InMemoryKeyStore();
    const store = storeFor(root, A, keys);
    await store.put(enc("one"));
    const other = await store.put(enc("two"));
    copyFileSync(join(root, T, A, await fpOf(keys, A, "one")), join(root, T, A, await fpOf(keys, A, "two")));
    await expect(store.get(other)).rejects.toBeInstanceOf(BlobCorruptError);
  });

  it("reports a missing key as BlobKeyUnavailableError, not as absence", async () => {
    const root = freshRoot();
    const keys = new InMemoryKeyStore();
    const store = storeFor(root, A, keys);
    const ref = await store.put(enc("keyed"));
    await keys.destroy(A);
    await expect(store.get(ref)).rejects.toBeInstanceOf(BlobKeyUnavailableError);
  });

  it("cannot compute a fingerprint once the key is destroyed, so a known file cannot be tested for", async () => {
    const root = freshRoot();
    const keys = new InMemoryKeyStore();
    const store = storeFor(root, A, keys);
    await store.put(enc("known file"));
    await keys.destroy(A);
    expect(await keys.get(A)).toBeNull(); // no data key, so no derived fingerprint key either
    await expect(store.put(enc("known file"))).rejects.toThrow(); // getOrCreate refuses a destroyed subject
    await expect(store.stage((async function* () { yield enc("known file"); })())).rejects.toThrow();
  });
});

describe("hostile refs and construction", () => {
  it("never leaves the user's directory for a crafted address", async () => {
    const root = freshRoot();
    const store = storeFor(root);
    await store.put(enc("keep me"));
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "do not touch");
    for (const address of [
      "hmac-sha256:../../outside.txt",
      `hmac-sha256:${"A".repeat(64)}`,
      `hmac-sha256:${"a".repeat(63)}`,
      "hmac-sha256:",
      `sha256:${createHash("sha256").update("keep me").digest("hex")}`, // the plain scheme is not ours
      "../outside.txt",
      `hmac-sha256:${"a".repeat(64)}/../x`,
    ]) {
      expect(await store.get({ __loomContent: address })).toBeNull();
      await store.delete({ __loomContent: address });
    }
    expect(readFileSync(outside, "utf8")).toBe("do not touch");
    expect(readdirSync(join(root, T, A))).toHaveLength(1);
  });

  it("rejects a relative root and ids that are not canonical UUIDs", () => {
    const keys = new InMemoryKeyStore();
    expect(() => new EncryptedFsContentStore({ root: "rel", tenantId: T, userId: A, keys })).toThrow();
    for (const userId of ["..", `${A}/x`, A.toUpperCase(), ""]) {
      expect(() => new EncryptedFsContentStore({ root: freshRoot(), tenantId: T, userId, keys })).toThrow();
    }
  });

  it("creates private directories and files", async () => {
    if (process.platform === "win32") return;
    const root = freshRoot();
    const keys = new InMemoryKeyStore();
    await storeFor(root, A, keys).put(enc("private"));
    expect(statSync(join(root, T, A)).mode & 0o077).toBe(0);
    expect(statSync(join(root, T, A, await fpOf(keys, A, "private"))).mode & 0o077).toBe(0);
  });
});
```

- [ ] **Step 2: Run, gate, commit**

Run: `pnpm --filter @docmind/blob-store exec vitest run src/hardening.test.ts`
Expected: PASS (no failing-first step: these cases pin Task 45a behaviour; if one fails, that is a real Task 45a bug: fix it there).

```bash
export DOCMIND_TEST_PG_URL=<superuser url> && pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
git switch -c test/blob-store-hardening
git add packages/blob-store
git commit -m "test(blob-store): size cap, tampering, hostile ref and destroyed key tests

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
gh pr create --draft --title "test(blob-store): size cap, tampering, hostile ref and destroyed key tests" --body "🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Expected: gate green; about 125 changed lines, 1 file.

---

### Task 47: migration 0009 `documents` with row-level security

**Files:**
- Create: `infra/migrations/0009_documents.sql`
- Create: `apps/server/app/db/documents.pg.test.ts`

**Interfaces:**
- Consumes: `tenants`, `users (tenant_id, id)` unique key (0003), `app_tenant_id()` (0002).
- Produces: table `documents (id uuid PK, tenant_id, owner_id, title_enc jsonb, filename_enc jsonb, mime text, size_bytes bigint, content_address text, fingerprint text, status text, error text, stats_enc jsonb, summary_enc jsonb, created_at, updated_at)` with `UNIQUE (tenant_id, owner_id, fingerprint)`, FK `(tenant_id, owner_id) -> users (tenant_id, id) ON DELETE CASCADE`, index `documents_owner_created_idx (tenant_id, owner_id, created_at DESC, id DESC)`, and policy `tenant_isolation`.

- [ ] **Step 1: Write the failing test**

`apps/server/app/db/documents.pg.test.ts`:

```ts
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword } from "./migrate";
import { withTenant } from "./tenant";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "./testSupport";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const USER_A2 = "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2";
const USER_B = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";
const HEX = (c: string) => c.repeat(64);

const insert = (
  tx: { query: Pool["query"] },
  id: string,
  tenant: string,
  owner: string,
  fingerprint: string,
  extra: { status?: string; size?: number } = {},
) =>
  tx.query(
    `INSERT INTO documents (id, tenant_id, owner_id, title_enc, filename_enc, mime, size_bytes,
                            content_address, fingerprint, status)
     VALUES ($1, $2, $3, '{"x":1}', '{"x":2}', 'text/plain', $4, $5, $6, $7)`,
    [id, tenant, owner, extra.size ?? 5, `hmac-sha256:${fingerprint}`, fingerprint, extra.status ?? "uploaded"],
  );

describe.skipIf(!PG_URL)("documents table (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await db.owner.query(`
      INSERT INTO tenants (id, name) VALUES ('${A}', 'A'), ('${B}', 'B');
      INSERT INTO users (id, tenant_id, email, password_hash) VALUES
        ('${USER_A}', '${A}', 'a@example.com', 'x'), ('${USER_A2}', '${A}', 'a2@example.com', 'x'),
        ('${USER_B}', '${B}', 'b@example.com', 'x');`);
    app = new Pool({ connectionString: db.appUrl, max: 1 });
    await withTenant(app, A, (tx) => insert(tx, "10000000-0000-4000-8000-000000000001", A, USER_A, HEX("a")));
    await withTenant(app, B, (tx) => insert(tx, "20000000-0000-4000-8000-000000000001", B, USER_B, HEX("a")));
  });

  afterAll(async () => {
    await app?.end();
    await db?.drop();
  });

  it("shows each tenant only its own rows, and none outside a tenant context", async () => {
    await withTenant(app, A, async (tx) => {
      const { rows } = await tx.query("SELECT tenant_id FROM documents");
      expect(rows).toEqual([{ tenant_id: A }]);
    });
    await withTenant(app, B, async (tx) => {
      const { rows } = await tx.query("SELECT tenant_id FROM documents");
      expect(rows).toEqual([{ tenant_id: B }]);
    });
    expect((await app.query("SELECT 1 FROM documents")).rowCount).toBe(0); // raw SQL, no tenant set
  });

  it("refuses to write a row for another tenant, or to move one there", async () => {
    await expect(
      withTenant(app, A, (tx) => insert(tx, "10000000-0000-4000-8000-000000000002", B, USER_B, HEX("b"))),
    ).rejects.toThrow(/row-level security/);
    await expect(
      withTenant(app, A, (tx) => tx.query("UPDATE documents SET tenant_id = $1", [B])),
    ).rejects.toThrow(/row-level security/);
  });

  it("makes the same bytes unique per owner, not per tenant or across tenants", async () => {
    await expect(
      withTenant(app, A, (tx) => insert(tx, "10000000-0000-4000-8000-000000000003", A, USER_A, HEX("a"))),
    ).rejects.toThrow(/documents_owner_fingerprint_key/);
    // another user of the same tenant may hold the same bytes (dedup is per user)
    await withTenant(app, A, (tx) => insert(tx, "10000000-0000-4000-8000-000000000004", A, USER_A2, HEX("a")));
  });

  it("requires the owner to be a user of the same tenant", async () => {
    await expect(
      withTenant(app, A, (tx) => insert(tx, "10000000-0000-4000-8000-000000000005", A, USER_B, HEX("c"))),
    ).rejects.toThrow(/documents_owner_fkey/);
  });

  it("rejects malformed values at the database", async () => {
    const bad = (fp: string, extra: { status?: string; size?: number }) =>
      withTenant(app, A, (tx) => insert(tx, "10000000-0000-4000-8000-0000000000ff", A, USER_A, fp, extra));
    await expect(bad(HEX("d"), { status: "done" })).rejects.toThrow(/status/);
    await expect(bad(HEX("d"), { size: -1 })).rejects.toThrow(/size_bytes/);
    await expect(bad("NOT-HEX", {})).rejects.toThrow(/fingerprint/);
  });

  it("accepts only keyed addresses and has no plaintext stats column", async () => {
    await expect(
      withTenant(app, A, (tx) =>
        tx.query(
          `INSERT INTO documents (id, tenant_id, owner_id, title_enc, filename_enc, mime, size_bytes,
                                  content_address, fingerprint)
           VALUES ('10000000-0000-4000-8000-0000000000aa', $1, $2, '{}', '{}', 'text/plain', 1, $3, $4)`,
          [A, USER_A, `sha256:${HEX("e")}`, HEX("e")], // the plain scheme is refused
        ),
      ),
    ).rejects.toThrow(/content_address/);
    const cols = await db.owner.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'documents'");
    const names = cols.rows.map((r) => r.column_name as string);
    expect(names).toContain("stats_enc");
    expect(names).not.toContain("stats");
  });

  it("is removed with its owner, and docmind_app owns nothing", async () => {
    await db.owner.query("DELETE FROM users WHERE id = $1", [USER_A2]);
    const { rows } = await db.owner.query("SELECT count(*)::int AS n FROM documents WHERE owner_id = $1", [USER_A2]);
    expect(rows[0].n).toBe(0);
    const owned = await db.owner.query(
      "SELECT 1 FROM pg_tables WHERE tablename = 'documents' AND tableowner = 'docmind_app'",
    );
    expect(owned.rowCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `export DOCMIND_TEST_PG_URL=<superuser url> && pnpm --filter @docmind/server exec vitest run app/db/documents.pg.test.ts`
Expected: FAIL (`relation "documents" does not exist`).

- [ ] **Step 3: Write the migration**

`infra/migrations/0009_documents.sql`:

```sql
-- Uploaded documents (spec 4.2). Titles, filenames, stats and summaries are sealed with the owner's
-- data key (the *_enc columns hold Loom's envelope as jsonb); everything else is metadata. The
-- original bytes live in the blob store, addressed by content_address.
CREATE TABLE documents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  owner_id uuid NOT NULL,
  title_enc jsonb NOT NULL,
  filename_enc jsonb NOT NULL,
  mime text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  -- Keyed fingerprint of the plaintext (HMAC-SHA256 under a key derived from the owner's data key),
  -- as the ContentStore ref ("hmac-sha256:<hex>") and as bare hex. Not a plain hash: knowing a
  -- file's sha256 does not let anyone test whether it was uploaded.
  content_address text NOT NULL CHECK (content_address ~ '^hmac-sha256:[0-9a-f]{64}$'),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('uploaded', 'parsing', 'embedding', 'ready', 'failed')),
  -- Plain text: only ever a fixed message, never a filename or document text.
  error text,
  stats_enc jsonb, -- outline, dates, numbers derive from content: sealed like the other *_enc columns
  summary_enc jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- The owner must be a user of the same tenant; deleting the user (erasure) removes the rows.
  CONSTRAINT documents_owner_fkey FOREIGN KEY (tenant_id, owner_id)
    REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  -- Re-uploading identical bytes returns the existing document (spec 4.2).
  CONSTRAINT documents_owner_fingerprint_key UNIQUE (tenant_id, owner_id, fingerprint)
);

CREATE INDEX documents_owner_created_idx ON documents (tenant_id, owner_id, created_at DESC, id DESC);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON documents USING (tenant_id = app_tenant_id());
```

(Default privileges from 0001 give `docmind_app` SELECT/INSERT/UPDATE/DELETE on it; it owns nothing.)

- [ ] **Step 4: Run to verify it passes, gate, commit**

Run: `export DOCMIND_TEST_PG_URL=<superuser url> && pnpm --filter @docmind/server exec vitest run app/db`
Expected: PASS, including the existing M0 "every table has RLS" guard.

```bash
export DOCMIND_TEST_PG_URL=<superuser url> && pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
git switch -c feat/db-documents-table
git add infra/migrations/0009_documents.sql apps/server/app/db/documents.pg.test.ts
git commit -m "feat(db): documents table with row-level security

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
gh pr create --draft --title "feat(db): documents table with row-level security" --body "🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

### Task 48: `FieldCrypto` for the `*_enc` columns

**Files:**
- Create: `apps/server/app/crypto/fields.ts`
- Create: `apps/server/app/crypto/fields.test.ts`

**Interfaces:**
- Consumes: `KeyStore` from `@loom/plugin-crypto` (the same instance the event store uses).
- Produces:
  - `interface UserFieldCipher { seal(bind: string, value: unknown): Promise<unknown>; open(bind: string, envelope: unknown): Promise<unknown>; openText(bind: string, envelope: unknown): Promise<string> }`
  - `class FieldCrypto { constructor(keys: KeyStore); forUser(userId: string): UserFieldCipher }`: the key is fetched lazily and once per cipher (`seal` uses `getOrCreate`, `open` uses `get`); the AAD context is `<userId>|<bind>`.
  - `class FieldKeyUnavailableError extends Error`
  - Callers use binds of the form `document:<documentId>:title` (also `:filename`, `:stats`, `:summary`).

- [ ] **Step 1: Write the failing test**

`apps/server/app/crypto/fields.test.ts`:

```ts
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { describe, expect, it } from "vitest";
import { FieldCrypto, FieldKeyUnavailableError } from "./fields";

const U1 = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const U2 = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";

describe("FieldCrypto", () => {
  it("round-trips text and JSON, and the stored form holds neither", async () => {
    const fields = new FieldCrypto(new InMemoryKeyStore());
    const cipher = fields.forUser(U1);
    const title = await cipher.seal("document:d1:title", "Tax return 2025");
    expect(JSON.stringify(title)).not.toContain("Tax");
    expect(await cipher.openText("document:d1:title", title)).toBe("Tax return 2025");
    const summary = await cipher.seal("document:d1:summary", { tldr: "private" });
    expect(await cipher.open("document:d1:summary", summary)).toEqual({ tldr: "private" });
  });

  it("does not open an envelope moved to another column, row or user", async () => {
    const keys = new InMemoryKeyStore();
    const fields = new FieldCrypto(keys);
    const sealed = await fields.forUser(U1).seal("document:d1:title", "secret");
    await expect(fields.forUser(U1).open("document:d1:filename", sealed)).rejects.toThrow();
    await expect(fields.forUser(U1).open("document:d2:title", sealed)).rejects.toThrow();
    await fields.forUser(U2).seal("document:d1:title", "other"); // U2 gets a key of their own
    await expect(fields.forUser(U2).open("document:d1:title", sealed)).rejects.toThrow();
  });

  it("refuses a value that is not an envelope instead of passing it through", async () => {
    const cipher = new FieldCrypto(new InMemoryKeyStore()).forUser(U1);
    await cipher.seal("b", "x"); // make sure a key exists
    await expect(cipher.open("b", "plain text in the column")).rejects.toThrow(/envelope/);
    await expect(cipher.openText("b", { not: "an envelope" })).rejects.toThrow(/envelope/);
  });

  it("cannot open anything once the user's key is destroyed, and does not mint a new one", async () => {
    const keys = new InMemoryKeyStore();
    const fields = new FieldCrypto(keys);
    const sealed = await fields.forUser(U1).seal("b", "gone soon");
    await keys.destroy(U1);
    await expect(fields.forUser(U1).open("b", sealed)).rejects.toBeInstanceOf(FieldKeyUnavailableError);
    await expect(fields.forUser(U1).seal("b", "again")).rejects.toThrow();
  });

  it("does not touch the key store until a field is sealed or opened", async () => {
    let calls = 0;
    const keys = new InMemoryKeyStore();
    const counting = {
      durable: false,
      getOrCreate: (id: string) => (calls++, keys.getOrCreate(id)),
      get: (id: string) => (calls++, keys.get(id)),
      destroy: (id: string) => keys.destroy(id),
    };
    new FieldCrypto(counting).forUser(U1);
    expect(calls).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @docmind/server exec vitest run app/crypto/fields.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`apps/server/app/crypto/fields.ts`:

```ts
import { type KeyStore, decryptValue, encryptValue } from "@loom/plugin-crypto";

const AAD_VERSION = "docmind-field-v1";

/** The owner's data key does not exist (never created, or destroyed by erasure). */
export class FieldKeyUnavailableError extends Error {
  constructor() {
    super("the data key for this field's owner is unavailable");
    this.name = "FieldKeyUnavailableError";
  }
}

export interface UserFieldCipher {
  /** Seals any JSON value. `bind` names the row and column, e.g. `document:<id>:title`. */
  seal(bind: string, value: unknown): Promise<unknown>;
  /** Opens what `seal` produced for the same `bind`; throws for anything else. */
  open(bind: string, envelope: unknown): Promise<unknown>;
  openText(bind: string, envelope: unknown): Promise<string>;
}

const isEnvelope = (v: unknown): boolean =>
  typeof v === "object" && v !== null && "__loomEnc" in v;

/**
 * Application-level AEAD for the `*_enc` columns, under the owning user's data key (spec §4.4).
 * It reuses Loom's envelope. The AAD binds user + row + column, so a value copied to another
 * row, column or user does not open. Make one cipher per request: it fetches the key lazily, once.
 */
export class FieldCrypto {
  constructor(private readonly keys: KeyStore) {}

  forUser(userId: string): UserFieldCipher {
    const keys = this.keys;
    let sealKey: Promise<Buffer> | undefined;
    let openKey: Promise<Buffer> | undefined;
    const forSeal = () => {
      sealKey ??= keys.getOrCreate(userId);
      return sealKey;
    };
    const forOpen = () => {
      openKey ??= keys.get(userId).then((key) => {
        if (!key) throw new FieldKeyUnavailableError();
        return key;
      });
      return openKey;
    };
    const context = (bind: string) => `${userId}|${bind}`;
    const open = async (bind: string, envelope: unknown): Promise<unknown> => {
      // decryptValue returns a non-envelope untouched; a plaintext in an *_enc column is a bug.
      if (!isEnvelope(envelope)) throw new Error("encrypted field does not hold an envelope");
      return decryptValue(await forOpen(), envelope, context(bind));
    };
    return {
      seal: async (bind, value) =>
        encryptValue(await forSeal(), value, { v: AAD_VERSION, bind: context(bind) }),
      open,
      openText: async (bind, envelope) => {
        const value = await open(bind, envelope);
        if (typeof value !== "string") throw new Error("encrypted field is not text");
        return value;
      },
    };
  }
}
```

- [ ] **Step 4: Run to verify it passes, gate, commit**

Run: `pnpm --filter @docmind/server exec vitest run app/crypto/fields.test.ts`
Expected: PASS.

```bash
export DOCMIND_TEST_PG_URL=<superuser url> && pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
git switch -c feat/server-field-crypto
git add apps/server/app/crypto
git commit -m "feat(server): FieldCrypto for the *_enc columns

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
gh pr create --draft --title "feat(server): FieldCrypto for the *_enc columns" --body "🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

### Task 49: magic-byte sniffer and filename sanitizer

**Files:**
- Create: `apps/server/app/documents/sniff.ts`
- Create: `apps/server/app/documents/sniff.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `SNIFF_BYTES = 4096`
  - `type DocumentKind = "txt" | "md" | "org" | "doc" | "docx" | "pdf" | "png" | "jpg" | "webp"`
  - `interface Sniffed { kind: DocumentKind; mime: string }`
  - `sniff(head: Uint8Array, filename: string): Sniffed | null`: `head` is the first `SNIFF_BYTES` bytes (or the whole file if shorter); `filename` is already sanitized; `null` means unsupported.
  - `sanitizeFilename(raw: string): string`: NFC, no path separators, no control or bidi-override characters, at most 200 code points, never empty (`"untitled"`).
  - `titleFromFilename(filename: string): string`: the name without its last extension (kept whole if that would leave it empty).

- [ ] **Step 1: Write the failing test**

`apps/server/app/documents/sniff.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { sanitizeFilename, sniff, titleFromFilename } from "./sniff";

const hex = (s: string) => Buffer.from(s.replace(/\s/g, ""), "hex");
const text = (s: string) => Buffer.from(s);

describe("sniff", () => {
  it("recognises binary formats by signature, whatever the extension says", () => {
    expect(sniff(text("%PDF-1.7\n..."), "x.png")?.kind).toBe("pdf");
    expect(sniff(hex("89504e470d0a1a0a0000000d"), "x.pdf")?.kind).toBe("png");
    expect(sniff(hex("ffd8ffe000104a464946"), "x")?.kind).toBe("jpg");
    expect(sniff(Buffer.concat([text("RIFF"), hex("24000000"), text("WEBPVP8 ")]), "x.jpg")?.kind).toBe("webp");
    expect(sniff(hex("89504e470d0a1a0a"), "x.pdf")?.mime).toBe("image/png");
  });

  it("accepts OLE2 only as .doc and ZIP only as .docx", () => {
    const ole = hex("d0cf11e0a1b11ae1 0000");
    const zip = hex("504b0304 1400");
    expect(sniff(ole, "report.DOC")?.kind).toBe("doc");
    expect(sniff(ole, "sheet.xls")).toBeNull();
    expect(sniff(zip, "report.docx")?.kind).toBe("docx");
    expect(sniff(zip, "archive.zip")).toBeNull();
    expect(sniff(zip, "deck.pptx")).toBeNull();
    expect(sniff(zip, "noext")).toBeNull();
  });

  it("accepts text by content plus a known extension", () => {
    expect(sniff(text("# Title\n\nSome text\n"), "notes.md")?.kind).toBe("md");
    expect(sniff(text("* Heading\n"), "plan.org")?.kind).toBe("org");
    expect(sniff(text("plain\r\n"), "a.txt")?.mime).toBe("text/plain");
    expect(sniff(text("naïve café"), "a.TXT")?.kind).toBe("txt");
    expect(sniff(hex("fffe 6800 6900"), "u16.txt")?.kind).toBe("txt"); // UTF-16 LE with BOM
  });

  it("rejects binary content disguised as text, unknown extensions, and empty files", () => {
    expect(sniff(hex("00 01 02 03 04"), "a.txt")).toBeNull();
    expect(sniff(text("hello\u0000world"), "a.txt")).toBeNull();
    expect(sniff(text("hello"), "a.exe")).toBeNull();
    expect(sniff(text("hello"), "noextension")).toBeNull();
    expect(sniff(Buffer.alloc(0), "a.txt")).toBeNull();
    expect(sniff(hex("7f454c46 02 01 01 00"), "a.txt")).toBeNull(); // ELF binary
  });
});

describe("sanitizeFilename", () => {
  it("keeps only a safe base name", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Users\\me\\a.docx")).toBe("a.docx");
    expect(sanitizeFilename("a\u0000b\u0007c.txt")).toBe("abc.txt");
    expect(sanitizeFilename("evil\u202etxt.exe")).toBe("eviltxt.exe");
    expect(sanitizeFilename("  spaced  name.md ")).toBe("spaced name.md");
    expect(sanitizeFilename("Cafe\u0301.txt")).toBe("Caf\u00e9.txt"); // NFC
  });

  it("is never empty and never longer than 200 code points", () => {
    for (const bad of ["", "   ", "///", "..", "\u0000"]) expect(sanitizeFilename(bad)).toBe("untitled");
    expect([...sanitizeFilename(`${"é".repeat(500)}.txt`)].length).toBeLessThanOrEqual(200);
  });
});

describe("titleFromFilename", () => {
  it("drops the last extension only", () => {
    expect(titleFromFilename("Quarterly report.final.docx")).toBe("Quarterly report.final");
    expect(titleFromFilename("notes.md")).toBe("notes");
    expect(titleFromFilename(".gitignore")).toBe(".gitignore");
    expect(titleFromFilename("README")).toBe("README");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @docmind/server exec vitest run app/documents/sniff.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`apps/server/app/documents/sniff.ts`:

```ts
export const SNIFF_BYTES = 4096;

export type DocumentKind = "txt" | "md" | "org" | "doc" | "docx" | "pdf" | "png" | "jpg" | "webp";
export interface Sniffed {
  kind: DocumentKind;
  mime: string;
}

const MIME: Record<DocumentKind, string> = {
  txt: "text/plain",
  md: "text/markdown",
  org: "text/x-org",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
};
const found = (kind: DocumentKind): Sniffed => ({ kind, mime: MIME[kind] });

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0): boolean =>
  b.length >= at + sig.length && sig.every((byte, i) => b[at + i] === byte);

const extensionOf = (filename: string): string => {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
};

// C0 controls other than TAB, LF, VT, FF, CR and ESC mark binary content.
const isBinaryByte = (byte: number): boolean =>
  byte < 0x20 && ![0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1b].includes(byte);

function looksLikeText(head: Uint8Array): boolean {
  if (startsWith(head, [0xff, 0xfe]) || startsWith(head, [0xfe, 0xff])) return true; // UTF-16 BOM
  return head.every((byte) => !isBinaryByte(byte));
}

/**
 * What a file is, decided from its first bytes. The extension is a hint that only breaks ties the
 * bytes cannot: OLE2 and ZIP containers are shared by many Office formats, and text has no
 * signature. `filename` must already be sanitized. Returns null for anything unsupported.
 * (Deep validation of docx and pdf is the M3 parsers' job, inside the sandbox.)
 */
export function sniff(head: Uint8Array, filename: string): Sniffed | null {
  if (head.length === 0) return null;
  const ext = extensionOf(filename);
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return found("pdf"); // %PDF-
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return found("png");
  if (startsWith(head, [0xff, 0xd8, 0xff])) return found("jpg");
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) {
    return found("webp"); // RIFF....WEBP
  }
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    return ext === "doc" ? found("doc") : null;
  }
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return ext === "docx" ? found("docx") : null;
  if (!looksLikeText(head)) return null;
  if (ext === "txt") return found("txt");
  if (ext === "md" || ext === "markdown") return found("md");
  if (ext === "org") return found("org");
  return null;
}

// Control characters and the bidi overrides that make a name display as something else.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;
const MAX_NAME_CODE_POINTS = 200;

/** A display-safe base name. Never used to build a path; the original is not kept. */
export function sanitizeFilename(raw: string): string {
  const base = raw.normalize("NFC").replace(UNSAFE, "").split(/[\\/]/).pop() ?? "";
  const trimmed = [...base.trim()].slice(0, MAX_NAME_CODE_POINTS).join("").trim();
  return trimmed === "" || /^\.+$/.test(trimmed) ? "untitled" : trimmed;
}

/** The default title: the file name without its last extension. */
export function titleFromFilename(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}
```

- [ ] **Step 4: Run to verify it passes, gate, commit**

Run: `pnpm --filter @docmind/server exec vitest run app/documents/sniff.test.ts`
Expected: PASS.

```bash
export DOCMIND_TEST_PG_URL=<superuser url> && pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
git switch -c feat/server-upload-sniff
git add apps/server/app/documents
git commit -m "feat(server): magic-byte sniffer and filename sanitizer

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
gh pr create --draft --title "feat(server): magic-byte sniffer and filename sanitizer" --body "🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

### Task 50: upload limits from the environment, `peek`, and config placeholders

**Files:**
- Create: `apps/server/app/documents/limits.ts`
- Create: `apps/server/app/documents/limits.test.ts`
- Create: `apps/server/app/http/peek.ts`
- Create: `apps/server/app/http/peek.test.ts`
- Modify: `.env.example`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface DocumentLimits { maxFileBytes: number; tenantMaxBytes: number; tenantMaxDocuments: number; maxConcurrentUploadsPerUser: number }`
  - `DEFAULT_LIMITS: DocumentLimits` (50 MiB, 1 GiB, 500, 2)
  - `loadLimits(env?: NodeJS.ProcessEnv): DocumentLimits`: reads `DOCMIND_MAX_UPLOAD_BYTES`, `DOCMIND_TENANT_MAX_BYTES`, `DOCMIND_TENANT_MAX_DOCUMENTS`, `DOCMIND_MAX_CONCURRENT_UPLOADS`; blank means default; anything that is not a positive safe integer throws `<NAME> must be a positive integer` (no value in the message); `DOCMIND_MAX_UPLOAD_BYTES` above 256 MiB throws too (a read buffers the whole file).
  - `loadBlobRoot(env?: NodeJS.ProcessEnv): string`: `DOCMIND_BLOB_DIR` resolved to an absolute path, default `./data/blobs`.
  - `peek(source: AsyncIterable<Uint8Array>, n: number): Promise<{ head: Buffer; rest: AsyncIterable<Uint8Array> }>`: reads at least `n` bytes (or to the end), returns the first `n` as `head`, and `rest` replays **the whole stream from byte 0** (the buffered bytes, then the remainder). `rest` can be iterated once.

- [ ] **Step 1: Write the failing tests**

`apps/server/app/documents/limits.test.ts`:

```ts
import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, loadBlobRoot, loadLimits } from "./limits";

describe("loadLimits", () => {
  it("uses the spec defaults when nothing is set", () => {
    expect(loadLimits({})).toEqual(DEFAULT_LIMITS);
    expect(DEFAULT_LIMITS.maxFileBytes).toBe(50 * 1024 * 1024);
    expect(loadLimits({ DOCMIND_TENANT_MAX_DOCUMENTS: "  " })).toEqual(DEFAULT_LIMITS);
  });

  it("reads overrides", () => {
    expect(
      loadLimits({
        DOCMIND_MAX_UPLOAD_BYTES: "1000",
        DOCMIND_TENANT_MAX_BYTES: "5000",
        DOCMIND_TENANT_MAX_DOCUMENTS: "3",
        DOCMIND_MAX_CONCURRENT_UPLOADS: "1",
      }),
    ).toEqual({ maxFileBytes: 1000, tenantMaxBytes: 5000, tenantMaxDocuments: 3, maxConcurrentUploadsPerUser: 1 });
  });

  it("names the variable, never the value, when one is invalid", () => {
    for (const bad of ["0", "-5", "1.5", "abc", "1e3", "99999999999999999999"]) {
      let message = "";
      try {
        loadLimits({ DOCMIND_TENANT_MAX_BYTES: bad });
      } catch (err) {
        message = String(err);
      }
      expect(message, bad).toContain("DOCMIND_TENANT_MAX_BYTES must be a positive integer");
      expect(message).not.toContain(bad === "0" ? "zzz" : `"${bad}"`);
    }
  });

  it("refuses a per-file limit above 256 MiB", () => {
    expect(() => loadLimits({ DOCMIND_MAX_UPLOAD_BYTES: String(257 * 1024 * 1024) })).toThrow(
      /DOCMIND_MAX_UPLOAD_BYTES must be at most/,
    );
  });
});

describe("loadBlobRoot", () => {
  it("is absolute whether or not it is configured", () => {
    expect(isAbsolute(loadBlobRoot({}))).toBe(true);
    expect(isAbsolute(loadBlobRoot({ DOCMIND_BLOB_DIR: "relative/blobs" }))).toBe(true);
    expect(loadBlobRoot({ DOCMIND_BLOB_DIR: "/var/lib/docmind" })).toBe("/var/lib/docmind");
  });
});
```

`apps/server/app/http/peek.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { peek } from "./peek";

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield Buffer.from(p);
}
async function collect(source: AsyncIterable<Uint8Array>): Promise<string> {
  const out: Buffer[] = [];
  for await (const c of source) out.push(Buffer.from(c));
  return Buffer.concat(out).toString();
}

describe("peek", () => {
  it("returns the first n bytes and replays the whole stream", async () => {
    const { head, rest } = await peek(chunks("abc", "defgh", "ij"), 4);
    expect(head.toString()).toBe("abcd");
    expect(await collect(rest)).toBe("abcdefghij");
  });

  it("handles a stream shorter than n, and an empty one", async () => {
    const short = await peek(chunks("ab"), 10);
    expect(short.head.toString()).toBe("ab");
    expect(await collect(short.rest)).toBe("ab");
    const empty = await peek(chunks(), 10);
    expect(empty.head.length).toBe(0);
    expect(await collect(empty.rest)).toBe("");
  });

  it("reads no more than it needs", async () => {
    let pulled = 0;
    async function* counting() {
      for (const p of ["aa", "bb", "cc", "dd"]) {
        pulled++;
        yield Buffer.from(p);
      }
    }
    await peek(counting(), 3);
    expect(pulled).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @docmind/server exec vitest run app/documents/limits.test.ts app/http/peek.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`apps/server/app/documents/limits.ts`:

```ts
import { resolve } from "node:path";

export interface DocumentLimits {
  /** Largest single file (spec §4.3: 50 MB). */
  maxFileBytes: number;
  /** Total plaintext bytes a tenant may store. */
  tenantMaxBytes: number;
  /** Most documents a tenant may hold. */
  tenantMaxDocuments: number;
  /** Uploads one user may have in flight at once, per server process. */
  maxConcurrentUploadsPerUser: number;
}

export const DEFAULT_LIMITS: DocumentLimits = {
  maxFileBytes: 50 * 1024 * 1024,
  tenantMaxBytes: 1024 * 1024 * 1024,
  tenantMaxDocuments: 500,
  maxConcurrentUploadsPerUser: 2,
};

// Reading a blob buffers it whole, so the per-file limit has a ceiling.
const MAX_FILE_CEILING = 256 * 1024 * 1024;

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  // The message names the variable only: the value could be anything the operator typed.
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

/** Quotas from the environment, validated at startup so a typo fails the boot, not an upload. */
export function loadLimits(env: NodeJS.ProcessEnv = process.env): DocumentLimits {
  const limits: DocumentLimits = {
    maxFileBytes: positiveInt(env, "DOCMIND_MAX_UPLOAD_BYTES", DEFAULT_LIMITS.maxFileBytes),
    tenantMaxBytes: positiveInt(env, "DOCMIND_TENANT_MAX_BYTES", DEFAULT_LIMITS.tenantMaxBytes),
    tenantMaxDocuments: positiveInt(env, "DOCMIND_TENANT_MAX_DOCUMENTS", DEFAULT_LIMITS.tenantMaxDocuments),
    maxConcurrentUploadsPerUser: positiveInt(
      env,
      "DOCMIND_MAX_CONCURRENT_UPLOADS",
      DEFAULT_LIMITS.maxConcurrentUploadsPerUser,
    ),
  };
  if (limits.maxFileBytes > MAX_FILE_CEILING) {
    throw new Error("DOCMIND_MAX_UPLOAD_BYTES must be at most 268435456 (256 MiB)");
  }
  return limits;
}

/** Where blobs live: `DOCMIND_BLOB_DIR`, default `./data/blobs`, always absolute. */
export function loadBlobRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.DOCMIND_BLOB_DIR?.trim() || "data/blobs");
}
```

`apps/server/app/http/peek.ts`:

```ts
/**
 * Buffers the first `n` bytes of a stream so they can be inspected (magic-byte sniffing), then
 * hands back a stream that replays everything from byte 0. Pulls no more chunks than it needs.
 */
export async function peek(
  source: AsyncIterable<Uint8Array>,
  n: number,
): Promise<{ head: Buffer; rest: AsyncIterable<Uint8Array> }> {
  const iterator = source[Symbol.asyncIterator]();
  const buffered: Buffer[] = [];
  let have = 0;
  let ended = false;
  while (have < n) {
    const next = await iterator.next();
    if (next.done) {
      ended = true;
      break;
    }
    const chunk = Buffer.from(next.value);
    buffered.push(chunk);
    have += chunk.length;
  }
  const all = Buffer.concat(buffered);
  async function* rest(): AsyncGenerator<Uint8Array> {
    if (all.length > 0) yield all;
    if (ended) return;
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  }
  return { head: all.subarray(0, n), rest: rest() };
}
```

Append to `.env.example`, before the "Used from M3" block:

```
# Where encrypted document blobs are stored (a directory the server user owns; default ./data/blobs).
DOCMIND_BLOB_DIR=./data/blobs
# Upload quotas (defaults shown). The per-file limit is at most 268435456.
DOCMIND_MAX_UPLOAD_BYTES=52428800
DOCMIND_TENANT_MAX_BYTES=1073741824
DOCMIND_TENANT_MAX_DOCUMENTS=500
DOCMIND_MAX_CONCURRENT_UPLOADS=2

```

Append to `.gitignore`: a line `/data`.

- [ ] **Step 4: Run to verify it passes, gate, commit**

Run: `pnpm --filter @docmind/server exec vitest run app/documents/limits.test.ts app/http/peek.test.ts`
Expected: PASS.

```bash
export DOCMIND_TEST_PG_URL=<superuser url> && pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
git switch -c feat/server-upload-limits
git add apps/server/app/documents/limits.ts apps/server/app/documents/limits.test.ts apps/server/app/http/peek.ts apps/server/app/http/peek.test.ts .env.example .gitignore
git commit -m "feat(server): upload limits from the environment and a stream peek helper

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
gh pr create --draft --title "feat(server): upload limits from the environment and a stream peek helper" --body "🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

### Task 51: streaming single-file multipart reader (busboy)

**Files:**
- Modify: `apps/server/package.json` (add `busboy` to `dependencies`, `@types/busboy` to `devDependencies`) and `pnpm-lock.yaml` (not counted)
- Create: `apps/server/app/http/multipart.ts`
- Create: `apps/server/app/http/multipart.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `class UploadTooLargeError extends Error`
  - `interface IncomingFile { filename: string; body: AsyncIterable<Uint8Array> }`: `filename` is the raw client string (untrusted); `body` throws `UploadTooLargeError` as soon as the file passes `maxFileBytes`.
  - `type ReceiveResult<T> = { ok: true; value: T } | { ok: false; status: number; code: string; message: string }`
  - `receiveFile<T>(req: IncomingMessage, options: { maxFileBytes: number }, handle: (file: IncomingFile) => Promise<T>): Promise<ReceiveResult<T>>`: requires `multipart/form-data`; takes the first file part, which must be named `file` (text fields and any later parts are drained and ignored, because the first file's work is already done by the time they arrive); calls `handle` as soon as that part starts (the file is streamed, never buffered by this function); maps: not multipart -> 415 `unsupported_media_type`; declared length over `maxFileBytes + 65536` -> 413 `payload_too_large`; no file / first file part not named `file` / malformed body -> 400 `invalid_request`; `UploadTooLargeError` from `handle` or the body -> 413 `payload_too_large`. Any other error thrown by `handle` rejects the returned promise (the router answers 500). The returned promise settles only after `handle` has settled.

- [ ] **Step 1: Add the dependency**

In `apps/server/package.json` add `"busboy": "^1.6.0"` to `dependencies` and `"@types/busboy": "^1.5.4"` to `devDependencies`, then run `pnpm install`.
Expected: success.

- [ ] **Step 2: Write the failing test**

`apps/server/app/http/multipart.test.ts`:

```ts
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UploadTooLargeError, receiveFile } from "./multipart";

const MAX = 100;
let server: Server;
let base = "";
let seen: { filename: string; bytes: string }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    receiveFile(req, { maxFileBytes: MAX }, async (file) => {
      const chunks: Buffer[] = [];
      for await (const c of file.body) chunks.push(Buffer.from(c));
      const got = { filename: file.filename, bytes: Buffer.concat(chunks).toString() };
      seen.push(got);
      if (got.filename === "boom.txt") throw new Error("handler exploded");
      if (got.filename === "toolarge.txt") throw new UploadTooLargeError();
      return got;
    }).then(
      (result) => {
        res.setHeader("connection", "close");
        res.writeHead(result.ok ? 200 : result.status, { "content-type": "application/json" });
        res.end(JSON.stringify(result.ok ? result.value : { code: result.code }));
      },
      () => {
        res.writeHead(500);
        res.end();
      },
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
});

const post = (form: FormData) => fetch(`${base}/`, { method: "POST", body: form });
const file = (name: string, content: string, field = "file") => {
  const form = new FormData();
  form.append(field, new Blob([content]), name);
  return form;
};

describe("receiveFile", () => {
  it("streams the single file part to the handler", async () => {
    seen = [];
    const res = await post(file("notes.txt", "hello"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ filename: "notes.txt", bytes: "hello" });
  });

  it("keeps a unicode filename intact and strips any directory part", async () => {
    seen = [];
    await post(file("café/../résumé.txt", "x"));
    expect(seen[0]?.filename).toBe("résumé.txt");
  });

  it("accepts a file of exactly the limit and rejects one byte more with 413", async () => {
    expect((await post(file("a.txt", "x".repeat(MAX)))).status).toBe(200);
    const res = await post(file("a.txt", "x".repeat(MAX + 1)));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ code: "payload_too_large" });
  });

  it("answers 415 for a body that is not multipart", async () => {
    const res = await fetch(`${base}/`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(415);
  });

  it("answers 400 for no file or a wrongly named file part, and never calls the handler for them", async () => {
    seen = [];
    expect((await post(new FormData())).status).toBe(400);
    expect((await post(file("a.txt", "x", "upload"))).status).toBe(400);
    expect(seen).toEqual([]);
  });

  it("ignores text fields and any later parts: only the first file part is used", async () => {
    seen = [];
    const form = new FormData();
    form.append("note", "hello");
    form.append("file", new Blob(["first"]), "a.txt");
    form.append("file", new Blob(["second"]), "b.txt");
    expect((await post(form)).status).toBe(200);
    expect(seen).toEqual([{ filename: "a.txt", bytes: "first" }]);
  });

  it("answers 400 for a malformed multipart body", async () => {
    const res = await fetch(`${base}/`, {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=zzz" },
      body: "--zzz\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.txt\"\r\n\r\ntruncated",
    });
    expect(res.status).toBe(400);
  });

  it("rejects the request when the handler fails for any other reason", async () => {
    expect((await post(file("boom.txt", "x"))).status).toBe(500);
  });

  it("maps UploadTooLargeError thrown by the handler to 413", async () => {
    expect((await post(file("toolarge.txt", "x"))).status).toBe(413);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm --filter @docmind/server exec vitest run app/http/multipart.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement**

`apps/server/app/http/multipart.ts`:

```ts
import type { IncomingMessage } from "node:http";
import busboy from "busboy";

/** The file passed the size limit while it was streaming in. */
export class UploadTooLargeError extends Error {
  constructor() {
    super("upload exceeds the size limit");
    this.name = "UploadTooLargeError";
  }
}

export interface IncomingFile {
  /** What the client called it. Untrusted: sanitize before storing, never build a path from it. */
  filename: string;
  /** The file bytes as they arrive; throws `UploadTooLargeError` past `maxFileBytes`. */
  body: AsyncIterable<Uint8Array>;
}

export type ReceiveResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string };

// Multipart framing around the file (boundaries, the part's headers).
const ENVELOPE_SLACK = 64 * 1024;

const failure = (status: number, code: string, message: string) =>
  ({ ok: false, status, code, message }) as const;

/**
 * Reads a `multipart/form-data` request that carries exactly one part, named `file`. The file is
 * handed to `handle` while it streams in; nothing is buffered here. Parser limits (parts, header
 * pairs, name and field sizes) keep a hostile body from costing memory.
 */
export function receiveFile<T>(
  req: IncomingMessage,
  options: { maxFileBytes: number },
  handle: (file: IncomingFile) => Promise<T>,
): Promise<ReceiveResult<T>> {
  const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "multipart/form-data") {
    return Promise.resolve(failure(415, "unsupported_media_type", "send multipart/form-data"));
  }
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > options.maxFileBytes + ENVELOPE_SLACK) {
    return Promise.resolve(failure(413, "payload_too_large", "request body is too large"));
  }

  return new Promise<ReceiveResult<T>>((resolve, reject) => {
    let parser: busboy.Busboy;
    try {
      parser = busboy({
        headers: req.headers,
        defParamCharset: "utf8",
        preservePath: false, // the directory part of a filename is dropped
        limits: {
          files: 1, // later files are dropped by the parser
          fields: 8,
          fieldSize: 1024,
          fieldNameSize: 64,
          parts: 16,
          fileSize: options.maxFileBytes,
          headerPairs: 16,
        },
      });
    } catch {
      return resolve(failure(400, "invalid_request", "malformed multipart request"));
    }

    let outcome: ReceiveResult<T> | undefined;
    let work: Promise<void> | undefined;
    let sawFile = false;
    const settle = (result: ReceiveResult<T>) => {
      outcome ??= result;
    };

    parser.on("file", (name, stream, info) => {
      if (sawFile) return void stream.resume(); // only the first file part counts
      sawFile = true;
      if (name !== "file") {
        stream.resume();
        return settle(failure(400, "invalid_request", "send the document as a part named file"));
      }
      stream.on("limit", () => stream.destroy(new UploadTooLargeError()));
      work = handle({ filename: info.filename ?? "", body: stream }).then(
        (value) => settle({ ok: true, value }),
        (err: unknown) => {
          if (err instanceof UploadTooLargeError) {
            return settle(failure(413, "payload_too_large", "file is too large"));
          }
          throw err;
        },
      );
      // The rejection is surfaced when the parser closes; avoid an unhandled-rejection warning.
      work.catch(() => {});
    });
    // Text fields are not used; busboy discards them (bounded by the limits above).
    parser.on("error", () => settle(failure(400, "invalid_request", "malformed multipart request")));
    parser.on("close", () => {
      (work ?? Promise.resolve()).then(
        () => {
          if (!sawFile) settle(failure(400, "invalid_request", "no file was sent"));
          resolve(outcome as ReceiveResult<T>);
        },
        reject,
      );
    });
    req.on("error", () => settle(failure(400, "invalid_request", "request was interrupted")));
    req.pipe(parser);
  });
}
```

Notes for the executor: busboy's typings and event semantics are the plan's least-verified part (see "Uncertain" #1). The invariant to preserve is that **a request answered 400 or 413 leaves no row and no blob**: that is why only the first file part is acted on (a failure discovered after the handler's work has committed would be too late) and why the handler runs inside `receiveFile`'s own `work` promise, which `close` awaits before resolving. Task 57 asserts the invariant through the whole route. `settle` keeps the first outcome, which is the right rule now that nothing after the first file part can fail the request.

- [ ] **Step 5: Run to verify it passes, gate, commit**

Run: `pnpm --filter @docmind/server exec vitest run app/http/multipart.test.ts`
Expected: PASS (8 tests).

```bash
export DOCMIND_TEST_PG_URL=<superuser url> && pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
git switch -c feat/server-multipart
git add apps/server/package.json pnpm-lock.yaml apps/server/app/http/multipart.ts apps/server/app/http/multipart.test.ts
git commit -m "feat(server): streaming single-file multipart reader

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
gh pr create --draft --title "feat(server): streaming single-file multipart reader" --body "Adds busboy. Lockfile not counted.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

### Task 52a: documents repository (insert, find, DTO mapping) and the test harness basics

**Files:**
- Create: `apps/server/app/documents/repo.ts`
- Create: `apps/server/app/documents/testHarness.ts`
- Create: `apps/server/app/documents/repo.pg.test.ts`

**Interfaces:**
- Consumes: Task 47 (table), Task 48 (`UserFieldCipher`), contracts `DocumentDto`, `DocumentStats`, `DocumentSummary`.
- Produces (all from `app/documents/repo.ts`; every function takes the `PoolClient` that `withTenant` supplies):
  - `interface DocumentRow { id: string; title_enc: unknown; filename_enc: unknown; mime: string; size_bytes: string; status: DocumentStatus; error: string | null; stats_enc: unknown; summary_enc: unknown; created_at: Date; updated_at: Date; created_cursor: string }`
  - `DOCUMENT_COLUMNS: string` (the SELECT/RETURNING list, including `created_cursor`)
  - `findByFingerprint(tx, ownerId, fingerprint): Promise<DocumentRow | undefined>`
  - `insertDocument(tx, doc: NewDocument): Promise<DocumentRow>` where `NewDocument = { id, tenantId, ownerId, titleEnc: unknown, filenameEnc: unknown, mime, sizeBytes: number, contentAddress, fingerprint }`
  - `toDto(row, cipher): Promise<DocumentDto>`
  - `titleBind(id)`, `filenameBind(id)`, `statsBind(id)`, `summaryBind(id)`: `document:<id>:title|filename|stats|summary`
- From `app/documents/testHarness.ts` (used by Tasks 53-62): `T1`, `T2`, `U1`, `U1B`, `U2`, `ALICE`, `ALICE2`, `BOB` (`Identity`s), `seedUsers(owner: Pool)`, `testAuthenticator` (header `x-test-user: alice | alice2 | bob`), `PNG`, `PDF`, `TEXT` sample byte buffers.

- [ ] **Step 1: Write the harness and the failing test**

`apps/server/app/documents/testHarness.ts`:

```ts
import type { Authenticator, Identity } from "@docmind/auth";
import type { Pool } from "pg";

export const T1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const T2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const U1 = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
export const U1B = "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2"; // a second user of tenant 1
export const U2 = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";

export const ALICE: Identity = { tenantId: T1, userId: U1 };
export const ALICE2: Identity = { tenantId: T1, userId: U1B };
export const BOB: Identity = { tenantId: T2, userId: U2 };

/** Two tenants; tenant 1 has two users. Run as the owner role. */
export async function seedUsers(owner: Pool): Promise<void> {
  await owner.query(`
    INSERT INTO tenants (id, name) VALUES ('${T1}', 'one'), ('${T2}', 'two');
    INSERT INTO users (id, tenant_id, email, password_hash) VALUES
      ('${U1}', '${T1}', 'alice@example.com', 'x'),
      ('${U1B}', '${T1}', 'alice2@example.com', 'x'),
      ('${U2}', '${T2}', 'bob@example.com', 'x')`);
}

export const BY_HEADER: Record<string, Identity> = { alice: ALICE, alice2: ALICE2, bob: BOB };

/** Test-only: who the caller is comes from the `x-test-user` header. */
export const testAuthenticator: Authenticator = {
  async authenticate(req) {
    return BY_HEADER[String(req.headers["x-test-user"])] ?? null;
  },
};

// Smallest inputs the sniffer accepts, plus padding so each is distinct bytes.
export const PNG = (tag = "") => Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), Buffer.from(tag)]);
export const PDF = (tag = "") => Buffer.from(`%PDF-1.7\n${tag}\n%%EOF`);
export const TEXT = (tag = "") => Buffer.from(`some plain text ${tag}\n`);
```

`apps/server/app/documents/repo.pg.test.ts`:

```ts
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FieldCrypto } from "../crypto/fields";
import { migrate, setAppRolePassword } from "../db/migrate";
import { withTenant } from "../db/tenant";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";
import {
  DOCUMENT_COLUMNS,
  type DocumentRow,
  type NewDocument,
  filenameBind,
  findByFingerprint,
  insertDocument,
  statsBind,
  titleBind,
  toDto,
} from "./repo";
import { T1, T2, U1, U1B, U2, seedUsers } from "./testHarness";

const FP = (c: string) => c.repeat(64);

describe.skipIf(!PG_URL)("documents repository (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;
  const fields = new FieldCrypto(new InMemoryKeyStore());

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

  async function newDoc(tenant: string, owner: string, fingerprint: string, size = 10): Promise<NewDocument> {
    const id = randomUUID();
    const cipher = fields.forUser(owner);
    return {
      id,
      tenantId: tenant,
      ownerId: owner,
      titleEnc: await cipher.seal(titleBind(id), "Quarterly report"),
      filenameEnc: await cipher.seal(filenameBind(id), "Quarterly report.pdf"),
      mime: "application/pdf",
      sizeBytes: size,
      contentAddress: `hmac-sha256:${fingerprint}`,
      fingerprint,
    };
  }

  it("inserts a row and maps it to a DTO with decrypted title and filename", async () => {
    const doc = await newDoc(T1, U1, FP("1"), 1234);
    const dto = await withTenant(app, T1, async (tx) => toDto(await insertDocument(tx, doc), fields.forUser(U1)));
    expect(dto).toMatchObject({
      id: doc.id,
      title: "Quarterly report",
      filename: "Quarterly report.pdf",
      mime: "application/pdf",
      sizeBytes: 1234,
      status: "uploaded",
      error: null,
      stats: null,
      summary: null,
    });
    expect(new Date(dto.createdAt).toISOString()).toBe(dto.createdAt);
    const raw = await db.owner.query("SELECT title_enc::text AS t, filename_enc::text AS f FROM documents WHERE id = $1", [doc.id]);
    expect(raw.rows[0].t + raw.rows[0].f).not.toContain("Quarterly");
  });

  it("finds a duplicate by owner and fingerprint only", async () => {
    await withTenant(app, T1, async (tx) => insertDocument(tx, await newDoc(T1, U1, FP("2"))));
    await withTenant(app, T1, async (tx) => {
      expect(await findByFingerprint(tx, U1, FP("2"))).toBeDefined();
      expect(await findByFingerprint(tx, U1B, FP("2"))).toBeUndefined(); // another user, same tenant
      expect(await findByFingerprint(tx, U1, FP("9"))).toBeUndefined();
    });
    await withTenant(app, T2, async (tx) => {
      expect(await findByFingerprint(tx, U2, FP("2"))).toBeUndefined(); // another tenant
    });
  });

  it("refuses to open a DTO whose envelope was moved to another document", async () => {
    const a = await newDoc(T1, U1, FP("5"));
    const b = await newDoc(T1, U1, FP("6"));
    const swapped = { ...a, titleEnc: b.titleEnc };
    await expect(
      withTenant(app, T1, async (tx) => toDto(await insertDocument(tx, swapped), fields.forUser(U1))),
    ).rejects.toThrow();
  });

  it("opens stats_enc into the DTO's stats and never stores it in the clear", async () => {
    const doc = await newDoc(T1, U1, FP("7"));
    const cipher = fields.forUser(U1);
    const stats = {
      wordCount: 3,
      pageCount: null,
      readingTimeMinutes: 0.1,
      language: "en",
      outline: ["Secret heading"],
      dates: [],
      numbers: [],
    };
    const dto = await withTenant(app, T1, async (tx) => {
      await insertDocument(tx, doc);
      await tx.query("UPDATE documents SET stats_enc = $2::jsonb WHERE id = $1", [
        doc.id,
        JSON.stringify(await cipher.seal(statsBind(doc.id), stats)),
      ]);
      const { rows } = await tx.query<DocumentRow>(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = $1`, [doc.id]);
      return toDto(rows[0] as DocumentRow, cipher);
    });
    expect(dto.stats).toEqual(stats);
    const raw = await db.owner.query("SELECT stats_enc::text AS s FROM documents WHERE id = $1", [doc.id]);
    expect(raw.rows[0].s).not.toContain("Secret heading");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `export DOCMIND_TEST_PG_URL=<superuser url> && pnpm --filter @docmind/server exec vitest run app/documents/repo.pg.test.ts`
Expected: FAIL (module `./repo` not found).

- [ ] **Step 3: Implement**

`apps/server/app/documents/repo.ts`:

```ts
import {
  type DocumentDto,
  DocumentStats,
  type DocumentStatus,
  DocumentSummary,
} from "@docmind/contracts";
import type { PoolClient } from "pg";
import type { UserFieldCipher } from "../crypto/fields";

export const titleBind = (id: string) => `document:${id}:title`;
export const filenameBind = (id: string) => `document:${id}:filename`;
export const statsBind = (id: string) => `document:${id}:stats`;
export const summaryBind = (id: string) => `document:${id}:summary`;

/** The SELECT/RETURNING list. `created_cursor` is the microsecond-exact keyset value. */
export const DOCUMENT_COLUMNS = `id, title_enc, filename_enc, mime, size_bytes, status, error, stats_enc,
  summary_enc, created_at, updated_at,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_cursor`;

export interface DocumentRow {
  id: string;
  title_enc: unknown;
  filename_enc: unknown;
  mime: string;
  size_bytes: string; // bigint arrives as text
  status: DocumentStatus;
  error: string | null;
  stats_enc: unknown;
  summary_enc: unknown;
  created_at: Date;
  updated_at: Date;
  created_cursor: string;
}

export interface NewDocument {
  id: string;
  tenantId: string;
  ownerId: string;
  titleEnc: unknown;
  filenameEnc: unknown;
  mime: string;
  sizeBytes: number;
  contentAddress: string;
  fingerprint: string;
}

export async function findByFingerprint(
  tx: PoolClient,
  ownerId: string,
  fingerprint: string,
): Promise<DocumentRow | undefined> {
  const { rows } = await tx.query<DocumentRow>(
    `SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE owner_id = $1 AND fingerprint = $2`,
    [ownerId, fingerprint],
  );
  return rows[0];
}

export async function insertDocument(tx: PoolClient, doc: NewDocument): Promise<DocumentRow> {
  const { rows } = await tx.query<DocumentRow>(
    `INSERT INTO documents (id, tenant_id, owner_id, title_enc, filename_enc, mime, size_bytes,
                            content_address, fingerprint)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9)
     RETURNING ${DOCUMENT_COLUMNS}`,
    [
      doc.id,
      doc.tenantId,
      doc.ownerId,
      JSON.stringify(doc.titleEnc),
      JSON.stringify(doc.filenameEnc),
      doc.mime,
      doc.sizeBytes,
      doc.contentAddress,
      doc.fingerprint,
    ],
  );
  return rows[0] as DocumentRow;
}

export async function toDto(row: DocumentRow, cipher: UserFieldCipher): Promise<DocumentDto> {
  return {
    id: row.id,
    title: await cipher.openText(titleBind(row.id), row.title_enc),
    filename: await cipher.openText(filenameBind(row.id), row.filename_enc),
    mime: row.mime,
    sizeBytes: Number(row.size_bytes),
    status: row.status,
    error: row.error,
    stats:
      row.stats_enc == null
        ? null
        : DocumentStats.parse(await cipher.open(statsBind(row.id), row.stats_enc)),
    summary:
      row.summary_enc == null
        ? null
        : DocumentSummary.parse(await cipher.open(summaryBind(row.id), row.summary_enc)),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
```

- [ ] **Step 4: Run to verify it passes, gate, commit**

Run: `export DOCMIND_TEST_PG_URL=<superuser url> && pnpm --filter @docmind/server exec vitest run app/documents/repo.pg.test.ts`
Expected: PASS.

```bash
export DOCMIND_TEST_PG_URL=<superuser url> && pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
git switch -c feat/server-documents-repo
git add apps/server/app/documents
git commit -m "feat(server): documents repository, DTO mapping and test harness basics

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
gh pr create --draft --title "feat(server): documents repository, DTO mapping and test harness" --body "🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Expected: gate green; about 190 changed lines, 3 files. `lockTenantForWrite` and `usageOfTenant` are Task 52b.

---

### Task 52b: per-tenant write lock and usage counts

**Files:**
- Modify: `apps/server/app/documents/repo.ts` (add `lockTenantForWrite`, `usageOfTenant`)
- Create: `apps/server/app/documents/repoTenant.pg.test.ts`

**Interfaces:**
- Consumes: Task 52a (`insertDocument`, `NewDocument`, the binds), Task 48 (`FieldCrypto`).
- Produces:
  - `lockTenantForWrite(tx, tenantId): Promise<void>`: `pg_advisory_xact_lock` on the tenant; held to commit.
  - `usageOfTenant(tx): Promise<{ documents: number; bytes: number }>` (RLS limits it to the transaction's tenant)

- [ ] **Step 1: Write the failing tests**

`apps/server/app/documents/repoTenant.pg.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FieldCrypto } from "../crypto/fields";
import { migrate, setAppRolePassword } from "../db/migrate";
import { withTenant } from "../db/tenant";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";
import { filenameBind, insertDocument, lockTenantForWrite, titleBind, usageOfTenant } from "./repo";
import { T1, T2, U1, U1B, U2, seedUsers } from "./testHarness";

const FP = (c: string) => c.repeat(64);

describe.skipIf(!PG_URL)("tenant usage and write lock (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;
  const fields = new FieldCrypto(new InMemoryKeyStore());

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

  async function add(tenant: string, owner: string, fingerprint: string, size: number): Promise<void> {
    const id = randomUUID();
    const cipher = fields.forUser(owner);
    await withTenant(app, tenant, async (tx) =>
      insertDocument(tx, {
        id,
        tenantId: tenant,
        ownerId: owner,
        titleEnc: await cipher.seal(titleBind(id), "t"),
        filenameEnc: await cipher.seal(filenameBind(id), "f"),
        mime: "text/plain",
        sizeBytes: size,
        contentAddress: `hmac-sha256:${fingerprint}`,
        fingerprint,
      }),
    );
  }

  it("counts a tenant's documents and bytes across its users, and nothing of other tenants", async () => {
    await add(T1, U1, FP("1"), 1234);
    await add(T1, U1, FP("2"), 10);
    await add(T1, U1B, FP("3"), 100);
    await add(T2, U2, FP("4"), 7);
    expect(await withTenant(app, T1, (tx) => usageOfTenant(tx))).toEqual({ documents: 3, bytes: 1344 });
    expect(await withTenant(app, T2, (tx) => usageOfTenant(tx))).toEqual({ documents: 1, bytes: 7 });
  });

  it("serialises two writers of one tenant on the advisory lock", async () => {
    const order: string[] = [];
    const first = withTenant(app, T1, async (tx) => {
      await lockTenantForWrite(tx, T1);
      order.push("first-has-lock");
      await new Promise((r) => setImmediate(r));
      order.push("first-done");
    });
    const second = withTenant(app, T1, async (tx) => {
      await lockTenantForWrite(tx, T1);
      order.push("second-has-lock");
    });
    await Promise.all([first, second]);
    expect(order.indexOf("first-done")).toBeLessThan(order.indexOf("second-has-lock"));
  });
});
```

(The last test's `order` assertion holds only if `first` takes the lock first; if the scheduler starts `second` first, swap the labels — assert that **whichever acquired first finished before the other acquired**: record `[who-has-lock, who-done]` pairs and check no interleaving. The executor makes this symmetric when the first run shows which way it goes.)

- [ ] **Step 2: Run to verify it fails**

Run: `export DOCMIND_TEST_PG_URL=<superuser url> && pnpm --filter @docmind/server exec vitest run app/documents/repoTenant.pg.test.ts`
Expected: FAIL (`lockTenantForWrite` and `usageOfTenant` are not exported).

- [ ] **Step 3: Implement**

Add to `apps/server/app/documents/repo.ts`:

```ts
/**
 * Serialises writers of one tenant until the transaction ends: quota checks, the duplicate check
 * and the delete's blob removal all run under it, so they cannot interleave. Held for the length
 * of a transaction only (the file itself is staged before it is taken).
 */
export async function lockTenantForWrite(tx: PoolClient, tenantId: string): Promise<void> {
  await tx.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))", [
    `docmind:documents:${tenantId}`,
  ]);
}

/** Documents and bytes held by the transaction's tenant (row-level security does the scoping). */
export async function usageOfTenant(tx: PoolClient): Promise<{ documents: number; bytes: number }> {
  const { rows } = await tx.query<{ documents: number; bytes: string }>(
    "SELECT count(*)::int AS documents, coalesce(sum(size_bytes), 0)::text AS bytes FROM documents",
  );
  const row = rows[0] as { documents: number; bytes: string };
  return { documents: row.documents, bytes: Number(row.bytes) };
}
```

- [ ] **Step 4: Run to verify it passes, gate, commit**

Run: `export DOCMIND_TEST_PG_URL=<superuser url> && pnpm --filter @docmind/server exec vitest run app/documents`
Expected: PASS.

```bash
export DOCMIND_TEST_PG_URL=<superuser url> && pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
git switch -c feat/server-documents-tenant-usage
git add apps/server/app/documents
git commit -m "feat(server): per-tenant write lock and usage counts for documents

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
gh pr create --draft --title "feat(server): per-tenant write lock and usage counts for documents" --body "🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Expected: gate green; about 110 changed lines, 2 files.

---

### Task 53: the `ingest-document` stub flow, its grants, and the "ids only" proofs

Owner decision 1: M2 starts the flow on upload. This task adds the flow itself; Task 54 adds the port that starts and cancels it, Task 56 calls it from the upload route.

**Files:**
- Create: `apps/server/app/flows/ingest-document/deps.ts`
- Create: `apps/server/app/flows/ingest-document/flow.ts`
- Create: `apps/server/app/flows/ingest-document/flow.test.ts`
- Modify: `apps/server/app/security.ts` (one grant)
- Modify: `apps/server/app/loom.gen.ts` (generated by `pnpm --filter @docmind/server gen`; not counted)
- Modify: `apps/server/package.json` (add `"@loom/core": "*"` to `dependencies`) and root `package.json` (one `pnpm.overrides` line), `pnpm-lock.yaml` (not counted)

**Interfaces:**
- Consumes: M0/M1 `buildApp`, `executionIdFor`, `createDurableStorage`.
- Produces (from `app/flows/ingest-document/`):
  - `IngestStartInput` (zod, **strict**) `= { tenantId: uuid, userId: uuid, documentId: uuid }` and its type; `IngestOutput = { outcome: "accepted" | "document_gone" }`.
  - `interface IngestDeps { documentExists(ref: IngestStartInput): Promise<boolean> }`, `setIngestDeps(deps: IngestDeps): void`, `resetIngestDeps(): void`, `ingestDeps(): IngestDeps` (throws `ingest dependencies are not configured` if unset). The holder is process-global because flows are static modules (Uncertain #6).
  - `ingestBeginStep` (id `ingest-begin`) and `ingestDocumentFlow: RegisteredFlow` (id `ingest-document`, version `1.0.0`, one step). The step only asks `documentExists`; it **writes nothing**, so `documents.status` stays `uploaded`. A document that is gone ends the execution `completed` with `{ outcome: "document_gone" }` (a clean stop, not an error and not a retry).
  - What M3 replaces: the `ingest-begin` step (see Deviation 7). The input schema, the execution-id convention, the grant mechanism and the guard stay.

- [ ] **Step 1: Link `@loom/core`**

Add `"@loom/core": "*"` to `dependencies` in `apps/server/package.json`, and this line to the root `package.json` `pnpm.overrides`, keeping the keys sorted:

```json
      "@loom/core": "link:../loom/packages/core",
```

Run: `pnpm install`
Expected: success.

- [ ] **Step 2: Write the failing tests**

`apps/server/app/flows/ingest-document/flow.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { sensitivePathsFromSteps } from "@loom/plugin-crypto";
import { ExecutionAlreadyExistsError } from "@loom/workflow-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../config";
import { SENSITIVE_EVENT_PATHS } from "../../sensitive";
import { executionIdFor } from "../../subject";
import { resetIngestDeps, setIngestDeps } from "./deps";
import { IngestOutput, IngestStartInput, ingestBeginStep, ingestDocumentFlow } from "./flow";

const ids = () => ({ tenantId: randomUUID(), userId: randomUUID(), documentId: randomUUID() });
const run = (input: IngestStartInput, app = buildApp({ kind: "memory" })) =>
  app.runtime.start(ingestDocumentFlow, input, {
    executionId: executionIdFor(input.userId, `ingest-${input.documentId}`),
    principal: { tenant: input.tenantId, actor: input.userId },
  });

afterEach(() => resetIngestDeps());

describe("ingest-document stub flow", () => {
  it("completes with 'accepted' while the document exists, and writes nothing else", async () => {
    setIngestDeps({ documentExists: async () => true });
    const app = buildApp({ kind: "memory" });
    const state = await (await run(ids(), app)).waitForCompletion();
    expect(state.status).toBe("completed");
    expect(state.variables._output).toEqual({ outcome: "accepted" });
    await app.close();
  });

  it("stops cleanly, not as a failure, when the document is gone", async () => {
    setIngestDeps({ documentExists: async () => false });
    const app = buildApp({ kind: "memory" });
    const state = await (await run(ids(), app)).waitForCompletion();
    expect(state.status).toBe("completed");
    expect(state.variables._output).toEqual({ outcome: "document_gone" });
    await app.close();
  });

  it("is start-once per document: the execution id is the idempotency key", async () => {
    setIngestDeps({ documentExists: async () => true });
    const app = buildApp({ kind: "memory" });
    const input = ids();
    await (await run(input, app)).waitForCompletion();
    await expect(run(input, app)).rejects.toBeInstanceOf(ExecutionAlreadyExistsError);
    await app.close();
  });

  it("is refused for a caller with no principal (the grants and owner policy are live)", async () => {
    setIngestDeps({ documentExists: async () => true });
    const app = buildApp({ kind: "memory" });
    const input = ids();
    await expect(
      app.runtime.start(ingestDocumentFlow, input, { executionId: executionIdFor(input.userId, "ingest-x") }),
    ).rejects.toThrow();
    await app.close();
  });
});

describe("what the flow may carry (owner decision 1: ids only)", () => {
  it("accepts exactly three UUIDs as start input and refuses any other field", () => {
    const input = ids();
    expect(Object.keys(IngestStartInput.shape).sort()).toEqual(["documentId", "tenantId", "userId"]);
    expect(IngestStartInput.safeParse(input).success).toBe(true);
    for (const extra of ["filename", "title", "content", "text", "summary", "mime"]) {
      expect(IngestStartInput.safeParse({ ...input, [extra]: "tax-return.pdf" }).success, extra).toBe(false);
    }
    expect(IngestStartInput.safeParse({ ...input, documentId: "tax-return.pdf" }).success).toBe(false);
  });

  it("produces only a two-value enum, which cannot hold content", () => {
    expect(Object.keys(IngestOutput.shape)).toEqual(["outcome"]);
    expect(IngestOutput.shape.outcome.options).toEqual(["accepted", "document_gone"]);
  });

  it("marks nothing sensitive, and so registers no event paths", () => {
    expect(sensitivePathsFromSteps([ingestBeginStep])).toEqual({});
    // If a content-bearing field is ever added to this flow, register it in the same PR and update
    // this expectation: an event written before its path is registered stays readable forever.
    expect(SENSITIVE_EVENT_PATHS).toEqual({});
  });

  it("keeps the execution id free of content: u_<user>:ingest-<document uuid> only", () => {
    const input = ids();
    expect(executionIdFor(input.userId, `ingest-${input.documentId}`)).toMatch(
      /^u_[0-9a-f-]{36}:ingest-[0-9a-f-]{36}$/,
    );
  });
});
```

(An optional extra, if the executor wants it: a variant on `createDurableStorage` exactly as `storage.test.ts` does it, asserting that the raw log of the execution holds no free-text string, only UUIDs, the execution id and Loom's own structural fields.)

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm --filter @docmind/server exec vitest run app/flows`
Expected: FAIL (modules not found).

- [ ] **Step 4: Implement**

`apps/server/app/flows/ingest-document/deps.ts`:

```ts
import type { IngestStartInput } from "./flow";

/**
 * What the flow's steps need from the outside world. Flows are static modules (`loom gen`), so the
 * server composition root (`main.ts`, or a test harness) sets this once before the first start.
 */
export interface IngestDeps {
  /** Is the document still there for its owner? Ids only: no filename, title or content. */
  documentExists(ref: IngestStartInput): Promise<boolean>;
}

let current: IngestDeps | undefined;

export function setIngestDeps(deps: IngestDeps): void {
  current = deps;
}

export function resetIngestDeps(): void {
  current = undefined;
}

export function ingestDeps(): IngestDeps {
  if (!current) throw new Error("ingest dependencies are not configured");
  return current;
}
```

`apps/server/app/flows/ingest-document/flow.ts`:

```ts
import { flow$, handler$, step$ } from "@loom/core";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";
import { ingestDeps } from "./deps";

/**
 * Start input: ids only (never a filename, title or text), and strict so a field added later fails
 * loudly. The execution id is `executionIdFor(userId, "ingest-" + documentId)`, which is also the
 * idempotency key: Loom starts a caller-chosen id once.
 */
export const IngestStartInput = z
  .object({ tenantId: z.string().uuid(), userId: z.string().uuid(), documentId: z.string().uuid() })
  .strict();
export type IngestStartInput = z.infer<typeof IngestStartInput>;

/** A two-value enum on purpose: it cannot carry user content. */
export const IngestOutput = z.object({ outcome: z.enum(["accepted", "document_gone"]) });
export type IngestOutput = z.infer<typeof IngestOutput>;

/**
 * The M2 skeleton of spec §5.2: confirm the document is still there and stop. It writes nothing,
 * so the document stays `uploaded`. M3 item 14 replaces it with the parse/chunk/embed/analyze/
 * summarize/finalize steps and reuses the same existence guard at the top of each.
 */
export const ingestBeginStep = step$({
  id: "ingest-begin",
  name: "IngestBegin",
  inputSchema: IngestStartInput,
  outputSchema: IngestOutput,
  handler: handler$(
    async (input: IngestStartInput): Promise<IngestOutput> => ({
      outcome: (await ingestDeps().documentExists(input)) ? "accepted" : "document_gone",
    }),
  ),
});

const runner: FlowRunner<IngestStartInput, IngestOutput> = (ctx, input) =>
  ctx.run(ingestBeginStep, input) as Promise<IngestOutput>;

export const ingestDocumentFlow: RegisteredFlow = {
  definition: flow$({
    id: "ingest-document",
    name: "IngestDocument",
    version: "1.0.0",
    inputSchema: IngestStartInput,
    outputSchema: IngestOutput,
    steps: [ingestBeginStep],
  }),
  runner: runner as FlowRunner<unknown, unknown>,
};
```

In `apps/server/app/security.ts`, replace the empty grant table (a step id doubles as its tool id; the table is keyed by workflow id):

```ts
export const authorizer = new GrantTable({
  "ingest-document": ["ingest-begin"],
});
```

and update the comment above it to say that every flow added later lists its step ids here.

Run `pnpm --filter @docmind/server gen` and commit the regenerated `apps/server/app/loom.gen.ts` (its `flowModules` now imports `./flows/ingest-document/flow`).

- [ ] **Step 5: Run to verify they pass, gate, commit**

Run: `pnpm --filter @docmind/server exec vitest run app/flows app/config.test.ts`
Expected: PASS. If the "refused for a caller with no principal" test passes for the wrong reason (for instance an input error), assert the specific Loom error it throws and keep the test.

```bash
export DOCMIND_TEST_PG_URL=<superuser url> && pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
git switch -c feat/flow-ingest-document-stub
git add apps/server package.json pnpm-lock.yaml
git commit -m "feat(flow): ingest-document stub flow with ids-only input

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
gh pr create --draft --title "feat(flow): ingest-document stub flow with ids-only input" --body "One step that checks the document still exists and writes nothing. Start input is three UUIDs, output a two-value enum; tests fail if a content-bearing field is added without registering its event path. Generated loom.gen.ts and the lockfile are not counted.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Expected: gate green; about 170 changed lines (generated file and lockfile excluded), 7 files.

---

### Task 54: `IngestPort` (start-once, cancel-by-id) and the Postgres deps for the stub step

**Files:**
- Create: `apps/server/app/documents/ingest.ts`
- Create: `apps/server/app/documents/ingest.test.ts`
- Create: `apps/server/app/flows/ingest-document/pgDeps.ts`
- Create: `apps/server/app/flows/ingest-document/pgDeps.pg.test.ts`

**Interfaces:**
- Consumes: Task 53 (`ingestDocumentFlow`, `IngestStartInput`, `setIngestDeps`), M1 `executionIdFor`, `Identity` from `@docmind/auth`, Task 47 (table; the pg test), Task 52a (`insertDocument`, `seedUsers`).
- Produces:
  - `ingestExecutionId(userId: string, documentId: string): string` = `executionIdFor(userId, "ingest-" + documentId)`.
  - `ingestStartInput(identity: Identity, documentId: string): IngestStartInput` (the only place the start input is built).
  - `interface IngestPort { start(identity: Identity, documentId: string): Promise<ExecutionHandle | null>; cancel(identity: Identity, documentId: string): Promise<void> }`. `start` returns `null` when the execution already exists (start-once); `cancel` is idempotent and treats an unknown or already finished execution as success.
  - `loomIngest(runtime: Pick<WorkflowRuntime, "start" | "cancel">): IngestPort`.
  - `pgIngestDeps(pool: Pool): IngestDeps` (in `flows/ingest-document/pgDeps.ts`): `documentExists` runs `SELECT 1 FROM documents WHERE id = $1 AND owner_id = $2` inside `withTenant(pool, tenantId, ...)`.

- [ ] **Step 1: Write the failing tests**

`apps/server/app/documents/ingest.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../config";
import { resetIngestDeps, setIngestDeps } from "../flows/ingest-document/deps";
import { IngestStartInput } from "../flows/ingest-document/flow";
import { ingestExecutionId, ingestStartInput, loomIngest } from "./ingest";

const identity = () => ({ tenantId: randomUUID(), userId: randomUUID() });
afterEach(() => resetIngestDeps());

describe("ingest start input", () => {
  it("is exactly the three ids, validated, and names the execution without content", () => {
    const who = identity();
    const documentId = randomUUID();
    const input = ingestStartInput(who, documentId);
    expect(input).toEqual({ tenantId: who.tenantId, userId: who.userId, documentId });
    expect(IngestStartInput.safeParse(input).success).toBe(true);
    expect(ingestExecutionId(who.userId, documentId)).toBe(`u_${who.userId}:ingest-${documentId}`);
  });
});

describe("loomIngest", () => {
  it("starts an execution once per document and reports the second start as already started", async () => {
    setIngestDeps({ documentExists: async () => true });
    const app = buildApp({ kind: "memory" });
    const port = loomIngest(app.runtime);
    const who = identity();
    const documentId = randomUUID();
    const handle = await port.start(who, documentId);
    expect(handle?.executionId).toBe(ingestExecutionId(who.userId, documentId));
    expect((await handle?.waitForCompletion())?.status).toBe("completed");
    expect(await port.start(who, documentId)).toBeNull();
    await app.close();
  });

  it("cancels a flow that is still running; the step that was in flight then finds nothing to do", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setIngestDeps({
      documentExists: async () => {
        await gate;
        return false; // the document was deleted meanwhile
      },
    });
    const app = buildApp({ kind: "memory" });
    const port = loomIngest(app.runtime);
    const who = identity();
    const documentId = randomUUID();
    const handle = await port.start(who, documentId);
    await port.cancel(who, documentId);
    release();
    await expect(handle?.waitForCompletion()).rejects.toThrow();
    expect(handle?.getState().status).toBe("cancelled");
    await app.close();
  });

  it("treats cancel as idempotent: unknown execution, finished execution and repeated cancel all succeed", async () => {
    setIngestDeps({ documentExists: async () => true });
    const app = buildApp({ kind: "memory" });
    const port = loomIngest(app.runtime);
    const who = identity();
    await expect(port.cancel(who, randomUUID())).resolves.toBeUndefined(); // never started
    const documentId = randomUUID();
    await (await port.start(who, documentId))?.waitForCompletion();
    await expect(port.cancel(who, documentId)).resolves.toBeUndefined(); // already completed
    await expect(port.cancel(who, documentId)).resolves.toBeUndefined(); // and again
    await app.close();
  });

  it("does not let another user cancel the execution", async () => {
    let release: () => void = () => {};
    setIngestDeps({
      documentExists: () =>
        new Promise<boolean>((resolve) => {
          release = () => resolve(true);
        }),
    });
    const app = buildApp({ kind: "memory" });
    const port = loomIngest(app.runtime);
    const owner = identity();
    const documentId = randomUUID();
    const handle = await port.start(owner, documentId);
    // The execution id embeds the owner's id, so a different user addresses a different (unknown) one;
    // the owner policy covers the same-id case: a different actor cancelling the same id is refused.
    await expect(
      app.runtime.cancel(ingestExecutionId(owner.userId, documentId), "x", {
        principal: { tenant: owner.tenantId, actor: randomUUID() },
      }),
    ).rejects.toThrow();
    release();
    expect((await handle?.waitForCompletion())?.status).toBe("completed");
    await app.close();
  });
});
```

`apps/server/app/flows/ingest-document/pgDeps.pg.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FieldCrypto } from "../../crypto/fields";
import { migrate, setAppRolePassword } from "../../db/migrate";
import { withTenant } from "../../db/tenant";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../../db/testSupport";
import { filenameBind, insertDocument, titleBind } from "../../documents/repo";
import { T1, T2, U1, U1B, seedUsers } from "../../documents/testHarness";
import { pgIngestDeps } from "./pgDeps";

describe.skipIf(!PG_URL)("pgIngestDeps (needs DOCMIND_TEST_PG_URL)", () => {
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

  it("sees a document for its owner only, in its own tenant only", async () => {
    const id = randomUUID();
    const cipher = new FieldCrypto(new InMemoryKeyStore()).forUser(U1);
    const fingerprint = "e".repeat(64);
    await withTenant(app, T1, async (tx) =>
      insertDocument(tx, {
        id,
        tenantId: T1,
        ownerId: U1,
        titleEnc: await cipher.seal(titleBind(id), "t"),
        filenameEnc: await cipher.seal(filenameBind(id), "f"),
        mime: "text/plain",
        sizeBytes: 1,
        contentAddress: `hmac-sha256:${fingerprint}`,
        fingerprint,
      }),
    );
    const deps = pgIngestDeps(app);
    expect(await deps.documentExists({ tenantId: T1, userId: U1, documentId: id })).toBe(true);
    expect(await deps.documentExists({ tenantId: T1, userId: U1B, documentId: id })).toBe(false); // colleague
    expect(await deps.documentExists({ tenantId: T2, userId: U1, documentId: id })).toBe(false); // other tenant
    expect(await deps.documentExists({ tenantId: T1, userId: U1, documentId: randomUUID() })).toBe(false);
    await db.owner.query("DELETE FROM documents WHERE id = $1", [id]);
    expect(await deps.documentExists({ tenantId: T1, userId: U1, documentId: id })).toBe(false); // gone
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `export DOCMIND_TEST_PG_URL=<superuser url> && pnpm --filter @docmind/server exec vitest run app/documents/ingest.test.ts app/flows/ingest-document/pgDeps.pg.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement**

`apps/server/app/documents/ingest.ts`:

```ts
import type { Identity } from "@docmind/auth";
import {
  type ExecutionHandle,
  ExecutionAlreadyExistsError,
  type WorkflowRuntime,
} from "@loom/workflow-runtime";
import { type IngestStartInput, ingestDocumentFlow } from "../flows/ingest-document/flow";
import { executionIdFor } from "../subject";

/** The execution that ingests one document. `name` is a fixed prefix plus a UUID: no content. */
export const ingestExecutionId = (userId: string, documentId: string): string =>
  executionIdFor(userId, `ingest-${documentId}`);

/** The only place the flow's start input is built: ids, nothing else. */
export const ingestStartInput = (identity: Identity, documentId: string): IngestStartInput => ({
  tenantId: identity.tenantId,
  userId: identity.userId,
  documentId,
});

/** What the document routes need from the flow engine. */
export interface IngestPort {
  /** Starts the document's ingest execution. `null`: it already exists (start-once). */
  start(identity: Identity, documentId: string): Promise<ExecutionHandle | null>;
  /** Cancels it. An unknown or already finished execution is not an error; safe to repeat. */
  cancel(identity: Identity, documentId: string): Promise<void>;
}

const principalOf = (identity: Identity) => ({ tenant: identity.tenantId, actor: identity.userId });
// A fixed reason: the cancel reason is recorded in the log, so it never names the document.
const CANCEL_REASON = "document-deleted";

export function loomIngest(runtime: Pick<WorkflowRuntime, "start" | "cancel">): IngestPort {
  return {
    async start(identity, documentId) {
      try {
        return await runtime.start(ingestDocumentFlow, ingestStartInput(identity, documentId), {
          executionId: ingestExecutionId(identity.userId, documentId),
          principal: principalOf(identity),
        });
      } catch (err) {
        if (err instanceof ExecutionAlreadyExistsError) return null;
        throw err;
      }
    },
    async cancel(identity, documentId) {
      try {
        await runtime.cancel(ingestExecutionId(identity.userId, documentId), CANCEL_REASON, {
          principal: principalOf(identity),
        });
      } catch (err) {
        // Never started (the start failed after the upload committed) or already gone: nothing to cancel.
        if (err instanceof Error && err.message.startsWith("No execution found for id")) return;
        throw err;
      }
    },
  };
}
```

`apps/server/app/flows/ingest-document/pgDeps.ts`:

```ts
import type { Pool } from "pg";
import { withTenant } from "../../db/tenant";
import type { IngestDeps } from "./deps";

/** The stub step's database access: a tenant-scoped existence check, ids in, boolean out. */
export function pgIngestDeps(pool: Pool): IngestDeps {
  return {
    documentExists: ({ tenantId, userId, documentId }) =>
      withTenant(pool, tenantId, async (tx) => {
        const { rowCount } = await tx.query("SELECT 1 FROM documents WHERE id = $1 AND owner_id = $2", [
          documentId,
          userId,
        ]);
        return (rowCount ?? 0) > 0;
      }),
  };
}
```

- [ ] **Step 4: Run to verify they pass, gate, commit**

Run: `export DOCMIND_TEST_PG_URL=<superuser url> && pnpm --filter @docmind/server exec vitest run app/documents/ingest.test.ts app/flows`
Expected: PASS. If the "another actor" test does not throw (the owner policy keys on something other than `actor`), assert the refusal Loom actually gives and keep the test; this is Uncertain #5.

```bash
export DOCMIND_TEST_PG_URL=<superuser url> && pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
git switch -c feat/server-ingest-port
git add apps/server/app
git commit -m "feat(server): IngestPort for starting and cancelling document ingestion

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
gh pr create --draft --title "feat(server): IngestPort for starting and cancelling document ingestion" --body "Start-once by execution id, cancel by id (idempotent, tolerant of unknown executions), ids-only start input, and the Postgres existence check the stub step uses. Not wired into routes yet.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Expected: gate green; about 175 changed lines, 4 files.

---

### Task 55a: `POST /api/documents` (upload with keyed dedup)

Starting the ingest flow is Task 56; this task stores the document and is reachable only from tests until Task 56 wires it into `main.ts` (state that in the PR description). The dedup, cross-user and keyed-name tests are Task 55b.

**Files:**
- Create: `apps/server/app/documents/routes.ts`
- Create: `apps/server/app/documents/upload.pg.test.ts`
- Modify: `apps/server/app/documents/testHarness.ts` (add `startDocumentServer`)
- Modify: `apps/server/package.json` (add `"@docmind/blob-store": "workspace:*"`) and `pnpm-lock.yaml`

**Interfaces:**
- Consumes: Task 45a (`EncryptedFsContentStore`, `BlobTooLargeError`), 48 (`FieldCrypto`), 49 (`sniff`, `sanitizeFilename`, `titleFromFilename`, `SNIFF_BYTES`), 50 (`DocumentLimits`, `peek`), 51 (`receiveFile`, `UploadTooLargeError`), 52 (repo functions), M1 `requireAuth`, `withTenant`.
- Produces:
  - `interface DocumentRoutesDeps { pool: Pool; authenticator: Authenticator; fields: FieldCrypto; blobs: (identity: Identity) => EncryptedFsContentStore; limits: DocumentLimits }` (Task 56 adds `ingest`)
  - `documentRoutes(deps: DocumentRoutesDeps): Record<string, Handler>` with `"POST /api/documents"` (Tasks 59 and 60 add the other routes to this same function).
  - `startDocumentServer(overrides?: { limits?: Partial<DocumentLimits> }): Promise<DocumentHarness>` in the harness, where `DocumentHarness = { base: string; owner: Pool; app: Pool; root: string; keys: InMemoryKeyStore; upload(user: string, name: string, data: Uint8Array | string): Promise<Response>; fingerprint(user: string, data: Uint8Array | string): Promise<string>; close(): Promise<void> }`. `fingerprint` is what the server stores for those bytes for that harness user (it derives the user's keyed fingerprint from `keys`), so tests never hash with plain sha256.

- [ ] **Step 1: Extend the harness and write the failing test**

Append to `apps/server/app/documents/testHarness.ts` (add the imports at the top of the file):

```ts
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EncryptedFsContentStore, deriveFingerprintKey, fingerprintOf } from "@docmind/blob-store";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { Pool as PgPool } from "pg";
import { FieldCrypto } from "../crypto/fields";
import { migrate, setAppRolePassword } from "../db/migrate";
import { APP_PASSWORD, createTestDb } from "../db/testSupport";
import { createHttpServer } from "../server";
import { DEFAULT_LIMITS, type DocumentLimits } from "./limits";
import { documentRoutes } from "./routes";

export interface DocumentHarness {
  base: string;
  owner: PgPool;
  app: PgPool;
  root: string;
  keys: InMemoryKeyStore;
  upload(user: string, name: string, data: Uint8Array | string): Promise<Response>;
  /** The keyed fingerprint the server stores for these bytes, for this harness user (alice, alice2, bob). */
  fingerprint(user: string, data: Uint8Array | string): Promise<string>;
  close(): Promise<void>;
}

/** A migrated database with two tenants, a blob directory and the document routes on 127.0.0.1. */
export async function startDocumentServer(
  overrides: { limits?: Partial<DocumentLimits> } = {},
): Promise<DocumentHarness> {
  const db = await createTestDb();
  await migrate(db.owner);
  await setAppRolePassword(db.owner, APP_PASSWORD);
  await seedUsers(db.owner);
  const app = new PgPool({ connectionString: db.appUrl });
  const root = mkdtempSync(join(tmpdir(), "dm-docs-"));
  const keys = new InMemoryKeyStore();
  const limits = { ...DEFAULT_LIMITS, ...overrides.limits };
  const server = createHttpServer(
    documentRoutes({
      pool: app,
      authenticator: testAuthenticator,
      fields: new FieldCrypto(keys),
      blobs: (id) =>
        new EncryptedFsContentStore({ root, tenantId: id.tenantId, userId: id.userId, keys, maxBytes: limits.maxFileBytes }),
      limits,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    owner: db.owner,
    app,
    root,
    keys,
    upload(user, name, data) {
      const form = new FormData();
      form.append("file", new Blob([data]), name);
      return fetch(`${base}/api/documents`, { method: "POST", headers: { "x-test-user": user }, body: form });
    },
    async fingerprint(user, data) {
      const identity = BY_HEADER[user];
      if (!identity) throw new Error("unknown harness user");
      const dek = await keys.getOrCreate(identity.userId);
      return fingerprintOf(deriveFingerprintKey(dek), typeof data === "string" ? Buffer.from(data) : data);
    },
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await app.end();
      await db.drop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
```

`apps/server/app/documents/upload.pg.test.ts`:

```ts
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { UploadDocumentResponse } from "@docmind/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_URL } from "../db/testSupport";
import { type DocumentHarness, T1, TEXT, U1, startDocumentServer } from "./testHarness";

describe.skipIf(!PG_URL)("POST /api/documents (needs DOCMIND_TEST_PG_URL)", () => {
  let h: DocumentHarness;
  beforeAll(async () => {
    h = await startDocumentServer();
  });
  afterAll(async () => {
    await h?.close();
  });

  it("stores a document: 201, a decrypted DTO, an encrypted row and an encrypted blob", async () => {
    const bytes = TEXT("first");
    const res = await h.upload("alice", "Meeting notes.txt", bytes);
    expect(res.status).toBe(201);
    const body = (await res.json()) as UploadDocumentResponse;
    expect(body.duplicate).toBe(false);
    expect(body.document).toMatchObject({
      title: "Meeting notes",
      filename: "Meeting notes.txt",
      mime: "text/plain",
      sizeBytes: bytes.length,
      status: "uploaded",
      summary: null,
      stats: null,
    });

    const fp = await h.fingerprint("alice", bytes);
    const row = await h.owner.query(
      "SELECT title_enc::text AS t, filename_enc::text AS f, fingerprint, content_address, stats_enc FROM documents WHERE id = $1",
      [body.document.id],
    );
    expect(row.rows[0].t + row.rows[0].f).not.toContain("Meeting");
    expect(row.rows[0].fingerprint).toBe(fp);
    expect(row.rows[0].content_address).toBe(`hmac-sha256:${fp}`);
    expect(row.rows[0].stats_enc).toBeNull();

    const file = join(h.root, T1, U1, fp);
    expect(readFileSync(file).includes("plain text")).toBe(false);
    expect(readdirSync(join(h.root, T1, U1))).toEqual([fp]); // no temp file left
  });

  it("answers 401 without a session and stores nothing", async () => {
    const form = new FormData();
    form.append("file", new Blob([TEXT("anon")]), "a.txt");
    const res = await fetch(`${h.base}/api/documents`, { method: "POST", body: form });
    expect(res.status).toBe(401);
    const rows = await h.owner.query("SELECT count(*)::int AS n FROM documents WHERE size_bytes = $1", [TEXT("anon").length]);
    expect(rows.rows[0].n).toBe(0);
  });
});
```

(`BY_HEADER` is exported by Task 52a's `testHarness.ts`.)

- [ ] **Step 2: Run to verify it fails**

Run: `export DOCMIND_TEST_PG_URL=<superuser url> && pnpm --filter @docmind/server exec vitest run app/documents/upload.pg.test.ts`
Expected: FAIL (module `./routes` not found).

- [ ] **Step 3: Implement the route**

Add `"@docmind/blob-store": "workspace:*"` to `apps/server/package.json` `dependencies`; run `pnpm install`.

`apps/server/app/documents/routes.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Authenticator, Identity } from "@docmind/auth";
import { BlobTooLargeError, type EncryptedFsContentStore, type StagedBlob } from "@docmind/blob-store";
import type { UploadDocumentResponse } from "@docmind/contracts";
import type { Pool } from "pg";
import type { FieldCrypto } from "../crypto/fields";
import { withTenant } from "../db/tenant";
import { UploadTooLargeError, receiveFile } from "../http/multipart";
import { peek } from "../http/peek";
import { requireAuth } from "../http/requireAuth";
import { type Handler, json, sendError } from "../http/respond";
import type { DocumentLimits } from "./limits";
import {
  filenameBind,
  findByFingerprint,
  insertDocument,
  lockTenantForWrite,
  titleBind,
  toDto,
} from "./repo";
import { SNIFF_BYTES, type Sniffed, sanitizeFilename, sniff, titleFromFilename } from "./sniff";

export interface DocumentRoutesDeps {
  pool: Pool;
  authenticator: Authenticator;
  fields: FieldCrypto;
  /** A blob store for this user. Cheap to build: no I/O happens until it is used. */
  blobs: (identity: Identity) => EncryptedFsContentStore;
  limits: DocumentLimits;
}

/** An error answer on the upload route. The body of the request may be unread, so the connection closes. */
function uploadError(req: IncomingMessage, res: ServerResponse, status: number, code: string, message: string): void {
  res.setHeader("connection", "close");
  sendError(res, status, code, message);
  res.once("finish", () => req.destroy());
}

type Registered = { document: UploadDocumentResponse["document"]; duplicate: boolean };

/** Inserts the row and commits the staged blob, or reports a duplicate. Runs inside one transaction. */
async function register(
  deps: DocumentRoutesDeps,
  identity: Identity,
  store: EncryptedFsContentStore,
  staged: StagedBlob,
  filename: string,
  sniffed: Sniffed,
): Promise<Registered> {
  const cipher = deps.fields.forUser(identity.userId);
  const id = randomUUID();
  // The keyed fingerprint (HMAC under a key derived from this user's data key), computed while streaming.
  const fingerprint = staged.fingerprint;
  const titleEnc = await cipher.seal(titleBind(id), titleFromFilename(filename));
  const filenameEnc = await cipher.seal(filenameBind(id), filename);
  let committed: { created: boolean } | undefined;
  try {
    return await withTenant(deps.pool, identity.tenantId, async (tx) => {
      await lockTenantForWrite(tx, identity.tenantId);
      const existing = await findByFingerprint(tx, identity.userId, fingerprint);
      if (existing) {
        await staged.discard();
        return { document: await toDto(existing, cipher), duplicate: true };
      }
      const row = await insertDocument(tx, {
        id,
        tenantId: identity.tenantId,
        ownerId: identity.userId,
        titleEnc,
        filenameEnc,
        mime: sniffed.mime,
        sizeBytes: staged.ref.size ?? 0,
        contentAddress: staged.ref.__loomContent,
        fingerprint,
      });
      committed = await staged.commit();
      return { document: await toDto(row, cipher), duplicate: false };
    });
  } catch (err) {
    // The transaction failed (possibly at COMMIT) after the blob was moved into place: take it out
    // again if this upload is what created it. Otherwise just drop the staged file.
    if (committed?.created) await store.delete(staged.ref);
    else await staged.discard();
    throw err;
  }
}

async function upload(
  deps: DocumentRoutesDeps,
  req: IncomingMessage,
  res: ServerResponse,
  identity: Identity,
): Promise<void> {
  const outcome = await receiveFile(req, { maxFileBytes: deps.limits.maxFileBytes }, async (file) => {
    const filename = sanitizeFilename(file.filename);
    const { head, rest } = await peek(file.body, SNIFF_BYTES);
    const sniffed = sniff(head, filename);
    if (!sniffed) return { rejected: true as const };
    const store = deps.blobs(identity);
    const staged = await store.stage(rest).catch((err: unknown) => {
      throw err instanceof BlobTooLargeError ? new UploadTooLargeError() : err;
    });
    try {
      return { rejected: false as const, result: await register(deps, identity, store, staged, filename, sniffed) };
    } catch (err) {
      await staged.discard();
      throw err;
    }
  });

  if (!outcome.ok) return uploadError(req, res, outcome.status, outcome.code, outcome.message);
  if (outcome.value.rejected) {
    return uploadError(req, res, 415, "unsupported_type", "this file type is not supported");
  }
  const { document, duplicate } = outcome.value.result;
  json(res, duplicate ? 200 : 201, { document, duplicate } satisfies UploadDocumentResponse);
}

/** The document API. Every route takes the tenant and user from the session, never from the request. */
export function documentRoutes(deps: DocumentRoutesDeps): Record<string, Handler> {
  return {
    "POST /api/documents": requireAuth(deps.authenticator, (req, res, identity) =>
      upload(deps, req, res, identity),
    ),
  };
}
```

- [ ] **Step 4: Run to verify it passes, gate, commit**

Run: `export DOCMIND_TEST_PG_URL=<superuser url> && pnpm --filter @docmind/server exec vitest run app/documents`
Expected: PASS.

```bash
export DOCMIND_TEST_PG_URL=<superuser url> && pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
git switch -c feat/api-document-upload
git add apps/server pnpm-lock.yaml
git commit -m "feat(api): POST /api/documents with magic-byte sniffing, encryption and keyed dedup

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
gh pr create --draft --title "feat(api): POST /api/documents with magic-byte sniffing, encryption and keyed dedup" --body "The route is reachable only from tests until the next PR wires it into main.ts and starts the ingest flow. Quotas follow after that. Lockfile not counted.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Expected: gate green; about 185 changed lines, 3 files (plus the lockfile).

---

### Task 55b: upload dedup, cross-user and keyed-name tests

Test-only PR for Task 55a's behaviour: identical bytes from one user are stored once, two users never share a document or a fingerprint, the type comes from the bytes, and nothing is named by a plain sha256.

**Files:**
- Create: `apps/server/app/documents/upload.dedup.pg.test.ts`

**Interfaces:**
- Consumes: Task 55a (`startDocumentServer`, the route, `DocumentHarness.fingerprint`).
- Produces: nothing (tests only).

- [ ] **Step 1: Write the tests**

`apps/server/app/documents/upload.dedup.pg.test.ts`:

```ts
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { UploadDocumentResponse } from "@docmind/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_URL } from "../db/testSupport";
import { type DocumentHarness, PNG, T1, T2, TEXT, U1, U2, startDocumentServer } from "./testHarness";

describe.skipIf(!PG_URL)("upload dedup and keyed names (needs DOCMIND_TEST_PG_URL)", () => {
  let h: DocumentHarness;
  beforeAll(async () => {
    h = await startDocumentServer();
  });
  afterAll(async () => {
    await h?.close();
  });

  it("never stores or names anything by the plain sha256 of the bytes", async () => {
    const bytes = TEXT("keyed not plain");
    await h.upload("alice", "k.txt", bytes);
    const plain = createHash("sha256").update(bytes).digest("hex");
    expect(existsSync(join(h.root, T1, U1, plain))).toBe(false);
    const rows = await h.owner.query("SELECT count(*)::int AS n FROM documents WHERE fingerprint = $1 OR content_address LIKE $2", [
      plain,
      `%${plain}`,
    ]);
    expect(rows.rows[0].n).toBe(0);
  });

  it("decides the type from the bytes, not the extension", async () => {
    const res = await h.upload("alice", "photo.txt", PNG("a"));
    expect(res.status).toBe(201);
    expect(((await res.json()) as UploadDocumentResponse).document.mime).toBe("image/png");
  });

  it("returns the existing document for identical bytes: 200, duplicate, one row, one file", async () => {
    const bytes = TEXT("dup");
    const first = (await (await h.upload("alice", "a.txt", bytes)).json()) as UploadDocumentResponse;
    const again = await h.upload("alice", "renamed.txt", bytes);
    expect(again.status).toBe(200);
    const body = (await again.json()) as UploadDocumentResponse;
    expect(body.duplicate).toBe(true);
    expect(body.document.id).toBe(first.document.id);
    expect(body.document.filename).toBe("a.txt"); // the first upload's name is kept
    const fp = await h.fingerprint("alice", bytes);
    const rows = await h.owner.query("SELECT count(*)::int AS n FROM documents WHERE fingerprint = $1", [fp]);
    expect(rows.rows[0].n).toBe(1);
    expect(readdirSync(join(h.root, T1, U1)).filter((f) => f === fp)).toHaveLength(1);
  });

  it("does not deduplicate across users: each keeps their own document, fingerprint and blob", async () => {
    const bytes = TEXT("shared bytes");
    const a = (await (await h.upload("alice", "x.txt", bytes)).json()) as UploadDocumentResponse;
    const b = await h.upload("bob", "x.txt", bytes);
    expect(b.status).toBe(201);
    const bodyB = (await b.json()) as UploadDocumentResponse;
    expect(bodyB.duplicate).toBe(false);
    expect(bodyB.document.id).not.toBe(a.document.id);
    const fpAlice = await h.fingerprint("alice", bytes);
    const fpBob = await h.fingerprint("bob", bytes);
    expect(fpAlice).not.toBe(fpBob); // the same file looks different under each user's key
    expect(existsSync(join(h.root, T1, U1, fpAlice))).toBe(true);
    expect(existsSync(join(h.root, T2, U2, fpBob))).toBe(true);
  });
});
```

- [ ] **Step 2: Run, gate, commit**

Run: `export DOCMIND_TEST_PG_URL=<superuser url> && pnpm --filter @docmind/server exec vitest run app/documents/upload.dedup.pg.test.ts`
Expected: PASS (no failing-first step: a failure is a Task 55a bug, fixed there).

```bash
export DOCMIND_TEST_PG_URL=<superuser url> && pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
git switch -c test/api-upload-dedup
git add apps/server/app/documents/upload.dedup.pg.test.ts
git commit -m "test(api): upload dedup, cross-user and keyed-name tests

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
gh pr create --draft --title "test(api): upload dedup, cross-user and keyed-name tests" --body "🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Expected: gate green; about 75 changed lines, 1 file.

---

### Task 56: start `ingest-document` after the upload commits, and wire the routes into `main.ts`

Owner decision 1 / spec §5.1 step 4. The start happens **after** `withTenant` has committed, never inside it; a failed start is logged by class and path only and never fails the upload.

**Files:**
- Modify: `apps/server/app/documents/routes.ts`
- Modify: `apps/server/app/documents/testHarness.ts` (a real in-memory Loom app, the `ingest` probe)
- Modify: `apps/server/app/main.ts`
- Create: `apps/server/app/documents/ingestStart.pg.test.ts`

**Interfaces:**
- Consumes: Task 54 (`IngestPort`, `loomIngest`, `pgIngestDeps`, `setIngestDeps`), Task 55a (`documentRoutes`, `startDocumentServer`), M1 `buildApp`.
- Produces:
  - `DocumentRoutesDeps.ingest: IngestPort` (required).
  - Upload behaviour: a **new** document (201) starts its execution once the transaction has committed. A **duplicate** (200) whose stored `status` is still `uploaded` re-attempts the start (start-once makes this safe), which is the only recovery for a crash between commit and start until the M3 sweep; a duplicate in any other status starts nothing. A start that throws is swallowed after `console.error(<class name>, <route>)`: the response is still 201/200.
  - Harness: `DocumentHarness.ingest: IngestProbe` where `IngestProbe = { handles: Map<string, ExecutionHandle>; calls: string[]; hold(): void; release(): void; failNext(op: "start" | "cancel"): void }`. `calls` records `start:<documentId>` and `cancel:<documentId>` in order; `hold()` makes the stub step wait before it looks the document up, `release()` lets it go; `failNext` makes the next call of that kind throw. The harness builds `buildApp({ kind: "memory" })`, calls `setIngestDeps` with the held/released wrapper of `pgIngestDeps(app)`, and `close()` calls `resetIngestDeps()` and closes the Loom app. (Process-global deps: Uncertain #6.)

- [ ] **Step 1: Extend the harness and write the failing tests**

In `testHarness.ts`, add (imports: `type ExecutionHandle` from `@loom/workflow-runtime`, `buildApp` from `../config`, `resetIngestDeps`/`setIngestDeps` from `../flows/ingest-document/deps`, `pgIngestDeps` from `../flows/ingest-document/pgDeps`, `type IngestPort`/`loomIngest` from `./ingest`):

```ts
export interface IngestProbe {
  /** The execution handle of every start that created an execution, by document id. */
  handles: Map<string, ExecutionHandle>;
  /** "start:<documentId>" and "cancel:<documentId>", in call order. */
  calls: string[];
  hold(): void;
  release(): void;
  failNext(op: "start" | "cancel"): void;
}

function makeIngest(app: PgPool): { port: IngestPort; probe: IngestProbe; close(): Promise<void> } {
  const loom = buildApp({ kind: "memory" });
  const real = pgIngestDeps(app);
  let gate: Promise<void> | null = null;
  let open: () => void = () => {};
  setIngestDeps({
    documentExists: async (ref) => {
      await gate;
      return real.documentExists(ref);
    },
  });
  const inner = loomIngest(loom.runtime);
  const failures = { start: 0, cancel: 0 };
  const probe: IngestProbe = {
    handles: new Map(),
    calls: [],
    hold() {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release() {
      open();
      gate = null;
    },
    failNext(op) {
      failures[op]++;
    },
  };
  const port: IngestPort = {
    async start(identity, documentId) {
      probe.calls.push(`start:${documentId}`);
      if (failures.start > 0) {
        failures.start--;
        throw new Error("synthetic-start-error");
      }
      const handle = await inner.start(identity, documentId);
      if (handle) probe.handles.set(documentId, handle);
      return handle;
    },
    async cancel(identity, documentId) {
      probe.calls.push(`cancel:${documentId}`);
      if (failures.cancel > 0) {
        failures.cancel--;
        throw new Error("synthetic-cancel-error");
      }
      await inner.cancel(identity, documentId);
    },
  };
  return {
    port,
    probe,
    close: async () => {
      probe.release();
      resetIngestDeps();
      await loom.close();
    },
  };
}
```

In `startDocumentServer`: `const ingest = makeIngest(app);`, pass `ingest: ingest.port` to `documentRoutes`, add `ingest: IngestProbe` to `DocumentHarness`, return `ingest: ingest.probe`, and call `await ingest.close()` at the start of `close()`.

`apps/server/app/documents/ingestStart.pg.test.ts`:

```ts
import type { DocumentDto, UploadDocumentResponse } from "@docmind/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PG_URL } from "../db/testSupport";
import { ingestExecutionId } from "./ingest";
import { type DocumentHarness, TEXT, U1, startDocumentServer } from "./testHarness";

describe.skipIf(!PG_URL)("upload starts the ingest flow (needs DOCMIND_TEST_PG_URL)", () => {
  let h: DocumentHarness;
  beforeAll(async () => {
    h = await startDocumentServer();
  });
  afterAll(async () => {
    await h?.close();
  });

  const created = async (name: string, bytes: Buffer, user = "alice") => {
    const res = await h.upload(user, name, bytes);
    return { res, body: (await res.json()) as UploadDocumentResponse };
  };

  it("starts exactly one execution per new document, after the row is committed, with the owner's execution id", async () => {
    const { res, body } = await created("a.txt", TEXT("starts once"));
    expect(res.status).toBe(201);
    const id = body.document.id;
    expect(h.ingest.calls.filter((c) => c === `start:${id}`)).toHaveLength(1);
    const handle = h.ingest.handles.get(id);
    expect(handle?.executionId).toBe(ingestExecutionId(U1, id));
    const state = await handle?.waitForCompletion();
    expect(state?.status).toBe("completed");
    expect(state?.variables._output).toEqual({ outcome: "accepted" });
    // The stub writes nothing: the document is still `uploaded`.
    const row = await h.owner.query("SELECT status FROM documents WHERE id = $1", [id]);
    expect(row.rows[0].status).toBe("uploaded");
  });

  it("re-attempts the start for a duplicate that is still uploaded, which creates no second execution", async () => {
    const bytes = TEXT("dup flow");
    const first = await created("a.txt", bytes);
    const id = first.body.document.id;
    const handle = h.ingest.handles.get(id);
    await handle?.waitForCompletion();
    const again = await created("again.txt", bytes);
    expect(again.res.status).toBe(200);
    // The re-attempt is made (the document is still `uploaded`) and answered "already started":
    // two start calls, but one execution (the stored handle is the first one, not replaced).
    expect(h.ingest.calls.filter((c) => c === `start:${id}`)).toHaveLength(2);
    expect(h.ingest.handles.get(id)).toBe(handle);
  });

  it("starts nothing for an upload that is refused", async () => {
    const before = h.ingest.calls.length;
    const res = await h.upload("alice", "tool.exe", Buffer.from("MZ\u0090\u0000\u0003"));
    expect(res.status).toBe(415);
    expect(h.ingest.calls.length).toBe(before);
  });

  it("answers 201 even when the start fails, logs only the class, and a later identical upload retries it", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.ingest.failNext("start");
    const bytes = TEXT("start fails");
    const first = await created("secret-name.txt", bytes);
    expect(first.res.status).toBe(201);
    expect(first.body.document.status).toBe("uploaded");
    expect(h.ingest.handles.has(first.body.document.id)).toBe(false);
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).not.toContain("secret-name");
    expect(logged).not.toContain("synthetic-start-error"); // the message could name anything; only the class is logged
    spy.mockRestore();

    const retry = await created("secret-name.txt", bytes);
    expect(retry.res.status).toBe(200);
    expect(retry.body.duplicate).toBe(true);
    expect(h.ingest.handles.has(first.body.document.id)).toBe(true);
  });

  it("gives the execution only ids: the stub's start input has no filename, title or content", async () => {
    const { body } = await created("Quarterly report.txt", TEXT("ids only"));
    const handle = h.ingest.handles.get(body.document.id);
    const state = JSON.stringify(handle?.getState());
    expect(state).not.toContain("Quarterly");
    expect(state).not.toContain("report");
    expect((body.document as DocumentDto).filename).toBe("Quarterly report.txt");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `export DOCMIND_TEST_PG_URL=<superuser url> && pnpm --filter @docmind/server exec vitest run app/documents/ingestStart.pg.test.ts`
Expected: FAIL (no execution is started: `calls` is empty; and `tsc` rejects `ingest` in the harness until `DocumentRoutesDeps.ingest` exists).

- [ ] **Step 3: Implement**

In `routes.ts`: import `type IngestPort` from `./ingest`; add to `DocumentRoutesDeps`:

```ts
  /** Starts and cancels document ingestion. */
  ingest: IngestPort;
```

Change `Registered` to carry the status the start decision needs, and start after the transaction in `upload`:

```ts
type Registered = {
  document: UploadDocumentResponse["document"];
  duplicate: boolean;
};
```

(`document.status` already tells whether a duplicate is still `uploaded`.) After the `uploadError`/`rejected` checks in `upload`, replace the final `json(...)` with:

```ts
  const { document, duplicate } = outcome.value.result;
  // The row is committed. Only now start the flow: a rolled-back upload must never have an execution.
  // A duplicate whose document never left `uploaded` re-attempts the start, which Loom makes start-once.
  if (!duplicate || document.status === "uploaded") {
    await deps.ingest.start(identity, document.id).catch((err: unknown) => {
      // Class and route only: the message could carry anything.
      console.error("ingest start failed:", err instanceof Error ? err.constructor.name : "unknown", "POST /api/documents");
    });
  }
  json(res, duplicate ? 200 : 201, { document, duplicate } satisfies UploadDocumentResponse);
```

In `main.ts`: add imports

```ts
import { EncryptedFsContentStore, removeStaleTemp } from "@docmind/blob-store";
import { FieldCrypto } from "./crypto/fields";
import { loadBlobRoot, loadLimits } from "./documents/limits";
import { loomIngest } from "./documents/ingest";
import { documentRoutes } from "./documents/routes";
import { setIngestDeps } from "./flows/ingest-document/deps";
import { pgIngestDeps } from "./flows/ingest-document/pgDeps";
```

Load configuration next to `loadKeks()` (so a bad variable fails before any connection opens):

```ts
  const limits = loadLimits();
  const blobRoot = loadBlobRoot();
```

After `const keys = new PostgresKeyStore(pool, keks);` add:

```ts
  // A crash can leave half-written uploads behind; they are never referenced, so just clear them.
  await removeStaleTemp(blobRoot, 60 * 60 * 1000);
```

After `const app = buildApp(durable.storage, durable.crypto);` add:

```ts
  // The flows are static modules; give the ingest-document stub step its database access.
  setIngestDeps(pgIngestDeps(pool));
  const ingest = loomIngest(app.runtime);
```

Replace the `createHttpServer(authRoutes({...}))` argument with a merge, declaring `const authenticator = new PasswordAuthenticator(store);` just above (the existing inline `new PasswordAuthenticator(store)` is replaced by this variable so both route sets share one instance):

```ts
  const server = createHttpServer({
    ...authRoutes({
      service: new AuthService(store),
      authenticator,
      store,
      throttle,
      secureCookies: process.env.DOCMIND_COOKIE_SECURE === "true",
      trustProxy: process.env.DOCMIND_TRUST_PROXY === "true",
    }),
    ...documentRoutes({
      pool,
      authenticator,
      fields: new FieldCrypto(keys),
      blobs: ({ tenantId, userId }) =>
        new EncryptedFsContentStore({ root: blobRoot, tenantId, userId, keys, maxBytes: limits.maxFileBytes }),
      limits,
      ingest,
    }),
  });
```

- [ ] **Step 4: Run to verify it passes, gate, commit**

Run: `export DOCMIND_TEST_PG_URL=<superuser url> && pnpm --filter @docmind/server exec vitest run app/documents`
Expected: PASS. (In the "does not start a flow for a duplicate" test the second `start:` call is the re-attempt, answered "already started"; if `runtime.start` does not reject a duplicate id as the plan expects, Uncertain #5 applies: fix `loomIngest.start`, not the test.)

```bash
export DOCMIND_TEST_PG_URL=<superuser url> && pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
git switch -c feat/api-upload-starts-ingest
git add apps/server
git commit -m "feat(api): start the ingest-document flow after upload commits and wire the routes

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
gh pr create --draft --title "feat(api): start the ingest-document flow after upload commits" --body "Spec 5.1 step 4. The start runs after COMMIT, once per new document, and never fails the upload; a duplicate that is still uploaded re-attempts it. Also wires the document routes, flow deps and stale temp cleanup into main.ts.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Expected: gate green; about 180 changed lines, 5 files. If over, move the `main.ts` wiring and `removeStaleTemp` call into a PR of their own that follows this one.

---

### Task 57: upload quotas, the per-user in-flight cap, and rejection/cleanup tests

**Files:**
- Create: `apps/server/app/documents/inFlight.ts`
- Create: `apps/server/app/documents/inFlight.test.ts`
- Create: `apps/server/app/documents/quota.pg.test.ts`
- Modify: `apps/server/app/documents/routes.ts`
- Modify: `apps/server/app/documents/testHarness.ts` (expose the in-flight tracker)

**Interfaces:**
- Consumes: Tasks 55a and 56 (`documentRoutes`, `register`, the start-after-commit block), Task 52b (`usageOfTenant`), Task 50 (`DocumentLimits`).
- Produces:
  - `class InFlight { tryAcquire(key: string, max: number): (() => void) | null }`: returns a release function (idempotent) or `null` at the cap.
  - `DocumentRoutesDeps.inFlight?: InFlight` (default: a new `InFlight` per `documentRoutes` call); `DocumentHarness.inFlight: InFlight`.
  - Upload answers added: `403 quota_exceeded` ("document limit reached" / "storage limit reached"), `429 too_many_uploads` with `Retry-After: 5`.

- [ ] **Step 1: Write the failing tests**

`apps/server/app/documents/inFlight.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { InFlight } from "./inFlight";

describe("InFlight", () => {
  it("allows up to max per key and frees a slot on release", () => {
    const f = new InFlight();
    const a = f.tryAcquire("u1", 2);
    const b = f.tryAcquire("u1", 2);
    expect(a && b).toBeTruthy();
    expect(f.tryAcquire("u1", 2)).toBeNull();
    a?.();
    expect(f.tryAcquire("u1", 2)).not.toBeNull();
  });

  it("counts keys separately and ignores a second release of the same slot", () => {
    const f = new InFlight();
    const a = f.tryAcquire("u1", 1);
    expect(f.tryAcquire("u2", 1)).not.toBeNull();
    a?.();
    a?.();
    expect(f.tryAcquire("u1", 1)).not.toBeNull();
    expect(f.tryAcquire("u1", 1)).toBeNull(); // the double release did not free two slots
  });
});
```

`apps/server/app/documents/quota.pg.test.ts`:

```ts
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { UploadDocumentResponse } from "@docmind/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { PG_URL } from "../db/testSupport";
import { type DocumentHarness, PDF, PNG, T1, TEXT, U1, startDocumentServer } from "./testHarness";

const filesOf = (h: DocumentHarness, tenant: string, user: string) => {
  const dir = join(h.root, tenant, user);
  return existsSync(dir) ? readdirSync(dir) : [];
};
const rowCount = async (h: DocumentHarness) =>
  (await h.owner.query("SELECT count(*)::int AS n FROM documents")).rows[0].n as number;

describe.skipIf(!PG_URL)("upload rejections and quotas (needs DOCMIND_TEST_PG_URL)", () => {
  const open: DocumentHarness[] = [];
  const harness = async (limits = {}) => {
    const h = await startDocumentServer({ limits });
    open.push(h);
    return h;
  };
  afterAll(async () => {
    for (const h of open) await h.close();
  });

  it("refuses an unsupported type with 415 and leaves no row or file", async () => {
    const h = await harness();
    const res = await h.upload("alice", "tool.exe", Buffer.from("MZ\u0090\u0000\u0003"));
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("unsupported_type");
    expect(await rowCount(h)).toBe(0);
    expect(filesOf(h, T1, U1)).toEqual([]);
  });

  it("refuses a request with no file, or not multipart, and a file over the limit", async () => {
    const h = await harness({ maxFileBytes: 64 });
    const none = await fetch(`${h.base}/api/documents`, { method: "POST", headers: { "x-test-user": "alice" }, body: new FormData() });
    expect(none.status).toBe(400);
    const json = await fetch(`${h.base}/api/documents`, {
      method: "POST",
      headers: { "x-test-user": "alice", "content-type": "application/json" },
      body: "{}",
    });
    expect(json.status).toBe(415);
    const big = await h.upload("alice", "big.txt", "x".repeat(65));
    expect(big.status).toBe(413);
    expect(await rowCount(h)).toBe(0);
    expect(filesOf(h, T1, U1)).toEqual([]);
  });

  it("stops at the tenant's document limit (403), counting every user of the tenant, but still answers duplicates", async () => {
    const h = await harness({ tenantMaxDocuments: 2 });
    expect((await h.upload("alice", "1.txt", TEXT("1"))).status).toBe(201);
    expect((await h.upload("alice2", "2.txt", TEXT("2"))).status).toBe(201); // same tenant, other user
    const third = await h.upload("alice", "3.txt", TEXT("3"));
    expect(third.status).toBe(403);
    expect(((await third.json()) as { error: { code: string } }).error.code).toBe("quota_exceeded");
    expect(await rowCount(h)).toBe(2);
    expect(filesOf(h, T1, U1)).toHaveLength(1); // the refused blob was not kept
    const dup = await h.upload("alice", "again.txt", TEXT("1"));
    expect(dup.status).toBe(200);
    expect(((await dup.json()) as UploadDocumentResponse).duplicate).toBe(true);
    expect((await h.upload("bob", "other-tenant.txt", TEXT("3"))).status).toBe(201); // other tenant unaffected
  });

  it("stops at the tenant's storage limit", async () => {
    const h = await harness({ tenantMaxBytes: 100 });
    expect((await h.upload("alice", "a.png", PNG("x".repeat(30)))).status).toBe(201); // 46 bytes
    expect((await h.upload("alice", "b.png", PNG("y".repeat(30)))).status).toBe(201); // 92 in total
    const res = await h.upload("alice", "c.png", PNG("z".repeat(30)));
    expect(res.status).toBe(403);
    expect(await rowCount(h)).toBe(2);
    expect(filesOf(h, T1, U1)).toHaveLength(2);
  });

  it("admits exactly one of two concurrent uploads when only one fits", async () => {
    const h = await harness({ tenantMaxDocuments: 1 });
    const [a, b] = await Promise.all([
      h.upload("alice", "a.pdf", PDF("a")),
      h.upload("alice2", "b.pdf", PDF("b")),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 403]);
    expect(await rowCount(h)).toBe(1);
    expect(filesOf(h, T1, U1).length + filesOf(h, T1, "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2").length).toBe(1);
  });

  it("answers 429 with Retry-After when the user already has the maximum uploads in flight", async () => {
    const h = await harness({ maxConcurrentUploadsPerUser: 1 });
    const slot = h.inFlight.tryAcquire(U1, 1); // an upload that has not finished
    const refused = await h.upload("alice", "a.txt", TEXT("a"));
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("5");
    expect((await h.upload("bob", "b.txt", TEXT("b"))).status).toBe(201); // another user is fine
    slot?.();
    expect((await h.upload("alice", "a.txt", TEXT("a"))).status).toBe(201);
    expect(await rowCount(h)).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `export DOCMIND_TEST_PG_URL=<superuser url> && pnpm --filter @docmind/server exec vitest run app/documents/inFlight.test.ts app/documents/quota.pg.test.ts`
Expected: FAIL (`./inFlight` missing; the quota tests fail on 201 instead of 403/429).

- [ ] **Step 3: Implement**

`apps/server/app/documents/inFlight.ts`:

```ts
/** Counts operations in progress per key (a user id), within this process. */
export class InFlight {
  private readonly counts = new Map<string, number>();

  /** A release function, or null when `key` already has `max` in flight. */
  tryAcquire(key: string, max: number): (() => void) | null {
    const current = this.counts.get(key) ?? 0;
    if (current >= max) return null;
    this.counts.set(key, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.counts.get(key) ?? 1) - 1;
      if (left <= 0) this.counts.delete(key);
      else this.counts.set(key, left);
    };
  }
}
```

In `apps/server/app/documents/routes.ts`:

1. Imports: `import { InFlight } from "./inFlight";` and add `usageOfTenant` to the `./repo` import.
2. Add to `DocumentRoutesDeps`: `/** Uploads in progress per user; defaults to a new tracker. */ inFlight?: InFlight;`
3. Change `Registered` and the start of the `withTenant` callback in `register` so quota is checked after the duplicate check and before the insert:

```ts
type Registered =
  | { kind: "stored"; document: UploadDocumentResponse["document"]; duplicate: boolean }
  | { kind: "quota"; reason: "documents" | "storage" };
```

```ts
      const existing = await findByFingerprint(tx, identity.userId, fingerprint);
      if (existing) {
        await staged.discard();
        return { kind: "stored", document: await toDto(existing, cipher), duplicate: true };
      }
      const usage = await usageOfTenant(tx);
      if (usage.documents + 1 > deps.limits.tenantMaxDocuments) {
        await staged.discard();
        return { kind: "quota", reason: "documents" };
      }
      if (usage.bytes + (staged.ref.size ?? 0) > deps.limits.tenantMaxBytes) {
        await staged.discard();
        return { kind: "quota", reason: "storage" };
      }
```

and the final return of that callback becomes `return { kind: "stored", document: await toDto(row, cipher), duplicate: false };`.

4. In `upload`, take a slot before reading the body and release it when done, and map the new result:

```ts
  const release = (deps.inFlight ?? defaultInFlight).tryAcquire(
    identity.userId,
    deps.limits.maxConcurrentUploadsPerUser,
  );
  if (!release) {
    res.setHeader("retry-after", "5");
    return uploadError(req, res, 429, "too_many_uploads", "too many uploads in progress; try again shortly");
  }
  try {
    /* the existing receiveFile(...) call and response code, unchanged except the lines below */
  } finally {
    release();
  }
```

with, after the `rejected` check:

```ts
  const result = outcome.value.result;
  if (result.kind === "quota") {
    const message = result.reason === "documents" ? "document limit reached" : "storage limit reached";
    return uploadError(req, res, 403, "quota_exceeded", message);
  }
  const { document, duplicate } = result;
  // ...Task 56's start-after-commit block stays here, unchanged, using `document` and `duplicate`...
  json(res, duplicate ? 200 : 201, { document, duplicate } satisfies UploadDocumentResponse);
```

and `const defaultInFlight = new InFlight();` at module level. (Keep one tracker per process: when `deps.inFlight` is absent the module-level one is shared, which is what production wants.)

(The quota tests open several harnesses at once; the process-global ingest deps (Uncertain #6) then belong to the last one opened, which only affects stub-flow outcomes that these tests do not assert.)

In `testHarness.ts`: `import { InFlight } from "./inFlight";`, add `inFlight: InFlight` to `DocumentHarness`, create `const inFlight = new InFlight();` in `startDocumentServer`, pass `inFlight` to `documentRoutes` and return it.

- [ ] **Step 4: Run to verify they pass, gate, commit**

Run: `export DOCMIND_TEST_PG_URL=<superuser url> && pnpm --filter @docmind/server exec vitest run app/documents`
Expected: PASS.

```bash
export DOCMIND_TEST_PG_URL=<superuser url> && pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
git switch -c feat/api-upload-quotas
git add apps/server/app/documents
git commit -m "feat(api): upload quotas and a per-user concurrent upload cap

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
gh pr create --draft --title "feat(api): upload quotas and a per-user concurrent upload cap" --body "🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

### Task 58: path parameters in the router

**Files:**
- Modify: `apps/server/app/http/respond.ts`
- Modify: `apps/server/app/server.ts`
- Modify: `apps/server/app/http/requireAuth.ts`
- Modify: `apps/server/app/server.test.ts`
- Modify: `apps/server/app/http/requireAuth.test.ts`

**Interfaces:**
- Consumes: M1 router and `requireAuth`.
- Produces:
  - `interface RouteContext { params: Readonly<Record<string, string>> }` in `respond.ts`.
  - `Handler = (req, res, ctx: RouteContext) => void | Promise<void>` and `AuthedHandler = (req, res, identity, ctx: RouteContext) => void | Promise<void>`.
  - Router: a route key like `"GET /api/documents/:id"` matches `GET /api/documents/<one non-empty segment>` and passes `{ params: { id } }` (percent-decoded). Exact keys win over parameterised ones. A segment with invalid percent-encoding is a `404`.

- [ ] **Step 1: Write the failing tests**

Add to `apps/server/app/server.test.ts` (a second server so the existing `createHttpServer()` stays untouched):

```ts
describe("route parameters", () => {
  const withParams = createHttpServer({
    "GET /things/:id": (_req, res, ctx) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: ctx.params.id }));
    },
    "GET /things/new": (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ exact: true }));
    },
    "DELETE /things/:id/parts/:part": (_req, res, ctx) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(ctx.params));
    },
  });
  let paramBase = "";

  beforeAll(async () => {
    await new Promise<void>((resolve) => withParams.listen(0, "127.0.0.1", resolve));
    paramBase = `http://127.0.0.1:${(withParams.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => withParams.close(() => resolve()));
  });

  it("passes a path segment as a parameter, decoded", async () => {
    expect(await (await fetch(`${paramBase}/things/abc`)).json()).toEqual({ id: "abc" });
    expect(await (await fetch(`${paramBase}/things/a%20b`)).json()).toEqual({ id: "a b" });
  });

  it("prefers an exact route to a parameterised one", async () => {
    expect(await (await fetch(`${paramBase}/things/new`)).json()).toEqual({ exact: true });
  });

  it("supports several parameters and requires the method to match", async () => {
    const del = await fetch(`${paramBase}/things/1/parts/2`, { method: "DELETE" });
    expect(await del.json()).toEqual({ id: "1", part: "2" });
    expect((await fetch(`${paramBase}/things/1/parts/2`)).status).toBe(404);
  });

  it("does not match an empty segment, an extra segment or a bad escape", async () => {
    expect((await fetch(`${paramBase}/things/`)).status).toBe(404);
    expect((await fetch(`${paramBase}/things/a/b`)).status).toBe(404);
    expect((await fetch(`${paramBase}/things/%E0%A4%A`)).status).toBe(404);
  });
});
```

Add to `apps/server/app/http/requireAuth.test.ts` a route `"GET /whoami/:name"` whose handler echoes `ctx.params.name` together with the identity, and one test that `GET /whoami/x` with `x-test-user: alice` returns `{ name: "x", ...ALICE }` while without the header it is the 401 (the handler must not run).

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @docmind/server exec vitest run app/server.test.ts app/http/requireAuth.test.ts`
Expected: FAIL (404 for parameterised paths; type errors under `typecheck:tests`).

- [ ] **Step 3: Implement**

`apps/server/app/http/respond.ts`: replace the `Handler` type with

```ts
/** What the router knows about the matched route. */
export interface RouteContext {
  /** Path parameters from a route key such as `GET /api/documents/:id`, percent-decoded. */
  params: Readonly<Record<string, string>>;
}

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
) => void | Promise<void>;
```

`apps/server/app/http/requireAuth.ts`: import `RouteContext`, add it to `AuthedHandler` as a fourth parameter and pass it through:

```ts
export type AuthedHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  identity: Identity,
  ctx: RouteContext,
) => void | Promise<void>;
```

```ts
  return async (req, res, ctx) => {
    const identity = await authenticator.authenticate(req);
    if (!identity) return sendError(res, 401, "unauthorized", "authentication required");
    await handler(req, res, identity, ctx);
  };
```

`apps/server/app/server.ts`: replace the lookup with an exact match first, then parameterised patterns compiled once:

```ts
import { type Handler, type RouteContext, json, sendError } from "./http/respond";

interface Pattern {
  method: string;
  segments: string[]; // ":name" entries are parameters
  handler: Handler;
}

function compile(routes: Record<string, Handler>): Pattern[] {
  return Object.entries(routes)
    .filter(([key]) => key.includes("/:"))
    .map(([key, handler]) => {
      const space = key.indexOf(" ");
      return { method: key.slice(0, space), segments: key.slice(space + 1).split("/"), handler };
    });
}

function match(patterns: Pattern[], method: string, path: string): { handler: Handler; ctx: RouteContext } | undefined {
  const parts = path.split("/");
  for (const p of patterns) {
    if (p.method !== method || p.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < parts.length && ok; i++) {
      const want = p.segments[i] as string;
      const got = parts[i] as string;
      if (want.startsWith(":")) {
        try {
          params[want.slice(1)] = decodeURIComponent(got);
          ok = got !== "";
        } catch {
          ok = false;
        }
      } else ok = want === got;
    }
    if (ok) return { handler: p.handler, ctx: { params } };
  }
  return undefined;
}
```

and in `createHttpServer`: `const patterns = compile(routes);`, then

```ts
    const exact = Object.hasOwn(routes, key) ? routes[key] : undefined;
    const found = exact
      ? { handler: exact, ctx: { params: {} } satisfies RouteContext }
      : match(patterns, method, path);
    if (!found) return sendError(res, 404, "not_found", "no such route");
    (async () => found.handler(req, res, found.ctx))().catch(...)  // the existing catch block, unchanged
```

(`baseRoutes` keys contain no `/:`, so `compile` ignores them; an exact key such as `GET /things/new` never reaches `match`.)

- [ ] **Step 4: Run to verify it passes, gate, commit**

Run: `pnpm --filter @docmind/server exec vitest run app/server.test.ts app/http/requireAuth.test.ts`
Expected: PASS. Then run the full gate: every existing handler (auth routes, upload) still type-checks because a handler with fewer parameters is assignable; fix any test that called a handler directly by passing `{ params: {} }`.

```bash
export DOCMIND_TEST_PG_URL=<superuser url> && pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
git switch -c feat/server-route-params
git add apps/server/app
git commit -m "feat(server): path parameters in the router

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
gh pr create --draft --title "feat(server): path parameters in the router" --body "🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

### Task 59: `GET /api/documents` (paged) and `GET /api/documents/:id`

**Files:**
- Create: `apps/server/app/documents/cursor.ts`
- Create: `apps/server/app/documents/cursor.test.ts`
- Modify: `apps/server/app/documents/repo.ts` (add `listDocuments`, `getDocument`)
- Modify: `apps/server/app/documents/routes.ts`
- Create: `apps/server/app/documents/read.pg.test.ts`

**Interfaces:**
- Consumes: Task 52a (`DOCUMENT_COLUMNS`, `DocumentRow`, `toDto`), Task 58 (`ctx.params`), contracts `ListDocumentsQuery`, `ListDocumentsResponse`, `Uuid`.
- Produces:
  - `encodeCursor(row: { created_cursor: string; id: string }): string` and `decodeCursor(cursor: string): { t: string; i: string } | null` (opaque base64url JSON; strict validation of both fields).
  - `listDocuments(tx, ownerId, page: { cursor: { t: string; i: string } | null; limit: number }): Promise<{ rows: DocumentRow[]; next: { created_cursor: string; id: string } | null }>`: newest first by `(created_at, id)`, only `owner_id = ownerId`.
  - `getDocument(tx, ownerId, id): Promise<DocumentRow | undefined>`
  - Routes `"GET /api/documents"` (200 `ListDocumentsResponse`; `400 invalid_request` for a bad `limit`; `400 invalid_cursor`) and `"GET /api/documents/:id"` (200 `DocumentDto`; `404 not_found` for a missing, foreign or malformed id).

- [ ] **Step 1: Write the failing tests**

`apps/server/app/documents/cursor.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "./cursor";

const row = { created_cursor: "2026-10-18T10:20:30.123456Z", id: "10000000-0000-4000-8000-000000000001" };

describe("cursor", () => {
  it("round-trips and is URL-safe", () => {
    const token = encodeCursor(row);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(token)).toEqual({ t: row.created_cursor, i: row.id });
  });

  it("rejects anything that is not a cursor this server issued", () => {
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    for (const bad of [
      "",
      "not base64 !!",
      enc({}),
      enc({ t: "yesterday", i: row.id }),
      enc({ t: row.created_cursor, i: "x'; DROP TABLE documents;--" }),
      enc({ t: row.created_cursor, i: row.id, extra: 1 }),
      enc([row.created_cursor, row.id]),
      "e30", // {}
    ]) {
      expect(decodeCursor(bad), bad).toBeNull();
    }
  });
});
```

`apps/server/app/documents/read.pg.test.ts`:

```ts
import type { DocumentDto, ListDocumentsResponse } from "@docmind/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_URL } from "../db/testSupport";
import { type DocumentHarness, PDF, TEXT, startDocumentServer } from "./testHarness";

describe.skipIf(!PG_URL)("reading documents (needs DOCMIND_TEST_PG_URL)", () => {
  let h: DocumentHarness;
  const mine: string[] = [];

  const get = (path: string, user = "alice") =>
    fetch(`${h.base}${path}`, { headers: { "x-test-user": user } });

  beforeAll(async () => {
    h = await startDocumentServer();
    for (let i = 0; i < 5; i++) {
      const res = await h.upload("alice", `doc ${i}.txt`, TEXT(String(i)));
      mine.push(((await res.json()) as { document: DocumentDto }).document.id);
    }
    await h.upload("alice2", "colleague.txt", TEXT("colleague")); // same tenant, other user
    await h.upload("bob", "other tenant.txt", TEXT("bob"));
  });
  afterAll(async () => {
    await h?.close();
  });

  it("lists only the caller's documents, newest first, across pages without gaps or repeats", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await get(`/api/documents?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      expect(res.status).toBe(200);
      const page = (await res.json()) as ListDocumentsResponse;
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((d) => d.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(5);
    expect([...seen].sort()).toEqual([...mine].sort());
    const expected = await h.owner.query(
      "SELECT id FROM documents WHERE owner_id = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1' ORDER BY created_at DESC, id DESC",
    );
    expect(seen).toEqual(expected.rows.map((r) => r.id));
  });

  it("returns decrypted titles and a null cursor on the last page", async () => {
    const res = await get("/api/documents");
    const page = (await res.json()) as ListDocumentsResponse;
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((d) => d.title).sort()).toEqual(["doc 0", "doc 1", "doc 2", "doc 3", "doc 4"]);
  });

  it("returns an empty list for a user with nothing", async () => {
    await h.owner.query("DELETE FROM documents WHERE owner_id = 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2'");
    const page = (await (await get("/api/documents", "alice2")).json()) as ListDocumentsResponse;
    expect(page).toEqual({ items: [], nextCursor: null });
  });

  it("rejects a bad limit or cursor with 400", async () => {
    expect((await get("/api/documents?limit=0")).status).toBe(400);
    expect((await get("/api/documents?limit=101")).status).toBe(400);
    expect((await get("/api/documents?limit=abc")).status).toBe(400);
    const bad = await get("/api/documents?cursor=bm90IGEgY3Vyc29y");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe("invalid_cursor");
  });

  it("gets one document, and answers the same 404 for missing, foreign and malformed ids", async () => {
    const ok = await get(`/api/documents/${mine[0]}`);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as DocumentDto).id).toBe(mine[0]);

    const bobsId = (
      await h.owner.query("SELECT id FROM documents WHERE owner_id = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1'")
    ).rows[0].id as string;
    const missing = await get("/api/documents/00000000-0000-4000-8000-000000000000");
    const otherTenant = await get(`/api/documents/${bobsId}`);
    const malformed = await get("/api/documents/not-a-uuid");
    for (const res of [missing, otherTenant, malformed]) expect(res.status).toBe(404);
    expect(await otherTenant.text()).toBe(await missing.clone().text());
  });

  it("requires a session on both routes", async () => {
    expect((await fetch(`${h.base}/api/documents`)).status).toBe(401);
    expect((await fetch(`${h.base}/api/documents/${mine[0]}`)).status).toBe(401);
  });

  it("shows a colleague's document to neither route", async () => {
    const res = await h.upload("alice2", "private.pdf", PDF("mine"));
    const id = ((await res.json()) as { document: DocumentDto }).document.id;
    expect((await get(`/api/documents/${id}`, "alice")).status).toBe(404);
    const list = (await (await get("/api/documents?limit=100")).json()) as ListDocumentsResponse;
    expect(list.items.map((d) => d.id)).not.toContain(id);
  });
});
```

(The `missing.clone().text()` comparison needs `missing` unread when compared; if the executor reads `missing` earlier, compare `JSON` bodies instead. The point: a foreign id and a missing id are byte-identical.)

- [ ] **Step 2: Run to verify they fail**

Run: `export DOCMIND_TEST_PG_URL=<superuser url> && pnpm --filter @docmind/server exec vitest run app/documents/cursor.test.ts app/documents/read.pg.test.ts`
Expected: FAIL (`./cursor` missing; GET routes answer 404).

- [ ] **Step 3: Implement**

`apps/server/app/documents/cursor.ts`:

```ts
import { z } from "zod";

// The keyset of the list order: created_at to the microsecond (UTC, exactly as Postgres formats
// it in repo.ts) and the id. Opaque to clients, but not trusted: it is validated like any input.
const Body = z
  .object({
    t: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
    i: z.string().uuid(),
  })
  .strict();

export function encodeCursor(row: { created_cursor: string; id: string }): string {
  return Buffer.from(JSON.stringify({ t: row.created_cursor, i: row.id })).toString("base64url");
}

export function decodeCursor(cursor: string): { t: string; i: string } | null {
  try {
    const parsed = Body.safeParse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
```

Add to `apps/server/app/documents/repo.ts`:

```ts
export async function listDocuments(
  tx: PoolClient,
  ownerId: string,
  page: { cursor: { t: string; i: string } | null; limit: number },
): Promise<{ rows: DocumentRow[]; next: { created_cursor: string; id: string } | null }> {
  const { rows } = await tx.query<DocumentRow>(
    `SELECT ${DOCUMENT_COLUMNS} FROM documents
      WHERE owner_id = $1
        AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
      ORDER BY created_at DESC, id DESC
      LIMIT $4`,
    [ownerId, page.cursor?.t ?? null, page.cursor?.i ?? null, page.limit + 1],
  );
  const more = rows.length > page.limit;
  const kept = more ? rows.slice(0, page.limit) : rows;
  const last = kept[kept.length - 1];
  return { rows: kept, next: more && last ? { created_cursor: last.created_cursor, id: last.id } : null };
}

export async function getDocument(
  tx: PoolClient,
  ownerId: string,
  id: string,
): Promise<DocumentRow | undefined> {
  const { rows } = await tx.query<DocumentRow>(
    `SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = $1 AND owner_id = $2`,
    [id, ownerId],
  );
  return rows[0];
}
```

In `routes.ts` add imports (`ListDocumentsQuery`, `type ListDocumentsResponse`, `Uuid` from `@docmind/contracts`; `decodeCursor`, `encodeCursor` from `./cursor`; `getDocument`, `listDocuments` from `./repo`) and these entries to the object returned by `documentRoutes`:

```ts
    "GET /api/documents": requireAuth(deps.authenticator, async (req, res, identity) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const query = ListDocumentsQuery.safeParse(Object.fromEntries(url.searchParams));
      if (!query.success) return sendError(res, 400, "invalid_request", "invalid query");
      let cursor: { t: string; i: string } | null = null;
      if (query.data.cursor !== undefined) {
        cursor = decodeCursor(query.data.cursor);
        if (!cursor) return sendError(res, 400, "invalid_cursor", "cursor is not valid");
      }
      const page = await withTenant(deps.pool, identity.tenantId, (tx) =>
        listDocuments(tx, identity.userId, { cursor, limit: query.data.limit }),
      );
      const cipher = deps.fields.forUser(identity.userId);
      json(res, 200, {
        items: await Promise.all(page.rows.map((row) => toDto(row, cipher))),
        nextCursor: page.next ? encodeCursor(page.next) : null,
      } satisfies ListDocumentsResponse);
    }),

    "GET /api/documents/:id": requireAuth(deps.authenticator, async (_req, res, identity, ctx) => {
      const id = Uuid.safeParse(ctx.params.id);
      // A malformed id answers exactly like a missing or foreign one.
      const row = id.success
        ? await withTenant(deps.pool, identity.tenantId, (tx) => getDocument(tx, identity.userId, id.data))
        : undefined;
      if (!row) return sendError(res, 404, "not_found", "document not found");
      json(res, 200, await toDto(row, deps.fields.forUser(identity.userId)));
    }),
```

- [ ] **Step 4: Run to verify they pass, gate, commit**

Run: `export DOCMIND_TEST_PG_URL=<superuser url> && pnpm --filter @docmind/server exec vitest run app/documents`
Expected: PASS.

```bash
export DOCMIND_TEST_PG_URL=<superuser url> && pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
git switch -c feat/api-document-read
git add apps/server/app/documents
git commit -m "feat(api): list and get document endpoints

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
gh pr create --draft --title "feat(api): list and get document endpoints" --body "🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

### Task 60: `DELETE /api/documents/:id`: cancel the flow, then remove the row and the blob

Owner decision 4: delete cancels the document's ingest execution first, then hard-deletes the row and the blob; a flow step that finds its document gone stops cleanly (Task 53). The upload/delete race test and the erasure-shape test are Task 61.

**Files:**
- Modify: `apps/server/app/documents/repo.ts` (add `deleteDocument`)
- Modify: `apps/server/app/documents/routes.ts`
- Create: `apps/server/app/documents/delete.pg.test.ts`

**Interfaces:**
- Consumes: Task 52b (`lockTenantForWrite`), Task 54 (`IngestPort.cancel`), Task 56 (`deps.ingest`, harness `ingest` probe), Task 58 (`ctx.params`), Task 59 (`getDocument`).
- Produces:
  - `deleteDocument(tx, ownerId, id): Promise<{ contentAddress: string } | undefined>`: `DELETE ... RETURNING content_address`.
  - Route `"DELETE /api/documents/:id"`, in this order: (1) a non-UUID, missing, foreign or other-tenant id is `404 not_found` and nothing else happens (no cancel); (2) `deps.ingest.cancel(identity, id)` - if it throws, the answer is `500`, **the row and blob are untouched**, and the delete can simply be repeated; (3) in one transaction under the tenant lock: delete the row, delete the blob, commit; `204`. A delete in any status is allowed (a stuck document must be removable). A repeated delete after success is `404` and cancels nothing; a repeated delete after a failed attempt finishes the job.

- [ ] **Step 1: Write the failing test**

`apps/server/app/documents/delete.pg.test.ts`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DocumentDto } from "@docmind/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_URL } from "../db/testSupport";
import { type DocumentHarness, T1, TEXT, U1, startDocumentServer } from "./testHarness";

describe.skipIf(!PG_URL)("DELETE /api/documents/:id (needs DOCMIND_TEST_PG_URL)", () => {
  let h: DocumentHarness;
  beforeAll(async () => {
    h = await startDocumentServer();
  });
  afterAll(async () => {
    await h?.close();
  });

  const del = (id: string, user = "alice") =>
    fetch(`${h.base}/api/documents/${id}`, { method: "DELETE", headers: { "x-test-user": user } });
  const create = async (name: string, bytes: Buffer, user = "alice") =>
    ((await (await h.upload(user, name, bytes)).json()) as { document: DocumentDto }).document;
  const rows = async (id: string) =>
    (await h.owner.query("SELECT count(*)::int AS n FROM documents WHERE id = $1", [id])).rows[0].n as number;
  const blobPath = async (bytes: Buffer) => join(h.root, T1, U1, await h.fingerprint("alice", bytes));

  it("hard-deletes the row and the blob, then answers 404 the second time", async () => {
    const bytes = TEXT("delete me");
    const doc = await create("a.txt", bytes);
    expect(existsSync(await blobPath(bytes))).toBe(true);
    expect((await del(doc.id)).status).toBe(204);
    expect(await rows(doc.id)).toBe(0);
    expect(existsSync(await blobPath(bytes))).toBe(false);
    expect((await del(doc.id)).status).toBe(404);
  });

  it("will not delete a colleague's or another tenant's document, and cancels nothing for them", async () => {
    const mine = await create("mine.txt", TEXT("colleague-owned"), "alice2");
    const before = h.ingest.calls.length;
    expect((await del(mine.id, "alice")).status).toBe(404);
    expect((await del(mine.id, "bob")).status).toBe(404);
    expect(await rows(mine.id)).toBe(1);
    expect((await del("not-a-uuid")).status).toBe(404);
    expect(h.ingest.calls.length).toBe(before); // no cancel was attempted for any of them
    expect((await fetch(`${h.base}/api/documents/${mine.id}`, { method: "DELETE" })).status).toBe(401);
  });

  it("lets the same bytes be uploaded again afterwards as a new document with its own execution", async () => {
    const bytes = TEXT("round trip");
    const first = await create("a.txt", bytes);
    await del(first.id);
    const res = await h.upload("alice", "a.txt", bytes);
    expect(res.status).toBe(201);
    const second = ((await res.json()) as { document: DocumentDto }).document;
    expect(second.id).not.toBe(first.id);
    expect(existsSync(await blobPath(bytes))).toBe(true);
    expect(h.ingest.handles.has(second.id)).toBe(true);
  });

  it("cancels the flow first: a delete during an in-flight flow cancels it, and the step that was running finds nothing", async () => {
    h.ingest.hold(); // the stub step waits before it looks the document up
    const bytes = TEXT("in flight");
    const doc = await create("busy.txt", bytes);
    const handle = h.ingest.handles.get(doc.id);
    expect(handle).toBeDefined();

    expect((await del(doc.id)).status).toBe(204);
    expect(h.ingest.calls.filter((c) => c === `cancel:${doc.id}`)).toHaveLength(1);
    expect(await rows(doc.id)).toBe(0);
    expect(existsSync(await blobPath(bytes))).toBe(false);

    h.ingest.release(); // the in-flight step now runs, and the document is gone
    await expect(handle?.waitForCompletion()).rejects.toThrow();
    expect(handle?.getState().status).toBe("cancelled");
  });

  it("cancels before it deletes: if the cancel fails nothing is deleted, and repeating the delete finishes the job", async () => {
    const bytes = TEXT("cancel fails once");
    const doc = await create("c.txt", bytes);
    h.ingest.failNext("cancel");
    expect((await del(doc.id)).status).toBe(500);
    expect(await rows(doc.id)).toBe(1);
    expect(existsSync(await blobPath(bytes))).toBe(true);

    expect((await del(doc.id)).status).toBe(204); // idempotent: the retry completes the delete
    expect(await rows(doc.id)).toBe(0);
    expect(existsSync(await blobPath(bytes))).toBe(false);
    const cancels = h.ingest.calls.filter((c) => c === `cancel:${doc.id}`);
    expect(cancels).toHaveLength(2); // the failed attempt and the retry
    expect((await del(doc.id)).status).toBe(404); // and a third delete changes and cancels nothing
    expect(h.ingest.calls.filter((c) => c === `cancel:${doc.id}`)).toHaveLength(2);
  });

  it("deletes a document whose flow already finished, and one whose flow never started", async () => {
    const done = await create("done.txt", TEXT("finished flow"));
    await h.ingest.handles.get(done.id)?.waitForCompletion();
    expect((await del(done.id)).status).toBe(204);

    h.ingest.failNext("start"); // upload commits, the flow never starts
    const orphan = await create("never.txt", TEXT("never started"));
    expect(h.ingest.handles.has(orphan.id)).toBe(false);
    expect((await del(orphan.id)).status).toBe(204); // cancel of an unknown execution is not an error
    expect(await rows(orphan.id)).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `export DOCMIND_TEST_PG_URL=<superuser url> && pnpm --filter @docmind/server exec vitest run app/documents/delete.pg.test.ts`
Expected: FAIL (the DELETE route answers 404; the first test fails).

- [ ] **Step 3: Implement**

Add to `apps/server/app/documents/repo.ts`:

```ts
/** Removes the row (RLS and the owner filter scope it). Returns what the blob store needs, or undefined. */
export async function deleteDocument(
  tx: PoolClient,
  ownerId: string,
  id: string,
): Promise<{ contentAddress: string } | undefined> {
  const { rows } = await tx.query<{ content_address: string }>(
    "DELETE FROM documents WHERE id = $1 AND owner_id = $2 RETURNING content_address",
    [id, ownerId],
  );
  return rows[0] ? { contentAddress: rows[0].content_address } : undefined;
}
```

Add to `documentRoutes` in `routes.ts` (import `deleteDocument`; `getDocument` and `Uuid` are already imported by Task 59):

```ts
    "DELETE /api/documents/:id": requireAuth(deps.authenticator, async (_req, res, identity, ctx) => {
      const id = Uuid.safeParse(ctx.params.id);
      if (!id.success) return sendError(res, 404, "not_found", "document not found");
      const mine = await withTenant(deps.pool, identity.tenantId, (tx) =>
        getDocument(tx, identity.userId, id.data),
      );
      if (!mine) return sendError(res, 404, "not_found", "document not found");

      // 1. Cancel the document's ingest execution first (spec §5.2). If this throws, nothing has
      //    been deleted and the whole delete can be repeated; a step still running when the cancel
      //    lands finds its document gone and stops cleanly.
      await deps.ingest.cancel(identity, id.data);

      // 2. The row and the blob go under the tenant lock that uploads take before they decide to
      //    reuse a blob, so an upload of the same bytes cannot slip between the two. If COMMIT then
      //    fails the row survives without its blob; deleting again finishes the job.
      const store = deps.blobs(identity);
      const removed = await withTenant(deps.pool, identity.tenantId, async (tx) => {
        await lockTenantForWrite(tx, identity.tenantId);
        const gone = await deleteDocument(tx, identity.userId, id.data);
        if (gone) await store.delete({ __loomContent: gone.contentAddress });
        return gone;
      });
      if (!removed) return sendError(res, 404, "not_found", "document not found"); // a concurrent delete won
      res.writeHead(204);
      res.end();
    }),
```

- [ ] **Step 4: Run to verify it passes, gate, commit**

Run: `export DOCMIND_TEST_PG_URL=<superuser url> && pnpm --filter @docmind/server exec vitest run app/documents`
Expected: PASS. If the 500 for a failed cancel arrives as a dropped connection instead, check that the router's catch answers 500 for a thrown handler (M1 `server.ts`) and fix the test's expectation only if that is its documented behaviour.

```bash
export DOCMIND_TEST_PG_URL=<superuser url> && pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
git switch -c feat/api-document-delete
git add apps/server/app/documents
git commit -m "feat(api): delete document endpoint that cancels the ingest flow first

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
gh pr create --draft --title "feat(api): delete document endpoint that cancels the ingest flow first" --body "Cancel the ingest execution, then hard-delete the row and blob under the tenant lock. Tests: delete during an in-flight flow, a failed cancel leaves everything intact and a retry completes, repeated delete is 404 and cancels nothing.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Expected: gate green; about 190 changed lines, 3 files. If over, the in-flight and repeated-delete tests become their own PR after this one.

---

### Task 61: upload/delete race and the erasure shape

**Files:**
- Create: `apps/server/app/documents/delete.race.pg.test.ts`

**Interfaces:**
- Consumes: Tasks 55a-60 (routes, harness, `eraseUserBlobs` from Task 46a).
- Produces: nothing (tests only).

- [ ] **Step 1: Write the tests**

`apps/server/app/documents/delete.race.pg.test.ts`:

```ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { eraseUserBlobs } from "@docmind/blob-store";
import type { DocumentDto } from "@docmind/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_URL } from "../db/testSupport";
import { type DocumentHarness, T1, TEXT, U1B, startDocumentServer } from "./testHarness";

describe.skipIf(!PG_URL)("delete races and the erasure shape (needs DOCMIND_TEST_PG_URL)", () => {
  let h: DocumentHarness;
  beforeAll(async () => {
    h = await startDocumentServer();
  });
  afterAll(async () => {
    await h?.close();
  });

  const create = async (name: string, bytes: Buffer, user = "alice") =>
    ((await (await h.upload(user, name, bytes)).json()) as { document: DocumentDto }).document;

  it("never leaves a row without its blob when an upload of the same bytes races a delete", async () => {
    for (let i = 0; i < 10; i++) {
      const bytes = TEXT(`race ${i}`);
      const doc = await create("r.txt", bytes);
      const fp = await h.fingerprint("alice", bytes);
      const [, uploaded] = await Promise.all([
        fetch(`${h.base}/api/documents/${doc.id}`, { method: "DELETE", headers: { "x-test-user": "alice" } }),
        h.upload("alice", "r2.txt", bytes),
      ]);
      expect([200, 201]).toContain(uploaded.status);
      const row = await h.owner.query("SELECT count(*)::int AS n FROM documents WHERE fingerprint = $1", [fp]);
      // Either order is legal, but a surviving row must have its blob and a missing row must not.
      expect(existsSync(join(h.root, T1, "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1", fp)), `iteration ${i}`).toBe(
        row.rows[0].n === 1,
      );
    }
  });

  it("is the shape erasure needs: deleting the user removes their rows, then their blobs go, then the key", async () => {
    const bytes = TEXT("erase everything");
    const doc = await create("e.txt", bytes, "alice2");
    const fp = await h.fingerprint("alice2", bytes);
    const blob = join(h.root, T1, U1B, fp);
    expect(existsSync(blob)).toBe(true);

    await h.owner.query("DELETE FROM users WHERE id = $1", [U1B]); // cascades
    const left = await h.owner.query("SELECT count(*)::int AS n FROM documents WHERE id = $1", [doc.id]);
    expect(left.rows[0].n).toBe(0);
    await eraseUserBlobs(h.root, T1, U1B);
    await eraseUserBlobs(h.root, T1, U1B); // idempotent
    expect(existsSync(blob)).toBe(false);
    await h.keys.destroy(U1B); // and then the key
    expect(await h.keys.wasDestroyed(U1B)).toBe(true);
    // With the key gone the fingerprint of a known file can no longer be computed.
    await expect(h.fingerprint("alice2", bytes)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run, gate, commit**

Run: `export DOCMIND_TEST_PG_URL=<superuser url> && pnpm --filter @docmind/server exec vitest run app/documents/delete.race.pg.test.ts`
Expected: PASS (no failing-first step: this task adds no behaviour; if it fails, the fix belongs to Task 60, with a regression test there).

```bash
export DOCMIND_TEST_PG_URL=<superuser url> && pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
git switch -c test/api-delete-race-erasure
git add apps/server/app/documents/delete.race.pg.test.ts
git commit -m "test(api): upload/delete race and the erasure shape

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
gh pr create --draft --title "test(api): upload/delete race and the erasure shape" --body "🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

### Task 62: M2 acceptance test over real authentication

Proves the milestone's "runnable" claim end to end with the real `Authenticator`, session cookies and `PostgresKeyStore`, that an upload starts the real stub flow and a delete cancels it, and that nothing readable (and no plain sha256) is left in the database or on disk.

**Files:**
- Create: `apps/server/app/documents/documents.e2e.pg.test.ts`

**Interfaces:**
- Consumes: everything above plus M1 `authRoutes`, `AuthService`, `PasswordAuthenticator`, `PgAuthStore`, `PgThrottle`, `PostgresKeyStore`.
- Produces: nothing (test only).

- [ ] **Step 1: Write the test**

`apps/server/app/documents/documents.e2e.pg.test.ts`:

```ts
import { createHash, createSecretKey, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthService, PasswordAuthenticator } from "@docmind/auth";
import { EncryptedFsContentStore } from "@docmind/blob-store";
import type { DocumentDto, ListDocumentsResponse, UploadDocumentResponse } from "@docmind/contracts";
import { PostgresKeyStore } from "@docmind/keystore-pg";
import type { ExecutionHandle } from "@loom/workflow-runtime";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgAuthStore } from "../auth/pgAuthStore";
import { PgThrottle } from "../auth/pgThrottle";
import { authRoutes } from "../auth/routes";
import { buildApp } from "../config";
import { FieldCrypto } from "../crypto/fields";
import { migrate, setAppRolePassword } from "../db/migrate";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";
import { resetIngestDeps, setIngestDeps } from "../flows/ingest-document/deps";
import { pgIngestDeps } from "../flows/ingest-document/pgDeps";
import { createHttpServer } from "../server";
import { type IngestPort, loomIngest } from "./ingest";
import { DEFAULT_LIMITS } from "./limits";
import { documentRoutes } from "./routes";
import { PDF, PNG, TEXT } from "./testHarness";

const PASSWORD = "correct horse battery";

describe.skipIf(!PG_URL)("M2 acceptance: upload, list, get, delete (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;
  let server: ReturnType<typeof createHttpServer>;
  let base = "";
  let root = "";
  let loom: ReturnType<typeof buildApp> | undefined;
  const calls: string[] = [];
  const handles = new Map<string, ExecutionHandle>();

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    app = new Pool({ connectionString: db.appUrl });
    root = mkdtempSync(join(tmpdir(), "dm-e2e-"));
    const keys = new PostgresKeyStore(app, [{ id: "kek-1", key: createSecretKey(randomBytes(32)) }]);
    const store = new PgAuthStore(app);
    const authenticator = new PasswordAuthenticator(store);
    // The real stub flow on a real (in-memory) Loom app, recorded so the test can see start and cancel.
    loom = buildApp({ kind: "memory" });
    setIngestDeps(pgIngestDeps(app));
    const real = loomIngest(loom.runtime);
    const ingest: IngestPort = {
      async start(identity, documentId) {
        calls.push(`start:${documentId}`);
        const handle = await real.start(identity, documentId);
        if (handle) handles.set(documentId, handle);
        return handle;
      },
      async cancel(identity, documentId) {
        calls.push(`cancel:${documentId}`);
        await real.cancel(identity, documentId);
      },
    };
    server = createHttpServer({
      ...authRoutes({
        service: new AuthService(store),
        authenticator,
        store,
        throttle: new PgThrottle(app),
        secureCookies: false,
        trustProxy: false,
      }),
      ...documentRoutes({
        pool: app,
        authenticator,
        fields: new FieldCrypto(keys),
        blobs: ({ tenantId, userId }) => new EncryptedFsContentStore({ root, tenantId, userId, keys }),
        limits: DEFAULT_LIMITS,
        ingest,
      }),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
    resetIngestDeps();
    await loom?.close();
    await app?.end();
    await db?.drop();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  async function signUpAndLogIn(email: string): Promise<string> {
    const json = (path: string) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: PASSWORD }),
      });
    expect((await json("/api/auth/sign-up")).status).toBe(202);
    const login = await json("/api/auth/login");
    expect(login.status).toBe(200);
    return (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  }

  const upload = (cookie: string, name: string, data: Uint8Array) => {
    const form = new FormData();
    form.append("file", new Blob([data]), name);
    return fetch(`${base}/api/documents`, { method: "POST", headers: { cookie }, body: form });
  };
  const get = (cookie: string, path: string) => fetch(`${base}${path}`, { headers: { cookie } });

  it("lets two signed-up users store, list, read and delete their own documents, and no one else's", async () => {
    const ada = await signUpAndLogIn("ada@example.com");
    const grace = await signUpAndLogIn("grace@example.com");
    const secretName = "Ada private diary.txt";
    const secretText = "my very private words";

    const a1 = (await (await upload(ada, secretName, Buffer.from(`${secretText}\n`))).json()) as UploadDocumentResponse;
    const a2 = (await (await upload(ada, "scan.png", PNG("ada"))).json()) as UploadDocumentResponse;
    const g1 = await upload(grace, "report.pdf", PDF("grace"));
    expect(g1.status).toBe(201);
    const graceDoc = ((await g1.json()) as UploadDocumentResponse).document;

    // the upload started the real stub flow, with the owner's execution id and ids only
    const started = handles.get(a1.document.id);
    expect(started?.executionId).toMatch(/^u_[0-9a-f-]{36}:ingest-[0-9a-f-]{36}$/);
    const done = await started?.waitForCompletion();
    expect(done?.variables._output).toEqual({ outcome: "accepted" });
    expect(done?.status).toBe("completed");

    // list: each sees only their own
    const adaList = (await (await get(ada, "/api/documents")).json()) as ListDocumentsResponse;
    expect(adaList.items.map((d) => d.id).sort()).toEqual([a1.document.id, a2.document.id].sort());
    const graceList = (await (await get(grace, "/api/documents")).json()) as ListDocumentsResponse;
    expect(graceList.items.map((d) => d.id)).toEqual([graceDoc.id]);

    // get: own works, the other's is a plain 404
    const read = (await (await get(ada, `/api/documents/${a1.document.id}`)).json()) as DocumentDto;
    expect(read).toMatchObject({ filename: secretName, title: "Ada private diary", status: "uploaded" });
    expect((await get(ada, `/api/documents/${graceDoc.id}`)).status).toBe(404);
    expect((await fetch(`${base}/api/documents`)).status).toBe(401);

    // row-level security holds for the app role even without going through the API
    expect((await app.query("SELECT 1 FROM documents")).rowCount).toBe(0);

    // nothing readable at rest: the table, and every blob file
    const dump = await db.owner.query("SELECT row_to_json(d)::text AS j FROM documents d");
    for (const row of dump.rows) {
      expect(row.j).not.toContain("diary");
      expect(row.j).not.toContain("Ada");
    }
    const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
    expect(files.length).toBe(3);
    // file names are keyed fingerprints, never the plain sha256 of the bytes
    const plain = createHash("sha256").update(`${secretText}\n`).digest("hex");
    expect(files.map((f) => f.name)).not.toContain(plain);
    expect(dump.rows.map((r) => r.j).join("")).not.toContain(plain);
    for (const f of files) {
      expect(readFileSync(join(f.parentPath ?? f.path, f.name)).includes(secretText)).toBe(false);
    }
    const dirs = readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isDirectory());
    for (const d of dirs) expect(statSync(join(d.parentPath ?? d.path, d.name)).mode & 0o077).toBe(0);

    // delete: row and blob are gone; the other user's document is untouched
    expect((await fetch(`${base}/api/documents/${a1.document.id}`, { method: "DELETE", headers: { cookie: ada } })).status).toBe(204);
    expect(calls).toContain(`cancel:${a1.document.id}`); // the flow was cancelled first
    expect((await get(ada, `/api/documents/${a1.document.id}`)).status).toBe(404);
    const after = (await (await get(ada, "/api/documents")).json()) as ListDocumentsResponse;
    expect(after.items.map((d) => d.id)).toEqual([a2.document.id]);
    expect(readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).length).toBe(2);
    expect((await get(grace, `/api/documents/${graceDoc.id}`)).status).toBe(200);
  });
});
```

(`Dirent.parentPath` exists on Node 20.12+/22; `path` is the older name. The test reads whichever is set.)

- [ ] **Step 2: Run, gate, commit**

Run: `export DOCMIND_TEST_PG_URL=<superuser url> && pnpm --filter @docmind/server exec vitest run app/documents/documents.e2e.pg.test.ts`
Expected: PASS. (No failing-first step: this task adds no behaviour; if it fails, the fix belongs to the task whose behaviour is wrong, and a regression test goes there.)

```bash
export DOCMIND_TEST_PG_URL=<superuser url> && pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
git switch -c test/api-documents-e2e
git add apps/server/app/documents/documents.e2e.pg.test.ts
git commit -m "test(api): M2 acceptance test over real authentication

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
gh pr create --draft --title "test(api): M2 acceptance test over real authentication" --body "🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## Self-review

**1. Spec coverage**

| Spec requirement | Task |
|---|---|
| §9 item 9: `packages/blob-store`, encrypted filesystem `ContentStore`, path `<tenant>/<user>/<fingerprint>` | 43, 44, 45a, 45b, 46a, 46b |
| §3.1 "each interface has one shared conformance test suite" (ContentStore) | 45a (Loom's `runContentStoreConformance`; passes with keyed addresses, see Verified facts) |
| §4.2 `documents` columns, `status` set, `UNIQUE(tenant_id, owner_id, fingerprint)`, `_enc` columns | 47, 48, 52a (**deviation:** `stats_enc` instead of plaintext `stats jsonb`; fingerprint is keyed) |
| §4.3 RLS on every table, `docmind_app` owns nothing, raw-SQL isolation test | 47, 62 |
| §4.3 quotas: 50 MB per file, total storage cap, document-count cap, "enforced at upload" | 50, 55a, 57 |
| §4.4 blobs envelope-encrypted under the user's DEK; `*_enc` AEAD under the user's DEK; dedup within a user only | 43, 45a, 48, 55a |
| §4.4 erasure order "rows, blobs, key", each step idempotent; fingerprints die with the key | 46a (`eraseUserBlobs`), 46b (key-destroyed test), 47 (cascade), 61 (shape test) |
| §5.1 steps 1-3: size limits while streaming, magic-byte sniffing, fingerprint, duplicate returns existing | 49, 51, 55a, 57 (**deviation:** keyed HMAC fingerprint, Deviation 1) |
| §5.1 step 4: encrypt and write blob, insert `uploaded` row, **start `ingest-document` with idempotency key `documentId`** | 55a (blob and row), 53 and 54 (flow and port), 56 (start after commit) |
| §5.2 "Deleting a document cancels its flow" | 54 (cancel), 60 (cancel first, in-flight and repeated-delete tests) |
| §5.2 flow skeleton, M3 item 14 | 53 (stub) and Deviation 7: item 14 shrinks to the real steps, status projection, progress SSE and the `uploaded` sweep |
| §6.1 / §9 item 11: list, get, delete endpoints | 58, 59, 60 |
| §8 gates: integration tests when Postgres is available, no sleeps | every task's gate; Global Constraints |
| §10 "parsing untrusted files: magic-byte sniffing, size caps" | 49, 51 |
| M1 carry-forward 1 (sensitive event paths before the first user flow) | 42 (registry and rule), 53 (the first user flow: ids only, nothing to register, tests that fail when that stops being true) |
| M1 carry-forward 2 (`x:` seals/reads; child ids keep the user subject) | 42 |
| M1 carry-forward 3 (`executionIdFor` on every start/fork) | 42 ratchet; 54 is the first start and uses it |
| Standing rules: no filenames/titles/content in logs or errors, placeholders in `.env.example`, RLS via `withTenant`, draft stacked PRs ≤200 lines/10 files, gate command | Global Constraints; each task's close-out |
| `docs/design/linked-retrieval.md` not blocked | Nothing in M2 touches chunks; `documents` rows keep `title_enc`/`filename_enc` so the M3 `reference` link kind can match titles after decryption; `owner_id`-scoped rows and per-user key match the `entities.name_key` design |

No spec gap is left open: the two earlier gaps (starting the flow; plaintext `stats`) were closed by the owner's decisions, and the fingerprint wording is a recorded deviation.

**2. Placeholder scan.** No "TBD"/"TODO"/"similar to Task N". Places that deliberately tell the executor what to do on a specific, foreseeable failure, because they hinge on library behaviour the plan could not run, each stating the invariant to preserve: Task 45a optionals fallback, Task 51 `settle` ordering, Task 52b lock-order symmetry, Task 53 refusal-for-the-right-reason, Task 54 owner-policy refusal and the "No execution found" matcher, Task 56 `start` semantics, Task 60 the 500 shape. `<superuser url>` in commands is an environment value the owner supplies (Preconditions step 3), not an omission.

**3. Type consistency.** Checked across tasks: `EncryptedFsContentStore.stage` -> `StagedBlob { ref, fingerprint, commit(): Promise<{created}>, discard() }` (45a) is used with those names in 55a; `deriveFingerprintKey`/`fingerprintOf` (44) are used by 45a, 45b, the hardening tests (46b) and the harness `fingerprint()` (55a); addresses are `hmac-sha256:<64 hex>` in 44, 45a, 47 (the CHECK), 52a (tests), 52b (tests) and 55a; `BlobTooLargeError` (43) is mapped to `UploadTooLargeError` (51) in 55a; `UserFieldCipher.seal/open/openText` (48) are called as `seal(bind, value)` / `openText(bind, env)` in 52a and 55a; bind helpers `titleBind/filenameBind/summaryBind/statsBind` (52a) are the only bind strings used; `DocumentRow.stats_enc` (52a) replaces `stats` everywhere; `DocumentRow.created_cursor` (52a) feeds `encodeCursor` (59); `DocumentLimits` field names (`maxFileBytes`, `tenantMaxBytes`, `tenantMaxDocuments`, `maxConcurrentUploadsPerUser`) are identical in 50, 55a, 57 and the harness; `IngestStartInput` (53) is built only by `ingestStartInput` (54); `IngestPort { start -> ExecutionHandle | null, cancel }` (54) is what `DocumentRoutesDeps.ingest` (56) and the harness probe (56) implement and what Task 60 calls; `executionIdFor(userId, "ingest-" + documentId)` appears only inside `ingestExecutionId` (54); `lockTenantForWrite`/`usageOfTenant` (52b) are used by 55a/57/60; `Handler`/`AuthedHandler` gain `ctx` in 58 and Tasks 59/60 use `ctx.params.id`; `Registered` is first defined as a plain object (55a) and becomes a tagged union in 57 (the 57 edit lists every site that changes); `startDocumentServer`/`DocumentHarness` fields (`base, owner, app, root, keys, upload, fingerprint, close` from 55a, `ingest` from 56, `inFlight` from 57) match every use in 55b-61.

---

## Decisions (owner, 2026-10-18)

The owner answered the plan's eight open questions. Each decision is applied in the tasks named.

1. **M2 starts the ingestion flow on upload** (spec §5.1 step 4). A stub `ingest-document` Loom flow exists in M2 (Task 53), started after the upload transaction commits (Task 56) with idempotency key = documentId (realised as the caller-chosen execution id, `executionIdFor(userId, "ingest-" + documentId)`, which Loom starts once; Task 54), and a start input of ids only (`{ tenantId, userId, documentId }`, strict). Its only step, `ingest-begin`, confirms the document still exists and writes nothing, so status stays `uploaded`. Because a real flow now runs, Task 42's sensitive-path registry is extended by rule and Task 53 proves that this flow needs no registered paths (ids in, two-value enum out) with tests that fail if a content-bearing field is added. **Reconciliation with the spec's M3 item 14:** M2 now owns flow registration, grants, start-after-commit, the id/idempotency convention, cancel-on-delete and the "document gone" stop; M3 item 14 shrinks to replacing `ingest-begin` with the §5.2 step skeleton (parse...finalize, empty bodies), the status projection, the progress SSE, and a sweep for documents stuck in `uploaded` (see Deviation 7).
2. **Quotas accepted:** 50 MiB per file; 1 GiB and 500 documents per tenant; 2 concurrent uploads per user; every one overridable through the environment (Tasks 50 and 57).
3. **busker -> `busboy` ^1.6.0 accepted** (Task 51; hand-written multipart parsing rejected as the place untrusted-input bugs live).
4. **Delete cancels the flow first.** `DELETE /api/documents/:id` cancels the document's ingest execution (`runtime.cancel(executionId, reason, { principal })`, Task 54), then hard-deletes the row and blob under the tenant lock (Task 60); a flow step that finds its document gone ends with outcome `document_gone` (Task 53). Tests: delete during an in-flight flow, a failed cancel that leaves everything intact, a repeated delete (Task 60); the upload/delete race (Task 61).
5. **The plaintext sha256 fingerprint is replaced by a keyed hash.** fingerprint = HMAC-SHA256 over the file bytes, keyed by an HKDF-SHA256 derivation of the user's DEK with the fixed label `docmind-fingerprint-v1`. Justification (Deviation 1): `KeyStore.getOrCreate` already exposes the raw DEK, so no extra key, table or destroy step is needed, and destroying the DEK destroys the fingerprint key, so fingerprints cannot be tested after erasure. It is used for `documents.fingerprint`, `content_address` (`hmac-sha256:<hex>`) and the blob path `<tenant>/<user>/<fingerprint>` (Tasks 44, 45a, 47, 55a). Dedup stays per user. `EncryptedFsContentStore` computes the keyed address itself; Loom's conformance kit only compares addresses with each other, so it still passes (Task 45a). **This is an intentional deviation from spec §5.1 step 3 and §4.1 ("sha256 fingerprint", path `<sha256>`).**
6. **Stats are encrypted now:** the `documents` migration has `stats_enc` (jsonb envelope under the user's DEK, same `FieldCrypto` as the other `*_enc` columns) instead of plaintext `stats jsonb` (Tasks 47, 52). `error` stays plaintext with fixed, non-content messages only.
7. **`DOCMIND_BLOB_DIR`, default `./data/blobs`, git-ignored:** accepted (Task 50; docker-compose untouched in M2).
8. **CSRF:** rely on the `SameSite=Lax` session cookie, no token, no CORS: accepted for v1; revisit if the platform ever sets `SameSite=None`.
