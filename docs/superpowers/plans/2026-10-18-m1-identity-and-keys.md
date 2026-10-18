# DocMind M1 (Identity and keys) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After M1, a user can sign up, log in and log out over HTTP with an argon2id password and an HTTP-only session cookie, behind an `Authenticator` interface that every request passes through; sign-up does not reveal which emails are registered, and login and sign-up are rate limited per client address and per email; every user has a data key held by a Postgres key store that passes Loom's KeyStore contract, and the master key that wraps them can be rotated with a resumable tool; and Loom's event log and snapshots live in Postgres, encrypted per user with that key store, so destroying a user's key makes their sealed snapshots and principal fields unreadable. Event payloads are sealed only once M2 registers its sensitive event paths (`sensitive: {}` in M1).

**Architecture:** `packages/auth` holds the `Authenticator` interface, its conformance suite and the password/session logic over an `AuthStore` interface (an in-memory store for unit tests); the server implements `AuthStore` on Postgres through `SECURITY DEFINER` functions for the steps that happen before a tenant is known, and mounts the routes behind a `requireAuth` middleware on a router that turns every handler failure into a 500. Sign-up always answers the same `202` and starts no session; login and sign-up go through a Postgres-backed `Throttle` (exponential, time-boxed locks keyed by client address and by a hash of the email). `packages/keystore-pg` implements Loom's `KeyStore` (`@loom/plugin-crypto`) with one random data key per user, wrapped by a master key (KEK) from the environment and reachable only through `SECURITY DEFINER` functions; a rotation command re-wraps every key to a new KEK, as the owner role, never exposing a data key. Loom's Postgres stores migrate themselves, so they get their own role (`docmind_loom`) and schema (`loom`); `apps/server` wraps them in `EncryptingEventStore` and `EncryptingSnapshotStore` (whole-state sealing), keyed by the owning user.

**Tech Stack:** everything in M0, plus `argon2` ^0.45.1 (node-argon2, prebuilt binaries), `zod` ^3.23.8 in the server, and the Loom packages `@loom/plugin-crypto`, `@loom/plugin-postgres` and (tests) `@loom/conformance`, all linked from `../loom` at commit `8f9eab2492c85bb994d746855f06d2eccc9f45db`.

**Spec:** `/Users/such/workspace/docmind/docs/specs/2026-10-18-docmind-design.md` (§3.1 interfaces, §4.2 tables, §4.3 tenancy, §4.4 crypto-shredding, §8 gates and PR rules, §9 M1 = items 5-8). M0 plan: `/Users/such/workspace/docmind/docs/superpowers/plans/2026-10-18-m0-foundations.md`. Executors read all three.

## Global Constraints

Copied from the spec and the owner's standing rules; every task includes them.

- **PR size:** at most **200 changed lines and 10 files** per PR. `pnpm-lock.yaml`, the generated `apps/server/app/loom.gen.ts` and binary fixtures do not count but are listed in the PR description. A PR that cannot fit is split, never stretched. Measure with the command in each PR's close-out.
- **PR rules:** each PR leaves `main` green with no half-built reachable path; tests ship in the same PR as the code; branch names `feat/<area>-<thing>`; Conventional Commits; every PR is opened as a **draft** (`gh pr create --draft`), gets an independent code review, and the owner merges it with **rebase and merge** (`gh pr merge --rebase`). Executors never merge.
- **Commit trailer:** every commit ends with the line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Every PR description ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **The local gate is the merge gate** (GitHub Actions has never run: the account is blocked by billing, so `LOOM_TOKEN` and the pgvector CI service are unproven): `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`, with `DOCMIND_TEST_PG_URL` exported so the Postgres suites run instead of skipping.
- **CI (when billing is restored):** triggers `pull_request: [opened, synchronize, reopened, ready_for_review]` and pushes to `main`; every PR job is gated on `github.event.pull_request.draft == false`.
- **Test hygiene (Loom's AGENTS.md):** no sleeps (wait on conditions); test servers bind `127.0.0.1`; no timing assertions in `*.test.ts`; test files are typechecked (`typecheck:tests`).
- **Tenancy:** the app connects as a **non-owner role** with no `BYPASSRLS`; RLS checks `tenant_id` against a transaction-local setting; nothing downstream accepts a tenant id from the client; the `Authenticator` produces `{tenantId, userId}` on every request.
- **Passwords:** hashed with argon2id (spec §4.2). Only a hash of the session cookie token is stored (spec §4.2).
- **No account enumeration through sign-up:** the sign-up response (status, headers, body) is identical whether or not the email is registered, and both paths do the same work (argon2 hash, then one database call). Login answers the same 401 for a wrong password and an unknown email.
- **Throttling:** login and sign-up are throttled per client address and per email (hash); locks are time-boxed and exponential, never permanent; a throttled request is `429` with `Retry-After` and says nothing about whether the account exists; proxy headers are not trusted unless `DOCMIND_TRUST_PROXY=true`.
- **Keys (spec §4.4):** each user has their own data key; `PostgresKeyStore` stores each DEK wrapped by a master KEK identified by `kek_id`; the KEK comes from an env var or file in v1; `destroy` is irreversible. No code path logs, returns or prints a plaintext data key.
- **Migrations:** never edit an applied migration; add a new numbered file in `infra/migrations/` (next free number at plan time is `0004`; this plan uses 0004-0008). Every table has row-level security enabled (the M0 guard test fails otherwise).
- **`SECURITY DEFINER` functions** (carried from the M0 review): each one has `SET search_path = pg_catalog, pg_temp`, schema-qualifies every object it touches, and has an explicit `REVOKE ALL ... FROM PUBLIC` and `GRANT EXECUTE ... TO docmind_app` (migration 0001 revokes PUBLIC execute by default).
- **Dependency rules:** packages never import from apps; only `loom.config.ts`/`app/config.ts`/`app/main.ts` choose implementations.
- **Toolchain pins:** `pnpm@9.14.4`, `@biomejs/biome` `1.9.4` (exact), `typescript` `^5.6.3`, `vitest` `^2.1.8`, Node `>=20.0.0`.

---

## Verified facts this plan relies on

Checked on this machine on 2026-10-18. The code in this plan was built and run: the 29 PR branches were replayed one after another from `main` (`0d37c50`) in a scratch checkout, and the full gate (`build`, `typecheck`, `typecheck:tests`, `lint`, `test`) was green on every one under `pnpm@9.14.4`, with the Postgres suites running against a local Postgres 17 cluster (superuser URL; `docker` is not installed here, so compose was not used). The line counts in the PR index are measured from those replays.

### Loom APIs used (real names, from the checkout at `/Users/such/workspace/loom`, HEAD `8f9eab24`)

| Need | Real export | Where |
|---|---|---|
| KeyStore interface | `KeyStore { getOrCreate(subjectId): Promise<Buffer>; get(subjectId): Promise<Buffer \| null>; destroy(subjectId): Promise<void>; wasDestroyed?(subjectId): Promise<boolean>; readonly durable?: boolean }` from `@loom/plugin-crypto`. Keys are 32-byte `Buffer`s. After `destroy`, `getOrCreate` MUST NOT mint a new key. | `plugins/crypto/src/keystore.ts`, re-exported by `plugins/crypto/src/index.ts` |
| KeyStore contract suite | `runKeyStoreConformance(factory: () => KeyStoreLike, label?)` from `@loom/conformance` (ESM-only package; registers vitest `describe`/`it`). 8 tests: durable is a boolean, stable key, distinct subjects, get before/after create, destroy, never resurrected, idempotent destroy, `wasDestroyed`. | `packages/conformance/src/index.ts:2913` |
| Reference KeyStore | `InMemoryKeyStore` (`durable = false`, tombstone set) | `plugins/crypto/src/keystore.ts` |
| Event-log encryption | `new EncryptingEventStore(inner: EventStore, keys: KeyStore, { sensitive: Record<eventType, string[]>, subjectOf?: (e: Pick<EventEnvelope,"executionId"\|"workflowId">) => string, onShredded?: "throw"\|"tolerate", ivSource? })`; `registerSensitive(eventType, paths)`; a read after a shred throws `PayloadShreddedError`. `subjectOf` defaults to `executionId`. | `plugins/crypto/src/EncryptingEventStore.ts:143`, `:169` |
| Snapshot encryption | `new EncryptingSnapshotStore(inner: SnapshotStore, keys: KeyStore, { sealState: true, subjectOf?, events?: EventStore, legacyPlaintext?, ... })`. `sealState: true` seals the whole folded state; `subjectOf` takes `{executionId, workflowId}`. | `plugins/crypto/src/EncryptingSnapshotStore.ts:124`, `:139` |
| Erasure primitive | `shredSubject(keys, rawEventStore, executionId, { subjectId?, executionIds?, snapshotStore?, reason?, force? })`: writes an erase intent, calls `keys.destroy(subject)`, then a `PAYLOAD_SHREDDED` tombstone per execution; idempotent. M5 calls it; M1 only proves it works against our stores. | `plugins/crypto/src/shred.ts:188` |
| Postgres stores | `postgresStorage({ url: PgConfig, branching?, ... })` returns `{ kind: "custom", eventStore, snapshotStore, leaseStore }`. `PgConfig = string \| PoolConfig \| Pool`. The event store **creates and migrates its own tables at boot** (`CREATE TABLE IF NOT EXISTS events, snapshots, refs, lineage, fences, timers, leases, durable_state, read_model_rows, memory_entries ...`, a `SECURITY DEFINER` trigger function, `CREATE INDEX`), unqualified, in the connection's `search_path` schema. | `plugins/postgres/src/preset.ts`, `schema.ts`, `PostgresEventStore.ts`; `MAX_EXECUTION_ID_BYTES = 1024` (`PostgresEventStore.ts:37`) |
| Composition | `defineConfig({ storage: { kind: "custom", eventStore, snapshotStore, leaseStore? }, security: { strict, crypto?: PrincipalCryptoOptions, principalCodec?, ... } })`. With `crypto` composed, the principal's identity is recorded encrypted and no `principalCodec` is needed under `strict`; `PrincipalCryptoOptions = { events: SensitivePathRegistry, snapshots?: SensitiveSnapshotRegistry, allowPlaintextCheckpoints? }`. `StorageConfig` and `PrincipalCryptoOptions` are exported from `@loom/app`. The kernel refuses a non-sealing snapshot store beside a sealing event store. | `packages/app/src/defineConfig.ts:140`, `:285`; `packages/app/src/principalPolicy.ts:31`; `packages/app/src/index.ts` |
| Compliance wiring (M5, not M1) | `security.compliance: { subjectOf: SubjectResolver /* (event: EventEnvelope) => string \| undefined */, tenantOf?, erase?: { shred, destroyed? } }`, `app.eraseSubject(subjectId, tenant, options)`. | `packages/app/src/defineConfig.ts:290-325`, `packages/compliance/src/SubjectIndex.ts:26` |

### Loom does not have

- **An `Authenticator`.** `grep` finds no such interface in `packages/` or `plugins/`. The nearest thing is conversation-sse's option `authenticate?: (req: http.IncomingMessage) => PrincipalChain \| undefined \| Promise<PrincipalChain \| undefined>` (`plugins/conversation-sse/src/server.ts:75`). DocMind defines its own `Authenticator` (spec §3.1); M4's SSE proxy adapts an `Identity` to a `PrincipalChain`.
- **A way to give `EncryptingEventStore` the owning user.** `subjectOf` sees only `{executionId, workflowId}`, never a payload or principal. A per-user key therefore needs the user id **inside the execution id**; PR 8b fixes that convention (`u_<userId>:<name>`) and everything that starts an execution for a user must use it.

### Findings from building this plan (each is why a task looks the way it does)

| Finding | Consequence |
|---|---|
| Loom's Postgres stores run DDL at boot, so they cannot connect as `docmind_app` (which owns nothing). Run as a role that **owns a dedicated schema** with `options: "-c search_path=loom"`, they work: spiked against Postgres 17, all 11 tables landed in `loom`, and an encrypting wrapper round-tripped. | PR 8a adds the `docmind_loom` role and `loom` schema; the M0 "RLS on every table" guard only looks at `public`, so Loom's tables do not trip it. |
| `@loom/conformance` is ESM with extensionless relative imports. Node's native ESM cannot load it, so it must be **inlined by Vite**; and the server's `external: [/@loom\//]` rule would externalize it. | PR 7b adds `server.deps.inline` for it in `apps/server/vitest.config.ts`. |
| A package's `testing` kit that imports `vitest` cannot be `require()`d from the CommonJS build ("Vitest cannot be imported in a CommonJS module"). | `packages/auth` exposes it as a subpath (`@docmind/auth/testing`) and the server's vitest config aliases that subpath to the TypeScript source (PR 6f). Type checking still uses `testing.d.ts`. |
| `node-argon2` and Postgres make a rate limiter easy to get subtly wrong, so one suite (`runThrottleConformance`, `packages/auth/src/throttleConformance.ts`) pins the behaviour and runs on both the in-memory and the Postgres throttle; time is moved by shifting stored timestamps, never by sleeping. | The two implementations cannot drift apart; route tests use the in-memory one with a fixed clock. |
| Node `server.close()` waits for keep-alive sockets that go idle **after** the call; they are not closed for you. | `shutdown()` (PR 5d) sweeps idle connections until the server is down. |
| `node-argon2` writes parameters as `m=...,p=...,t=...` (not `m,t,p`). | The password test asserts that order. |
| Calling `auth_sign_up` with a tenant id that already exists is a primary-key error, not "email taken". | Only matters for tests that reuse a tenant id; production generates both ids per call. |
| `process.env` set in one shell command does not reach the next. | Every gate block below exports `DOCMIND_TEST_PG_URL` in the same command. |

## Deviations from the spec, decisions, and what is still open

Decided here so executors are not blocked. Items 2, 8, 9 and 10 carry the owner's answers to the four questions that were open in the first version of this plan.

1. **29 PRs, not 4.** The spec's items 5-8 do not fit 200 lines each: item 5 becomes PRs 5a-5d, item 6 becomes 6a-6n, item 7 becomes 7a-7g, item 8 becomes 8a-8d. The first async handler (`requireAuth`) lands in 5d, so the router fix the M0 review asked for ("first async route") lands in 5c, one PR before it, with `shutdown` ordering and the contracts dependency.
2. **Auth API paths are not in the spec.** Chosen: `POST /api/auth/sign-up`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/me` (the contracts' `MeResponse` already names `GET /api/me`; `DELETE /api/me` is M5). **Sign-up answers `202 {"status":"accepted"}` with no cookie, always** (decision 9 below); login answers 200 with `MeResponse` and the session cookie; logout 204 and always clears the cookie; bad credentials are 401 `invalid_credentials`, identical for a wrong password and an unknown email; a throttled request is 429 `too_many_requests` with `Retry-After`.
3. **`AuthStore` is a new interface** in `packages/auth` (spec §3.1 lists only `Authenticator`). It exists so the password and session logic is unit-tested without a database and the Postgres implementation lives in the server, where `withTenant` is. `Authenticator.authenticate` takes `Pick<IncomingMessage, "headers">`, not a whole request, and is async. `Throttle` is likewise an interface with an in-memory and a Postgres implementation that pass one shared suite.
4. **`data_keys` differs from spec §4.2/§4.4.** (a) `destroy` does not delete the row: it nulls `wrapped_dek` and `kek_id` and sets `destroyed_at`, because Loom's contract requires `getOrCreate` to refuse a destroyed subject and `wasDestroyed` to prove it; a deleted row would let a retry mint a fresh key. The row holds no key material afterwards. (b) No `tenant_id` column and no tenant policy: Loom calls the key store outside any tenant context, so the table has RLS **enabled with no policy** and **no privileges for `docmind_app`**; the only way in is four `SECURITY DEFINER` functions (`key_get`, `key_put`, `key_destroy`, `key_was_destroyed`). A compromised app can still ask for a key by subject id, but cannot dump the table or overwrite a key. `auth_throttle` (migration 0006) follows the same pattern.
5. **Loom gets its own role and schema** (`docmind_loom`, schema `loom`; migration 0008), because its stores run DDL. `docmind_app` has no privilege on `loom` and `docmind_loom` none on `public`. The server asserts both roles are unprivileged at startup. Requires Postgres 15+ (the compose image is `pg16`) so `public` is not creatable by everyone.
6. **Per-user subject convention: `u_<userId>:<name>`.** One user, one key, across every execution they own, so erasing a user (M5) destroys one key. An execution id that does not match falls back to the subject `x:<executionId>`, which is right for system work. Mistakes here are silent (data under the wrong key), so the mapping has its own tests and `executionIdFor` is the only way to build ids.
7. **Memory vs durable app.** `loom.config.ts` (what the `loom` CLI loads) stays in-memory so `loom gen` needs no database; `app/main.ts` builds the durable, encrypted app with `buildApp(storage, crypto)`. In memory mode the M0 `principalCodec` stays; in durable mode `security.crypto` replaces it.
8. **Rate limiting and lockout (owner decision; PRs 6h-6k, applied in 6k-6l, wired in 6n).**
   - *What is limited:* login and sign-up, each **per client address and per email**. The email is keyed by its sha256 whether or not the account exists, so a throttled answer and its timing say nothing about existence (tested: a locked real email and a locked unknown email get byte-identical 429s).
   - *Backoff, not a permanent lock:* login allows 5 free failures per email and 20 per address; each further failure locks that key for `base * 2^(n - free - 1)` seconds (2 s for an email, 5 s for an address, doubling) capped at **15 minutes**; sign-up counts every attempt (5 free per address, 3 per email, then 60 s doubling to 1 hour). A key left alone for an hour (two for sign-up) starts again from zero, and a successful login clears the email's count. Every lock is time-boxed, so waiting it out is always enough.
   - *Storage:* Postgres (`auth_throttle`, migration 0006), so counters survive restarts and are shared by every server instance; reached only through `SECURITY DEFINER` functions (RLS on, no policy, no privilege for `docmind_app`, like `data_keys`); counters are purged a day after last use. An in-process map was rejected: each instance would have its own allowance and a deploy would reset it.
   - *Client address:* the socket's peer address. `X-Forwarded-For` is **not** believed unless `DOCMIND_TRUST_PROXY=true`, which means "exactly one reverse proxy of mine in front, which appends the address it saw; use the last entry". Otherwise a client could invent a new address per guess.
   - *Residual risks, honestly:* (a) an attacker who keeps guessing at one email can hold that email in its 15-minute lock, which delays that user's login attempts but never blocks them for good; a per-email lock that also asked "has this browser logged in before" would reduce it and is not built. (b) An attacker with many addresses is limited by the per-email counter only. (c) IPv6 clients are keyed per /64, so one attacker holding a whole /64 shares one counter, but one with several /64s still gets a counter for each. (d) Argon2id's cost (about 25 ms here) is itself a limit on how fast a single instance answers.
9. **Sign-up does not reveal whether an email is registered (owner decision; PR 6k).** Design: sign-up never sets a session and always answers `202 {"status":"accepted"}` with identical headers; both paths hash the password with argon2id before one database call, so the work is comparable; the client then logs in. A test asserts the two responses are byte-identical (the `Date` header aside), and that a taken email's password is never changed. **Residual enumeration channel:** sign-up then login still tells an attacker whether an email was registered (login with the password just submitted works for a new email, fails for a taken one), at the cost of two requests and a throwaway account per probe. The sign-up and login rate limits (decision 8) make large-scale probing slow; **email verification would close the channel** (the account is only usable once the owner confirms, so the response cannot depend on whether the email was new) and is left for when the platform has email infrastructure.
10. **KEK rotation (owner decision; PRs 7d-7g).** `pnpm --filter @docmind/server keys:rotate` re-wraps every live `data_keys` row from the previous KEK to the current one as the owner role: atomic batches, idempotent, resumable after a crash, tombstones untouched, data keys unchanged and never printed or returned; it then verifies every key opens with the new KEK alone and exits non-zero if any key failed to open or is on a KEK nobody provided. Steps are in `docs/operations/rotate-kek.md` (delivered in 7g). Trade-offs: rotation does not change data keys, so it does not help if a data key itself leaked (re-encryption is not built); the old KEK must be kept until database backups taken before the rotation expire (30 days by default, spec §4.4); `PostgresKeyStore` and `loadKeks` support one current and one previous KEK at a time.
11. **Carried to M5 (`DELETE /api/me`):** `docmind_app` cannot insert or delete `tenants` (migration 0003), so erasure needs a new `SECURITY DEFINER` function to hard-delete the tenant; `security.compliance.subjectOf` must resolve an event to the same user id that `subjectOfExecution` yields (read `input.userId`, or parse the execution id), and `tenantOf` must return the tenant; `shredSubject` needs `createDurableStorage(...).raw` (the unwrapped stores), which PR 8c already returns. The `data_keys` tombstone for an erased user stays (it holds a user id and no key material).
12. **Carried to M4:** conversation-sse runs its own HTTP server; its `authenticate` callback must adapt `Authenticator` (an `Identity` becomes a `PrincipalChain` with `tenant` and `actor`). `chat_sessions.id` is a Loom conversation id, which must be built with `executionIdFor(userId, ...)` or the chat is encrypted under the wrong key.
13. **CI is still unproven** (billing). When it is restored the first push to `main` must be watched: it exercises `LOOM_TOKEN`, building `@loom/conformance`, `@loom/plugin-crypto` and `@loom/plugin-postgres` in the Loom checkout, and the superuser `postgres` role the Postgres suites need.
14. **Not in M1, by design:** password change or reset, email verification, account deletion (M5), the `documents`/`chunks`/`chat_sessions` tables, sign-up UI (M6).

**Still unresolved (for the owner, none blocks M1):** (a) whether the thresholds in decision 8 suit real use (they are constants in `packages/auth/src/throttle.ts`); (b) whether to harden against the email-lock residual (8a) or an attacker rotating across /64s (8c) before launch; (c) whether the hourly purge cadence and the one-day retention of throttle rows are acceptable for the privacy notice (they hold addresses); (d) an automated re-encryption story for a leaked data key (out of scope here).

M2 must register sensitive event paths before its first user flow, and add a test that an `x:` execution seals and reads, and that Loom child ids (`<parent>::<key>`) keep the user subject.

## Decision D1 (decided by the owner; applies from M2 / `apps/web`; NOT an M1 task)

**`apps/web` (Vite) consumes `@docmind/contracts` through a Vite `resolve.alias` to its TypeScript source** (`@docmind/contracts` maps to `packages/contracts/src/index.ts`), exactly as spec §7 already aliases `@loom/*` and `@loom-ui/*`. `packages/contracts` stays CommonJS with no `exports` map: the server keeps consuming `dist`, and no ESM build is added. Consequences the M2/M6 plans must honour: contracts source stays free of Node-only imports (today only `zod`); the web app typechecks that source under its own tsconfig; if a consumer outside the workspace ever appears, revisit (an ESM build with an `exports` map is then a one-file change plus a test importing both entry points, and is the same moment to publish `@loom/*`, see the loom-repo-topology note). The M2 plan header and M6 PR 36 (web scaffold: aliases, router, tokens) record this; there is no longer an open question here.

## Preconditions (once, before PR 5a)

- [ ] **Step 1: Confirm M0 is on `main` and the tree is clean**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git status --short && git log --oneline -1
```

Expected: no output from `status`, and the last commit is `0d37c50` or a descendant (M0 PRs #3-#13 merged).

- [ ] **Step 2: Confirm the Loom checkout has what M1 links to, built**

```bash
git -C /Users/such/workspace/loom rev-parse HEAD
command ls /Users/such/workspace/loom/plugins/crypto/dist/index.js \
  /Users/such/workspace/loom/plugins/postgres/dist/index.js \
  /Users/such/workspace/loom/packages/conformance/dist/index.js
```

Expected: `8f9eab2492c85bb994d746855f06d2eccc9f45db` (or a descendant) and the three files listed. If any is missing, run `pnpm install && pnpm build` in `/Users/such/workspace/loom`.

- [ ] **Step 3: Toolchain**

```bash
node -v && corepack enable && corepack prepare pnpm@9.14.4 --activate && pnpm -v
```

Expected: Node 20 or newer, then `9.14.4`.

- [ ] **Step 4: A Postgres whose URL role is a superuser**

The Postgres suites create and drop a database per suite and flip role attributes, which needs `SUPERUSER`. Either `docker compose up -d postgres` (user `docmind`, which the image makes a superuser) or any local cluster:

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
```

Every gate block below repeats the `export` because shell state does not persist between commands.

## PR index

Merge strictly in this order; cut each branch from `main` after the previous PR has merged (`git switch main && git pull --ff-only`). Lines are measured with the size command in each close-out (replayed in a scratch checkout); re-measure on your branch.

| # | Branch | Delivers | Files | Lines (measured) |
|---|---|---|---|---|
| 5a | `feat/m1-auth-interface` | `packages/auth`: `Authenticator`, `Identity`, conformance suite | 10 | 153 |
| 5b | `feat/m1-contracts-types` | same-named `export type` for `Uuid`, `IsoDateTime`, `Cursor`, `Email` | 3 | 15 |
| 5c | `feat/m1-router-errors` | router answers 500 for rejected/throwing handlers; `sendError`; contracts dependency | 4 | 99 |
| 5d | `feat/m1-require-auth` | `requireAuth` middleware; `shutdown` closes server then app | 6 | 154 |
| 6a | `feat/m1-auth-sql` | session indexes (0004); `SECURITY DEFINER` auth functions (0005) | 3 | 157 |
| 6b | `feat/m1-auth-password` | argon2id hashing, decoy check, session tokens | 6 | 97 |
| 6c | `feat/m1-auth-store` | `AuthStore`, `MemoryAuthStore`, session cookie helpers | 7 | 164 |
| 6d | `feat/m1-auth-authenticator` | `PasswordAuthenticator` passing the conformance suite | 3 | 77 |
| 6e | `feat/m1-auth-service` | `AuthService`: sign-up (no session), login, logout | 3 | 113 |
| 6f | `feat/m1-auth-pg-store` | `PgAuthStore` on Postgres | 3 | 191 |
| 6g | `feat/m1-http-body` | `readJson` (JSON-only, size-limited, zod-validated) | 3 | 121 |
| 6h | `feat/m1-throttle` | `Throttle` interface, policies, `clientIp` | 5 | 129 |
| 6i | `feat/m1-throttle-memory` | `MemoryThrottle` and the Throttle conformance suite | 4 | 139 |
| 6j | `feat/m1-throttle-sql` | `auth_throttle` (0006) behind definer functions; `PgThrottle` | 3 | 159 |
| 6k | `feat/m1-signup-route` | `POST /api/auth/sign-up`: uniform 202, throttled; `SignUpResponse` | 4 | 175 |
| 6l | `feat/m1-login-route` | `POST /api/auth/login`, throttled | 2 | 106 |
| 6m | `feat/m1-auth-session-routes` | logout, `GET /api/me` | 2 | 76 |
| 6n | `feat/m1-auth-wiring` | startup role assertion, `createAppPool`, `main.ts` serves the routes | 4 | 146 |
| 7a | `feat/m1-keystore-primitives` | `packages/keystore-pg`: KEK loading, AES-GCM key wrapping | 8 | 138 |
| 7b | `feat/m1-keystore-pg` | `data_keys` (0007) and `PostgresKeyStore` passing Loom's KeyStore contract | 8 | 196 |
| 7c | `feat/m1-keystore-pg-security` | key store security tests (restart, race, tombstone, tamper, rotation, privileges) | 1 | 76 |
| 7d | `feat/m1-kek-previous` | `loadKeks`: current and previous KEK | 3 | 60 |
| 7e | `feat/m1-kek-rotate` | `rotateKek`, `verifyKeys` and their tests | 3 | 187 |
| 7f | `feat/m1-kek-rotate-failures` | rotation crash-recovery and bad-row tests | 1 | 48 |
| 7g | `feat/m1-kek-rotate-cli` | `keys:rotate` command, runbook, `.env.example` | 5 | 148 |
| 8a | `feat/m1-loom-role` | `docmind_loom` role and `loom` schema (0008), password CLI | 4 | 100 |
| 8b | `feat/m1-erasure-subject` | `executionIdFor`, `subjectOfExecution` | 2 | 43 |
| 8c | `feat/m1-durable-storage` | Postgres event store and snapshots wrapped by the encrypting stores | 4 | 184 |
| 8d | `feat/m1-durable-app` | `buildApp` in `config.ts`; `main.ts` serves the encrypted, durable app | 6 | 118 |

Plus `pnpm-lock.yaml` on 5a, 5c, 5d, 6b, 6g, 7a, 7b and 8c (excluded from the budget, listed in each description). No route is reachable before PR 6n, and every route is throttled (sign-up, login) or authenticated (me) from the PR that adds it.

**Independent PRs** (could be built in parallel branches, still merged in order): 5a/5b, 6a, 6h/6i, 7a, 8a.

---
# PR 5a: `packages/auth` and the Authenticator contract

**Branch:** `feat/m1-auth-interface`  **Budget:** 10 files, 153 lines (+ `pnpm-lock.yaml`). Spec §9 item 5, part 1 of 3.

### Task 13: `Authenticator` interface and its conformance suite

**Files:**
- Create: `/Users/such/workspace/docmind/packages/auth/package.json`, `tsconfig.json`, `tsconfig.test.json`, `testing.js`, `testing.d.ts`
- Create: `/Users/such/workspace/docmind/packages/auth/src/authenticator.ts`, `conformance.ts`, `testing.ts`, `index.ts`
- Test: `/Users/such/workspace/docmind/packages/auth/src/conformance.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (from `@docmind/auth`): `interface Identity { tenantId: string; userId: string }`; `type AuthRequest = Pick<IncomingMessage, "headers">`; `interface Authenticator { authenticate(req: AuthRequest): Promise<Identity | null> }`. Contract: resolve `null` for any request that is not authenticated; reject only when the check itself could not run.
- Produces (from `@docmind/auth/testing`): `interface AuthenticatorHarness { authenticator: Authenticator; issue(identity: Identity): Promise<IncomingHttpHeaders>; revoke(headers: IncomingHttpHeaders): Promise<void>; forged(): IncomingHttpHeaders }` and `runAuthenticatorConformance(make: () => AuthenticatorHarness | Promise<AuthenticatorHarness>, label?: string): void`.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m1-auth-interface
```

- [ ] **Step 2: Scaffold the package**

`packages/auth/package.json` (vitest is a peer: the conformance suite registers vitest tests, as Loom's own `@loom/conformance` does):

```json
{
  "name": "@docmind/auth",
  "version": "0.0.0",
  "private": true,
  "description": "The Authenticator interface, its conformance suite, and the password/session implementation.",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "typecheck:tests": "tsc -p tsconfig.test.json"
  },
  "peerDependencies": {
    "vitest": ">=2"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "vitest": "^2.1.8"
  }
}
```

`packages/auth/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "types": ["node"] },
  "include": ["src"],
  "exclude": ["**/*.test.ts", "dist"]
}
```

`packages/auth/tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src"],
  "exclude": ["dist"]
}
```

`packages/auth/testing.js` and `packages/auth/testing.d.ts` (a subpath at the package root, the layout `@loom/plugin-crypto/testing` uses, because the CommonJS build and `moduleResolution: Node` ignore `exports` maps):

```js
// Subpath entry for test support: the conformance suite imports vitest, so the main entry must not.
module.exports = require("./dist/testing");
```

```ts
export * from "./dist/testing";
```

- [ ] **Step 3: Write the failing test**

The suite is the product here; its test runs it against the smallest authenticator that can pass (a bearer-token map), which proves the suite accepts a correct implementation. `packages/auth/src/conformance.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { Authenticator, Identity } from "./authenticator";
import { type AuthenticatorHarness, runAuthenticatorConformance } from "./conformance";

/** A bearer-token authenticator over a Map: the smallest thing that can pass the suite. */
function bearerHarness(): AuthenticatorHarness {
  const tokens = new Map<string, Identity>();
  const authenticator: Authenticator = {
    async authenticate(req) {
      const token = req.headers.authorization?.replace(/^Bearer /, "");
      return (token && tokens.get(token)) || null;
    },
  };
  return {
    authenticator,
    async issue(identity) {
      const token = randomUUID();
      tokens.set(token, identity);
      return { authorization: `Bearer ${token}` };
    },
    async revoke(headers: IncomingHttpHeaders) {
      tokens.delete(String(headers.authorization).replace(/^Bearer /, ""));
    },
    forged: () => ({ authorization: `Bearer ${randomUUID()}` }),
  };
}

runAuthenticatorConformance(bearerHarness, "bearer-token stub");
```

- [ ] **Step 4: Run it to see it fail**

```bash
pnpm install
pnpm --filter @docmind/auth test
```

Expected: FAIL, `Failed to resolve import "./conformance" from "src/conformance.test.ts". Does the file exist?`

- [ ] **Step 5: Write the interface, the suite and the entry points**

`packages/auth/src/authenticator.ts`:

```ts
import type { IncomingMessage } from "node:http";

/** Who a request is from. Both ids come from the server's own records, never from the client. */
export interface Identity {
  tenantId: string;
  userId: string;
}

/** The only part of a request an Authenticator may read. */
export type AuthRequest = Pick<IncomingMessage, "headers">;

/**
 * Turns a request into an Identity. The password/session implementation is the v1 one; AetherOS
 * platform identity replaces it later without touching a route.
 *
 * Contract: resolve `null` for any request that is not authenticated (no credential, a forged or
 * expired or revoked one, garbage). Reject only when the check itself could not run (database
 * down); the router turns that into a 500, never into a 401 and never into access.
 */
export interface Authenticator {
  authenticate(req: AuthRequest): Promise<Identity | null>;
}
```

`packages/auth/src/conformance.ts`:

```ts
import type { IncomingHttpHeaders } from "node:http";
import { describe, expect, it } from "vitest";
import type { Authenticator, Identity } from "./authenticator";

/** What the suite needs from an implementation, since credentials differ per implementation. */
export interface AuthenticatorHarness {
  authenticator: Authenticator;
  /** Makes `identity` a valid caller and returns the request headers that carry its credential. */
  issue(identity: Identity): Promise<IncomingHttpHeaders>;
  /** Invalidates a credential `issue` returned (logout, expiry, revocation). */
  revoke(headers: IncomingHttpHeaders): Promise<void>;
  /** Headers shaped like a credential of this implementation that was never issued. */
  forged(): IncomingHttpHeaders;
}

const ALICE: Identity = {
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  userId: "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1",
};
const BOB: Identity = {
  tenantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  userId: "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1",
};

/** The suite every Authenticator implementation must pass. Call it from the implementation's test. */
export function runAuthenticatorConformance(
  make: () => AuthenticatorHarness | Promise<AuthenticatorHarness>,
  label = "Authenticator",
): void {
  describe(`${label} conformance`, () => {
    it("returns null for a request with no credential", async () => {
      const { authenticator } = await make();
      expect(await authenticator.authenticate({ headers: {} })).toBeNull();
    });

    it("returns null for a credential that was never issued", async () => {
      const h = await make();
      expect(await h.authenticator.authenticate({ headers: h.forged() })).toBeNull();
    });

    it("returns exactly the issued identity, and nothing else", async () => {
      const h = await make();
      const headers = await h.issue(ALICE);
      expect(await h.authenticator.authenticate({ headers })).toEqual(ALICE);
    });

    it("keeps two callers apart", async () => {
      const h = await make();
      const alice = await h.issue(ALICE);
      const bob = await h.issue(BOB);
      expect(await h.authenticator.authenticate({ headers: alice })).toEqual(ALICE);
      expect(await h.authenticator.authenticate({ headers: bob })).toEqual(BOB);
    });

    it("returns null once the credential is revoked, and leaves other callers alone", async () => {
      const h = await make();
      const alice = await h.issue(ALICE);
      const bob = await h.issue(BOB);
      await h.revoke(alice);
      expect(await h.authenticator.authenticate({ headers: alice })).toBeNull();
      expect(await h.authenticator.authenticate({ headers: bob })).toEqual(BOB);
    });
  });
}
```

`packages/auth/src/testing.ts`:

```ts
export * from "./conformance";
```

`packages/auth/src/index.ts`:

```ts
export type { AuthRequest, Authenticator, Identity } from "./authenticator";
```

- [ ] **Step 6: Run the test, then the gate**

```bash
pnpm --filter @docmind/auth test
```

Expected: `5 passed` (the five conformance tests against the stub).

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0. If `pnpm lint` reports formatting, run `pnpm lint:fix` and re-run.

- [ ] **Step 7: Commit, check the size, open the draft PR**

```bash
git add -A
git commit -m "feat(auth): Authenticator interface and conformance suite" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git diff main...HEAD --numstat -- . ':!pnpm-lock.yaml' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
```

Expected: about `153 lines, 10 files` (limit 200 and 10; if over, stop and split).

```bash
git push -u origin feat/m1-auth-interface
gh pr create --draft --base main --head feat/m1-auth-interface --title "feat(auth): Authenticator interface and conformance suite" --body "$(cat <<'EOF'
## Summary
- New package @docmind/auth (spec §3.1, §9 item 5): the Authenticator interface (request -> {tenantId, userId} or null) and runAuthenticatorConformance, the suite every implementation must pass (exported from @docmind/auth/testing).
- The suite is proven against a bearer-token stub. Loom has no Authenticator of its own (its nearest is conversation-sse's authenticate callback), so this is DocMind's.

## Not counted toward the 200-line / 10-file limit
pnpm-lock.yaml (new workspace package).

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: `gh` prints the PR URL. The PR stays a draft; the owner reviews it and merges with `gh pr merge --rebase`.

---

# PR 5b: same-named contract types

**Branch:** `feat/m1-contracts-types`  **Budget:** 3 files, 15 lines. Carried from the M0 review.

### Task 14: `export type` beside each shared schema

**Files:**
- Modify: `/Users/such/workspace/docmind/packages/contracts/src/common.ts`, `auth.ts`
- Test: `/Users/such/workspace/docmind/packages/contracts/src/common.test.ts` (create)

**Interfaces:**
- Consumes: the zod schemas `Uuid`, `IsoDateTime`, `Cursor` (`common.ts`) and `Email` (`auth.ts`).
- Produces: `type Uuid = string`, `type IsoDateTime = string`, `type Cursor = string`, `type Email = string`, each exported under the same name as its schema (so `import type { Uuid } from "@docmind/contracts"` works and `Uuid` is still the schema as a value).

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m1-contracts-types
```

- [ ] **Step 2: Write the failing test** (a type test: `expectTypeOf` is checked by `typecheck:tests`, not at runtime)

`packages/contracts/src/common.test.ts`:

```ts
import { describe, expectTypeOf, it } from "vitest";
import type { Cursor, Email, IsoDateTime, Uuid } from "./index";

describe("common contract types", () => {
  it("export a type with the same name as each schema", () => {
    expectTypeOf<Uuid>().toEqualTypeOf<string>();
    expectTypeOf<IsoDateTime>().toEqualTypeOf<string>();
    expectTypeOf<Cursor>().toEqualTypeOf<string>();
    expectTypeOf<Email>().toEqualTypeOf<string>();
  });
});
```

- [ ] **Step 3: Run it to see it fail**

```bash
pnpm --filter @docmind/contracts typecheck:tests
```

Expected: FAIL with errors like `'Uuid' only refers to a value, but is being used as a type here`.

- [ ] **Step 4: Add the types**

```diff
@@ -2,8 +2,11 @@ import { z } from "zod";
 
 export const Uuid = z.string().uuid();
+export type Uuid = z.infer<typeof Uuid>;
 export const IsoDateTime = z.string().datetime();
+export type IsoDateTime = z.infer<typeof IsoDateTime>;
 
 /** Opaque pagination cursor: the server issues it, clients echo it back unchanged. */
 export const Cursor = z.string().min(1).max(512);
+export type Cursor = z.infer<typeof Cursor>;
 
 /** Body of every non-2xx response. */
```

```diff
@@ -4,4 +4,5 @@ import { Uuid } from "./common";
 /** Trimmed and lower-cased on the way in, so `users.email UNIQUE` is case-insensitive. */
 export const Email = z.string().trim().toLowerCase().email().max(254);
+export type Email = z.infer<typeof Email>;
 
 export const SignUpRequest = z.object({
```

- [ ] **Step 5: Run the gate**

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0.

- [ ] **Step 6: Commit, check the size, open the draft PR**

```bash
git add -A
git commit -m "feat(contracts): export a type beside each shared schema" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git diff main...HEAD --numstat -- . ':!pnpm-lock.yaml' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
git push -u origin feat/m1-contracts-types
gh pr create --draft --base main --head feat/m1-contracts-types --title "feat(contracts): export a type beside each shared schema" --body "$(cat <<'EOF'
## Summary
- Uuid, IsoDateTime, Cursor and Email now export a type of the same name as their schema, like every other contract already does (M0 review carry-forward).

## Not counted toward the 200-line / 10-file limit
None.

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: about `15 lines, 3 files`, then the PR URL.

---

# PR 5c: the router answers 500 when a handler fails

**Branch:** `feat/m1-router-errors`  **Budget:** 4 files, 99 lines (+ `pnpm-lock.yaml`). The M0 review asked for this in "the first async route PR"; the first async handler is `requireAuth` (PR 5d), so it lands one PR earlier, where it is tested without any auth code.

### Task 15: catch rejected and throwing handlers; typed error responses

**Files:**
- Create: `/Users/such/workspace/docmind/apps/server/app/http/respond.ts`
- Modify: `/Users/such/workspace/docmind/apps/server/app/server.ts`, `server.test.ts`, `apps/server/package.json`

**Interfaces:**
- Consumes: `ErrorBody` type from `@docmind/contracts` (M0, PR 3a).
- Produces (`apps/server/app/http/respond.ts`): `type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>`; `json(res, status, body): void`; `sendError(res, status, code, message): void` (body is a `{ error: { code, message } }` `ErrorBody`).
- Produces (`server.ts`): `createHttpServer(extraRoutes?: Record<string, Handler>): Server`. Route keys are `"METHOD /path"`. A handler that throws or whose promise rejects yields a JSON 500 `{error:{code:"internal",message:"internal error"}}`; if headers were already sent the response is ended instead.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m1-router-errors
```

- [ ] **Step 2: Write the failing tests**

Append this block to `apps/server/app/server.test.ts` (keep the M0 tests above it):

```diff
@@ -46,2 +46,48 @@ describe("http server", () => {
   });
 });
+
+describe("handler failures", () => {
+  const failing = createHttpServer({
+    "GET /rejects": async () => {
+      throw new Error("boom");
+    },
+    "GET /throws": () => {
+      throw new Error("boom");
+    },
+    "GET /rejects-after-headers": async (_req, res) => {
+      res.writeHead(200, { "content-type": "text/plain" });
+      res.write("partial");
+      throw new Error("boom");
+    },
+  });
+  let url = "";
+
+  beforeAll(async () => {
+    await new Promise<void>((resolve) => failing.listen(0, "127.0.0.1", resolve));
+    url = `http://127.0.0.1:${(failing.address() as AddressInfo).port}`;
+  });
+
+  afterAll(async () => {
+    await new Promise<void>((resolve) => {
+      failing.close(() => resolve());
+      failing.closeAllConnections();
+    });
+  });
+
+  it.each(["/rejects", "/throws"])(
+    "answers a JSON 500 when %s fails, and keeps serving",
+    async (path) => {
+      const res = await fetch(`${url}${path}`);
+      expect(res.status).toBe(500);
+      expect(await res.json()).toEqual({ error: { code: "internal", message: "internal error" } });
+      expect((await fetch(`${url}/healthz`)).status).toBe(200);
+    },
+  );
+
+  it("ends a response that already started instead of hanging or crashing", async () => {
+    const res = await fetch(`${url}/rejects-after-headers`);
+    expect(res.status).toBe(200);
+    expect(await res.text()).toBe("partial");
+    expect((await fetch(`${url}/healthz`)).status).toBe(200);
+  });
+});
```

- [ ] **Step 3: Run them to see them fail**

```bash
pnpm --filter @docmind/server test
```

Expected: FAIL: `createHttpServer` takes no arguments yet, so the `/rejects` and `/throws` routes do not exist (404 instead of 500), and `pnpm --filter @docmind/server typecheck:tests` reports `Expected 0 arguments, but got 1`.

- [ ] **Step 4: Implement**

`apps/server/app/http/respond.ts`:

```ts
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ErrorBody } from "@docmind/contracts";

export type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  json(res, status, { error: { code, message } } satisfies ErrorBody);
}
```

Replace `apps/server/app/server.ts`:

```ts
import { type Server, createServer } from "node:http";
import { type Handler, json, sendError } from "./http/respond";

const baseRoutes: Record<string, Handler> = {
  "GET /healthz": (_req, res) => json(res, 200, { status: "ok" }),
};

/** The HTTP edge. Routes are keyed "METHOD /path"; unknown routes are a JSON 404. */
export function createHttpServer(extraRoutes: Record<string, Handler> = {}): Server {
  const routes = { ...baseRoutes, ...extraRoutes };
  return createServer((req, res) => {
    let path: string;
    try {
      path = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      return sendError(res, 400, "bad_request", "invalid request target");
    }
    const handler = Object.hasOwn(routes, `${req.method ?? "GET"} ${path}`)
      ? routes[`${req.method ?? "GET"} ${path}`]
      : undefined;
    if (!handler) return sendError(res, 404, "not_found", "no such route");
    // The async wrapper turns a synchronous throw and a rejected promise into the same failure.
    (async () => handler(req, res))().catch(() => {
      if (res.headersSent) res.end();
      else sendError(res, 500, "internal", "internal error");
    });
  });
}
```

Add the contracts dependency in `apps/server/package.json` (`dependencies`, first entry):

```diff
@@ -13,4 +13,5 @@
   },
   "dependencies": {
+    "@docmind/contracts": "workspace:*",
     "@loom/app": "*",
     "@loom/effect-runtime": "*",
```

- [ ] **Step 5: Run the tests, then the gate**

```bash
pnpm install
pnpm --filter @docmind/server test
```

Expected: `app/server.test.ts` shows 6 tests passed (3 from M0, 3 new).

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0.

- [ ] **Step 6: Commit, check the size, open the draft PR**

```bash
git add -A
git commit -m "fix(server): answer 500 when a route handler throws or rejects" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git diff main...HEAD --numstat -- . ':!pnpm-lock.yaml' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
git push -u origin feat/m1-router-errors
gh pr create --draft --base main --head feat/m1-router-errors --title "fix(server): answer 500 when a route handler throws or rejects" --body "$(cat <<'EOF'
## Summary
- The router now awaits handlers and turns a throw or a rejected promise into a JSON 500 (or ends a response that already started), with tests for both and for the half-sent case. M0 review carry-forward, needed before any async route.
- sendError/json/Handler move to app/http/respond.ts; sendError is typed by the contracts ErrorBody. apps/server gains the @docmind/contracts workspace dependency (M0 review carry-forward).

## Not counted toward the 200-line / 10-file limit
pnpm-lock.yaml.

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: about `99 lines, 4 files`, then the PR URL.

---

# PR 5d: `requireAuth` and graceful shutdown

**Branch:** `feat/m1-require-auth`  **Budget:** 6 files, 154 lines (+ `pnpm-lock.yaml`). Spec §9 item 5, part 3 of 3.

### Task 16: request middleware, and `server.close()` before `app.close()`

**Files:**
- Create: `/Users/such/workspace/docmind/apps/server/app/http/requireAuth.ts`, `requireAuth.test.ts`, `apps/server/app/shutdown.ts`, `shutdown.test.ts`
- Modify: `/Users/such/workspace/docmind/apps/server/app/main.ts`, `apps/server/package.json`

**Interfaces:**
- Consumes: `Authenticator`, `Identity` from `@docmind/auth` (PR 5a); `Handler`, `sendError` from `./respond` (PR 5c).
- Produces: `type AuthedHandler = (req, res, identity: Identity) => void | Promise<void>`; `requireAuth(authenticator: Authenticator, handler: AuthedHandler): Handler` (401 `unauthorized` when `authenticate` resolves null; a rejection reaches the router, so 500); `shutdown(server: Server, app: { close(): Promise<void> }): Promise<void>` (awaits `server.close()`, sweeping idle keep-alive sockets, then `app.close()`; does not close the app if the server fails to close).

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m1-require-auth
```

- [ ] **Step 2: Write the failing tests**

`apps/server/app/http/requireAuth.test.ts`:

```ts
import type { AddressInfo } from "node:net";
import type { Authenticator, Identity } from "@docmind/auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpServer } from "../server";
import { requireAuth } from "./requireAuth";
import { json } from "./respond";

const ALICE: Identity = {
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  userId: "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1",
};

/** Accepts only the header `x-test-user: alice`; `x-test-user: down` simulates an outage. */
const authenticator: Authenticator = {
  async authenticate(req) {
    const who = req.headers["x-test-user"];
    if (who === "down") throw new Error("database unavailable");
    return who === "alice" ? ALICE : null;
  },
};

const server = createHttpServer({
  "GET /whoami": requireAuth(authenticator, (_req, res, identity) => json(res, 200, identity)),
});
let base = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("requireAuth", () => {
  it("gives the handler the authenticated identity", async () => {
    const res = await fetch(`${base}/whoami`, { headers: { "x-test-user": "alice" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(ALICE);
  });

  it("answers 401 without running the handler when nobody is authenticated", async () => {
    const res = await fetch(`${base}/whoami`, { headers: { "x-test-user": "mallory" } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "unauthorized", message: "authentication required" },
    });
  });

  it("answers 500, not 401 and not access, when the authenticator itself fails", async () => {
    const res = await fetch(`${base}/whoami`, { headers: { "x-test-user": "down" } });
    expect(res.status).toBe(500);
  });
});
```

`apps/server/app/shutdown.test.ts`:

```ts
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { shutdown } from "./shutdown";

describe("shutdown", () => {
  it("lets the in-flight request finish before it closes the app", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    let arrived: () => void = () => undefined;
    const requestArrived = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const server = createServer((_req, res) => {
      arrived();
      release = () => {
        order.push("response sent");
        res.end("done");
      };
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const inFlight = fetch(url).then((r) => r.text());
    await requestArrived;
    const closing = shutdown(server, {
      close: async () => {
        order.push("app closed");
      },
    });
    release();

    expect(await inFlight).toBe("done");
    await closing;
    expect(order).toEqual(["response sent", "app closed"]);
  });

  it("does not close the app when the server fails to close", async () => {
    const server = createServer(); // never listened: close() reports ERR_SERVER_NOT_RUNNING
    let closed = false;
    await expect(
      shutdown(server, {
        close: async () => {
          closed = true;
        },
      }),
    ).rejects.toThrow();
    expect(closed).toBe(false);
  });
});
```

- [ ] **Step 3: Run them to see them fail**

```bash
pnpm --filter @docmind/server test
```

Expected: FAIL, `Failed to resolve import "./requireAuth"` and `"./shutdown"`.

- [ ] **Step 4: Implement**

`apps/server/app/http/requireAuth.ts`:

```ts
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Authenticator, Identity } from "@docmind/auth";
import { type Handler, sendError } from "./respond";

export type AuthedHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  identity: Identity,
) => void | Promise<void>;

/**
 * Wraps a route so it runs only for an authenticated caller and receives the Identity. A route
 * must take the tenant and user from here, never from the request body or URL. If the
 * authenticator itself fails, the rejection reaches the router, which answers 500: a failed
 * check is never treated as a pass.
 */
export function requireAuth(authenticator: Authenticator, handler: AuthedHandler): Handler {
  return async (req, res) => {
    const identity = await authenticator.authenticate(req);
    if (!identity) return sendError(res, 401, "unauthorized", "authentication required");
    await handler(req, res, identity);
  };
}
```

`apps/server/app/shutdown.ts`:

```ts
import type { Server } from "node:http";

/**
 * Stops accepting requests, lets in-flight ones finish, and only then closes the app.
 * `server.close()` waits for idle keep-alive sockets too, and one that goes idle after the call is
 * not closed for us, so idle sockets are swept until the server is down.
 */
export async function shutdown(server: Server, app: { close(): Promise<void> }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const sweep = setInterval(() => server.closeIdleConnections(), 50);
    server.close((err) => {
      clearInterval(sweep);
      return err ? reject(err) : resolve();
    });
    server.closeIdleConnections();
  });
  await app.close();
}
```

Replace `apps/server/app/main.ts` so signals call it (before, it did `server.close(); void app.close();`, closing both at once):

```ts
import { app } from "./config";
import { createHttpServer } from "./server";
import { shutdown } from "./shutdown";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const server = createHttpServer();

server.listen(port, host, () => console.log(`docmind server listening on http://${host}:${port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    shutdown(server, app).catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
  });
}
```

Add the auth dependency in `apps/server/package.json`:

```diff
@@ -13,4 +13,5 @@
   },
   "dependencies": {
+    "@docmind/auth": "workspace:*",
     "@docmind/contracts": "workspace:*",
     "@loom/app": "*",
```

- [ ] **Step 5: Run the tests, then the gate**

```bash
pnpm install
pnpm --filter @docmind/server test
```

Expected: `requireAuth.test.ts` 3 passed, `shutdown.test.ts` 2 passed.

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0.

- [ ] **Step 6: Commit, check the size, open the draft PR**

```bash
git add -A
git commit -m "feat(server): requireAuth middleware; close the server before the app" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git diff main...HEAD --numstat -- . ':!pnpm-lock.yaml' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
git push -u origin feat/m1-require-auth
gh pr create --draft --base main --head feat/m1-require-auth --title "feat(server): requireAuth middleware; close the server before the app" --body "$(cat <<'EOF'
## Summary
- requireAuth(authenticator, handler): the request middleware (spec §9 item 5). 401 when nobody is authenticated; if the authenticator itself fails the router answers 500, never 401 and never access.
- shutdown(): awaits server.close() (sweeping idle keep-alive sockets) and only then app.close(); main.ts uses it (M0 review carry-forward). A test checks the in-flight response finishes before the app closes.
- apps/server depends on @docmind/auth.

## Not counted toward the 200-line / 10-file limit
pnpm-lock.yaml.

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: about `154 lines, 6 files`, then the PR URL.

---
# PR 6a: session indexes and the `SECURITY DEFINER` auth functions

**Branch:** `feat/m1-auth-sql`  **Budget:** 3 files, 157 lines. Spec §9 item 6, part 1 of 14. Nothing calls these functions yet.

### Task 17: migrations 0004 and 0005

**Files:**
- Create: `/Users/such/workspace/docmind/infra/migrations/0004_auth_session_indexes.sql`, `0005_auth_functions.sql`
- Test: `/Users/such/workspace/docmind/apps/server/app/db/authFunctions.test.ts` (create)

**Interfaces:**
- Consumes: M0's `tenants`, `users`, `auth_sessions`, `docmind_app`, `withTenant(pool, tenantId, fn)` (`apps/server/app/db/tenant.ts`), and the test helpers `createTestDb`, `PG_URL`, `APP_PASSWORD`, `TestDb` (`testSupport.ts`) and `migrate`, `setAppRolePassword` (`migrate.ts`).
- Produces (callable by `docmind_app` with no tenant set): `auth_sign_up(p_tenant_id uuid, p_user_id uuid, p_email text, p_password_hash text) RETURNS boolean` (creates the personal tenant `'Personal'` and the user; false and no tenant left behind when the email is taken); `auth_find_login(p_email text) RETURNS TABLE (user_id uuid, tenant_id uuid, password_hash text)`; `auth_find_session(p_token_hash text) RETURNS TABLE (user_id uuid, tenant_id uuid)` (live sessions only); `auth_purge_expired_sessions() RETURNS bigint`. Indexes `auth_sessions_tenant_user_idx (tenant_id, user_id)` and `auth_sessions_expires_at_idx (expires_at)`.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m1-auth-sql
```

- [ ] **Step 2: Write the failing test**

It drives every function as the app role with no tenant set, and also checks the properties the M0 review asked for: pinned `search_path`, executable by `docmind_app` and by nobody else, both indexes present. It filters to `auth_%` functions so later migrations' own definer functions do not break it. `apps/server/app/db/authFunctions.test.ts`:

```ts
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword } from "./migrate";
import { withTenant } from "./tenant";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "./testSupport";

const T1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const U1 = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const T2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const U2 = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";

describe.skipIf(!PG_URL)("auth SQL functions (need DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    app = new Pool({ connectionString: db.appUrl, max: 1 });
  });

  afterAll(async () => {
    await app?.end();
    await db?.drop();
  });

  const signUp = async (t: string, u: string, email: string) =>
    (await app.query("SELECT auth_sign_up($1, $2, $3, 'hash') AS ok", [t, u, email])).rows[0].ok;

  it("signs a user up, with no tenant context, as the app role", async () => {
    expect(await signUp(T1, U1, "a@example.com")).toBe(true);
    const login = await app.query("SELECT * FROM auth_find_login('a@example.com')");
    expect(login.rows).toEqual([{ user_id: U1, tenant_id: T1, password_hash: "hash" }]);
    expect((await app.query("SELECT * FROM auth_find_login('x@example.com')")).rowCount).toBe(0);
  });

  it("reports a taken email and leaves no orphan tenant behind", async () => {
    expect(await signUp(T2, U2, "a@example.com")).toBe(false);
    const { rowCount } = await db.owner.query("SELECT 1 FROM tenants WHERE id = $1", [T2]);
    expect(rowCount).toBe(0);
  });

  it("finds a live session by token hash and ignores an expired one", async () => {
    await withTenant(app, T1, async (tx) => {
      await tx.query(
        `INSERT INTO auth_sessions (token_hash, tenant_id, user_id, expires_at) VALUES
           ('live', $1, $2, now() + interval '1 day'), ('dead', $1, $2, now() - interval '1 day')`,
        [T1, U1],
      );
    });
    const live = await app.query("SELECT * FROM auth_find_session('live')");
    expect(live.rows).toEqual([{ user_id: U1, tenant_id: T1 }]);
    expect((await app.query("SELECT * FROM auth_find_session('dead')")).rowCount).toBe(0);
    expect((await app.query("SELECT * FROM auth_find_session('nope')")).rowCount).toBe(0);
  });

  it("sweeps expired sessions across tenants and keeps live ones", async () => {
    expect((await app.query("SELECT auth_purge_expired_sessions() AS n")).rows[0].n).toBe("1");
    const { rows } = await db.owner.query("SELECT token_hash FROM auth_sessions");
    expect(rows).toEqual([{ token_hash: "live" }]);
  });

  it("pins search_path on every definer function, so a caller's path cannot redirect it", async () => {
    const { rows } = await db.owner.query(
      `SELECT proname, proconfig FROM pg_proc WHERE prosecdef AND proname LIKE 'auth\\_%' AND pronamespace = 'public'::regnamespace
       ORDER BY proname`,
    );
    expect(rows.map((r) => r.proname)).toEqual([
      "auth_find_login",
      "auth_find_session",
      "auth_purge_expired_sessions",
      "auth_sign_up",
    ]);
    for (const r of rows)
      expect(r.proconfig, r.proname).toContain("search_path=pg_catalog, pg_temp");
  });

  it("is executable by the app role and by nobody else", async () => {
    const { rows } = await db.owner.query(
      `SELECT p.proname,
              has_function_privilege('docmind_app', p.oid, 'EXECUTE') AS app,
              has_function_privilege(0, p.oid, 'EXECUTE') AS public
         FROM pg_proc p
        WHERE prosecdef AND proname LIKE 'auth\\_%' AND pronamespace = 'public'::regnamespace`,
    );
    expect(rows.length).toBe(4);
    for (const r of rows) expect([r.app, r.public], r.proname).toEqual([true, false]);
  });

  it("indexes sessions by (tenant_id, user_id) and by expires_at", async () => {
    const { rows } = await db.owner.query(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'auth_sessions'",
    );
    const defs = rows.map((r) => r.indexdef).join("\n");
    expect(defs).toContain("(tenant_id, user_id)");
    expect(defs).toContain("(expires_at)");
  });
});
```

- [ ] **Step 3: Run it to see it fail**

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm --filter @docmind/server exec vitest run app/db/authFunctions.test.ts
```

Expected: FAIL, `function auth_sign_up(...) does not exist` (and the other tests fail the same way, or because the indexes are missing).

- [ ] **Step 4: Write the migrations** (new files; never edit 0001-0003)

`infra/migrations/0004_auth_session_indexes.sql`:

```sql
-- Lookups the auth flows make: a user's sessions within their tenant (revoke all, account erasure),
-- and the sweep that deletes expired sessions.
CREATE INDEX auth_sessions_tenant_user_idx ON auth_sessions (tenant_id, user_id);
CREATE INDEX auth_sessions_expires_at_idx ON auth_sessions (expires_at);
```

`infra/migrations/0005_auth_functions.sql`:

```sql
-- Auth steps that happen before a tenant is known (sign-up, login by email, session by token hash)
-- or that span tenants (the expired-session sweep). docmind_app is bound by row-level security and
-- cannot create tenants, so each step is a narrow SECURITY DEFINER function owned by the migration
-- role, which bypasses RLS. Every one pins search_path (a definer function must not resolve names
-- through the caller's path) and schema-qualifies what it touches.

-- Creates a personal tenant and its first user together. False when the email is already taken.
CREATE FUNCTION auth_sign_up(p_tenant_id uuid, p_user_id uuid, p_email text, p_password_hash text)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  INSERT INTO public.tenants (id, name) VALUES (p_tenant_id, 'Personal');
  INSERT INTO public.users (id, tenant_id, email, password_hash)
    VALUES (p_user_id, p_tenant_id, p_email, p_password_hash)
    ON CONFLICT (email) DO NOTHING;
  IF NOT FOUND THEN
    DELETE FROM public.tenants WHERE id = p_tenant_id;
    RETURN false;
  END IF;
  RETURN true;
END
$$;

-- Login: the one row a given email maps to.
CREATE FUNCTION auth_find_login(p_email text)
  RETURNS TABLE (user_id uuid, tenant_id uuid, password_hash text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT u.id, u.tenant_id, u.password_hash FROM public.users u WHERE u.email = p_email $$;

-- Authentication: the owner of a live session, found by the hash of its cookie token.
CREATE FUNCTION auth_find_session(p_token_hash text)
  RETURNS TABLE (user_id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT s.user_id, s.tenant_id FROM public.auth_sessions s
         WHERE s.token_hash = p_token_hash AND s.expires_at > now() $$;

-- Deletes every expired session of every tenant; returns how many.
CREATE FUNCTION auth_purge_expired_sessions()
  RETURNS bigint
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ WITH gone AS (DELETE FROM public.auth_sessions WHERE expires_at <= now() RETURNING 1)
        SELECT count(*) FROM gone $$;

-- 0001 revokes PUBLIC execute on new functions; grant it to the app role explicitly, and revoke
-- PUBLIC again so this file does not depend on that default.
REVOKE ALL ON FUNCTION auth_sign_up(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_find_login(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_find_session(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_purge_expired_sessions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_sign_up(uuid, uuid, text, text) TO docmind_app;
GRANT EXECUTE ON FUNCTION auth_find_login(text) TO docmind_app;
GRANT EXECUTE ON FUNCTION auth_find_session(text) TO docmind_app;
GRANT EXECUTE ON FUNCTION auth_purge_expired_sessions() TO docmind_app;
```

- [ ] **Step 5: Run the test, then the gate**

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm --filter @docmind/server exec vitest run app/db/authFunctions.test.ts
```

Expected: `7 passed`.

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0 (the M0 isolation test still passes: it only looks at `public` tables and these add none).

- [ ] **Step 6: Commit, check the size, open the draft PR**

```bash
git add -A
git commit -m "feat(db): session indexes and SECURITY DEFINER auth functions" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git diff main...HEAD --numstat -- . ':!pnpm-lock.yaml' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
git push -u origin feat/m1-auth-sql
gh pr create --draft --base main --head feat/m1-auth-sql --title "feat(db): session indexes and SECURITY DEFINER auth functions" --body "$(cat <<'EOF'
## Summary
- 0004: indexes on auth_sessions (tenant_id, user_id) and (expires_at) (M0 review carry-forward).
- 0005: auth_sign_up, auth_find_login, auth_find_session, auth_purge_expired_sessions: the pre-tenant steps docmind_app cannot do under RLS. Each is SECURITY DEFINER with SET search_path = pg_catalog, pg_temp, schema-qualified names, REVOKE ALL FROM PUBLIC and an explicit GRANT EXECUTE to docmind_app (M0 review carry-forward). No caller yet.
- Tests run as docmind_app with no tenant set, and assert the search_path pin, the grants and the indexes.

## Not counted toward the 200-line / 10-file limit
None.

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test` (with DOCMIND_TEST_PG_URL)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: about `157 lines, 3 files`, then the PR URL.

---

# PR 6b: password hashing and session tokens

**Branch:** `feat/m1-auth-password`  **Budget:** 6 files, 97 lines (+ `pnpm-lock.yaml`). Spec §9 item 6, part 2 of 14.

### Task 18: argon2id and the session token

**Files:**
- Create: `/Users/such/workspace/docmind/packages/auth/src/password.ts`, `password.test.ts`, `session.ts`, `session.test.ts`
- Modify: `/Users/such/workspace/docmind/packages/auth/src/index.ts`, `packages/auth/package.json`

**Interfaces:**
- Consumes: nothing from earlier tasks (the `argon2` npm package).
- Produces (from `@docmind/auth`): `hashPassword(password: string): Promise<string>` (argon2id PHC string, 19 MiB / 2 passes / 1 lane); `verifyPassword(hash: string, password: string): Promise<boolean>` (a malformed hash is `false`); `verifyAgainstDecoy(password: string): Promise<void>` (spends one real verification); `SESSION_TTL_MS` (30 days); `interface SessionToken { token: string; tokenHash: string }`; `newSessionToken(): SessionToken` (256 random bits, base64url, 43 chars); `hashToken(token: string): string` (sha256 hex).

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m1-auth-password
```

- [ ] **Step 2: Write the failing tests**

`packages/auth/src/password.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { hashPassword, verifyAgainstDecoy, verifyPassword } from "./password";

describe("password hashing", () => {
  it("produces an argon2id hash and verifies the right password only", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    expect(await verifyPassword(hash, "correct horse battery")).toBe(true);
    expect(await verifyPassword(hash, "wrong horse battery")).toBe(false);
  });

  it("salts every hash", async () => {
    expect(await hashPassword("same password here")).not.toBe(
      await hashPassword("same password here"),
    );
  });

  it("treats a malformed stored hash as a mismatch", async () => {
    expect(await verifyPassword("not-a-hash", "anything")).toBe(false);
  });

  it("takes a decoy check without throwing, even for the decoy's own password", async () => {
    await expect(verifyAgainstDecoy("decoy-password-never-matches")).resolves.toBeUndefined();
  });
});
```

`packages/auth/src/session.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { hashToken, newSessionToken } from "./session";

describe("session tokens", () => {
  it("are 256 random bits in a cookie-safe alphabet, never repeated", () => {
    const a = newSessionToken();
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newSessionToken().token).not.toBe(a.token);
  });

  it("are stored as a hash that cannot be used as the cookie", () => {
    const { token, tokenHash } = newSessionToken();
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).not.toBe(token);
    expect(hashToken(token)).toBe(tokenHash);
  });
});
```

- [ ] **Step 3: Run them to see them fail**

```bash
pnpm --filter @docmind/auth test
```

Expected: FAIL, `Failed to resolve import "./password"` and `"./session"`.

- [ ] **Step 4: Implement**

Add the dependency to `packages/auth/package.json` and install (`node-argon2` ships prebuilt binaries for Linux, macOS and Windows; nothing compiles locally, so pnpm's install-script policy does not matter):

```diff
@@ -18,4 +18,7 @@
     "@types/node": "^22.0.0",
     "vitest": "^2.1.8"
+  },
+  "dependencies": {
+    "argon2": "^0.45.1"
   }
 }
```

```bash
pnpm install
```

`packages/auth/src/password.ts`:

```ts
import argon2 from "argon2";

// OWASP's minimum argon2id profile: 19 MiB of memory, 2 passes, 1 lane.
const PARAMS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

/** An argon2id hash in PHC string form; the salt and parameters are inside it. */
export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, PARAMS);
}

/** True only for a match. A malformed stored hash is a mismatch, not a crash. */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

let decoy: Promise<string> | undefined;

/**
 * Spends the time of a real check for an email that has no account, and and discards the result. Without it,
 * a fast "no such user" answer tells an attacker which emails are registered.
 */
export async function verifyAgainstDecoy(password: string): Promise<void> {
  decoy ??= hashPassword("decoy-password-never-matches");
  await verifyPassword(await decoy, password);
}
```

`packages/auth/src/session.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";

/** A session lasts 30 days from login; logout ends it sooner. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** What the browser holds (the cookie value) and what the database keeps (its hash). */
export interface SessionToken {
  token: string;
  tokenHash: string;
}

/** The database stores only this, so a leaked table cannot be replayed as cookies. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 256 random bits, so a plain SHA-256 is enough; a slow hash would only slow every request. */
export function newSessionToken(): SessionToken {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}
```

`packages/auth/src/index.ts`:

```ts
export type { AuthRequest, Authenticator, Identity } from "./authenticator";
export { hashPassword, verifyAgainstDecoy, verifyPassword } from "./password";
export { SESSION_TTL_MS, type SessionToken, hashToken, newSessionToken } from "./session";
```

- [ ] **Step 5: Run the tests, then the gate**

```bash
pnpm --filter @docmind/auth test
```

Expected: `password.test.ts` 4 passed, `session.test.ts` 2 passed.

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0.

- [ ] **Step 6: Commit, check the size, open the draft PR**

```bash
git add -A
git commit -m "feat(auth): argon2id password hashing and session tokens" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git diff main...HEAD --numstat -- . ':!pnpm-lock.yaml' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
git push -u origin feat/m1-auth-password
gh pr create --draft --base main --head feat/m1-auth-password --title "feat(auth): argon2id password hashing and session tokens" --body "$(cat <<'EOF'
## Summary
- hashPassword/verifyPassword on argon2id (OWASP minimum profile: 19 MiB, 2 passes, 1 lane); a malformed stored hash is a mismatch, not a crash.
- verifyAgainstDecoy spends the time of a real check so login does not reveal which emails exist.
- newSessionToken: 256 random bits for the cookie; hashToken (sha256) is what the database stores (spec §4.2).
- Adds the argon2 dependency (prebuilt binaries).

## Not counted toward the 200-line / 10-file limit
pnpm-lock.yaml.

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: about `97 lines, 6 files`, then the PR URL.

---

# PR 6c: `AuthStore`, an in-memory store, and the session cookie

**Branch:** `feat/m1-auth-store`  **Budget:** 7 files, 164 lines. Spec §9 item 6, part 3 of 14.

### Task 19: the storage interface and cookie helpers

**Files:**
- Create: `/Users/such/workspace/docmind/packages/auth/src/store.ts`, `memoryStore.ts`, `memoryStore.test.ts`, `cookie.ts`, `cookie.test.ts`
- Modify: `/Users/such/workspace/docmind/packages/auth/src/index.ts`, `packages/auth/src/testing.ts`

**Interfaces:**
- Consumes: `Identity` (PR 5a).
- Produces (from `@docmind/auth`): `interface LoginRecord extends Identity { passwordHash: string }`; `interface NewAccount extends Identity { email: string; passwordHash: string }`; `interface NewSession extends Identity { tokenHash: string; expiresAt: Date }`; `interface AuthStore { findLogin(email): Promise<LoginRecord | null>; createAccount(a: NewAccount): Promise<boolean>; createSession(s: NewSession): Promise<void>; findSession(tokenHash): Promise<Identity | null>; findEmail(identity: Identity): Promise<string | null>; deleteSession(identity: Identity, tokenHash: string): Promise<void> }`; `SESSION_COOKIE = "dm_session"`; `readSessionCookie(headers: IncomingHttpHeaders): string | undefined`; `sessionCookie(token: string, maxAgeMs: number, secure: boolean): string`; `clearedSessionCookie(secure: boolean): string`.
- Produces (from `@docmind/auth/testing`): `class MemoryAuthStore implements AuthStore` with a settable `now: () => Date`.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m1-auth-store
```

- [ ] **Step 2: Write the failing tests**

`packages/auth/src/cookie.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE, clearedSessionCookie, readSessionCookie, sessionCookie } from "./cookie";

describe("session cookie", () => {
  it("reads its own cookie among others, and nothing from a look-alike name", () => {
    expect(readSessionCookie({ cookie: `a=1; ${SESSION_COOKIE}=tok; b=2` })).toBe("tok");
    expect(readSessionCookie({ cookie: `x${SESSION_COOKIE}=evil; a=1` })).toBeUndefined();
    expect(readSessionCookie({})).toBeUndefined();
  });

  it("is HttpOnly and SameSite=Lax, Secure only when asked", () => {
    const plain = sessionCookie("tok", 90_000, false);
    expect(plain).toBe(`${SESSION_COOKIE}=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=90`);
    expect(sessionCookie("tok", 90_000, true)).toMatch(/; Secure$/);
  });

  it("is removed by an empty, immediately expiring cookie", () => {
    expect(clearedSessionCookie(false)).toBe(
      `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    );
  });
});
```

`packages/auth/src/memoryStore.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MemoryAuthStore } from "./memoryStore";

const alice = { tenantId: "t1", userId: "u1" };
const account = { ...alice, email: "a@example.com", passwordHash: "hash" };
const session = { ...alice, tokenHash: "h1", expiresAt: new Date(Date.now() + 60_000) };

describe("MemoryAuthStore", () => {
  it("creates an account once per email and finds it by email and by identity", async () => {
    const store = new MemoryAuthStore();
    expect(await store.createAccount(account)).toBe(true);
    expect(await store.createAccount({ ...account, userId: "u2" })).toBe(false);
    expect(await store.findLogin("a@example.com")).toEqual(account);
    expect(await store.findLogin("b@example.com")).toBeNull();
    expect(await store.findEmail(alice)).toBe("a@example.com");
    expect(await store.findEmail({ ...alice, tenantId: "t2" })).toBeNull();
  });

  it("finds a session until it expires", async () => {
    const store = new MemoryAuthStore();
    await store.createSession(session);
    expect(await store.findSession("h1")).toEqual(alice);
    store.now = () => new Date(session.expiresAt.getTime() + 1);
    expect(await store.findSession("h1")).toBeNull();
  });

  it("ends a session only for the tenant that owns it", async () => {
    const store = new MemoryAuthStore();
    await store.createSession(session);
    await store.deleteSession({ tenantId: "t2", userId: "u9" }, "h1");
    expect(await store.findSession("h1")).toEqual(alice);
    await store.deleteSession(alice, "h1");
    expect(await store.findSession("h1")).toBeNull();
  });
});
```

- [ ] **Step 3: Run them to see them fail**

```bash
pnpm --filter @docmind/auth test
```

Expected: FAIL, `Failed to resolve import "./cookie"` and `"./memoryStore"`.

- [ ] **Step 4: Implement**

`packages/auth/src/store.ts`:

```ts
import type { Identity } from "./authenticator";

export interface LoginRecord extends Identity {
  passwordHash: string;
}

export interface NewAccount extends Identity {
  email: string;
  passwordHash: string;
}

export interface NewSession extends Identity {
  tokenHash: string;
  expiresAt: Date;
}

/**
 * Where accounts and sessions live. The password/session code depends on this interface so it can
 * be tested without a database; the server implements it on Postgres (`SECURITY DEFINER`
 * functions for the steps that happen before a tenant is known, `withTenant` for the rest).
 */
export interface AuthStore {
  /** The account an email belongs to, if any. Emails arrive already lower-cased. */
  findLogin(email: string): Promise<LoginRecord | null>;
  /** Creates the personal tenant and its first user together. False when the email is taken. */
  createAccount(account: NewAccount): Promise<boolean>;
  createSession(session: NewSession): Promise<void>;
  /** The owner of a session that has not expired, found by token hash. */
  findSession(tokenHash: string): Promise<Identity | null>;
  /** The email of an account, for `GET /api/me`. Null when the account no longer exists. */
  findEmail(identity: Identity): Promise<string | null>;
  /** Ends one session. A no-op for a session that is already gone. */
  deleteSession(identity: Identity, tokenHash: string): Promise<void>;
}
```

`packages/auth/src/memoryStore.ts`:

```ts
import type { Identity } from "./authenticator";
import type { AuthStore, LoginRecord, NewAccount, NewSession } from "./store";

/** An AuthStore in memory, for tests of everything built on the interface. */
export class MemoryAuthStore implements AuthStore {
  private readonly accounts = new Map<string, LoginRecord & { email: string }>();
  private readonly sessions = new Map<string, NewSession>();

  /** Tests move this to make sessions expire without waiting. */
  now: () => Date = () => new Date();

  async findLogin(email: string): Promise<LoginRecord | null> {
    return this.accounts.get(email) ?? null;
  }

  async createAccount(a: NewAccount): Promise<boolean> {
    if (this.accounts.has(a.email)) return false;
    this.accounts.set(a.email, a);
    return true;
  }

  async createSession(s: NewSession): Promise<void> {
    this.sessions.set(s.tokenHash, s);
  }

  async findSession(tokenHash: string): Promise<Identity | null> {
    const s = this.sessions.get(tokenHash);
    if (!s || s.expiresAt <= this.now()) return null;
    return { tenantId: s.tenantId, userId: s.userId };
  }

  async findEmail(identity: Identity): Promise<string | null> {
    for (const a of this.accounts.values()) {
      if (a.userId === identity.userId && a.tenantId === identity.tenantId) return a.email;
    }
    return null;
  }

  async deleteSession(identity: Identity, tokenHash: string): Promise<void> {
    if (this.sessions.get(tokenHash)?.tenantId === identity.tenantId) {
      this.sessions.delete(tokenHash);
    }
  }
}
```

`packages/auth/src/cookie.ts`:

```ts
import type { IncomingHttpHeaders } from "node:http";

export const SESSION_COOKIE = "dm_session";

/** The value of the session cookie, or undefined. A cookie can only be sent by its own site's origin. */
export function readSessionCookie(headers: IncomingHttpHeaders): string | undefined {
  for (const part of (headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * The Set-Cookie value that starts a session. HttpOnly keeps scripts away from it, SameSite=Lax
 * keeps other sites from sending it on a form post, `secure` is for HTTPS deployments.
 */
export function sessionCookie(token: string, maxAgeMs: number, secure: boolean): string {
  const attrs = ["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  return [`${SESSION_COOKIE}=${token}`, ...attrs, ...(secure ? ["Secure"] : [])].join("; ");
}

/** The Set-Cookie value that removes the session cookie from the browser. */
export function clearedSessionCookie(secure: boolean): string {
  return sessionCookie("", 0, secure);
}
```

`packages/auth/src/testing.ts` and `packages/auth/src/index.ts`:

```ts
export * from "./conformance";
export { MemoryAuthStore } from "./memoryStore";
```

```ts
export type { AuthRequest, Authenticator, Identity } from "./authenticator";
export { SESSION_COOKIE, clearedSessionCookie, readSessionCookie, sessionCookie } from "./cookie";
export { hashPassword, verifyAgainstDecoy, verifyPassword } from "./password";
export { SESSION_TTL_MS, type SessionToken, hashToken, newSessionToken } from "./session";
export type { AuthStore, LoginRecord, NewAccount, NewSession } from "./store";
```

- [ ] **Step 5: Run the tests, then the gate**

```bash
pnpm --filter @docmind/auth test
```

Expected: `cookie.test.ts` 3 passed, `memoryStore.test.ts` 3 passed, plus the earlier suites.

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0.

- [ ] **Step 6: Commit, check the size, open the draft PR**

```bash
git add -A
git commit -m "feat(auth): AuthStore interface, in-memory store and session cookie helpers" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git diff main...HEAD --numstat -- . ':!pnpm-lock.yaml' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
git push -u origin feat/m1-auth-store
gh pr create --draft --base main --head feat/m1-auth-store --title "feat(auth): AuthStore interface, in-memory store and session cookie helpers" --body "$(cat <<'EOF'
## Summary
- AuthStore: what the password/session code needs from storage, so it is unit-tested without a database. The server implements it on Postgres (PR 6f).
- MemoryAuthStore (exported from @docmind/auth/testing) with a settable clock.
- The dm_session cookie: HttpOnly, SameSite=Lax, Path=/, Secure when asked; a look-alike cookie name is ignored.

## Not counted toward the 200-line / 10-file limit
None.

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: about `164 lines, 7 files`, then the PR URL.

---

# PR 6d: `PasswordAuthenticator`

**Branch:** `feat/m1-auth-authenticator`  **Budget:** 3 files, 77 lines. Spec §9 item 6, part 4 of 14.

### Task 20: the cookie-session Authenticator, passing the conformance suite

**Files:**
- Create: `/Users/such/workspace/docmind/packages/auth/src/passwordAuthenticator.ts`, `passwordAuthenticator.test.ts`
- Modify: `/Users/such/workspace/docmind/packages/auth/src/index.ts`

**Interfaces:**
- Consumes: `Authenticator`, `AuthRequest`, `Identity` (PR 5a); `AuthStore`, `readSessionCookie`, `SESSION_COOKIE` (PR 6c); `hashToken`, `newSessionToken`, `SESSION_TTL_MS` (PR 6b); `runAuthenticatorConformance`, `AuthenticatorHarness`, `MemoryAuthStore` from `./testing`.
- Produces: `class PasswordAuthenticator implements Authenticator { constructor(store: AuthStore) }`. It reads the session cookie, ignores a value that cannot be a real token (43 base64url characters) without touching the store, and otherwise returns `store.findSession(hashToken(token))`.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m1-auth-authenticator
```

- [ ] **Step 2: Write the failing test**

It runs the conformance suite on `PasswordAuthenticator` over a `MemoryAuthStore`, then adds the two behaviours specific to this implementation. `packages/auth/src/passwordAuthenticator.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE, readSessionCookie } from "./cookie";
import { MemoryAuthStore } from "./memoryStore";
import { PasswordAuthenticator } from "./passwordAuthenticator";
import { SESSION_TTL_MS, hashToken, newSessionToken } from "./session";
import { type AuthenticatorHarness, runAuthenticatorConformance } from "./testing";

const cookieFor = (token: string) => ({ cookie: `other=1; ${SESSION_COOKIE}=${token}` });

function setup() {
  const store = new MemoryAuthStore();
  const owners = new Map<string, { tenantId: string; userId: string }>();
  const harness: AuthenticatorHarness = {
    authenticator: new PasswordAuthenticator(store),
    async issue(identity) {
      const { token, tokenHash } = newSessionToken();
      owners.set(token, identity);
      await store.createSession({
        ...identity,
        tokenHash,
        expiresAt: new Date(store.now().getTime() + SESSION_TTL_MS),
      });
      return cookieFor(token);
    },
    async revoke(headers) {
      const token = readSessionCookie(headers) ?? "";
      await store.deleteSession(
        owners.get(token) ?? { tenantId: "", userId: "" },
        hashToken(token),
      );
    },
    forged: () => cookieFor(newSessionToken().token),
  };
  return { store, harness };
}

runAuthenticatorConformance(() => setup().harness, "PasswordAuthenticator");

describe("PasswordAuthenticator", () => {
  const alice = { tenantId: "t1", userId: "u1" };

  it("rejects a session that has expired", async () => {
    const { store, harness } = setup();
    const headers = await harness.issue(alice);
    expect(await harness.authenticator.authenticate({ headers })).toEqual(alice);
    store.now = () => new Date(Date.now() + SESSION_TTL_MS + 1000);
    expect(await harness.authenticator.authenticate({ headers })).toBeNull();
  });

  it("does not consult the store for a cookie that cannot be a real token", async () => {
    const { store, harness } = setup();
    store.findSession = async () => {
      throw new Error("store consulted");
    };
    const headers = { cookie: `${SESSION_COOKIE}=junk` };
    expect(await harness.authenticator.authenticate({ headers })).toBeNull();
  });
});
```

- [ ] **Step 3: Run it to see it fail**

```bash
pnpm --filter @docmind/auth test
```

Expected: FAIL, `Failed to resolve import "./passwordAuthenticator"`.

- [ ] **Step 4: Implement**

`packages/auth/src/passwordAuthenticator.ts`:

```ts
import type { AuthRequest, Authenticator, Identity } from "./authenticator";
import { readSessionCookie } from "./cookie";
import { hashToken } from "./session";
import type { AuthStore } from "./store";

/** What `newSessionToken` produces; anything else cannot be a real cookie, so skip the lookup. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** The v1 Authenticator: the session cookie set at login, checked against the stored hash. */
export class PasswordAuthenticator implements Authenticator {
  constructor(private readonly store: AuthStore) {}

  async authenticate(req: AuthRequest): Promise<Identity | null> {
    const token = readSessionCookie(req.headers);
    if (!token || !TOKEN_SHAPE.test(token)) return null;
    return this.store.findSession(hashToken(token));
  }
}
```

`packages/auth/src/index.ts`:

```ts
export type { AuthRequest, Authenticator, Identity } from "./authenticator";
export { SESSION_COOKIE, clearedSessionCookie, readSessionCookie, sessionCookie } from "./cookie";
export { hashPassword, verifyAgainstDecoy, verifyPassword } from "./password";
export { PasswordAuthenticator } from "./passwordAuthenticator";
export { SESSION_TTL_MS, type SessionToken, hashToken, newSessionToken } from "./session";
export type { AuthStore, LoginRecord, NewAccount, NewSession } from "./store";
```

- [ ] **Step 5: Run the test, then the gate**

```bash
pnpm --filter @docmind/auth test
```

Expected: `passwordAuthenticator.test.ts` 7 passed (5 conformance + 2).

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0.

- [ ] **Step 6: Commit, check the size, open the draft PR**

```bash
git add -A
git commit -m "feat(auth): PasswordAuthenticator" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git diff main...HEAD --numstat -- . ':!pnpm-lock.yaml' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
git push -u origin feat/m1-auth-authenticator
gh pr create --draft --base main --head feat/m1-auth-authenticator --title "feat(auth): PasswordAuthenticator" --body "$(cat <<'EOF'
## Summary
- PasswordAuthenticator: the v1 Authenticator (spec §3.1). Reads the dm_session cookie, skips the store for a value that cannot be a token, and resolves the identity of a live session by token hash.
- Passes runAuthenticatorConformance, plus tests for expiry and for not consulting the store on junk.

## Not counted toward the 200-line / 10-file limit
None.

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: about `77 lines, 3 files`, then the PR URL.

---

# PR 6e: `AuthService` (sign-up, login, logout)

**Branch:** `feat/m1-auth-service`  **Budget:** 3 files, 113 lines. Spec §9 item 6, part 5 of 14.

### Task 21: the account logic

**Files:**
- Create: `/Users/such/workspace/docmind/packages/auth/src/authService.ts`, `authService.test.ts`
- Modify: `/Users/such/workspace/docmind/packages/auth/src/index.ts`

**Interfaces:**
- Consumes: `AuthStore` (PR 6c); `hashPassword`, `verifyPassword`, `verifyAgainstDecoy`, `newSessionToken`, `hashToken`, `SESSION_TTL_MS` (PR 6b); `Identity`.
- Produces: `interface StartedSession { identity: Identity; token: string }`; `class AuthService { constructor(store: AuthStore); signUp(email, password): Promise<boolean> /* false: email taken; starts NO session; hashes the password before asking the store, so both outcomes cost the same */; logIn(email, password): Promise<StartedSession | null> /* null: unknown email or wrong password, same work either way */; logOut(identity: Identity, token: string): Promise<void> }`. Emails arrive already normalised by the contracts' `Email` schema. `signUp` returns a boolean, not a session, because the HTTP layer must not tell a client whether the email was new (PR 6k); the user logs in afterwards.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m1-auth-service
```

- [ ] **Step 2: Write the failing test**

`packages/auth/src/authService.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AuthService } from "./authService";
import { SESSION_COOKIE } from "./cookie";
import { MemoryAuthStore } from "./memoryStore";
import { PasswordAuthenticator } from "./passwordAuthenticator";

const EMAIL = "ada@example.com";
const PASSWORD = "correct horse battery";

function setup() {
  const store = new MemoryAuthStore();
  const authenticator = new PasswordAuthenticator(store);
  const whoIs = (token: string) =>
    authenticator.authenticate({ headers: { cookie: `${SESSION_COOKIE}=${token}` } });
  return { store, service: new AuthService(store), whoIs };
}

describe("AuthService", () => {
  it("signs up with only an argon2id hash stored, starting no session", async () => {
    const { store, service } = setup();
    expect(await service.signUp(EMAIL, PASSWORD)).toBe(true);
    const stored = await store.findLogin(EMAIL);
    expect(stored?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(stored)).not.toContain(PASSWORD);
  });

  it("refuses a second sign-up with the same email and keeps the first password", async () => {
    const { service } = setup();
    await service.signUp(EMAIL, PASSWORD);
    expect(await service.signUp(EMAIL, "another long password")).toBe(false);
    expect(await service.logIn(EMAIL, PASSWORD)).not.toBeNull();
    expect(await service.logIn(EMAIL, "another long password")).toBeNull();
  });

  it("logs in as the signed-up user, on a new session each time", async () => {
    const { service, whoIs } = setup();
    await service.signUp(EMAIL, PASSWORD);
    const first = await service.logIn(EMAIL, PASSWORD);
    const again = await service.logIn(EMAIL, PASSWORD);
    expect(again?.identity).toEqual(first?.identity);
    expect(again?.token).not.toBe(first?.token);
    expect(await whoIs(again?.token ?? "")).toEqual(first?.identity);
  });

  it("answers null for a wrong password and for an unknown email", async () => {
    const { service } = setup();
    await service.signUp(EMAIL, PASSWORD);
    expect(await service.logIn(EMAIL, "wrong password here")).toBeNull();
    expect(await service.logIn("nobody@example.com", PASSWORD)).toBeNull();
  });

  it("ends only the session it is asked to end", async () => {
    const { service, whoIs } = setup();
    await service.signUp(EMAIL, PASSWORD);
    const a = await service.logIn(EMAIL, PASSWORD);
    const b = await service.logIn(EMAIL, PASSWORD);
    if (!a || !b) throw new Error("setup failed");
    await service.logOut(a.identity, a.token);
    expect(await whoIs(a.token)).toBeNull();
    expect(await whoIs(b.token)).toEqual(b.identity);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

```bash
pnpm --filter @docmind/auth test
```

Expected: FAIL, `Failed to resolve import "./authService"`.

- [ ] **Step 4: Implement**

`packages/auth/src/authService.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { Identity } from "./authenticator";
import { hashPassword, verifyAgainstDecoy, verifyPassword } from "./password";
import { SESSION_TTL_MS, hashToken, newSessionToken } from "./session";
import type { AuthStore } from "./store";

/** A started session: who it is for, and the cookie token to hand the browser. */
export interface StartedSession {
  identity: Identity;
  token: string;
}

/** Sign-up, login and logout over an AuthStore. Emails arrive normalised by the contracts. */
export class AuthService {
  constructor(private readonly store: AuthStore) {}

  /**
   * Creates a personal tenant and its user; false when the email is taken. It starts no session,
   * and the HTTP layer must answer the same either way, or sign-up tells anyone which emails are
   * registered. The password is hashed before the store is asked, so both outcomes cost the same.
   */
  async signUp(email: string, password: string): Promise<boolean> {
    const passwordHash = await hashPassword(password);
    const identity = { tenantId: randomUUID(), userId: randomUUID() };
    return this.store.createAccount({ ...identity, email, passwordHash });
  }

  /** Null for an unknown email and for a wrong password alike, after the same amount of work. */
  async logIn(email: string, password: string): Promise<StartedSession | null> {
    const login = await this.store.findLogin(email);
    if (!login) {
      await verifyAgainstDecoy(password);
      return null;
    }
    if (!(await verifyPassword(login.passwordHash, password))) return null;
    return this.start({ tenantId: login.tenantId, userId: login.userId });
  }

  /** Ends the session the caller authenticated with. */
  async logOut(identity: Identity, token: string): Promise<void> {
    await this.store.deleteSession(identity, hashToken(token));
  }

  private async start(identity: Identity): Promise<StartedSession> {
    const { token, tokenHash } = newSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.store.createSession({ ...identity, tokenHash, expiresAt });
    return { identity, token };
  }
}
```

`packages/auth/src/index.ts`:

```ts
export { AuthService, type StartedSession } from "./authService";
export type { AuthRequest, Authenticator, Identity } from "./authenticator";
export { SESSION_COOKIE, clearedSessionCookie, readSessionCookie, sessionCookie } from "./cookie";
export { hashPassword, verifyAgainstDecoy, verifyPassword } from "./password";
export { PasswordAuthenticator } from "./passwordAuthenticator";
export { SESSION_TTL_MS, type SessionToken, hashToken, newSessionToken } from "./session";
export type { AuthStore, LoginRecord, NewAccount, NewSession } from "./store";
```

- [ ] **Step 5: Run the test, then the gate**

```bash
pnpm --filter @docmind/auth test
```

Expected: `authService.test.ts` 5 passed.

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0.

- [ ] **Step 6: Commit, check the size, open the draft PR**

```bash
git add -A
git commit -m "feat(auth): AuthService with sign-up, login and logout" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git diff main...HEAD --numstat -- . ':!pnpm-lock.yaml' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
git push -u origin feat/m1-auth-service
gh pr create --draft --base main --head feat/m1-auth-service --title "feat(auth): AuthService with sign-up, login and logout" --body "$(cat <<'EOF'
## Summary
- AuthService over an AuthStore: signUp (personal tenant + user, hashes first, starts no session so the HTTP layer can answer identically for a taken email; false when taken), logIn (new session per login; the same null, after the same work, for a wrong password and an unknown email), logOut (ends one session).
- Passwords are stored only as argon2id hashes (asserted).

## Not counted toward the 200-line / 10-file limit
None.

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: about `113 lines, 3 files`, then the PR URL.

---
# PR 6f: `PgAuthStore`

**Branch:** `feat/m1-auth-pg-store`  **Budget:** 3 files, 191 lines. Spec §9 item 6, part 6 of 14. Nothing mounts it yet.

### Task 22: `AuthStore` on Postgres

**Files:**
- Create: `/Users/such/workspace/docmind/apps/server/app/auth/pgAuthStore.ts`, `pgAuthStore.test.ts`
- Modify: `/Users/such/workspace/docmind/apps/server/vitest.config.ts`

**Interfaces:**
- Consumes: `AuthStore`, `Identity`, `LoginRecord`, `NewAccount`, `NewSession` (PR 6c); the SQL functions from PR 6a; `withTenant(pool, tenantId, fn)` (M0).
- Produces: `class PgAuthStore implements AuthStore { constructor(pool: Pool); purgeExpiredSessions(): Promise<number> }`. `pool` must be connected as `docmind_app`. Pre-tenant steps (`findLogin`, `createAccount`, `findSession`) call the definer functions directly; `createSession`, `findEmail` and `deleteSession` run inside `withTenant`, so row-level security applies (a session can only be ended by the tenant that owns it).

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m1-auth-pg-store
```

- [ ] **Step 2: Write the failing test**

It runs the same Authenticator conformance suite on the Postgres store, then sign-up/login/logout end to end, a cross-tenant `deleteSession` that must do nothing, and the purge. `apps/server/app/auth/pgAuthStore.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import {
  AuthService,
  type Identity,
  PasswordAuthenticator,
  SESSION_COOKIE,
  hashToken,
  newSessionToken,
  readSessionCookie,
} from "@docmind/auth";
import { runAuthenticatorConformance } from "@docmind/auth/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword } from "../db/migrate";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";
import { PgAuthStore } from "./pgAuthStore";

describe.skipIf(!PG_URL)("PgAuthStore (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let pool: Pool;
  let store: PgAuthStore;

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    pool = new Pool({ connectionString: db.appUrl });
    store = new PgAuthStore(pool);
  });

  afterAll(async () => {
    await pool?.end();
    await db?.drop();
  });

  // The conformance suite names its callers; each needs an account (once) so the session's keys hold.
  const withAccount = new Set<string>();
  runAuthenticatorConformance(() => {
    const owners = new Map<string, Identity>();
    const cookieFor = (token: string) => ({ cookie: `${SESSION_COOKIE}=${token}` });
    return {
      authenticator: new PasswordAuthenticator(store),
      async issue(identity) {
        if (!withAccount.has(identity.userId)) {
          withAccount.add(identity.userId);
          const email = `${identity.userId}@x.test`;
          await store.createAccount({ ...identity, email, passwordHash: "x" });
        }
        const { token, tokenHash } = newSessionToken();
        owners.set(token, identity);
        await store.createSession({
          ...identity,
          tokenHash,
          expiresAt: new Date(Date.now() + 60_000),
        });
        return cookieFor(token);
      },
      async revoke(headers) {
        const token = readSessionCookie(headers) ?? "";
        const owner = owners.get(token);
        if (owner) await store.deleteSession(owner, hashToken(token));
      },
      forged: () => cookieFor("A".repeat(43)),
    };
  }, "PasswordAuthenticator on PgAuthStore");

  const PASSWORD = "correct horse battery";
  const signedUp = async () => {
    const service = new AuthService(store);
    const email = `${randomUUID()}@example.com`;
    expect(await service.signUp(email, PASSWORD)).toBe(true);
    const started = await service.logIn(email, PASSWORD);
    if (!started) throw new Error("setup failed");
    return { service, email, started };
  };

  it("runs sign-up, login and logout end to end", async () => {
    const { service, email, started } = await signedUp();
    expect(await service.signUp(email, PASSWORD)).toBe(false);
    expect(await store.findEmail(started.identity)).toBe(email);
    const again = await service.logIn(email, PASSWORD);
    expect(again?.identity).toEqual(started.identity);
    await service.logOut(started.identity, started.token);
    const auth = new PasswordAuthenticator(store);
    const cookie = (t: string) => ({ cookie: `${SESSION_COOKIE}=${t}` });
    expect(await auth.authenticate({ headers: cookie(started.token) })).toBeNull();
    expect(await auth.authenticate({ headers: cookie(again?.token ?? "") })).toEqual(
      again?.identity,
    );
  });

  it("cannot end another tenant's session", async () => {
    const { service, started: a } = await signedUp();
    const { started: b } = await signedUp();
    await service.logOut(b.identity, a.token);
    const auth = new PasswordAuthenticator(store);
    const headers = { cookie: `${SESSION_COOKIE}=${a.token}` };
    expect(await auth.authenticate({ headers })).toEqual(a.identity);
  });

  it("purges expired sessions and only those", async () => {
    const { started: user } = await signedUp();
    await db.owner.query(
      "INSERT INTO auth_sessions VALUES ('stale', $1, $2, now() - interval '1 minute')",
      [user.identity.tenantId, user.identity.userId],
    );
    expect(await store.purgeExpiredSessions()).toBe(1);
    expect(await store.findSession(hashToken(user.token))).toEqual(user.identity);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm --filter @docmind/server exec vitest run app/auth/pgAuthStore.test.ts
```

Expected: FAIL, `Failed to resolve import "./pgAuthStore"`.

- [ ] **Step 4: Implement**

`apps/server/app/auth/pgAuthStore.ts`:

```ts
import type { AuthStore, Identity, LoginRecord, NewAccount, NewSession } from "@docmind/auth";
import type { Pool } from "pg";
import { withTenant } from "../db/tenant";

/**
 * AuthStore on Postgres, connected as the docmind_app role. The steps that happen before a tenant
 * is known go through the SECURITY DEFINER functions in migration 0005; everything else runs in
 * `withTenant`, so row-level security applies to it.
 */
export class PgAuthStore implements AuthStore {
  constructor(private readonly pool: Pool) {}

  async findLogin(email: string): Promise<LoginRecord | null> {
    const { rows } = await this.pool.query(
      "SELECT user_id, tenant_id, password_hash FROM auth_find_login($1)",
      [email],
    );
    const row = rows[0];
    return row
      ? { userId: row.user_id, tenantId: row.tenant_id, passwordHash: row.password_hash }
      : null;
  }

  async createAccount(a: NewAccount): Promise<boolean> {
    const { rows } = await this.pool.query("SELECT auth_sign_up($1, $2, $3, $4) AS ok", [
      a.tenantId,
      a.userId,
      a.email,
      a.passwordHash,
    ]);
    return rows[0].ok;
  }

  async createSession(s: NewSession): Promise<void> {
    await withTenant(this.pool, s.tenantId, (tx) =>
      tx.query(
        "INSERT INTO auth_sessions (token_hash, tenant_id, user_id, expires_at) VALUES ($1, $2, $3, $4)",
        [s.tokenHash, s.tenantId, s.userId, s.expiresAt],
      ),
    );
  }

  async findSession(tokenHash: string): Promise<Identity | null> {
    const { rows } = await this.pool.query("SELECT user_id, tenant_id FROM auth_find_session($1)", [
      tokenHash,
    ]);
    return rows[0] ? { userId: rows[0].user_id, tenantId: rows[0].tenant_id } : null;
  }

  async findEmail(identity: Identity): Promise<string | null> {
    const { rows } = await withTenant(this.pool, identity.tenantId, (tx) =>
      tx.query("SELECT email FROM users WHERE id = $1", [identity.userId]),
    );
    return rows[0]?.email ?? null;
  }

  async deleteSession(identity: Identity, tokenHash: string): Promise<void> {
    await withTenant(this.pool, identity.tenantId, (tx) =>
      tx.query("DELETE FROM auth_sessions WHERE token_hash = $1 AND user_id = $2", [
        tokenHash,
        identity.userId,
      ]),
    );
  }

  /** Deletes every tenant's expired sessions; returns how many. */
  async purgeExpiredSessions(): Promise<number> {
    const { rows } = await this.pool.query("SELECT auth_purge_expired_sessions() AS n");
    return Number(rows[0].n);
  }
}
```

The test imports `@docmind/auth/testing`, whose compiled CommonJS entry would `require("vitest")` ("Vitest cannot be imported in a CommonJS module"). Tests therefore load that subpath from TypeScript source; type checking still uses `testing.d.ts`. Update `apps/server/vitest.config.ts`:

```ts
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // @loom/* publish require-only `exports`; resolve them the same way under Vite.
  resolve: {
    conditions: ["node", "require", "default"],
    // The auth test kit imports vitest, which cannot be require()d from the CommonJS build, so
    // tests load it from source.
    alias: { "@docmind/auth/testing": resolve(__dirname, "../../packages/auth/src/testing.ts") },
  },
  // Suites share cluster-wide state (the docmind_app role), so test files run one at a time.
  test: {
    environment: "node",
    fileParallelism: false,
    server: { deps: { external: [/@loom\//, /[\/]loom[\/]/] } },
  },
});
```

- [ ] **Step 5: Run the test, then the gate**

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm --filter @docmind/server exec vitest run app/auth/pgAuthStore.test.ts
```

Expected: `8 passed` (5 conformance + end to end + cross-tenant + purge).

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0.

- [ ] **Step 6: Commit, check the size, open the draft PR**

```bash
git add -A
git commit -m "feat(server): PgAuthStore on the SECURITY DEFINER auth functions" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git diff main...HEAD --numstat -- . ':!pnpm-lock.yaml' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
git push -u origin feat/m1-auth-pg-store
gh pr create --draft --base main --head feat/m1-auth-pg-store --title "feat(server): PgAuthStore on the SECURITY DEFINER auth functions" --body "$(cat <<'EOF'
## Summary
- PgAuthStore implements AuthStore as docmind_app: the pre-tenant steps through the 0005 functions, everything else in withTenant (so RLS applies; a session cannot be ended across tenants, tested).
- PasswordAuthenticator passes the Authenticator conformance suite on it. purgeExpiredSessions wraps auth_purge_expired_sessions.
- vitest config maps @docmind/auth/testing to TypeScript source (its CommonJS build cannot require vitest).

## Not counted toward the 200-line / 10-file limit
None.

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test` (with DOCMIND_TEST_PG_URL)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: about `191 lines, 3 files`, then the PR URL.

---

# PR 6g: `readJson`

**Branch:** `feat/m1-http-body`  **Budget:** 3 files, 121 lines. Spec §9 item 6, part 7 of 14.

### Task 23: JSON-only, size-limited, validated request bodies

**Files:**
- Create: `/Users/such/workspace/docmind/apps/server/app/http/body.ts`, `body.test.ts`
- Modify: `/Users/such/workspace/docmind/apps/server/package.json`

**Interfaces:**
- Consumes: `sendError` (PR 5c); `createHttpServer`, `json` for the test; `ErrorBody` from `@docmind/contracts`.
- Produces: `readJson<S extends z.ZodTypeAny>(req: IncomingMessage, res: ServerResponse, schema: S): Promise<z.infer<S> | undefined>`. On any problem it has already answered and returns `undefined`: 415 `unsupported_media_type` unless `content-type` is `application/json`; 413 `payload_too_large` above 16 KiB (with `connection: close`, then the request is destroyed once the response is flushed); 400 `invalid_request` for broken JSON or a schema failure (the message lists `path: problem` pairs, never the submitted values). Requiring `application/json` also stops a cross-site HTML form from posting to the API, since a form cannot send that type.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m1-http-body
```

- [ ] **Step 2: Write the failing test**

`apps/server/app/http/body.test.ts`:

```ts
import type { AddressInfo } from "node:net";
import { ErrorBody } from "@docmind/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createHttpServer } from "../server";
import { readJson } from "./body";
import { json } from "./respond";

const Echo = z.object({ name: z.string().min(1) });

const server = createHttpServer({
  "POST /echo": async (req, res) => {
    const body = await readJson(req, res, Echo);
    if (body) json(res, 200, body);
  },
});
let base = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
});

const post = (body: string, type = "application/json") =>
  fetch(`${base}/echo`, { method: "POST", headers: { "content-type": type }, body });

describe("readJson", () => {
  it("returns the validated body", async () => {
    const res = await post(JSON.stringify({ name: "ada", extra: 1 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "ada" });
  });

  it("refuses a body that is not declared as JSON (a form post cannot send it)", async () => {
    const res = await post("name=ada", "application/x-www-form-urlencoded");
    expect(res.status).toBe(415);
  });

  it("answers 400 for broken JSON and for a body that fails the schema", async () => {
    expect((await post("{nope")).status).toBe(400);
    const bad = await post(JSON.stringify({ name: "" }));
    expect(bad.status).toBe(400);
    expect(ErrorBody.parse(await bad.json()).error.message).toContain("name:");
  });

  it("answers 413 for an oversized body and keeps serving", async () => {
    const res = await post(JSON.stringify({ name: "x".repeat(20_000) }));
    expect(res.status).toBe(413);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

```bash
pnpm --filter @docmind/server exec vitest run app/http/body.test.ts
```

Expected: FAIL, `Failed to resolve import "./body"`.

- [ ] **Step 4: Implement**

Add `zod` to the server's dependencies (same range as `@docmind/contracts`):

```diff
@@ -18,5 +18,6 @@
     "@loom/effect-runtime": "*",
     "@loom/workflow-runtime": "*",
-    "pg": "^8.13.0"
+    "pg": "^8.13.0",
+    "zod": "^3.23.8"
   },
   "devDependencies": {
```

```bash
pnpm install
```

`apps/server/app/http/body.ts`:

```ts
import type { IncomingMessage, ServerResponse } from "node:http";
import type { z } from "zod";
import { sendError } from "./respond";

const MAX_BODY_BYTES = 16 * 1024;

/** The body as text, or null when it is larger than the limit (reading stops there). */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.pause();
        resolve(null);
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

/**
 * Reads and validates a JSON request body. On any problem it has already answered (415, 413 or
 * 400) and returns undefined, so a route does `if (!body) return;`. Requiring application/json
 * also keeps a cross-site HTML form from posting to the API: a form cannot send that type.
 */
export async function readJson<S extends z.ZodTypeAny>(
  req: IncomingMessage,
  res: ServerResponse,
  schema: S,
): Promise<z.infer<S> | undefined> {
  const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") {
    sendError(res, 415, "unsupported_media_type", "send application/json");
    return undefined;
  }
  const text = await readBody(req);
  if (text === null) {
    res.setHeader("connection", "close");
    sendError(res, 413, "payload_too_large", "request body is too large");
    res.once("finish", () => req.destroy());
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    sendError(res, 400, "invalid_request", "body is not valid JSON");
    return undefined;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`);
    sendError(res, 400, "invalid_request", problems.join("; "));
    return undefined;
  }
  return parsed.data;
}
```

- [ ] **Step 5: Run the test, then the gate**

```bash
pnpm --filter @docmind/server exec vitest run app/http/body.test.ts
```

Expected: `4 passed`.

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0.

- [ ] **Step 6: Commit, check the size, open the draft PR**

```bash
git add -A
git commit -m "feat(server): readJson for JSON-only, size-limited, validated bodies" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git diff main...HEAD --numstat -- . ':!pnpm-lock.yaml' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
git push -u origin feat/m1-http-body
gh pr create --draft --base main --head feat/m1-http-body --title "feat(server): readJson for JSON-only, size-limited, validated bodies" --body "$(cat <<'EOF'
## Summary
- readJson(req, res, schema): 415 unless application/json (also what keeps a cross-site HTML form from posting to the API), 413 above 16 KiB, 400 for broken JSON or a schema failure with a message that names fields, never values. It answers itself and returns undefined, so a route is `if (!body) return;`.

## Not counted toward the 200-line / 10-file limit
pnpm-lock.yaml (zod added to apps/server).

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: about `121 lines, 3 files`, then the PR URL.

---

# PR 6h: throttle policy and the client address

**Branch:** `feat/m1-throttle`  **Budget:** 5 files, 129 lines. Spec §9 item 6, part 8 of 14. Rate limiting is not in the spec; the owner asked for it in M1, and PRs 6h-6k land before any route so no route ships unthrottled.

### Task 24: the `Throttle` interface, the policies, and `clientIp`

**Files:**
- Create: `/Users/such/workspace/docmind/packages/auth/src/throttle.ts`, `throttle.test.ts`, `clientIp.ts`, `clientIp.test.ts`
- Modify: `/Users/such/workspace/docmind/packages/auth/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (from `@docmind/auth`): `interface ThrottlePolicy { free: number; baseSeconds: number; capSeconds: number; decaySeconds: number }`; `interface Throttle { retryAfter(keys: readonly string[]): Promise<number>; fail(key: string, policy: ThrottlePolicy): Promise<void>; clear(key: string): Promise<void> }`; `POLICIES` (`loginIp`, `loginAccount`, `signUpIp`, `signUpAccount`); `type Scope = "login" | "signup"`; `ipKey(scope, ip): string`; `accountKey(scope, email): string` (a sha256 of the email, never the address itself); `lockSeconds(policy, failures): number`; `clientIp(req: Pick<IncomingMessage, "headers" | "socket">, trustProxy: boolean): string`.

**The policy (why a victim cannot be locked out for good).** The first `free` failures cost nothing. Each failure after that locks the key for `baseSeconds * 2^(n - free - 1)` seconds, at most `capSeconds`, and a key left alone for `decaySeconds` starts again from zero. Every lock is therefore time-boxed: the longest any one lock lasts is 15 minutes for login (1 hour for sign-up), and an attacker who stops stops the lock. Per email (5 free guesses, then 2 s, 4 s, 8 s ... up to 15 min) and per client address (20 free, then 5 s ... up to 15 min); sign-up counts every attempt, 5 free per address and 3 per email, then 60 s ... up to 1 hour. A successful login forgets the email's failures. Keys use a hash of the email, whether or not the account exists, so a throttled answer reveals nothing about existence.

**The client address.** `clientIp` believes only the socket's peer address, by default. Any client can send `X-Forwarded-For`, and believing it would let an attacker pick a new "address" for every guess. With `trustProxy` (env `DOCMIND_TRUST_PROXY=true`, for a deployment behind exactly one reverse proxy of yours that appends the address it saw) the last entry of the header is used. IPv4-mapped IPv6 is written as IPv4.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m1-throttle
```

- [ ] **Step 2: Write the failing tests**

`packages/auth/src/throttle.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { POLICIES, accountKey, ipKey, lockSeconds } from "./throttle";

describe("throttle policy", () => {
  it("is free up to the allowance, then doubles up to the cap", () => {
    const p = POLICIES.loginAccount;
    const locks = [5, 6, 7, 8, 9, 20].map((n) => lockSeconds(p, n));
    expect(locks).toEqual([0, 2, 4, 8, 16, 900]);
  });

  it("keys an account by a hash of its email, the same for any case-normalised email", () => {
    expect(accountKey("login", "a@example.com")).toBe(accountKey("login", "a@example.com"));
    expect(accountKey("login", "a@example.com")).not.toContain("a@example.com");
    expect(accountKey("login", "a@example.com")).not.toBe(accountKey("signup", "a@example.com"));
    expect(ipKey("login", "203.0.113.9")).toBe("login-ip:203.0.113.9");
  });
});
```

`packages/auth/src/clientIp.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { clientIp } from "./clientIp";

const req = (remoteAddress: string | undefined, forwarded?: string) =>
  ({
    headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
    socket: { remoteAddress },
  }) as Parameters<typeof clientIp>[0];

describe("clientIp", () => {
  it("believes only the socket by default, whatever the headers say", () => {
    expect(clientIp(req("203.0.113.9", "1.2.3.4"), false)).toBe("203.0.113.9");
  });

  it("takes the last forwarded entry (the one our proxy added) when told to trust it", () => {
    expect(clientIp(req("10.0.0.2", "6.6.6.6, 198.51.100.7"), true)).toBe("198.51.100.7");
  });

  it("falls back to the socket when trusting but there is no header", () => {
    expect(clientIp(req("10.0.0.2"), true)).toBe("10.0.0.2");
  });

  it("writes an IPv4-mapped address as IPv4, and survives a missing address", () => {
    expect(clientIp(req("::ffff:203.0.113.9"), false)).toBe("203.0.113.9");
    expect(clientIp(req(undefined), false)).toBe("unknown");
  });
});
```

- [ ] **Step 3: Run them to see them fail**

```bash
pnpm --filter @docmind/auth test
```

Expected: FAIL, `Failed to resolve import "./throttle"` and `"./clientIp"`.

- [ ] **Step 4: Implement**

`packages/auth/src/throttle.ts`:

```ts
import { createHash } from "node:crypto";

/**
 * How failures slow a caller down. The first `free` failures cost nothing; each one after that
 * locks the key for `baseSeconds * 2^(n - free - 1)`, never more than `capSeconds`, so a lock is
 * always time-boxed: waiting it out is enough, and nobody is locked out for good. A key left
 * alone for `decaySeconds` starts again from zero.
 */
export interface ThrottlePolicy {
  free: number;
  baseSeconds: number;
  capSeconds: number;
  decaySeconds: number;
}

/** Counters that survive restarts and are shared by every server instance (Postgres in v1). */
export interface Throttle {
  /** Seconds the caller must wait because of any of these keys; 0 when none is locked. */
  retryAfter(keys: readonly string[]): Promise<number>;
  /** Counts one failure (for sign-up, one attempt) against a key. */
  fail(key: string, policy: ThrottlePolicy): Promise<void>;
  /** Forgets a key, after a successful login. */
  clear(key: string): Promise<void>;
}

export const POLICIES = {
  /** Per client IP: generous, because many people can share one address. */
  loginIp: { free: 20, baseSeconds: 5, capSeconds: 900, decaySeconds: 3600 },
  /** Per email, whether or not it exists: 5 free guesses, then 2 s, 4 s, ... up to 15 min. */
  loginAccount: { free: 5, baseSeconds: 2, capSeconds: 900, decaySeconds: 3600 },
  signUpIp: { free: 5, baseSeconds: 60, capSeconds: 3600, decaySeconds: 7200 },
  signUpAccount: { free: 3, baseSeconds: 60, capSeconds: 900, decaySeconds: 3600 },
} as const satisfies Record<string, ThrottlePolicy>;

export type Scope = "login" | "signup";

export const ipKey = (scope: Scope, ip: string): string => `${scope}-ip:${ip}`;

/** Keyed by a hash of the email, so the table never holds an address and an unknown email counts like a known one. */
export const accountKey = (scope: Scope, email: string): string =>
  `${scope}-acct:${createHash("sha256").update(email).digest("hex")}`;

/** The lock a key has after `failures` failures; the SQL function throttle_fail computes the same. */
export function lockSeconds(policy: ThrottlePolicy, failures: number): number {
  if (failures <= policy.free) return 0;
  return Math.min(
    policy.capSeconds,
    policy.baseSeconds * 2 ** Math.min(failures - policy.free - 1, 30),
  );
}
```

`packages/auth/src/clientIp.ts`:

```ts
import type { IncomingMessage } from "node:http";

/**
 * The address a request came from, for throttling. By default only the socket's peer address is
 * believed: any client can send an X-Forwarded-For header, and trusting it would let an attacker
 * pick a fresh "address" for every guess. Set `trustProxy` only when the server is reachable
 * through exactly one reverse proxy of yours, which appends the address it saw; the last entry is
 * then that address. IPv4-mapped IPv6 addresses are written as plain IPv4.
 */
export function clientIp(
  req: Pick<IncomingMessage, "headers" | "socket">,
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const last = (Array.isArray(forwarded) ? forwarded.join(",") : (forwarded ?? ""))
      .split(",")
      .pop()
      ?.trim();
    if (last) return normalise(last);
  }
  return normalise(req.socket.remoteAddress ?? "unknown");
}

const normalise = (ip: string): string => ip.replace(/^::ffff:/i, "").toLowerCase();
```

`packages/auth/src/index.ts`:

```ts
export { AuthService, type StartedSession } from "./authService";
export type { AuthRequest, Authenticator, Identity } from "./authenticator";
export { clientIp } from "./clientIp";
export { SESSION_COOKIE, clearedSessionCookie, readSessionCookie, sessionCookie } from "./cookie";
export { hashPassword, verifyAgainstDecoy, verifyPassword } from "./password";
export { PasswordAuthenticator } from "./passwordAuthenticator";
export { SESSION_TTL_MS, type SessionToken, hashToken, newSessionToken } from "./session";
export type { AuthStore, LoginRecord, NewAccount, NewSession } from "./store";
export {
  POLICIES,
  type Scope,
  type Throttle,
  type ThrottlePolicy,
  accountKey,
  ipKey,
  lockSeconds,
} from "./throttle";
```

- [ ] **Step 5: Run the tests, then the gate**

```bash
pnpm --filter @docmind/auth test
```

Expected: `throttle.test.ts` 2 passed, `clientIp.test.ts` 4 passed.

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0.

- [ ] **Step 6: Commit, check the size, open the draft PR**

```bash
git add -A
git commit -m "feat(auth): throttle interface, policies and client address" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git diff main...HEAD --numstat -- . ':!pnpm-lock.yaml' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
git push -u origin feat/m1-throttle
gh pr create --draft --base main --head feat/m1-throttle --title "feat(auth): throttle interface, policies and client address" --body "$(cat <<'EOF'
## Summary
- Throttle (retryAfter / fail / clear) and the four policies for login and sign-up, per client address and per email: free allowance, then exponential locks capped at 15 min (1 h for sign-up), decaying when left alone, so no lock is ever permanent. Account keys are a sha256 of the email.
- clientIp trusts only the socket unless told to trust one proxy hop (then the last X-Forwarded-For entry).
- Owner-requested rate limiting (not in the spec). Nothing uses it yet; the routes in PRs 6k-6l do.

## Not counted toward the 200-line / 10-file limit
None.

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: about `129 lines, 5 files`, then the PR URL.

---

# PR 6i: the in-memory throttle and the Throttle conformance suite

**Branch:** `feat/m1-throttle-memory`  **Budget:** 4 files, 139 lines. Spec §9 item 6, part 9 of 14.

### Task 25: `MemoryThrottle` and `runThrottleConformance`

**Files:**
- Create: `/Users/such/workspace/docmind/packages/auth/src/memoryThrottle.ts`, `throttleConformance.ts`, `memoryThrottle.test.ts`
- Modify: `/Users/such/workspace/docmind/packages/auth/src/testing.ts`

**Interfaces:**
- Consumes: `Throttle`, `ThrottlePolicy`, `lockSeconds` (PR 6h).
- Produces (from `@docmind/auth/testing`): `class MemoryThrottle implements Throttle` with a settable `now: () => number` (milliseconds); `interface ThrottleHarness { throttle: Throttle; advance(seconds: number): Promise<void> }`; `runThrottleConformance(make: () => ThrottleHarness | Promise<ThrottleHarness>, label?: string): void`. The suite checks: no lock within the free allowance; the base lock and its expiry; doubling; the cap; decay; `clear`; and the longest lock across several keys. It never sleeps: `advance` moves time.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m1-throttle-memory
```

- [ ] **Step 2: Write the failing test**

`packages/auth/src/memoryThrottle.test.ts`:

```ts
import { MemoryThrottle } from "./memoryThrottle";
import { runThrottleConformance } from "./throttleConformance";

runThrottleConformance(() => {
  const throttle = new MemoryThrottle();
  let offset = 0;
  throttle.now = () => Date.now() + offset;
  return {
    throttle,
    advance: async (seconds) => {
      offset += seconds * 1000;
    },
  };
}, "MemoryThrottle");
```

- [ ] **Step 3: Run it to see it fail**

```bash
pnpm --filter @docmind/auth test
```

Expected: FAIL, `Failed to resolve import "./memoryThrottle"`.

- [ ] **Step 4: Implement**

`packages/auth/src/memoryThrottle.ts`:

```ts
import { type Throttle, type ThrottlePolicy, lockSeconds } from "./throttle";

interface Row {
  failures: number;
  lockedUntil: number;
  updatedAt: number;
}

/** A Throttle in memory, for tests of everything built on the interface. `now` is settable. */
export class MemoryThrottle implements Throttle {
  now: () => number = () => Date.now();
  private readonly rows = new Map<string, Row>();

  async retryAfter(keys: readonly string[]): Promise<number> {
    const now = this.now();
    let wait = 0;
    for (const key of keys) {
      const row = this.rows.get(key);
      if (row && row.lockedUntil > now)
        wait = Math.max(wait, Math.ceil((row.lockedUntil - now) / 1000));
    }
    return wait;
  }

  async fail(key: string, policy: ThrottlePolicy): Promise<void> {
    const now = this.now();
    const old = this.rows.get(key);
    const stale = !old || now - old.updatedAt >= policy.decaySeconds * 1000;
    const failures = stale ? 1 : old.failures + 1;
    const lock = lockSeconds(policy, failures);
    const lockedUntil = lock > 0 ? now + lock * 1000 : stale ? now : (old?.lockedUntil ?? now);
    this.rows.set(key, { failures, lockedUntil, updatedAt: now });
  }

  async clear(key: string): Promise<void> {
    this.rows.delete(key);
  }
}
```

`packages/auth/src/throttleConformance.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Throttle, ThrottlePolicy } from "./throttle";

/** What the suite needs: the throttle, and a way to move time forward without waiting. */
export interface ThrottleHarness {
  throttle: Throttle;
  advance(seconds: number): Promise<void>;
}

const P: ThrottlePolicy = { free: 2, baseSeconds: 10, capSeconds: 60, decaySeconds: 300 };

/** The suite every Throttle implementation must pass. */
export function runThrottleConformance(
  make: () => ThrottleHarness | Promise<ThrottleHarness>,
  label = "Throttle",
): void {
  const failTimes = async (t: Throttle, key: string, n: number) => {
    for (let i = 0; i < n; i++) await t.fail(key, P);
  };

  describe(`${label} conformance`, () => {
    it("does not lock until the free failures are used up", async () => {
      const { throttle } = await make();
      await failTimes(throttle, "k", 2);
      expect(await throttle.retryAfter(["k"])).toBe(0);
    });

    it("locks for the base time on the first failure over, and the lock runs out", async () => {
      const { throttle, advance } = await make();
      await failTimes(throttle, "k", 3);
      const wait = await throttle.retryAfter(["k"]);
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(10);
      await advance(10);
      expect(await throttle.retryAfter(["k"])).toBe(0);
    });

    it("doubles the lock with each further failure", async () => {
      const { throttle, advance } = await make();
      await failTimes(throttle, "k", 3);
      await advance(10);
      await failTimes(throttle, "k", 1);
      const wait = await throttle.retryAfter(["k"]);
      expect(wait).toBeGreaterThan(10);
      expect(wait).toBeLessThanOrEqual(20);
    });

    it("never locks for longer than the cap", async () => {
      const { throttle, advance } = await make();
      for (let i = 0; i < 12; i++) {
        await failTimes(throttle, "k", 1);
        await advance(100);
      }
      await failTimes(throttle, "k", 1);
      const wait = await throttle.retryAfter(["k"]);
      expect(wait).toBeGreaterThan(30);
      expect(wait).toBeLessThanOrEqual(60);
    });

    it("starts again from zero once a key has been left alone for the decay time", async () => {
      const { throttle, advance } = await make();
      await failTimes(throttle, "k", 5);
      await advance(301);
      await failTimes(throttle, "k", 1);
      expect(await throttle.retryAfter(["k"])).toBe(0);
    });

    it("forgets a key that is cleared", async () => {
      const { throttle } = await make();
      await failTimes(throttle, "k", 4);
      await throttle.clear("k");
      expect(await throttle.retryAfter(["k"])).toBe(0);
    });

    it("answers with the longest lock among the keys, and keeps keys apart", async () => {
      const { throttle } = await make();
      await failTimes(throttle, "a", 3);
      await failTimes(throttle, "b", 4);
      const both = await throttle.retryAfter(["a", "b", "c"]);
      expect(both).toBeGreaterThan(10);
      expect(await throttle.retryAfter(["c"])).toBe(0);
      expect(await throttle.retryAfter(["a"])).toBeLessThanOrEqual(10);
    });
  });
}
```

`packages/auth/src/testing.ts`:

```ts
export * from "./conformance";
export * from "./throttleConformance";
export { MemoryAuthStore } from "./memoryStore";
export { MemoryThrottle } from "./memoryThrottle";
```

- [ ] **Step 5: Run the test, then the gate**

```bash
pnpm --filter @docmind/auth test
```

Expected: `memoryThrottle.test.ts` 7 passed.

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0.

- [ ] **Step 6: Commit, check the size, open the draft PR**

```bash
git add -A
git commit -m "feat(auth): MemoryThrottle and the Throttle conformance suite" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git diff main...HEAD --numstat -- . ':!pnpm-lock.yaml' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
git push -u origin feat/m1-throttle-memory
gh pr create --draft --base main --head feat/m1-throttle-memory --title "feat(auth): MemoryThrottle and the Throttle conformance suite" --body "$(cat <<'EOF'
## Summary
- runThrottleConformance: the suite every Throttle must pass (free allowance, base lock and expiry, doubling, cap, decay, clear, longest lock across keys), driven by an advance() hook so nothing sleeps.
- MemoryThrottle with an injectable clock, for route tests. The Postgres throttle (PR 6j) runs the same suite.

## Not counted toward the 200-line / 10-file limit
None.

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: about `139 lines, 4 files`, then the PR URL.

---

# PR 6j: the Postgres throttle

**Branch:** `feat/m1-throttle-sql`  **Budget:** 3 files, 159 lines. Spec §9 item 6, part 10 of 14.

### Task 26: `auth_throttle` (migration 0006) and `PgThrottle`

**Files:**
- Create: `/Users/such/workspace/docmind/infra/migrations/0006_auth_throttle.sql`, `apps/server/app/auth/pgThrottle.ts`, `pgThrottle.test.ts`

**Interfaces:**
- Consumes: `Throttle`, `ThrottlePolicy` (PR 6h); `runThrottleConformance` from `@docmind/auth/testing` (PR 6i); the test helpers `createTestDb`, `migrate`, `setAppRolePassword`.
- Produces: SQL `throttle_retry_after(p_keys text[]) RETURNS integer`, `throttle_fail(p_key text, p_free integer, p_base integer, p_cap integer, p_decay integer) RETURNS void`, `throttle_clear(p_key text) RETURNS void`, `throttle_purge() RETURNS bigint`, all `SECURITY DEFINER` with a pinned `search_path` and an explicit grant to `docmind_app`; table `auth_throttle (key text PRIMARY KEY, failures integer, locked_until timestamptz, updated_at timestamptz)`. TypeScript `class PgThrottle implements Throttle { constructor(pool: Pool); purge(): Promise<number> }`, `pool` connected as `docmind_app`.

**Storage choice.** Postgres, because the counters must survive a restart and be shared by every server instance behind a load balancer (an in-process map would give each instance its own allowance and forget on deploy). No new infrastructure. Like `data_keys`, the table has row-level security **enabled with no policy** and **no privilege for `docmind_app`**: throttling happens before any tenant is known, so a tenant policy cannot describe it, and the app reaches it only through four functions. Rows hold an address or a hash of an email and are deleted a day after their last use (`throttle_purge`, run hourly by the server), so the table is not a log of who logged in.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m1-throttle-sql
```

- [ ] **Step 2: Write the failing test**

It runs the whole Throttle conformance suite on Postgres (time moves by shifting the stored timestamps, as the owner), then checks the purge and that `docmind_app` cannot touch the table directly. `apps/server/app/auth/pgThrottle.test.ts`:

```ts
import { runThrottleConformance } from "@docmind/auth/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword } from "../db/migrate";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";
import { PgThrottle } from "./pgThrottle";

describe.skipIf(!PG_URL)("PgThrottle (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;
  const policy = { free: 0, baseSeconds: 1, capSeconds: 1, decaySeconds: 60 };

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    app = new Pool({ connectionString: db.appUrl });
  });

  afterAll(async () => {
    await app?.end();
    await db?.drop();
  });

  // Time moves by shifting the stored timestamps back, so the suite never waits.
  runThrottleConformance(async () => {
    await db.owner.query("TRUNCATE auth_throttle");
    return {
      throttle: new PgThrottle(app),
      advance: async (seconds) => {
        await db.owner.query(
          `UPDATE auth_throttle SET locked_until = locked_until - make_interval(secs => $1::float8),
                                    updated_at = updated_at - make_interval(secs => $1::float8)`,
          [seconds],
        );
      },
    };
  }, "PgThrottle");

  it("purges counters that are unlocked and a day old, and only those", async () => {
    await db.owner.query("TRUNCATE auth_throttle");
    const throttle = new PgThrottle(app);
    await throttle.fail("old", policy);
    await throttle.fail("recent", policy);
    await db.owner.query(
      "UPDATE auth_throttle SET updated_at = now() - interval '2 days', locked_until = now() - interval '2 days' WHERE key = 'old'",
    );
    expect(await throttle.purge()).toBe(1);
    const { rows } = await db.owner.query("SELECT key FROM auth_throttle");
    expect(rows).toEqual([{ key: "recent" }]);
  });

  it("is a table the app role can only reach through the functions", async () => {
    await expect(app.query("SELECT * FROM auth_throttle")).rejects.toThrow(/permission denied/);
    await expect(app.query("DELETE FROM auth_throttle")).rejects.toThrow(/permission denied/);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm --filter @docmind/server exec vitest run app/auth/pgThrottle.test.ts
```

Expected: FAIL, `Failed to resolve import "./pgThrottle"`.

- [ ] **Step 4: Implement**

`infra/migrations/0006_auth_throttle.sql`:

```sql
-- Failure counters behind login and sign-up throttling (packages/auth/src/throttle.ts). A key is
-- "<scope>-ip:<address>" or "<scope>-acct:<sha256 of the email>", so no address of a person is stored
-- and an email that does not exist is counted like one that does. The counters are in Postgres so
-- they survive restarts and are shared by every server instance.
CREATE TABLE auth_throttle (
  key text PRIMARY KEY,
  failures integer NOT NULL,
  locked_until timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

-- Throttling happens before any tenant is known, so there is no tenant policy: docmind_app gets no
-- privilege on the table and reaches it only through the functions below.
ALTER TABLE auth_throttle ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON auth_throttle FROM docmind_app;

-- Seconds until the last of these keys unlocks; 0 when none is locked.
CREATE FUNCTION throttle_retry_after(p_keys text[])
  RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT COALESCE(ceil(max(extract(epoch FROM t.locked_until - now())))::integer, 0)
          FROM public.auth_throttle t WHERE t.key = ANY (p_keys) AND t.locked_until > now() $$;

-- Counts one failure. Past the free allowance the key is locked for base * 2^(n - free - 1) seconds,
-- at most cap. A key idle for p_decay seconds starts again from one failure.
CREATE FUNCTION throttle_fail(p_key text, p_free integer, p_base integer, p_cap integer, p_decay integer)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  n integer;
BEGIN
  INSERT INTO public.auth_throttle AS t (key, failures, locked_until, updated_at)
    VALUES (p_key, 1, now(), now())
    ON CONFLICT (key) DO UPDATE SET
      failures = CASE WHEN t.updated_at <= now() - make_interval(secs => p_decay)
                      THEN 1 ELSE t.failures + 1 END,
      locked_until = CASE WHEN t.updated_at <= now() - make_interval(secs => p_decay)
                          THEN now() ELSE t.locked_until END,
      updated_at = now()
    RETURNING t.failures INTO n;
  IF n > p_free THEN
    UPDATE public.auth_throttle
       SET locked_until = now() + make_interval(
             secs => least(p_cap::float8, p_base::float8 * power(2, least(n - p_free - 1, 30))))
     WHERE key = p_key;
  END IF;
END
$$;

CREATE FUNCTION throttle_clear(p_key text)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ DELETE FROM public.auth_throttle WHERE key = p_key $$;

-- Drops counters that are unlocked and untouched for a day; returns how many.
CREATE FUNCTION throttle_purge()
  RETURNS bigint
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ WITH gone AS (DELETE FROM public.auth_throttle
                       WHERE updated_at < now() - interval '1 day' AND locked_until < now()
                       RETURNING 1)
        SELECT count(*) FROM gone $$;

REVOKE ALL ON FUNCTION throttle_retry_after(text[]), throttle_fail(text, integer, integer, integer, integer),
  throttle_clear(text), throttle_purge() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION throttle_retry_after(text[]), throttle_fail(text, integer, integer, integer, integer),
  throttle_clear(text), throttle_purge() TO docmind_app;
```

`apps/server/app/auth/pgThrottle.ts`:

```ts
import type { Throttle, ThrottlePolicy } from "@docmind/auth";
import type { Pool } from "pg";

/** Throttle on Postgres (migration 0006), connected as docmind_app. */
export class PgThrottle implements Throttle {
  constructor(private readonly pool: Pool) {}

  async retryAfter(keys: readonly string[]): Promise<number> {
    const { rows } = await this.pool.query("SELECT throttle_retry_after($1::text[]) AS wait", [
      keys,
    ]);
    return rows[0].wait;
  }

  async fail(key: string, p: ThrottlePolicy): Promise<void> {
    await this.pool.query("SELECT throttle_fail($1, $2, $3, $4, $5)", [
      key,
      p.free,
      p.baseSeconds,
      p.capSeconds,
      p.decaySeconds,
    ]);
  }

  async clear(key: string): Promise<void> {
    await this.pool.query("SELECT throttle_clear($1)", [key]);
  }

  /** Deletes counters that are unlocked and idle for a day; returns how many. */
  async purge(): Promise<number> {
    const { rows } = await this.pool.query("SELECT throttle_purge() AS n");
    return Number(rows[0].n);
  }
}
```

- [ ] **Step 5: Run the test, then the gate**

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm --filter @docmind/server exec vitest run app/auth/pgThrottle.test.ts
```

Expected: `9 passed` (7 conformance + purge + privileges).

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0 (the M0 "RLS on every table" guard passes: `auth_throttle` has RLS enabled).

- [ ] **Step 6: Commit, check the size, open the draft PR**

```bash
git add -A
git commit -m "feat(db): Postgres-backed throttle behind SECURITY DEFINER functions" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git diff main...HEAD --numstat -- . ':!pnpm-lock.yaml' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
git push -u origin feat/m1-throttle-sql
gh pr create --draft --base main --head feat/m1-throttle-sql --title "feat(db): Postgres-backed throttle behind SECURITY DEFINER functions" --body "$(cat <<'EOF'
## Summary
- Migration 0006: auth_throttle plus throttle_retry_after/fail/clear/purge (SECURITY DEFINER, pinned search_path, explicit grants). RLS on, no policy, no privileges for docmind_app: throttling is pre-tenant, and the app can only use the functions. Postgres so counters survive restarts and are shared across instances.
- PgThrottle passes runThrottleConformance (same suite as MemoryThrottle); counters older than a day and unlocked are purged.
- Nothing mounts it yet (PR 6n).

## Not counted toward the 200-line / 10-file limit
None.

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test` (with DOCMIND_TEST_PG_URL)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: about `159 lines, 3 files`, then the PR URL.

---

# PR 6k: the sign-up route

**Branch:** `feat/m1-signup-route`  **Budget:** 4 files, 175 lines. Spec §9 item 6, part 11 of 14. Not mounted until PR 6n.

### Task 27: `POST /api/auth/sign-up` that does not reveal whether the email is registered

**Files:**
- Create: `/Users/such/workspace/docmind/apps/server/app/auth/routes.ts`, `routes.test.ts`
- Modify: `/Users/such/workspace/docmind/packages/contracts/src/auth.ts`, `auth.test.ts`

**Interfaces:**
- Consumes: `AuthService` (PR 6e: `signUp(email, password): Promise<boolean>`); `Throttle`, `POLICIES`, `ipKey`, `accountKey`, `clientIp` (`@docmind/auth`, PRs 6h-6i); `readJson` (PR 6g); `Handler`, `json`, `sendError` (PR 5c); `SignUpRequest` (`@docmind/contracts`, M0).
- Produces: contracts `SignUpResponse = { status: "accepted" }` (schema and same-named type); `interface AuthRoutesDeps { service: AuthService; throttle: Throttle; trustProxy: boolean }` (extended in the next PRs) and `authRoutes(deps): Record<string, Handler>` with `POST /api/auth/sign-up`: 202 `SignUpResponse` and **no cookie** for a new email and for a taken one alike; 400 for a short password (before anything is counted); 429 `too_many_requests` with `Retry-After` when the address or the email is locked.

**Design: a uniform 202, no session, then the client logs in.** Sign-up used to start a session and answer `201` with the account, or `409` for a taken email; both reveal whether an email is registered. Now the route does the same thing for both cases: it counts the attempt, hashes the password (argon2id, the expensive part, before the database is asked), calls `auth_sign_up` once, and answers `202 {"status":"accepted"}` with the same headers and no `Set-Cookie`. The work, the status, the headers and the body are identical, and a test asserts the responses are byte-identical for a new email and a taken one (the clock-dependent `Date` header aside). A taken email's existing password is never changed. The client then calls login, which creates the session.

**The residual channel, stated plainly.** Sign-up followed by login still leaks: for a new email, logging in with the password just submitted succeeds; for a taken email it fails (unless the submitter knew the owner's password). So an attacker can still learn "registered" at the price of two requests per email. Two things bound that: the sign-up and login rate limits (per address and per email, in this plan) make large-scale enumeration slow, and it creates a throwaway account for every unregistered email probed. **Email verification would close it** (the response then cannot depend on whether the email was new, because the account is only usable after the owner confirms); the spec has no email infrastructure, so that stays out of M1. Timing is comparable by construction (same hash, one database call each); no timing assertion is made, per the test hygiene rules.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m1-signup-route
```

- [ ] **Step 2: Write the failing tests**

Contract test, appended to `packages/contracts/src/auth.test.ts`:

```diff
@@ -1,4 +1,4 @@
 import { describe, expect, it } from "vitest";
-import { ErrorBody, LoginRequest, MeResponse, SignUpRequest } from "./index";
+import { ErrorBody, LoginRequest, MeResponse, SignUpRequest, SignUpResponse } from "./index";
 
 const ID = "11111111-1111-4111-8111-111111111111";
@@ -34,3 +34,8 @@ describe("auth contracts", () => {
     expect(ErrorBody.safeParse({ error: "no" }).success).toBe(false);
   });
+
+  it("answers sign-up with the one accepted body", () => {
+    expect(SignUpResponse.parse({ status: "accepted" })).toEqual({ status: "accepted" });
+    expect(SignUpResponse.safeParse({ status: "exists" }).success).toBe(false);
+  });
 });
```

Route test (in-memory store and throttle with a fixed clock, through a real HTTP server, so no database is needed). `apps/server/app/auth/routes.test.ts`:

```ts
import type { AddressInfo } from "node:net";
import { AuthService } from "@docmind/auth";
import { MemoryAuthStore, MemoryThrottle } from "@docmind/auth/testing";
import { ErrorBody, SignUpResponse } from "@docmind/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpServer } from "../server";
import { authRoutes } from "./routes";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const PASSWORD = "correct horse battery";

/** A fresh server, store and throttle per test. The clock is fixed, so a lock never runs out. */
async function start(trustProxy = false) {
  const store = new MemoryAuthStore();
  const throttle = new MemoryThrottle();
  throttle.now = () => 1_000_000;
  const server = createHttpServer(
    authRoutes({ service: new AuthService(store), throttle, trustProxy }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    store,
    signUp: (email: string, password = PASSWORD, headers: Record<string, string> = {}) =>
      fetch(`${base}/api/auth/sign-up`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ email, password }),
      }),
  };
}

/** Everything a client can see of a response except the Date header. */
async function wire(res: Response) {
  const headers = [...res.headers.entries()].filter(([name]) => name !== "date");
  return { status: res.status, headers, body: await res.text() };
}

describe("sign-up", () => {
  it("answers 202 with no cookie, and creates the account", async () => {
    const api = await start();
    const res = await api.signUp("Ada@Example.com");
    expect(res.status).toBe(202);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(SignUpResponse.parse(await res.json())).toEqual({ status: "accepted" });
    expect((await api.store.findLogin("ada@example.com"))?.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it("answers a new email and a taken one with byte-identical responses", async () => {
    const api = await start();
    const fresh = await wire(await api.signUp("new@example.com"));
    const taken = await wire(await api.signUp("new@example.com", "another long password"));
    expect(taken).toEqual(fresh);
  });

  it("leaves a taken email's password alone", async () => {
    const api = await start();
    await api.signUp("ada@example.com");
    const first = await api.store.findLogin("ada@example.com");
    await api.signUp("ada@example.com", "another long password");
    expect(await api.store.findLogin("ada@example.com")).toEqual(first);
  });

  it("rejects a short password with 400, before anything is counted", async () => {
    const api = await start();
    expect((await api.signUp("b@example.com", "short")).status).toBe(400);
  });

  it("limits sign-ups per address, then answers 429 with Retry-After", async () => {
    const api = await start();
    for (let i = 0; i < 6; i++) await api.signUp(`user${i}@example.com`);
    const res = await api.signUp("next@example.com");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(ErrorBody.parse(await res.json()).error.code).toBe("too_many_requests");
  });

  it("limits sign-ups per email, whether or not it is registered", async () => {
    const api = await start();
    for (let i = 0; i < 4; i++) await api.signUp("same@example.com");
    expect((await api.signUp("same@example.com")).status).toBe(429);
  });

  it("ignores X-Forwarded-For unless the proxy is trusted", async () => {
    const spoofed = await start(false);
    for (let i = 0; i < 6; i++) {
      await spoofed.signUp(`u${i}@example.com`, PASSWORD, { "x-forwarded-for": `10.0.0.${i}` });
    }
    const blocked = await spoofed.signUp("v@example.com", PASSWORD, {
      "x-forwarded-for": "10.9.9.9",
    });
    expect(blocked.status).toBe(429);

    const proxied = await start(true);
    for (let i = 0; i < 7; i++) {
      const res = await proxied.signUp(`u${i}@example.com`, PASSWORD, {
        "x-forwarded-for": `10.0.0.${i}`,
      });
      expect(res.status).toBe(202);
    }
  });
});
```

- [ ] **Step 3: Run them to see them fail**

```bash
pnpm --filter @docmind/contracts typecheck:tests
pnpm --filter @docmind/server exec vitest run app/auth/routes.test.ts
```

Expected: FAIL, `Module '"./index"' has no exported member 'SignUpResponse'`, and `Failed to resolve import "./routes"`.

- [ ] **Step 4: Implement**

```diff
@@ -19,5 +19,12 @@ export const LoginRequest = z.object({
 export type LoginRequest = z.infer<typeof LoginRequest>;
 
-/** `GET /api/me`, and the body of a successful sign-up or login. */
+/**
+ * The only body sign-up ever answers with (202), whether or not the email was already registered:
+ * it must not reveal which emails have accounts. The client then logs in.
+ */
+export const SignUpResponse = z.object({ status: z.literal("accepted") });
+export type SignUpResponse = z.infer<typeof SignUpResponse>;
+
+/** `GET /api/me`, and the body of a successful login. */
 export const MeResponse = z.object({ userId: Uuid, tenantId: Uuid, email: Email });
 export type MeResponse = z.infer<typeof MeResponse>;
```

`apps/server/app/auth/routes.ts`:

```ts
import {
  type AuthService,
  POLICIES,
  type Throttle,
  accountKey,
  clientIp,
  ipKey,
} from "@docmind/auth";
import { SignUpRequest, type SignUpResponse } from "@docmind/contracts";
import { readJson } from "../http/body";
import { type Handler, json, sendError } from "../http/respond";

export interface AuthRoutesDeps {
  service: AuthService;
  throttle: Throttle;
  /** Believe X-Forwarded-For (its last entry) for the client address. Only behind one proxy of yours. */
  trustProxy: boolean;
}

/** 429 with Retry-After. The body says nothing about whether the account exists. */
function tooMany(res: Parameters<Handler>[1], seconds: number): void {
  res.setHeader("retry-after", String(seconds));
  sendError(res, 429, "too_many_requests", "too many attempts; try again later");
}

/** Sign-up. (Login, logout and `GET /api/me` follow in the next PRs.) */
export function authRoutes(deps: AuthRoutesDeps): Record<string, Handler> {
  const { service, throttle, trustProxy } = deps;

  return {
    // Answers the same 202 whether or not the email is registered, and never sets a cookie, so the
    // response cannot tell the two apart; the client then logs in. Every attempt is counted.
    "POST /api/auth/sign-up": async (req, res) => {
      const body = await readJson(req, res, SignUpRequest);
      if (!body) return;
      const ip = ipKey("signup", clientIp(req, trustProxy));
      const account = accountKey("signup", body.email);
      const wait = await throttle.retryAfter([ip, account]);
      if (wait > 0) return tooMany(res, wait);
      await throttle.fail(ip, POLICIES.signUpIp);
      await throttle.fail(account, POLICIES.signUpAccount);
      await service.signUp(body.email, body.password);
      json(res, 202, { status: "accepted" } satisfies SignUpResponse);
    },
  };
}
```

- [ ] **Step 5: Run the tests, then the gate**

```bash
pnpm build
pnpm --filter @docmind/server exec vitest run app/auth/routes.test.ts
```

Expected: `7 passed`.

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0.

- [ ] **Step 6: Commit, check the size, open the draft PR**

```bash
git add -A
git commit -m "feat(server): sign-up route that does not reveal registered emails" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git diff main...HEAD --numstat -- . ':!pnpm-lock.yaml' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
git push -u origin feat/m1-signup-route
gh pr create --draft --base main --head feat/m1-signup-route --title "feat(server): sign-up route that does not reveal registered emails" --body "$(cat <<'EOF'
## Summary
- POST /api/auth/sign-up always answers 202 {"status":"accepted"} with no cookie, for a new email and a taken one alike (tested byte-identical; both paths hash the password and make one database call). The user then logs in. The owner rejected the earlier 409.
- Every attempt is throttled per client address and per email (429 + Retry-After). X-Forwarded-For is ignored unless trustProxy is set (tested).
- Residual channel (documented in the plan): sign-up then login still tells an attacker whether an email was registered; the rate limits slow it, email verification would close it.
- Contracts: SignUpResponse. Not mounted yet (PR 6n).

## Not counted toward the 200-line / 10-file limit
None.

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: about `175 lines, 4 files`, then the PR URL.

---

# PR 6l: the login route

**Branch:** `feat/m1-login-route`  **Budget:** 2 files, 106 lines. Spec §9 item 6, part 12 of 14.

### Task 28: `POST /api/auth/login`, throttled

**Files:**
- Modify: `/Users/such/workspace/docmind/apps/server/app/auth/routes.ts`, `routes.test.ts`

**Interfaces:**
- Consumes: everything from PR 6k; `LoginRequest`, `MeResponse` (`@docmind/contracts`); `sessionCookie`, `SESSION_TTL_MS` (`@docmind/auth`); `AuthService.logIn`.
- Produces: `AuthRoutesDeps` gains `secureCookies: boolean`; `POST /api/auth/login`: 200 `MeResponse` and `Set-Cookie` on success; 401 `invalid_credentials` for a wrong password and an unknown email, byte-identical; 429 with `Retry-After` while the address or the email is locked, **checked before the password**, so a locked caller learns nothing and the right password does not help until the lock runs out. Failures count against the address (`loginIp`) and the email (`loginAccount`); a success forgets the email's count.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m1-login-route
```

- [ ] **Step 2: Write the failing tests**

Replace `apps/server/app/auth/routes.test.ts` (the sign-up tests stay; the server now needs `secureCookies`, and the login tests are added):

```diff
@@ -2,5 +2,5 @@ import type { AddressInfo } from "node:net";
 import { AuthService } from "@docmind/auth";
 import { MemoryAuthStore, MemoryThrottle } from "@docmind/auth/testing";
-import { ErrorBody, SignUpResponse } from "@docmind/contracts";
+import { ErrorBody, MeResponse, SignUpResponse } from "@docmind/contracts";
 import { afterEach, describe, expect, it } from "vitest";
 import { createHttpServer } from "../server";
@@ -20,5 +20,5 @@ async function start(trustProxy = false) {
   throttle.now = () => 1_000_000;
   const server = createHttpServer(
-    authRoutes({ service: new AuthService(store), throttle, trustProxy }),
+    authRoutes({ service: new AuthService(store), throttle, secureCookies: false, trustProxy }),
   );
   await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
@@ -33,4 +33,10 @@ async function start(trustProxy = false) {
   return {
     store,
+    logIn: (email: string, password = PASSWORD) =>
+      fetch(`${base}/api/auth/login`, {
+        method: "POST",
+        headers: { "content-type": "application/json" },
+        body: JSON.stringify({ email, password }),
+      }),
     signUp: (email: string, password = PASSWORD, headers: Record<string, string> = {}) =>
       fetch(`${base}/api/auth/sign-up`, {
@@ -112,2 +118,63 @@ describe("sign-up", () => {
   });
 });
+
+describe("login", () => {
+  it("logs in after sign-up, with an HttpOnly session cookie", async () => {
+    const api = await start();
+    await api.signUp("Ada@Example.com");
+    const res = await api.logIn("ada@example.com");
+    expect(res.status).toBe(200);
+    expect(MeResponse.parse(await res.json()).email).toBe("ada@example.com");
+    expect(res.headers.get("set-cookie")).toMatch(
+      /^dm_session=[\w-]{43}; .*HttpOnly.*SameSite=Lax/,
+    );
+  });
+
+  it("answers the same 401 for a wrong password and an unknown email", async () => {
+    const api = await start();
+    await api.signUp("ada@example.com");
+    const wrong = await api.logIn("ada@example.com", "wrong password here");
+    const unknown = await api.logIn("nobody@example.com");
+    expect([wrong.status, unknown.status]).toEqual([401, 401]);
+    expect(await wrong.text()).toBe(await unknown.text());
+  });
+
+  it("locks an email after five failures, even against the right password", async () => {
+    const api = await start();
+    await api.signUp("ada@example.com");
+    for (let i = 0; i < 6; i++) {
+      expect((await api.logIn("ada@example.com", "wrong password here")).status).toBe(401);
+    }
+    const locked = await api.logIn("ada@example.com");
+    expect(locked.status).toBe(429);
+    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
+  });
+
+  it("answers a locked email that exists exactly like one that does not", async () => {
+    const api = await start();
+    await api.signUp("ada@example.com");
+    const lockOut = async (email: string) => {
+      for (let i = 0; i < 6; i++) await api.logIn(email, "wrong password here");
+      return wire(await api.logIn(email));
+    };
+    const known = await lockOut("ada@example.com");
+    const unknown = await lockOut("nobody@example.com");
+    expect(known.status).toBe(429);
+    expect(unknown).toEqual(known);
+  });
+
+  it("forgets an email's failures after a successful login", async () => {
+    const api = await start();
+    await api.signUp("ada@example.com");
+    for (let round = 0; round < 2; round++) {
+      for (let i = 0; i < 4; i++) await api.logIn("ada@example.com", "wrong password here");
+      expect((await api.logIn("ada@example.com")).status).toBe(200);
+    }
+  });
+
+  it("locks a client address after 20 failed logins, whatever emails it tries", async () => {
+    const api = await start();
+    for (let i = 0; i < 21; i++) await api.logIn(`user${i}@example.com`);
+    expect((await api.logIn("another@example.com")).status).toBe(429);
+  });
+});
```

- [ ] **Step 3: Run them to see them fail**

```bash
pnpm --filter @docmind/server exec vitest run app/auth/routes.test.ts
```

Expected: FAIL: `POST /api/auth/login` is a 404 (`no such route`).

- [ ] **Step 4: Implement**

```diff
@@ -2,10 +2,17 @@ import {
   type AuthService,
   POLICIES,
+  SESSION_TTL_MS,
   type Throttle,
   accountKey,
   clientIp,
   ipKey,
+  sessionCookie,
 } from "@docmind/auth";
-import { SignUpRequest, type SignUpResponse } from "@docmind/contracts";
+import {
+  LoginRequest,
+  type MeResponse,
+  SignUpRequest,
+  type SignUpResponse,
+} from "@docmind/contracts";
 import { readJson } from "../http/body";
 import { type Handler, json, sendError } from "../http/respond";
@@ -14,4 +21,6 @@ export interface AuthRoutesDeps {
   service: AuthService;
   throttle: Throttle;
+  /** Mark the session cookie Secure: set it for any deployment served over HTTPS. */
+  secureCookies: boolean;
   /** Believe X-Forwarded-For (its last entry) for the client address. Only behind one proxy of yours. */
   trustProxy: boolean;
@@ -24,7 +33,7 @@ function tooMany(res: Parameters<Handler>[1], seconds: number): void {
 }
 
-/** Sign-up. (Login, logout and `GET /api/me` follow in the next PRs.) */
+/** Sign-up and login. (Logout and `GET /api/me` follow in the next PR.) */
 export function authRoutes(deps: AuthRoutesDeps): Record<string, Handler> {
-  const { service, throttle, trustProxy } = deps;
+  const { service, throttle, secureCookies, trustProxy } = deps;
 
   return {
@@ -43,4 +52,24 @@ export function authRoutes(deps: AuthRoutesDeps): Record<string, Handler> {
       json(res, 202, { status: "accepted" } satisfies SignUpResponse);
     },
+
+    // Failures count against the client address and against the email (known or not); a success
+    // forgets the email's count. A lock is checked first, so a locked caller learns nothing.
+    "POST /api/auth/login": async (req, res) => {
+      const body = await readJson(req, res, LoginRequest);
+      if (!body) return;
+      const ip = ipKey("login", clientIp(req, trustProxy));
+      const account = accountKey("login", body.email);
+      const wait = await throttle.retryAfter([ip, account]);
+      if (wait > 0) return tooMany(res, wait);
+      const started = await service.logIn(body.email, body.password);
+      if (!started) {
+        await throttle.fail(ip, POLICIES.loginIp);
+        await throttle.fail(account, POLICIES.loginAccount);
+        return sendError(res, 401, "invalid_credentials", "email or password is incorrect");
+      }
+      await throttle.clear(account);
+      res.setHeader("set-cookie", sessionCookie(started.token, SESSION_TTL_MS, secureCookies));
+      json(res, 200, { ...started.identity, email: body.email } satisfies MeResponse);
+    },
   };
 }
```

- [ ] **Step 5: Run the tests, then the gate**

```bash
pnpm --filter @docmind/server exec vitest run app/auth/routes.test.ts
```

Expected: `13 passed` (7 sign-up + 6 login).

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0.

- [ ] **Step 6: Commit, check the size, open the draft PR**

```bash
git add -A
git commit -m "feat(server): throttled login route" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git diff main...HEAD --numstat -- . ':!pnpm-lock.yaml' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
git push -u origin feat/m1-login-route
gh pr create --draft --base main --head feat/m1-login-route --title "feat(server): throttled login route" --body "$(cat <<'EOF'
## Summary
- POST /api/auth/login: 200 + HttpOnly session cookie; 401 identical for a wrong password and an unknown email. Locks per email (5 free failures, then exponential up to 15 min) and per address (20 free), checked before the password: a locked caller gets 429 + Retry-After, the right password does not help until the lock expires, and a locked unknown email answers byte-identically to a locked real one (tested). A success forgets the email's failures.
- Not mounted yet (PR 6n).

## Not counted toward the 200-line / 10-file limit
None.

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: about `106 lines, 2 files`, then the PR URL.

---

# PR 6m: logout and `GET /api/me`

**Branch:** `feat/m1-auth-session-routes`  **Budget:** 2 files, 76 lines. Spec §9 item 6, part 13 of 14.

### Task 29: the session routes

**Files:**
- Modify: `/Users/such/workspace/docmind/apps/server/app/auth/routes.ts`, `routes.test.ts`

**Interfaces:**
- Consumes: everything from PR 6l; `requireAuth` (PR 5d); `Authenticator`, `AuthStore`, `readSessionCookie`, `clearedSessionCookie` (`@docmind/auth`).
- Produces: `AuthRoutesDeps` gains `authenticator: Authenticator` and `store: AuthStore`; `POST /api/auth/logout` (always 204 and a cleared cookie; ends only the calling session; safe to repeat) and `GET /api/me` (200 `MeResponse`; 401 without a live session).

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m1-auth-session-routes
```

- [ ] **Step 2: Write the failing tests**

```diff
@@ -1,4 +1,4 @@
 import type { AddressInfo } from "node:net";
-import { AuthService } from "@docmind/auth";
+import { AuthService, PasswordAuthenticator } from "@docmind/auth";
 import { MemoryAuthStore, MemoryThrottle } from "@docmind/auth/testing";
 import { ErrorBody, MeResponse, SignUpResponse } from "@docmind/contracts";
@@ -20,5 +20,12 @@ async function start(trustProxy = false) {
   throttle.now = () => 1_000_000;
   const server = createHttpServer(
-    authRoutes({ service: new AuthService(store), throttle, secureCookies: false, trustProxy }),
+    authRoutes({
+      service: new AuthService(store),
+      authenticator: new PasswordAuthenticator(store),
+      store,
+      throttle,
+      secureCookies: false,
+      trustProxy,
+    }),
   );
   await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
@@ -32,4 +39,5 @@ async function start(trustProxy = false) {
   const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
   return {
+    base,
     store,
     logIn: (email: string, password = PASSWORD) =>
@@ -179,2 +187,39 @@ describe("login", () => {
   });
 });
+
+/** `name=value` of the Set-Cookie header, as a browser would send it back. */
+const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
+
+describe("session routes", () => {
+  const signedIn = async () => {
+    const api = await start();
+    await api.signUp("ada@example.com");
+    return { api, cookie: cookieOf(await api.logIn("ada@example.com")) };
+  };
+
+  it("answers /api/me for a live session, and 401 for none or a forged one", async () => {
+    const { api, cookie } = await signedIn();
+    const me = await fetch(`${api.base}/api/me`, { headers: { cookie } });
+    expect(MeResponse.parse(await me.json()).email).toBe("ada@example.com");
+    expect((await fetch(`${api.base}/api/me`)).status).toBe(401);
+    const forged = { cookie: `dm_session=${"A".repeat(43)}` };
+    expect((await fetch(`${api.base}/api/me`, { headers: forged })).status).toBe(401);
+  });
+
+  it("logs out: clears the cookie, ends only that session, and is safe to repeat", async () => {
+    const { api, cookie: one } = await signedIn();
+    const two = cookieOf(await api.logIn("ada@example.com"));
+    const logOut = (cookie: string) =>
+      fetch(`${api.base}/api/auth/logout`, {
+        method: "POST",
+        headers: { "content-type": "application/json", cookie },
+        body: "{}",
+      });
+    const out = await logOut(one);
+    expect(out.status).toBe(204);
+    expect(out.headers.get("set-cookie")).toMatch(/^dm_session=; .*Max-Age=0/);
+    expect((await fetch(`${api.base}/api/me`, { headers: { cookie: one } })).status).toBe(401);
+    expect((await fetch(`${api.base}/api/me`, { headers: { cookie: two } })).status).toBe(200);
+    expect((await logOut(one)).status).toBe(204);
+  });
+});
```

- [ ] **Step 3: Run them to see them fail**

```bash
pnpm --filter @docmind/server exec vitest run app/auth/routes.test.ts
```

Expected: FAIL: `/api/me` and `/api/auth/logout` answer 404.

- [ ] **Step 4: Implement**

```diff
@@ -1,10 +1,14 @@
 import {
   type AuthService,
+  type AuthStore,
+  type Authenticator,
   POLICIES,
   SESSION_TTL_MS,
   type Throttle,
   accountKey,
+  clearedSessionCookie,
   clientIp,
   ipKey,
+  readSessionCookie,
   sessionCookie,
 } from "@docmind/auth";
@@ -16,8 +20,11 @@ import {
 } from "@docmind/contracts";
 import { readJson } from "../http/body";
+import { requireAuth } from "../http/requireAuth";
 import { type Handler, json, sendError } from "../http/respond";
 
 export interface AuthRoutesDeps {
   service: AuthService;
+  authenticator: Authenticator;
+  store: AuthStore;
   throttle: Throttle;
   /** Mark the session cookie Secure: set it for any deployment served over HTTPS. */
@@ -33,7 +40,7 @@ function tooMany(res: Parameters<Handler>[1], seconds: number): void {
 }
 
-/** Sign-up and login. (Logout and `GET /api/me` follow in the next PR.) */
+/** Sign-up, login, logout and `GET /api/me`. Every route gets its identity from the session. */
 export function authRoutes(deps: AuthRoutesDeps): Record<string, Handler> {
-  const { service, throttle, secureCookies, trustProxy } = deps;
+  const { service, authenticator, store, throttle, secureCookies, trustProxy } = deps;
 
   return {
@@ -72,4 +79,20 @@ export function authRoutes(deps: AuthRoutesDeps): Record<string, Handler> {
       json(res, 200, { ...started.identity, email: body.email } satisfies MeResponse);
     },
+
+    // Always clears the cookie, even for a request with no live session: logging out twice is fine.
+    "POST /api/auth/logout": async (req, res) => {
+      const token = readSessionCookie(req.headers);
+      const identity = await authenticator.authenticate(req);
+      if (token && identity) await service.logOut(identity, token);
+      res.setHeader("set-cookie", clearedSessionCookie(secureCookies));
+      res.writeHead(204);
+      res.end();
+    },
+
+    "GET /api/me": requireAuth(authenticator, async (_req, res, identity) => {
+      const email = await store.findEmail(identity);
+      if (!email) return sendError(res, 401, "unauthorized", "authentication required");
+      json(res, 200, { ...identity, email } satisfies MeResponse);
+    }),
   };
 }
```

- [ ] **Step 5: Run the tests, then the gate**

```bash
pnpm --filter @docmind/server exec vitest run app/auth/routes.test.ts
```

Expected: `15 passed`.

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0.

- [ ] **Step 6: Commit, check the size, open the draft PR**

```bash
git add -A
git commit -m "feat(server): logout and GET /api/me routes" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git diff main...HEAD --numstat -- . ':!pnpm-lock.yaml' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
git push -u origin feat/m1-auth-session-routes
gh pr create --draft --base main --head feat/m1-auth-session-routes --title "feat(server): logout and GET /api/me routes" --body "$(cat <<'EOF'
## Summary
- POST /api/auth/logout: always 204 and a cleared cookie, ends only the calling session, safe to repeat. GET /api/me: the caller's MeResponse from the session, 401 otherwise (via requireAuth).
- Not mounted yet (PR 6n).

## Not counted toward the 200-line / 10-file limit
None.

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: about `76 lines, 2 files`, then the PR URL.

---

# PR 6n: the server comes up authenticated, throttled, as an unprivileged role

**Branch:** `feat/m1-auth-wiring`  **Budget:** 4 files, 146 lines. Spec §9 item 6, part 14 of 14. **Behaviour change:** `pnpm start` now needs `DATABASE_URL`.

### Task 30: startup role assertion, the pool, and `main.ts`

**Files:**
- Create: `/Users/such/workspace/docmind/apps/server/app/db/pool.ts`, `pool.test.ts`
- Modify: `/Users/such/workspace/docmind/apps/server/app/main.ts`, `/Users/such/workspace/docmind/.env.example`

**Interfaces:**
- Consumes: `PgAuthStore` (PR 6f); `PgThrottle` (PR 6j); `authRoutes` (PR 6m); `AuthService`, `PasswordAuthenticator` (`@docmind/auth`); `shutdown` (PR 5d); `app` from `./config`.
- Produces: `assertUnprivilegedRole(pool: Pool): Promise<void>` (throws if `current_user` is a superuser or has `BYPASSRLS`); `createAppPool(connectionString: string): Promise<Pool>` (asserts, ends the pool and rethrows on failure; logs idle-connection errors instead of crashing). `main.ts` reads `DATABASE_URL` (the `docmind_app` URL; required), `DOCMIND_COOKIE_SECURE` (`"true"` marks the cookie Secure), `DOCMIND_TRUST_PROXY` (`"true"` believes the last `X-Forwarded-For` entry; default off), `PORT`, `HOST`; mounts `authRoutes`; purges expired sessions and idle throttle counters at start and hourly; on SIGINT/SIGTERM drains the server, then closes the app, then the pool.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m1-auth-wiring
```

- [ ] **Step 2: Write the failing test**

It connects as the app role (accepted), as the suite's owner role (a superuser, so refused), and as `docmind_app` after it was granted `BYPASSRLS` (refused). `apps/server/app/db/pool.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword } from "./migrate";
import { createAppPool } from "./pool";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "./testSupport";

describe.skipIf(!PG_URL)("createAppPool (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
  });

  afterAll(async () => {
    await db?.drop();
  });

  it("accepts the app role", async () => {
    const pool = await createAppPool(db.appUrl);
    expect((await pool.query("SELECT current_user AS u")).rows[0].u).toBe("docmind_app");
    await pool.end();
  });

  it("refuses the owner role (a superuser here, or any role that bypasses RLS)", async () => {
    const url = new URL(db.appUrl);
    const owner = new URL(PG_URL as string);
    url.username = owner.username;
    url.password = owner.password;
    await expect(createAppPool(url.toString())).rejects.toThrow(/voids row-level security/);
  });

  it("refuses an app role that was granted BYPASSRLS", async () => {
    await db.owner.query("ALTER ROLE docmind_app BYPASSRLS");
    try {
      await expect(createAppPool(db.appUrl)).rejects.toThrow(/BYPASSRLS/);
    } finally {
      await db.owner.query("ALTER ROLE docmind_app NOBYPASSRLS");
    }
  });
});
```

- [ ] **Step 3: Run it to see it fail**

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm --filter @docmind/server exec vitest run app/db/pool.test.ts
```

Expected: FAIL, `Failed to resolve import "./pool"`.

- [ ] **Step 4: Implement**

`apps/server/app/db/pool.ts`:

```ts
import { Pool } from "pg";

/**
 * Refuses a connection that bypasses row-level security. A superuser or BYPASSRLS role sees every
 * tenant's rows whatever the policies say, so a server started with the wrong DATABASE_URL (the
 * owner's, say) must not come up at all.
 */
export async function assertUnprivilegedRole(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ name: string; rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  );
  const role = rows[0];
  if (!role || role.rolsuper || role.rolbypassrls) {
    throw new Error(
      `database role "${role?.name}" is a superuser or has BYPASSRLS, which voids row-level security: connect as docmind_app`,
    );
  }
}

/** The pool the server uses for tenant data: connected as docmind_app, or it does not start. */
export async function createAppPool(connectionString: string): Promise<Pool> {
  const pool = new Pool({ connectionString });
  // An idle connection dropped by the server must not crash the process.
  pool.on("error", (err) => console.error("idle database connection failed:", err.message));
  try {
    await assertUnprivilegedRole(pool);
  } catch (err) {
    await pool.end();
    throw err;
  }
  return pool;
}
```

Replace `apps/server/app/main.ts`:

```ts
import { AuthService, PasswordAuthenticator } from "@docmind/auth";
import { PgAuthStore } from "./auth/pgAuthStore";
import { PgThrottle } from "./auth/pgThrottle";
import { authRoutes } from "./auth/routes";
import { app } from "./config";
import { createAppPool } from "./db/pool";
import { createHttpServer } from "./server";
import { shutdown } from "./shutdown";

const HOUR_MS = 60 * 60 * 1000;

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set (the docmind_app connection string)");
  const pool = await createAppPool(databaseUrl);

  const store = new PgAuthStore(pool);
  const throttle = new PgThrottle(pool);
  const authenticator = new PasswordAuthenticator(store);
  const server = createHttpServer(
    authRoutes({
      service: new AuthService(store),
      authenticator,
      store,
      throttle,
      secureCookies: process.env.DOCMIND_COOKIE_SECURE === "true",
      trustProxy: process.env.DOCMIND_TRUST_PROXY === "true",
    }),
  );

  const sweep = () =>
    Promise.all([store.purgeExpiredSessions(), throttle.purge()]).catch((err) =>
      console.error(err),
    );
  void sweep();
  setInterval(sweep, HOUR_MS).unref();

  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "127.0.0.1";
  server.listen(port, host, () =>
    console.log(`docmind server listening on http://${host}:${port}`),
  );

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      // The server drains first; the app closes before the pool it may read from.
      const closeAll = {
        close: async () => {
          await app.close();
          await pool.end();
        },
      };
      shutdown(server, closeAll).catch((err) => {
        console.error(err);
        process.exitCode = 1;
      });
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Document the new variables in `.env.example`:

```diff
@@ -12,4 +12,11 @@ DOCMIND_APP_DB_PASSWORD=change-me-locally
 DATABASE_URL=postgres://docmind_app:change-me-locally@127.0.0.1:5432/docmind
 
+# Set to true when the server is reached over HTTPS (marks the session cookie Secure).
+DOCMIND_COOKIE_SECURE=false
+
+# Believe X-Forwarded-For for the client address (login/sign-up throttling). Set to true only when the
+# server sits behind exactly one reverse proxy of yours; otherwise any client could fake its address.
+DOCMIND_TRUST_PROXY=false
+
 # Enables the Postgres integration tests (they skip when unset). The role must be able to
 # CREATE DATABASE: each suite makes, and drops, a database of its own.
```

- [ ] **Step 5: Run the test, then the gate**

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm --filter @docmind/server exec vitest run app/db/pool.test.ts
```

Expected: `3 passed`.

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0.

- [ ] **Step 6: Smoke-test the real server** (`main.ts` has no unit test; this is its test)

```bash
export DOCMIND_MIGRATE_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
export DOCMIND_APP_DB_PASSWORD=change-me-locally
pnpm --filter @docmind/server db:migrate
```

Expected: `applied: ...` listing `0004_auth_session_indexes.sql`, `0005_auth_functions.sql` and `0006_auth_throttle.sql` (all of 0001-0006 on a fresh database).

```bash
DATABASE_URL=postgres://docmind_app:change-me-locally@127.0.0.1:5432/docmind PORT=3917 pnpm --filter @docmind/server start &
sleep 4
curl -s -i -X POST localhost:3917/api/auth/sign-up -H 'content-type: application/json' \
  -d '{"email":"Smoke@Example.com","password":"correct horse battery"}' | head -1
curl -s -c /tmp/dm-jar -X POST localhost:3917/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"smoke@example.com","password":"correct horse battery"}'
curl -s -b /tmp/dm-jar localhost:3917/api/me
curl -s -o /dev/null -w '%{http_code}\n' -b /tmp/dm-jar -X POST localhost:3917/api/auth/logout -H 'content-type: application/json' -d '{}'
curl -s -b /tmp/dm-jar localhost:3917/api/me
for i in 1 2 3 4 5 6 7; do curl -s -o /dev/null -w '%{http_code} ' -X POST localhost:3917/api/auth/login \
  -H 'content-type: application/json' -d '{"email":"smoke@example.com","password":"wrong password here"}'; done; echo
kill %1
```

Expected, in order: `HTTP/1.1 202 Accepted`; the `MeResponse` JSON for the login; the same JSON from `/api/me`; `204`; the `401` error body; then `401 401 401 401 401 401 429` (the sixth wrong password locks the email for 2 seconds, so the seventh is throttled; the earlier successful login had reset the count). (`sleep 4` is a manual smoke step, not a test.) Starting it with the owner's URL as `DATABASE_URL` must instead exit with `database role "..." is a superuser or has BYPASSRLS`.

- [ ] **Step 7: Commit, check the size, open the draft PR**

```bash
git add -A
git commit -m "feat(server): serve the auth routes as an unprivileged database role" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git diff main...HEAD --numstat -- . ':!pnpm-lock.yaml' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
git push -u origin feat/m1-auth-wiring
gh pr create --draft --base main --head feat/m1-auth-wiring --title "feat(server): serve the auth routes as an unprivileged database role" --body "$(cat <<'EOF'
## Summary
- Startup assertion (M0 review carry-forward): createAppPool refuses a DATABASE_URL whose role is a superuser or has BYPASSRLS, so a server pointed at the owner's URL does not come up. Tested against the owner role and against docmind_app granted BYPASSRLS.
- main.ts now needs DATABASE_URL (docmind_app), mounts the auth routes with the Postgres throttle (DOCMIND_TRUST_PROXY, off by default, controls whether X-Forwarded-For is believed), purges expired sessions and idle throttle counters at start and hourly, and closes server, app, pool in order. /healthz still works as before.
- Smoke-tested by hand: sign-up (202), login, /api/me, logout, and the 429 after repeated wrong passwords, against a real database.

## Not counted toward the 200-line / 10-file limit
None.

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test` (with DOCMIND_TEST_PG_URL)
- [x] manual smoke test (commands in the plan, Task 30 step 6)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: about `146 lines, 4 files`, then the PR URL.

---
# PR 7a: `packages/keystore-pg` primitives (KEK and key wrapping)

**Branch:** `feat/m1-keystore-primitives`  **Budget:** 8 files, 138 lines (+ `pnpm-lock.yaml`). Spec §9 item 7, part 1 of 7.

### Task 31: load the master key; wrap and unwrap data keys

**Files:**
- Create: `/Users/such/workspace/docmind/packages/keystore-pg/package.json`, `tsconfig.json`, `tsconfig.test.json`
- Create: `/Users/such/workspace/docmind/packages/keystore-pg/src/kek.ts`, `kek.test.ts`, `wrap.ts`, `wrap.test.ts`, `index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface Kek { id: string; key: Buffer }` (a master key-encryption key; `key` is 32 bytes); `loadKek(env?: NodeJS.ProcessEnv): Kek` (`DOCMIND_KEK` base64, or `DOCMIND_KEK_FILE` holding the base64; `DOCMIND_KEK_ID`, default `"kek-1"`; throws on a missing or non-32-byte key); `wrapKey(kek: Buffer, subjectId: string, dek: Buffer): Buffer` (AES-256-GCM, `iv(12) || tag(16) || ciphertext(32)`, the subject id is authenticated data); `unwrapKey(kek: Buffer, subjectId: string, wrapped: Buffer): Buffer` (throws if the KEK, subject or bytes differ). Only `Kek` and `loadKek` are exported from the package index in this PR (`wrapKey`/`unwrapKey` are internal).

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m1-keystore-primitives
```

- [ ] **Step 2: Scaffold the package**

`packages/keystore-pg/package.json`:

```json
{
  "name": "@docmind/keystore-pg",
  "version": "0.0.0",
  "private": true,
  "description": "PostgresKeyStore: per-subject data keys, wrapped by a master key, for Loom's crypto-shredding.",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "typecheck:tests": "tsc -p tsconfig.test.json"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "vitest": "^2.1.8"
  }
}
```

`packages/keystore-pg/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src", "types": ["node"] },
  "include": ["src"],
  "exclude": ["**/*.test.ts", "dist"]
}
```

`packages/keystore-pg/tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src"],
  "exclude": ["dist"]
}
```

- [ ] **Step 3: Write the failing tests**

`packages/keystore-pg/src/wrap.test.ts`:

```ts
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { unwrapKey, wrapKey } from "./wrap";

describe("key wrapping", () => {
  const kek = randomBytes(32);
  const dek = randomBytes(32);

  it("round-trips and does not contain the data key in the clear", () => {
    const wrapped = wrapKey(kek, "user-1", dek);
    expect(wrapped).toHaveLength(12 + 16 + 32);
    expect(wrapped.includes(dek)).toBe(false);
    expect(unwrapKey(kek, "user-1", wrapped).equals(dek)).toBe(true);
  });

  it("never wraps the same key to the same bytes", () => {
    expect(wrapKey(kek, "user-1", dek).equals(wrapKey(kek, "user-1", dek))).toBe(false);
  });

  it("does not open under another KEK, another subject, or after tampering", () => {
    const wrapped = wrapKey(kek, "user-1", dek);
    expect(() => unwrapKey(randomBytes(32), "user-1", wrapped)).toThrow();
    expect(() => unwrapKey(kek, "user-2", wrapped)).toThrow();
    const flipped = Buffer.from(wrapped);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
    expect(() => unwrapKey(kek, "user-1", flipped)).toThrow();
  });
});
```

`packages/keystore-pg/src/kek.test.ts`:

```ts
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadKek } from "./kek";

const b64 = randomBytes(32).toString("base64");

describe("loadKek", () => {
  it("reads a base64 key from DOCMIND_KEK and names it", () => {
    const kek = loadKek({ DOCMIND_KEK: b64, DOCMIND_KEK_ID: "kek-7" });
    expect(kek.id).toBe("kek-7");
    expect(kek.key.toString("base64")).toBe(b64);
    expect(loadKek({ DOCMIND_KEK: b64 }).id).toBe("kek-1");
  });

  it("reads the key from a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "docmind-kek-"));
    try {
      writeFileSync(join(dir, "kek"), `${b64}\n`);
      expect(loadKek({ DOCMIND_KEK_FILE: join(dir, "kek") }).key.toString("base64")).toBe(b64);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a missing key and a key of the wrong size", () => {
    expect(() => loadKek({})).toThrow(/DOCMIND_KEK/);
    expect(() => loadKek({ DOCMIND_KEK: randomBytes(16).toString("base64") })).toThrow(/32 bytes/);
  });
});
```

- [ ] **Step 4: Run them to see them fail**

```bash
pnpm install
pnpm --filter @docmind/keystore-pg test
```

Expected: FAIL, `Failed to resolve import "./wrap"` and `"./kek"`.

- [ ] **Step 5: Implement**

`packages/keystore-pg/src/wrap.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * AES-256-GCM seal of a data key under the KEK, as iv || tag || ciphertext. The subject is
 * authenticated data: a wrapped key copied onto another user's row fails to open.
 */
export function wrapKey(kek: Buffer, subjectId: string, dek: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", kek, iv);
  cipher.setAAD(Buffer.from(subjectId, "utf8"));
  const body = Buffer.concat([cipher.update(dek), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/** Opens what `wrapKey` sealed. Throws if the KEK, the subject or the bytes are not the originals. */
export function unwrapKey(kek: Buffer, subjectId: string, wrapped: Buffer): Buffer {
  const iv = wrapped.subarray(0, IV_BYTES);
  const tag = wrapped.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = wrapped.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", kek, iv);
  decipher.setAAD(Buffer.from(subjectId, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}
```

`packages/keystore-pg/src/kek.ts`:

```ts
import { readFileSync } from "node:fs";

/** A master key-encryption key. Data keys are stored wrapped by one; the id says which. */
export interface Kek {
  id: string;
  key: Buffer;
}

/**
 * The KEK from the environment: DOCMIND_KEK (base64) or DOCMIND_KEK_FILE (a file holding the base64),
 * named by DOCMIND_KEK_ID (default "kek-1"). A cloud KMS replaces this later, behind the same Kek.
 */
export function loadKek(env: NodeJS.ProcessEnv = process.env): Kek {
  const file = env.DOCMIND_KEK_FILE;
  const b64 = file ? readFileSync(file, "utf8").trim() : env.DOCMIND_KEK;
  if (!b64) throw new Error("set DOCMIND_KEK (base64, 32 bytes) or DOCMIND_KEK_FILE");
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error(`the KEK must be 32 bytes, got ${key.length}`);
  return { id: env.DOCMIND_KEK_ID ?? "kek-1", key };
}
```

`packages/keystore-pg/src/index.ts`:

```ts
export { type Kek, loadKek } from "./kek";
```

- [ ] **Step 6: Run the tests, then the gate**

```bash
pnpm --filter @docmind/keystore-pg test
```

Expected: `wrap.test.ts` 3 passed, `kek.test.ts` 3 passed.

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0.

- [ ] **Step 7: Commit, check the size, open the draft PR**

```bash
git add -A
git commit -m "feat(keystore-pg): KEK loading and AES-GCM key wrapping" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git diff main...HEAD --numstat -- . ':!pnpm-lock.yaml' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
git push -u origin feat/m1-keystore-primitives
gh pr create --draft --base main --head feat/m1-keystore-primitives --title "feat(keystore-pg): KEK loading and AES-GCM key wrapping" --body "$(cat <<'EOF'
## Summary
- New package @docmind/keystore-pg (spec §3, §9 item 7), first part: loadKek (DOCMIND_KEK / DOCMIND_KEK_FILE, id from DOCMIND_KEK_ID) and AES-256-GCM wrapping of a data key, with the subject id as authenticated data so a wrapped key copied onto another user's row does not open.
- No database yet: the KeyStore itself is PR 7b.

## Not counted toward the 200-line / 10-file limit
pnpm-lock.yaml (new workspace package).

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: about `138 lines, 8 files`, then the PR URL.

---

# PR 7b: `data_keys` and `PostgresKeyStore`

**Branch:** `feat/m1-keystore-pg`  **Budget:** 8 files, 196 lines (+ `pnpm-lock.yaml`; this one is close to the limit, so re-measure and trim comments rather than splitting further). Spec §9 item 7, part 2 of 7.

### Task 32: a Postgres `KeyStore` that passes Loom's contract

**Files:**
- Create: `/Users/such/workspace/docmind/infra/migrations/0007_data_keys.sql`, `packages/keystore-pg/src/PostgresKeyStore.ts`, `apps/server/app/keys/postgresKeyStore.test.ts`
- Modify: `/Users/such/workspace/docmind/packages/keystore-pg/src/index.ts`, `packages/keystore-pg/package.json`, `package.json` (root), `apps/server/package.json`, `apps/server/vitest.config.ts`

**Interfaces:**
- Consumes: `Kek`, `wrapKey`, `unwrapKey` (PR 7a); from Loom `KeyStore` (`@loom/plugin-crypto`, `plugins/crypto/src/keystore.ts`) and `runKeyStoreConformance` (`@loom/conformance`, `packages/conformance/src/index.ts:2913`); the server test helpers (M0, PR 6a) `createTestDb`, `migrate`, `setAppRolePassword`.
- Produces: SQL `key_get(p_subject text) RETURNS TABLE (dek bytea, kek text)` (live key only), `key_put(p_subject text, p_dek bytea, p_kek text) RETURNS TABLE (dek bytea, kek text)` (insert if absent, return the stored row; raises SQLSTATE `DM001` "was destroyed and cannot be recreated" for a destroyed subject), `key_destroy(p_subject text) RETURNS void` (wipe and tombstone, idempotent, also for a never-seen subject), `key_was_destroyed(p_subject text) RETURNS boolean`; table `data_keys (subject_id text PRIMARY KEY, wrapped_dek bytea, kek_id text, created_at, destroyed_at)` with RLS enabled, no policy, no privileges for `docmind_app`. TypeScript `class PostgresKeyStore implements KeyStore { constructor(pool: Pool, keks: readonly [Kek, ...Kek[]]); readonly durable = true; getOrCreate(subjectId): Promise<Buffer>; get(subjectId): Promise<Buffer | null>; destroy(subjectId): Promise<void>; wasDestroyed(subjectId): Promise<boolean> }` exported from `@docmind/keystore-pg`. `pool` is the `docmind_app` pool; `keks[0]` wraps new keys and every KEK can unwrap keys written under its id.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m1-keystore-pg
```

- [ ] **Step 2: Link the Loom packages and wire the server's test config**

Add `@loom/conformance` and `@loom/plugin-crypto` to the root `pnpm.overrides` (a `link:` for every `@loom/*` package that is imported, as in M0):

```diff
@@ -26,5 +26,7 @@
       "@loom/app": "link:../loom/packages/app",
       "@loom/cli": "link:../loom/tools/cli",
+      "@loom/conformance": "link:../loom/packages/conformance",
       "@loom/effect-runtime": "link:../loom/packages/effect-runtime",
+      "@loom/plugin-crypto": "link:../loom/plugins/crypto",
       "@loom/workflow-runtime": "link:../loom/packages/workflow-runtime"
     }
```

Add the dependencies in `apps/server/package.json` (the workspace package, and the two Loom packages the test imports):

```diff
@@ -15,4 +15,5 @@
     "@docmind/auth": "workspace:*",
     "@docmind/contracts": "workspace:*",
+    "@docmind/keystore-pg": "workspace:*",
     "@loom/app": "*",
     "@loom/effect-runtime": "*",
@@ -26,5 +27,7 @@
     "tsx": "^4.19.2",
     "vitest": "^2.1.8",
-    "@types/pg": "^8.11.0"
+    "@types/pg": "^8.11.0",
+    "@loom/conformance": "*",
+    "@loom/plugin-crypto": "*"
   }
 }
```

`@loom/conformance` is ESM with extensionless relative imports, which Node's native ESM loader rejects, so Vite must load it; the server's `external: [/@loom\//]` rule would otherwise externalize it. `apps/server/vitest.config.ts`:

```ts
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // @loom/* publish require-only `exports`; resolve them the same way under Vite.
  resolve: {
    conditions: ["node", "require", "default"],
    // The auth test kit imports vitest, which cannot be require()d from the CommonJS build, so
    // tests load it from source.
    alias: { "@docmind/auth/testing": resolve(__dirname, "../../packages/auth/src/testing.ts") },
  },
  // Suites share cluster-wide state (the docmind_app role), so test files run one at a time.
  test: {
    environment: "node",
    fileParallelism: false,
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

Add the runtime dependencies to `packages/keystore-pg/package.json`:

```diff
@@ -14,5 +14,10 @@
   "devDependencies": {
     "@types/node": "^22.0.0",
+    "@types/pg": "^8.11.0",
     "vitest": "^2.1.8"
+  },
+  "dependencies": {
+    "@loom/plugin-crypto": "*",
+    "pg": "^8.13.0"
   }
 }
```

```bash
pnpm install
```

- [ ] **Step 3: Write the failing test**

Loom's suite names its subjects `"s1"`, `"s2"` in every test, so a random prefix per instance keeps the tests apart in one database. `apps/server/app/keys/postgresKeyStore.test.ts`:

```ts
import { randomBytes, randomUUID } from "node:crypto";
import { PostgresKeyStore } from "@docmind/keystore-pg";
import { runKeyStoreConformance } from "@loom/conformance";
import type { KeyStore } from "@loom/plugin-crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe } from "vitest";
import { migrate, setAppRolePassword } from "../db/migrate";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";

const kek = { id: "kek-1", key: randomBytes(32) };

describe.skipIf(!PG_URL)("PostgresKeyStore (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    app = new Pool({ connectionString: db.appUrl });
  });

  afterAll(async () => {
    await app?.end();
    await db?.drop();
  });

  // The contract names subjects like "s1"; a random prefix per instance keeps the tests apart.
  const isolated = (inner: KeyStore): KeyStore => {
    const ns = `${randomUUID()}:`;
    return {
      durable: inner.durable,
      getOrCreate: (s) => inner.getOrCreate(ns + s),
      get: (s) => inner.get(ns + s),
      destroy: (s) => inner.destroy(ns + s),
      wasDestroyed: (s) => (inner.wasDestroyed as NonNullable<KeyStore["wasDestroyed"]>)(ns + s),
    };
  };
  runKeyStoreConformance(() => isolated(new PostgresKeyStore(app, [kek])), "PostgresKeyStore");
});
```

- [ ] **Step 4: Run it to see it fail**

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm build
pnpm --filter @docmind/server exec vitest run app/keys/postgresKeyStore.test.ts
```

Expected: FAIL, `PostgresKeyStore is not a constructor` (the package does not export it yet).

- [ ] **Step 5: Write the migration**

`infra/migrations/0007_data_keys.sql`:

```sql
-- Per-subject data keys for crypto-shredding (spec 4.4). A subject is a user. The key is stored
-- wrapped by a master key held outside the database. Destroying it leaves a tombstone row, so the
-- subject can never be given a new key.
CREATE TABLE data_keys (
  subject_id text PRIMARY KEY,
  wrapped_dek bytea,
  kek_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  destroyed_at timestamptz,
  CONSTRAINT data_keys_live_or_destroyed CHECK (
    (wrapped_dek IS NOT NULL AND kek_id IS NOT NULL AND destroyed_at IS NULL)
    OR (wrapped_dek IS NULL AND kek_id IS NULL AND destroyed_at IS NOT NULL))
);

-- No policy and no privileges for docmind_app: the functions below are its only way in, so it can
-- ask for one subject's key but cannot dump the table. (Keys are used outside any tenant context.)
ALTER TABLE data_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON data_keys FROM docmind_app;

-- The live key of a subject, if it has one.
CREATE FUNCTION key_get(p_subject text)
  RETURNS TABLE (dek bytea, kek text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT k.wrapped_dek, k.kek_id FROM public.data_keys k
         WHERE k.subject_id = p_subject AND k.wrapped_dek IS NOT NULL $$;

-- Stores a key unless the subject has one and returns the stored one, so racing creators agree.
-- Refuses a destroyed subject.
CREATE FUNCTION key_put(p_subject text, p_dek bytea, p_kek text)
  RETURNS TABLE (dek bytea, kek text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  INSERT INTO public.data_keys (subject_id, wrapped_dek, kek_id)
    VALUES (p_subject, p_dek, p_kek) ON CONFLICT (subject_id) DO NOTHING;
  RETURN QUERY SELECT k.wrapped_dek, k.kek_id FROM public.data_keys k
    WHERE k.subject_id = p_subject AND k.wrapped_dek IS NOT NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the key for subject % was destroyed and cannot be recreated', p_subject
      USING ERRCODE = 'DM001';
  END IF;
END
$$;

-- Wipes the key material and records the destruction. Safe to repeat, and for a subject that never
-- had a key (it is then barred from getting one).
CREATE FUNCTION key_destroy(p_subject text)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ INSERT INTO public.data_keys (subject_id, destroyed_at) VALUES (p_subject, now())
        ON CONFLICT (subject_id) DO UPDATE
          SET wrapped_dek = NULL, kek_id = NULL,
              destroyed_at = COALESCE(public.data_keys.destroyed_at, now()) $$;

-- Proof of destruction (Loom's KeyStore.wasDestroyed).
CREATE FUNCTION key_was_destroyed(p_subject text)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT EXISTS (SELECT 1 FROM public.data_keys
                        WHERE subject_id = p_subject AND destroyed_at IS NOT NULL) $$;

REVOKE ALL ON FUNCTION key_get(text), key_put(text, bytea, text), key_destroy(text),
  key_was_destroyed(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION key_get(text), key_put(text, bytea, text), key_destroy(text),
  key_was_destroyed(text) TO docmind_app;
```

- [ ] **Step 6: Implement the store**

`packages/keystore-pg/src/PostgresKeyStore.ts`:

```ts
import { randomBytes } from "node:crypto";
import type { KeyStore } from "@loom/plugin-crypto";
import type { Pool } from "pg";
import type { Kek } from "./kek";
import { unwrapKey, wrapKey } from "./wrap";

interface KeyRow {
  dek: Buffer;
  kek: string;
}

/**
 * Loom's KeyStore on Postgres: one random data key per subject (a user), stored wrapped by a KEK and
 * reached only through the key_* SQL functions (migration 0007). `destroy` leaves a tombstone, and
 * the database never mints a key for a tombstoned subject.
 */
export class PostgresKeyStore implements KeyStore {
  /** The keys survive a restart: they live in the database. */
  readonly durable = true;
  private readonly byId: Map<string, Kek>;

  /** `keks[0]` wraps new keys; the others only unwrap keys written under them (rotation). */
  constructor(
    private readonly pool: Pool,
    private readonly keks: readonly [Kek, ...Kek[]],
  ) {
    this.byId = new Map(keks.map((k) => [k.id, k]));
  }

  async getOrCreate(subjectId: string): Promise<Buffer> {
    const existing = await this.row(subjectId);
    if (existing) return this.open(subjectId, existing);
    const [active] = this.keks;
    const wrapped = wrapKey(active.key, subjectId, randomBytes(32));
    // Of two racing creators the database keeps one row and returns it to both.
    const { rows } = await this.pool.query<KeyRow>("SELECT * FROM key_put($1, $2, $3)", [
      subjectId,
      wrapped,
      active.id,
    ]);
    return this.open(subjectId, rows[0] as KeyRow);
  }

  async get(subjectId: string): Promise<Buffer | null> {
    const row = await this.row(subjectId);
    return row ? this.open(subjectId, row) : null;
  }

  async destroy(subjectId: string): Promise<void> {
    await this.pool.query("SELECT key_destroy($1)", [subjectId]);
  }

  async wasDestroyed(subjectId: string): Promise<boolean> {
    const { rows } = await this.pool.query("SELECT key_was_destroyed($1) AS destroyed", [
      subjectId,
    ]);
    return rows[0].destroyed;
  }

  private async row(subjectId: string): Promise<KeyRow | undefined> {
    const { rows } = await this.pool.query<KeyRow>("SELECT * FROM key_get($1)", [subjectId]);
    return rows[0];
  }

  private open(subjectId: string, row: KeyRow): Buffer {
    const kek = this.byId.get(row.kek);
    if (!kek) throw new Error(`the key for "${subjectId}" is wrapped by unknown KEK "${row.kek}"`);
    return unwrapKey(kek.key, subjectId, row.dek);
  }
}
```

`packages/keystore-pg/src/index.ts`:

```ts
export { type Kek, loadKek } from "./kek";
export { PostgresKeyStore } from "./PostgresKeyStore";
```

- [ ] **Step 7: Run the test, then the gate**

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm build
pnpm --filter @docmind/server exec vitest run app/keys/postgresKeyStore.test.ts
```

Expected: `8 passed` (Loom's eight contract tests).

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0 (the M0 "RLS on every table" guard passes: `data_keys` has RLS enabled).

- [ ] **Step 8: Commit, check the size, open the draft PR**

```bash
git add -A
git commit -m "feat(keystore-pg): PostgresKeyStore passing Loom's KeyStore contract" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git diff main...HEAD --numstat -- . ':!pnpm-lock.yaml' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
git push -u origin feat/m1-keystore-pg
gh pr create --draft --base main --head feat/m1-keystore-pg --title "feat(keystore-pg): PostgresKeyStore passing Loom's KeyStore contract" --body "$(cat <<'EOF'
## Summary
- Migration 0007 data_keys + key_get/key_put/key_destroy/key_was_destroyed (SECURITY DEFINER, pinned search_path, explicit grants). docmind_app has no privilege on the table, only on the functions. destroy wipes the wrapped key and leaves a tombstone, because Loom's contract forbids minting a new key for a destroyed subject; this differs from spec §4.4's "deletes the row" (plan deviation 4).
- PostgresKeyStore (durable) implements @loom/plugin-crypto's KeyStore incl. wasDestroyed; the DEK is AES-GCM-wrapped by the KEK (PR 7a); several KEKs can unwrap (rotation), the first wraps.
- Passes runKeyStoreConformance from @loom/conformance (8 tests). The conformance test lives in apps/server because the DB test harness does.
- Root pnpm.overrides links @loom/conformance and @loom/plugin-crypto; the server's vitest config inlines @loom/conformance (ESM with extensionless imports).

## Not counted toward the 200-line / 10-file limit
pnpm-lock.yaml.

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test` (with DOCMIND_TEST_PG_URL)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: about `196 lines, 8 files`, then the PR URL.

---

# PR 7c: key store security tests

**Branch:** `feat/m1-keystore-pg-security`  **Budget:** 1 file, 76 lines. Spec §9 item 7, part 3 of 7. Tests only.

### Task 33: the properties crypto-shredding relies on

**Files:**
- Modify: `/Users/such/workspace/docmind/apps/server/app/keys/postgresKeyStore.test.ts`

**Interfaces:**
- Consumes: `PostgresKeyStore` (PR 7b); `createTestDb` (`db.owner` is the superuser pool used to look at the table).
- Produces: nothing new; eight tests: a new instance reads the same key (restart), the stored value is wrapped (60 bytes) and not the key, eight racing creators agree, `destroy` leaves only a tombstone, a destroyed subject cannot get a key even by calling `key_put` directly, a wrapped key copied onto another subject or opened with another KEK fails, rotation works and an unknown KEK is named, `docmind_app` cannot read or delete `data_keys`.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m1-keystore-pg-security
```

- [ ] **Step 2: Add the tests** (they should pass at once: they pin behaviour PR 7b already has; if one fails, the key store is wrong and the failure is the finding)

Replace `apps/server/app/keys/postgresKeyStore.test.ts` with:

```ts
import { randomBytes, randomUUID } from "node:crypto";
import { PostgresKeyStore } from "@docmind/keystore-pg";
import { runKeyStoreConformance } from "@loom/conformance";
import type { KeyStore } from "@loom/plugin-crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword } from "../db/migrate";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";

const kek = { id: "kek-1", key: randomBytes(32) };

describe.skipIf(!PG_URL)("PostgresKeyStore (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    app = new Pool({ connectionString: db.appUrl });
  });

  afterAll(async () => {
    await app?.end();
    await db?.drop();
  });

  // The contract names subjects like "s1"; a random prefix per instance keeps the tests apart.
  const isolated = (inner: KeyStore): KeyStore => {
    const ns = `${randomUUID()}:`;
    return {
      durable: inner.durable,
      getOrCreate: (s) => inner.getOrCreate(ns + s),
      get: (s) => inner.get(ns + s),
      destroy: (s) => inner.destroy(ns + s),
      wasDestroyed: (s) => (inner.wasDestroyed as NonNullable<KeyStore["wasDestroyed"]>)(ns + s),
    };
  };
  runKeyStoreConformance(() => isolated(new PostgresKeyStore(app, [kek])), "PostgresKeyStore");

  const fresh = () => `subject-${randomUUID()}`;
  const rowOf = async (subject: string) =>
    (await db.owner.query("SELECT * FROM data_keys WHERE subject_id = $1", [subject])).rows[0];

  it("gives a new instance the same key: the key survives a restart", async () => {
    const subject = fresh();
    const key = await new PostgresKeyStore(app, [kek]).getOrCreate(subject);
    expect((await new PostgresKeyStore(app, [kek]).get(subject))?.equals(key)).toBe(true);
  });

  it("stores the key wrapped, never in the clear", async () => {
    const subject = fresh();
    const key = await new PostgresKeyStore(app, [kek]).getOrCreate(subject);
    const row = await rowOf(subject);
    expect(row.kek_id).toBe("kek-1");
    expect(row.wrapped_dek).toHaveLength(60);
    expect(row.wrapped_dek.includes(key)).toBe(false);
  });

  it("hands two racing creators the same key", async () => {
    const subject = fresh();
    const store = new PostgresKeyStore(app, [kek]);
    const keys = await Promise.all(Array.from({ length: 8 }, () => store.getOrCreate(subject)));
    expect(new Set(keys.map((k) => k.toString("hex"))).size).toBe(1);
  });

  it("wipes the key material on destroy and leaves only the tombstone", async () => {
    const subject = fresh();
    const store = new PostgresKeyStore(app, [kek]);
    await store.getOrCreate(subject);
    await store.destroy(subject);
    const row = await rowOf(subject);
    expect([row.wrapped_dek, row.kek_id]).toEqual([null, null]);
    expect(row.destroyed_at).toBeInstanceOf(Date);
    await expect(store.getOrCreate(subject)).rejects.toThrow(/destroyed/);
  });

  it("stays destroyed even when the database is asked for a key directly", async () => {
    const subject = fresh();
    await new PostgresKeyStore(app, [kek]).destroy(subject);
    await expect(
      app.query("SELECT * FROM key_put($1, $2, 'kek-1')", [subject, randomBytes(60)]),
    ).rejects.toThrow(/destroyed/);
  });

  it("does not open a wrapped key copied onto another subject, or under another KEK", async () => {
    const [a, b] = [fresh(), fresh()];
    const store = new PostgresKeyStore(app, [kek]);
    await store.getOrCreate(a);
    await store.getOrCreate(b);
    await db.owner.query(
      "UPDATE data_keys SET wrapped_dek = (SELECT wrapped_dek FROM data_keys WHERE subject_id = $1) WHERE subject_id = $2",
      [a, b],
    );
    await expect(store.get(b)).rejects.toThrow();
    const other = { id: "kek-1", key: randomBytes(32) };
    await expect(new PostgresKeyStore(app, [other]).get(a)).rejects.toThrow();
  });

  it("opens keys written under an earlier KEK after rotation, and names an unknown one", async () => {
    const subject = fresh();
    const old = await new PostgresKeyStore(app, [kek]).getOrCreate(subject);
    const next = { id: "kek-2", key: randomBytes(32) };
    expect((await new PostgresKeyStore(app, [next, kek]).get(subject))?.equals(old)).toBe(true);
    await expect(new PostgresKeyStore(app, [next]).get(subject)).rejects.toThrow(
      /unknown KEK "kek-1"/,
    );
  });

  it("is a table the app role cannot read, only reach through the functions", async () => {
    await expect(app.query("SELECT * FROM data_keys")).rejects.toThrow(/permission denied/);
    await expect(app.query("DELETE FROM data_keys")).rejects.toThrow(/permission denied/);
  });
});
```

- [ ] **Step 3: Run them, then the gate**

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm --filter @docmind/server exec vitest run app/keys/postgresKeyStore.test.ts
```

Expected: `16 passed` (8 contract + 8 below).

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0.

- [ ] **Step 4: Commit, check the size, open the draft PR**

```bash
git add -A
git commit -m "test(keystore-pg): restart, race, tombstone, tamper, rotation and privilege tests" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git diff main...HEAD --numstat -- . ':!pnpm-lock.yaml' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
git push -u origin feat/m1-keystore-pg-security
gh pr create --draft --base main --head feat/m1-keystore-pg-security --title "test(keystore-pg): restart, race, tombstone, tamper, rotation and privilege tests" --body "$(cat <<'EOF'
## Summary
- The properties crypto-shredding depends on, beyond Loom's contract: keys survive a restart, racing creators agree, the stored value is wrapped, destroy leaves no key material and cannot be undone even by calling key_put directly, a wrapped key moved to another subject or opened under another KEK fails, KEK rotation reads old keys, and docmind_app cannot read or delete data_keys.

## Not counted toward the 200-line / 10-file limit
None.

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test` (with DOCMIND_TEST_PG_URL)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: about `76 lines, 1 file`, then the PR URL.

---

# PR 7d: the previous KEK

**Branch:** `feat/m1-kek-previous`  **Budget:** 3 files, 60 lines. Spec §9 item 7 (key rotation requested by the owner), part 4 of 7.

### Task 34: run with a current KEK and, while rotating, a previous one

**Files:**
- Modify: `/Users/such/workspace/docmind/packages/keystore-pg/src/kek.ts`, `kek.test.ts`, `index.ts`

**Interfaces:**
- Consumes: `Kek`, `loadKek` (PR 7a); `PostgresKeyStore(pool, keks)` already accepts several KEKs (PR 7b).
- Produces: `loadKek(env?, name = "DOCMIND_KEK", defaultId?)` generalised to any variable name (`<name>`, `<name>_FILE`, `<name>_ID`; the id defaults to `"kek-1"` only for `DOCMIND_KEK`); `loadKeks(env?): readonly [Kek, ...Kek[]]`: the current KEK first (it wraps new keys), then, if `DOCMIND_KEK_PREVIOUS` (or `_FILE`) is set, the previous one, whose id is required and must differ.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m1-kek-previous
```

- [ ] **Step 2: Write the failing tests**

```diff
@@ -4,5 +4,5 @@ import { tmpdir } from "node:os";
 import { join } from "node:path";
 import { describe, expect, it } from "vitest";
-import { loadKek } from "./kek";
+import { loadKek, loadKeks } from "./kek";
 
 const b64 = randomBytes(32).toString("base64");
@@ -30,3 +30,24 @@ describe("loadKek", () => {
     expect(() => loadKek({ DOCMIND_KEK: randomBytes(16).toString("base64") })).toThrow(/32 bytes/);
   });
+
+  it("loadKeks puts the current KEK first and adds the previous one while rotating", () => {
+    const other = randomBytes(32).toString("base64");
+    expect(loadKeks({ DOCMIND_KEK: b64 }).map((k) => k.id)).toEqual(["kek-1"]);
+    const both = loadKeks({
+      DOCMIND_KEK: b64,
+      DOCMIND_KEK_ID: "kek-2",
+      DOCMIND_KEK_PREVIOUS: other,
+      DOCMIND_KEK_PREVIOUS_ID: "kek-1",
+    });
+    expect(both.map((k) => k.id)).toEqual(["kek-2", "kek-1"]);
+    expect(both[1]?.key.toString("base64")).toBe(other);
+  });
+
+  it("loadKeks refuses a previous KEK without an id, or with the current one's id", () => {
+    const other = randomBytes(32).toString("base64");
+    expect(() => loadKeks({ DOCMIND_KEK: b64, DOCMIND_KEK_PREVIOUS: other })).toThrow(/_ID/);
+    expect(() =>
+      loadKeks({ DOCMIND_KEK: b64, DOCMIND_KEK_PREVIOUS: other, DOCMIND_KEK_PREVIOUS_ID: "kek-1" }),
+    ).toThrow(/different id/);
+  });
 });
```

- [ ] **Step 3: Run them to see them fail**

```bash
pnpm --filter @docmind/keystore-pg test
```

Expected: FAIL, `loadKeks is not a function` (and a type error from `typecheck:tests`).

- [ ] **Step 4: Implement**

`packages/keystore-pg/src/kek.ts`:

```ts
import { readFileSync } from "node:fs";

/** A master key-encryption key. Data keys are stored wrapped by one; the id says which. */
export interface Kek {
  id: string;
  key: Buffer;
}

/**
 * One KEK from the environment: `<name>` (base64) or `<name>_FILE` (a file holding the base64),
 * named by `<name>_ID`. A cloud KMS replaces this later, behind the same Kek.
 */
export function loadKek(
  env: NodeJS.ProcessEnv = process.env,
  name = "DOCMIND_KEK",
  defaultId = name === "DOCMIND_KEK" ? "kek-1" : undefined,
): Kek {
  const file = env[`${name}_FILE`];
  const b64 = file ? readFileSync(file, "utf8").trim() : env[name];
  if (!b64) throw new Error(`set ${name} (base64, 32 bytes) or ${name}_FILE`);
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error(`${name} must be 32 bytes, got ${key.length}`);
  const id = env[`${name}_ID`] ?? defaultId;
  if (!id) throw new Error(`set ${name}_ID, the name that tells this key from the others`);
  return { id, key };
}

/**
 * The KEKs this server runs with: the current one (`DOCMIND_KEK`, id default "kek-1") first, which
 * wraps new keys, and while a rotation is under way the one being retired (`DOCMIND_KEK_PREVIOUS`,
 * its id required), which can still open keys not yet re-wrapped.
 */
export function loadKeks(env: NodeJS.ProcessEnv = process.env): readonly [Kek, ...Kek[]] {
  const current = loadKek(env);
  if (!env.DOCMIND_KEK_PREVIOUS && !env.DOCMIND_KEK_PREVIOUS_FILE) return [current];
  const previous = loadKek(env, "DOCMIND_KEK_PREVIOUS");
  if (previous.id === current.id) throw new Error("the previous KEK must have a different id");
  return [current, previous];
}
```

`packages/keystore-pg/src/index.ts`:

```ts
export { type Kek, loadKek, loadKeks } from "./kek";
export { PostgresKeyStore } from "./PostgresKeyStore";
```

- [ ] **Step 5: Run the tests, then the gate**

```bash
pnpm --filter @docmind/keystore-pg test
```

Expected: `kek.test.ts` 5 passed.

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0.

- [ ] **Step 6: Commit, check the size, open the draft PR**

```bash
git add -A
git commit -m "feat(keystore-pg): load a previous KEK alongside the current one" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git diff main...HEAD --numstat -- . ':!pnpm-lock.yaml' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
git push -u origin feat/m1-kek-previous
gh pr create --draft --base main --head feat/m1-kek-previous --title "feat(keystore-pg): load a previous KEK alongside the current one" --body "$(cat <<'EOF'
## Summary
- loadKeks(): DOCMIND_KEK (current, wraps new keys) plus, during a rotation, DOCMIND_KEK_PREVIOUS (+ _ID, required) which can still open keys not yet re-wrapped. Step 2 of the rotation runbook (PR 7g).

## Not counted toward the 200-line / 10-file limit
None.

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: about `60 lines, 3 files`, then the PR URL.

---

# PR 7e: the KEK rotation core

**Branch:** `feat/m1-kek-rotate`  **Budget:** 3 files, 187 lines. Spec §9 item 7 (owner request), part 5 of 7.

### Task 35: `rotateKek` and `verifyKeys`

**Files:**
- Create: `/Users/such/workspace/docmind/packages/keystore-pg/src/rotate.ts`, `apps/server/app/keys/rotateKek.test.ts`
- Modify: `/Users/such/workspace/docmind/packages/keystore-pg/src/index.ts`

**Interfaces:**
- Consumes: `Kek`, `wrapKey`, `unwrapKey` (PR 7a); `PostgresKeyStore` (PR 7b) and the server test helpers for the tests (they live in `apps/server`, where the database harness is).
- Produces (from `@docmind/keystore-pg`): `interface RotateResult { rotated: number; failed: string[]; remaining: Record<string, number> }`; `rotateKek(pool: Pool, keks: readonly [Kek, ...Kek[]], batchSize = 100): Promise<RotateResult>`; `interface VerifyResult { verified: number; wrongKek: number; failed: string[] }`; `verifyKeys(pool: Pool, kek: Kek): Promise<VerifyResult>`. `pool` must be the **owner** role's (the tool reads and updates `data_keys`, which `docmind_app` cannot).

**Design.**
- *What it does:* for every live row wrapped by a KEK in the list other than `keks[0]`, unwrap the data key with the KEK the row names, wrap the same bytes with `keks[0]`, and update the row. Data keys do not change, so nothing encrypted under them has to be touched.
- *Idempotent and resumable:* work is done in batches of `batchSize`; each batch is one transaction (`SELECT ... FOR UPDATE SKIP LOCKED` of rows not yet on the target KEK, then an `UPDATE` per row). A crash rolls the batch back whole; a re-run selects only rows still on an old KEK, so it continues where it stopped, and a run when everything is done selects nothing and changes nothing.
- *Tombstones:* rows with `wrapped_dek IS NULL` (erased users) are never selected, so their state is untouched.
- *No plaintext keys leave the process:* a data key exists in a local variable between unwrap and wrap; the result carries counts and subject ids only, and nothing is logged.
- *Bad rows do not block the rest:* a row that will not open under the KEK it names goes into `failed` and is left exactly as it was; rows under a KEK id not provided are left alone and counted in `remaining`. The caller (the command, PR 7g) exits non-zero for either.
- *Trade-off:* the tool takes row locks per batch (short); it is meant to be run by one operator, so `SKIP LOCKED` can leave a row to the next run if a concurrent writer holds it, and `remaining` says so.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m1-kek-rotate
```

- [ ] **Step 2: Write the failing tests**

Five users with keys under the old KEK, one of them erased; rotate; every key opens with the new KEK alone and is the same data key; the tombstone is untouched; a second run changes nothing. `apps/server/app/keys/rotateKek.test.ts`:

```ts
import { randomBytes, randomUUID } from "node:crypto";
import { PostgresKeyStore, rotateKek, verifyKeys } from "@docmind/keystore-pg";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword } from "../db/migrate";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";

const oldKek = { id: "kek-1", key: randomBytes(32) };
const newKek = { id: "kek-2", key: randomBytes(32) };

describe.skipIf(!PG_URL)("KEK rotation (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;
  let deks: Map<string, Buffer>;

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    app = new Pool({ connectionString: db.appUrl });
  });

  afterAll(async () => {
    await app?.end();
    await db?.drop();
  });

  /** Five users with keys under the old KEK, one of them erased. */
  beforeEach(async () => {
    await db.owner.query("TRUNCATE data_keys");
    const store = new PostgresKeyStore(app, [oldKek]);
    deks = new Map();
    for (let i = 0; i < 5; i++) {
      const subject = randomUUID();
      deks.set(subject, await store.getOrCreate(subject));
    }
    await store.destroy([...deks.keys()][4] as string);
  });

  const rows = async () =>
    (await db.owner.query("SELECT * FROM data_keys ORDER BY subject_id")).rows;

  it("moves every live key to the new KEK without changing any data key", async () => {
    const result = await rotateKek(db.owner, [newKek, oldKek], 2);
    expect(result).toEqual({ rotated: 4, failed: [], remaining: {} });

    const onlyNew = new PostgresKeyStore(app, [newKek]);
    for (const [subject, dek] of deks) {
      const got = await onlyNew.get(subject);
      if (await onlyNew.wasDestroyed(subject)) expect(got).toBeNull();
      else expect(got?.equals(dek)).toBe(true);
    }
    expect(await verifyKeys(db.owner, newKek)).toEqual({ verified: 4, wrongKek: 0, failed: [] });
  });

  it("leaves a tombstone exactly as it was", async () => {
    const before = (await rows()).filter((r) => r.destroyed_at);
    await rotateKek(db.owner, [newKek, oldKek]);
    expect((await rows()).filter((r) => r.destroyed_at)).toEqual(before);
    expect(before).toHaveLength(1);
  });

  it("is a no-op when run again", async () => {
    await rotateKek(db.owner, [newKek, oldKek]);
    const settled = await rows();
    expect(await rotateKek(db.owner, [newKek, oldKek])).toEqual({
      rotated: 0,
      failed: [],
      remaining: {},
    });
    expect(await rows()).toEqual(settled);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm build
pnpm --filter @docmind/server exec vitest run app/keys/rotateKek.test.ts
```

Expected: FAIL, `rotateKek is not a function` (not exported yet).

- [ ] **Step 4: Implement**

`packages/keystore-pg/src/rotate.ts`:

```ts
import type { Pool } from "pg";
import type { Kek } from "./kek";
import { unwrapKey, wrapKey } from "./wrap";

export interface RotateResult {
  /** Keys re-wrapped by this run. */
  rotated: number;
  /** Subjects whose wrapped key would not open under the KEK it names; left exactly as they were. */
  failed: string[];
  /** Live keys still wrapped by some other KEK id afterwards, by id and count (an id nobody gave us, or a failure). */
  remaining: Record<string, number>;
}

/**
 * Re-wraps every live data key from the other KEKs to `keks[0]`. It needs the table itself, so it
 * connects as the migration (owner) role, not as docmind_app.
 *
 * - Safe to stop and re-run: each batch is one transaction that moves rows from an old KEK to the new
 *   one, and a row already on the new KEK is never selected, so a second run does nothing.
 * - Tombstones (destroyed subjects, no key material) are never selected or changed.
 * - A data key exists in memory only between unwrap and wrap, and nothing here prints or returns one.
 * - A row that will not open is reported in `failed`, skipped, and left untouched.
 */
export async function rotateKek(
  pool: Pool,
  keks: readonly [Kek, ...Kek[]],
  batchSize = 100,
): Promise<RotateResult> {
  const [target] = keks;
  const byId = new Map(keks.map((k) => [k.id, k]));
  const failed = new Set<string>();
  let rotated = 0;

  for (;;) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{
        subject_id: string;
        wrapped_dek: Buffer;
        kek_id: string;
      }>(
        `SELECT subject_id, wrapped_dek, kek_id FROM data_keys
          WHERE wrapped_dek IS NOT NULL AND kek_id <> $1 AND kek_id = ANY ($2::text[])
            AND subject_id <> ALL ($3::text[])
          ORDER BY subject_id LIMIT $4 FOR UPDATE SKIP LOCKED`,
        [target.id, [...byId.keys()], [...failed], batchSize],
      );
      for (const row of rows) {
        let rewrapped: Buffer;
        try {
          const dek = unwrapKey((byId.get(row.kek_id) as Kek).key, row.subject_id, row.wrapped_dek);
          rewrapped = wrapKey(target.key, row.subject_id, dek);
        } catch {
          failed.add(row.subject_id); // will not open under the KEK it names: report it, change nothing
          continue;
        }
        await client.query(
          "UPDATE data_keys SET wrapped_dek = $2, kek_id = $3 WHERE subject_id = $1",
          [row.subject_id, rewrapped, target.id],
        );
        rotated++;
      }
      await client.query("COMMIT");
      if (rows.length === 0) break;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  const { rows } = await pool.query<{ kek_id: string; n: string }>(
    `SELECT kek_id, count(*) AS n FROM data_keys
      WHERE wrapped_dek IS NOT NULL AND kek_id <> $1 GROUP BY kek_id`,
    [target.id],
  );
  return {
    rotated,
    failed: [...failed].sort(),
    remaining: Object.fromEntries(rows.map((r) => [r.kek_id, Number(r.n)])),
  };
}

export interface VerifyResult {
  /** Live keys that open with `kek` alone. */
  verified: number;
  /** Live keys wrapped under a different KEK id. */
  wrongKek: number;
  /** Live keys that name `kek` but do not open. */
  failed: string[];
}

/** Checks, with only `kek`, that every live key opens: what must hold before the old KEK is retired. */
export async function verifyKeys(pool: Pool, kek: Kek): Promise<VerifyResult> {
  const { rows } = await pool.query<{ subject_id: string; wrapped_dek: Buffer; kek_id: string }>(
    "SELECT subject_id, wrapped_dek, kek_id FROM data_keys WHERE wrapped_dek IS NOT NULL ORDER BY subject_id",
  );
  const result: VerifyResult = { verified: 0, wrongKek: 0, failed: [] };
  for (const row of rows) {
    if (row.kek_id !== kek.id) result.wrongKek++;
    else {
      try {
        unwrapKey(kek.key, row.subject_id, row.wrapped_dek);
        result.verified++;
      } catch {
        result.failed.push(row.subject_id);
      }
    }
  }
  return result;
}
```

`packages/keystore-pg/src/index.ts`:

```ts
export { type Kek, loadKek, loadKeks } from "./kek";
export { PostgresKeyStore } from "./PostgresKeyStore";
export { type RotateResult, type VerifyResult, rotateKek, verifyKeys } from "./rotate";
```

- [ ] **Step 5: Run the test, then the gate**

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm build
pnpm --filter @docmind/server exec vitest run app/keys/rotateKek.test.ts
```

Expected: `3 passed`.

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0.

- [ ] **Step 6: Commit, check the size, open the draft PR**

```bash
git add -A
git commit -m "feat(keystore-pg): rotateKek re-wraps every data key to the current KEK" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git diff main...HEAD --numstat -- . ':!pnpm-lock.yaml' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
git push -u origin feat/m1-kek-rotate
gh pr create --draft --base main --head feat/m1-kek-rotate --title "feat(keystore-pg): rotateKek re-wraps every data key to the current KEK" --body "$(cat <<'EOF'
## Summary
- rotateKek(ownerPool, [newKek, oldKek]): re-wraps every live data_keys row from the old KEK to the new one in atomic batches (FOR UPDATE SKIP LOCKED); idempotent and resumable (a re-run selects only rows still on an old KEK); tombstones are never selected; data keys are unchanged and never leave the function. verifyKeys(pool, kek) proves every live key opens with that KEK alone.
- Tests on a real database: rotate, then every key unwraps with only the new KEK and equals the original; the tombstone row is byte-identical; a second run is a no-op.
- Crash and bad-row tests follow in PR 7f; the command and runbook in PR 7g.

## Not counted toward the 200-line / 10-file limit
None.

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test` (with DOCMIND_TEST_PG_URL)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: about `187 lines, 3 files`, then the PR URL.

---

# PR 7f: rotation failure-mode tests

**Branch:** `feat/m1-kek-rotate-failures`  **Budget:** 1 file, 48 lines. Spec §9 item 7 (owner request), part 6 of 7. Tests only.

### Task 36: crash recovery, corrupt rows, unknown KEKs

**Files:**
- Modify: `/Users/such/workspace/docmind/apps/server/app/keys/rotateKek.test.ts`

**Interfaces:**
- Consumes: `rotateKek`, `verifyKeys` (PR 7e).
- Produces: nothing new; two tests: a run that crashes in the middle of its second batch leaves exactly the first batch committed (the failing `UPDATE` is injected through a pool wrapper), and a re-run finishes the rest; a row that does not open and a row under an unknown KEK are reported and left byte-identical while the others are rotated.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m1-kek-rotate-failures
```

- [ ] **Step 2: Add the tests** (they pin behaviour PR 7e already has; a failure here is a bug in `rotateKek`)

```diff
@@ -71,3 +71,51 @@ describe.skipIf(!PG_URL)("KEK rotation (needs DOCMIND_TEST_PG_URL)", () => {
     expect(await rows()).toEqual(settled);
   });
+
+  it("finishes after a crash: batches are atomic and a re-run takes the rest", async () => {
+    let updates = 0;
+    const crashing = {
+      query: db.owner.query.bind(db.owner),
+      connect: async () => {
+        const client = await db.owner.connect();
+        const run = client.query.bind(client) as (...args: unknown[]) => unknown;
+        (client as { query: unknown }).query = (...args: unknown[]) => {
+          if (
+            typeof args[0] === "string" &&
+            args[0].startsWith("UPDATE data_keys") &&
+            ++updates === 3
+          ) {
+            throw new Error("crash");
+          }
+          return run(...args);
+        };
+        return client;
+      },
+    } as unknown as Pool;
+
+    await expect(rotateKek(crashing, [newKek, oldKek], 2)).rejects.toThrow("crash");
+    const half = await db.owner.query(
+      "SELECT count(*)::int AS n FROM data_keys WHERE kek_id = 'kek-2'",
+    );
+    expect(half.rows[0].n).toBe(2); // the first batch committed, the second rolled back whole
+
+    const rest = await rotateKek(db.owner, [newKek, oldKek], 2);
+    expect(rest).toEqual({ rotated: 2, failed: [], remaining: {} });
+    expect(await verifyKeys(db.owner, newKek)).toMatchObject({ verified: 4, wrongKek: 0 });
+  });
+
+  it("reports a key that will not open, and keys wrapped by an unknown KEK, and changes neither", async () => {
+    const [bad, stranger] = [...deks.keys()];
+    await db.owner.query("UPDATE data_keys SET wrapped_dek = $2 WHERE subject_id = $1", [
+      bad,
+      randomBytes(60),
+    ]);
+    await db.owner.query("UPDATE data_keys SET kek_id = 'kek-0' WHERE subject_id = $1", [stranger]);
+    const before = (await rows()).filter((r) => r.subject_id === bad || r.subject_id === stranger);
+
+    const result = await rotateKek(db.owner, [newKek, oldKek]);
+    expect(result).toEqual({ rotated: 2, failed: [bad], remaining: { "kek-1": 1, "kek-0": 1 } });
+    expect((await rows()).filter((r) => r.subject_id === bad || r.subject_id === stranger)).toEqual(
+      before,
+    );
+  });
 });
```

- [ ] **Step 3: Run them, then the gate**

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm --filter @docmind/server exec vitest run app/keys/rotateKek.test.ts
```

Expected: `5 passed`.

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0.

- [ ] **Step 4: Commit, check the size, open the draft PR**

```bash
git add -A
git commit -m "test(keystore-pg): rotation survives a crash and reports bad rows" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git diff main...HEAD --numstat -- . ':!pnpm-lock.yaml' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
git push -u origin feat/m1-kek-rotate-failures
gh pr create --draft --base main --head feat/m1-kek-rotate-failures --title "test(keystore-pg): rotation survives a crash and reports bad rows" --body "$(cat <<'EOF'
## Summary
- Crash test: an UPDATE injected to fail in the second batch rolls that batch back whole (2 of 4 keys rotated), and a re-run rotates the remaining 2.
- A key that does not open, and a key under a KEK nobody provided, are reported (failed / remaining) and left byte-identical; the other keys still rotate.

## Not counted toward the 200-line / 10-file limit
None.

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test` (with DOCMIND_TEST_PG_URL)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: about `48 lines, 1 file`, then the PR URL.

---

# PR 7g: the rotation command and its runbook

**Branch:** `feat/m1-kek-rotate-cli`  **Budget:** 5 files, 148 lines. Spec §9 item 7 (owner request), part 7 of 7. The spec's runbook is M7 PR 48; this is its KEK chapter, delivered with the tool.

### Task 37: `pnpm --filter @docmind/server keys:rotate` and `docs/operations/rotate-kek.md`

**Files:**
- Create: `/Users/such/workspace/docmind/apps/server/app/keys/rotateKek.ts`, `rotateCli.test.ts`, `docs/operations/rotate-kek.md`
- Modify: `/Users/such/workspace/docmind/apps/server/package.json`, `.env.example`

**Interfaces:**
- Consumes: `loadKeks`, `rotateKek`, `verifyKeys`, `Kek` (`@docmind/keystore-pg`); the test helpers.
- Produces: `runRotation(pool: Pool, keks: readonly [Kek, ...Kek[]], options?: { verifyOnly?: boolean }, log?: (line: string) => void): Promise<number>` (rotates unless `verifyOnly`, then verifies with the current KEK alone, prints counts and subject ids, returns the exit code: 0 only when every live key is on the current KEK and opens); the script `keys:rotate` (`tsx app/keys/rotateKek.ts [--verify-only]`), which reads `DOCMIND_MIGRATE_URL` (the owner's URL) and the KEK variables.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m1-kek-rotate-cli
```

- [ ] **Step 2: Write the failing test**

It runs the whole command against a database, checks what it prints (counts only, never a data key, in hex or base64), and that verification fails with exit code 1 when a key is on another KEK. `apps/server/app/keys/rotateCli.test.ts`:

```ts
import { randomBytes, randomUUID } from "node:crypto";
import { PostgresKeyStore } from "@docmind/keystore-pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword } from "../db/migrate";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";
import { runRotation } from "./rotateKek";

const oldKek = { id: "kek-1", key: randomBytes(32) };
const newKek = { id: "kek-2", key: randomBytes(32) };

describe.skipIf(!PG_URL)("the rotation command (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;
  const deks = new Map<string, Buffer>();

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    app = new Pool({ connectionString: db.appUrl });
    const store = new PostgresKeyStore(app, [oldKek]);
    for (let i = 0; i < 3; i++) {
      const subject = randomUUID();
      deks.set(subject, await store.getOrCreate(subject));
    }
  });

  afterAll(async () => {
    await app?.end();
    await db?.drop();
  });

  it("never returns or prints a data key, and exits non-zero until everything is rotated", async () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    expect(await runRotation(db.owner, [newKek, oldKek], {}, log)).toBe(0);
    expect(lines).toEqual([
      "rotated 3 key(s) to kek-2",
      "3 key(s) open with kek-2 alone; 0 on another KEK; 0 do not open",
    ]);
    const secrets = [...deks.values()].flatMap((d) => [d.toString("hex"), d.toString("base64")]);
    for (const secret of secrets) expect(lines.join("\n")).not.toContain(secret);

    const [first] = [...deks.keys()];
    await db.owner.query("UPDATE data_keys SET kek_id = 'kek-1' WHERE subject_id = $1", [first]);
    expect(await runRotation(db.owner, [newKek], { verifyOnly: true }, log)).toBe(1);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm --filter @docmind/server exec vitest run app/keys/rotateCli.test.ts
```

Expected: FAIL, `Failed to resolve import "./rotateKek"`.

- [ ] **Step 4: Implement**

`apps/server/app/keys/rotateKek.ts`:

```ts
import { type Kek, loadKeks, rotateKek, verifyKeys } from "@docmind/keystore-pg";
import { Pool } from "pg";

/**
 * Re-wraps every data key to the current KEK, then proves they all open with that KEK alone.
 * Prints counts and subject ids, never key material. Returns the process exit code: 0 only when
 * every live key is on the current KEK and opens.
 */
export async function runRotation(
  pool: Pool,
  keks: readonly [Kek, ...Kek[]],
  options: { verifyOnly?: boolean } = {},
  log: (line: string) => void = console.log,
): Promise<number> {
  const [current] = keks;
  let code = 0;
  if (!options.verifyOnly) {
    const run = await rotateKek(pool, keks);
    log(`rotated ${run.rotated} key(s) to ${current.id}`);
    for (const subject of run.failed) log(`FAILED to open the key of ${subject}; left unchanged`);
    for (const [id, n] of Object.entries(run.remaining)) log(`${n} key(s) still wrapped by ${id}`);
    if (run.failed.length > 0 || Object.keys(run.remaining).length > 0) code = 1;
  }
  const check = await verifyKeys(pool, current);
  log(
    `${check.verified} key(s) open with ${current.id} alone; ${check.wrongKek} on another KEK; ${check.failed.length} do not open`,
  );
  return check.wrongKek > 0 || check.failed.length > 0 ? 1 : code;
}

async function main(): Promise<void> {
  const url = process.env.DOCMIND_MIGRATE_URL;
  if (!url) throw new Error("DOCMIND_MIGRATE_URL is not set (the owner role's connection string)");
  const pool = new Pool({ connectionString: url });
  try {
    process.exitCode = await runRotation(pool, loadKeks(), {
      verifyOnly: process.argv.includes("--verify-only"),
    });
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
```

Add the script in `apps/server/package.json`:

```diff
@@ -10,5 +10,6 @@
     "typecheck": "tsc -p tsconfig.json --noEmit",
     "typecheck:tests": "tsc -p tsconfig.test.json",
-    "db:migrate": "tsx app/db/migrate.ts"
+    "db:migrate": "tsx app/db/migrate.ts",
+    "keys:rotate": "tsx app/keys/rotateKek.ts"
   },
   "dependencies": {
```

`.env.example` (the KEK variables, including the rotation-only ones):

```diff
@@ -12,4 +12,12 @@ DOCMIND_APP_DB_PASSWORD=change-me-locally
 DATABASE_URL=postgres://docmind_app:change-me-locally@127.0.0.1:5432/docmind
 
+# Master key that wraps every user's data key. Generate: openssl rand -base64 32
+# Losing it makes all encrypted data unreadable; leaking it exposes the wrapped data keys.
+DOCMIND_KEK=
+DOCMIND_KEK_ID=kek-1
+# Only while rotating the KEK (docs/operations/rotate-kek.md): the key being retired.
+# DOCMIND_KEK_PREVIOUS=
+# DOCMIND_KEK_PREVIOUS_ID=
+
 # Set to true when the server is reached over HTTPS (marks the session cookie Secure).
 DOCMIND_COOKIE_SECURE=false
```

The runbook, `docs/operations/rotate-kek.md`:

```
# Rotating the master key (KEK)

Every user's data key is stored wrapped by the KEK (`data_keys.kek_id` names which one). Rotation
re-wraps each stored key under a new KEK. It does **not** change any data key, so no event, snapshot or
blob is rewritten, and it does not help if a data key itself leaked (that needs re-encryption, which
v1 does not have).

Rotate on a schedule, when someone with access to the KEK leaves, and at once if the KEK may have leaked.

## Before you start

- A database backup, and the old KEK safe in your secret store.
- The migration (owner) role's URL: the tool reads and updates `data_keys`, which `docmind_app` cannot.
- Every server instance can be restarted.

## Steps

1. **Make the new KEK.** `openssl rand -base64 32`. Pick an id that was never used, for example `kek-2`.
2. **Run servers with both.** Set on every instance and restart:
   `DOCMIND_KEK=<new>`, `DOCMIND_KEK_ID=kek-2`, `DOCMIND_KEK_PREVIOUS=<old>`, `DOCMIND_KEK_PREVIOUS_ID=kek-1`.
   New users' keys are now wrapped by the new KEK, and old keys still open with the previous one.
3. **Re-wrap.** From a machine that can reach the database, with the same four variables set:
   ```bash
   DOCMIND_MIGRATE_URL=postgres://<owner>@<host>/docmind pnpm --filter @docmind/server keys:rotate
   ```
   It prints `rotated N key(s) to kek-2`, then `M key(s) open with kek-2 alone; 0 on another KEK; 0 do not open`,
   and exits 0. It is safe to stop (Ctrl-C) and to run again: each batch of 100 is one transaction, a key
   already on the new KEK is skipped, and tombstones (erased users) are never touched.
4. **If it exits 1,** read the lines it printed. `FAILED to open the key of <user>` means that row does not
   open under the KEK it names (corruption, or the wrong previous KEK): the row is left as it was; fix the cause
   and run again. `K key(s) still wrapped by <id>` means keys under a KEK you did not provide: add it as the
   previous KEK and run again. Do not go on until the run is clean.
5. **Verify on its own.** `... pnpm --filter @docmind/server keys:rotate -- --verify-only` must exit 0.
6. **Drop the old KEK from the servers.** Remove `DOCMIND_KEK_PREVIOUS*` and restart every instance.
7. **Retire the old KEK last.** Backups taken before step 3 still hold keys wrapped by it, and restoring one
   needs it. Keep the old KEK until those backups have expired (30 days by default, spec §4.4), then destroy it.

If the old KEK leaked, steps 1-6 protect the live database, but a leaked backup from before the rotation can
still be opened with it. That is why backup retention is bounded.
```

- [ ] **Step 5: Run the test, then the gate**

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm --filter @docmind/server exec vitest run app/keys/rotateCli.test.ts
```

Expected: `1 passed`.

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0.

- [ ] **Step 6: Try it by hand against a scratch database** (the runbook's steps 3 and 5)

```bash
export DOCMIND_MIGRATE_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
export DOCMIND_KEK=$(openssl rand -base64 32) DOCMIND_KEK_ID=kek-2
export DOCMIND_KEK_PREVIOUS=$(openssl rand -base64 32) DOCMIND_KEK_PREVIOUS_ID=kek-1
pnpm --filter @docmind/server keys:rotate; echo "exit $?"
pnpm --filter @docmind/server keys:rotate -- --verify-only; echo "exit $?"
```

Expected on a database with no keys yet: `rotated 0 key(s) to kek-2`, `0 key(s) open with kek-2 alone; 0 on another KEK; 0 do not open`, `exit 0`, twice. (With keys created under a different `kek-1`, the first run prints `FAILED to open the key of <user>` lines and exits 1; that is the tool refusing to guess.)

- [ ] **Step 7: Commit, check the size, open the draft PR**

```bash
git add -A
git commit -m "feat(server): keys:rotate command and KEK rotation runbook" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git diff main...HEAD --numstat -- . ':!pnpm-lock.yaml' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
git push -u origin feat/m1-kek-rotate-cli
gh pr create --draft --base main --head feat/m1-kek-rotate-cli --title "feat(server): keys:rotate command and KEK rotation runbook" --body "$(cat <<'EOF'
## Summary
- pnpm --filter @docmind/server keys:rotate [--verify-only]: re-wraps every data key to the current KEK as the owner role, then verifies they all open with that KEK alone. Prints counts and subject ids only (tested not to contain any data key); exits non-zero for a key that fails to open, a key under an unknown KEK, or a failed verification.
- docs/operations/rotate-kek.md: the runbook (generate, run with both KEKs, re-wrap, verify, drop the old KEK from servers, retire it only after pre-rotation backups expire).
- .env.example documents DOCMIND_KEK, DOCMIND_KEK_ID and the rotation-only DOCMIND_KEK_PREVIOUS[_ID].

## Not counted toward the 200-line / 10-file limit
None.

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test` (with DOCMIND_TEST_PG_URL)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: about `148 lines, 5 files`, then the PR URL.

---

# PR 8a: Loom's database role and schema

**Branch:** `feat/m1-loom-role`  **Budget:** 4 files, 100 lines. Spec §9 item 8, part 1 of 4. Nothing connects as the new role yet.

### Task 38: `docmind_loom` owns a `loom` schema and nothing else

**Files:**
- Create: `/Users/such/workspace/docmind/infra/migrations/0008_loom_role.sql`, `apps/server/app/db/loomRole.test.ts`
- Modify: `/Users/such/workspace/docmind/apps/server/app/db/migrate.ts`, `apps/server/app/db/testSupport.ts`

**Interfaces:**
- Consumes: M0's `migrate`, `setAppRolePassword`, `createTestDb`, `TestDb`, `APP_PASSWORD`.
- Produces: role `docmind_loom` (`NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`, no memberships, guarded like `docmind_app`) that owns schema `loom` and has `search_path = loom`; `setRolePassword(pool: Pool, role: "docmind_app" | "docmind_loom", password: string): Promise<void>` (`setAppRolePassword(pool, password)` stays, now a thin wrapper); `pnpm db:migrate` also logs the role in when `DOCMIND_LOOM_DB_PASSWORD` is set; test helpers `LOOM_PASSWORD` and `TestDb.loomUrl`.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m1-loom-role
```

- [ ] **Step 2: Write the failing test**

It checks that the role is unprivileged, owns `loom` and defaults to it; cannot read `public.users` or `public.data_keys`; creates its tables only in `loom`; and that `docmind_app` cannot see them. `apps/server/app/db/loomRole.test.ts`:

```ts
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword, setRolePassword } from "./migrate";
import { APP_PASSWORD, LOOM_PASSWORD, PG_URL, type TestDb, createTestDb } from "./testSupport";

describe.skipIf(!PG_URL)("docmind_loom role and schema (need DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let loom: Pool;
  let app: Pool;

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await setRolePassword(db.owner, "docmind_loom", LOOM_PASSWORD);
    loom = new Pool({ connectionString: db.loomUrl });
    app = new Pool({ connectionString: db.appUrl });
  });

  afterAll(async () => {
    await loom?.end();
    await app?.end();
    await db?.drop();
  });

  it("is unprivileged, owns the loom schema, and defaults to it", async () => {
    const { rows } = await loom.query(
      `SELECT current_user AS who, current_schema() AS schema, rolsuper, rolbypassrls,
              (SELECT nspowner = r.oid FROM pg_namespace WHERE nspname = 'loom') AS owns
         FROM pg_roles r WHERE rolname = current_user`,
    );
    expect(rows[0]).toEqual({
      who: "docmind_loom",
      schema: "loom",
      rolsuper: false,
      rolbypassrls: false,
      owns: true,
    });
  });

  it("cannot read DocMind's tables, and creates its own tables only in its schema", async () => {
    await expect(loom.query("SELECT * FROM public.users")).rejects.toThrow(/permission denied/);
    await expect(loom.query("SELECT * FROM public.data_keys")).rejects.toThrow(/permission denied/);
    await loom.query("CREATE TABLE events_probe (id int)");
    const { rows } = await loom.query("SELECT to_regclass('loom.events_probe') AS t");
    expect(rows[0].t).toBe("events_probe");
  });

  it("is invisible to the app role", async () => {
    await expect(app.query("SELECT * FROM loom.events_probe")).rejects.toThrow(/permission denied/);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm --filter @docmind/server exec vitest run app/db/loomRole.test.ts
```

Expected: FAIL, `setRolePassword` and `LOOM_PASSWORD` are not exported.

- [ ] **Step 4: Implement**

`infra/migrations/0008_loom_role.sql`:

```sql
-- Loom's Postgres stores (event log, snapshots, leases) create and migrate their own tables, so
-- they get their own role and their own schema. The role owns that schema and nothing else:
-- it has no privilege on DocMind's tables, and docmind_app has none on Loom's. Like docmind_app it
-- is not privileged and cannot bypass row-level security; it starts without a login and
-- `pnpm db:migrate` gives it one when DOCMIND_LOOM_DB_PASSWORD is set.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'docmind_loom') THEN
    CREATE ROLE docmind_loom NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles r WHERE rolname = 'docmind_loom' AND (rolsuper OR rolbypassrls OR rolcreaterole
      OR rolcreatedb OR rolreplication OR EXISTS (SELECT FROM pg_auth_members m WHERE m.member = r.oid))) THEN
    RAISE EXCEPTION 'docmind_loom must not be privileged or a member of any role';
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS loom AUTHORIZATION docmind_loom;
ALTER ROLE docmind_loom SET search_path = loom;
```

`apps/server/app/db/migrate.ts` (generalise the password helper; the CLI also sets the Loom role's login):

```diff
@@ -45,13 +45,20 @@ export async function migrate(pool: Pool, dir: string = MIGRATIONS_DIR): Promise
 }
 
-/** Lets `docmind_app` log in. DDL cannot take parameters, so Postgres quotes the password itself. */
-export async function setAppRolePassword(pool: Pool, password: string): Promise<void> {
+/** Lets a DocMind role log in. DDL cannot take parameters, so Postgres quotes the password itself. */
+export async function setRolePassword(
+  pool: Pool,
+  role: "docmind_app" | "docmind_loom",
+  password: string,
+): Promise<void> {
   const { rows } = await pool.query<{ ddl: string }>(
-    "SELECT format('ALTER ROLE docmind_app LOGIN PASSWORD %L', $1::text) AS ddl",
-    [password],
+    "SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) AS ddl",
+    [role, password],
   );
   await pool.query(rows[0]?.ddl as string);
 }
 
+export const setAppRolePassword = (pool: Pool, password: string) =>
+  setRolePassword(pool, "docmind_app", password);
+
 async function main(): Promise<void> {
   const url = process.env.DOCMIND_MIGRATE_URL;
@@ -63,4 +70,6 @@ async function main(): Promise<void> {
     const password = process.env.DOCMIND_APP_DB_PASSWORD;
     if (password) await setAppRolePassword(pool, password);
+    const loomPassword = process.env.DOCMIND_LOOM_DB_PASSWORD;
+    if (loomPassword) await setRolePassword(pool, "docmind_loom", loomPassword);
   } finally {
     await pool.end();
```

`apps/server/app/db/testSupport.ts`:

```diff
@@ -7,4 +7,5 @@ export const PG_URL = process.env.DOCMIND_TEST_PG_URL;
 /** Cluster-wide and fixed, so test files agree on it. */
 export const APP_PASSWORD = "docmind_app_test";
+export const LOOM_PASSWORD = "docmind_loom_test";
 
 export interface TestDb {
@@ -13,4 +14,6 @@ export interface TestDb {
   /** The same database as `docmind_app`; call `setAppRolePassword` first. */
   appUrl: string;
+  /** The same database as `docmind_loom`; call `setRolePassword(owner, "docmind_loom", LOOM_PASSWORD)` first. */
+  loomUrl: string;
   drop(): Promise<void>;
 }
@@ -30,8 +33,12 @@ export async function createTestDb(): Promise<TestDb> {
   appUrl.username = "docmind_app";
   appUrl.password = APP_PASSWORD;
+  const loomUrl = new URL(url);
+  loomUrl.username = "docmind_loom";
+  loomUrl.password = LOOM_PASSWORD;
 
   return {
     owner,
     appUrl: appUrl.toString(),
+    loomUrl: loomUrl.toString(),
     async drop() {
       await owner.end();
```

- [ ] **Step 5: Run the test, then the gate**

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm --filter @docmind/server exec vitest run app/db/loomRole.test.ts
```

Expected: `3 passed`.

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0 (the M0 migration test and RLS guard still pass; they look at `public` only).

- [ ] **Step 6: Commit, check the size, open the draft PR**

```bash
git add -A
git commit -m "feat(db): docmind_loom role and loom schema for Loom's Postgres stores" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git diff main...HEAD --numstat -- . ':!pnpm-lock.yaml' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
git push -u origin feat/m1-loom-role
gh pr create --draft --base main --head feat/m1-loom-role --title "feat(db): docmind_loom role and loom schema for Loom's Postgres stores" --body "$(cat <<'EOF'
## Summary
- Loom's Postgres stores run DDL at boot, so they cannot use docmind_app (which owns nothing). Migration 0008 adds docmind_loom (unprivileged, no BYPASSRLS, same guard as docmind_app) owning schema loom; it has no privilege on DocMind's tables and docmind_app none on loom's. Spiked: the event store runs as such a role with search_path=loom.
- db:migrate gives the role a login when DOCMIND_LOOM_DB_PASSWORD is set (setRolePassword generalises setAppRolePassword).
- Nothing connects as it yet (PR 8c).

## Not counted toward the 200-line / 10-file limit
None.

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test` (with DOCMIND_TEST_PG_URL)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: about `100 lines, 4 files`, then the PR URL.

---

# PR 8b: which key encrypts which execution

**Branch:** `feat/m1-erasure-subject`  **Budget:** 2 files, 43 lines. Spec §9 item 8, part 2 of 4.

### Task 39: `executionIdFor` and `subjectOfExecution`

**Files:**
- Create: `/Users/such/workspace/docmind/apps/server/app/subject.ts`, `subject.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `executionIdFor(userId: string, name: string): string` → `u_<userId>:<name>`; `subjectOfExecution(e: { executionId: string }): string` → the lower-cased user id when the id is `u_<uuid>` optionally followed by `:...` (case-insensitive), otherwise the execution id itself. Its parameter type is a structural subset of Loom's `Pick<EventEnvelope, "executionId" | "workflowId">`, so it is passed straight to `EncryptingEventStore`/`EncryptingSnapshotStore` as `subjectOf`.

Why it exists: Loom decides which key encrypts an execution by calling `subjectOf` with only `{executionId, workflowId}` (`plugins/crypto/src/EncryptingEventStore.ts:169`), so the owning user must be recoverable from the execution id. Every execution a user owns (ingestion, chats, anything later) must be started with `executionIdFor`; one that is not is encrypted under its own key, which erasing the user does not destroy, so that data would outlive the user.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m1-erasure-subject
```

- [ ] **Step 2: Write the failing test**

`apps/server/app/subject.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { executionIdFor, subjectOfExecution } from "./subject";

const USER = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";

describe("erasure subject of an execution", () => {
  it("is the owning user for every execution that user owns", () => {
    expect(subjectOfExecution({ executionId: executionIdFor(USER, "ingest-1") })).toBe(USER);
    expect(subjectOfExecution({ executionId: executionIdFor(USER, "chat:2:x") })).toBe(USER);
    expect(subjectOfExecution({ executionId: `u_${USER}` })).toBe(USER);
  });

  it("is case-insensitive about the id, so one user never has two keys", () => {
    expect(subjectOfExecution({ executionId: `u_${USER.toUpperCase()}:x` })).toBe(USER);
  });

  it("is the execution itself when no user owns it", () => {
    for (const executionId of ["system-sweep", `x_${USER}:a`, "u_not-a-uuid:a", `u_${USER}x:a`]) {
      expect(subjectOfExecution({ executionId })).toBe(executionId);
    }
  });
});
```

- [ ] **Step 3: Run it to see it fail**

```bash
pnpm --filter @docmind/server exec vitest run app/subject.test.ts
```

Expected: FAIL, `Failed to resolve import "./subject"`.

- [ ] **Step 4: Implement**

`apps/server/app/subject.ts`:

```ts
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const USER_EXECUTION = new RegExp(`^u_(${UUID})(?::|$)`, "i");

/**
 * The execution id for something a user owns. Loom encrypts an execution's data under the key of
 * its erasure subject and learns the subject from the execution id alone, so every execution a user
 * owns must carry the user's id: that puts all of their data under one key, and destroying the key
 * erases it all. Callers that start executions for a user use this to build the id.
 */
export function executionIdFor(userId: string, name: string): string {
  return `u_${userId}:${name}`;
}

/**
 * The erasure subject of an execution: the owning user, or, for an execution no user owns (system
 * work), the execution itself, which is Loom's own default.
 */
export function subjectOfExecution(e: { executionId: string }): string {
  const match = USER_EXECUTION.exec(e.executionId);
  return match?.[1]?.toLowerCase() ?? e.executionId;
}
```

- [ ] **Step 5: Run the test, then the gate**

```bash
pnpm --filter @docmind/server exec vitest run app/subject.test.ts
```

Expected: `3 passed`.

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0.

- [ ] **Step 6: Commit, check the size, open the draft PR**

```bash
git add -A
git commit -m "feat(server): map an execution to its owning user for per-user keys" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git diff main...HEAD --numstat -- . ':!pnpm-lock.yaml' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
git push -u origin feat/m1-erasure-subject
gh pr create --draft --base main --head feat/m1-erasure-subject --title "feat(server): map an execution to its owning user for per-user keys" --body "$(cat <<'EOF'
## Summary
- Loom's encrypting stores learn an execution's erasure subject from its id alone. executionIdFor(userId, name) builds u_<userId>:<name>; subjectOfExecution maps it back (case-insensitive, so a user never has two keys) and falls back to the execution id for system work. Plan deviation 6.

## Not counted toward the 200-line / 10-file limit
None.

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: about `43 lines, 2 files`, then the PR URL.

---

# PR 8c: durable, encrypted Loom storage

**Branch:** `feat/m1-durable-storage`  **Budget:** 4 files, 184 lines (+ `pnpm-lock.yaml`). Spec §9 item 8, part 3 of 4.

### Task 40: the Postgres event store and snapshots, wrapped by Loom's encrypting stores

**Files:**
- Create: `/Users/such/workspace/docmind/apps/server/app/storage.ts`, `storage.test.ts`
- Modify: `/Users/such/workspace/docmind/package.json` (root), `apps/server/package.json`

**Interfaces:**
- Consumes: `PostgresKeyStore` (PR 7b); `subjectOfExecution`, `executionIdFor` (PR 8b); the `docmind_loom` role (PR 8a); from Loom `postgresStorage` (`@loom/plugin-postgres`), `EncryptingEventStore`, `EncryptingSnapshotStore`, `KeyStore`, `shredSubject`, `PayloadShreddedError` (`@loom/plugin-crypto`), `StorageConfig`, `PrincipalCryptoOptions` (`@loom/app`).
- Produces: `interface DurableStorageOptions { loomUrl: string; keys: KeyStore }`; `interface DurableStorage { storage: Extract<StorageConfig, {kind:"custom"}>; crypto: PrincipalCryptoOptions; sealed: { eventStore; snapshotStore }; raw: { eventStore; snapshotStore } }`; `createDurableStorage(options: DurableStorageOptions): DurableStorage`. `storage` goes to `defineConfig({ storage })`, `crypto` to `security.crypto`; `sealed` is the encrypting pair (what `storage` hands Loom); `raw` is the unwrapped pair, which M5's `shredSubject` needs. The event store seals nothing until event types are registered with `crypto.events.registerSensitive(eventType, paths)` (M2 onwards registers its own; `defineConfig` registers the principal's identity paths itself). The snapshot store seals the whole folded state (`sealState: true`). Both use `subjectOfExecution` and the same `keys`.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m1-durable-storage
```

- [ ] **Step 2: Link `@loom/plugin-postgres` and declare the dependencies**

```diff
@@ -29,4 +29,5 @@
       "@loom/effect-runtime": "link:../loom/packages/effect-runtime",
       "@loom/plugin-crypto": "link:../loom/plugins/crypto",
+      "@loom/plugin-postgres": "link:../loom/plugins/postgres",
       "@loom/workflow-runtime": "link:../loom/packages/workflow-runtime"
     }
```

`@loom/plugin-crypto` moves from `devDependencies` to `dependencies` (the server now uses it at runtime):

```diff
@@ -19,4 +19,6 @@
     "@loom/app": "*",
     "@loom/effect-runtime": "*",
+    "@loom/plugin-crypto": "*",
+    "@loom/plugin-postgres": "*",
     "@loom/workflow-runtime": "*",
     "pg": "^8.13.0",
@@ -29,6 +31,5 @@
     "vitest": "^2.1.8",
     "@types/pg": "^8.11.0",
-    "@loom/conformance": "*",
-    "@loom/plugin-crypto": "*"
+    "@loom/conformance": "*"
   }
 }
```

```bash
pnpm install
```

- [ ] **Step 3: Write the failing test**

Three behaviours against a real database: events are sealed under the user's key (not the execution's) and the raw log shows ciphertext; shredding one user's key makes that user's events unreadable (`PayloadShreddedError`) while another user's stay readable; a snapshot is sealed under the same key and unreadable once the key is destroyed. `apps/server/app/storage.test.ts`:

```ts
import { randomBytes, randomUUID } from "node:crypto";
import { PostgresKeyStore } from "@docmind/keystore-pg";
import { PayloadShreddedError, shredSubject } from "@loom/plugin-crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword, setRolePassword } from "./db/migrate";
import { APP_PASSWORD, LOOM_PASSWORD, PG_URL, type TestDb, createTestDb } from "./db/testSupport";
import { type DurableStorage, createDurableStorage } from "./storage";
import { executionIdFor } from "./subject";

describe.skipIf(!PG_URL)("durable, encrypted Loom storage (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;
  let keys: PostgresKeyStore;
  let stores: DurableStorage;

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await setRolePassword(db.owner, "docmind_loom", LOOM_PASSWORD);
    app = new Pool({ connectionString: db.appUrl });
    keys = new PostgresKeyStore(app, [{ id: "kek-1", key: randomBytes(32) }]);
    stores = createDurableStorage({ loomUrl: db.loomUrl, keys });
    stores.crypto.events.registerSensitive("NOTE_ADDED", ["text"]);
  });

  afterAll(async () => {
    await stores?.storage.eventStore.close?.();
    await app?.end();
    await db?.drop();
  });

  const note = (executionId: string, text: string) => ({
    id: randomUUID(),
    workflowId: "notes",
    executionId,
    eventType: "NOTE_ADDED",
    sequence: 0,
    timestamp: 1,
    payload: { text, author: "kept in the clear" },
  });

  it("seals each user's events under that user's key, not the execution's", async () => {
    const userA = randomUUID();
    const exec = executionIdFor(userA, "notes-1");
    await stores.sealed.eventStore.append(note(exec, "secret A"));

    expect((await stores.sealed.eventStore.read(exec))[0]?.payload).toMatchObject({
      text: "secret A",
    });
    const stored = (await stores.raw.eventStore.read(exec))[0]?.payload as { text: object };
    expect(JSON.stringify(stored.text)).not.toContain("secret A");

    const { rows } = await db.owner.query(
      "SELECT subject_id FROM data_keys WHERE subject_id = ANY($1)",
      [[userA, exec]],
    );
    expect(rows).toEqual([{ subject_id: userA }]);
  });

  it("makes one user's events unreadable after their key is destroyed, and no one else's", async () => {
    const [userA, userB] = [randomUUID(), randomUUID()];
    const [execA1, execA2, execB] = [
      executionIdFor(userA, "one"),
      executionIdFor(userA, "two"),
      executionIdFor(userB, "one"),
    ];
    for (const e of [execA1, execA2, execB])
      await stores.sealed.eventStore.append(note(e, "secret"));

    for (const e of [execA1, execA2]) {
      await shredSubject(keys, stores.raw.eventStore, e, {
        subjectId: userA,
        executionIds: [execA1, execA2],
        snapshotStore: stores.raw.snapshotStore,
      });
    }

    await expect(stores.sealed.eventStore.read(execA1)).rejects.toBeInstanceOf(
      PayloadShreddedError,
    );
    await expect(stores.sealed.eventStore.read(execA2)).rejects.toBeInstanceOf(
      PayloadShreddedError,
    );
    expect((await stores.sealed.eventStore.read(execB))[0]?.payload).toMatchObject({
      text: "secret",
    });
    expect(await keys.wasDestroyed(userA)).toBe(true);
    expect(await keys.wasDestroyed(userB)).toBe(false);
  });

  it("seals snapshots under the same key, so the checkpoint is erased with the events", async () => {
    const user = randomUUID();
    const exec = executionIdFor(user, "snap");
    const state = { variables: { draft: "private words" } };
    const snapshot = {
      id: randomUUID(),
      executionId: exec,
      workflowId: "notes",
      sequence: 1,
      createdAt: 1,
    };
    // biome-ignore lint/suspicious/noExplicitAny: a minimal folded state is enough to seal
    await stores.sealed.snapshotStore.save({ ...snapshot, state: state as any });

    expect((await stores.sealed.snapshotStore.loadLatest(exec))?.state).toEqual(state);
    const raw = await stores.raw.snapshotStore.loadLatest(exec);
    expect(JSON.stringify(raw?.state)).not.toContain("private words");

    await keys.destroy(user);
    await expect(stores.sealed.snapshotStore.loadLatest(exec)).rejects.toThrow();
  });
});
```

- [ ] **Step 4: Run it to see it fail**

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm --filter @docmind/server exec vitest run app/storage.test.ts
```

Expected: FAIL, `Failed to resolve import "./storage"`.

- [ ] **Step 5: Implement**

`apps/server/app/storage.ts` (the connection option `-c search_path=loom` puts every table Loom creates in the `loom` schema, whatever the role's default):

```ts
import type { PrincipalCryptoOptions, StorageConfig } from "@loom/app";
import { EncryptingEventStore, EncryptingSnapshotStore, type KeyStore } from "@loom/plugin-crypto";
import { postgresStorage } from "@loom/plugin-postgres";
import { subjectOfExecution } from "./subject";

type CustomStorage = Extract<StorageConfig, { kind: "custom" }>;

export interface DurableStorageOptions {
  /** Connection string for the docmind_loom role (it owns the `loom` schema). */
  loomUrl: string;
  /** Where per-user data keys live. Event payloads and snapshots are sealed under these. */
  keys: KeyStore;
}

interface StorePair {
  eventStore: CustomStorage["eventStore"];
  snapshotStore: NonNullable<CustomStorage["snapshotStore"]>;
}

export interface DurableStorage {
  storage: CustomStorage;
  crypto: PrincipalCryptoOptions;
  /** The encrypting pair that `storage` hands to Loom. */
  sealed: StorePair;
  /** The unwrapped pair. */
  raw: StorePair;
}

/**
 * Loom's Postgres event log and snapshots, wrapped so that what they hold is encrypted per user.
 *
 * - `storage` and `crypto` go into `defineConfig` (`storage`, and `security.crypto` so Loom marks the
 *   principal's identity fields as sensitive too).
 * - `raw` is the unwrapped pair, which erasure needs (`shredSubject` must write its tombstone to the
 *   raw log; M5).
 *
 * Both wrappers use the same KeyStore and the same subject mapping, so one destroyed key erases a
 * user's events and snapshots together. The snapshot store seals the whole folded state.
 */
export function createDurableStorage({ loomUrl, keys }: DurableStorageOptions): DurableStorage {
  const pg = postgresStorage({
    url: { connectionString: loomUrl, options: "-c search_path=loom" },
  });
  const events = new EncryptingEventStore(pg.eventStore, keys, {
    sensitive: {},
    subjectOf: subjectOfExecution,
  });
  const snapshots = new EncryptingSnapshotStore(pg.snapshotStore, keys, {
    sealState: true,
    subjectOf: subjectOfExecution,
    events: pg.eventStore,
  });
  return {
    storage: {
      kind: "custom",
      eventStore: events,
      snapshotStore: snapshots,
      leaseStore: pg.leaseStore,
    },
    crypto: { events, snapshots },
    sealed: { eventStore: events, snapshotStore: snapshots },
    raw: { eventStore: pg.eventStore, snapshotStore: pg.snapshotStore },
  };
}
```

- [ ] **Step 6: Run the test, then the gate**

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm --filter @docmind/server exec vitest run app/storage.test.ts
```

Expected: `3 passed`.

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0.

- [ ] **Step 7: Commit, check the size, open the draft PR**

```bash
git add -A
git commit -m "feat(server): Postgres event store and snapshots sealed per user" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git diff main...HEAD --numstat -- . ':!pnpm-lock.yaml' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
git push -u origin feat/m1-durable-storage
gh pr create --draft --base main --head feat/m1-durable-storage --title "feat(server): Postgres event store and snapshots sealed per user" --body "$(cat <<'EOF'
## Summary
- createDurableStorage: @loom/plugin-postgres stores (schema loom, role docmind_loom) wrapped by EncryptingEventStore and EncryptingSnapshotStore (sealState) over PostgresKeyStore, both keyed by subjectOfExecution so one user = one key. Returns the config pieces (storage, security.crypto) and the raw stores M5's shredSubject needs.
- Tests on a real database: events and snapshots are ciphertext at rest under the user's key (not the execution's); shredSubject makes that user's events unreadable while another user's stay readable; a destroyed key makes the snapshot unreadable.
- Links @loom/plugin-postgres; @loom/plugin-crypto becomes a runtime dependency. Not wired into main yet (PR 8d).

## Not counted toward the 200-line / 10-file limit
pnpm-lock.yaml.

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test` (with DOCMIND_TEST_PG_URL)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: about `184 lines, 4 files`, then the PR URL.

---

# PR 8d: the server runs on the durable, encrypted app

**Branch:** `feat/m1-durable-app`  **Budget:** 6 files, 118 lines. Spec §9 item 8, part 4 of 4. **Behaviour change:** `pnpm start` needs `LOOM_DATABASE_URL` and `DOCMIND_KEK`.

### Task 41: compose it in `loom.config.ts`'s `buildApp`, and start it from `main.ts`

**Files:**
- Create: `/Users/such/workspace/docmind/apps/server/app/config.test.ts`
- Modify: `/Users/such/workspace/docmind/apps/server/app/config.ts`, `apps/server/loom.config.ts`, `apps/server/app/security.ts`, `apps/server/app/main.ts`, `.env.example`

**Interfaces:**
- Consumes: `createDurableStorage` (PR 8c); `PostgresKeyStore` (PR 7b), `loadKeks` (PR 7d); `createAppPool` (PR 6n); `PgAuthStore`, `authRoutes`, `shutdown`.
- Produces: `buildApp(storage: StorageConfig, crypto?: PrincipalCryptoOptions)` in `app/config.ts` (replaces the old `app` export). With `crypto` the app is durable and encrypted and has no `principalCodec`; without it (the CLI default) it is in-memory with the M0 `principalCodec`. `loom.config.ts` default-exports `buildApp({ kind: "memory" })`. `main.ts` requires `DATABASE_URL`, `LOOM_DATABASE_URL` (the `docmind_loom` URL, checked unprivileged like the app URL), `DOCMIND_KEK`/`DOCMIND_KEK_FILE`, optional `DOCMIND_KEK_ID` and, while rotating, `DOCMIND_KEK_PREVIOUS[_ID]` (all through `loadKeks()`), and the existing `DOCMIND_COOKIE_SECURE`, `DOCMIND_TRUST_PROXY`, `PORT`, `HOST`.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m1-durable-app
```

- [ ] **Step 2: Write the failing test**

Two checks: `buildApp` composes under `security.strict` on in-memory storage, and on the durable pair, where Loom itself verifies the event store and snapshot store seal consistently (it refuses a plaintext checkpoint beside a sealing event store). `apps/server/app/config.test.ts`:

```ts
import { randomBytes } from "node:crypto";
import { PostgresKeyStore } from "@docmind/keystore-pg";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./config";
import { migrate, setAppRolePassword, setRolePassword } from "./db/migrate";
import { APP_PASSWORD, LOOM_PASSWORD, PG_URL, type TestDb, createTestDb } from "./db/testSupport";
import { createDurableStorage } from "./storage";

describe("buildApp", () => {
  it("composes under strict mode on in-memory storage", async () => {
    const app = buildApp({ kind: "memory" });
    await app.close();
  });
});

describe.skipIf(!PG_URL)("buildApp on durable storage (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let pool: Pool;

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await setRolePassword(db.owner, "docmind_loom", LOOM_PASSWORD);
    pool = new Pool({ connectionString: db.appUrl });
  });

  afterAll(async () => {
    await pool?.end();
    await db?.drop();
  });

  it("composes under strict mode, with encrypting stores that Loom accepts as sealing", async () => {
    const keys = new PostgresKeyStore(pool, [{ id: "kek-1", key: randomBytes(32) }]);
    const { storage, crypto } = createDurableStorage({ loomUrl: db.loomUrl, keys });
    const app = buildApp(storage, crypto);
    expect(app.stores.eventStore).toBe(storage.eventStore);
    expect(app.security?.crypto).toEqual({ allowPlaintextCheckpoints: false });
    await app.close();
  });
});
```

- [ ] **Step 3: Run it to see it fail**

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm --filter @docmind/server exec vitest run app/config.test.ts
```

Expected: FAIL, `"./config" has no exported member "buildApp"` / `buildApp is not a function`.

- [ ] **Step 4: Implement**

`apps/server/app/config.ts`:

```ts
import { type PrincipalCryptoOptions, type StorageConfig, defineConfig } from "@loom/app";
import {
  agentModules,
  flowModules,
  projectionModules,
  skillModules,
  toolModules,
} from "./loom.gen";
import { authorizer, executionAuthorizer, principalCodec, resumeAuthenticator } from "./security";

/**
 * The composition root: the only place that picks an implementation for each interface.
 *
 * With `crypto` (the encrypting stores from `createDurableStorage`), Loom seals the principal's
 * identity in the log under the user's key. Without it (in-memory storage for the CLI and tests)
 * the identity is recorded as an opaque reference instead, which strict mode requires.
 */
export function buildApp(storage: StorageConfig, crypto?: PrincipalCryptoOptions) {
  return defineConfig({
    storage,
    flowModules,
    agentModules,
    toolModules,
    skillModules,
    projectionModules,
    security: {
      strict: true,
      authorizer,
      executionAuthorizer,
      resumeAuthenticator,
      ...(crypto ? { crypto } : { principalCodec }),
    },
  });
}
```

`apps/server/loom.config.ts` (the file the `loom` CLI loads stays database-free):

```ts
import { buildApp } from "./app/config";

// What the loom CLI (`loom gen`, `loom debug`) loads: in-memory storage, no database needed.
// The server builds the durable, encrypted app itself (app/main.ts).
export default buildApp({ kind: "memory" });
```

`apps/server/app/security.ts` (only the comment above `principalCodec` changes; it is now for the in-memory app):

```diff
@@ -19,6 +19,7 @@ export const executionAuthorizer: ExecutionAuthorizer = executionAccessPolicy({
 });
 
-// The log stores an opaque ref, never a tenant or actor verbatim. In-memory until the durable
-// event store lands (M1 PR 8); then it is backed by the users table.
+// For the in-memory app only (the CLI and tests): the log stores an opaque ref, never a tenant or
+// actor verbatim. The durable app does not use this; it seals the identity under the user's key
+// instead (`security.crypto`, see config.ts).
 const principals = new Map<string, PrincipalChain>();
 export const principalCodec: PrincipalCodec = {
```

`apps/server/app/main.ts`:

```ts
import { AuthService, PasswordAuthenticator } from "@docmind/auth";
import { PostgresKeyStore, loadKeks } from "@docmind/keystore-pg";
import { PgAuthStore } from "./auth/pgAuthStore";
import { PgThrottle } from "./auth/pgThrottle";
import { authRoutes } from "./auth/routes";
import { buildApp } from "./config";
import { createAppPool } from "./db/pool";
import { createHttpServer } from "./server";
import { shutdown } from "./shutdown";
import { createDurableStorage } from "./storage";

const HOUR_MS = 60 * 60 * 1000;

function required(name: string, what: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (${what})`);
  return value;
}

async function main(): Promise<void> {
  const pool = await createAppPool(required("DATABASE_URL", "the docmind_app connection string"));

  // Loom's stores connect as docmind_loom; check that role is unprivileged too before they start.
  const loomUrl = required("LOOM_DATABASE_URL", "the docmind_loom connection string");
  await (await createAppPool(loomUrl)).end();

  const keys = new PostgresKeyStore(pool, loadKeks());
  const durable = createDurableStorage({ loomUrl, keys });
  const app = buildApp(durable.storage, durable.crypto);

  const store = new PgAuthStore(pool);
  const throttle = new PgThrottle(pool);
  const authenticator = new PasswordAuthenticator(store);
  const server = createHttpServer(
    authRoutes({
      service: new AuthService(store),
      authenticator,
      store,
      throttle,
      secureCookies: process.env.DOCMIND_COOKIE_SECURE === "true",
      trustProxy: process.env.DOCMIND_TRUST_PROXY === "true",
    }),
  );

  const sweep = () =>
    Promise.all([store.purgeExpiredSessions(), throttle.purge()]).catch((err) =>
      console.error(err),
    );
  void sweep();
  setInterval(sweep, HOUR_MS).unref();

  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "127.0.0.1";
  server.listen(port, host, () =>
    console.log(`docmind server listening on http://${host}:${port}`),
  );

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      // The server drains first; the app (and the stores under it) closes before the pool its
      // key store reads from.
      const closeAll = {
        close: async () => {
          await app.close();
          await pool.end();
        },
      };
      shutdown(server, closeAll).catch((err) => {
        console.error(err);
        process.exitCode = 1;
      });
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

`.env.example`:

```diff
@@ -12,4 +12,23 @@ DOCMIND_APP_DB_PASSWORD=change-me-locally
 DATABASE_URL=postgres://docmind_app:change-me-locally@127.0.0.1:5432/docmind
 
+# Loom's event log and snapshots live in their own schema, owned by their own role (docmind_loom).
+DOCMIND_LOOM_DB_PASSWORD=change-me-too
+LOOM_DATABASE_URL=postgres://docmind_loom:change-me-too@127.0.0.1:5432/docmind
+
+# Master key that wraps every user's data key. Generate: openssl rand -base64 32
+# Losing it makes all encrypted data unreadable; leaking it exposes the wrapped data keys.
+DOCMIND_KEK=
+DOCMIND_KEK_ID=kek-1
+# Only while rotating the KEK (docs/operations/rotate-kek.md): the key being retired.
+# DOCMIND_KEK_PREVIOUS=
+# DOCMIND_KEK_PREVIOUS_ID=
+
+# Set to true when the server is reached over HTTPS (marks the session cookie Secure).
+DOCMIND_COOKIE_SECURE=false
+
+# Believe X-Forwarded-For for the client address (login/sign-up throttling). Set to true only when the
+# server sits behind exactly one reverse proxy of yours; otherwise any client could fake its address.
+DOCMIND_TRUST_PROXY=false
+
 # Enables the Postgres integration tests (they skip when unset). The role must be able to
 # CREATE DATABASE: each suite makes, and drops, a database of its own.
```

- [ ] **Step 5: Run the test, then the gate**

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm --filter @docmind/server exec vitest run app/config.test.ts
pnpm --filter @docmind/server gen
```

Expected: `config.test.ts` 2 passed; `gen` prints `wrote app/loom.gen.ts (0 flows, ...)` and `git status` shows no change to `app/loom.gen.ts` (the CLI still loads `loom.config.ts` without a database).

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0.

- [ ] **Step 6: Smoke-test the durable server**

```bash
export DOCMIND_MIGRATE_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
export DOCMIND_APP_DB_PASSWORD=change-me-locally DOCMIND_LOOM_DB_PASSWORD=change-me-too
pnpm --filter @docmind/server db:migrate
DATABASE_URL=postgres://docmind_app:change-me-locally@127.0.0.1:5432/docmind \
LOOM_DATABASE_URL=postgres://docmind_loom:change-me-too@127.0.0.1:5432/docmind \
DOCMIND_KEK=$(openssl rand -base64 32) PORT=3918 pnpm --filter @docmind/server start &
sleep 5
curl -s -X POST localhost:3918/api/auth/sign-up -H 'content-type: application/json' \
  -d '{"email":"s@example.com","password":"correct horse battery"}'
psql postgres://docmind:docmind@127.0.0.1:5432/docmind -Atc "select count(*) from pg_tables where schemaname = 'loom'"
kill %1
```

Expected: the server logs `docmind server listening on http://127.0.0.1:3918` and nothing else; the `curl` answers `{"status":"accepted"}`; the `psql` count is `11` (Loom's tables, created in schema `loom` by `docmind_loom`). Unsetting `DOCMIND_KEK` must make startup fail with `set DOCMIND_KEK (base64, 32 bytes) or DOCMIND_KEK_FILE`.

- [ ] **Step 7: Commit, check the size, open the draft PR**

```bash
git add -A
git commit -m "feat(server): run on durable Postgres storage sealed per user" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git diff main...HEAD --numstat -- . ':!pnpm-lock.yaml' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
git push -u origin feat/m1-durable-app
gh pr create --draft --base main --head feat/m1-durable-app --title "feat(server): run on durable Postgres storage sealed per user" --body "$(cat <<'EOF'
## Summary
- app/config.ts exports buildApp(storage, crypto?): with the encrypting stores it composes under security.strict with security.crypto (Loom seals the principal's identity under the user's key; no principalCodec); without them it is the in-memory app the loom CLI loads (loom.config.ts), so `loom gen` needs no database.
- main.ts builds PostgresKeyStore (KEK from the environment) -> createDurableStorage -> buildApp, checks docmind_loom is unprivileged too, and closes server, app, pool in order. New required env: LOOM_DATABASE_URL, DOCMIND_KEK (see .env.example).
- Smoke-tested by hand: migrations, sign-up, and Loom's 11 tables created in schema loom by docmind_loom.

## Not counted toward the 200-line / 10-file limit
None.

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test` (with DOCMIND_TEST_PG_URL)
- [x] manual smoke test (plan, Task 41 step 6)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: about `118 lines, 6 files`, then the PR URL.

---

## After PR 8d: M1 exit check

- [ ] On a fresh clone of `main` (with `../loom` built and Postgres up): `export DOCMIND_TEST_PG_URL=...; pnpm install --frozen-lockfile && pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`. Expected: all green: 176 tests (contracts 16, auth 42, keystore-pg 8, server 110); the Postgres suites run, not skip.
- [ ] The two smoke tests (Task 30 step 6, Task 41 step 6) pass on `main`: sign-up (202), login, `/api/me`, logout, a 429 after repeated wrong passwords; Loom's tables in schema `loom`; a start with the owner's URL as `DATABASE_URL` or `LOOM_DATABASE_URL` is refused.
- [ ] Rehearse a rotation once on a scratch database (runbook `docs/operations/rotate-kek.md`), including `--verify-only`.
- [ ] D1 is decided (Vite alias to source): the M2 plan header says so and `apps/web` is scaffolded that way (M6 PR 36).
- [ ] If billing is restored: the first push to `main` triggers `ci`; confirm it is green, which also proves `LOOM_TOKEN`, building the three Loom packages M1 added, and the superuser `postgres` role.

## Self-review

**Spec coverage (§9 M1, plus §3.1, §4.2-4.4) and the owner's four decisions:**

| Spec item or decision | Where |
|---|---|
| Item 5: `Authenticator` interface, conformance suite, request middleware | PR 5a (interface, suite), 5d (`requireAuth`), 6d (`PasswordAuthenticator` passes the suite), 6f (and on Postgres) |
| Item 6: password auth (argon2id, session cookie), sign-up, login, logout | 6b (argon2id, tokens), 6c (cookie), 6e (service), 6k (sign-up), 6l (login), 6m (logout, `/api/me`), 6n (wired) |
| Item 7: `PostgresKeyStore` passing the Loom KeyStore contract | 7b (`runKeyStoreConformance`, 8 tests), 7c (security tests), 7a (KEK + wrapping) |
| Item 8: Postgres event store wrapped by `EncryptingEventStore` and `EncryptingSnapshotStore` in `loom.config.ts` | 8c (stores), 8d (`buildApp` in `config.ts`, started by `main.ts`; `loom.config.ts` stays in-memory for the CLI, deviation 7) |
| Decision 1: sign-up must not reveal registered emails | 6e (`signUp` returns a boolean, hashes first, no session), 6k (uniform 202, no cookie, byte-identical test), residual channel stated in 6k and deviation 9 |
| Decision 2: rate limiting and lockout on login and sign-up | 6h (policies, `clientIp`), 6i (`MemoryThrottle` and the conformance suite), 6j (Postgres storage, migration 0006), 6k and 6l (applied before the password is looked at; 429 + `Retry-After`; existence not leaked), 6n (`DOCMIND_TRUST_PROXY`, hourly purge). No route is mounted before PR 6n, and 6n mounts only throttled routes |
| Decision 3: KEK rotation tool | 7d (`loadKeks`), 7e (`rotateKek`, `verifyKeys`), 7f (crash and bad-row tests), 7g (`keys:rotate` and the runbook) |
| Decision 4: D1 decided (Vite alias to source) | "Decision D1" section; recorded for M2, no M1 task |
| §4.2 `users.password_hash` argon2id; `auth_sessions` stores only a token hash | 6b/6e |
| §4.2 `data_keys (subject_id, wrapped_dek, kek_id, created_at)` | 7b, with the tombstone deviation (4) |
| §4.3 identity from the Authenticator, never the client; RLS; `SECURITY DEFINER` pre-tenant lookups | 5d, 6a, 6f, 6j; routes take identity only from the session (6m) |
| §4.4 per-user DEK, KEK from env/file, `destroy` irreversible, events + snapshots + `*_enc` under the user's key | 7a/7b, 8b/8c. Blobs and `*_enc` columns are M2+ (they will call the same `KeyStore`) |
| §4.4 erasure flow | M5; the pieces M5 needs (`raw` stores, `wasDestroyed`, subject mapping, `shredSubject` proven in PR 8c's test) exist |
| §8 gates, PR rules | Global Constraints; every PR's close-out |
| M0 review carry-forwards: router rejection + test; `server.close()` then `app.close()`; contracts dependency; definer `SET search_path` + `GRANT EXECUTE`; startup role assertion; same-named types; session indexes; contracts ESM decision | 5c; 5d; 5c; 6a/6j/7b (every definer function pins `search_path` and grants `docmind_app` explicitly); 6n (+8d for the Loom role); 5b; 6a (migration 0004); D1 |

**Spec content with no M1 task (intentional):** blob and `*_enc` encryption (M2), `DELETE /api/me` (M5), email verification (needs email infrastructure; deviation 9), sign-up UI (M6).

**Placeholder scan:** no unfinished markers or "similar to" steps; every code step carries file contents copied from the branches that were built and run (the plan is generated from those branches, so a drift would show as a failing replay).

**Type consistency:** `Identity` (5a) is what `requireAuth` (5d), `AuthStore` (6c), `PasswordAuthenticator` (6d), `AuthService` (6e), `PgAuthStore` (6f) and `authRoutes` (6k-6m) use; `AuthService.signUp` is `Promise<boolean>` from 6e on and the sign-up route (6k) ignores the boolean on purpose; `Throttle` and `ThrottlePolicy` (6h) are implemented by `MemoryThrottle` (6i) and `PgThrottle` (6j) and passed to `authRoutes` as `throttle`; `AuthRoutesDeps` grows `service, throttle, trustProxy` (6k), `secureCookies` (6l), `authenticator, store` (6m), and `main.ts` (6n) passes all of them; `AuthStore.findEmail` is defined in 6c and used in 6f/6m; `Handler`/`sendError` (5c) are used by 5d, 6g, 6k-6m; `setRolePassword` (8a) is used in 8c/8d tests, `setAppRolePassword` keeps its M0 signature; `Kek`/`loadKeks` (7a/7d) feed `PostgresKeyStore(pool, keks)` (7b), `rotateKek(pool, keks)` (7e) and `runRotation` (7g); `createDurableStorage(...).{storage,crypto,sealed,raw}` (8c) is what 8d and the tests read; `buildApp(storage, crypto?)` (8d) is what `loom.config.ts` and `main.ts` call; `executionIdFor`/`subjectOfExecution` (8b) are what 8c uses.
