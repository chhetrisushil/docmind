# DocMind M0 (Foundations) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the DocMind repo so that `main` has a green, CI-gated pnpm/Turborepo workspace with a Loom-scaffolded server answering `/healthz`, the zod HTTP contracts for auth, documents and chats, and a migration runner plus row-level-security tenancy tables proven isolated by a test that runs as a non-owner Postgres role.

**Architecture:** A pnpm workspace (`apps/server`, `packages/contracts`, `infra/`) that consumes the unpublished `@loom/*` packages from a sibling `../loom` checkout through `link:` overrides. The server is a `create-loom-app` project (composition root in `loom.config.ts`) with a small `node:http` edge on top. Tenancy is enforced by Postgres RLS: the server connects as `docmind_app` (owns nothing, cannot bypass RLS) and every request runs inside `withTenant`, which sets a transaction-local tenant id.

**Tech Stack:** pnpm 9.14.4, Turborepo ^2.3.3, Biome 1.9.4, TypeScript ^5.6.3 (CommonJS, like Loom), Vitest ^2.1.8, zod ^3.23.8 (Loom's version), `pg` ^8.13.0 (the driver `@loom/plugin-postgres` uses), Node >=20 (local is v24), Postgres 16 + pgvector for CI and docker-compose.

**Spec:** `/Users/such/workspace/docmind/docs/specs/2026-10-18-docmind-design.md` (§3 layout, §4.2-4.3 tables and RLS, §8 gates/CI/PR rules, §9 M0). Executors read both documents.

## Global Constraints

Copied from the spec; every task includes them.

- **PR size:** at most **200 changed lines and 10 files** per PR. `pnpm-lock.yaml`, the generated `apps/server/app/loom.gen.ts` and binary fixtures do not count but are listed in the PR description. A PR that cannot fit is split, never stretched.
- **PR rules:** each PR leaves `main` green with no half-built reachable path; tests ship in the same PR as the code; branch names `feat/<area>-<thing>`; Conventional Commits; every PR is opened as a **draft** (`gh pr create --draft`), gets an independent code review, and merges only with the owner's approval.
- **Commit trailer:** every commit ends with the line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Every PR description ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- **PR gate:** `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`, plus the Postgres integration tests when `DOCMIND_TEST_PG_URL` is set.
- **CI:** triggers `pull_request: [opened, synchronize, reopened, ready_for_review]` and pushes to `main`; every PR job is gated on `github.event.pull_request.draft == false` so drafts use no Actions minutes.
- **Test hygiene (Loom's AGENTS.md):** no sleeps (wait on conditions); test servers bind `127.0.0.1`; no timing assertions in `*.test.ts`; test files are typechecked (`typecheck:tests`).
- **Tenancy:** the app connects as a **non-owner role**; RLS checks `tenant_id` against a transaction-local setting; nothing downstream accepts a tenant id from the client.
- **Dependency rules:** packages never import from apps; only `loom.config.ts` chooses implementations.
- **Toolchain pins:** `pnpm@9.14.4`, `@biomejs/biome` `1.9.4` (exact), `typescript` `^5.6.3`, `vitest` `^2.1.8`, Node `>=20.0.0`.

---

## Verified facts this plan relies on

Everything below was checked on this machine on 2026-10-18; the code in this plan was built and run branch by branch (nine stacked branches; the full gate was green on each except PR 2, which is YAML-validated and linted only; the final branch also passes the gate under `pnpm@9.14.4`).

| Fact | Evidence |
|---|---|
| Loom remote is `git@github.com:chhetrisushil/loom.git`, **private** | `git -C /Users/such/workspace/loom remote -v`; `gh repo view chhetrisushil/loom --json visibility` returns `PRIVATE` |
| Loom `main` HEAD, pushed to `origin/main`, is `8f9eab2492c85bb994d746855f06d2eccc9f45db` | `git rev-parse HEAD origin/main`; used as the initial `LOOM_REF` |
| CI therefore needs a **`LOOM_TOKEN` repository secret**: a token with read access to `chhetrisushil/loom` (fine-grained PAT, "Contents: read", that one repo) | the same convention loom-ui's CI uses (`/Users/such/workspace/loom-ui/.github/workflows/ci.yml`) |
| Loom checkout pattern: `actions/checkout` docmind into `path: docmind`, loom into `path: loom`, build loom (`pnpm install --frozen-lockfile && pnpm build`), then docmind | loom-ui `ci.yml`; `../loom` resolves from `docmind/` because both live in `$GITHUB_WORKSPACE` |
| `@loom/*` is consumed with `"*"` dependencies plus `pnpm.overrides` of the form `"@loom/app": "link:../loom/packages/app"` in the **root** `package.json` | loom-examples and loom-ui `package.json`; the scaffolder emits the same shape |
| Loom's vitest pattern: `resolve.conditions` including `require` (Loom's `exports` map declares only `require` and `types`), and `@loom/*` externalized | `loom-examples`, scaffolder `vitest.config.ts`, aetherOS `apps/war-room/vitest.config.ts` |
| `@loom/plugin-postgres` uses **`pg`** (`"pg": "^8.13.0"`, `"@types/pg": "^8.11.0"`), not postgres.js | `/Users/such/workspace/loom/plugins/postgres/package.json`; aetherOS war-room uses the same |
| `defineConfig` (`@loom/app`) exposes **no HTTP server**; `@loom/plugin-conversation-sse` creates **its own** `http.Server` on its own port (`createConversationSseServer(...).http`, `server.ts:667`) and exports no mountable handler | `grep` of `packages/app/src/defineConfig.ts` and `plugins/conversation-sse/src/server.ts` |
| So `/healthz` is served by a ~20-line `node:http` router, no framework | aetherOS war-room (`apps/war-room/src/server/http.ts`) also uses bare `node:http` `createServer` |
| Loom test style: Postgres suites are gated on an env var and skip cleanly (`LOOM_TEST_POSTGRES_URL`); DocMind uses `DOCMIND_TEST_PG_URL` the same way | `plugins/postgres/src/conformance.test.ts` |
| **Turborepo strict env mode hides env vars from tasks.** Without `"env": ["DOCMIND_TEST_PG_URL"]` on the `test` task, `pnpm test` silently skipped every Postgres suite even with the variable exported | observed while building PR 4a; fixed in `turbo.json` |
| Local `pnpm` here is 10.10.0; the lockfile (`lockfileVersion: '9.0'`) installs `--frozen-lockfile` and the whole gate passes under `pnpm@9.14.4` | run with `npx pnpm@9.14.4 ...` |
| `docker` is **not installed** on this machine; compose and the pgvector image were not run here | `which docker`. The Postgres tests were verified against a local Postgres 17 cluster with a superuser URL |

### What the scaffolder generated, and what PR 1b does with it

Run: `node /Users/such/workspace/loom/tools/create-loom-app/dist/index.js <scratch>/probe --loom-path /Users/such/workspace/loom` produced 12 files (326 lines).

| Generated file | Decision |
|---|---|
| `loom.config.ts` | **Kept verbatim** (one line: `export { app as default } from "./app/config"`) |
| `app/config.ts` | **Trimmed**: kept `defineConfig` with `storage: { kind: "memory" }` (until PR 8), `strict: true` security and the module arrays; dropped the long comments and `execution.effectMiddleware` |
| `app/security.ts` (70 lines) | **Trimmed to 37**: `GrantTable({})` (no flows yet), the same `executionAccessPolicy`, an in-memory `principalCodec`, a `resumeAuthenticator` whose `keys` always returns `undefined` (fails closed; the scaffold's `LOOM_APPROVER_KEY_*` env lookup is dropped until an approval gate exists) |
| `app/loom.gen.ts` | **Regenerated** with `loom gen` (0 modules), committed, excluded from the line count and from Biome |
| `app/main.ts` | **Replaced**: starts the HTTP server instead of running the greet flow once |
| `app/middleware.ts` | **Dropped** (`retryMiddleware`); come back with the first effect |
| `app/flows/greet/flow.ts`, `app/greet.test.ts` | **Dropped** (demo flow) |
| `package.json` | **Rewritten**: `"*"` for `@loom/app`, `@loom/effect-runtime`, `@loom/workflow-runtime`, `@loom/cli`; removed unused `@loom/agent-surface`, `@loom/core`, `@loom/middleware`, `@loom/testing`, `zod`; added `build`/`typecheck`/`typecheck:tests`/`gen` scripts and `@types/node`. The **75-entry `pnpm.overrides` block moves to the repo root and shrinks to the 4 packages actually imported** |
| `tsconfig.json` | **Replaced** by one that extends `tsconfig.base.json`, plus a new `tsconfig.test.json` (the scaffold's config typechecks tests inside the build config, which `typecheck:tests` must keep separate) |
| `vitest.config.ts` | **Kept and extended**: same `require` condition, plus `node` and `@loom/` externalization (the war-room pattern) |
| `README.md` | **Dropped** (the real README is M7 PR 47) |

Scaffolder surprises worth knowing: it targets a standalone app (relative `link:` paths computed from the app directory, a `loom.gen.ts` imported by `config.ts`, demo principal `{ actor: "demo-user", tenant: "demo" }`), so it needs adapting for a monorepo; `security.strict` refuses to start without the four security pieces, which is why `security.ts` stays.

## Deviations from the spec and open questions

Each is decided in this plan so executors are not blocked; the owner can overrule in review.

1. **9 PRs, not 4.** PR 1 splits into 1a/1b, PR 3 into 3a/3b/3c, PR 4 into 4a/4b/4c to stay under 200 lines and 10 files.
2. **`withTenant(pool, tenantId, fn)` instead of `withTenant(tx)`.** It opens the transaction itself, so a caller cannot forget it. The setting is applied with `set_config('app.tenant_id', $1, true)`, which is `SET LOCAL` with a bind parameter (real `SET LOCAL` cannot take parameters).
3. **Policies call `app_tenant_id()`** (`nullif(current_setting('app.tenant_id', true), '')::uuid`) rather than a bare `current_setting('app.tenant_id')`. A bare call errors when the setting was never set, and after a transaction ends the setting reads `''`, which fails the `::uuid` cast. With the wrapper, no tenant context means **zero rows**.
4. **`auth_sessions` gets a `tenant_id` column** (spec §4.2 lists `(token_hash, user_id, expires_at)` but also says every table carries `tenant_id`; RLS needs it).
5. **RLS is `ENABLE`d, not `FORCE`d.** Login (look up a user by email) and session lookup (by token hash) happen *before* a tenant is known, so M1 PRs 5/6 will need two narrow `SECURITY DEFINER` functions owned by the migration role; `FORCE` would make those functions subject to RLS too. Isolation rests on `docmind_app` owning nothing and having no `BYPASSRLS`, which PR 4c's tests assert, including that it cannot `DISABLE ROW LEVEL SECURITY` or drop a policy. **Open question for the owner:** accept that design for M1, or prefer a `FORCE` plus a separate `docmind_auth` role?
6. **`email` is lower-cased by the contract**, so `users.email UNIQUE` stays case-insensitive without a functional index.
7. **`docmind_app` is created `NOLOGIN` by migration 0001**; `pnpm --filter @docmind/server db:migrate` gives it a login when `DOCMIND_APP_DB_PASSWORD` is set. Migrations never contain a password.
8. **Sign-up password minimum is 12 characters** (login has no minimum so older passwords keep working). Spec is silent; change in `auth.ts` if you disagree.
9. **`locator` in contracts is `{ kind, ...rest }` (passthrough).** The per-format fields (character range, heading path, page, paragraph range, image region) are defined by the parsers in M3.
10. **Open question for M4:** conversation-sse owns its own `http.Server`/port, so `GET /api/chats/:id/stream` cannot be a route in the `node:http` router. Options: run it on a sibling port behind the Vite dev proxy and a reverse proxy in production, or forward requests to `handle.http`'s listeners. Not needed before PR 28.
11. **CI cannot be exercised while PRs are drafts** (by design). PR 2's workflow is first proven when PR 2 is marked ready for review, or on the first push to `main`. Needs the `LOOM_TOKEN` secret first (see PR 2).
12. **Docker was not available here**, so `docker-compose.yml` is YAML-validated only; the executor must run `docker compose config -q` and `docker compose up -d postgres`.

## Preconditions (once, before PR 1a)

- [ ] **Step 1: Confirm the sibling Loom checkout is built**

```bash
git -C /Users/such/workspace/loom rev-parse HEAD
ls /Users/such/workspace/loom/packages/app/dist/index.js /Users/such/workspace/loom/tools/cli/dist/index.js
```

Expected: a commit that is `8f9eab2492c85bb994d746855f06d2eccc9f45db` or a descendant of it, and both `dist` files listed. If `dist` is missing, run `pnpm install && pnpm build` in `/Users/such/workspace/loom` (the only time this plan builds Loom).

- [ ] **Step 2: Confirm the toolchain**

```bash
node -v && corepack enable && corepack prepare pnpm@9.14.4 --activate && pnpm -v
```

Expected: Node `v20` or newer, then `9.14.4`. (pnpm 10 also works locally, but CI uses 9.14.4.)

- [ ] **Step 3: Have a Postgres for PRs 4a-4c**

Either, once PR 2 is merged, `docker compose up -d postgres` (URL `postgres://docmind:docmind@127.0.0.1:5432/docmind`), or any local Postgres 13+ superuser URL (`DROP DATABASE ... WITH (FORCE)` needs 13+; the role must be allowed to `CREATE DATABASE`). Export it before the 4a-4c gates:

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
```

## PR index

Merge strictly in this order; cut each branch from `main` after the previous PR has merged (`git switch main && git pull --ff-only`).

| # | Branch | Delivers | Files | Lines (measured) |
|---|---|---|---|---|
| 1a | `feat/m0-scaffold` | pnpm workspace, Turborepo, Biome, tsconfig base, Loom link overrides | 6 | 81 |
| 1b | `feat/m0-scaffold-server` | `apps/server`: Loom app + `/healthz` and its test | 10 | 167 |
| 2 | `feat/m0-ci-infra` | CI workflow (skips drafts), docker-compose, `.env.example` | 3 | 139 |
| 3a | `feat/m0-contracts` | `packages/contracts` scaffold, common + auth schemas | 7 | 105 |
| 3b | `feat/m0-contracts-documents` | documents schemas | 3 | 116 |
| 3c | `feat/m0-contracts-chats` | chats schemas | 3 | 130 |
| 4a | `feat/m0-db-migrations` | migration runner, `docmind_app` role, test DB helper | 7 | 176 |
| 4b | `feat/m0-db-app-login` | `db:migrate` CLI, app-role login | 4 | 65 |
| 4c | `feat/m0-db-tenancy` | `tenants`/`users`/`auth_sessions`, RLS, `withTenant`, isolation test | 3 | 182 |

Plus `pnpm-lock.yaml` on every PR that changes dependencies, and `apps/server/app/loom.gen.ts` on 1b (both excluded from the budget).

---

# PR 1a: workspace root

**Branch:** `feat/m0-scaffold`  **Budget:** 6 files, 81 lines (+ `pnpm-lock.yaml`).
This PR has no behavior to test-drive; its verification is that the tools install and run on an empty workspace.

### Task 1: Workspace, Turborepo, Biome, tsconfig base

**Files:**
- Create: `/Users/such/workspace/docmind/.gitignore`
- Create: `/Users/such/workspace/docmind/package.json`
- Create: `/Users/such/workspace/docmind/pnpm-workspace.yaml`
- Create: `/Users/such/workspace/docmind/turbo.json`
- Create: `/Users/such/workspace/docmind/biome.json`
- Create: `/Users/such/workspace/docmind/tsconfig.base.json`

**Interfaces:**
- Consumes: nothing.
- Produces: root scripts `build`, `test`, `typecheck`, `typecheck:tests`, `lint`, `lint:fix` (all later PRs and CI call these); Turbo tasks of the same names, where `build`/`typecheck`/`typecheck:tests`/`test` depend on `^build`; `tsconfig.base.json` that every package extends; the `link:` overrides for `@loom/app`, `@loom/cli`, `@loom/effect-runtime`, `@loom/workflow-runtime` (add an override here whenever a later PR imports another `@loom/*` package).

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m0-scaffold
```

Expected: `Switched to a new branch 'feat/m0-scaffold'`.

- [ ] **Step 2: Create `.gitignore`**

```
node_modules
dist
*.tsbuildinfo
.turbo
.env
```

- [ ] **Step 3: Create `package.json`**

```json
{
  "name": "docmind",
  "version": "0.0.0",
  "private": true,
  "description": "DocMind: a multi-user, RAG-based document assistant built on Loom.",
  "license": "UNLICENSED",
  "packageManager": "pnpm@9.14.4",
  "engines": {
    "node": ">=20.0.0"
  },
  "scripts": {
    "build": "turbo run build",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck",
    "typecheck:tests": "turbo run typecheck:tests",
    "lint": "biome check .",
    "lint:fix": "biome check --write ."
  },
  "devDependencies": {
    "@biomejs/biome": "1.9.4",
    "turbo": "^2.3.3",
    "typescript": "^5.6.3"
  },
  "pnpm": {
    "overrides": {
      "@loom/app": "link:../loom/packages/app",
      "@loom/cli": "link:../loom/tools/cli",
      "@loom/effect-runtime": "link:../loom/packages/effect-runtime",
      "@loom/workflow-runtime": "link:../loom/packages/workflow-runtime"
    }
  }
}
```

- [ ] **Step 4: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - apps/*
  - packages/*
```

- [ ] **Step 5: Create `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "typecheck": {
      "dependsOn": ["^build"]
    },
    "typecheck:tests": {
      "dependsOn": ["^build"]
    },
    "test": {
      "dependsOn": ["^build"]
    }
  }
}
```

- [ ] **Step 6: Create `biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": { "ignore": ["**/dist/**", "**/loom.gen.ts"] },
  "organizeImports": { "enabled": true },
  "linter": { "enabled": true, "rules": { "recommended": true } },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 }
}
```

- [ ] **Step 7: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "Node",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 8: Install**

Run: `pnpm install`
Expected: ends with `Done in ...s`, adds `@biomejs/biome 1.9.4`, `turbo 2.x`, `typescript 5.x`, and creates `pnpm-lock.yaml` (`lockfileVersion: '9.0'`).

- [ ] **Step 9: Verify lint and the (empty) build graph**

Run: `pnpm lint`
Expected: `Checked 4 files in ...ms. No fixes applied.`

Run: `pnpm build`
Expected: turbo prints `WARNING  No tasks were executed as part of this run.` and `Tasks:    0 successful, 0 total`, exit code 0.

- [ ] **Step 10: Commit**

```bash
git add .
git commit -m "$(cat <<'EOF'
feat(repo): add pnpm workspace, turborepo, biome and tsconfig base

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Close out 1/3: check the size budget**

```bash
git diff --numstat main...HEAD -- . ':!pnpm-lock.yaml' ':!apps/server/app/loom.gen.ts' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
```

Expected: `81 lines, 6 files` (limit: 200 lines and 10 files). If it prints more, stop and split the PR instead of stretching it.

- [ ] **Close out 2/3: run the full PR gate**

```bash
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0 and the last turbo summary reads `Tasks:    N successful, N total`.
- [ ] **Close out 3/3: push and open the draft PR**

```bash
git push -u origin feat/m0-scaffold
gh pr create --draft --base main --head feat/m0-scaffold --title "feat(repo): pnpm workspace, Turborepo, Biome, tsconfig base" --body "$(cat <<'EOF'
## Summary
- Root workspace for DocMind (spec §3, §9 PR 1, part 1 of 2).
- pnpm 9.14.4 workspace over apps/* and packages/*
- Turborepo tasks build/typecheck/typecheck:tests/test
- Biome 1.9.4
- shared tsconfig base.
- Loom is consumed via pnpm.overrides link:../loom/... for the four packages apps/server imports (next PR).

## Not counted toward the 200-line / 10-file limit
pnpm-lock.yaml (generated).

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: `gh` prints the PR URL. The PR stays a draft: CI does not run until it is marked ready, and only the owner merges.

---

# PR 1b: `apps/server` with `/healthz`

**Branch:** `feat/m0-scaffold-server`  **Depends on:** PR 1a merged.  **Budget:** 10 files, 167 lines (+ `pnpm-lock.yaml`, `apps/server/app/loom.gen.ts`).

### Task 2: Server package skeleton

**Files:**
- Create: `apps/server/package.json`
- Create: `apps/server/tsconfig.json`
- Create: `apps/server/tsconfig.test.json`
- Create: `apps/server/vitest.config.ts`

**Interfaces:**
- Consumes: root scripts and `tsconfig.base.json` (PR 1a).
- Produces: package `@docmind/server` with scripts `build`, `start`, `gen`, `test`, `typecheck`, `typecheck:tests`; `tsconfig.test.json` that includes the test files the build config excludes.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m0-scaffold-server
```

- [ ] **Step 2: Create `apps/server/package.json`**

```json
{
  "name": "@docmind/server",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "tsx app/main.ts",
    "gen": "loom gen --dir app",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "typecheck:tests": "tsc -p tsconfig.test.json"
  },
  "dependencies": {
    "@loom/app": "*",
    "@loom/effect-runtime": "*",
    "@loom/workflow-runtime": "*"
  },
  "devDependencies": {
    "@loom/cli": "*",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.2",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 3: Create `apps/server/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": ".", "types": ["node"] },
  "include": ["app/**/*", "loom.config.ts"],
  "exclude": ["**/*.test.ts", "dist"]
}
```

- [ ] **Step 4: Create `apps/server/tsconfig.test.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": true },
  "include": ["app/**/*", "loom.config.ts", "vitest.config.ts"],
  "exclude": ["dist"]
}
```

- [ ] **Step 5: Create `apps/server/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  // @loom/* publish require-only `exports`; resolve them the same way under Vite.
  resolve: { conditions: ["node", "require", "default"] },
  test: { environment: "node", server: { deps: { external: [/@loom\//, /[\\/]loom[\\/]/] } } },
});
```

- [ ] **Step 6: Install and check the Loom links**

Run: `pnpm install && ls -l apps/server/node_modules/@loom`
Expected: four symlinks, e.g. `app -> ../../../../../loom/packages/app`, `cli -> ../../../../../loom/tools/cli`, `effect-runtime -> ...`, `workflow-runtime -> ...`. If a link is missing, the matching override in the root `package.json` is wrong.

### Task 3: `/healthz` (test first)

**Files:**
- Create: `apps/server/app/server.test.ts`
- Create: `apps/server/app/server.ts`

**Interfaces:**
- Consumes: nothing from Loom (the HTTP edge is plain `node:http`; conversation-sse owns its own server, see "Verified facts").
- Produces: `createHttpServer(): http.Server` with a route table keyed `"METHOD /path"`; unknown routes answer `404 {"error":{"code":"not_found","message":"no such route"}}` (the same `ErrorBody` shape as `@docmind/contracts`). Later PRs add routes to the table.

- [ ] **Step 1: Write the failing test**

Create `apps/server/app/server.test.ts`:

```ts
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpServer } from "./server";

const server = createHttpServer();
let base = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("http server", () => {
  it("GET /healthz returns ok", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("answers an unknown route with a JSON 404", async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "no such route" } });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @docmind/server test`
Expected: FAIL, `Error: Failed to load url ./server ... Does the file exist?` and `Tests  no tests`.

- [ ] **Step 3: Write the implementation**

Create `apps/server/app/server.ts`:

```ts
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const routes: Record<string, Handler> = {
  "GET /healthz": (_req, res) => json(res, 200, { status: "ok" }),
};

/** The HTTP edge. Later PRs add routes to the table; unknown routes are a JSON 404. */
export function createHttpServer(): Server {
  return createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const handler = routes[`${req.method ?? "GET"} ${path}`];
    if (handler) handler(req, res);
    else json(res, 404, { error: { code: "not_found", message: "no such route" } });
  });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @docmind/server test`
Expected: `✓ app/server.test.ts (2 tests)` and `Tests  2 passed (2)`.

- [ ] **Step 5: Commit**

```bash
git add apps/server/package.json apps/server/tsconfig.json apps/server/tsconfig.test.json apps/server/vitest.config.ts apps/server/app/server.ts apps/server/app/server.test.ts pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(server): add server package with node:http router and /healthz

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4: Loom composition root and `main`

**Files:**
- Create: `apps/server/loom.config.ts`
- Create: `apps/server/app/security.ts`
- Create: `apps/server/app/config.ts`
- Create: `apps/server/app/loom.gen.ts` (generated, not hand-written)
- Create: `apps/server/app/main.ts`

**Interfaces:**
- Consumes: `createHttpServer()` (Task 3); `defineConfig` from `@loom/app`.
- Produces: `app` (the Loom app) exported from `app/config.ts` and as the default export of `loom.config.ts`; `authorizer`, `executionAuthorizer`, `principalCodec`, `resumeAuthenticator` from `app/security.ts`; `pnpm --filter @docmind/server start` listening on `HOST:PORT` (defaults `127.0.0.1:3000`).

- [ ] **Step 1: Create `apps/server/loom.config.ts`**

```ts
export { app as default } from "./app/config";
```

- [ ] **Step 2: Create `apps/server/app/security.ts`**

```ts
import { createHash } from "node:crypto";
import { GrantTable, type PrincipalChain } from "@loom/effect-runtime";
import {
  type ExecutionAuthorizer,
  type PrincipalCodec,
  executionAccessPolicy,
  signedResumeAuthenticator,
} from "@loom/workflow-runtime";

// What `security.strict` refuses to start without. M0 has no flows, so the grant table is empty;
// every flow added later lists the tool ids it may run here (a step id doubles as its tool id).
export const authorizer = new GrantTable({});

// The actor that starts an execution owns it; only that actor, in the same tenant, may resume,
// cancel or read it.
export const executionAuthorizer: ExecutionAuthorizer = executionAccessPolicy({
  requireTenant: true,
  rules: { start: "any", resume: "owner", cancel: "owner", query: "owner" },
});

// The log stores an opaque ref, never a tenant or actor verbatim. In-memory until the durable
// event store lands (M1 PR 8); then it is backed by the users table.
const principals = new Map<string, PrincipalChain>();
export const principalCodec: PrincipalCodec = {
  toRef(chain) {
    const ref = `p:${createHash("sha256").update(JSON.stringify(chain)).digest("hex").slice(0, 32)}`;
    principals.set(ref, chain);
    return ref;
  },
  fromRef: (ref) => principals.get(ref),
};

// No gate in M0 is approvable: with no key configured every actor fails closed.
export const resumeAuthenticator = signedResumeAuthenticator({
  gates: ["AgentToolApproval", "ApprovalGranted"],
  keys: () => undefined,
});
```

- [ ] **Step 3: Create `apps/server/app/config.ts`**

```ts
import { defineConfig } from "@loom/app";
import {
  agentModules,
  flowModules,
  projectionModules,
  skillModules,
  toolModules,
} from "./loom.gen";
import { authorizer, executionAuthorizer, principalCodec, resumeAuthenticator } from "./security";

// The composition root: the only place that picks an implementation for each interface.
export const app = defineConfig({
  storage: { kind: "memory" },
  flowModules,
  agentModules,
  toolModules,
  skillModules,
  projectionModules,
  security: { strict: true, authorizer, executionAuthorizer, resumeAuthenticator, principalCodec },
});
```

- [ ] **Step 4: Generate `app/loom.gen.ts`**

Run: `pnpm --filter @docmind/server gen`
Expected: `wrote app/loom.gen.ts (0 flows, 0 agents, 0 tools, 0 skills, 0 schedules, 0 memories, 0 projections)`. Commit the generated file; Biome ignores it (`biome.json`).

- [ ] **Step 5: Create `apps/server/app/main.ts`**

```ts
import { app } from "./config";
import { createHttpServer } from "./server";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const server = createHttpServer();

server.listen(port, host, () => console.log(`docmind server listening on http://${host}:${port}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close();
    void app.close();
  });
}
```

- [ ] **Step 6: Typecheck, lint, and prove the real app boots**

Run: `pnpm typecheck && pnpm typecheck:tests && pnpm lint`
Expected: all exit 0 (`Tasks:    1 successful, 1 total` twice; `Checked 14 files in ...ms. No fixes applied.`). If Biome reformats a file, run `pnpm lint:fix` and keep its output.

In one terminal: `PORT=3917 pnpm --filter @docmind/server start`
Expected: `docmind server listening on http://127.0.0.1:3917` (this imports `app/config.ts`, so `security.strict` has accepted the four security pieces).

In another: `curl -s http://127.0.0.1:3917/healthz`
Expected: `{"status":"ok"}`. Stop the server with Ctrl-C.

- [ ] **Step 7: Commit**

```bash
git add apps/server/loom.config.ts apps/server/app/security.ts apps/server/app/config.ts apps/server/app/loom.gen.ts apps/server/app/main.ts
git commit -m "$(cat <<'EOF'
feat(server): wire the Loom composition root and start the HTTP server

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Close out 1/3: check the size budget**

```bash
git diff --numstat main...HEAD -- . ':!pnpm-lock.yaml' ':!apps/server/app/loom.gen.ts' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
```

Expected: `167 lines, 10 files` (limit: 200 lines and 10 files). If it prints more, stop and split the PR instead of stretching it.

- [ ] **Close out 2/3: run the full PR gate**

```bash
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0 and the last turbo summary reads `Tasks:    N successful, N total`.
- [ ] **Close out 3/3: push and open the draft PR**

```bash
git push -u origin feat/m0-scaffold-server
gh pr create --draft --base main --head feat/m0-scaffold-server --title "feat(server): create-loom-app server with /healthz" --body "$(cat <<'EOF'
## Summary
- apps/server from the create-loom-app scaffold (config, strict security stubs, loom.config.ts), trimmed
- demo flow, middleware and README dropped.
- node:http router with GET /healthz and a JSON 404, tested on 127.0.0.1 with an ephemeral port.
- Part 2 of 2 of spec §9 PR 1
- split to stay under 10 files.

## Not counted toward the 200-line / 10-file limit
pnpm-lock.yaml (generated); apps/server/app/loom.gen.ts (generated by loom gen, 0 modules).

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: `gh` prints the PR URL. The PR stays a draft: CI does not run until it is marked ready, and only the owner merges.

---

# PR 2: CI, docker-compose, `.env.example`

**Branch:** `feat/m0-ci-infra`  **Depends on:** PR 1b merged.  **Budget:** 3 files, 139 lines.

**Before this PR can be proven:** add the `LOOM_TOKEN` secret, because `chhetrisushil/loom` is private. Create a fine-grained personal access token (Repository access: only `chhetrisushil/loom`; Permissions: Contents = Read-only), then:

```bash
gh secret set LOOM_TOKEN --repo chhetrisushil/docmind
```

`gh` prompts for the value (paste the token). Without the secret the "Checkout loom" step fails and so does the run, on purpose.

### Task 5: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: root scripts `build`, `typecheck`, `typecheck:tests`, `lint`, `test` (PR 1a); `DOCMIND_TEST_PG_URL` convention (PR 4a).
- Produces: workflow `ci`, job `gate`, env `LOOM_REF` (bump deliberately), a pgvector Postgres service on `127.0.0.1:5432`, `DOCMIND_TEST_PG_URL` set for the job.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m0-ci-infra
```

- [ ] **Step 2: Create `.github/workflows/ci.yml`**

```yaml
# DocMind consumes the sibling ../loom checkout via pnpm.overrides (link:), because @loom/* is not
# published. CI therefore checks loom out NEXT TO this repo at a pinned ref, builds it, then builds,
# typechecks, lints and tests DocMind against it. The same pattern as loom-ui.
#
# chhetrisushil/loom is private: the LOOM_TOKEN repository secret must hold a token with read access
# to it (a fine-grained PAT with "Contents: read" on that one repository). Without it the loom
# checkout fails, and so does the run: loudly, rather than testing against nothing.
name: ci

# Actions minutes are a budget: a PR runs CI once it is READY. Draft PRs skip every job (iterate
# against the full local gate), and main is checked after each merge.
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  push:
    branches: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

env:
  # The loom commit DocMind is built and tested against. Bump deliberately: rebuild ../loom at the
  # new commit, re-run the whole gate, then change this line.
  LOOM_REF: 8f9eab2492c85bb994d746855f06d2eccc9f45db

jobs:
  gate:
    name: build + typecheck + lint + test
    if: github.event_name == 'push' || github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env:
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    env:
      # Turns on the Postgres suites; without it they skip.
      DOCMIND_TEST_PG_URL: postgres://postgres:postgres@127.0.0.1:5432/postgres
    steps:
      - uses: actions/checkout@v4
        with:
          path: docmind
      - name: Checkout loom (the framework DocMind links to)
        uses: actions/checkout@v4
        with:
          repository: chhetrisushil/loom
          ref: ${{ env.LOOM_REF }}
          token: ${{ secrets.LOOM_TOKEN }}
          path: loom
      - uses: pnpm/action-setup@v4
        with:
          version: 9.14.4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
          cache-dependency-path: |
            loom/pnpm-lock.yaml
            docmind/pnpm-lock.yaml
      - name: Install and build loom
        working-directory: loom
        run: pnpm install --frozen-lockfile && pnpm build
      - name: Install DocMind
        working-directory: docmind
        run: pnpm install --frozen-lockfile
      - name: Build
        working-directory: docmind
        run: pnpm build
      - name: Typecheck
        working-directory: docmind
        run: pnpm typecheck
      - name: Typecheck test files
        working-directory: docmind
        run: pnpm typecheck:tests
      - name: Lint
        working-directory: docmind
        run: pnpm lint
      - name: Test
        working-directory: docmind
        run: pnpm test
```

- [ ] **Step 3: Check the workflow's draft policy mechanically**

A workflow cannot run while its PR is a draft, so assert the policy from the file. Run:

```bash
python3 - <<'PY'
import yaml
wf = yaml.safe_load(open(".github/workflows/ci.yml"))
on = wf[True]  # YAML parses the key `on` as boolean True
assert on["pull_request"]["types"] == ["opened", "synchronize", "reopened", "ready_for_review"], on
assert on["push"]["branches"] == ["main"], on
gate = "github.event_name == 'push' || github.event.pull_request.draft == false"
for name, job in wf["jobs"].items():
    assert job["if"] == gate, f"{name} is not draft-gated"
print("ok:", ", ".join(wf["jobs"]))
PY
```

Expected: `ok: gate`.

### Task 6: docker-compose and `.env.example`

**Files:**
- Create: `docker-compose.yml`
- Create: `.env.example`

**Interfaces:**
- Consumes: nothing.
- Produces: services `postgres` (pgvector 16; superuser `docmind`/`docmind`, database `docmind`) and `ollama`, both bound to `127.0.0.1`; the documented variables `HOST`, `PORT`, `DOCMIND_MIGRATE_URL`, `DOCMIND_APP_DB_PASSWORD`, `DATABASE_URL`, `DOCMIND_TEST_PG_URL`, `OLLAMA_URL`, `ANTHROPIC_API_KEY` (the DB ones are implemented in PRs 4a/4b; the rest from M3/M4).

- [ ] **Step 1: Create `docker-compose.yml`**

```yaml
# Local services: `docker compose up -d`, then
#   docker compose exec ollama ollama pull nomic-embed-text
# Everything binds to 127.0.0.1 only.
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: docmind
      POSTGRES_PASSWORD: docmind
      POSTGRES_DB: docmind
    ports:
      - "127.0.0.1:5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U docmind -d docmind"]
      interval: 5s
      timeout: 5s
      retries: 10

  ollama:
    image: ollama/ollama:latest
    ports:
      - "127.0.0.1:11434:11434"
    volumes:
      - ollama:/root/.ollama

volumes:
  pgdata:
  ollama:
```

- [ ] **Step 2: Create `.env.example`**

```
# Copy to .env (git-ignored) and load it into your shell: set -a; . ./.env; set +a
# Hosts and credentials match docker-compose.yml.

# HTTP server
HOST=127.0.0.1
PORT=3000

# Postgres. The OWNER role runs migrations (pnpm --filter @docmind/server db:migrate); the server
# itself connects as docmind_app, which owns nothing and cannot bypass row-level security.
DOCMIND_MIGRATE_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind
DOCMIND_APP_DB_PASSWORD=change-me-locally
DATABASE_URL=postgres://docmind_app:change-me-locally@127.0.0.1:5432/docmind

# Enables the Postgres integration tests (they skip when unset). The role must be able to
# CREATE DATABASE: each suite makes, and drops, a database of its own.
DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind

# Used from M3 (embeddings) and M4 (chat).
OLLAMA_URL=http://127.0.0.1:11434
ANTHROPIC_API_KEY=
```

- [ ] **Step 3: Validate compose (needs Docker; it was not installed where this plan was written)**

Run: `docker compose config -q && docker compose up -d postgres && docker compose ps`
Expected: `config -q` prints nothing; after a few seconds `postgres` shows `healthy`. Then `docker compose exec postgres psql -U docmind -d docmind -c "select 1"` prints one row. Stop with `docker compose down` (add `-v` to drop the volume).

- [ ] **Step 4: Lint and commit**

Run: `pnpm lint`
Expected: `Checked 14 files in ...ms. No fixes applied.`

```bash
git add .github/workflows/ci.yml docker-compose.yml .env.example
git commit -m "$(cat <<'EOF'
ci: add draft-skipping workflow, docker-compose and .env.example

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Close out 1/3: check the size budget**

```bash
git diff --numstat main...HEAD -- . ':!pnpm-lock.yaml' ':!apps/server/app/loom.gen.ts' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
```

Expected: `139 lines, 3 files` (limit: 200 lines and 10 files). If it prints more, stop and split the PR instead of stretching it.

- [ ] **Close out 2/3: run the full PR gate**

```bash
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0 and the last turbo summary reads `Tasks:    N successful, N total`.
- [ ] **Close out 3/3: push and open the draft PR**

```bash
git push -u origin feat/m0-ci-infra
gh pr create --draft --base main --head feat/m0-ci-infra --title "ci: draft-skipping CI, docker-compose, .env.example" --body "$(cat <<'EOF'
## Summary
- GitHub Actions workflow: pull_request [opened, synchronize, reopened, ready_for_review] plus push to main
- every job gated on non-draft
- checks out private chhetrisushil/loom at pinned LOOM_REF into ../loom and builds it
- pgvector Postgres service
- runs build, typecheck, typecheck:tests, lint, test.
- docker-compose: pgvector Postgres 16 and Ollama on 127.0.0.1.
- .env.example for the server, Postgres roles and tests.
- Needs the LOOM_TOKEN repository secret (read access to chhetrisushil/loom) before the first non-draft run.

## Not counted toward the 200-line / 10-file limit
None (no lockfile change).

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: `gh` prints the PR URL. The PR stays a draft: CI does not run until it is marked ready, and only the owner merges.

After opening it, tell the owner: "mark PR 2 ready for review to run the workflow for the first time; the `Checkout loom` step proves `LOOM_TOKEN`." If that run fails, fix on this branch (the PR stays under budget).

---

# PR 3a: contracts scaffold, common and auth schemas

**Branch:** `feat/m0-contracts`  **Depends on:** PR 1a merged (independent of 2).  **Budget:** 7 files, 105 lines (+ lockfile).

### Task 7: `@docmind/contracts` package, common and auth

**Files:**
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/tsconfig.test.json`
- Create: `packages/contracts/src/common.ts`
- Create: `packages/contracts/src/auth.ts`
- Create: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/auth.test.ts`

**Interfaces:**
- Consumes: root `tsconfig.base.json`.
- Produces (all also exported as same-named types via `z.infer`): `Uuid`, `IsoDateTime`, `Cursor`, `ErrorBody` (`{ error: { code, message } }`); `Email` (trim, lower-case, valid, max 254), `SignUpRequest { email, password(12..128) }`, `LoginRequest { email, password(1..128) }`, `MeResponse { userId, tenantId, email }`. Package entry `./dist/index.js` / `./dist/index.d.ts` (CommonJS, like Loom; the web app aliases the source in M6).

- [ ] **Step 1: Create the branch and the package files**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m0-contracts
mkdir -p packages/contracts/src
```

Create `packages/contracts/package.json`:

```json
{
  "name": "@docmind/contracts",
  "version": "0.0.0",
  "private": true,
  "description": "zod schemas and types for the DocMind HTTP API (server and web).",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "typecheck:tests": "tsc -p tsconfig.test.json"
  },
  "dependencies": {
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "vitest": "^2.1.8"
  }
}
```

Create `packages/contracts/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"],
  "exclude": ["**/*.test.ts", "dist"]
}
```

Create `packages/contracts/tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src"],
  "exclude": ["dist"]
}
```

Run: `pnpm install`
Expected: `+ zod 3.x`, `+ vitest 2.x` for `@docmind/contracts`; lockfile updated.

- [ ] **Step 2: Write the failing test and the index**

Create `packages/contracts/src/index.ts`:

```ts
export * from "./auth";
export * from "./common";
```

Create `packages/contracts/src/auth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ErrorBody, LoginRequest, MeResponse, SignUpRequest } from "./index";

const ID = "11111111-1111-4111-8111-111111111111";

describe("auth contracts", () => {
  it("normalises the email on sign-up", () => {
    const parsed = SignUpRequest.parse({
      email: "  Ada@Example.COM ",
      password: "correct horse battery",
    });
    expect(parsed.email).toBe("ada@example.com");
  });

  it("rejects a short sign-up password but accepts it on login", () => {
    expect(SignUpRequest.safeParse({ email: "a@b.co", password: "short" }).success).toBe(false);
    expect(LoginRequest.safeParse({ email: "a@b.co", password: "short" }).success).toBe(true);
  });

  it("rejects a malformed email", () => {
    expect(LoginRequest.safeParse({ email: "not-an-email", password: "x" }).success).toBe(false);
  });

  it("requires uuid ids in MeResponse", () => {
    const ok = { userId: ID, tenantId: ID, email: "a@b.co" };
    expect(MeResponse.parse(ok)).toEqual(ok);
    expect(MeResponse.safeParse({ ...ok, userId: "u1" }).success).toBe(false);
  });

  it("describes errors as { error: { code, message } }", () => {
    expect(ErrorBody.safeParse({ error: { code: "unauthorized", message: "no" } }).success).toBe(
      true,
    );
    expect(ErrorBody.safeParse({ error: "no" }).success).toBe(false);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @docmind/contracts test`
Expected: FAIL, `Error: Failed to load url ./auth ... Does the file exist?` and `Tests  no tests`.

- [ ] **Step 4: Write the implementation**

Create `packages/contracts/src/common.ts`:

```ts
import { z } from "zod";

export const Uuid = z.string().uuid();
export const IsoDateTime = z.string().datetime();

/** Opaque pagination cursor: the server issues it, clients echo it back unchanged. */
export const Cursor = z.string().min(1).max(512);

/** Body of every non-2xx response. */
export const ErrorBody = z.object({
  error: z.object({ code: z.string().min(1), message: z.string() }),
});
export type ErrorBody = z.infer<typeof ErrorBody>;
```

Create `packages/contracts/src/auth.ts`:

```ts
import { z } from "zod";
import { Uuid } from "./common";

/** Trimmed and lower-cased on the way in, so `users.email UNIQUE` is case-insensitive. */
export const Email = z.string().trim().toLowerCase().email().max(254);

export const SignUpRequest = z.object({
  email: Email,
  password: z.string().min(12).max(128),
});
export type SignUpRequest = z.infer<typeof SignUpRequest>;

/** No minimum length on login: a password set under an older policy must still work. */
export const LoginRequest = z.object({
  email: Email,
  password: z.string().min(1).max(128),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

/** `GET /api/me`, and the body of a successful sign-up or login. */
export const MeResponse = z.object({ userId: Uuid, tenantId: Uuid, email: Email });
export type MeResponse = z.infer<typeof MeResponse>;
```

- [ ] **Step 5: Run the tests and the type checks**

Run: `pnpm --filter @docmind/contracts test`
Expected: `✓ src/auth.test.ts (5 tests)` and `Tests  5 passed (5)`.

Run: `pnpm build && pnpm typecheck && pnpm typecheck:tests`
Expected: all exit 0; `packages/contracts/dist/index.d.ts` exists (gitignored).

- [ ] **Step 6: Commit**

```bash
git add packages/contracts pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(contracts): add contracts package with common and auth schemas

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Close out 1/3: check the size budget**

```bash
git diff --numstat main...HEAD -- . ':!pnpm-lock.yaml' ':!apps/server/app/loom.gen.ts' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
```

Expected: `105 lines, 7 files` (limit: 200 lines and 10 files). If it prints more, stop and split the PR instead of stretching it.

- [ ] **Close out 2/3: run the full PR gate**

```bash
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0 and the last turbo summary reads `Tasks:    N successful, N total`.
- [ ] **Close out 3/3: push and open the draft PR**

```bash
git push -u origin feat/m0-contracts
gh pr create --draft --base main --head feat/m0-contracts --title "feat(contracts): contracts package with auth schemas" --body "$(cat <<'EOF'
## Summary
- New packages/contracts (zod 3): common helpers (Uuid, IsoDateTime, Cursor, ErrorBody) and the auth shapes (sign-up, login, me). Email is trimmed and lower-cased so users.email UNIQUE is case-insensitive.
- Sign-up password min 12 chars
- login has no minimum. Part 1 of 3 of spec §9 PR 3.

## Not counted toward the 200-line / 10-file limit
pnpm-lock.yaml (generated).

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: `gh` prints the PR URL. The PR stays a draft: CI does not run until it is marked ready, and only the owner merges.

---

# PR 3b: document schemas

**Branch:** `feat/m0-contracts-documents`  **Depends on:** PR 3a merged.  **Budget:** 3 files, 116 lines.

### Task 8: documents contracts

**Files:**
- Create: `packages/contracts/src/documents.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/documents.test.ts`

**Interfaces:**
- Consumes: `Uuid`, `IsoDateTime`, `Cursor` from `./common`.
- Produces: `DocumentStatus` (`uploaded|parsing|embedding|ready|failed`), `IngestStep` (`parse|chunk|embed|analyze|summarize|finalize`), `DocumentStats`, `DocumentSummary` (`tldr, keyPoints, entities, topics, suggestedQuestions`), `DocumentDto`, `UploadDocumentResponse { document, duplicate }`, `ListDocumentsQuery { cursor?, limit (default 50, max 100, coerced from a query string) }`, `ListDocumentsResponse { items, nextCursor }`, `DocumentProgressEvent { documentId, step, status, detail? }` (spec §5.1, §5.2).

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m0-contracts-documents
```

- [ ] **Step 2: Write the failing test and export the module**

Create `packages/contracts/src/documents.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { DocumentDto, DocumentProgressEvent, ListDocumentsQuery } from "./index";

const ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-10-18T10:00:00.000Z";
const doc = {
  id: ID,
  title: "Q3 report",
  filename: "q3.pdf",
  mime: "application/pdf",
  sizeBytes: 1024,
  status: "ready",
  error: null,
  stats: null,
  summary: null,
  createdAt: NOW,
  updatedAt: NOW,
};

describe("document contracts", () => {
  it("accepts a ready document and round-trips it", () => {
    expect(DocumentDto.parse(doc)).toEqual(doc);
  });

  it("rejects an unknown status and a negative size", () => {
    expect(DocumentDto.safeParse({ ...doc, status: "done" }).success).toBe(false);
    expect(DocumentDto.safeParse({ ...doc, sizeBytes: -1 }).success).toBe(false);
  });

  it("coerces list query strings and defaults the page size to 50", () => {
    expect(ListDocumentsQuery.parse({})).toEqual({ limit: 50 });
    expect(ListDocumentsQuery.parse({ limit: "20", cursor: "abc" })).toEqual({
      limit: 20,
      cursor: "abc",
    });
    expect(ListDocumentsQuery.safeParse({ limit: "500" }).success).toBe(false);
  });

  it("only accepts known ingest steps in progress events", () => {
    const event = { documentId: ID, step: "embed", status: "embedding" };
    expect(DocumentProgressEvent.parse(event)).toEqual(event);
    expect(DocumentProgressEvent.safeParse({ ...event, step: "ocr" }).success).toBe(false);
  });
});
```

Replace `packages/contracts/src/index.ts` with:

```ts
export * from "./auth";
export * from "./common";
export * from "./documents";
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @docmind/contracts test`
Expected: FAIL, `Error: Failed to load url ./documents ... Does the file exist?` (the auth suite fails too, as it imports the same index).

- [ ] **Step 4: Write the implementation**

Create `packages/contracts/src/documents.ts`:

```ts
import { z } from "zod";
import { Cursor, IsoDateTime, Uuid } from "./common";

export const DocumentStatus = z.enum(["uploaded", "parsing", "embedding", "ready", "failed"]);
export type DocumentStatus = z.infer<typeof DocumentStatus>;

/** Steps of the `ingest-document` flow, in order. */
export const IngestStep = z.enum(["parse", "chunk", "embed", "analyze", "summarize", "finalize"]);
export type IngestStep = z.infer<typeof IngestStep>;

/** Output of the analyze step: deterministic statistics. */
export const DocumentStats = z.object({
  wordCount: z.number().int().nonnegative(),
  pageCount: z.number().int().nonnegative().nullable(),
  readingTimeMinutes: z.number().nonnegative(),
  language: z.string().nullable(),
  outline: z.array(z.string()),
  dates: z.array(z.string()),
  numbers: z.array(z.string()),
});
export type DocumentStats = z.infer<typeof DocumentStats>;

/** Output of the summarize step. */
export const DocumentSummary = z.object({
  tldr: z.string(),
  keyPoints: z.array(z.string()),
  entities: z.array(z.string()),
  topics: z.array(z.string()),
  suggestedQuestions: z.array(z.string()),
});
export type DocumentSummary = z.infer<typeof DocumentSummary>;

export const DocumentDto = z.object({
  id: Uuid,
  title: z.string(),
  filename: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  status: DocumentStatus,
  error: z.string().nullable(),
  stats: DocumentStats.nullable(),
  summary: DocumentSummary.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type DocumentDto = z.infer<typeof DocumentDto>;

/** `POST /api/documents` (the multipart body is not a JSON contract). `duplicate`: same bytes re-sent. */
export const UploadDocumentResponse = z.object({ document: DocumentDto, duplicate: z.boolean() });
export type UploadDocumentResponse = z.infer<typeof UploadDocumentResponse>;

export const ListDocumentsQuery = z.object({
  cursor: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListDocumentsQuery = z.infer<typeof ListDocumentsQuery>;

export const ListDocumentsResponse = z.object({
  items: z.array(DocumentDto),
  nextCursor: Cursor.nullable(),
});
export type ListDocumentsResponse = z.infer<typeof ListDocumentsResponse>;

/** One event on `GET /api/documents/events` (SSE). */
export const DocumentProgressEvent = z.object({
  documentId: Uuid,
  step: IngestStep,
  status: DocumentStatus,
  detail: z.string().optional(),
});
export type DocumentProgressEvent = z.infer<typeof DocumentProgressEvent>;
```

- [ ] **Step 5: Run the tests and the type checks**

Run: `pnpm --filter @docmind/contracts test`
Expected: `Tests  9 passed (9)` (5 auth + 4 documents).

Run: `pnpm build && pnpm typecheck && pnpm typecheck:tests`
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts
git commit -m "$(cat <<'EOF'
feat(contracts): add document schemas

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Close out 1/3: check the size budget**

```bash
git diff --numstat main...HEAD -- . ':!pnpm-lock.yaml' ':!apps/server/app/loom.gen.ts' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
```

Expected: `116 lines, 3 files` (limit: 200 lines and 10 files). If it prints more, stop and split the PR instead of stretching it.

- [ ] **Close out 2/3: run the full PR gate**

```bash
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0 and the last turbo summary reads `Tasks:    N successful, N total`.
- [ ] **Close out 3/3: push and open the draft PR**

```bash
git push -u origin feat/m0-contracts-documents
gh pr create --draft --base main --head feat/m0-contracts-documents --title "feat(contracts): document schemas" --body "$(cat <<'EOF'
## Summary
- Document DTO, status, ingest steps, stats, structured summary, upload/list responses and the SSE progress event (spec §5.1, §5.2).
- Part 2 of 3 of spec §9 PR 3.

## Not counted toward the 200-line / 10-file limit
None (no lockfile change).

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: `gh` prints the PR URL. The PR stays a draft: CI does not run until it is marked ready, and only the owner merges.

---

# PR 3c: chat schemas

**Branch:** `feat/m0-contracts-chats`  **Depends on:** PR 3b merged.  **Budget:** 3 files, 130 lines.

### Task 9: chats contracts

**Files:**
- Create: `packages/contracts/src/chats.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/src/chats.test.ts`

**Interfaces:**
- Consumes: `Uuid`, `IsoDateTime`, `Cursor` from `./common`.
- Produces: `ChatScope` (`"all"` or `{ documentIds: Uuid[1..100] }`), `Locator` (`{ kind: chars|heading|page|paragraphs|region, ...rest }`), `Citation { passageId, documentId, docTitle, locator, snippet }`, `CreateChatRequest { scope (default "all") }`, `ChatSessionDto`, `ListChatsQuery { cursor?, q? }`, `ListChatsResponse`, `ChatMessageDto { id, role: user|assistant, text, citations, createdAt }`, `ListMessagesQuery`, `ListMessagesResponse`, `SendMessageRequest { text (trimmed, 1..8000) }`, `PatchChatRequest { title?, scope? }` (at least one required) (spec §6.1).

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m0-contracts-chats
```

- [ ] **Step 2: Write the failing test and export the module**

Create `packages/contracts/src/chats.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ChatMessageDto, CreateChatRequest, PatchChatRequest, SendMessageRequest } from "./index";

const ID = "11111111-1111-4111-8111-111111111111";

describe("chat contracts", () => {
  it("defaults a new chat's scope to all documents", () => {
    expect(CreateChatRequest.parse({})).toEqual({ scope: "all" });
  });

  it("accepts a document-list scope and rejects an empty one", () => {
    expect(CreateChatRequest.parse({ scope: { documentIds: [ID] } }).scope).toEqual({
      documentIds: [ID],
    });
    expect(CreateChatRequest.safeParse({ scope: { documentIds: [] } }).success).toBe(false);
    expect(CreateChatRequest.safeParse({ scope: "some" }).success).toBe(false);
  });

  it("requires a patch to change something", () => {
    expect(PatchChatRequest.safeParse({}).success).toBe(false);
    expect(PatchChatRequest.safeParse({ title: "Renamed" }).success).toBe(true);
  });

  it("rejects an empty or oversized message", () => {
    expect(SendMessageRequest.safeParse({ text: "   " }).success).toBe(false);
    expect(SendMessageRequest.safeParse({ text: "x".repeat(8001) }).success).toBe(false);
  });

  it("keeps locator fields it does not know yet", () => {
    const message = {
      id: "m1",
      role: "assistant",
      text: "See [[p1]].",
      citations: [
        {
          passageId: "p1",
          documentId: ID,
          docTitle: "Q3",
          locator: { kind: "page", page: 4 },
          snippet: "...",
        },
      ],
      createdAt: "2026-10-18T10:00:00.000Z",
    };
    expect(ChatMessageDto.parse(message).citations[0]?.locator).toEqual({ kind: "page", page: 4 });
  });
});
```

Replace `packages/contracts/src/index.ts` with:

```ts
export * from "./auth";
export * from "./chats";
export * from "./common";
export * from "./documents";
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @docmind/contracts test`
Expected: FAIL, `Failed Suites 3` (`auth`, `chats` and `documents` suites all fail on the missing `./chats` module).

- [ ] **Step 4: Write the implementation**

Create `packages/contracts/src/chats.ts`:

```ts
import { z } from "zod";
import { Cursor, IsoDateTime, Uuid } from "./common";

/** `"all"` searches every document; otherwise only the listed ones. */
export const ChatScope = z.union([
  z.literal("all"),
  z.object({ documentIds: z.array(Uuid).min(1).max(100) }),
]);
export type ChatScope = z.infer<typeof ChatScope>;

/** Where a passage sits in its document. Extra fields per `kind` are defined with the parsers (M3). */
export const Locator = z
  .object({ kind: z.enum(["chars", "heading", "page", "paragraphs", "region"]) })
  .passthrough();
export type Locator = z.infer<typeof Locator>;

export const Citation = z.object({
  passageId: z.string().min(1),
  documentId: Uuid,
  docTitle: z.string(),
  locator: Locator,
  snippet: z.string(),
});
export type Citation = z.infer<typeof Citation>;

/** `POST /api/chats`. */
export const CreateChatRequest = z.object({ scope: ChatScope.default("all") });
export type CreateChatRequest = z.infer<typeof CreateChatRequest>;

export const ChatSessionDto = z.object({
  id: z.string().min(1),
  title: z.string(),
  scope: ChatScope,
  createdAt: IsoDateTime,
  lastMessageAt: IsoDateTime.nullable(),
  messageCount: z.number().int().nonnegative(),
});
export type ChatSessionDto = z.infer<typeof ChatSessionDto>;

/** `GET /api/chats?cursor&q`: `q` filters by title. */
export const ListChatsQuery = z.object({
  cursor: Cursor.optional(),
  q: z.string().trim().max(200).optional(),
});
export type ListChatsQuery = z.infer<typeof ListChatsQuery>;

export const ListChatsResponse = z.object({
  items: z.array(ChatSessionDto),
  nextCursor: Cursor.nullable(),
});
export type ListChatsResponse = z.infer<typeof ListChatsResponse>;

export const ChatMessageDto = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  citations: z.array(Citation),
  createdAt: IsoDateTime,
});
export type ChatMessageDto = z.infer<typeof ChatMessageDto>;

/** `GET /api/chats/:id/messages?cursor`. */
export const ListMessagesQuery = z.object({ cursor: Cursor.optional() });
export type ListMessagesQuery = z.infer<typeof ListMessagesQuery>;

export const ListMessagesResponse = z.object({
  items: z.array(ChatMessageDto),
  nextCursor: Cursor.nullable(),
});
export type ListMessagesResponse = z.infer<typeof ListMessagesResponse>;

/** `POST /api/chats/:id/messages`. The reply arrives on the SSE stream. */
export const SendMessageRequest = z.object({ text: z.string().trim().min(1).max(8000) });
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;

/** `PATCH /api/chats/:id`: rename, change scope, or both. */
export const PatchChatRequest = z
  .object({ title: z.string().trim().min(1).max(200).optional(), scope: ChatScope.optional() })
  .refine((v) => v.title !== undefined || v.scope !== undefined, {
    message: "provide a title, a scope, or both",
  });
export type PatchChatRequest = z.infer<typeof PatchChatRequest>;
```

- [ ] **Step 5: Run the tests and the type checks**

Run: `pnpm --filter @docmind/contracts test`
Expected: `Tests  14 passed (14)` (5 + 4 + 5).

Run: `pnpm build && pnpm typecheck && pnpm typecheck:tests`
Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts
git commit -m "$(cat <<'EOF'
feat(contracts): add chat schemas

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Close out 1/3: check the size budget**

```bash
git diff --numstat main...HEAD -- . ':!pnpm-lock.yaml' ':!apps/server/app/loom.gen.ts' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
```

Expected: `130 lines, 3 files` (limit: 200 lines and 10 files). If it prints more, stop and split the PR instead of stretching it.

- [ ] **Close out 2/3: run the full PR gate**

```bash
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0 and the last turbo summary reads `Tasks:    N successful, N total`.
- [ ] **Close out 3/3: push and open the draft PR**

```bash
git push -u origin feat/m0-contracts-chats
gh pr create --draft --base main --head feat/m0-contracts-chats --title "feat(contracts): chat schemas" --body "$(cat <<'EOF'
## Summary
- Chat scope, create/list/rename requests, session and message DTOs, citations with a tagged locator, send-message request (spec §6.1).
- Locator is {kind, ...rest} passthrough until the M3 parsers define the per-format fields.
- Part 3 of 3 of spec §9 PR 3
- unblocks M6 against a mocked API.

## Not counted toward the 200-line / 10-file limit
None (no lockfile change).

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: `gh` prints the PR URL. The PR stays a draft: CI does not run until it is marked ready, and only the owner merges.

---

# PR 4a: migration runner and the app role

**Branch:** `feat/m0-db-migrations`  **Depends on:** PR 1b and PR 2 merged (uses `apps/server` and `docker-compose.yml`); a Postgres per "Preconditions".  **Budget:** 7 files, 176 lines (+ lockfile).

Design: numbered `infra/migrations/NNNN_name.sql` files, a `schema_migrations(name, applied_at)` table, one transaction per file, an advisory lock so concurrent runners apply each file once. Migration `0001` creates `docmind_app`: no login, no superuser, no `BYPASSRLS`, owns nothing, and gets default privileges on future tables.

### Task 10: runner, test database helper, `0001_app_role.sql`

**Files:**
- Modify: `apps/server/package.json` (add `pg`, `@types/pg`)
- Modify: `turbo.json` (`test` task passes `DOCMIND_TEST_PG_URL`)
- Modify: `apps/server/vitest.config.ts` (`fileParallelism: false`)
- Create: `infra/migrations/0001_app_role.sql`
- Create: `apps/server/app/db/testSupport.ts`
- Create: `apps/server/app/db/migrate.ts`
- Test: `apps/server/app/db/migrate.test.ts`

**Interfaces:**
- Consumes: `pg` `Pool`.
- Produces: `migrate(pool: Pool, dir?: string): Promise<string[]>` (names applied this run, in order; `dir` defaults to `MIGRATIONS_DIR`), `MIGRATIONS_DIR`; test helpers `PG_URL: string | undefined`, `createTestDb(): Promise<TestDb>`, `interface TestDb { owner: Pool; drop(): Promise<void> }` (each call makes a fresh `docmind_t_<hex>` database); role `docmind_app` (cluster-wide, so test files run one at a time).

- [ ] **Step 1: Create the branch and wire dependencies and config**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m0-db-migrations
mkdir -p infra/migrations apps/server/app/db
```

Replace `apps/server/package.json` with:

```json
{
  "name": "@docmind/server",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "tsx app/main.ts",
    "gen": "loom gen --dir app",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "typecheck:tests": "tsc -p tsconfig.test.json"
  },
  "dependencies": {
    "@loom/app": "*",
    "@loom/effect-runtime": "*",
    "@loom/workflow-runtime": "*",
    "pg": "^8.13.0"
  },
  "devDependencies": {
    "@loom/cli": "*",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.2",
    "vitest": "^2.1.8",
    "@types/pg": "^8.11.0"
  }
}
```

Replace `turbo.json` with (Turbo's strict env mode otherwise hides the variable from `test`, which silently skips the Postgres suites):

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "typecheck": {
      "dependsOn": ["^build"]
    },
    "typecheck:tests": {
      "dependsOn": ["^build"]
    },
    "test": {
      "dependsOn": ["^build"],
      "env": ["DOCMIND_TEST_PG_URL"]
    }
  }
}
```

Replace `apps/server/vitest.config.ts` with:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  // @loom/* publish require-only `exports`; resolve them the same way under Vite.
  resolve: { conditions: ["node", "require", "default"] },
  // Suites share cluster-wide state (the docmind_app role), so test files run one at a time.
  test: {
    environment: "node",
    fileParallelism: false,
    server: { deps: { external: [/@loom\//, /[\\/]loom[\\/]/] } },
  },
});
```

Run: `pnpm install`
Expected: `+ pg 8.x` and `+ @types/pg 8.x`; lockfile updated.

- [ ] **Step 2: Create the migration, the helper and the failing test**

Create `infra/migrations/0001_app_role.sql`:

```sql
-- The role the server connects as. It owns nothing, cannot bypass row-level security, and starts
-- with no login: `pnpm db:migrate` gives it one when DOCMIND_APP_DB_PASSWORD is set.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'docmind_app') THEN
    CREATE ROLE docmind_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO docmind_app;

-- Tables the migrator creates from here on are readable and writable by the app role. Row-level
-- security (enabled per table in each migration) is what limits which rows.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO docmind_app;
```

Create `apps/server/app/db/testSupport.ts`:

```ts
import { randomBytes } from "node:crypto";
import { Pool } from "pg";

/** Set by CI and in a local .env; the Postgres suites skip cleanly without it. */
export const PG_URL = process.env.DOCMIND_TEST_PG_URL;

export interface TestDb {
  /** Connected as the owner named in DOCMIND_TEST_PG_URL (runs migrations, seeds data). */
  owner: Pool;
  drop(): Promise<void>;
}

/** An empty database of its own, so suites never see each other's tables. */
export async function createTestDb(): Promise<TestDb> {
  if (!PG_URL) throw new Error("DOCMIND_TEST_PG_URL is not set");
  const name = `docmind_t_${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString: PG_URL, max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(PG_URL);
  url.pathname = `/${name}`;
  const owner = new Pool({ connectionString: url.toString() });

  return {
    owner,
    async drop() {
      await owner.end();
      const dropper = new Pool({ connectionString: PG_URL, max: 1 });
      await dropper.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await dropper.end();
    },
  };
}
```

Create `apps/server/app/db/migrate.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "./migrate";
import { PG_URL, type TestDb, createTestDb } from "./testSupport";

describe.skipIf(!PG_URL)("migration runner (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let dir: string;

  beforeAll(async () => {
    db = await createTestDb();
    dir = mkdtempSync(join(tmpdir(), "docmind-migrations-"));
    writeFileSync(join(dir, "0001_one.sql"), "CREATE TABLE one (id int);");
    writeFileSync(join(dir, "0002_two.sql"), "CREATE TABLE two (id int);");
    writeFileSync(join(dir, "notes.txt"), "not a migration");
  });

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db.drop();
  });

  it("applies files in name order, once, and records them", async () => {
    expect(await migrate(db.owner, dir)).toEqual(["0001_one.sql", "0002_two.sql"]);
    expect(await migrate(db.owner, dir)).toEqual([]);
    const { rows } = await db.owner.query("SELECT name FROM schema_migrations ORDER BY name");
    expect(rows.map((r) => r.name)).toEqual(["0001_one.sql", "0002_two.sql"]);
  });

  it("rolls a failing file back whole and keeps the earlier ones", async () => {
    const bad = join(dir, "0003_bad.sql");
    writeFileSync(bad, "CREATE TABLE three (id int); SELECT 1/0;");
    await expect(migrate(db.owner, dir)).rejects.toThrow(/division by zero/);
    rmSync(bad);
    const { rows } = await db.owner.query("SELECT to_regclass('three') AS t");
    expect(rows[0].t).toBeNull();
    const done = await db.owner.query("SELECT count(*)::int AS n FROM schema_migrations");
    expect(done.rows[0].n).toBe(2);
  });

  it("lets two runners started together apply each file once", async () => {
    const racy = await createTestDb();
    try {
      const runs = await Promise.all([migrate(racy.owner, dir), migrate(racy.owner, dir)]);
      expect(runs.flat().sort()).toEqual(["0001_one.sql", "0002_two.sql"]);
    } finally {
      await racy.drop();
    }
  });

  it("applies the repo's migrations, which create an unprivileged app role", async () => {
    const fresh = await createTestDb();
    try {
      expect(await migrate(fresh.owner)).toContain("0001_app_role.sql");
      const { rows } = await fresh.owner.query(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'docmind_app'",
      );
      expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    } finally {
      await fresh.drop();
    }
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @docmind/server test app/db/migrate.test.ts`
Expected: FAIL, `Error: Failed to load url ./migrate ... Does the file exist?` and `Tests  no tests`.

- [ ] **Step 4: Write the runner**

Create `apps/server/app/db/migrate.ts`:

```ts
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Pool } from "pg";

// Resolved from the source tree: this runs under tsx and vitest, never from `dist`.
export const MIGRATIONS_DIR = resolve(__dirname, "../../../../infra/migrations");

// Serializes runners: two started together apply each file once.
const LOCK_KEY = 727274;

/** Applies every `NNNN_name.sql` in `dir` not yet recorded in `schema_migrations`, in name order. */
export async function migrate(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const done = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const seen = new Set(done.rows.map((r) => r.name));
    const applied: string[] = [];
    for (const file of readdirSync(dir)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f))
      .sort()) {
      if (seen.has(file)) continue;
      try {
        await client.query("BEGIN");
        await client.query(readFileSync(join(dir, file), "utf8"));
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
      applied.push(file);
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
    client.release();
  }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm --filter @docmind/server test app/db/migrate.test.ts`
Expected: `✓ app/db/migrate.test.ts (4 tests)` and `Tests  4 passed (4)`.

- [ ] **Step 6: Prove the suite skips without Postgres, and runs through Turbo with it**

Run: `env -u DOCMIND_TEST_PG_URL pnpm --filter @docmind/server test`
Expected: `↓ app/db/migrate.test.ts (4 tests | 4 skipped)` and exit 0.

Run: `pnpm exec turbo run test --force`
Expected (with `DOCMIND_TEST_PG_URL` exported): `✓ app/db/migrate.test.ts (4 tests)` under `@docmind/server:test`, no `↓`. If it shows `↓`, the `env` entry in `turbo.json` is missing.

- [ ] **Step 7: Commit**

```bash
git add apps/server/package.json apps/server/vitest.config.ts turbo.json infra/migrations/0001_app_role.sql apps/server/app/db pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
feat(db): add migration runner and the unprivileged docmind_app role

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Close out 1/3: check the size budget**

```bash
git diff --numstat main...HEAD -- . ':!pnpm-lock.yaml' ':!apps/server/app/loom.gen.ts' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
```

Expected: `176 lines, 7 files` (limit: 200 lines and 10 files). If it prints more, stop and split the PR instead of stretching it.

- [ ] **Close out 2/3: run the full PR gate**

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind  # or your local superuser URL
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0 and the last turbo summary reads `Tasks:    N successful, N total`.
The Postgres suites must have run: the `@docmind/server:test` summary shows no skipped files (`↓`) for `app/db/*`.

- [ ] **Close out 3/3: push and open the draft PR**

```bash
git push -u origin feat/m0-db-migrations
gh pr create --draft --base main --head feat/m0-db-migrations --title "feat(db): migration runner and docmind_app role" --body "$(cat <<'EOF'
## Summary
- In-repo runner: numbered infra/migrations/*.sql, schema_migrations table, one transaction per file with rollback, advisory lock so concurrent runners apply each file once.
- Migration 0001 creates docmind_app (NOLOGIN, no superuser, no BYPASSRLS) with default privileges on future tables.
- Postgres suites run only when DOCMIND_TEST_PG_URL is set (passed through Turbo env)
- each suite gets a database of its own.
- Part 1 of 3 of spec §9 PR 4.

## Not counted toward the 200-line / 10-file limit
pnpm-lock.yaml (generated).

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: `gh` prints the PR URL. The PR stays a draft: CI does not run until it is marked ready, and only the owner merges.

---

# PR 4b: `db:migrate` CLI and app-role login

**Branch:** `feat/m0-db-app-login`  **Depends on:** PR 4a merged.  **Budget:** 4 files, 65 lines.

### Task 11: `setAppRolePassword` and the CLI

**Files:**
- Modify: `apps/server/app/db/migrate.ts`
- Modify: `apps/server/app/db/testSupport.ts`
- Modify: `apps/server/app/db/migrate.test.ts`
- Modify: `apps/server/package.json` (script `db:migrate`)

**Interfaces:**
- Consumes: `migrate`, `createTestDb`, `TestDb` (PR 4a).
- Produces: `setAppRolePassword(pool: Pool, password: string): Promise<void>` (runs `ALTER ROLE docmind_app LOGIN PASSWORD ...` with the password quoted by Postgres' `format('%L')`); `APP_PASSWORD` (fixed test password, `"docmind_app_test"`); `TestDb.appUrl: string` (the same database as `docmind_app`); CLI `pnpm --filter @docmind/server db:migrate` reading `DOCMIND_MIGRATE_URL` (owner) and optional `DOCMIND_APP_DB_PASSWORD`.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m0-db-app-login
```

- [ ] **Step 2: Write the failing test and the helper changes**

Replace `apps/server/app/db/testSupport.ts` with:

```ts
import { randomBytes } from "node:crypto";
import { Pool } from "pg";

/** Set by CI and in a local .env; the Postgres suites skip cleanly without it. */
export const PG_URL = process.env.DOCMIND_TEST_PG_URL;

/** Cluster-wide and fixed, so test files agree on it. */
export const APP_PASSWORD = "docmind_app_test";

export interface TestDb {
  /** Connected as the owner named in DOCMIND_TEST_PG_URL (runs migrations, seeds data). */
  owner: Pool;
  /** The same database as `docmind_app`; call `setAppRolePassword` first. */
  appUrl: string;
  drop(): Promise<void>;
}

/** An empty database of its own, so suites never see each other's tables. */
export async function createTestDb(): Promise<TestDb> {
  if (!PG_URL) throw new Error("DOCMIND_TEST_PG_URL is not set");
  const name = `docmind_t_${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString: PG_URL, max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(PG_URL);
  url.pathname = `/${name}`;
  const owner = new Pool({ connectionString: url.toString() });
  const appUrl = new URL(url);
  appUrl.username = "docmind_app";
  appUrl.password = APP_PASSWORD;

  return {
    owner,
    appUrl: appUrl.toString(),
    async drop() {
      await owner.end();
      const dropper = new Pool({ connectionString: PG_URL, max: 1 });
      await dropper.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await dropper.end();
    },
  };
}
```

Replace `apps/server/app/db/migrate.test.ts` with:

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword } from "./migrate";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "./testSupport";

describe.skipIf(!PG_URL)("migration runner (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let dir: string;

  beforeAll(async () => {
    db = await createTestDb();
    dir = mkdtempSync(join(tmpdir(), "docmind-migrations-"));
    writeFileSync(join(dir, "0001_one.sql"), "CREATE TABLE one (id int);");
    writeFileSync(join(dir, "0002_two.sql"), "CREATE TABLE two (id int);");
    writeFileSync(join(dir, "notes.txt"), "not a migration");
  });

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db.drop();
  });

  it("applies files in name order, once, and records them", async () => {
    expect(await migrate(db.owner, dir)).toEqual(["0001_one.sql", "0002_two.sql"]);
    expect(await migrate(db.owner, dir)).toEqual([]);
    const { rows } = await db.owner.query("SELECT name FROM schema_migrations ORDER BY name");
    expect(rows.map((r) => r.name)).toEqual(["0001_one.sql", "0002_two.sql"]);
  });

  it("rolls a failing file back whole and keeps the earlier ones", async () => {
    const bad = join(dir, "0003_bad.sql");
    writeFileSync(bad, "CREATE TABLE three (id int); SELECT 1/0;");
    await expect(migrate(db.owner, dir)).rejects.toThrow(/division by zero/);
    rmSync(bad);
    const { rows } = await db.owner.query("SELECT to_regclass('three') AS t");
    expect(rows[0].t).toBeNull();
    const done = await db.owner.query("SELECT count(*)::int AS n FROM schema_migrations");
    expect(done.rows[0].n).toBe(2);
  });

  it("lets two runners started together apply each file once", async () => {
    const racy = await createTestDb();
    try {
      const runs = await Promise.all([migrate(racy.owner, dir), migrate(racy.owner, dir)]);
      expect(runs.flat().sort()).toEqual(["0001_one.sql", "0002_two.sql"]);
    } finally {
      await racy.drop();
    }
  });

  it("applies the repo's migrations, which create an unprivileged app role", async () => {
    const fresh = await createTestDb();
    try {
      expect(await migrate(fresh.owner)).toContain("0001_app_role.sql");
      const { rows } = await fresh.owner.query(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'docmind_app'",
      );
      expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    } finally {
      await fresh.drop();
    }
  });

  it("gives the app role a login that is still not privileged", async () => {
    const fresh = await createTestDb();
    try {
      await migrate(fresh.owner);
      await setAppRolePassword(fresh.owner, APP_PASSWORD);
      const app = new Pool({ connectionString: fresh.appUrl });
      const { rows } = await app.query(
        "SELECT current_user AS who, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      );
      await app.end();
      expect(rows[0]).toEqual({ who: "docmind_app", rolsuper: false, rolbypassrls: false });
    } finally {
      await fresh.drop();
    }
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @docmind/server test app/db/migrate.test.ts`
Expected: FAIL, `TypeError: setAppRolePassword is not a function` on `gives the app role a login that is still not privileged`; `Tests  1 failed | 4 passed (5)`.

- [ ] **Step 4: Write the implementation**

Replace `apps/server/app/db/migrate.ts` with:

```ts
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Pool } from "pg";

// Resolved from the source tree: this runs under tsx and vitest, never from `dist`.
export const MIGRATIONS_DIR = resolve(__dirname, "../../../../infra/migrations");

// Serializes runners: two started together apply each file once.
const LOCK_KEY = 727274;

/** Applies every `NNNN_name.sql` in `dir` not yet recorded in `schema_migrations`, in name order. */
export async function migrate(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const done = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const seen = new Set(done.rows.map((r) => r.name));
    const applied: string[] = [];
    for (const file of readdirSync(dir)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f))
      .sort()) {
      if (seen.has(file)) continue;
      try {
        await client.query("BEGIN");
        await client.query(readFileSync(join(dir, file), "utf8"));
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
      applied.push(file);
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
    client.release();
  }
}

/** Lets `docmind_app` log in. DDL cannot take parameters, so Postgres quotes the password itself. */
export async function setAppRolePassword(pool: Pool, password: string): Promise<void> {
  const { rows } = await pool.query<{ ddl: string }>(
    "SELECT format('ALTER ROLE docmind_app LOGIN PASSWORD %L', $1::text) AS ddl",
    [password],
  );
  await pool.query(rows[0]?.ddl as string);
}

async function main(): Promise<void> {
  const url = process.env.DOCMIND_MIGRATE_URL;
  if (!url) throw new Error("DOCMIND_MIGRATE_URL is not set (the owner role's connection string)");
  const pool = new Pool({ connectionString: url });
  try {
    const applied = await migrate(pool);
    console.log(applied.length > 0 ? `applied: ${applied.join(", ")}` : "schema is up to date");
    const password = process.env.DOCMIND_APP_DB_PASSWORD;
    if (password) await setAppRolePassword(pool, password);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

Replace `apps/server/package.json` with:

```json
{
  "name": "@docmind/server",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "tsx app/main.ts",
    "gen": "loom gen --dir app",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "typecheck:tests": "tsc -p tsconfig.test.json",
    "db:migrate": "tsx app/db/migrate.ts"
  },
  "dependencies": {
    "@loom/app": "*",
    "@loom/effect-runtime": "*",
    "@loom/workflow-runtime": "*",
    "pg": "^8.13.0"
  },
  "devDependencies": {
    "@loom/cli": "*",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.2",
    "vitest": "^2.1.8",
    "@types/pg": "^8.11.0"
  }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm --filter @docmind/server test app/db/migrate.test.ts`
Expected: `✓ app/db/migrate.test.ts (5 tests)` and `Tests  5 passed (5)`.

- [ ] **Step 6: Smoke-test the CLI on a scratch database**

The CLI has no unit test (it is argument glue), so run it once for real. With the compose Postgres (adjust the URLs for a local one):

```bash
psql postgres://docmind:docmind@127.0.0.1:5432/docmind -c "create database cli_probe"
cd apps/server
DOCMIND_MIGRATE_URL=postgres://docmind:docmind@127.0.0.1:5432/cli_probe DOCMIND_APP_DB_PASSWORD=probe-pw pnpm db:migrate
DOCMIND_MIGRATE_URL=postgres://docmind:docmind@127.0.0.1:5432/cli_probe pnpm db:migrate
pnpm db:migrate
psql postgres://docmind_app:probe-pw@127.0.0.1:5432/cli_probe -Atc "select current_user"
cd ../.. && psql postgres://docmind:docmind@127.0.0.1:5432/docmind -c "drop database cli_probe"
```

Expected, in order: `applied: 0001_app_role.sql`; `schema is up to date`; `Error: DOCMIND_MIGRATE_URL is not set (the owner role's connection string)`; `docmind_app`; `DROP DATABASE`.

- [ ] **Step 7: Commit**

```bash
git add apps/server/app/db apps/server/package.json
git commit -m "$(cat <<'EOF'
feat(db): add db:migrate CLI and a login for the app role

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Close out 1/3: check the size budget**

```bash
git diff --numstat main...HEAD -- . ':!pnpm-lock.yaml' ':!apps/server/app/loom.gen.ts' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
```

Expected: `65 lines, 4 files` (limit: 200 lines and 10 files). If it prints more, stop and split the PR instead of stretching it.

- [ ] **Close out 2/3: run the full PR gate**

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind  # or your local superuser URL
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0 and the last turbo summary reads `Tasks:    N successful, N total`.
The Postgres suites must have run: the `@docmind/server:test` summary shows no skipped files (`↓`) for `app/db/*`.

- [ ] **Close out 3/3: push and open the draft PR**

```bash
git push -u origin feat/m0-db-app-login
gh pr create --draft --base main --head feat/m0-db-app-login --title "feat(db): db:migrate CLI and app-role login" --body "$(cat <<'EOF'
## Summary
- pnpm --filter @docmind/server db:migrate applies migrations as the owner (DOCMIND_MIGRATE_URL) and, when DOCMIND_APP_DB_PASSWORD is set, enables a login for docmind_app. Migrations never contain a password.
- Test proves the app role logs in and is neither superuser nor BYPASSRLS.
- Part 2 of 3 of spec §9 PR 4.

## Not counted toward the 200-line / 10-file limit
None (no lockfile change).

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: `gh` prints the PR URL. The PR stays a draft: CI does not run until it is marked ready, and only the owner merges.

---

# PR 4c: tenancy tables, RLS and `withTenant`

**Branch:** `feat/m0-db-tenancy`  **Depends on:** PR 4b merged.  **Budget:** 3 files, 182 lines.

### Task 12: `0002_tenancy.sql`, `withTenant`, isolation tests

**Files:**
- Create: `infra/migrations/0002_tenancy.sql`
- Create: `apps/server/app/db/tenant.ts`
- Test: `apps/server/app/db/tenancy.test.ts`

**Interfaces:**
- Consumes: `migrate`, `setAppRolePassword` (`./migrate`); `createTestDb`, `TestDb`, `APP_PASSWORD`, `PG_URL` (`./testSupport`); role `docmind_app` and its default privileges (migration 0001).
- Produces: SQL function `app_tenant_id() RETURNS uuid`; tables `tenants(id, name, created_at)`, `users(id, tenant_id, email UNIQUE, password_hash, created_at)`, `auth_sessions(token_hash, tenant_id, user_id, expires_at)`, each with RLS enabled and policy `tenant_isolation`; `withTenant<T>(pool: Pool, tenantId: string, fn: (tx: PoolClient) => Promise<T>): Promise<T>` (rejects a non-uuid id before any query; commits on success, rolls back on throw). Every later table migration must `ENABLE ROW LEVEL SECURITY` and add the same kind of policy; the last test in this PR fails if one forgets.

- [ ] **Step 1: Create the branch**

```bash
cd /Users/such/workspace/docmind
git switch main && git pull --ff-only
git switch -c feat/m0-db-tenancy
```

- [ ] **Step 2: Write the failing isolation test**

Create `apps/server/app/db/tenancy.test.ts` (it seeds two tenants as the owner, then does everything else as `docmind_app` through a one-connection pool, so a leaked tenant setting would show on the very next query):

```ts
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword } from "./migrate";
import { withTenant } from "./tenant";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "./testSupport";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const USER_B = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";

describe.skipIf(!PG_URL)("tenant isolation (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await db.owner.query(`
      INSERT INTO tenants (id, name) VALUES ('${A}', 'A'), ('${B}', 'B');
      INSERT INTO users (id, tenant_id, email, password_hash) VALUES
        ('${USER_A}', '${A}', 'a@example.com', 'x'), ('${USER_B}', '${B}', 'b@example.com', 'x');
      INSERT INTO auth_sessions (token_hash, tenant_id, user_id, expires_at) VALUES
        ('hash-a', '${A}', '${USER_A}', now() + interval '1 day'),
        ('hash-b', '${B}', '${USER_B}', now() + interval '1 day');
    `);
    // One connection, so a leaked tenant setting would show up on the very next query.
    app = new Pool({ connectionString: db.appUrl, max: 1 });
  });

  afterAll(async () => {
    await app?.end();
    await db?.drop();
  });

  it("shows tenant A only its own rows, in every table", async () => {
    await withTenant(app, A, async (tx) => {
      for (const table of ["tenants", "users", "auth_sessions"]) {
        const { rowCount } = await tx.query(`SELECT * FROM ${table}`);
        expect(rowCount, table).toBe(1);
      }
    });
  });

  it("returns nothing for tenant B's rows even when raw SQL names them", async () => {
    await withTenant(app, A, async (tx) => {
      const byTenant = await tx.query("SELECT * FROM users WHERE tenant_id = $1", [B]);
      const byId = await tx.query("SELECT * FROM users WHERE id = $1", [USER_B]);
      const viaJoin = await tx.query(
        "SELECT s.* FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE u.id = $1",
        [USER_B],
      );
      expect([byTenant.rowCount, byId.rowCount, viaJoin.rowCount]).toEqual([0, 0, 0]);
    });
  });

  it("cannot update or delete another tenant's rows", async () => {
    await withTenant(app, A, async (tx) => {
      const upd = await tx.query("UPDATE users SET email = 'owned@evil.test' WHERE true");
      const del = await tx.query("DELETE FROM auth_sessions WHERE true");
      expect([upd.rowCount, del.rowCount]).toEqual([1, 1]);
    });
    const users = await db.owner.query("SELECT email FROM users WHERE tenant_id = $1", [B]);
    const sessions = await db.owner.query("SELECT 1 FROM auth_sessions WHERE tenant_id = $1", [B]);
    expect([users.rows[0].email, sessions.rowCount]).toEqual(["b@example.com", 1]);
  });

  it("refuses to insert a row for another tenant", async () => {
    const insert =
      "INSERT INTO users (id, tenant_id, email, password_hash) VALUES ($1, $2, $3, 'x')";
    await expect(
      withTenant(app, A, (tx) => tx.query(insert, [crypto.randomUUID(), B, "c@example.com"])),
    ).rejects.toThrow(/row-level security/);
  });

  it("sees nothing without a tenant, even on a connection that just served one", async () => {
    await withTenant(app, A, async () => undefined);
    const { rows } = await app.query("SELECT count(*)::int AS n FROM users");
    expect(rows[0].n).toBe(0);
  });

  it("rolls back when the callback throws", async () => {
    await expect(
      withTenant(app, A, async (tx) => {
        await tx.query("DELETE FROM users");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const { rowCount } = await db.owner.query("SELECT 1 FROM users WHERE tenant_id = $1", [A]);
    expect(rowCount).toBe(1);
  });

  it("rejects a tenant id that is not a uuid before touching the database", async () => {
    await expect(withTenant(app, "a'; DROP TABLE users;--", async () => 1)).rejects.toThrow(/uuid/);
  });

  it("connects as a role that cannot switch row-level security off", async () => {
    const off = "ALTER TABLE users DISABLE ROW LEVEL SECURITY";
    await expect(app.query(off)).rejects.toThrow(/must be owner/);
    await expect(app.query("DROP POLICY tenant_isolation ON users")).rejects.toThrow(
      /must be owner/,
    );
  });

  it("has row-level security on every table, including ones later PRs add", async () => {
    const { rows } = await db.owner.query<{ relname: string }>(
      `SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
         AND relname <> 'schema_migrations'`,
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails (twice, for two different reasons)**

Run: `pnpm --filter @docmind/server test app/db/tenancy.test.ts`
Expected: FAIL, `Error: Failed to load url ./tenant ... Does the file exist?`.

Create `apps/server/app/db/tenant.ts`:

```ts
import type { Pool, PoolClient } from "pg";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` in one transaction whose row-level-security context is `tenantId`. The setting is
 * transaction-local, so a pooled connection never carries a tenant into its next use. The caller
 * must take `tenantId` from the Authenticator, never from the request.
 */
export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  if (!UUID.test(tenantId)) throw new Error("withTenant: tenantId must be a uuid");
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    await tx.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(tx);
    await tx.query("COMMIT");
    return result;
  } catch (err) {
    await tx.query("ROLLBACK");
    throw err;
  } finally {
    tx.release();
  }
}
```

Run the same command again.
Expected: FAIL, `error: relation "tenants" does not exist` in `beforeAll`, and `Tests  9 skipped (9)`.

- [ ] **Step 4: Write the migration**

Create `infra/migrations/0002_tenancy.sql`:

```sql
-- Tenancy core. Every table carries tenant_id; row-level security keeps each request to its own
-- tenant. The server sets `app.tenant_id` per transaction (apps/server/app/db/tenant.ts).

-- The tenant of the current transaction. NULL when unset or empty (an ended SET LOCAL leaves ''),
-- so a query with no tenant context matches no rows instead of failing or leaking.
CREATE FUNCTION app_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE TABLE tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_sessions (
  token_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

-- Not FORCEd: the owner (migrations, the SECURITY DEFINER lookups login will need) bypasses RLS,
-- while docmind_app owns nothing and is bound by it.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenants USING (id = app_tenant_id());
CREATE POLICY tenant_isolation ON users USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON auth_sessions USING (tenant_id = app_tenant_id());
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm --filter @docmind/server test app/db/tenancy.test.ts`
Expected: `✓ app/db/tenancy.test.ts (9 tests)` and `Tests  9 passed (9)`.

- [ ] **Step 6: Prove the tests bite (mutation check, do not commit)**

Temporarily disable RLS and confirm the suite notices:

```bash
sed -i.bak '/ENABLE ROW LEVEL SECURITY/d' infra/migrations/0002_tenancy.sql
pnpm --filter @docmind/server test app/db/tenancy.test.ts
mv infra/migrations/0002_tenancy.sql.bak infra/migrations/0002_tenancy.sql
git diff --stat infra/migrations/0002_tenancy.sql
```

Expected: the test run shows `Tests  6 failed | 3 passed (9)` (including `shows tenant A only its own rows` and `has row-level security on every table`); after the restore, `git diff --stat` prints nothing.

- [ ] **Step 7: Commit**

```bash
git add infra/migrations/0002_tenancy.sql apps/server/app/db/tenant.ts apps/server/app/db/tenancy.test.ts
git commit -m "$(cat <<'EOF'
feat(db): add tenants, users and auth_sessions with RLS and withTenant

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Close out 1/3: check the size budget**

```bash
git diff --numstat main...HEAD -- . ':!pnpm-lock.yaml' ':!apps/server/app/loom.gen.ts' | awk '{a+=$1+$2; n++} END {print a" lines, "n" files"}'
```

Expected: `182 lines, 3 files` (limit: 200 lines and 10 files). If it prints more, stop and split the PR instead of stretching it.

- [ ] **Close out 2/3: run the full PR gate**

```bash
export DOCMIND_TEST_PG_URL=postgres://docmind:docmind@127.0.0.1:5432/docmind  # or your local superuser URL
pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test
```

Expected: every command exits 0 and the last turbo summary reads `Tasks:    N successful, N total`.
The Postgres suites must have run: the `@docmind/server:test` summary shows no skipped files (`↓`) for `app/db/*`.

- [ ] **Close out 3/3: push and open the draft PR**

```bash
git push -u origin feat/m0-db-tenancy
gh pr create --draft --base main --head feat/m0-db-tenancy --title "feat(db): tenancy tables, RLS and withTenant" --body "$(cat <<'EOF'
## Summary
- Migration 0002: tenants, users, auth_sessions (each with tenant_id), RLS enabled with a tenant_isolation policy per table, and app_tenant_id() (unset or empty tenant matches no rows).
- withTenant(pool, tenantId, fn): one transaction, tenant set with set_config(..., true), commit/rollback, uuid-validated.
- Isolation test runs as the non-owner docmind_app role: tenant A cannot read, update, delete or insert for tenant B even with raw SQL
- no tenant means zero rows
- the role cannot disable RLS
- a guard fails if any table lacks RLS.
- auth_sessions gains tenant_id (spec §4.2 says every table carries it). RLS is enabled, not forced, so M1's SECURITY DEFINER login/session lookups can work
- see the plan's deviation 5.
- Part 3 of 3 of spec §9 PR 4.

## Not counted toward the 200-line / 10-file limit
None (no lockfile change).

## Test plan
- [x] `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: `gh` prints the PR URL. The PR stays a draft: CI does not run until it is marked ready, and only the owner merges.

---

## After PR 4c: M0 exit check

- [ ] On a fresh clone of `main` (with `../loom` built and Postgres up): `pnpm install --frozen-lockfile && pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`. Expected: all green; `pnpm --filter @docmind/server start` answers `GET /healthz` with `{"status":"ok"}`; `pnpm --filter @docmind/server db:migrate` reports `schema is up to date`.
- [ ] The first push to `main` triggers the `ci` workflow (push path); confirm it is green, which also proves `LOOM_TOKEN` and the pgvector service.

## Self-review

**Spec coverage (§9 M0):**

| Spec item | Where |
|---|---|
| PR 1: workspace, Turborepo, Biome, tsconfig, create-loom-app server, `/healthz` + test | PR 1a (Task 1), PR 1b (Tasks 2-4) |
| PR 2: CI skipping drafts, docker-compose (Postgres+pgvector, Ollama), `.env.example` | PR 2 (Tasks 5-6) |
| PR 3: zod schemas for auth, documents, chats (§5.1, §6.1, sign-up/login/me) | PR 3a, 3b, 3c |
| PR 4: migration runner, tenants/users/auth_sessions, RLS, `withTenant`, isolation test as non-owner role incl. raw SQL | PR 4a, 4b, 4c |
| §8 gates, CI triggers and draft gate, test hygiene, PR rules | Global Constraints; PR 2; every close-out block |
| §4.3 non-owner role, `SET LOCAL` via `withTenant` | PR 4a (role), PR 4c (policies, `withTenant`, tests) |

Not in M0 by design: `documents`/`chunks`/`chat_sessions`/`data_keys` tables (their milestones), the `Authenticator` (M1), any argon2/session code.

**Placeholder scan:** no TBD/TODO; every code step carries the full file contents taken from branches that were built and run (lint, build, typecheck, typecheck:tests, test all green on each, including with a real Postgres and under pnpm 9.14.4).

**Type consistency:** `migrate(pool, dir?)` and `MIGRATIONS_DIR` (4a) are what 4b/4c call; `setAppRolePassword`, `APP_PASSWORD`, `TestDb.appUrl` are introduced in 4b and used in 4c; `withTenant(pool, tenantId, fn)` is defined and used with that signature only in 4c; contracts exports accumulate in `index.ts` exactly as each PR's Interfaces block lists.
