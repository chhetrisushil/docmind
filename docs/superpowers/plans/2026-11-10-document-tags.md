# Document Tags Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user group documents with per-user tags (added by hand, or suggested by the model at ingest and on demand), and filter the document library by one or more tags with an Any or All match.

**Architecture:** Three additive tables (`tags`, `document_tags`, `document_tag_suggestions`, migration 0036) with sealed names and a keyed lookup hash derived from the owner's data key (the `EntityKeys` pattern). One `TagService` owns every read and write. The ingest `summarize` step lists the owner's tags in the reduce prompt, parses a lenient `suggestedTags`, and stores normalised suggestions before the summary. A small `suggest-tags` Loom flow (one step, per-document `rerunTracker` lock) does the same from the stored summary on demand. The listing filter is SQL before the cursor cut, with a filter fingerprint in the cursor. The web library page gains a tag bar that drives the `library` view's `documents` provider through hydration parameters; the detail page gains a Tags row and a Suggested line.

**Tech Stack:** TypeScript, zod, Postgres (RLS, `withTenant`, composite foreign keys), Loom (`flow$`, `step$`, tool effects, `rerunTracker`), Lit, vitest, pnpm/turbo, biome.

**Spec:** `docs/specs/2026-11-10-document-tags-design.md` (binding; read it first). Background for the library and detail pages: `docs/specs/2026-11-08-document-visuals-design.md`.

## Global Constraints

Every task's requirements include these (values copied from the spec):

- Tags are per user, are named by the user, and have no hierarchy and no colours. (T1)
- Tag names are sealed under the owner's key, like document titles. Uniqueness is enforced on a keyed lookup hash of the normalised name (the `entityNameBind` pattern), so the database never compares plaintext. (T2)
- **Suggestions, approach A.** The ingest summary call also returns `suggestedTags`. The user's existing tag names are listed in its prompt, so it prefers them. Existing documents get an on-demand "Suggest tags" call that reads only the document's stored summary. (T3)
- Suggestions are never applied automatically. The user accepts or dismisses each one. (T4)
- The listing filter works by tag id, with `match=any` (the default) or `match=all`. It is applied in SQL before the existing cursor page cut. (T5)
- One additive migration (the next free number; 0036 if #495 lands first). No existing rows change. (T6)
- `tags`: columns `id uuid PK`, `tenant_id`, `owner_id`, `name_enc jsonb` (sealed), `name_bind bytea`, `created_at`; `UNIQUE (owner_id, name_bind)`.
- Normalisation, for the lookup hash only: NFKC, trim, collapse inner whitespace to one space, then case-fold. The display name is kept as typed, trimmed. It is 1–40 characters, with no control characters.
- `document_tags`: columns `document_id` (FK `ON DELETE CASCADE`), `tag_id` (FK `ON DELETE CASCADE`), `tenant_id`, `owner_id`, `created_at`; PK `(document_id, tag_id)`, plus an index on `(owner_id, tag_id, document_id)`. A CHECK or trigger guarantees the document and the tag share the owner.
- `document_tag_suggestions`: columns `document_id PK` (FK `ON DELETE CASCADE`), `tenant_id`, `owner_id`, `names_enc jsonb` (sealed list of up to 5 names), `updated_at`. Each ingest or "Suggest tags" run replaces the row. Accept or dismiss removes the name from it.
- Owner-scoped row-level security on each table, with the same policies as `documents`.
- Erasing a user deletes their rows. The names are sealed under the user's key, so crypto-shredding also covers them.
- Limits: 20 tags per document, 200 tags per user, 10 tags per filter.
- Adding a name whose normalised form already exists reuses that tag.
- A tag with no documents remains until the user deletes it.
- Renaming a tag to a normalised name that belongs to another of the user's tags answers 409.
- The summary step loads the owner's tag names: it reads them, decrypts them in memory and caps the list at 200, ordered by use count, then by name.
- It adds one line to the prompt of the call that produces the final summary. This covers both the single-pass path and the reduce step. The line lists the existing tags. It asks for `suggestedTags`: up to 5 names, reusing an existing name wherever one fits, and at most 3 new names.
- `ReduceAnswer` gains an optional `suggestedTags` field. It is parsed leniently: a missing or malformed field becomes `[]`, and never fails the summary.
- The shared function `normaliseSuggestions(raw, existingTags)` clips each name to 40 characters and drops empty or control-character names; maps a name onto an existing tag when the normalised forms are equal, keeping the existing display name; dedupes; caps at 5, with at most 3 new names; drops names already linked to the document.
- The result is written to `document_tag_suggestions`. `DocumentSummary` (in contracts) is unchanged, because suggestions do not live in the summary.
- On demand: a small Loom flow, `suggest-tags`, keyed per document with a per-key lock (the `rerunTracker` pattern). It reads the stored summary (tldr, topics, keyPoints) and the tag names. It makes one model call with the same answer schema and normalisation, writes the suggestions row, and emits a document event so the detail page updates. It never reads passages. If the document has no stored summary, the button is disabled with the reason given.
- The summary step's prompt and inputs change, but its step list does not. The plan verifies whether Loom's flow hash changes. If it does, ingest moves to the next version and keeps the old version registered for runs in flight. That is the visualize-document treatment, and needs a rollback note in `cloud-deploy.md`.
- A suggestion problem never fails ingest. The summary is stored as today, and suggestions are empty. An on-demand failure shows "Couldn't suggest tags" with Retry. A key-store outage fails the step, as elsewhere.
- All routes are owner-scoped, need the session and CSRF as existing routes do, and validate their bodies with zod.
- Routes: `GET /api/tags` returns `{tags: [{id, name, documents}]}`, sorted by name (locale-aware). `POST /api/tags {name}` creates, or returns the existing tag with the same normalised name (200 vs 201). `PATCH /api/tags/:id {name}` renames; 409 `tag_exists` on collision. `DELETE /api/tags/:id` deletes the tag and its links. `PUT /api/documents/:id/tags {tagIds}` sets a document's tags (≤ 20; foreign or unknown ids answer 400). `POST /api/documents/:id/tags {name}` adds one tag by name, creating it if needed. `DELETE /api/documents/:id/tags/:tagId` removes one tag. `POST /api/documents/:id/tag-suggestions/accept {name}` creates or reuses the tag, links it, removes it from suggestions. `POST /api/documents/:id/tag-suggestions/dismiss {name}` removes it from suggestions. `POST /api/documents/:id/tag-suggestions/refresh` starts `suggest-tags`; 202.
- `GET /api/documents` rows gain `tags: [{id, name}]`. The document detail gains `tags` and `suggestedTags: string[]`.
- Listing filter syntax: `GET /api/documents?tags=<id>,<id>&match=any|all`. `any` gives `EXISTS (SELECT 1 FROM document_tags dt WHERE dt.document_id = d.id AND dt.owner_id = $owner AND dt.tag_id = ANY($ids))`. `all` gives `(SELECT count(*) FROM document_tags dt WHERE … AND dt.tag_id = ANY($ids)) = cardinality($ids)`.
- Ordering and the cursor are unchanged, and the filter is part of the cursor's validity: a cursor used with a different filter answers 400. The query carries explicit owner and tenant predicates. With zero tags, the listing is unfiltered and `match` is ignored.
- Web, documents page: a tag bar above the list: one toggle chip per tag, with its count and `aria-pressed`; an **Any / All** two-option radio group, enabled when 2 or more tags are selected; **Clear**. The selection and mode live in the URL (`?tags=…&match=all`), so back, forward and bookmarks work. Any is the default and is omitted from the URL. Each row shows its tags as small chips. Clicking one filters by that tag alone. An empty filtered list shows "No documents match these tags" with Clear. The result count is announced politely. A **Manage tags** panel offers rename (inline) and delete (with confirmation naming how many documents use the tag).
- Web, document detail: a Tags row: chips with ×, and an input with autocomplete from the user's tags. Enter adds the typed name, creating the tag if needed. A Suggested line: chips with ✓ (accept) and × (dismiss), plus a **Suggest tags** button showing a busy state while the flow runs.
- Privacy: tag names and suggestions are sealed per user. They never appear in logs, the event log, lineage or error messages. The user's tag names are sent to their configured model provider inside the summary and suggestion prompts. This is the same trust boundary as the document text already sent.
- Cost: no extra call at ingest; one small call per "Suggest tags" press, whose input is the summary, not the document.
- Out of scope: tag colours, nesting and sharing; tags on chats; filtering chat retrieval by tag ("ask only within tag X"); automatic tagging without review; a bulk-tag action on several selected documents.
- Verification commands (run from the worktree root `/Users/such/workspace/docmind/.worktrees/document-tags`): `pnpm typecheck`, `pnpm typecheck:tests`, `pnpm lint`, and the suites named in each task. The worktree has no `node_modules` yet: run `pnpm install` once first (the sibling `.worktrees/loom` and `.worktrees/loom-ui` links make the `link:../loom` overrides resolve). Postgres suites need `set -a; . ./.env; set +a` first (it sets `DOCMIND_TEST_PG_URL`, the separate test cluster); **a skipped pg test is not a pass**: check the vitest summary shows the pg tests ran. Run one file with `pnpm --filter @docmind/server exec vitest run <path>` (web: `--filter @docmind/web`, contracts: `--filter @docmind/contracts`). Task 1 Step 0 makes the server and web test runs read `@docmind/contracts` and `@docmind/experiences` from `src`, so these single-suite runs never read a stale `dist`; `pnpm typecheck` and `pnpm typecheck:tests` go through turbo, which builds the dependencies first. **Lint:** every code block in this plan was run through Biome 1.9.4 with the repo's `biome.json` (format, organizeImports, recommended rules, so no non-null assertions); each task ends with `pnpm lint`, which must pass. If it flags formatting or import order in code you pasted, run `pnpm lint:fix`, re-run the task's tests and commit the result.
- Erasure: a user's on-demand `suggest-tags` starts are settled and cancelled by the erasure pipeline like the ingest, visualize and title starts (Task 5 Step 9a). The user's tag names and suggestions must be absent from every table after erasure (the erasure end-to-end scan, Task 8 Step 2a).
- Library table: each row shows its tags as clickable chips, a loom-ui token cell (`{ tokens: [{ id, label }] }`, loom-ui pin `fc34435285e3411b720107f06990d5f0d76a67c2`); clicking a chip filters the list to that tag alone (Task 6). There is no text-column fallback.

## Plan decisions (where the spec is silent, or the code constrains it)

Each was verified against the code at `main` 54e358d, the Loom pin 4af27eaa and the loom-ui pin fc34435 (token cells).

**D1. Flow hash: ingest-document does NOT need a bump.** `flowContentHash` (`/Users/such/workspace/loom/packages/core/src/flowHash.ts`) is SHA-256 over `flow id`, `version`, `deadlineMs`, and per step `id | toolId | timeoutMs | retry`. It excludes zod schemas, handler code and prompts, and DocMind sets no `codeFingerprint` (grep: none). The summary step's prompt and its inputs live inside the effect (its step input is still the ids-only `IngestStartInput`), so the hash cannot move. Contrast `visualize-document` 1.0.0 to 1.1.0: that change added a step (`visualize-structure`), which changes the step list and so the hash (measured on `main`: 1.0.0 `sha256:d8491324…`, 1.1.0 `sha256:d3bfb104…`). The ingest hash on `main` is `sha256:e9c2819cd68e5b3d2bae57d5ef9e7d55af3067a99db66e225b00f0adfa864dc4` (version 3.0.0). Task 4 pins that literal in a test, so a later edit that does change the graph fails loudly. Consequences: ingest stays 3.0.0, no `legacy` definition, no resume test. An execution in flight at deploy resumes on the new summarize code; its `summarize` step either already completed (its result is in the log and is not re-run) or runs once with the new code. The rollback note in `cloud-deploy.md` (Task 8) says rolling back is safe for ingest, and that the new `suggest-tags` 1.0.0 flow is not recovery-owned.

**D2. Binds and keys.** `entityNameBind` in `pgEntities.ts` is only the seal bind (`entity:<id>:name`). The lookup key is `EntityKeys.nameKey` (`crypto/entityKeys.ts`): HMAC-SHA256 over the normalised name under `hkdf(sha256, dek, "", "docmind-entity-v1", 32)`, `dek` being the owner's data key. `TagKeys` mirrors it with info `docmind-tag-v1` (a domain-separated derivation from the same data key: no new stored key material). The tag key differs from the entity key for the same name. It uses `keys.getOrCreate` (like `FieldCrypto.seal`), because a user can create a tag before uploading anything. Seal binds: `tag:<id>:name` and `document:<id>:tag-suggestions`. `name_bind` is `bytea` (the raw 32 bytes), as the spec says.

**D3. Row-level security.** `documents` and every visuals table carry exactly one policy, `tenant_isolation USING (tenant_id = app_tenant_id())`; the app role sets only the tenant (`withTenant`), so there is no per-owner RLS setting. The three new tables carry the same policy (the tenancy suite in `db/tenancy.test.ts` already fails any table without RLS), and every query names the owner and the tenant explicitly, as the document code does. Grants come from the default privileges of migration 0001, as for 0026 and 0030.

**D4. Same-owner guarantee is declarative.** Migration 0036 adds `UNIQUE (tenant_id, owner_id, id)` to `documents` and to `tags`, and `document_tags` references both through `(tenant_id, owner_id, <id>)`, so a link whose document and tag have different owners cannot exist (no trigger). `document_tag_suggestions` references `documents (tenant_id, owner_id, id)`. The extra unique constraint on `documents` is additive: no row changes.

**D5. There is no separate single-pass summary path.** `summarizeDocument` always maps each group and then reduces, even for one group (`summarize.ts`). The reduce call is the only call that produces the final summary, so the one prompt line goes into it and covers every document.

**D6. Ordering and failure policy in the summarize step.** The suggestions are written before `putSummary` (the summary stays last: its presence means "done", D2 of ingest). A problem reading the tag context or writing suggestions is logged by class and ignored, except a key-store error, a document-gone condition and an abort, which end the step exactly as elsewhere (`isDocumentGone`, `isAbort`, `FieldKeyStoreError`). A missing or malformed `suggestedTags` is `[]`.

**D7. Listing.** `listDocuments` gains a filter and a required tenant (every listing names the owner and the tenant). `any` is the spec's correlated `EXISTS`. `all` is `documents.id IN (SELECT dt.document_id … GROUP BY dt.document_id HAVING count(*) = cardinality($ids))`, which is the spec's count form made set-based so the planner can start from the tag index (the correlated form walks the library in date order when a tag is rare); a result-equality test against a brute-force read of the links guards its answers, and an EXPLAIN test (Task 3) checks that the selective case starts from the tag index. A filter of exactly one tag is `any` whatever `match` says. The cursor carries `f`, 16 hex characters of SHA-256 over `<match>|<sorted ids>`, absent when there is no filter; a cursor whose `f` differs from the request's answers 400 `invalid_cursor`. A foreign or unknown tag id in the filter simply matches nothing (no existence oracle).

**D8. The library page is a hydrated view, not `GET /api/documents`.** The web draws the table through the `library` experience (`packages/experiences/src/views.ts`): the `documents` provider (`documents.list`) is served by `UiReaders.documents`. So the web filter reaches the server as hydration parameters `tags` (comma-separated ids) and `match` on that provider's `overridable` list (the counts providers stay unfiltered). Raw output of `documents.list` and `document.get` now carries `tags`, so both pins go to `@2` (`PINS` in `providers.ts`). the Tags column of the table is a loom-ui **token cell**, `{ tokens: [{ id, label }] }` (one token per tag: the tag id is a valid token id, and 20 tags per document equals the cell cap of 20). The table's `TABLE_TOKEN` action carries `{ rowKey, tokenId }` (the table has `rowKeys`), and the page answers it by filtering the list to that tag alone, which writes the address (spec §6, "click a chip in a row"). The token cell is in loom-ui from `fc34435` (the pin; PR #131); Task 6 opens with a gate that checks the linked loom-ui has it and stops if not (there is no text-column fallback).

**D9. `suggest-tags` runs.** Execution id `u_<user>:suggest-tags-<document>-r<n>`; `n` comes from `rerunTracker.probe` (a restart resets the in-process counter, `probe` skips ids Loom already holds; after 999 presses for one document the route answers 409 `suggest_running`, an accepted limit). Not added to `recoveryOwns`: an interrupted run is simply pressed again (the page's busy state ends after 60 s, as for visuals). Its step output is `{outcome}` only; its start input is ids only; no `sensitive.ts` entry is needed. A document or user deleted mid-run is safe: the write is `INSERT … SELECT FROM documents WHERE id AND owner_id AND tenant_id` (no row means gone) and the sealing key of an erased user is unavailable.

**D10. Document events.** `DocumentProgressEvent` gains `tags: "suggested" | "failed"`, valid only on a `ready`/`finalize` event (the same refinement as `visuals`).

**D11. `DocumentDto`.** `tags` is required (`[]` when none); `suggestedTags` is optional and filled only by the detail read. Fixtures flagged by `pnpm typecheck:tests` get `tags: []`. `toDto` takes the tags as a required fourth argument so no call site can forget them.

---

## Amendments (preflight)

This plan was amended after the pre-flight scan (`preflight.md`, F1 to F16) and the rulings recorded with it. Each finding maps to the task and step that now carries the fix.

| Finding | Ruling | Where |
|---|---|---|
| F1 token-cell ruling absent | Row chips are a loom-ui token cell (pin `fc34435`, PR #131); Task 6 opens with a gate and has no text-column fallback; the page answers `TABLE_TOKEN`; a web test clicks a chip | D8, Global Constraints, Task 6 Step 0, Step 1 (reshaper), Step 7 Part B (`onTagChip`, tests); Task 8 docs; self-review |
| F2 tests read stale `dist` | vitest and vite aliases for `@docmind/contracts` and `@docmind/experiences` to `src`; build and typecheck checked by reading the configs | Task 1 Step 0, Verification paragraph |
| F3 EXPLAIN test flaky and non-discriminating | Deterministic seed and `ANALYZE`, like `ui/connections.pg.test.ts`; plan asserted for the selective case only, with the index name; no timing; plus an equality test against a brute-force read | Task 3 Step 3 (`tags.explain.pg.test.ts`), D7 |
| F4 lint | Every complete-file block run through Biome (format, organizeImports, recommended rules); non-null assertions and unused template literals replaced; each task ends with `pnpm lint` | Verification paragraph; Tasks 2, 7 (`tagOf`, `act(api, id)`), Task 3 (explain test); all blocks |
| F5 fake server split | The fake server's tag routes move to Task 6 Step 7 Part A; the `replaceState` instruction becomes a `url` parameter of `setup` | Task 6 Step 7; Task 7 Step 1 |
| F6 assertions that cannot fail | Ids with hex letters (contracts test, hydrate test); no-op `replace` removed; the step's privacy test makes the store fail with a message holding the tag and checks output, event and log | Task 1 Step 1, Task 6 Step 1, Task 5 Step 3 |
| F7 duplication | One `defaultSleep` (exported from `chat-title/step.ts`) and one `authed` wrapper (`tags/routes.ts`); shared server helpers `callApi`, `errorCode`, `seedNext`; shared web helpers in `testing/tags.ts` | Task 5 Steps 4 and 8, Task 3 Steps 3 and 5, Task 6 Step 5, Tasks 7 and 8 tests |
| F8 suggest-tags starts at erasure | The starter gains `settle` and `cancel`; `erasure/wire.ts` settles, awaits and cancels them like the other starts; unit tests for both | Task 5 Steps 5 and 9a, Global Constraints |
| F9 callers outside the file lists | `repo.pg.test.ts` (`toDto`) and `ui.pg.test.ts` (`readersFor` deps, then the `documents` arguments) are listed and updated in the task that changes the signature | Task 3 Files and Step 6, Task 6 Files and Step 2 |
| F10 Files line | `answering`, `idOf`, `notFound`, `authed` are exported from the start in Task 3; Task 5 no longer edits `routes.ts` | Task 3 Files and Step 5, Task 5 Files |
| F11 SQL predicates | `tenantId` is required in `ListPage` and the query; `pgDocumentReads` passes it; `readSuggestions` names owner and tenant in the join; `putSuggestions` explains its conflict target | Task 3 Steps 4 and 6, Task 2 (`service.ts`) |
| F12 empty `aria-describedby` | `ifDefined` | Task 7 Step 2 |
| F13 e2e order dependence | `vi` imported at the top; `beforeEach` resets the model answers and deletes the tags | Task 8 Step 2 |
| F14 unused import | `randomUUID` removed from `suggestRoutes.pg.test.ts` | Task 5 Step 8 |
| F15 hash test brittleness | No change (intentional) | Task 4 |
| F16 erasure needles | `seedUser` seeds a tag and a suggestion carrying sentinels; `assertErased` scans for them and counts the rows | Task 8 Step 2a |

---

## Task 1: Names, keys and the suggestion normaliser (pure)

**Files:**
- Modify: `apps/server/vitest.config.ts`, `apps/web/vite.config.ts` (tests read `@docmind/contracts` and `@docmind/experiences` from `src`)
- Create: `packages/contracts/src/tags.ts`, `packages/contracts/src/tags.test.ts`
- Modify: `packages/contracts/src/index.ts` (add `export * from "./tags";`)
- Create: `apps/server/app/crypto/tagKeys.ts`, `apps/server/app/crypto/tagKeys.test.ts`
- Create: `apps/server/app/tags/suggestions.ts`, `apps/server/app/tags/suggestions.test.ts`

**Interfaces:**
- Consumes: `Uuid` from `packages/contracts/src/common.ts`; `FieldKeyStoreError`, `FieldKeyUnavailableError` from `apps/server/app/crypto/fields.ts`; `KeyStore` from `@loom/plugin-crypto`.
- Produces (contracts, used by every later task):
  - limits: `MAX_TAG_NAME_CHARS = 40`, `MAX_TAGS_PER_DOCUMENT = 20`, `MAX_TAGS_PER_USER = 200`, `MAX_TAGS_PER_FILTER = 10`, `MAX_TAG_SUGGESTIONS = 5`, `MAX_NEW_TAG_SUGGESTIONS = 3`
  - `cleanTagName(raw: string): string | null`, `normaliseTagName(raw: string): string | null`
  - zod: `TagName`, `DocumentTag` (`{id, name}`), `TagSummary` (`{id, name, documents}`), `ListTagsResponse`, `TagNameRequest` (`{name}`), `TagResponse` (`{tag}`), `SetDocumentTagsRequest` (`{tagIds}`), `DocumentTagsResponse` (`{tags, suggestedTags}`), `SuggestTagsResponse` (`{started: true}`), `TagIdList` (comma list to `string[]`), `TagMatch` (`"any" | "all"`)
- Produces (server):
  - `class TagKeys { constructor(keys: KeyStore); forUser(userId: string): { nameBind(name: string): Promise<Buffer | null> } }`
  - `interface ExistingTag { id: string; name: string; linked: boolean }`
  - `parseSuggestedTags(value: unknown): string[]`
  - `normaliseSuggestions(raw: unknown, existingTags: readonly ExistingTag[]): string[]`
  - `tagInstruction(existing: readonly string[]): string`

- [ ] **Step 0: Tests read `src`, not a stale `dist` (preflight F2)**

`@docmind/contracts` and `@docmind/experiences` have `main: ./dist/index.js`, and `pnpm --filter … exec vitest` does not go through turbo's `^build`. Today `apps/server/vitest.config.ts` has no alias for either package and `apps/web/vite.config.ts` aliases only contracts, so any test that imports a package whose `src` this plan edits would run against old `dist` code. Alias both to `src`, as the web config already does for contracts.

In `apps/server/vitest.config.ts`, add two entries to the `resolve.alias` array (after the `@docmind/vector-pg` one):

```ts
      {
        find: /^@docmind\/contracts$/,
        replacement: resolve(__dirname, "../../packages/contracts/src/index.ts"),
      },
      {
        find: /^@docmind\/experiences$/,
        replacement: resolve(__dirname, "../../packages/experiences/src/index.ts"),
      },
```

and extend the comment above the array with `// @docmind/contracts and @docmind/experiences load from source too, so a suite never reads a stale dist.` In `apps/web/vite.config.ts`, replace the `contracts` constant's comment and alias with:

```ts
// @docmind/contracts and @docmind/experiences are CommonJS builds; tests take their TypeScript source instead.
const contracts = fileURLToPath(new URL("../../packages/contracts/src/index.ts", import.meta.url));
const experiences = fileURLToPath(
  new URL("../../packages/experiences/src/index.ts", import.meta.url),
);
```

and `alias: { "@docmind/contracts": contracts, "@docmind/experiences": experiences },`.

Why the build and typecheck are unaffected (checked by reading the configs): `apps/server/tsconfig.json` (what `pnpm --filter @docmind/server build` runs, `tsc -p tsconfig.json`) includes only `app/**/*`, `scripts/**/*` and `loom.config.ts`, so `vitest.config.ts` is not compiled by the build; it is in `tsconfig.test.json` (`typecheck:tests`), where the new entries use the same `resolve(__dirname, …)` form as the existing ones. `tsc` resolves the packages through their `types`, not through Vite aliases. In the web app, only tests and `src/testing/*` import `@docmind/experiences` (`grep -rln "@docmind/experiences" apps/web/src`), none of which `vite build` bundles, so the production bundle is unchanged; `tsc -p tsconfig.json --noEmit` ignores the Vite alias, and `vite.config.ts` stays inside the existing `include`. Both aliases were exercised before this plan was amended: a server run of `app/ui/routes.test.ts` and `app/ui/visuals.e2e.test.ts`, and a web run of `guards.test.ts`, `dm-doc-detail.test.ts` and `ui/elements.test.ts`, all passed with the experiences alias in place. If a later change makes the alias break a build, the fallback is a pre-test step: `pnpm --filter @docmind/contracts build && pnpm --filter @docmind/experiences build` before each single-suite run.

Run: `pnpm --filter @docmind/server exec vitest run app/ui/routes.test.ts && pnpm --filter @docmind/web exec vitest run src/ui/elements.test.ts && pnpm typecheck:tests`
Expected: PASS (nothing else changed yet).

- [ ] **Step 1: Write the failing contract tests**

Create `packages/contracts/src/tags.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ListTagsResponse,
  SetDocumentTagsRequest,
  TagIdList,
  TagName,
  TagNameRequest,
  cleanTagName,
  normaliseTagName,
} from "./tags";

// Ids with hex letters (a00000000001), so the case tests below can fail: an upper-cased digit-only id is unchanged.
const id = (n: number) => `00000000-0000-4000-8000-${(0xa00000000000 + n).toString(16)}`;

describe("cleanTagName", () => {
  it("trims, keeps inner spacing and case, and counts characters not code units", () => {
    expect(cleanTagName("  Q3 report ")).toBe("Q3 report");
    expect(cleanTagName("a   b")).toBe("a   b");
    expect(cleanTagName("\u{1F600}".repeat(40))).toBe("\u{1F600}".repeat(40));
    expect(cleanTagName("x".repeat(40))).toBe("x".repeat(40));
  });
  it.each(["", "   ", "x".repeat(41), "\u{1F600}".repeat(41), "a\nb", "a\tb", "a\u0000b"])(
    "refuses %j",
    (raw) => {
      expect(cleanTagName(raw)).toBeNull();
    },
  );
});

describe("normaliseTagName", () => {
  it("is NFKC, trimmed, one inner space, case-folded", () => {
    expect(normaliseTagName("ＡＢＣ")).toBe("abc");
    expect(normaliseTagName("  Q3   Report ")).toBe("q3 report");
    expect(normaliseTagName("Straße")).toBe(normaliseTagName("STRASSE"));
    expect(normaliseTagName("é")).toBe(normaliseTagName("é"));
    expect(normaliseTagName("A B")).toBe("a b");
  });
  it("is null for a name that is not a valid tag name", () => {
    expect(normaliseTagName("")).toBeNull();
    expect(normaliseTagName("x".repeat(41))).toBeNull();
  });
});

describe("tag schemas", () => {
  it("TagName trims and refuses an invalid name without echoing it", () => {
    expect(TagName.parse(" Finance ")).toBe("Finance");
    const bad = TagName.safeParse("a\nb");
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad)).not.toContain("a\\nb");
    expect(TagName.safeParse("x".repeat(500)).success).toBe(false);
  });
  it("TagNameRequest is strict", () => {
    expect(TagNameRequest.safeParse({ name: "a", extra: 1 }).success).toBe(false);
    expect(TagNameRequest.parse({ name: " a " })).toEqual({ name: "a" });
  });
  it("SetDocumentTagsRequest lowercases ids and holds at most 20", () => {
    const up = id(1).toUpperCase();
    expect(up).not.toBe(id(1)); // the input really differs in case
    expect(SetDocumentTagsRequest.parse({ tagIds: [up] }).tagIds).toEqual([id(1)]);
    const many = Array.from({ length: 21 }, (_, i) => id(i + 1));
    expect(SetDocumentTagsRequest.safeParse({ tagIds: many }).success).toBe(false);
  });
  it("TagIdList: empty is none, duplicates collapse, more than 10 or a bad id is refused", () => {
    expect(TagIdList.parse("")).toEqual([]);
    expect(id(1).toUpperCase()).not.toBe(id(1));
    expect(TagIdList.parse(`${id(1)},${id(2)},${id(1).toUpperCase()}`)).toEqual([id(1), id(2)]);
    const eleven = Array.from({ length: 11 }, (_, i) => id(i + 1)).join(",");
    expect(TagIdList.safeParse(eleven).success).toBe(false);
    expect(TagIdList.safeParse(`${id(1)},nope`).success).toBe(false);
  });
  it("ListTagsResponse needs a document count per tag", () => {
    expect(ListTagsResponse.safeParse({ tags: [{ id: id(1), name: "a" }] }).success).toBe(false);
    expect(
      ListTagsResponse.safeParse({ tags: [{ id: id(1), name: "a", documents: 0 }] }).success,
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @docmind/contracts exec vitest run src/tags.test.ts`
Expected: FAIL (`./tags` does not exist).

- [ ] **Step 3: Write `packages/contracts/src/tags.ts`**

```ts
import { z } from "zod";
import { Uuid } from "./common";

export const MAX_TAG_NAME_CHARS = 40;
export const MAX_TAGS_PER_DOCUMENT = 20;
export const MAX_TAGS_PER_USER = 200;
export const MAX_TAGS_PER_FILTER = 10;
export const MAX_TAG_SUGGESTIONS = 5;
export const MAX_NEW_TAG_SUGGESTIONS = 3;

const CONTROL = /\p{Cc}/u;

/** The display name as typed, trimmed; null when it is empty, over 40 characters (code points) or holds a control character. */
export function cleanTagName(raw: string): string | null {
  const name = raw.trim();
  const length = [...name].length;
  if (length < 1 || length > MAX_TAG_NAME_CHARS || CONTROL.test(name)) return null;
  return name;
}

/**
 * What the keyed lookup hash is taken over: NFKC, trimmed, inner whitespace collapsed to one space, case-folded
 * (upper then lower case, so "ß" and "SS" meet). Null when `raw` is not a valid tag name. Never the display name.
 */
export function normaliseTagName(raw: string): string | null {
  const name = cleanTagName(raw);
  if (name === null) return null;
  const folded = name.normalize("NFKC").trim().replace(/\s+/gu, " ").toUpperCase().toLowerCase();
  return folded === "" ? null : folded;
}

/** A tag name in a request body: cleaned, or an issue that never quotes the value. */
export const TagName = z
  .string()
  .max(400)
  .transform((raw, ctx) => {
    const name = cleanTagName(raw);
    if (name === null) {
      ctx.addIssue({ code: "custom", message: "invalid tag name" });
      return z.NEVER;
    }
    return name;
  });

export const DocumentTag = z.object({ id: Uuid, name: z.string() }).strict();
export type DocumentTag = z.infer<typeof DocumentTag>;

/** One row of `GET /api/tags`: `documents` is how many of the user's documents carry it. */
export const TagSummary = z
  .object({ id: Uuid, name: z.string(), documents: z.number().int().nonnegative() })
  .strict();
export type TagSummary = z.infer<typeof TagSummary>;

export const ListTagsResponse = z.object({ tags: z.array(TagSummary) });
export type ListTagsResponse = z.infer<typeof ListTagsResponse>;

/** `POST /api/tags`, `PATCH /api/tags/:id`, `POST /api/documents/:id/tags` and the accept and dismiss routes. */
export const TagNameRequest = z.object({ name: TagName }).strict();
export type TagNameRequest = z.infer<typeof TagNameRequest>;

export const TagResponse = z.object({ tag: DocumentTag });
export type TagResponse = z.infer<typeof TagResponse>;

export const SetDocumentTagsRequest = z
  .object({
    tagIds: z.array(Uuid.transform((s) => s.toLowerCase())).max(MAX_TAGS_PER_DOCUMENT),
  })
  .strict();
export type SetDocumentTagsRequest = z.infer<typeof SetDocumentTagsRequest>;

/** What every document-tag route answers: the document's tags and its open suggestions. */
export const DocumentTagsResponse = z.object({
  tags: z.array(DocumentTag),
  suggestedTags: z.array(z.string()),
});
export type DocumentTagsResponse = z.infer<typeof DocumentTagsResponse>;

/** `POST /api/documents/:id/tag-suggestions/refresh`: the `suggest-tags` run was started. */
export const SuggestTagsResponse = z.object({ started: z.literal(true) });
export type SuggestTagsResponse = z.infer<typeof SuggestTagsResponse>;

export const TagMatch = z.enum(["any", "all"]);
export type TagMatch = z.infer<typeof TagMatch>;

/** The `tags` query value: comma-separated ids; empty is none; duplicates collapse; at most 10; anything else is refused. */
export const TagIdList = z
  .string()
  .max(MAX_TAGS_PER_FILTER * 37)
  .transform((s, ctx) => {
    if (s === "") return [] as string[];
    const ids = [...new Set(s.split(",").map((x) => x.trim().toLowerCase()))];
    if (ids.length > MAX_TAGS_PER_FILTER || ids.some((x) => !Uuid.safeParse(x).success)) {
      ctx.addIssue({ code: "custom", message: "invalid tag list" });
      return z.NEVER;
    }
    return ids;
  });
```

Add to `packages/contracts/src/index.ts` after `export * from "./sources";`:

```ts
export * from "./tags";
```

- [ ] **Step 4: Run it to see it pass**

Run: `pnpm --filter @docmind/contracts exec vitest run src/tags.test.ts && pnpm --filter @docmind/contracts typecheck`
Expected: PASS.

- [ ] **Step 5: Write the failing `TagKeys` test**

Create `apps/server/app/crypto/tagKeys.test.ts`:

```ts
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { describe, expect, it } from "vitest";
import { EntityKeys } from "./entityKeys";
import { FieldKeyUnavailableError } from "./fields";
import { TagKeys } from "./tagKeys";

const U1 = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const U2 = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";

describe("TagKeys", () => {
  it("gives one 32-byte hash to every spelling of a name, and creates the user's key if there is none", async () => {
    const keys = new InMemoryKeyStore(); // no key for U1 yet: a user may tag before uploading
    const a = await new TagKeys(keys).forUser(U1).nameBind("Q3 Report");
    expect(a?.length).toBe(32);
    const k = new TagKeys(keys).forUser(U1);
    expect((await k.nameBind("  q3   REPORT "))?.equals(a as Buffer)).toBe(true);
    expect((await k.nameBind("Q3 Reports"))?.equals(a as Buffer)).toBe(false);
  });

  it("separates users, and separates tags from entities for the same name", async () => {
    const keys = new InMemoryKeyStore();
    const t = new TagKeys(keys);
    const one = await t.forUser(U1).nameBind("acme");
    const two = await t.forUser(U2).nameBind("acme");
    expect(one?.equals(two as Buffer)).toBe(false);
    await keys.getOrCreate(U1);
    const entity = await new EntityKeys(keys).forUser(U1).nameKey("acme");
    expect(one?.toString("hex")).not.toBe(entity);
  });

  it("is null for a name that is not valid, and refuses once the key was destroyed", async () => {
    const keys = new InMemoryKeyStore();
    const k = new TagKeys(keys).forUser(U1);
    expect(await k.nameBind("")).toBeNull();
    await keys.getOrCreate(U1);
    await keys.destroy(U1);
    await expect(new TagKeys(keys).forUser(U1).nameBind("x")).rejects.toBeInstanceOf(
      FieldKeyUnavailableError,
    );
  });
});
```

- [ ] **Step 6: Run it to see it fail**

Run: `pnpm --filter @docmind/server exec vitest run app/crypto/tagKeys.test.ts`
Expected: FAIL (`./tagKeys` does not exist).

- [ ] **Step 7: Write `apps/server/app/crypto/tagKeys.ts`**

```ts
import { createHmac, hkdfSync } from "node:crypto";
import { normaliseTagName } from "@docmind/contracts";
import type { KeyStore } from "@loom/plugin-crypto";
import { FieldKeyStoreError, FieldKeyUnavailableError } from "./fields";

const TAG_INFO = "docmind-tag-v1";

/**
 * The keyed lookup hash of a tag name (the `EntityKeys` pattern, `crypto/entityKeys.ts`): HMAC-SHA256 over the normalised name
 * under a key derived from the owner's data key with its own HKDF info string, so the database never compares plaintext and
 * the hash cannot be tested against guesses once the key is destroyed. Make one per request, like FieldCrypto.
 * Unlike entity names, a tag can be the user's first write, so the data key is created when it does not exist; only a
 * destroyed key reads as unavailable.
 */
export class TagKeys {
  constructor(private readonly keys: KeyStore) {}

  forUser(userId: string): { nameBind(name: string): Promise<Buffer | null> } {
    const keys = this.keys;
    let key: Promise<Buffer> | undefined;
    const derive = (): Promise<Buffer> =>
      keys.getOrCreate(userId).then(
        (dek) => Buffer.from(hkdfSync("sha256", dek, Buffer.alloc(0), TAG_INFO, 32)),
        async () => {
          // The store's own errors may name the subject or KEK, so they are not passed on.
          const destroyed = (await keys.wasDestroyed?.(userId).catch(() => false)) === true;
          throw destroyed ? new FieldKeyUnavailableError() : new FieldKeyStoreError();
        },
      );
    return {
      nameBind: async (name) => {
        const n = normaliseTagName(name);
        if (n === null) return null;
        key ??= derive();
        return createHmac("sha256", await key)
          .update(n)
          .digest();
      },
    };
  }
}
```

- [ ] **Step 8: Run it to see it pass**

Run: `pnpm --filter @docmind/server exec vitest run app/crypto/tagKeys.test.ts`
Expected: PASS.

- [ ] **Step 9: Write the failing suggestion tests**

Create `apps/server/app/tags/suggestions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  type ExistingTag,
  normaliseSuggestions,
  parseSuggestedTags,
  tagInstruction,
} from "./suggestions";

const tag = (name: string, linked = false): ExistingTag => ({
  id: `00000000-0000-4000-8000-${String(name.length).padStart(12, "0")}`,
  name,
  linked,
});

describe("parseSuggestedTags", () => {
  it("keeps strings from an array and turns anything else into []", () => {
    expect(parseSuggestedTags(["a", 3, null, "b"])).toEqual(["a", "b"]);
    for (const bad of [undefined, null, "a,b", 7, { 0: "a" }])
      expect(parseSuggestedTags(bad)).toEqual([]);
  });
  it("looks at no more than 20 entries", () => {
    expect(parseSuggestedTags(Array.from({ length: 50 }, (_, i) => `t${i}`))).toHaveLength(20);
  });
});

describe("normaliseSuggestions", () => {
  it("maps a name onto an existing tag by normalised form and keeps the existing display name", () => {
    expect(normaliseSuggestions(["  q3   REPORT "], [tag("Q3 Report")])).toEqual(["Q3 Report"]);
  });
  it("clips to 40 characters, drops empty and control-character names, and dedupes", () => {
    const long = "x".repeat(60);
    expect(normaliseSuggestions([long, "", "   ", "a\nb", "Dup", "dup", " DUP "], [])).toEqual([
      "x".repeat(40),
      "Dup",
    ]);
  });
  it("allows at most 3 new names, but existing ones past them still count", () => {
    const existing = [tag("Old1"), tag("Old2"), tag("Old3")];
    expect(
      normaliseSuggestions(["n1", "n2", "n3", "n4", "old1", "old2", "old3"], existing),
    ).toEqual(["n1", "n2", "n3", "Old1", "Old2"]);
  });
  it("caps the result at 5", () => {
    const existing = Array.from({ length: 8 }, (_, i) => tag(`E${i}`.padEnd(i + 2, "z")));
    expect(
      normaliseSuggestions(
        existing.map((t) => t.name),
        existing,
      ),
    ).toHaveLength(5);
  });
  it("drops a name already linked to the document, whatever its spelling", () => {
    expect(normaliseSuggestions(["finance", "new"], [tag("Finance", true)])).toEqual(["new"]);
  });
  it("tolerates a malformed answer", () => {
    expect(normaliseSuggestions("nope", [])).toEqual([]);
    expect(normaliseSuggestions(undefined, [tag("A")])).toEqual([]);
  });
});

describe("tagInstruction", () => {
  it("without tags asks for up to 3 new names and lists nothing", () => {
    const line = tagInstruction([]);
    expect(line).toContain("suggestedTags");
    expect(line).toContain("up to 3");
    expect(line).not.toContain("[");
  });
  it("with tags lists them as a JSON array, asks to reuse them, and allows at most 3 new ones", () => {
    const line = tagInstruction(["Finance", 'say "hi"']);
    expect(line).toContain('["Finance","say \\"hi\\""]');
    expect(line).toContain("up to 5");
    expect(line).toContain("Reuse an existing tag");
    expect(line).toContain("at most 3");
  });
  it("lists no more than 200 tags", () => {
    const line = tagInstruction(Array.from({ length: 300 }, (_, i) => `t${i}`));
    expect(line).toContain('"t199"');
    expect(line).not.toContain('"t200"');
  });
});
```

- [ ] **Step 10: Run it to see it fail**

Run: `pnpm --filter @docmind/server exec vitest run app/tags/suggestions.test.ts`
Expected: FAIL (`./suggestions` does not exist).

- [ ] **Step 11: Write `apps/server/app/tags/suggestions.ts`**

```ts
import {
  MAX_NEW_TAG_SUGGESTIONS,
  MAX_TAGS_PER_USER,
  MAX_TAG_NAME_CHARS,
  MAX_TAG_SUGGESTIONS,
  cleanTagName,
  normaliseTagName,
} from "@docmind/contracts";

/** One of the owner's tags, as the suggestion code sees it. `linked`: it is already on the document in question. */
export interface ExistingTag {
  id: string;
  name: string;
  linked: boolean;
}

const LOOK_AT = 20;

/** The model's `suggestedTags` read leniently: the strings of an array (first 20), else `[]`. Never throws. */
export function parseSuggestedTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string").slice(0, LOOK_AT);
}

const clip = (name: string): string => [...name.trim()].slice(0, MAX_TAG_NAME_CHARS).join("");

/**
 * The names to offer for a document (spec section 4): each clipped to 40 characters, empty and control-character names dropped,
 * mapped onto an existing tag whose normalised form is equal (keeping that tag's display name), deduped, at most 5 with at most
 * 3 that are not existing tags, and never a tag already linked to the document. `raw` is the model's field, parsed leniently.
 */
export function normaliseSuggestions(raw: unknown, existingTags: readonly ExistingTag[]): string[] {
  const known = new Map<string, ExistingTag>();
  for (const t of existingTags) {
    const n = normaliseTagName(t.name);
    if (n !== null) known.set(n, t);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  let fresh = 0;
  for (const candidate of parseSuggestedTags(raw)) {
    const display = cleanTagName(clip(candidate));
    if (display === null) continue;
    const norm = normaliseTagName(display);
    if (norm === null || seen.has(norm)) continue;
    seen.add(norm);
    const match = known.get(norm);
    if (match?.linked) continue;
    if (!match && fresh >= MAX_NEW_TAG_SUGGESTIONS) continue;
    if (!match) fresh++;
    out.push(match ? match.name : display);
    if (out.length === MAX_TAG_SUGGESTIONS) break;
  }
  return out;
}

/**
 * The one prompt line that asks for `suggestedTags`. The existing tags are the user's own words, so they go in as a JSON array
 * (quoted and escaped, at most 200): a tag name can never read as an instruction.
 */
export function tagInstruction(existing: readonly string[]): string {
  const known = existing.slice(0, MAX_TAGS_PER_USER);
  return known.length === 0
    ? 'For "suggestedTags", give up to 3 short topic tags (1 to 3 words each) this document could be filed under.'
    : `For "suggestedTags", give up to 5 short tags for this document. The reader already uses these tags (a JSON list): ${JSON.stringify(known)}. Reuse an existing tag exactly as written wherever one fits, and add at most 3 tags that are not in that list.`;
}
```

- [ ] **Step 12: Run the suite and the checks**

Run: `pnpm --filter @docmind/server exec vitest run app/tags/suggestions.test.ts app/crypto/tagKeys.test.ts && pnpm typecheck && pnpm typecheck:tests && pnpm lint`
Expected: PASS. (The `caps the result at 5` test builds eight distinct existing names; if `typecheck:tests` flags the `padEnd` helper, replace it with `["Aa","Bb","Cc","Dd","Ee","Ff","Gg","Hh"]` mapped through `tag`.)

- [ ] **Step 13: Commit**

```bash
git add packages/contracts apps/server/app/crypto apps/server/app/tags apps/server/vitest.config.ts apps/web/vite.config.ts
git commit -m "feat(tags): tag name contracts, keyed lookup hash and the suggestion normaliser"
```

---

## Task 2: Migration 0036, `TagService`, erasure

**Files:**
- Create: `infra/migrations/0036_document_tags.sql`
- Create: `apps/server/app/tags/service.ts`
- Test: `apps/server/app/tags/service.pg.test.ts`
- Modify: `apps/server/app/erasure/pgSteps.ts:65` (the comment naming what the user-row delete cascades to)
- Modify: `docs/codebase-guide.md:77` is done in Task 8

**Interfaces:**
- Consumes: `FieldCrypto`, `FieldKeyUnavailableError` (`crypto/fields.ts`); `TagKeys` (Task 1); `withTenant` (`db/tenant.ts`); contracts limits and `cleanTagName`, `normaliseTagName`, `DocumentTag` (Task 1); `ExistingTag`, `parseSuggestedTags` (Task 1); `startPgFixture` (`flows/ingest-document/pgFixture.ts`, users `U1` and `U1B` in tenant `T1`, `U2` in `T2`).
- Produces:

```ts
export const tagNameBind = (id: string) => `tag:${id}:name`;
export const suggestionsBind = (documentId: string) => `document:${documentId}:tag-suggestions`;
export interface TagOwner { tenantId: string; userId: string }
export interface TagWithCount extends DocumentTag { documents: number }
export class TagNameInvalidError extends Error {}
export class TagExistsError extends Error {}
export class UnknownTagError extends Error {}
export class TagLimitError extends Error { readonly limit: "document" | "user" }
export class TagService {
  constructor(pool: Pool, fields: FieldCrypto, keys: TagKeys);
  list(o: TagOwner): Promise<TagWithCount[]>;
  create(o: TagOwner, raw: string): Promise<{ tag: DocumentTag; created: boolean }>;
  rename(o: TagOwner, id: string, raw: string): Promise<DocumentTag | null>;
  remove(o: TagOwner, id: string): Promise<boolean>;
  forDocuments(o: TagOwner, documentIds: readonly string[]): Promise<Map<string, DocumentTag[]>>;
  detail(o: TagOwner, documentId: string): Promise<{ tags: DocumentTag[]; suggestedTags: string[] } | null>;
  setForDocument(o: TagOwner, documentId: string, tagIds: readonly string[]): Promise<{ tags: DocumentTag[]; suggestedTags: string[] } | null>;
  addToDocument(o: TagOwner, documentId: string, raw: string): Promise<{ tags: DocumentTag[]; suggestedTags: string[] } | null>;
  removeFromDocument(o: TagOwner, documentId: string, tagId: string): Promise<{ tags: DocumentTag[]; suggestedTags: string[] } | null>;
  suggestionContext(ref: TagOwner & { documentId: string }): Promise<ExistingTag[] | null>;
  putSuggestions(ref: TagOwner & { documentId: string }, names: readonly string[]): Promise<boolean>;
  accept(o: TagOwner, documentId: string, raw: string): Promise<{ tags: DocumentTag[]; suggestedTags: string[] } | null>;
  dismiss(o: TagOwner, documentId: string, raw: string): Promise<{ tags: DocumentTag[]; suggestedTags: string[] } | null>;
}
```
  (`null` from a document-scoped method means the document is not the owner's; `suggestionContext` is ordered by use count desc then name, at most 200.)

- [ ] **Step 1: Write the migration**

Create `infra/migrations/0036_document_tags.sql`:

```sql
-- 0036: document tags (spec docs/specs/2026-11-10-document-tags-design.md section 3). Additive: no existing row changes.
-- Names are sealed under the owner's data key (bind tag:<id>:name); `name_bind` is an HMAC of the normalised name under a key
-- derived from the same data key (the entities.name_key pattern), so uniqueness never compares plaintext and cannot be tested
-- against guesses once the key is destroyed. Every table carries the tenant-isolation policy of `documents`; the owner is
-- named in every query. Rows cascade with the document, the tag and the user, so erasure (DELETE FROM users) removes them.

-- A key the composite foreign keys below can point at: it makes "this document's owner is this tag's owner" a database fact.
ALTER TABLE documents ADD CONSTRAINT documents_tenant_owner_id_key UNIQUE (tenant_id, owner_id, id);

CREATE TABLE tags (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  name_enc jsonb NOT NULL,
  name_bind bytea NOT NULL CHECK (octet_length(name_bind) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tags_owner_fkey FOREIGN KEY (tenant_id, owner_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT tags_owner_name_key UNIQUE (owner_id, name_bind),
  CONSTRAINT tags_tenant_owner_id_key UNIQUE (tenant_id, owner_id, id)
);
ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tags USING (tenant_id = app_tenant_id());

CREATE TABLE document_tags (
  document_id uuid NOT NULL,
  tag_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, tag_id),
  CONSTRAINT document_tags_document_fkey FOREIGN KEY (tenant_id, owner_id, document_id)
    REFERENCES documents (tenant_id, owner_id, id) ON DELETE CASCADE,
  CONSTRAINT document_tags_tag_fkey FOREIGN KEY (tenant_id, owner_id, tag_id)
    REFERENCES tags (tenant_id, owner_id, id) ON DELETE CASCADE
);
-- The listing filter starts here: a tag's documents of one owner, in document order.
CREATE INDEX document_tags_owner_tag_idx ON document_tags (owner_id, tag_id, document_id);
ALTER TABLE document_tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON document_tags USING (tenant_id = app_tenant_id());

CREATE TABLE document_tag_suggestions (
  document_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  names_enc jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_tag_suggestions_document_fkey FOREIGN KEY (tenant_id, owner_id, document_id)
    REFERENCES documents (tenant_id, owner_id, id) ON DELETE CASCADE
);
ALTER TABLE document_tag_suggestions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON document_tag_suggestions USING (tenant_id = app_tenant_id());
```

- [ ] **Step 2: Write the failing database tests**

Create `apps/server/app/tags/service.pg.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { MAX_TAGS_PER_USER } from "@docmind/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FieldKeyUnavailableError } from "../crypto/fields";
import { TagKeys } from "../crypto/tagKeys";
import { withTenant } from "../db/tenant";
import { PG_URL } from "../db/testSupport";
import { insertDocument } from "../documents/repo";
import { T1, T2, U1, U1B, U2, newDocument } from "../documents/testHarness";
import { type PgFixture, startPgFixture } from "../flows/ingest-document/pgFixture";
import { TagExistsError, TagLimitError, TagService, UnknownTagError } from "./service";

const A = { tenantId: T1, userId: U1 };
const A2 = { tenantId: T1, userId: U1B };
const B = { tenantId: T2, userId: U2 };

describe.skipIf(!PG_URL)("TagService (needs DOCMIND_TEST_PG_URL)", () => {
  let fx: PgFixture;
  let svc: TagService;
  let n = 0;
  const doc = async (who = A) => {
    const d = await newDocument(
      fx.fields,
      who.tenantId,
      who.userId,
      (++n).toString(16).padStart(64, "0"),
    );
    await withTenant(fx.app, who.tenantId, (tx) => insertDocument(tx, d));
    return d.id;
  };
  /** A user of tenant 1 that a test may erase or shred without disturbing the others. */
  const freshUser = async () => {
    const userId = randomUUID();
    await fx.db.owner.query(
      "INSERT INTO users (id, tenant_id, email, password_hash) VALUES ($1, $2, $3, 'x')",
      [userId, T1, `${userId}@example.com`],
    );
    return { tenantId: T1, userId };
  };
  const count = async (sql: string, args: unknown[] = []) =>
    (await fx.db.owner.query(sql, args)).rows[0].n as number;
  /** Links the document to a tag by name and answers that tag (no non-null assertions: the lint rule forbids them). */
  const tagOf = async (who: typeof A, documentId: string, name: string) => {
    const added = await svc.addToDocument(who, documentId, name);
    const tag = added?.tags.find((t) => t.name === name);
    if (!tag) throw new Error("the tag was not added");
    return tag;
  };

  beforeAll(async () => {
    fx = await startPgFixture();
    svc = new TagService(fx.app, fx.fields, new TagKeys(fx.keys));
  });
  afterAll(async () => void (await fx?.close()));
  beforeEach(async () => {
    await fx.db.owner.query("DELETE FROM tags");
    await fx.db.owner.query("DELETE FROM documents");
  });

  it("reuses the tag for any spelling of the same normalised name, per owner", async () => {
    const first = await svc.create(A, "Q3 Report");
    const again = await svc.create(A, "  q3   REPORT ");
    expect(again).toEqual({ tag: first.tag, created: false });
    expect(first.created).toBe(true);
    expect(first.tag.name).toBe("Q3 Report"); // the display name is kept as first typed
    const other = await svc.create(A2, "Q3 Report"); // another user of the same tenant
    expect(other.tag.id).not.toBe(first.tag.id);
    expect(other.created).toBe(true);
  });

  it("enforces name_bind uniqueness in the database", async () => {
    await svc.create(A, "dup");
    const row = (await fx.db.owner.query("SELECT * FROM tags WHERE owner_id = $1", [U1])).rows[0];
    await expect(
      fx.db.owner.query(
        "INSERT INTO tags (id, tenant_id, owner_id, name_enc, name_bind) VALUES ($1, $2, $3, '{}', $4)",
        [randomUUID(), T1, U1, row.name_bind],
      ),
    ).rejects.toThrow(/tags_owner_name_key/);
  });

  it("seals the name: no plaintext in any column", async () => {
    await svc.create(A, "Zebra-Secret-Tag");
    const row = (await fx.db.owner.query("SELECT to_jsonb(t) AS r FROM tags t")).rows[0].r;
    expect(JSON.stringify(row)).not.toContain("Zebra");
  });

  it("lists with counts, sorted by name, and opens only the caller's tags", async () => {
    const d = await doc();
    await svc.addToDocument(A, d, "banana");
    await svc.addToDocument(A, d, "Apple");
    await svc.create(A, "cherry");
    await svc.create(A2, "other user");
    expect(await svc.list(A)).toEqual([
      { id: expect.any(String), name: "Apple", documents: 1 },
      { id: expect.any(String), name: "banana", documents: 1 },
      { id: expect.any(String), name: "cherry", documents: 0 },
    ]);
  });

  it("guarantees the document and the tag share the owner", async () => {
    const d = await doc(A);
    const foreign = (await svc.create(A2, "theirs")).tag.id;
    await expect(
      fx.db.owner.query(
        "INSERT INTO document_tags (document_id, tag_id, tenant_id, owner_id) VALUES ($1, $2, $3, $4)",
        [d, foreign, T1, U1],
      ),
    ).rejects.toThrow(/document_tags_tag_fkey/);
    await expect(svc.setForDocument(A, d, [foreign])).rejects.toBeInstanceOf(UnknownTagError);
    expect(await svc.setForDocument(A, randomUUID(), [])).toBeNull();
  });

  it("isolates tenants with row-level security", async () => {
    await svc.create(A, "visible to a1 only");
    const seen = await withTenant(
      fx.app,
      T2,
      async (tx) => (await tx.query("SELECT count(*)::int AS n FROM tags")).rows[0].n,
    );
    expect(seen).toBe(0);
    expect(await svc.list(B)).toEqual([]);
  });

  it("cascades: a deleted document drops its links and suggestions, a deleted tag its links, a deleted user everything", async () => {
    const d1 = await doc();
    const d2 = await doc();
    const t = await tagOf(A, d1, "keep");
    await svc.addToDocument(A, d2, "keep");
    await svc.putSuggestions({ ...A, documentId: d1 }, ["s1"]);
    await fx.db.owner.query("DELETE FROM documents WHERE id = $1", [d1]);
    expect(
      await count("SELECT count(*)::int AS n FROM document_tags WHERE document_id = $1", [d1]),
    ).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM document_tag_suggestions")).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM tags WHERE id = $1", [t.id])).toBe(1); // a tag with no documents stays
    expect(await svc.remove(A, t.id)).toBe(true);
    expect(await count("SELECT count(*)::int AS n FROM document_tags")).toBe(0);
    const gone = await freshUser();
    await svc.addToDocument(gone, await doc(gone), "mine");
    await svc.putSuggestions({ ...gone, documentId: await doc(gone) }, ["s"]);
    await fx.db.owner.query("DELETE FROM users WHERE id = $1", [gone.userId]); // erasure's `rows` step
    for (const table of ["tags", "document_tags", "document_tag_suggestions"])
      expect(
        await count(`SELECT count(*)::int AS n FROM ${table} WHERE owner_id = $1`, [gone.userId]),
      ).toBe(0);
  });

  it("crypto-shredding: once the key is destroyed the names cannot be opened", async () => {
    const who = await freshUser();
    await svc.create(who, "shredme");
    await fx.keys.destroy(who.userId);
    await expect(svc.list(who)).rejects.toBeInstanceOf(FieldKeyUnavailableError);
    await expect(svc.create(who, "again")).rejects.toBeInstanceOf(FieldKeyUnavailableError);
  });

  it("limits a document to 20 tags and a user to 200", async () => {
    const d = await doc();
    for (let i = 0; i < 20; i++) await svc.addToDocument(A, d, `t${i}`);
    await expect(svc.addToDocument(A, d, "t20")).rejects.toMatchObject({ limit: "document" });
    await svc.addToDocument(A, d, "t3"); // already linked: not a 21st
    await fx.db.owner.query(
      `INSERT INTO tags (id, tenant_id, owner_id, name_enc, name_bind)
       SELECT gen_random_uuid(), $1, $2, '{}', decode(md5(g::text) || md5(g::text || 'x'), 'hex')
         FROM generate_series(1, $3) g`,
      [T1, U1, MAX_TAGS_PER_USER - 20],
    );
    await expect(svc.create(A, "one too many")).rejects.toBeInstanceOf(TagLimitError);
    expect((await svc.create(A, "t3")).created).toBe(false); // reusing is not creating
  });

  it("renames, refuses a collision with 409's error, and allows a case-only change", async () => {
    const a = (await svc.create(A, "alpha")).tag;
    const b = (await svc.create(A, "beta")).tag;
    await expect(svc.rename(A, b.id, " ALPHA ")).rejects.toBeInstanceOf(TagExistsError);
    expect(await svc.rename(A, a.id, "ALPHA")).toEqual({ id: a.id, name: "ALPHA" });
    expect(await svc.rename(A, randomUUID(), "x")).toBeNull();
    expect(await svc.rename(A2, a.id, "x")).toBeNull(); // another user's tag
  });

  it("sets, adds and removes a document's tags, and reports the open suggestions without the linked ones", async () => {
    const d = await doc();
    const x = (await svc.create(A, "x")).tag;
    const y = (await svc.create(A, "y")).tag;
    expect((await svc.setForDocument(A, d, [x.id, y.id, x.id]))?.tags.map((t) => t.name)).toEqual([
      "x",
      "y",
    ]);
    await svc.putSuggestions({ ...A, documentId: d }, ["X", "fresh"]);
    expect((await svc.detail(A, d))?.suggestedTags).toEqual(["fresh"]); // "X" is linked as "x"
    expect((await svc.removeFromDocument(A, d, x.id))?.tags.map((t) => t.name)).toEqual(["y"]);
    expect((await svc.detail(A, d))?.suggestedTags).toEqual(["X", "fresh"]);
    expect(await svc.removeFromDocument(A, randomUUID(), x.id)).toBeNull();
  });

  it("accepts a suggestion (creating or reusing the tag) and dismisses one", async () => {
    const d = await doc();
    await svc.putSuggestions({ ...A, documentId: d }, ["Finance", "Legal", "Misc"]);
    const accepted = await svc.accept(A, d, "finance");
    expect(accepted?.tags.map((t) => t.name)).toEqual(["finance"]);
    expect(accepted?.suggestedTags).toEqual(["Legal", "Misc"]);
    expect((await svc.dismiss(A, d, "LEGAL"))?.suggestedTags).toEqual(["Misc"]);
    expect((await svc.dismiss(A, d, "Misc"))?.suggestedTags).toEqual([]);
    expect(await count("SELECT count(*)::int AS n FROM document_tag_suggestions")).toBe(0); // an empty list is no row
  });

  it("stores suggestions sealed, replaces the row, and reports a gone document", async () => {
    const d = await doc();
    expect(await svc.putSuggestions({ ...A, documentId: d }, ["Zebra-Secret-Suggestion"])).toBe(
      true,
    );
    expect(await svc.putSuggestions({ ...A, documentId: d }, ["second"])).toBe(true);
    const row = (await fx.db.owner.query("SELECT to_jsonb(s) AS r FROM document_tag_suggestions s"))
      .rows;
    expect(row).toHaveLength(1);
    expect(JSON.stringify(row)).not.toContain("Zebra");
    expect((await svc.detail(A, d))?.suggestedTags).toEqual(["second"]);
    expect(await svc.putSuggestions({ ...A, documentId: randomUUID() }, ["x"])).toBe(false);
    expect(await svc.putSuggestions({ ...A2, documentId: d }, ["x"])).toBe(false); // not their document
  });

  it("orders the suggestion context by use count, then name, and marks the tags the document has", async () => {
    const d1 = await doc();
    const d2 = await doc();
    await svc.addToDocument(A, d1, "popular");
    await svc.addToDocument(A, d2, "popular");
    await svc.addToDocument(A, d1, "alpha");
    await svc.create(A, "beta");
    const context = await svc.suggestionContext({ ...A, documentId: d1 });
    expect(context?.map((t) => [t.name, t.linked])).toEqual([
      ["popular", true],
      ["alpha", true],
      ["beta", false],
    ]);
    expect(await svc.suggestionContext({ ...A, documentId: randomUUID() })).toBeNull();
  });

  it("lists a page of documents' tags in one read", async () => {
    const d1 = await doc();
    const d2 = await doc();
    await svc.addToDocument(A, d1, "one");
    const map = await svc.forDocuments(A, [d1, d2]);
    expect(map.get(d1)?.map((t) => t.name)).toEqual(["one"]);
    expect(map.get(d2)).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `set -a; . ./.env; set +a; pnpm --filter @docmind/server exec vitest run app/tags/service.pg.test.ts`
Expected: FAIL (`./service` does not exist; the migration is applied by `startPgFixture`).

- [ ] **Step 4: Write `apps/server/app/tags/service.ts`**

```ts
import { randomUUID } from "node:crypto";
import {
  type DocumentTag,
  MAX_TAGS_PER_DOCUMENT,
  MAX_TAGS_PER_USER,
  cleanTagName,
  normaliseTagName,
} from "@docmind/contracts";
import type { Pool, PoolClient } from "pg";
import type { FieldCrypto } from "../crypto/fields";
import type { TagKeys } from "../crypto/tagKeys";
import { withTenant } from "../db/tenant";
import { type ExistingTag, parseSuggestedTags } from "./suggestions";

export const tagNameBind = (id: string) => `tag:${id}:name`;
export const suggestionsBind = (documentId: string) => `document:${documentId}:tag-suggestions`;

export interface TagOwner {
  tenantId: string;
  userId: string;
}
export interface TagWithCount extends DocumentTag {
  documents: number;
}
export interface DocumentTagsView {
  tags: DocumentTag[];
  suggestedTags: string[];
}

// Fixed messages: these reach logs and error answers, so they never carry a name.
export class TagNameInvalidError extends Error {
  constructor() {
    super("invalid tag name");
    this.name = "TagNameInvalidError";
  }
}
export class TagExistsError extends Error {
  constructor() {
    super("a tag with this name exists");
    this.name = "TagExistsError";
  }
}
export class UnknownTagError extends Error {
  constructor() {
    super("unknown tag");
    this.name = "UnknownTagError";
  }
}
export class TagLimitError extends Error {
  constructor(readonly limit: "document" | "user") {
    super("tag limit reached");
    this.name = "TagLimitError";
  }
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
const byName = (a: DocumentTag, b: DocumentTag) =>
  collator.compare(a.name, b.name) || (a.id < b.id ? -1 : 1);

interface Prepared {
  id: string;
  display: string;
  bind: Buffer;
  sealed: unknown;
}
interface NameRow {
  id: string;
  name_enc: unknown;
}

/** Serialises one owner's tag writes (the limit checks and the get-or-create). Held until the transaction ends. */
const lockOwner = (tx: PoolClient, o: TagOwner) =>
  tx.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))", [
    `docmind:tags:${o.userId}`,
  ]);

/** Owner-scoped `FOR KEY SHARE`: a concurrent delete of the document waits, then cascades our rows. False when it is not the owner's. */
async function lockDocument(tx: PoolClient, o: TagOwner, documentId: string): Promise<boolean> {
  const { rowCount } = await tx.query(
    "SELECT 1 FROM documents WHERE id = $1 AND owner_id = $2 AND tenant_id = $3 FOR KEY SHARE",
    [documentId, o.userId, o.tenantId],
  );
  return rowCount === 1;
}

/** The owner's tag with this lookup hash, or a new one (limit checked). Call under `lockOwner`. */
async function upsertTag(
  tx: PoolClient,
  o: TagOwner,
  p: Prepared,
): Promise<{ id: string; created: boolean }> {
  const found = await tx.query<{ id: string }>(
    "SELECT id FROM tags WHERE owner_id = $1 AND tenant_id = $2 AND name_bind = $3",
    [o.userId, o.tenantId, p.bind],
  );
  if (found.rows[0]) return { id: found.rows[0].id, created: false };
  const total = await tx.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM tags WHERE owner_id = $1 AND tenant_id = $2",
    [o.userId, o.tenantId],
  );
  if ((total.rows[0] as { n: number }).n >= MAX_TAGS_PER_USER) throw new TagLimitError("user");
  await tx.query(
    "INSERT INTO tags (id, tenant_id, owner_id, name_enc, name_bind) VALUES ($1, $2, $3, $4::jsonb, $5)",
    [p.id, o.tenantId, o.userId, JSON.stringify(p.sealed), p.bind],
  );
  return { id: p.id, created: true };
}

/**
 * Every read and write of tags, links and suggestions. Names are sealed under the owner's key and compared by a keyed hash;
 * all key-store calls (seal, open, hash) happen outside the transactions, never under a row lock. Every statement names the
 * owner and the tenant, in addition to row-level security. Nothing here logs or puts a name in an error.
 */
export class TagService {
  constructor(
    private readonly pool: Pool,
    private readonly fields: FieldCrypto,
    private readonly keys: TagKeys,
  ) {}

  private async prepare(o: TagOwner, raw: string, id: string = randomUUID()): Promise<Prepared> {
    const display = cleanTagName(raw);
    if (display === null) throw new TagNameInvalidError();
    const bind = await this.keys.forUser(o.userId).nameBind(display);
    if (bind === null) throw new TagNameInvalidError();
    return {
      id,
      display,
      bind,
      sealed: await this.fields.forUser(o.userId).seal(tagNameBind(id), display),
    };
  }

  private async open(o: TagOwner, rows: readonly NameRow[]): Promise<DocumentTag[]> {
    const cipher = this.fields.forUser(o.userId);
    const named = await Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        name: await cipher.openText(tagNameBind(r.id), r.name_enc),
      })),
    );
    return named.sort(byName);
  }

  async list(o: TagOwner): Promise<TagWithCount[]> {
    const rows = await withTenant(
      this.pool,
      o.tenantId,
      async (tx) =>
        (
          await tx.query<NameRow & { documents: number }>(
            `SELECT t.id, t.name_enc, count(dt.document_id)::int AS documents
               FROM tags t
               LEFT JOIN document_tags dt
                 ON dt.tag_id = t.id AND dt.owner_id = t.owner_id AND dt.tenant_id = t.tenant_id
              WHERE t.owner_id = $1 AND t.tenant_id = $2
              GROUP BY t.id`,
            [o.userId, o.tenantId],
          )
        ).rows,
    );
    const counts = new Map(rows.map((r) => [r.id, r.documents]));
    return (await this.open(o, rows)).map((t) => ({ ...t, documents: counts.get(t.id) ?? 0 }));
  }

  async create(o: TagOwner, raw: string): Promise<{ tag: DocumentTag; created: boolean }> {
    const p = await this.prepare(o, raw);
    const out = await withTenant(this.pool, o.tenantId, async (tx) => {
      await lockOwner(tx, o);
      const r = await upsertTag(tx, o, p);
      const row = await tx.query<NameRow>(
        "SELECT id, name_enc FROM tags WHERE id = $1 AND owner_id = $2 AND tenant_id = $3",
        [r.id, o.userId, o.tenantId],
      );
      return { created: r.created, row: row.rows[0] as NameRow };
    });
    const [tag] = await this.open(o, [out.row]);
    return { tag: tag as DocumentTag, created: out.created };
  }

  /** The renamed tag; null when it is not the owner's. Throws `TagExistsError` when the new name belongs to another of their tags. */
  async rename(o: TagOwner, id: string, raw: string): Promise<DocumentTag | null> {
    const p = await this.prepare(o, raw, id); // sealed under the tag's own id
    try {
      const hit = await withTenant(this.pool, o.tenantId, async (tx) => {
        await lockOwner(tx, o);
        const r = await tx.query(
          `UPDATE tags SET name_enc = $4::jsonb, name_bind = $5
            WHERE id = $1 AND owner_id = $2 AND tenant_id = $3`,
          [id, o.userId, o.tenantId, JSON.stringify(p.sealed), p.bind],
        );
        return r.rowCount === 1;
      });
      return hit ? { id, name: p.display } : null;
    } catch (err) {
      if ((err as { code?: unknown }).code === "23505") throw new TagExistsError();
      throw err;
    }
  }

  async remove(o: TagOwner, id: string): Promise<boolean> {
    return withTenant(this.pool, o.tenantId, async (tx) => {
      const r = await tx.query(
        "DELETE FROM tags WHERE id = $1 AND owner_id = $2 AND tenant_id = $3",
        [id, o.userId, o.tenantId],
      );
      return r.rowCount === 1;
    });
  }

  /** The tags of each listed document (a page of the library), one owner-scoped read. A document with none is absent. */
  async forDocuments(
    o: TagOwner,
    documentIds: readonly string[],
  ): Promise<Map<string, DocumentTag[]>> {
    const out = new Map<string, DocumentTag[]>();
    if (documentIds.length === 0) return out;
    const rows = await withTenant(
      this.pool,
      o.tenantId,
      async (tx) =>
        (
          await tx.query<NameRow & { document_id: string }>(
            `SELECT dt.document_id, t.id, t.name_enc
               FROM document_tags dt
               JOIN tags t ON t.id = dt.tag_id AND t.owner_id = dt.owner_id AND t.tenant_id = dt.tenant_id
              WHERE dt.owner_id = $1 AND dt.tenant_id = $2 AND dt.document_id = ANY($3::uuid[])`,
            [o.userId, o.tenantId, [...documentIds]],
          )
        ).rows,
    );
    const names = new Map((await this.open(o, rows)).map((t) => [t.id, t]));
    for (const r of rows) {
      const tag = names.get(r.id) as DocumentTag;
      out.set(r.document_id, [...(out.get(r.document_id) ?? []), tag]);
    }
    for (const [id, tags] of out) out.set(id, tags.sort(byName));
    return out;
  }

  private async readSuggestions(
    o: TagOwner,
    documentId: string,
  ): Promise<{ names: string[]; stamp: string | null } | null> {
    const row = await withTenant(
      this.pool,
      o.tenantId,
      async (tx) =>
        (
          await tx.query<{ names_enc: unknown; stamp: string | null }>(
            `SELECT s.names_enc, s.updated_at::text AS stamp
               FROM documents d
               LEFT JOIN document_tag_suggestions s
                 ON s.document_id = d.id AND s.owner_id = d.owner_id AND s.tenant_id = d.tenant_id
              WHERE d.id = $1 AND d.owner_id = $2 AND d.tenant_id = $3`,
            [documentId, o.userId, o.tenantId],
          )
        ).rows[0],
    );
    if (!row) return null;
    if (row.names_enc == null) return { names: [], stamp: null };
    const opened = await this.fields
      .forUser(o.userId)
      .open(suggestionsBind(documentId), row.names_enc);
    return { names: parseSuggestedTags(opened), stamp: row.stamp };
  }

  /** The document's tags and its open suggestions (those not already linked); null when it is not the owner's. */
  async detail(o: TagOwner, documentId: string): Promise<DocumentTagsView | null> {
    const stored = await this.readSuggestions(o, documentId);
    if (!stored) return null;
    const tags = (await this.forDocuments(o, [documentId])).get(documentId) ?? [];
    const linked = new Set(tags.map((t) => normaliseTagName(t.name)));
    return {
      tags,
      suggestedTags: stored.names.filter((n) => !linked.has(normaliseTagName(n))),
    };
  }

  async setForDocument(
    o: TagOwner,
    documentId: string,
    tagIds: readonly string[],
  ): Promise<DocumentTagsView | null> {
    const ids = [...new Set(tagIds.map((t) => t.toLowerCase()))];
    if (ids.length > MAX_TAGS_PER_DOCUMENT) throw new TagLimitError("document");
    const found = await withTenant(this.pool, o.tenantId, async (tx) => {
      await lockOwner(tx, o);
      if (!(await lockDocument(tx, o, documentId))) return false;
      const owned = await tx.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM tags WHERE owner_id = $1 AND tenant_id = $2 AND id = ANY($3::uuid[])",
        [o.userId, o.tenantId, ids],
      );
      if ((owned.rows[0] as { n: number }).n !== ids.length) throw new UnknownTagError();
      await tx.query(
        "DELETE FROM document_tags WHERE document_id = $1 AND owner_id = $2 AND tenant_id = $3",
        [documentId, o.userId, o.tenantId],
      );
      await tx.query(
        `INSERT INTO document_tags (document_id, tag_id, tenant_id, owner_id)
         SELECT $1, t, $2, $3 FROM unnest($4::uuid[]) AS t`,
        [documentId, o.tenantId, o.userId, ids],
      );
      return true;
    });
    return found ? this.detail(o, documentId) : null;
  }

  /** Links the tag named `raw`, creating it if the owner has none. False when the document is not the owner's. */
  private async link(o: TagOwner, documentId: string, raw: string): Promise<boolean> {
    const p = await this.prepare(o, raw);
    return withTenant(this.pool, o.tenantId, async (tx) => {
      await lockOwner(tx, o);
      if (!(await lockDocument(tx, o, documentId))) return false;
      const { id } = await upsertTag(tx, o, p);
      const has = await tx.query(
        "SELECT 1 FROM document_tags WHERE document_id = $1 AND tag_id = $2 AND owner_id = $3 AND tenant_id = $4",
        [documentId, id, o.userId, o.tenantId],
      );
      if (has.rowCount === 0) {
        const n = await tx.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM document_tags WHERE document_id = $1 AND owner_id = $2 AND tenant_id = $3",
          [documentId, o.userId, o.tenantId],
        );
        if ((n.rows[0] as { n: number }).n >= MAX_TAGS_PER_DOCUMENT)
          throw new TagLimitError("document");
        await tx.query(
          "INSERT INTO document_tags (document_id, tag_id, tenant_id, owner_id) VALUES ($1, $2, $3, $4)",
          [documentId, id, o.tenantId, o.userId],
        );
      }
      return true;
    });
  }

  async addToDocument(
    o: TagOwner,
    documentId: string,
    raw: string,
  ): Promise<DocumentTagsView | null> {
    return (await this.link(o, documentId, raw)) ? this.detail(o, documentId) : null;
  }

  async removeFromDocument(
    o: TagOwner,
    documentId: string,
    tagId: string,
  ): Promise<DocumentTagsView | null> {
    const found = await withTenant(this.pool, o.tenantId, async (tx) => {
      if (!(await lockDocument(tx, o, documentId))) return false;
      await tx.query(
        "DELETE FROM document_tags WHERE document_id = $1 AND tag_id = $2 AND owner_id = $3 AND tenant_id = $4",
        [documentId, tagId, o.userId, o.tenantId],
      );
      return true;
    });
    return found ? this.detail(o, documentId) : null;
  }

  /**
   * The owner's tags for a suggestion prompt: most used first, then by name, at most 200, each marked when this document has
   * it. Null when the document is not the owner's.
   */
  async suggestionContext(ref: TagOwner & { documentId: string }): Promise<ExistingTag[] | null> {
    const rows = await withTenant(this.pool, ref.tenantId, async (tx) => {
      if (!(await lockDocumentRead(tx, ref))) return null;
      return (
        await tx.query<NameRow & { uses: number; linked: boolean | null }>(
          `SELECT t.id, t.name_enc, count(dt.document_id)::int AS uses, bool_or(dt.document_id = $3) AS linked
             FROM tags t
             LEFT JOIN document_tags dt
               ON dt.tag_id = t.id AND dt.owner_id = t.owner_id AND dt.tenant_id = t.tenant_id
            WHERE t.owner_id = $1 AND t.tenant_id = $2
            GROUP BY t.id`,
          [ref.userId, ref.tenantId, ref.documentId],
        )
      ).rows;
    });
    if (rows === null) return null;
    const meta = new Map(rows.map((r) => [r.id, r]));
    return (await this.open(ref, rows))
      .sort(
        (a, b) =>
          (meta.get(b.id)?.uses ?? 0) - (meta.get(a.id)?.uses ?? 0) ||
          collator.compare(a.name, b.name) ||
          (a.id < b.id ? -1 : 1),
      )
      .slice(0, MAX_TAGS_PER_USER)
      .map((t) => ({ id: t.id, name: t.name, linked: meta.get(t.id)?.linked === true }));
  }

  /** Replaces the document's suggestions (an empty list removes the row). False when the document is not the owner's. */
  async putSuggestions(
    ref: TagOwner & { documentId: string },
    names: readonly string[],
  ): Promise<boolean> {
    const sealed =
      names.length === 0
        ? null
        : await this.fields.forUser(ref.userId).seal(suggestionsBind(ref.documentId), [...names]);
    return withTenant(this.pool, ref.tenantId, async (tx) => {
      if (sealed === null) {
        const exists = await lockDocumentRead(tx, ref);
        await tx.query(
          "DELETE FROM document_tag_suggestions WHERE document_id = $1 AND owner_id = $2 AND tenant_id = $3",
          [ref.documentId, ref.userId, ref.tenantId],
        );
        return exists;
      }
      // The SELECT names owner and tenant, and the composite foreign key ties the row to that document, so the conflict
      // target (the document's own row) can only ever be the owner's.
      const r = await tx.query(
        `INSERT INTO document_tag_suggestions (document_id, tenant_id, owner_id, names_enc)
         SELECT d.id, d.tenant_id, d.owner_id, $4::jsonb
           FROM documents d WHERE d.id = $1 AND d.owner_id = $2 AND d.tenant_id = $3
         ON CONFLICT (document_id) DO UPDATE SET names_enc = EXCLUDED.names_enc, updated_at = now()`,
        [ref.documentId, ref.userId, ref.tenantId, JSON.stringify(sealed)],
      );
      return r.rowCount === 1;
    });
  }

  /** Removes one name from the suggestions with a compare-and-set on the row's timestamp (no key call under a lock); gives up after 3 lost races. */
  private async removeSuggestion(o: TagOwner, documentId: string, raw: string): Promise<void> {
    const norm = normaliseTagName(raw);
    if (norm === null) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      const cur = await this.readSuggestions(o, documentId);
      if (!cur || cur.stamp === null) return;
      const kept = cur.names.filter((n) => normaliseTagName(n) !== norm);
      if (kept.length === cur.names.length) return;
      const sealed =
        kept.length === 0
          ? null
          : await this.fields.forUser(o.userId).seal(suggestionsBind(documentId), kept);
      const done = await withTenant(this.pool, o.tenantId, async (tx) => {
        const r =
          sealed === null
            ? await tx.query(
                `DELETE FROM document_tag_suggestions
                  WHERE document_id = $1 AND owner_id = $2 AND tenant_id = $3 AND updated_at::text = $4`,
                [documentId, o.userId, o.tenantId, cur.stamp],
              )
            : await tx.query(
                `UPDATE document_tag_suggestions SET names_enc = $5::jsonb, updated_at = now()
                  WHERE document_id = $1 AND owner_id = $2 AND tenant_id = $3 AND updated_at::text = $4`,
                [documentId, o.userId, o.tenantId, cur.stamp, JSON.stringify(sealed)],
              );
        return r.rowCount === 1;
      });
      if (done) return;
    }
  }

  async accept(o: TagOwner, documentId: string, raw: string): Promise<DocumentTagsView | null> {
    if (!(await this.link(o, documentId, raw))) return null;
    await this.removeSuggestion(o, documentId, raw);
    return this.detail(o, documentId);
  }

  async dismiss(o: TagOwner, documentId: string, raw: string): Promise<DocumentTagsView | null> {
    const exists = await this.readSuggestions(o, documentId);
    if (!exists) return null;
    await this.removeSuggestion(o, documentId, raw);
    return this.detail(o, documentId);
  }
}

async function lockDocumentRead(
  tx: PoolClient,
  o: TagOwner & { documentId: string },
): Promise<boolean> {
  const { rowCount } = await tx.query(
    "SELECT 1 FROM documents WHERE id = $1 AND owner_id = $2 AND tenant_id = $3",
    [o.documentId, o.userId, o.tenantId],
  );
  return rowCount === 1;
}
```

Also update the comment at `apps/server/app/erasure/pgSteps.ts:65` so it reads `... cascade to sessions, documents (chunks, parsed text, links, entities, visual facts), tags (with their links and suggestions) and chats ...` (the foreign keys of 0036 reference `users` and `documents` with `ON DELETE CASCADE`; no code change).

- [ ] **Step 5: Run the suite, the tenancy suite and the checks**

Run: `set -a; . ./.env; set +a; pnpm --filter @docmind/server exec vitest run app/tags app/db/tenancy.test.ts && pnpm typecheck && pnpm typecheck:tests && pnpm lint`
Expected: PASS, and the vitest summary shows `service.pg.test.ts` ran (not skipped). `db/tenancy.test.ts` ("has row-level security on every table") passes with the three new tables.

- [ ] **Step 6: Commit**

```bash
git add infra/migrations/0036_document_tags.sql apps/server/app/tags apps/server/app/erasure/pgSteps.ts
git commit -m "feat(tags): migration 0036 (tags, links, suggestions) and the TagService"
```

---

## Task 3: Tag and document-tag routes, the listing filter, `tags` on documents

**Files:**
- Modify: `packages/contracts/src/documents.ts` (`DocumentDto`, `ListDocumentsQuery`), `packages/contracts/src/documents.test.ts`
- Create: `apps/server/app/tags/routes.ts` (also exports `authed`, `answering`, `idOf` and `notFound`, which Task 5's routes reuse)
- Modify: `apps/server/app/documents/cursor.ts`, `apps/server/app/documents/cursor.test.ts`
- Modify: `apps/server/app/documents/repo.ts` (`toDto`, `listDocumentsQuery`, `listDocuments`)
- Modify: `apps/server/app/documents/routes.ts` (deps, list, detail, upload duplicate, retry)
- Modify: `apps/server/app/ui/readers.ts` (deps, `documents`, `document`)
- Modify: `apps/server/app/chats/tools/pgDocumentReads.ts` (the listing now names the tenant)
- Modify: `apps/server/app/compose.ts` (build the `TagService`, mount the routes, give it to the document routes and readers, return it)
- Modify: `apps/server/app/documents/testHarness.ts` (a `tags` service and the routes; the shared helpers `callApi`, `errorCode`, `seedNext`)
- Modify (their callers of the changed signatures): `apps/server/app/documents/repo.pg.test.ts` (`toDto` takes a fourth argument), `apps/server/app/ui/ui.pg.test.ts` (`readersFor` deps need `tags`)
- Test: `apps/server/app/tags/routes.pg.test.ts`, `apps/server/app/documents/tags.list.pg.test.ts`, `apps/server/app/documents/tags.explain.pg.test.ts`
- Modify (mechanical): every fixture `pnpm typecheck:tests` flags for the new required `tags` (likely `packages/experiences/src/{terminal,hydrate,reshapers}.test.ts`, `apps/web/src/{ui/session,state/uploads,api/client}.test.ts`, `apps/web/src/components/{dm-doc-detail,dm-upload-zone,dm-documents-page}.test.ts`, `apps/web/src/testing/fakeServer.ts`, and server tests that build a `DocumentDto`): add `tags: []`

**Interfaces:**
- Consumes: `TagService` and its errors (Task 2); contracts from Task 1 (`TagNameRequest`, `SetDocumentTagsRequest`, `ListTagsResponse`, `TagResponse`, `DocumentTagsResponse`, `TagIdList`, `TagMatch`, `DocumentTag`); `readJson` (`http/body.ts`), `requireAuth`, `json`, `sendError`, `withTenant`.
- Produces:
  - `DocumentDto.tags: DocumentTag[]` (required) and `DocumentDto.suggestedTags?: string[]` (detail only)
  - `ListDocumentsQuery.tags?: string[]` (parsed), `ListDocumentsQuery.match: "any" | "all"`
  - `toDto(row, cipher, view, extra: { tags: DocumentTag[]; suggestedTags?: string[] })`
  - `interface TagFilter { tagIds: readonly string[]; match: "any" | "all" }`; `listDocumentsQuery(ownerId, page: { cursor; limit; tenantId: string; filter?: TagFilter }): { sql: string; params: unknown[] }` (`tenantId` is required: every listing names the owner and the tenant); `listDocuments(tx, ownerId, page)` (same page type)
  - `filterFingerprint(filter: { tagIds: readonly string[]; match: "any" | "all" } | undefined): string` (`""` for none, else 16 hex); `encodeCursor(row, fingerprint?)`; `decodeCursor(c): { t: string; i: string; f?: string } | null`
  - `tagRoutes(deps: { authenticator: Authenticator; tags: TagService }): Record<string, Handler>`; also exported from `tags/routes.ts`: `authed(authenticator): (handler: AuthedHandler) => Handler` (session, `no-store`, the service's errors as answers), `answering`, `idOf`, `notFound`
  - test helpers in `documents/testHarness.ts`: `callApi(h, user | null, method, path, body?, type?)`, `errorCode(res)`, `seedNext(h, who?)`
  - `DocumentRoutesDeps.tags: TagService`; `UiReaderDeps.tags: Pick<TagService, "forDocuments" | "detail">`; `DocumentHarness.tags: TagService`

- [ ] **Step 1: Contracts, test first**

In `packages/contracts/src/documents.test.ts` add `tags: []` to the `DocumentDto` fixtures and these cases (the file already imports from `./documents`; add `ListDocumentsQuery` and `DocumentDto` to its imports if absent):

```ts
describe("document tags in the contracts", () => {
  const base = {
    id: "00000000-0000-4000-8000-000000000001",
    title: "t",
    filename: "f",
    mime: "text/plain",
    sizeBytes: 1,
    status: "ready",
    error: null,
    stats: null,
    summary: null,
    createdAt: "2026-11-10T10:00:00.000Z",
    updatedAt: "2026-11-10T10:00:00.000Z",
  };
  it("DocumentDto needs tags and may carry suggestedTags", () => {
    expect(DocumentDto.safeParse(base).success).toBe(false);
    expect(DocumentDto.safeParse({ ...base, tags: [] }).success).toBe(true);
    expect(DocumentDto.safeParse({ ...base, tags: [], suggestedTags: ["a"] }).success).toBe(true);
  });
  it("ListDocumentsQuery reads tags and match, with any as the default", () => {
    const a = "00000000-0000-4000-8000-00000000000a";
    expect(ListDocumentsQuery.parse({})).toMatchObject({ match: "any" });
    expect(ListDocumentsQuery.parse({ tags: `${a}`, match: "all" })).toMatchObject({
      tags: [a],
      match: "all",
    });
    expect(ListDocumentsQuery.safeParse({ tags: "nope" }).success).toBe(false);
    expect(ListDocumentsQuery.safeParse({ match: "some" }).success).toBe(false);
  });
});
```

Run: `pnpm --filter @docmind/contracts exec vitest run src/documents.test.ts` Expected: FAIL.

In `packages/contracts/src/documents.ts` add `import { DocumentTag, TagIdList, TagMatch } from "./tags";`, add to `DocumentDto` (after `summary`):

```ts
  /** The document's tags, by name. */
  tags: z.array(DocumentTag),
  /** Names the model suggested and the user has not accepted or dismissed: filled by the detail read only. */
  suggestedTags: z.array(z.string()).optional(),
```

and replace `ListDocumentsQuery` with:

```ts
export const ListDocumentsQuery = z.object({
  cursor: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Comma-separated tag ids; empty or absent is no filter. */
  tags: TagIdList.optional(),
  /** Any: a document with at least one of the tags; all: a document with every one. Ignored without tags. */
  match: TagMatch.default("any"),
});
```

Run the contracts suite again. Expected: PASS.

- [ ] **Step 2: The cursor carries a filter fingerprint, test first**

Append to `apps/server/app/documents/cursor.test.ts` (it already imports `decodeCursor`/`encodeCursor`; add `filterFingerprint`):

```ts
describe("the filter fingerprint", () => {
  const row = { created_cursor: "2026-11-10T10:00:00.123456Z", id: "00000000-0000-4000-8000-000000000001" };
  const a = "00000000-0000-4000-8000-00000000000a";
  const b = "00000000-0000-4000-8000-00000000000b";
  it("is empty without a filter and 16 hex characters with one, whatever the id order or case", () => {
    expect(filterFingerprint(undefined)).toBe("");
    expect(filterFingerprint({ tagIds: [], match: "all" })).toBe("");
    const f = filterFingerprint({ tagIds: [a, b], match: "any" });
    expect(f).toMatch(/^[0-9a-f]{16}$/);
    expect(filterFingerprint({ tagIds: [b.toUpperCase(), a], match: "any" })).toBe(f);
    expect(filterFingerprint({ tagIds: [a, b], match: "all" })).not.toBe(f);
    expect(filterFingerprint({ tagIds: [a], match: "any" })).not.toBe(f);
  });
  it("treats match as any for a single tag", () => {
    expect(filterFingerprint({ tagIds: [a], match: "all" })).toBe(
      filterFingerprint({ tagIds: [a], match: "any" }),
    );
  });
  it("is carried in the cursor only when there is one, and an older cursor still decodes", () => {
    expect(decodeCursor(encodeCursor(row))).toEqual({ t: row.created_cursor, i: row.id });
    const f = filterFingerprint({ tagIds: [a], match: "any" });
    expect(decodeCursor(encodeCursor(row, f))).toEqual({ t: row.created_cursor, i: row.id, f });
    const forged = Buffer.from(JSON.stringify({ t: row.created_cursor, i: row.id, f: "zz" })).toString("base64url");
    expect(decodeCursor(forged)).toBeNull();
  });
});
```

Run it. Expected: FAIL. Then edit `apps/server/app/documents/cursor.ts`: add `import { createHash } from "node:crypto";` at the top, add `f: z.string().regex(/^[0-9a-f]{16}$/).optional(),` to the `Body` object after `i`, and replace the two functions and add the fingerprint:

```ts
/**
 * Names the filter a cursor was issued for: 16 hex characters of SHA-256 over `<match>|<sorted ids>`, `""` for no filter. A
 * cursor reused under another filter would skip or repeat rows, so the route refuses it. One tag is `any` whatever `match` says.
 */
export function filterFingerprint(
  filter: { tagIds: readonly string[]; match: "any" | "all" } | undefined,
): string {
  if (!filter || filter.tagIds.length === 0) return "";
  const ids = [...new Set(filter.tagIds.map((s) => s.toLowerCase()))].sort();
  const match = ids.length > 1 ? filter.match : "any";
  return createHash("sha256").update(`${match}|${ids.join(",")}`).digest("hex").slice(0, 16);
}

export function encodeCursor(
  row: { created_cursor: string; id: string },
  fingerprint = "",
): string {
  return Buffer.from(
    JSON.stringify({ t: row.created_cursor, i: row.id, ...(fingerprint !== "" && { f: fingerprint }) }),
  ).toString("base64url");
}

export function decodeCursor(cursor: string): { t: string; i: string; f?: string } | null {
  try {
    const parsed = Body.safeParse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
```

Run `pnpm --filter @docmind/server exec vitest run app/documents/cursor.test.ts`. Expected: PASS (the old tests that `toEqual({t, i})` still pass: `f` is absent).

- [ ] **Step 3: Write the failing listing and route tests**

First extend the harness. In `apps/server/app/documents/testHarness.ts`:
- add imports `import { TagKeys } from "../crypto/tagKeys";`, `import { TagService } from "../tags/service";`, `import { tagRoutes } from "../tags/routes";`
- add to `DocumentHarness`: `/** The tag service the routes use. */ tags: TagService;`
- in `startDocumentServer`, right after `const fields = new FieldCrypto(keys);` add `const tags = new TagService(app, fields, new TagKeys(keys));`
- pass `tags` in the object given to `wrap({ pool: app, … })` (a new line `tags,` after `starts: new StartScheduler(ingest.port),`)
- in `createHttpServer({ ...documentRoutes({ ...wrapped, starts }),` add `...tagRoutes({ authenticator: testAuthenticator, tags: wrapped.tags }),` and, in the `readers: {…}` object, `tags: wrapped.tags,`
- add `tags: wrapped.tags,` to the returned harness object;
- add these exported helpers, which every tag route test shares (Tasks 3, 5 and 8 import them; no test file keeps its own copy):

```ts
/** A request to the harness server as a test user (`null`: no session). A string body is sent as it is. */
export const callApi = (
  h: Pick<DocumentHarness, "base">,
  user: string | null,
  method: string,
  path: string,
  body?: unknown,
  type = "application/json",
) =>
  fetch(`${h.base}${path}`, {
    method,
    headers: {
      ...(user && { "x-test-user": user }),
      ...(body !== undefined && { "content-type": type }),
    },
    ...(body !== undefined && { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });

/** The `error.code` of a failed answer. */
export const errorCode = async (res: Response) =>
  ((await res.json()) as { error?: { code?: string } }).error?.code;

let seeded = 0;
/** One document of `who` with a content address no other document made by this helper shares (the counter is per test file). */
export const seedNext = (
  h: Pick<DocumentHarness, "owner" | "app" | "keys">,
  who: Identity = ALICE,
) =>
  seedDoc(
    h.owner,
    h.app,
    new FieldCrypto(h.keys),
    who,
    (++seeded).toString(16).padStart(64, "0"),
    0,
  );
```

Create `apps/server/app/tags/routes.pg.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import {
  type DocumentDto,
  DocumentTagsResponse,
  ListTagsResponse,
  TagResponse,
} from "@docmind/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PG_URL } from "../db/testSupport";
import {
  ALICE,
  BOB,
  type DocumentHarness,
  callApi,
  errorCode as code,
  seedNext,
  startDocumentServer,
} from "../documents/testHarness";

describe.skipIf(!PG_URL)("tag routes (needs DOCMIND_TEST_PG_URL)", () => {
  let h: DocumentHarness;
  beforeAll(async () => {
    h = await startDocumentServer();
  });
  afterAll(async () => void (await h?.close()));
  beforeEach(async () => {
    await h.owner.query("DELETE FROM tags");
    await h.owner.query("DELETE FROM documents");
  });
  const call = (user: string | null, method: string, path: string, body?: unknown, type?: string) =>
    callApi(h, user, method, path, body, type);
  const seed = (who = ALICE) => seedNext(h, who);
  const mk = async (user: string, name: string) =>
    TagResponse.parse(await (await call(user, "POST", "/api/tags", { name })).json()).tag;

  it("needs a session, JSON, and a valid name", async () => {
    expect((await call(null, "GET", "/api/tags")).status).toBe(401);
    expect((await call("alice", "POST", "/api/tags", '{"name":"a"}', "text/plain")).status).toBe(
      415,
    );
    for (const name of ["", "   ", "x".repeat(41), "a\nb"]) {
      const res = await call("alice", "POST", "/api/tags", { name });
      expect([res.status, await code(res)]).toEqual([400, "invalid_request"]);
    }
    expect((await call("alice", "POST", "/api/tags", { name: "a", extra: 1 })).status).toBe(400);
  });

  it("creates with 201, reuses the same normalised name with 200, and never caches", async () => {
    const first = await call("alice", "POST", "/api/tags", { name: "Q3 Report" });
    expect(first.status).toBe(201);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const t = TagResponse.parse(await first.json()).tag;
    const again = await call("alice", "POST", "/api/tags", { name: " q3   REPORT " });
    expect([again.status, TagResponse.parse(await again.json()).tag]).toEqual([200, t]);
    expect((await mk("bob", "Q3 Report")).id).not.toBe(t.id); // per user
  });

  it("lists the caller's tags with document counts, sorted by name", async () => {
    const d = await seed();
    await call("alice", "POST", `/api/documents/${d}/tags`, { name: "banana" });
    await mk("alice", "Apple");
    await mk("bob", "bob-only");
    const res = await call("alice", "GET", "/api/tags");
    expect(ListTagsResponse.parse(await res.json()).tags.map((t) => [t.name, t.documents])).toEqual(
      [
        ["Apple", 0],
        ["banana", 1],
      ],
    );
  });

  it("renames, answers 409 tag_exists on a collision, and 404 for a foreign or malformed id", async () => {
    const a = await mk("alice", "alpha");
    const b = await mk("alice", "beta");
    const ok = await call("alice", "PATCH", `/api/tags/${a.id}`, { name: "Alpha 2" });
    expect([ok.status, TagResponse.parse(await ok.json()).tag]).toEqual([
      200,
      { id: a.id, name: "Alpha 2" },
    ]);
    const clash = await call("alice", "PATCH", `/api/tags/${b.id}`, { name: " ALPHA  2" });
    expect([clash.status, await code(clash)]).toEqual([409, "tag_exists"]);
    expect((await call("bob", "PATCH", `/api/tags/${a.id}`, { name: "x" })).status).toBe(404);
    expect((await call("alice", "PATCH", "/api/tags/not-a-uuid", { name: "x" })).status).toBe(404);
  });

  it("deletes a tag and its links; a foreign id is 404", async () => {
    const d = await seed();
    const t = await mk("alice", "gone");
    await call("alice", "PUT", `/api/documents/${d}/tags`, { tagIds: [t.id] });
    expect((await call("bob", "DELETE", `/api/tags/${t.id}`)).status).toBe(404);
    expect((await call("alice", "DELETE", `/api/tags/${t.id}`)).status).toBe(204);
    expect((await h.owner.query("SELECT count(*)::int AS n FROM document_tags")).rows[0].n).toBe(0);
    expect((await call("alice", "DELETE", `/api/tags/${t.id}`)).status).toBe(404);
  });

  it("sets a document's tags: 400 invalid_tag for a foreign or unknown id, 404 for a document that is not yours, 400 over 20", async () => {
    const d = await seed();
    const mine = await mk("alice", "mine");
    const theirs = await mk("bob", "theirs");
    const ok = await call("alice", "PUT", `/api/documents/${d}/tags`, { tagIds: [mine.id] });
    expect(DocumentTagsResponse.parse(await ok.json()).tags).toEqual([mine]);
    for (const id of [theirs.id, randomUUID()]) {
      const bad = await call("alice", "PUT", `/api/documents/${d}/tags`, { tagIds: [id] });
      expect([bad.status, await code(bad)]).toEqual([400, "invalid_tag"]);
    }
    const bobDoc = await seed(BOB);
    expect(
      (await call("alice", "PUT", `/api/documents/${bobDoc}/tags`, { tagIds: [] })).status,
    ).toBe(404);
    const many = Array.from({ length: 21 }, () => randomUUID());
    expect((await call("alice", "PUT", `/api/documents/${d}/tags`, { tagIds: many })).status).toBe(
      400,
    );
  });

  it("adds by name (creating or reusing), removes one, and refuses a 21st with 409 tag_limit", async () => {
    const d = await seed();
    const add = (name: string) => call("alice", "POST", `/api/documents/${d}/tags`, { name });
    const finance = DocumentTagsResponse.parse(await (await add("Finance")).json()).tags;
    expect(finance.map((t) => t.name)).toEqual(["Finance"]);
    expect(DocumentTagsResponse.parse(await (await add("finance")).json()).tags).toHaveLength(1);
    for (let i = 0; i < 19; i++) await add(`t${i}`);
    const over = await add("one more");
    expect([over.status, await code(over)]).toEqual([409, "tag_limit"]);
    const id = (finance[0] as { id: string }).id;
    const removed = await call("alice", "DELETE", `/api/documents/${d}/tags/${id}`);
    expect(DocumentTagsResponse.parse(await removed.json()).tags.map((t) => t.name)).not.toContain(
      "Finance",
    );
    expect((await call("bob", "DELETE", `/api/documents/${d}/tags/${id}`)).status).toBe(404);
    expect((await call("alice", "DELETE", `/api/documents/${d}/tags/not-a-uuid`)).status).toBe(404);
  });

  it("puts tags on the list rows and tags with suggestedTags on the detail", async () => {
    const d = await seed();
    await call("alice", "POST", `/api/documents/${d}/tags`, { name: "one" });
    await h.tags.putSuggestions({ ...ALICE, documentId: d }, ["maybe"]);
    const detail = (await (
      await call("alice", "GET", `/api/documents/${d}`)
    ).json()) as DocumentDto;
    expect([detail.tags.map((t) => t.name), detail.suggestedTags]).toEqual([["one"], ["maybe"]]);
    const list = (await (await call("alice", "GET", "/api/documents")).json()) as {
      items: DocumentDto[];
    };
    expect(list.items[0]?.tags.map((t) => t.name)).toEqual(["one"]);
    expect(list.items[0]?.suggestedTags).toBeUndefined();
  });
});
```

Create `apps/server/app/documents/tags.list.pg.test.ts`:

```ts
import { type DocumentDto, ListDocumentsResponse } from "@docmind/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FieldCrypto } from "../crypto/fields";
import { PG_URL } from "../db/testSupport";
import { ALICE, ALICE2, type DocumentHarness, seedDoc, startDocumentServer } from "./testHarness";

describe.skipIf(!PG_URL)("GET /api/documents with a tag filter (needs DOCMIND_TEST_PG_URL)", () => {
  let h: DocumentHarness;
  let docs: string[]; // d1 is the newest
  let tag: Record<"a" | "b" | "c", string>;
  beforeAll(async () => {
    h = await startDocumentServer();
  });
  afterAll(async () => void (await h?.close()));
  beforeEach(async () => {
    await h.owner.query("DELETE FROM tags");
    await h.owner.query("DELETE FROM documents");
    const fields = new FieldCrypto(h.keys);
    docs = [];
    for (let i = 0; i < 7; i++)
      docs.push(
        await seedDoc(
          h.owner,
          h.app,
          fields,
          ALICE,
          (i + 1).toString(16).padStart(64, "0"),
          (i + 1) * 10,
        ),
      );
    const mk = async (name: string) => (await h.tags.create(ALICE, name)).tag.id;
    tag = { a: await mk("a"), b: await mk("b"), c: await mk("c") };
    const link = (name: "a" | "b" | "c", idx: number[]) =>
      Promise.all(
        idx.map((i) =>
          h.owner.query(
            "INSERT INTO document_tags (document_id, tag_id, tenant_id, owner_id) SELECT $1, $2, tenant_id, owner_id FROM documents WHERE id = $1",
            [docs[i], tag[name]],
          ),
        ),
      );
    await link("a", [0, 1, 2, 4]);
    await link("b", [1, 2, 3]);
    await link("c", [2]);
  });
  const get = (user: string, qs: string) =>
    fetch(`${h.base}/api/documents?${qs}`, { headers: { "x-test-user": user } });
  const ids = async (res: Response) =>
    (ListDocumentsResponse.parse(await res.json()).items as DocumentDto[]).map((d) => d.id);
  const at = (...i: number[]) => i.map((x) => docs[x]);

  it("any: a document with at least one of the tags; all: with every one; newest first", async () => {
    expect(await ids(await get("alice", `tags=${tag.a},${tag.b}`))).toEqual(at(0, 1, 2, 3, 4));
    expect(await ids(await get("alice", `tags=${tag.a},${tag.b}&match=any`))).toEqual(
      at(0, 1, 2, 3, 4),
    );
    expect(await ids(await get("alice", `tags=${tag.a},${tag.b}&match=all`))).toEqual(at(1, 2));
    expect(await ids(await get("alice", `tags=${tag.a},${tag.b},${tag.c}&match=all`))).toEqual(
      at(2),
    );
    expect(await ids(await get("alice", `tags=${tag.a}&match=all`))).toEqual(at(0, 1, 2, 4)); // one tag: same as any
    expect(await ids(await get("alice", "match=all"))).toHaveLength(7); // no tags: unfiltered, match ignored
    expect(await ids(await get("alice", "tags="))).toHaveLength(7);
  });

  it("pages with no duplicate and no gap in both modes", async () => {
    for (const [qs, want] of [
      [`tags=${tag.a},${tag.b}`, at(0, 1, 2, 3, 4)],
      [`tags=${tag.a},${tag.b}&match=all`, at(1, 2)],
      ["", docs],
    ] as const) {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 10; guard++) {
        const res: Response = await get(
          "alice",
          `${qs}&limit=2${cursor ? `&cursor=${cursor}` : ""}`,
        );
        const page = ListDocumentsResponse.parse(await res.json());
        seen.push(...page.items.map((d) => d.id));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      expect(seen).toEqual(want);
    }
  });

  it("answers 400 invalid_cursor when a cursor is reused under a changed filter, and accepts the same filter", async () => {
    const first = ListDocumentsResponse.parse(
      await (await get("alice", `tags=${tag.a}&limit=1`)).json(),
    );
    const cursor = first.nextCursor as string;
    for (const qs of [
      `tags=${tag.b}`,
      `tags=${tag.a},${tag.b}`,
      "",
      `tags=${tag.a},${tag.b}&match=all`,
    ]) {
      const res = await get("alice", `${qs}&limit=1&cursor=${cursor}`);
      expect([res.status, ((await res.json()) as { error: { code: string } }).error.code]).toEqual([
        400,
        "invalid_cursor",
      ]);
    }
    expect((await get("alice", `tags=${tag.a}&match=all&limit=1&cursor=${cursor}`)).status).toBe(
      200,
    ); // one tag: same filter
    const plain = ListDocumentsResponse.parse(await (await get("alice", "limit=1")).json());
    expect((await get("alice", `tags=${tag.a}&limit=1&cursor=${plain.nextCursor}`)).status).toBe(
      400,
    );
  });

  it("refuses a malformed filter with 400 invalid_request", async () => {
    const eleven = Array.from(
      { length: 11 },
      (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
    ).join(",");
    for (const qs of ["tags=nope", `tags=${eleven}`, `tags=${tag.a}&match=some`]) {
      const res = await get("alice", qs);
      expect([res.status, ((await res.json()) as { error: { code: string } }).error.code]).toEqual([
        400,
        "invalid_request",
      ]);
    }
  });

  it("never shows another user's documents, even for a tag id that is not theirs", async () => {
    expect(await ids(await get("alice2", `tags=${tag.a}`))).toEqual([]);
    expect(await ids(await get("bob", `tags=${tag.a}&match=all`))).toEqual([]);
    await seedDoc(h.owner, h.app, new FieldCrypto(h.keys), ALICE2, "f".repeat(64), 1);
    expect(await ids(await get("alice2", ""))).toHaveLength(1);
  });
});
```

Create `apps/server/app/documents/tags.explain.pg.test.ts` (preflight F3: modelled on `ui/connections.pg.test.ts`: a deterministic seed, `ANALYZE`, the plan under the default planner settings; only the selective case asserts a plan, and the equality test is what guards the answers of `any` and `all`; it does not claim to tell the set-based `all` from the correlated count form, and has no timing assertion):

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../db/tenant";
import { PG_URL } from "../db/testSupport";
import { type PgFixture, startPgFixture } from "../flows/ingest-document/pgFixture";
import { type TagFilter, listDocumentsQuery } from "./repo";
import { T1, T2, U1, U1B, U2 } from "./testHarness";

type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
};
const walk = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(walk)];

// Like ui/connections.pg.test.ts: a seeded library, ANALYZE, the plan under the default planner settings. The ids are
// deterministic (a counter, not gen_random_uuid()), so the physical layout the planner sees is the same on every run, and
// only the selective case asserts a plan.
describe.skipIf(!PG_URL)("the tag filter on a seeded library (needs DOCMIND_TEST_PG_URL)", () => {
  let fx: PgFixture;
  let rare: string; // on 6 of U1's 600 documents
  let common: string; // on about 7% of them
  let other: string; // on about 7% of them, together with `common` on some
  beforeAll(async () => {
    fx = await startPgFixture();
    const q = (sql: string, args: unknown[] = []) => fx.db.owner.query(sql, args);
    // U1 has 600 documents; two other users hold 3000 each, so the owner predicate is selective. `base` keeps the ids apart.
    for (const [tenant, owner, docs, base] of [
      [T1, U1, 600, 0x1000],
      [T1, U1B, 3000, 0x100000],
      [T2, U2, 3000, 0x200000],
    ] as const) {
      await q(
        `INSERT INTO documents (id, tenant_id, owner_id, title_enc, filename_enc, mime, size_bytes, content_address, fingerprint, created_at)
         SELECT lpad(to_hex($4::bigint + g), 32, '0')::uuid, $1::uuid, $2::uuid, '{}', '{}', 'text/plain', 1,
                'hmac-sha256:' || lpad(to_hex($4::bigint + g), 64, '0'), lpad(to_hex($4::bigint + g), 64, '0'),
                now() - make_interval(secs => g)
           FROM generate_series(1, $3::int) g`,
        [tenant, owner, docs, base],
      );
      await q(
        `INSERT INTO tags (id, tenant_id, owner_id, name_enc, name_bind)
         SELECT lpad(to_hex($3::bigint + g), 32, '0')::uuid, $1::uuid, $2::uuid, '{}',
                decode(md5($2::text || g::text) || md5(g::text || $2::text), 'hex')
           FROM generate_series(1, 41) g`,
        [tenant, owner, base],
      );
    }
    // Three of the first 40 tags per document, by the document's rank among its owner's documents (deterministic).
    await q(
      `INSERT INTO document_tags (document_id, tag_id, tenant_id, owner_id)
       SELECT DISTINCT d.id, t.id, d.tenant_id, d.owner_id
         FROM (SELECT id, tenant_id, owner_id, row_number() OVER (PARTITION BY owner_id ORDER BY id) AS rn FROM documents) d
         JOIN (SELECT id, owner_id, row_number() OVER (PARTITION BY owner_id ORDER BY id) AS tn FROM tags) t
           ON t.owner_id = d.owner_id AND t.tn <= 40
          AND t.tn IN ((d.rn % 40) + 1, ((d.rn * 7) % 40) + 1, ((d.rn * 13) % 40) + 1)`,
    );
    const nth = async (n: number) =>
      (await q("SELECT id FROM tags WHERE owner_id = $1 ORDER BY id OFFSET $2 LIMIT 1", [U1, n]))
        .rows[0].id as string;
    common = await nth(1); // the 2nd tag
    other = await nth(7); // the 8th tag: on every document that has the 2nd and whose rank is 1 mod 40
    rare = await nth(40); // the 41st tag: on no document yet, then on 6 of those that hold `common`
    await q(
      `INSERT INTO document_tags (document_id, tag_id, tenant_id, owner_id)
       SELECT document_id, $3, tenant_id, owner_id FROM document_tags WHERE owner_id = $1 AND tag_id = $2 ORDER BY document_id LIMIT 6`,
      [U1, common, rare],
    );
    await q("ANALYZE");
  }, 120_000);
  afterAll(async () => void (await fx?.close()));

  const lit = (v: unknown) =>
    v === null ? "NULL" : Array.isArray(v) ? `'{${v.join(",")}}'` : `'${v}'`;
  const query = (filter: TagFilter, limit = 51) =>
    listDocumentsQuery(U1, { cursor: null, limit, tenantId: T1, filter });

  /** Plans and runs the listing as the app role, with the parameters as literals so the planner sees the values. */
  async function explain(filter: TagFilter) {
    const { sql, params } = query(filter);
    const inline = sql.replace(/\$(\d+)/g, (_m, i) => lit(params[Number(i) - 1]));
    return withTenant(fx.app, T1, async (tx) => {
      const res = await tx.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${inline}`);
      return walk(res.rows[0]["QUERY PLAN"][0].Plan as PlanNode);
    });
  }
  const idsOf = async (filter: TagFilter) => {
    const { sql, params } = query(filter, 1000);
    const rows = await withTenant(
      fx.app,
      T1,
      async (tx) => (await tx.query<{ id: string }>(sql, params)).rows,
    );
    return rows.map((r) => r.id).sort();
  };

  it("a rare tag is reached through the tag index, never by scanning the library", async () => {
    const nodes = await explain({ tagIds: [rare], match: "any" });
    const seq = nodes.filter((n) => n["Node Type"] === "Seq Scan").map((n) => n["Relation Name"]);
    expect(seq.filter((r) => r === "document_tags" || r === "documents")).toEqual([]);
    expect(nodes.some((n) => n["Index Name"] === "document_tags_owner_tag_idx")).toBe(true);
  });

  it("any and all return exactly what a brute-force read of the links says", async () => {
    const links = (
      await fx.db.owner.query<{ document_id: string; tag_id: string }>(
        "SELECT document_id, tag_id FROM document_tags WHERE owner_id = $1",
        [U1],
      )
    ).rows;
    const held = new Map<string, Set<string>>();
    for (const l of links)
      held.set(l.document_id, (held.get(l.document_id) ?? new Set()).add(l.tag_id));
    const brute = (tagIds: string[], match: "any" | "all") =>
      [...held]
        .filter(([, tags]) =>
          match === "all" ? tagIds.every((t) => tags.has(t)) : tagIds.some((t) => tags.has(t)),
        )
        .map(([doc]) => doc)
        .sort();
    const cases: [string[], "any" | "all"][] = [
      [[rare], "any"],
      [[rare, common], "any"],
      [[rare, common], "all"],
      [[common, other], "any"],
      [[common, other], "all"],
    ];
    for (const [tagIds, match] of cases) {
      const want = brute(tagIds, match);
      expect(want.length).toBeGreaterThan(0); // each case selects something
      expect(await idsOf({ tagIds, match })).toEqual(want);
    }
    // All is narrower than Any for two common tags: the two forms really differ on this data.
    expect((await idsOf({ tagIds: [common, other], match: "all" })).length).toBeLessThan(
      (await idsOf({ tagIds: [common, other], match: "any" })).length,
    );
  });
});
```

(The seed, the migration and the query of this task were run together before the plan was amended: the plan test and the equality test passed on three runs.)

Run: `set -a; . ./.env; set +a; pnpm --filter @docmind/server exec vitest run app/tags/routes.pg.test.ts app/documents/tags.list.pg.test.ts app/documents/tags.explain.pg.test.ts`
Expected: FAIL (`../tags/routes` and `listDocumentsQuery` do not exist).

- [ ] **Step 4: `repo.ts`: `toDto`, the listing query**

In `apps/server/app/documents/repo.ts`:
- change the first import to `import { type DocumentDto, DocumentStats, DocumentSummary, type DocumentTag } from "@docmind/contracts";`
- replace `toDto`'s signature and result:

```ts
export async function toDto(
  row: DocumentRow,
  cipher: UserFieldCipher,
  view: StatusView,
  extra: { tags: DocumentTag[]; suggestedTags?: string[] },
): Promise<DocumentDto> {
  return {
    id: row.id,
    title: await cipher.openText(titleBind(row.id), row.title_enc),
    filename: await cipher.openText(filenameBind(row.id), row.filename_enc),
    mime: row.mime,
    sizeBytes: Number(row.size_bytes),
    status: view.status,
    error: view.error,
    stats:
      row.stats_enc == null
        ? null
        : DocumentStats.parse(await cipher.open(statsBind(row.id), row.stats_enc)),
    summary:
      row.summary_enc == null
        ? null
        : DocumentSummary.parse(await cipher.open(summaryBind(row.id), row.summary_enc)),
    tags: extra.tags,
    ...(extra.suggestedTags !== undefined && { suggestedTags: extra.suggestedTags }),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
```

- replace `listDocuments` with:

```ts
export interface TagFilter {
  tagIds: readonly string[];
  match: "any" | "all";
}
export interface ListPage {
  cursor: { t: string; i: string } | null;
  limit: number;
  /** Named in every listing: the explicit tenant predicate, beside row-level security. */
  tenantId: string;
  filter?: TagFilter;
}

/**
 * The library page query. The tag filter is part of the WHERE, before the cursor's page cut, so a page is always full and a
 * cursor stays valid within one filter. Every predicate names the owner and the tenant. `any` is an EXISTS;
 * `all` takes the documents holding as many of the ids as there are ids (one tag is `any`). No user text is in the SQL.
 */
export function listDocumentsQuery(
  ownerId: string,
  page: ListPage,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [
    ownerId,
    page.cursor?.t ?? null,
    page.cursor?.i ?? null,
    page.limit + 1,
    page.tenantId,
  ];
  let where =
    "owner_id = $1 AND tenant_id = $5::uuid AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))";
  const ids = [...new Set((page.filter?.tagIds ?? []).map((t) => t.toLowerCase()))];
  if (ids.length > 0) {
    params.push(ids);
    const list = `$${params.length}::uuid[]`;
    const mine = `dt.owner_id = $1 AND dt.tenant_id = $5::uuid AND dt.tag_id = ANY(${list})`;
    where +=
      ids.length > 1 && page.filter?.match === "all"
        ? ` AND documents.id IN (SELECT dt.document_id FROM document_tags dt WHERE ${mine} GROUP BY dt.document_id HAVING count(*) = cardinality(${list}))`
        : ` AND EXISTS (SELECT 1 FROM document_tags dt WHERE dt.document_id = documents.id AND ${mine})`;
  }
  return {
    sql: `SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT $4`,
    params,
  };
}

export async function listDocuments(
  tx: PoolClient,
  ownerId: string,
  page: ListPage,
): Promise<{ rows: DocumentRow[]; next: { created_cursor: string; id: string } | null }> {
  const { sql, params } = listDocumentsQuery(ownerId, page);
  const { rows } = await tx.query<DocumentRow>(sql, params);
  const more = rows.length > page.limit;
  const kept = more ? rows.slice(0, page.limit) : rows;
  const last = kept[kept.length - 1];
  return {
    rows: kept,
    next: more && last ? { created_cursor: last.created_cursor, id: last.id } : null,
  };
}
```

(`chats/tools/pgDocumentReads.ts` is the one other caller: it passes `tenantId: scope.tenantId`, see Step 6.)

- [ ] **Step 5: The tag routes**

Create `apps/server/app/tags/routes.ts`:

```ts
import type { ServerResponse } from "node:http";
import type { Authenticator } from "@docmind/auth";
import {
  type DocumentTagsResponse,
  type ListTagsResponse,
  SetDocumentTagsRequest,
  TagNameRequest,
  type TagResponse,
  Uuid,
} from "@docmind/contracts";
import { readJson } from "../http/body";
import { type AuthedHandler, requireAuth } from "../http/requireAuth";
import { type Handler, json, sendError } from "../http/respond";
import {
  TagExistsError,
  TagLimitError,
  TagNameInvalidError,
  type TagService,
  UnknownTagError,
} from "./service";

export interface TagRoutesDeps {
  authenticator: Authenticator;
  tags: TagService;
}

/** A malformed id answers exactly like a missing or foreign one. */
export const idOf = (raw: string | undefined): string | null => {
  const p = Uuid.safeParse(raw);
  return p.success ? p.data.toLowerCase() : null;
};
export const notFound = (res: ServerResponse, what: string) =>
  sendError(res, 404, "not_found", `${what} not found`);

/** The service's errors as answers. Fixed texts: a tag name never reaches a message. */
export async function answering(res: ServerResponse, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    if (err instanceof TagLimitError)
      return sendError(
        res,
        409,
        "tag_limit",
        err.limit === "document"
          ? "a document holds at most 20 tags"
          : "you can have at most 200 tags",
      );
    if (err instanceof TagExistsError)
      return sendError(res, 409, "tag_exists", "a tag with this name already exists");
    if (err instanceof UnknownTagError) return sendError(res, 400, "invalid_tag", "unknown tag");
    if (err instanceof TagNameInvalidError)
      return sendError(res, 400, "invalid_request", "invalid tag name");
    throw err;
  }
}

/** A handler behind the session: tenant and user come from it, the answer is never cached (it carries decrypted names), the service's errors become answers. The one wrapper both route files use. */
export const authed =
  (authenticator: Authenticator) =>
  (handler: AuthedHandler): Handler =>
    requireAuth(authenticator, async (req, res, identity, ctx) => {
      res.setHeader("cache-control", "no-store");
      await answering(res, async () => void (await handler(req, res, identity, ctx)));
    });

/** The tag API (spec section 5). Every route takes tenant and user from the session. */
export function tagRoutes(deps: TagRoutesDeps): Record<string, Handler> {
  const auth = authed(deps.authenticator);
  const view = (res: ServerResponse, answer: Awaited<ReturnType<TagService["detail"]>>) =>
    answer ? json(res, 200, answer satisfies DocumentTagsResponse) : notFound(res, "document");

  return {
    "GET /api/tags": auth(async (_req, res, identity) => {
      json(res, 200, { tags: await deps.tags.list(identity) } satisfies ListTagsResponse);
    }),

    "POST /api/tags": auth(async (req, res, identity) => {
      const body = await readJson(req, res, TagNameRequest);
      if (!body) return;
      const { tag, created } = await deps.tags.create(identity, body.name);
      json(res, created ? 201 : 200, { tag } satisfies TagResponse);
    }),

    "PATCH /api/tags/:id": auth(async (req, res, identity, ctx) => {
      const body = await readJson(req, res, TagNameRequest);
      if (!body) return;
      const id = idOf(ctx.params.id);
      const tag = id ? await deps.tags.rename(identity, id, body.name) : null;
      if (!tag) return notFound(res, "tag");
      json(res, 200, { tag } satisfies TagResponse);
    }),

    "DELETE /api/tags/:id": auth(async (_req, res, identity, ctx) => {
      const id = idOf(ctx.params.id);
      if (!id || !(await deps.tags.remove(identity, id))) return notFound(res, "tag");
      res.writeHead(204);
      res.end();
    }),

    "PUT /api/documents/:id/tags": auth(async (req, res, identity, ctx) => {
      const body = await readJson(req, res, SetDocumentTagsRequest);
      if (!body) return;
      const id = idOf(ctx.params.id);
      view(res, id ? await deps.tags.setForDocument(identity, id, body.tagIds) : null);
    }),

    "POST /api/documents/:id/tags": auth(async (req, res, identity, ctx) => {
      const body = await readJson(req, res, TagNameRequest);
      if (!body) return;
      const id = idOf(ctx.params.id);
      view(res, id ? await deps.tags.addToDocument(identity, id, body.name) : null);
    }),

    "DELETE /api/documents/:id/tags/:tagId": auth(async (_req, res, identity, ctx) => {
      const id = idOf(ctx.params.id);
      const tagId = idOf(ctx.params.tagId);
      view(res, id && tagId ? await deps.tags.removeFromDocument(identity, id, tagId) : null);
    }),
  };
}
```

- [ ] **Step 6: The document routes and the UI readers**

In `apps/server/app/documents/routes.ts`:
- import `type TagService` from `../tags/service` and `filterFingerprint` with `decodeCursor, encodeCursor` from `./cursor`; add to `DocumentRoutesDeps`: `/** The tag reads: every document answer carries its tags. */ tags: TagService;`
- in `register()`, change the two `toDto(…, UPLOADED)` calls to pass `{ tags: [] }` for a new document and `{ tags: [] }` for the duplicate (the route below replaces a duplicate's tags after the transaction, so no second connection is taken under the tenant lock): `await toDto(existing, cipher, UPLOADED, { tags: [] })` and `await toDto(row, cipher, UPLOADED, { tags: [] })`.
- in `receive()`, inside `if (result.kind === "stored" && result.duplicate) {` before `const out = await restartIfFailed(…)`, add:

```ts
        const tags = (await deps.tags.forDocuments(identity, [result.row.id])).get(result.row.id) ?? [];
        result.document = { ...result.document, tags };
```

- replace the body of `"GET /api/documents"` after the query validation with:

```ts
      const tagIds = query.data.tags ?? [];
      const filter = tagIds.length > 0 ? { tagIds, match: query.data.match } : undefined;
      const fingerprint = filterFingerprint(filter);
      let cursor: { t: string; i: string; f?: string } | null = null;
      if (query.data.cursor !== undefined) {
        cursor = decodeCursor(query.data.cursor);
        // A cursor issued for another filter would skip or repeat rows.
        if (!cursor || (cursor.f ?? "") !== fingerprint)
          return sendError(res, 400, "invalid_cursor", "cursor is not valid");
      }
      // owner_id comes from the session; the cursor only positions within the caller's own rows.
      const page = await withTenant(deps.pool, identity.tenantId, (tx) =>
        listDocuments(tx, identity.userId, {
          cursor,
          limit: query.data.limit,
          tenantId: identity.tenantId,
          ...(filter && { filter }),
        }),
      );
      const cipher = deps.fields.forUser(identity.userId);
      const views = await deps.status.forPage(
        identity,
        page.rows.map((row) => ({ id: row.id, generation: row.ingest_generation })),
      );
      const tagsOf = await deps.tags.forDocuments(
        identity,
        page.rows.map((row) => row.id),
      );
      json(res, 200, {
        items: await Promise.all(
          page.rows.map((row) =>
            toDto(row, cipher, views.get(row.id) ?? UPLOADED, { tags: tagsOf.get(row.id) ?? [] }),
          ),
        ),
        nextCursor: page.next ? encodeCursor(page.next, fingerprint) : null,
      } satisfies ListDocumentsResponse);
```

- in `"GET /api/documents/:id"`, replace the last two lines with:

```ts
      const view = await deps.status.forDocument(identity, row.id, row.ingest_generation);
      const detail = await deps.tags.detail(identity, row.id);
      if (!detail) return sendError(res, 404, "not_found", "document not found"); // deleted since the read above
      json(res, 200, await toDto(row, deps.fields.forUser(identity.userId), view, detail));
```

- in `"POST /api/documents/:id/retry"`, replace the answer with:

```ts
        const cipher = deps.fields.forUser(identity.userId);
        const tags = (await deps.tags.forDocuments(identity, [out.row.id])).get(out.row.id) ?? [];
        json(res, 202, {
          document: await toDto(out.row, cipher, UPLOADED, { tags }),
        } satisfies RetryDocumentResponse);
```

In `apps/server/app/ui/readers.ts`: import `type TagService` from `../tags/service`; add `tags: Pick<TagService, "forDocuments" | "detail">;` to `UiReaderDeps`; give `listDocuments` its tenant (`{ cursor, limit: PAGE, tenantId: identity.tenantId }`); replace the page loop body so tags are read once per page for the rows kept:

```ts
        const pending: { row: (typeof page.rows)[number]; view: StatusView }[] = [];
        for (const row of page.rows) {
          // The status decides before anything is opened: only the documents returned are decrypted.
          const view = views.get(row.id) ?? UPLOADED;
          if (!keep(view.status)) continue;
          if (items.length + pending.length === limit) {
            truncated = true; // one more match than asked for
            break;
          }
          pending.push({ row, view });
        }
        const tagsOf = await deps.tags.forDocuments(
          identity,
          pending.map((p) => p.row.id),
        );
        for (const { row, view } of pending)
          items.push(shown(await toDto(row, cipher(), view, { tags: tagsOf.get(row.id) ?? [] })));
```

(import `type StatusView` from `../status/model` next to `STATUS_MESSAGES, UPLOADED`), and in `document({ id })`:

```ts
      const detail = await deps.tags.detail(identity, row.id);
      return shown(
        await toDto(
          row,
          cipher(),
          await deps.status.forDocument(identity, row.id, row.ingest_generation),
          detail ?? { tags: [] },
        ),
      );
```

In `apps/server/app/compose.ts`: add imports `import { TagKeys } from "./crypto/tagKeys";`, `import { tagRoutes } from "./tags/routes";`, `import { TagService } from "./tags/service";`; right after `const visualRuns = new PgVisualRuns(pool);` (before `buildApp`, which Task 5 gives the tags too) add `const tags = new TagService(pool, fields, new TagKeys(keys));`; add `tags,` to the `documentRoutes({ … })` argument (after `status,`) and `tags,` to the `readers: { … }` object; add `...tagRoutes({ authenticator, tags }),` right after the `...documentRoutes({ … }),` spread; and add `tags,` to the object `buildServer` returns (`/** The tag service; the erasure end-to-end seed writes a suggestion through it. */`).

In `apps/server/app/chats/tools/pgDocumentReads.ts` (line 68) the page call becomes `listDocuments(tx, scope.ownerId, { cursor: at, limit: PAGE, tenantId: scope.tenantId })` (the tenant is now required).

Callers of the two changed signatures that this task must fix itself (the typecheck of tests flags the first; the second fails at run time with a `TypeError`, not only as a type error):
- `apps/server/app/documents/repo.pg.test.ts` lines 46, 85 and 112: add the fourth argument, `toDto(…, UPLOADED, { tags: [] })`.
- `apps/server/app/ui/ui.pg.test.ts` (the `readersFor({ pool: h.app, fields: counting, … })` call near line 228, and every other `UiReaderDeps` literal that `grep -rn "visualFacts: new PgVisualFacts" apps/server` finds): add `tags: new TagService(h.app, fields, new TagKeys(h.keys)),` (imports `TagKeys` from `../crypto/tagKeys` and `TagService` from `../tags/service`; use the file's own pool, fields and key store variables).

- [ ] **Step 7: Run everything**

Run: `set -a; . ./.env; set +a; pnpm typecheck && pnpm typecheck:tests` and fix every fixture it flags by adding `tags: []` (and the new `tags` dependency to any test that builds `DocumentRoutesDeps` or `UiReaderDeps`: `grep -rn "visualFacts: new PgVisualFacts" apps/server`; give them `tags: new TagService(app, fields, new TagKeys(keys))`).
Then: `pnpm --filter @docmind/server exec vitest run app/tags app/documents app/ui app/db/tenancy.test.ts` and `pnpm --filter @docmind/contracts exec vitest run` and `pnpm --filter @docmind/experiences exec vitest run` and `pnpm --filter @docmind/web exec vitest run`, then `pnpm lint`.
Expected: PASS; the vitest summary shows the three new pg files ran.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(tags): tag routes, document tags and the tag filter on the document listing"
```

---

## Task 4: Ingest suggestions

**Files:**
- Modify: `apps/server/app/flows/ingest-document/summarize/prompts.ts`, `summarize/summarize.ts`
- Modify: `apps/server/app/flows/ingest-document/steps/summarize.ts`, `apps/server/app/flows/ingest-document/pgDeps.ts`
- Test: `summarize/pack.test.ts`, `summarize/summarize.test.ts`, `steps/summarize.test.ts` (extend); create `apps/server/app/flows/ingest-document/flowHash.test.ts`, `apps/server/app/flows/ingest-document/steps/summarize.tags.pg.test.ts`

**Interfaces:**
- Consumes: `normaliseSuggestions`, `tagInstruction`, `parseSuggestedTags`, `ExistingTag` (Task 1); `TagService.suggestionContext` and `putSuggestions` (Task 2); `isDocumentGone`, `isAbort` (`ingest-document/errors.ts`); `FieldKeyStoreError`.
- Produces:
  - `reduceInstruction(existing: readonly string[]): string` (replaces the constant `REDUCE_INSTRUCTION`)
  - `ReduceAnswer` output `DocumentSummary & { suggestedTags: string[] }`
  - `SummaryRun.suggestedTags: string[]` (the model's names, not yet normalised; the `summary` field is a plain `DocumentSummary`); option `existingTags?: readonly string[]` of `summarizeDocument`
  - `SummarizeDeps.tags?: Pick<TagService, "suggestionContext" | "putSuggestions">`

- [ ] **Step 1: Write the failing tests**

Append to `apps/server/app/flows/ingest-document/summarize/pack.test.ts` (inside the existing file, a new `describe`; `ReduceAnswer` is already imported):

```ts
describe("ReduceAnswer suggestedTags", () => {
  const base = { tldr: "t", keyPoints: [], entities: [], topics: [], suggestedQuestions: [] };
  it("keeps the strings of an array, up to 20", () => {
    expect(ReduceAnswer.parse({ ...base, suggestedTags: ["a", 1, "b"] }).suggestedTags).toEqual(["a", "b"]);
    const many = Array.from({ length: 30 }, (_, i) => `t${i}`);
    expect(ReduceAnswer.parse({ ...base, suggestedTags: many }).suggestedTags).toHaveLength(20);
  });
  it("is [] when missing or malformed, and never fails the summary", () => {
    for (const bad of [undefined, null, "a,b", 42, { a: 1 }]) {
      const out = ReduceAnswer.parse({ ...base, suggestedTags: bad });
      expect(out.suggestedTags).toEqual([]);
      expect(out.tldr).toBe("t");
    }
    expect(ReduceAnswer.parse(base).suggestedTags).toEqual([]);
  });
});
```

Append to `summarize/summarize.test.ts` (`scripted`, `doc`, `isReduce` exist there; add `reduceInstruction` to the import from `./prompts`: `import { reduceInstruction } from "./prompts";`):

```ts
describe("summarizeDocument tag suggestions", () => {
  const withTags = (suggestedTags: unknown) =>
    JSON.stringify({
      tldr: "T",
      keyPoints: ["k"],
      entities: ["Acme"],
      topics: ["t"],
      suggestedQuestions: ["q?"],
      suggestedTags,
    });
  const userText = (r: LlmRequest) => JSON.stringify(r.messages);

  it("returns the model's suggested names beside a summary that does not carry them", async () => {
    const { provider } = scripted({ reduce: () => withTags(["Finance", "Q3"]) });
    const out = await summarizeDocument(provider, doc(["one"]), { maxChars: 1_000 });
    expect(out?.suggestedTags).toEqual(["Finance", "Q3"]);
    expect(out?.summary).toEqual({
      tldr: "T",
      keyPoints: ["k"],
      entities: ["Acme"],
      topics: ["t"],
      suggestedQuestions: ["q?"],
    });
  });

  it("asks for the tags in the reduce call only, listing the existing ones as quoted JSON", async () => {
    const { provider, requests } = scripted();
    await summarizeDocument(provider, doc(["a", "b"]), {
      maxChars: 1_000,
      groupChars: 1,
      existingTags: ["Finance", 'say "hi"'],
    });
    const reduce = requests.filter(isReduce);
    expect(reduce).toHaveLength(1);
    expect(userText(reduce[0] as LlmRequest)).toContain('[\\"Finance\\",\\"say \\\\\\"hi\\\\\\"\\"]');
    for (const r of requests.filter((x) => !isReduce(x)))
      expect(userText(r)).not.toContain("suggestedTags");
  });

  it("asks for up to 3 new names when the user has no tags", async () => {
    const { provider, requests } = scripted();
    await summarizeDocument(provider, doc(["one"]), { maxChars: 1_000 });
    expect(userText(requests.filter(isReduce)[0] as LlmRequest)).toContain("up to 3 short topic tags");
  });

  it("a missing or malformed suggestedTags is [] and the summary still comes back", async () => {
    for (const reduce of [() => withTags(undefined), () => withTags(42), () => REDUCE]) {
      const out = await summarizeDocument(scripted({ reduce }).provider, doc(["one"]), { maxChars: 1_000 });
      expect(out?.suggestedTags).toEqual([]);
      expect(out?.summary.tldr).toBe("T");
    }
  });

  it("reduceInstruction names every summary field and suggestedTags", () => {
    expect(reduceInstruction([])).toContain('"suggestedTags"');
    expect(reduceInstruction([])).toContain('"suggestedQuestions"');
  });
});
```

Extend `steps/summarize.test.ts` (the `import` lines in the block below belong at the top of the file with the others). In the file's `deps()` helper, add `tags?: Pick<TagService, "suggestionContext" | "putSuggestions">;` to the `over` type (`import type { TagService } from "../../../tags/service";`), and `...(over.tags && { tags: over.tags }),` to the `d` object next to `...(over.llm && { llm: over.llm })`. Then append:

```ts
import { FieldKeyStoreError } from "../../../crypto/fields";
import type { ExistingTag } from "../../../tags/suggestions";

const reduceWith = (suggestedTags: unknown) =>
  JSON.stringify({ tldr: "T", keyPoints: ["k"], entities: ["Acme"], topics: ["t"], suggestedQuestions: ["q?"], suggestedTags });

function tagsLlm(reduce: string, seen: LlmRequest[] = []): LlmProvider {
  return Object.assign(
    {
      complete: async (r: LlmRequest) => {
        seen.push(r);
        const isReduce = (r.system ?? "").startsWith("You combine");
        return { content: isReduce ? reduce : MAP, stopReason: "end_turn" as const };
      },
    },
    { model: "claude-test" },
  );
}

function fakeTags(
  existing: ExistingTag[],
  o: { order?: string[]; put?: (names: string[]) => void; context?: () => Promise<ExistingTag[] | null> } = {},
) {
  const puts: string[][] = [];
  const port = {
    suggestionContext: o.context ?? (async () => existing),
    putSuggestions: async (_ref: unknown, names: readonly string[]) => {
      o.order?.push("suggestions");
      o.put?.([...names]);
      puts.push([...names]);
      return true;
    },
  };
  return { puts, port };
}
const FIN: ExistingTag = { id: randomUUID(), name: "Finance", linked: false };

describe("summarize step: tag suggestions", () => {
  it("stores the normalised suggestions after the entities and before the summary", async () => {
    const order: string[] = [];
    const t = fakeTags([FIN, { id: randomUUID(), name: "Done", linked: true }], { order });
    const s = deps({
      llm: tagsLlm(reduceWith(["finance", "DONE", "New one", "x".repeat(60)])),
      tags: t.port,
      onWrite: (w) => order.push(w),
    });
    expect(await run(s)).toMatchObject({ outcome: "done" });
    expect(t.puts).toEqual([["Finance", "New one", "x".repeat(40)]]);
    expect(order).toEqual(["entities", "suggestions", "summary"]);
  });

  it("lists the owner's tags in the reduce prompt, ordered as the store gave them", async () => {
    const seen: LlmRequest[] = [];
    const t = fakeTags([FIN, { id: randomUUID(), name: "Legal", linked: false }]);
    await run(deps({ llm: tagsLlm(reduceWith([]), seen), tags: t.port }));
    const reduce = seen.find((r) => (r.system ?? "").startsWith("You combine"));
    expect(JSON.stringify(reduce?.messages)).toContain('[\\"Finance\\",\\"Legal\\"]');
  });

  it("a malformed suggestedTags still stores the summary, and clears the suggestions", async () => {
    const t = fakeTags([FIN]);
    const s = deps({ llm: tagsLlm(reduceWith(42)), tags: t.port });
    expect(await run(s)).toMatchObject({ outcome: "done" });
    expect(await s.results.hasSummary(s.ref)).toBe(true);
    expect(t.puts).toEqual([[]]);
  });

  it("a failing suggestion store, or tag read, never fails ingest", async () => {
    const boom = fakeTags([FIN], { put: () => { throw new Error("secret-tag-name boom"); } });
    const s1 = deps({ llm: tagsLlm(reduceWith(["a"])), tags: boom.port });
    expect(await run(s1)).toMatchObject({ outcome: "done" });
    expect(await s1.results.hasSummary(s1.ref)).toBe(true);
    const noRead = fakeTags([], { context: async () => { throw new Error("db down"); } });
    const seen: LlmRequest[] = [];
    const s2 = deps({ llm: tagsLlm(reduceWith(["a"]), seen), tags: noRead.port });
    expect(await run(s2)).toMatchObject({ outcome: "done" });
    expect(JSON.stringify(seen)).not.toContain("already uses");
  });

  it("logs only the class of a swallowed failure, never a name", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = fakeTags([FIN], { put: () => { throw new Error("Zebra-Secret-Tag"); } });
    await run(deps({ llm: tagsLlm(reduceWith(["a"])), tags: boom.port }));
    expect(JSON.stringify(log.mock.calls)).not.toContain("Zebra");
    log.mockRestore();
  });

  it("a key-store outage fails the step, as elsewhere", async () => {
    const outage = fakeTags([FIN], { context: async () => { throw new FieldKeyStoreError(); } });
    await expect(run(deps({ llm: tagsLlm(reduceWith([])), tags: outage.port }))).rejects.toBeInstanceOf(
      FieldKeyStoreError,
    );
  });

  it("without the tag port the prompt and the result are as before", async () => {
    const seen: LlmRequest[] = [];
    const s = deps({ llm: tagsLlm(reduceWith(["a"]), seen) });
    expect(await run(s)).toMatchObject({ outcome: "done" });
    expect(JSON.stringify(seen)).toContain("up to 3 short topic tags");
  });

  it("does not read the tags for a document that already has its summary", async () => {
    let reads = 0;
    const t = fakeTags([FIN], { context: async () => { reads++; return [FIN]; } });
    const s = deps({ llm: tagsLlm(reduceWith([])), tags: t.port, summary: true });
    expect(await run(s)).toMatchObject({ outcome: "done", count: 0 });
    expect(reads).toBe(0);
  });
});
```

(`vi` is imported already in that file; add `LlmRequest` is imported; `randomUUID` too.)

Create `apps/server/app/flows/ingest-document/flowHash.test.ts` (the D1 finding as a guard):

```ts
import { flowContentHash } from "@loom/core";
import { describe, expect, it } from "vitest";
import { ingestDocumentFlow } from "./flow";

describe("the ingest-document flow identity", () => {
  /**
   * Loom's flow hash covers the flow id and version, the ordered steps (id, tool id, timeout, retry) and the deadline, and
   * nothing inside a step: not its prompt, its inputs' contents, its schemas or its code (packages/core/src/flowHash.ts;
   * DocMind sets no codeFingerprint). The tag suggestions change the summarize step's prompt and what its effect reads, so
   * the hash did not move and ingest stays 3.0.0 with no legacy definition. This literal is the hash on main before the
   * change: if you edit the step list, the ids, a retry policy or the version, this fails and you must follow the
   * visualize-document 1.0.0 to 1.1.0 treatment (a new version, the old one kept registered, a resume test, a rollback note).
   */
  it("is unchanged by the tag suggestions", () => {
    expect(ingestDocumentFlow.definition.version).toBe("3.0.0");
    expect(flowContentHash(ingestDocumentFlow.definition)).toBe(
      "sha256:e9c2819cd68e5b3d2bae57d5ef9e7d55af3067a99db66e225b00f0adfa864dc4",
    );
  });
});
```

Create `apps/server/app/flows/ingest-document/steps/summarize.tags.pg.test.ts` (the step with the real tag service and the real results store):

```ts
import { randomUUID } from "node:crypto";
import type { ParsedDocument } from "@docmind/parsers";
import type { LlmProvider, LlmRequest } from "@loom/llm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TagKeys } from "../../../crypto/tagKeys";
import { PG_URL } from "../../../db/testSupport";
import { TagService } from "../../../tags/service";
import { type PgFixture, startPgFixture } from "../pgFixture";
import { PgDocumentResults } from "../pgResults";
import { summarizeEffect } from "./summarize";

const PARSED: ParsedDocument = {
  text: "one",
  sections: [{ headingPath: [], text: "one", locator: { kind: "chars", start: 0, end: 3 } }],
  media: [],
};

describe.skipIf(!PG_URL)(
  "the summarize step with the real tag service (needs DOCMIND_TEST_PG_URL)",
  () => {
    let fx: PgFixture;
    beforeAll(async () => {
      fx = await startPgFixture();
    });
    afterAll(async () => void (await fx?.close()));

    it("writes the document's suggestions, mapped onto its owner's existing tags, and the sealed summary", async () => {
      const ref = await fx.doc(randomUUID().replaceAll("-", "").padEnd(64, "0"));
      const tags = new TagService(fx.app, fx.fields, new TagKeys(fx.keys));
      await tags.create(ref, "Finance");
      const llm: LlmProvider & { model: string } = {
        model: "claude-test",
        complete: async (r: LlmRequest) => ({
          content: (r.system ?? "").startsWith("You combine")
            ? JSON.stringify({
                tldr: "T",
                keyPoints: [],
                entities: [],
                topics: [],
                suggestedQuestions: [],
                suggestedTags: ["FINANCE", "Brand new"],
              })
            : JSON.stringify({ summary: "s", entities: [] }),
          stopReason: "end_turn",
        }),
      };
      const results = new PgDocumentResults(fx.app, fx.fields);
      const effect = summarizeEffect({
        guard: { begin: async () => {} },
        parsed: {
          put: async () => {},
          take: async () => PARSED,
          has: async () => true,
          drop: async () => {},
        },
        chunks: {
          replace: async () => 0,
          count: async () => 1,
          read: async () => [],
          sectionsOf: async () => [],
        },
        results,
        entities: { replaceForDocument: async () => 0, sharedWith: async () => [] },
        llm,
        tags,
        summaryMaxChars: 1_000,
        sleep: async () => {},
      });
      expect(await effect.execute(ref, {} as never)).toMatchObject({ outcome: "done" });
      expect(await results.hasSummary(ref)).toBe(true);
      expect((await tags.detail(ref, ref.documentId))?.suggestedTags).toEqual([
        "Finance",
        "Brand new",
      ]);
      const raw = (
        await fx.db.owner.query("SELECT to_jsonb(s) AS r FROM document_tag_suggestions s")
      ).rows;
      expect(JSON.stringify(raw)).not.toContain("Brand new");
    });
  },
);
```

Run: `pnpm --filter @docmind/server exec vitest run app/flows/ingest-document/summarize app/flows/ingest-document/steps/summarize.test.ts app/flows/ingest-document/flowHash.test.ts`
Expected: the pack, summarize and step tests FAIL (no `suggestedTags`, no `reduceInstruction`, no `tags` dep). `flowHash.test.ts` PASSES already: that is the point (it pins the hash of the unchanged graph).

- [ ] **Step 2: Prompts and answer**

In `apps/server/app/flows/ingest-document/summarize/prompts.ts`: add imports `import { parseSuggestedTags, tagInstruction } from "../../../tags/suggestions";`; replace the `REDUCE_INSTRUCTION` constant with:

```ts
const REDUCE_FIELDS =
  '{"tldr": "<2-3 sentences>", "keyPoints": ["…"], "entities": ["…"], "topics": ["…"], "suggestedQuestions": ["questions a reader could ask about this document"], "suggestedTags": ["…"]}';

/**
 * The reduce call's instruction: the JSON shape of the answer and the one line that asks for tags (the owner's existing tag
 * names, quoted as JSON, so the model prefers them; none: up to 3 new names). The reduce is the only call that produces the
 * final summary, for one group as for many.
 */
export const reduceInstruction = (existingTags: readonly string[] = []): string =>
  `Reply as ${REDUCE_FIELDS}. ${tagInstruction(existingTags)}`;
```

and replace `ReduceAnswer` with:

```ts
export const ReduceAnswer = z
  .object({
    tldr: z.string().transform((s) => s.slice(0, 2_000)),
    keyPoints: capped(12, 500),
    entities: capped(30, 200),
    topics: capped(12, 100),
    suggestedQuestions: capped(8, 300),
    // Lenient: a missing or malformed field is [], never a failed summary.
    suggestedTags: z.unknown().transform(parseSuggestedTags),
  })
  .pipe(DocumentSummary.extend({ suggestedTags: z.array(z.string()) }));
```

- [ ] **Step 3: `summarizeDocument`**

In `summarize/summarize.ts`: replace the import list from `./prompts` (`MAP_INSTRUCTION, MAP_SYSTEM, MapAnswer, REDUCE_SYSTEM, ReduceAnswer, reduceInstruction`); change `SummaryRun`:

```ts
export interface SummaryRun {
  summary: DocumentSummary;
  /** The model's tag names as it wrote them: `normaliseSuggestions` cleans them. Never part of the stored summary. */
  suggestedTags: string[];
  groups: { sections: number[]; entities: { name: string; kind: EntityKind }[] }[];
}
```

add `existingTags?: readonly string[]` to the `options` type (`options: { maxChars: number; signal?: AbortSignal; groupChars?: number; concurrency?: number; existingTags?: readonly string[] }`), and replace the reduce call and the return:

```ts
    const { suggestedTags, ...summary } = await ask(
      REDUCE_SYSTEM,
      joined,
      reduceInstruction(options.existingTags ?? []),
      ReduceAnswer,
    );
    return {
      summary,
      suggestedTags,
      groups: groups.map((g, i) => ({ sections: g.sections, entities: maps[i]?.entities ?? [] })),
    };
```

- [ ] **Step 4: The step**

In `steps/summarize.ts`: add imports `import { FieldKeyStoreError } from "../../../crypto/fields";`, `import type { TagService } from "../../../tags/service";`, `import { normaliseSuggestions } from "../../../tags/suggestions";`, and `isAbort, isDocumentGone` from `"../errors"`; add to `SummarizeDeps`:

```ts
  /** The owner's tags in, the document's suggestions out. Absent: no suggestions (the prompt asks for up to 3 new names, nothing is stored). */
  tags?: Pick<TagService, "suggestionContext" | "putSuggestions">;
```

add above `summarizeEffect`:

```ts
/**
 * A suggestion problem never fails ingest (spec section 4): it is logged by class and ignored. Only what ends a step elsewhere
 * ends it here: a key-store outage, a document that is gone, an abort.
 */
async function tolerant<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof FieldKeyStoreError || isDocumentGone(err) || isAbort(err)) throw err;
    console.error("tag suggestions skipped", err instanceof Error ? err.constructor.name : typeof err);
    return undefined;
  }
}
```

and in the effect body replace the section from `const parsed = …` to the `putSummary` call with:

```ts
      const parsed = await deps.parsed.take(ref);
      if (!parsed) throw new Error("no parsed document to summarize");
      // The owner's tag names, read and opened here (never in the step input, so never in the event log). A failure to read
      // them only costs the preference for existing tags.
      const existing = (await tolerant(async () => (await deps.tags?.suggestionContext(ref)) ?? [])) ?? [];
      let run: SummaryRun | null;
      try {
        run = await summarizeDocument(provider, parsed, {
          maxChars: deps.summaryMaxChars,
          existingTags: existing.map((t) => t.name),
          ...(signal && { signal }),
        });
      } catch (err) {
        if (err instanceof LlmRefusalError) return { count: 0, model };
        throw err;
      }
      if (!run) return { count: 0, model };
      const chunks = await deps.chunks.sectionsOf(ref);
      const bySection = new Map<number, string[]>();
      for (const c of chunks)
        bySection.set(c.sectionOrdinal, [...(bySection.get(c.sectionOrdinal) ?? []), c.id]);
      const mentions = run.groups.flatMap((g) => {
        const chunkIds = g.sections.flatMap((s) => bySection.get(s) ?? []);
        return chunkIds.length === 0
          ? []
          : g.entities.map((e) => ({ chunkIds, name: e.name, kind: e.kind }));
      });
      await deps.entities.replaceForDocument(ref, mentions, signal);
      // Before the summary, so the summary stays last (its presence means "done"). A run replaces the row; none means none.
      if (deps.tags) {
        const names = normaliseSuggestions(run.suggestedTags, existing);
        const put = deps.tags;
        await tolerant(() => put.putSuggestions(ref, names));
      }
      await deps.results.putSummary(ref, run.summary, signal); // last: its presence means "summarize done" (D2)
      return { count: run.groups.length, model };
```

In `pgDeps.ts`: add imports `import { TagKeys } from "../../crypto/tagKeys";` and `import { TagService } from "../../tags/service";` and add to the returned object, after `entities: …,`: `tags: new TagService(pool, fields, new TagKeys(keys)),`.

- [ ] **Step 5: Run the tests**

Run: `set -a; . ./.env; set +a; pnpm --filter @docmind/server exec vitest run app/flows/ingest-document app/documents/ingest.e2e.pg.test.ts && pnpm typecheck && pnpm typecheck:tests && pnpm lint`
Expected: PASS, including `flowHash.test.ts` (the hash is still `sha256:e9c2819c…`: this is the recorded finding) and `summarize.tags.pg.test.ts` (check it ran, not skipped). If an existing test asserted the old reduce instruction text or `SummaryRun` shape, update the expectation (`REDUCE_INSTRUCTION` no longer exists; `summary` is still a `DocumentSummary`).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(tags): ingest asks for suggested tags and stores them before the summary"
```

---

## Task 5: The `suggest-tags` flow and the accept, dismiss and refresh routes

**Files:**
- Create: `apps/server/app/flows/suggest-tags/flow.ts`, `prompts.ts`, `step.ts`, `start.ts`
- Test: `apps/server/app/flows/suggest-tags/start.test.ts`, `step.pg.test.ts`, `flow.pg.test.ts`
- Create: `apps/server/app/tags/suggestRoutes.ts`, test `apps/server/app/tags/suggestRoutes.pg.test.ts`
- Modify: `apps/server/app/flows/chat-title/step.ts` (export its `defaultSleep`, which this step reuses), `apps/server/app/erasure/wire.ts`, `apps/server/app/erasure/wire.test.ts` (settle and cancel the starts), `apps/server/app/security.ts`, `apps/server/app/security.test.ts`, `apps/server/app/config.ts`, `apps/server/app/loom.gen.ts` (regenerated), `apps/server/app/compose.ts`, `apps/server/app/bootIngest.ts`, `apps/server/app/documents/testHarness.ts`
- Modify: `packages/contracts/src/documents.ts` (`DocumentProgressEvent.tags`), `packages/contracts/src/documents.test.ts`

**Interfaces:**
- Consumes: `TagService` (`suggestionContext`, `putSuggestions`, `accept`, `dismiss`; Task 2); `normaliseSuggestions`, `parseSuggestedTags`, `tagInstruction` (Task 1); `TagNameRequest`, `SuggestTagsResponse`, `DocumentTagsResponse` (Task 1); `rerunTracker` (`flows/rerunTracker.ts`); `jsonAnswer` (`ingest-document/llmJson.ts`); `getDocument`, `summaryBind` (`documents/repo.ts`); `isAbort`, `isDocumentGone`; `ProgressBus` (`documents/progress.ts`); `UserRateLimit` (`flows/visualize-turn/limiter.ts`); `executionIdFor` (`subject.ts`).
- Produces:
  - `SUGGEST_TAGS_FLOW_ID = "suggest-tags"`; `SuggestTagsInput` (`{tenantId, userId, documentId}`, strict); `SuggestTagsOutput` (`{outcome: "suggested" | "empty" | "failed"}`); `suggestTagsFlow: RegisteredFlow` (version 1.0.0, one step `suggest-tags`)
  - `interface SuggestTagsDeps { pool: Pool; fields: FieldCrypto; tags: Pick<TagService, "suggestionContext" | "putSuggestions">; bus: ProgressBus; llm?: LlmProvider; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> }`; `suggestTagsEffect(deps): Effect<SuggestTagsInput, SuggestTagsOutput>`
  - `type SuggestTagsStart = { kind: "started"; run: number } | { kind: "running" } | { kind: "disabled" }`; `interface SuggestTagsStarter { start(ref: SuggestTagsInput): Promise<SuggestTagsStart>; settle(identity: Identity, documentId: string): Promise<void>; cancel(identity: Identity, documentId: string, reason: string): Promise<void>; idle(): Promise<void> }` (`settle` and `cancel` are for erasure); `loomSuggestTagsStarter(runtime: Pick<WorkflowRuntime, "start" | "cancel">, o?: { enabled?: () => boolean }): SuggestTagsStarter`; `suggestTagsExecutionId(userId, documentId, run): UserExecutionId` (`u_<user>:suggest-tags-<doc>-r<n>`)
  - `suggestRoutes(deps: { pool: Pool; authenticator: Authenticator; tags: TagService; starter: Pick<SuggestTagsStarter, "start">; limiter: { tryAcquire(userId: string): boolean } }): Record<string, Handler>` (it reuses `authed`, `idOf`, `notFound` and `answering` from `tags/routes.ts`, Task 3)
  - `ErasureParts.suggestTags?: Pick<SuggestTagsStarter, "cancel" | "idle" | "settle">`
  - `DocumentProgressEvent.tags?: "suggested" | "failed"`; `FlowDeps.suggestTags?: SuggestTagsDeps`; `BuiltServer.suggestTags: SuggestTagsStarter`

- [ ] **Step 1: The progress event carries `tags`, test first**

Append to `packages/contracts/src/documents.test.ts`:

```ts
describe("a tags progress event", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  it("is a ready, finalize event with tags suggested or failed", () => {
    for (const tags of ["suggested", "failed"])
      expect(DocumentProgressEvent.safeParse({ documentId: id, status: "ready", step: "finalize", tags }).success).toBe(true);
    expect(DocumentProgressEvent.safeParse({ documentId: id, status: "ready", step: "finalize", tags: "x" }).success).toBe(false);
    expect(DocumentProgressEvent.safeParse({ documentId: id, status: "parsing", step: "parse", tags: "suggested" }).success).toBe(false);
  });
});
```

(add `DocumentProgressEvent` to the file's imports). Run it: FAIL. In `packages/contracts/src/documents.ts` add to the `DocumentProgressEvent` object, after `visuals`:

```ts
    /**
     * The document's tag suggestions were refreshed (`suggested`: an open detail page reads them again) or the on-demand run
     * failed (`failed`: the page offers a retry).
     */
    tags: z.enum(["suggested", "failed"]).optional(),
```

and a third refinement after the `visuals` one:

```ts
  .refine((e) => e.tags === undefined || (e.status === "ready" && e.step === "finalize"), {
    message: "a tags event must be ready at finalize",
  })
```

Run the contracts suite: PASS.

- [ ] **Step 2: The flow and its prompts**

Create `apps/server/app/flows/suggest-tags/flow.ts`:

```ts
import { flow$, step$ } from "@loom/core";
import type { RetryPolicy } from "@loom/core";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";

export const SUGGEST_TAGS_FLOW_ID = "suggest-tags";

/** Ids only. The execution id is `executionIdFor(userId, "suggest-tags-<documentId>-r<n>")`. */
export const SuggestTagsInput = z
  .object({ tenantId: z.string().uuid(), userId: z.string().uuid(), documentId: z.string().uuid() })
  .strict();
export type SuggestTagsInput = z.infer<typeof SuggestTagsInput>;

/** One word: never a tag name. */
export const SuggestTagsOutput = z
  .object({ outcome: z.enum(["suggested", "empty", "failed"]) })
  .strict();
export type SuggestTagsOutput = z.infer<typeof SuggestTagsOutput>;

/** Declared metadata (part of the flow's identity); the effect applies it. */
export const SUGGEST_TAGS_RETRY: RetryPolicy = {
  maxAttempts: 3,
  backoffMs: 2_000,
  backoffMultiplier: 2,
};

// A step id doubles as its tool id; `security.ts` grants it and `config.ts` registers its effect.
export const suggestTagsStep = step$({
  id: "suggest-tags",
  name: "SuggestTags",
  inputSchema: SuggestTagsInput,
  outputSchema: SuggestTagsOutput,
  retry: SUGGEST_TAGS_RETRY,
});

const runSuggestTags: FlowRunner<SuggestTagsInput, SuggestTagsOutput> = async (ctx, input) =>
  ctx.run(suggestTagsStep, input);

export const suggestTagsFlow: RegisteredFlow = {
  definition: flow$({
    id: SUGGEST_TAGS_FLOW_ID,
    name: "SuggestTags",
    version: "1.0.0",
    inputSchema: SuggestTagsInput,
    outputSchema: SuggestTagsOutput,
    steps: [suggestTagsStep],
  }),
  runner: runSuggestTags as FlowRunner<unknown, unknown>,
};
```

Create `apps/server/app/flows/suggest-tags/prompts.ts`:

```ts
import type { DocumentSummary } from "@docmind/contracts";
import { z } from "zod";
import { parseSuggestedTags, tagInstruction } from "../../tags/suggestions";

export const SUGGEST_SYSTEM = [
  "You suggest tags for one document from a private document library, using only its stored summary.",
  "Answer with one JSON object and nothing else.",
].join(" ");

export const suggestInstruction = (existingTags: readonly string[]): string =>
  `Reply as {"suggestedTags": ["…"]}. ${tagInstruction(existingTags)}`;

/** The same lenient `suggestedTags` as the ingest reduce answer: missing or malformed is []. */
export const SuggestAnswer = z
  .object({ suggestedTags: z.unknown().transform(parseSuggestedTags) })
  .transform((a) => a.suggestedTags);

const MAX_SUMMARY_CHARS = 6_000;

/** What the model reads: the stored summary's tldr, topics and key points. Never a passage, the title or the filename. */
export function summaryText(s: Pick<DocumentSummary, "tldr" | "topics" | "keyPoints">): string {
  return [
    `Summary: ${s.tldr}`,
    `Topics: ${s.topics.join("; ")}`,
    "Key points:",
    ...s.keyPoints.map((k) => `- ${k}`),
  ]
    .join("\n")
    .slice(0, MAX_SUMMARY_CHARS);
}
```

- [ ] **Step 3: Write the failing step tests**

Create `apps/server/app/flows/suggest-tags/step.pg.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { DocumentProgressEvent } from "@docmind/contracts";
import { LlmRefusalError, LlmUnavailableError } from "@docmind/llm-anthropic";
import type { LlmProvider, LlmRequest } from "@loom/llm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TagKeys } from "../../crypto/tagKeys";
import { PG_URL } from "../../db/testSupport";
import { InMemoryProgressBus } from "../../documents/progress";
import { TagService } from "../../tags/service";
import { type PgFixture, startPgFixture } from "../ingest-document/pgFixture";
import { PgDocumentResults } from "../ingest-document/pgResults";
import { suggestTagsEffect } from "./step";

const SUMMARY = {
  tldr: "Quarterly summary tldr",
  keyPoints: ["Revenue grew"],
  entities: [],
  topics: ["finance"],
  suggestedQuestions: [],
};

describe.skipIf(!PG_URL)("the suggest-tags step (needs DOCMIND_TEST_PG_URL)", () => {
  let fx: PgFixture;
  let tags: TagService;
  let results: PgDocumentResults;
  beforeAll(async () => {
    fx = await startPgFixture();
    tags = new TagService(fx.app, fx.fields, new TagKeys(fx.keys));
    results = new PgDocumentResults(fx.app, fx.fields);
  });
  afterAll(async () => void (await fx?.close()));

  async function setup(
    o: {
      summary?: boolean;
      reply?: (n: number) => string | Error;
      tags?: Pick<TagService, "suggestionContext" | "putSuggestions">;
    } = {},
  ) {
    const ref = await fx.doc(randomUUID().replaceAll("-", "").padEnd(64, "0"));
    if (o.summary !== false) await results.putSummary(ref, SUMMARY);
    const requests: LlmRequest[] = [];
    const events: DocumentProgressEvent[] = [];
    const bus = new InMemoryProgressBus();
    bus.subscribe({ userId: ref.userId }, (e) => events.push(e));
    const sleeps: number[] = [];
    const llm: LlmProvider = {
      complete: async (r) => {
        requests.push(r);
        const out = (o.reply ?? (() => JSON.stringify({ suggestedTags: ["Finance", "New idea"] })))(
          requests.length,
        );
        if (out instanceof Error) throw out;
        return { content: out, stopReason: "end_turn" };
      },
    };
    const effect = suggestTagsEffect({
      pool: fx.app,
      fields: fx.fields,
      tags: o.tags ?? tags,
      bus,
      llm,
      sleep: async (ms) => void sleeps.push(ms),
    });
    return { ref, requests, events, sleeps, run: () => effect.execute(ref, {} as never) };
  }

  it("reads only the stored summary and the tag names, stores normalised suggestions and announces them", async () => {
    const s = await setup();
    await tags.create(s.ref, "finance");
    expect(await s.run()).toEqual({ outcome: "suggested" });
    expect(s.requests).toHaveLength(1);
    const sent = JSON.stringify(s.requests[0]);
    expect(sent).toContain("Quarterly summary tldr");
    expect(sent).toContain("Revenue grew");
    expect(sent).not.toContain("Quarterly report"); // the document's title: not read
    expect(sent).toContain('[\\"finance\\"]'); // the user's existing tag, quoted
    expect((await tags.detail(s.ref, s.ref.documentId))?.suggestedTags).toEqual([
      "finance",
      "New idea",
    ]);
    expect(s.events).toEqual([
      { documentId: s.ref.documentId, status: "ready", step: "finalize", tags: "suggested" },
    ]);
  });

  it("drops a name the document already has and replaces earlier suggestions", async () => {
    const s = await setup();
    await tags.putSuggestions(s.ref, ["stale"]);
    await tags.addToDocument(s.ref, s.ref.documentId, "Finance");
    expect(await s.run()).toEqual({ outcome: "suggested" });
    expect((await tags.detail(s.ref, s.ref.documentId))?.suggestedTags).toEqual(["New idea"]);
  });

  it("a missing or malformed answer is empty, clears the row and still announces", async () => {
    const s = await setup({ reply: () => JSON.stringify({ suggestedTags: 42 }) });
    await tags.putSuggestions(s.ref, ["stale"]);
    expect(await s.run()).toEqual({ outcome: "empty" });
    expect((await tags.detail(s.ref, s.ref.documentId))?.suggestedTags).toEqual([]);
    expect(s.events.map((e) => e.tags)).toEqual(["suggested"]);
  });

  it("fails with the failed event when the document has no summary, without a model call", async () => {
    const s = await setup({ summary: false });
    expect(await s.run()).toEqual({ outcome: "failed" });
    expect(s.requests).toHaveLength(0);
    expect(s.events.map((e) => e.tags)).toEqual(["failed"]);
  });

  it("retries an unavailable model or a garbled answer, then fails with the event", async () => {
    const s = await setup({ reply: () => new LlmUnavailableError(503) });
    expect(await s.run()).toEqual({ outcome: "failed" });
    expect(s.requests).toHaveLength(3);
    expect(s.sleeps).toEqual([2_000, 4_000]);
    expect(s.events.map((e) => e.tags)).toEqual(["failed"]);
    const garbled = await setup({
      reply: (n) => (n < 3 ? "not json" : JSON.stringify({ suggestedTags: ["ok"] })),
    });
    expect(await garbled.run()).toEqual({ outcome: "suggested" });
    expect(garbled.requests).toHaveLength(3);
  });

  it("does not retry a refusal", async () => {
    const s = await setup({ reply: () => new LlmRefusalError() });
    expect(await s.run()).toEqual({ outcome: "failed" });
    expect(s.requests).toHaveLength(1);
    expect(s.events.map((e) => e.tags)).toEqual(["failed"]);
  });

  it("is quiet for a document that is gone", async () => {
    const gone = await setup();
    await fx.db.owner.query("DELETE FROM documents WHERE id = $1", [gone.ref.documentId]);
    expect(await gone.run()).toEqual({ outcome: "failed" });
    expect(gone.events).toEqual([]);
    expect(gone.requests).toHaveLength(0);
  });

  it("puts no tag or summary text in the output, the event or the log when storing fails (preflight F6)", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const s = await setup({
        tags: {
          suggestionContext: (ref) => tags.suggestionContext(ref),
          // The model answered "New idea", and the store fails with a message that holds it: nothing may carry it on.
          putSuggestions: async () => {
            throw new Error("storage failed for New idea");
          },
        },
      });
      const out = await s.run();
      expect(out).toEqual({ outcome: "failed" });
      expect(s.requests).toHaveLength(1);
      expect(s.events.map((e) => e.tags)).toEqual(["failed"]);
      expect(logged).toHaveBeenCalled(); // the failure is logged by class, so the check below can fail
      const seen = JSON.stringify([out, s.events, logged.mock.calls]);
      for (const text of ["New idea", "storage failed", "Quarterly summary tldr"])
        expect(seen).not.toContain(text);
    } finally {
      logged.mockRestore();
    }
  });
});
```

Run: `set -a; . ./.env; set +a; pnpm --filter @docmind/server exec vitest run app/flows/suggest-tags/step.pg.test.ts`
Expected: FAIL (`./step` does not exist).

- [ ] **Step 4: The step**

In `apps/server/app/flows/chat-title/step.ts` change `const defaultSleep =` to `export const defaultSleep =` (the same abortable wait; the step below imports it, so there is no third copy of it; `ingest-document/stepEffect.ts` keeps its own, which rejects with its own abort error).

Create `apps/server/app/flows/suggest-tags/step.ts`:

```ts
import { DocumentSummary } from "@docmind/contracts";
import {
  LlmAbortedError,
  LlmOutputError,
  LlmRefusalError,
  LlmRequestError,
  LlmUnavailableError,
} from "@docmind/llm-anthropic";
import { tainted } from "@loom/classify";
import type { Effect } from "@loom/effect-runtime";
import { type LlmProvider, UNTRUSTED_CONTENT_SYSTEM_NOTE, guardRequest } from "@loom/llm";
import type { Pool } from "pg";
import { type FieldCrypto, FieldKeyStoreError } from "../../crypto/fields";
import { withTenant } from "../../db/tenant";
import type { ProgressBus } from "../../documents/progress";
import { getDocument, summaryBind } from "../../documents/repo";
import type { TagService } from "../../tags/service";
import { normaliseSuggestions } from "../../tags/suggestions";
import { defaultSleep } from "../chat-title/step";
import { isAbort, isDocumentGone } from "../ingest-document/errors";
import { jsonAnswer } from "../ingest-document/llmJson";
import { SUGGEST_TAGS_RETRY, type SuggestTagsInput, type SuggestTagsOutput } from "./flow";
import { SUGGEST_SYSTEM, SuggestAnswer, suggestInstruction, summaryText } from "./prompts";

export interface SuggestTagsDeps {
  pool: Pool;
  fields: FieldCrypto;
  tags: Pick<TagService, "suggestionContext" | "putSuggestions">;
  bus: ProgressBus;
  /** The `summary` role's provider; absent: every run fails (the route answers 409 `suggest_unavailable` before that). */
  llm?: LlmProvider;
  /** Test seam: the wait between attempts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const FAILED: SuggestTagsOutput = { outcome: "failed" };
const cls = (err: unknown) => (err instanceof Error ? err.constructor.name : typeof err);

/**
 * The one step of `suggest-tags` (spec section 4, on demand). It reads the document's stored summary (tldr, topics, key points)
 * and the owner's tag names, makes one model call with the same lenient answer and normalisation as ingest, replaces the
 * document's suggestions row and tells the owner's open pages. It never reads a passage, the title or the filename. A model
 * problem ends the run `failed` (with the `failed` event, so the page can offer a retry), never an exception; only an abort
 * and a key-store outage are rethrown. The output is one word: no tag name reaches the event log.
 */
export function suggestTagsEffect(
  deps: SuggestTagsDeps,
): Effect<SuggestTagsInput, SuggestTagsOutput> {
  const sleep = deps.sleep ?? defaultSleep;
  return {
    kind: "tool",
    execute: async (ref, ctx) => {
      const signal = ctx?.signal;
      const announce = (tags: "suggested" | "failed") => {
        try {
          deps.bus.publish(
            { userId: ref.userId },
            { documentId: ref.documentId, status: "ready", step: "finalize", tags },
          );
        } catch (err) {
          console.error("tag suggestions event not published", cls(err));
        }
      };
      const fail = (): SuggestTagsOutput => {
        announce("failed");
        return FAILED;
      };
      const llm = deps.llm;
      if (!llm) return fail();
      try {
        const row = await withTenant(deps.pool, ref.tenantId, (tx) =>
          getDocument(tx, ref.userId, ref.documentId),
        );
        if (!row) return FAILED; // gone: nobody to tell
        if (row.summary_enc == null) return fail();
        const summary = DocumentSummary.parse(
          await deps.fields.forUser(ref.userId).open(summaryBind(ref.documentId), row.summary_enc),
        );
        const existing = await deps.tags.suggestionContext(ref);
        if (existing === null) return FAILED;
        const request = guardRequest({
          system: `${SUGGEST_SYSTEM}\n\n${UNTRUSTED_CONTENT_SYSTEM_NOTE}`,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: tainted(summaryText(summary), "document") },
                { type: "text", text: suggestInstruction(existing.map((t) => t.name)) },
              ],
            },
          ],
          temperature: 0,
        });
        let raw: string[];
        for (let attempt = 1; ; attempt++) {
          try {
            const res = await llm.complete({ ...request, ...(signal && { signal }) });
            if (res.stopReason === "max_tokens") throw new LlmOutputError();
            raw = jsonAnswer(res.content, SuggestAnswer);
            break;
          } catch (err) {
            if (err instanceof LlmAbortedError) throw err;
            if (err instanceof LlmRefusalError || err instanceof LlmRequestError) return fail();
            if (!(err instanceof LlmUnavailableError || err instanceof LlmOutputError)) throw err;
            if (attempt >= SUGGEST_TAGS_RETRY.maxAttempts) return fail();
            await sleep(
              (SUGGEST_TAGS_RETRY.backoffMs ?? 0) *
                (SUGGEST_TAGS_RETRY.backoffMultiplier ?? 1) ** (attempt - 1),
              signal,
            );
            signal?.throwIfAborted();
          }
        }
        const names = normaliseSuggestions(raw, existing);
        if (!(await deps.tags.putSuggestions(ref, names))) return FAILED; // deleted meanwhile
        announce("suggested");
        return { outcome: names.length > 0 ? "suggested" : "empty" };
      } catch (err) {
        if (isAbort(err)) throw err;
        if (isDocumentGone(err)) return FAILED;
        console.error("suggest tags failed", cls(err));
        announce("failed");
        if (err instanceof FieldKeyStoreError) throw err; // an outage fails the step, as elsewhere
        return FAILED;
      }
    },
  };
}
```

Run the step tests again. Expected: PASS.

- [ ] **Step 5: The starter, test first**

Create `apps/server/app/flows/suggest-tags/start.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { ExecutionAlreadyExistsError, type ExecutionHandle } from "@loom/workflow-runtime";
import { describe, expect, it, vi } from "vitest";
import { executionIdFor } from "../../subject";
import { loomSuggestTagsStarter, suggestTagsExecutionId } from "./start";

const ref = () => ({ tenantId: randomUUID(), userId: randomUUID(), documentId: randomUUID() });
const never = {
  waitForCompletion: () => new Promise<void>(() => {}),
} as unknown as ExecutionHandle;

describe("suggestTagsExecutionId", () => {
  it("is suggest-tags-<doc>-r<n> under the user's prefix", () => {
    const r = ref();
    expect(suggestTagsExecutionId(r.userId, r.documentId.toUpperCase(), 2)).toBe(
      executionIdFor(r.userId, `suggest-tags-${r.documentId}-r2`),
    );
  });
});

describe("loomSuggestTagsStarter", () => {
  it("runs once for a double click: the second request answers running", async () => {
    const start = vi.fn(async () => never);
    const starter = loomSuggestTagsStarter({ start } as never);
    const r = ref();
    const [a, b] = await Promise.all([starter.start(r), starter.start(r)]);
    expect([a, b]).toEqual([{ kind: "started", run: 1 }, { kind: "running" }]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(await starter.start(ref())).toEqual({ kind: "started", run: 1 }); // another document is independent
  });

  it("takes the next free run number when Loom already holds one (a restart forgets the counter)", async () => {
    const r = ref();
    const taken = suggestTagsExecutionId(r.userId, r.documentId, 1);
    const start = vi.fn(async (_f: unknown, _i: unknown, o: { executionId: string }) => {
      if (o.executionId === taken) throw new ExecutionAlreadyExistsError(taken);
      return never;
    });
    const starter = loomSuggestTagsStarter({ start } as never);
    expect(await starter.start(r)).toEqual({ kind: "started", run: 2 });
  });

  it("lets a finished run be followed by another", async () => {
    let done: () => void = () => {};
    const handle = {
      waitForCompletion: () =>
        new Promise<void>((res) => {
          done = res;
        }),
    } as unknown as ExecutionHandle;
    const starter = loomSuggestTagsStarter({ start: vi.fn(async () => handle) } as never);
    const r = ref();
    expect(await starter.start(r)).toEqual({ kind: "started", run: 1 });
    expect(await starter.start(r)).toEqual({ kind: "running" });
    done();
    await vi.waitFor(async () =>
      expect(await starter.start(r)).toEqual({ kind: "started", run: 2 }),
    );
  });

  it("answers disabled without starting anything while the role is off", async () => {
    const start = vi.fn();
    const starter = loomSuggestTagsStarter({ start } as never, { enabled: () => false });
    expect(await starter.start(ref())).toEqual({ kind: "disabled" });
    expect(start).not.toHaveBeenCalled();
  });

  it("rejects a malformed ref and idle() waits for pending starts", async () => {
    const starter = loomSuggestTagsStarter({ start: vi.fn(async () => never) } as never);
    expect(() => starter.start({ tenantId: "x", userId: "y", documentId: "z" } as never)).toThrow();
    await starter.start(ref());
    await starter.idle();
  });
});

describe("settle and cancel (erasure)", () => {
  it("settle waits for the document's pending start and for no other document's", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const start = vi.fn(async () => {
      await gate;
      return never;
    });
    const starter = loomSuggestTagsStarter({ start, cancel: vi.fn() } as never);
    const r = ref();
    void starter.start(r);
    let settled = false;
    const waiting = starter.settle(r, r.documentId).then(() => {
      settled = true;
    });
    const other = ref();
    await starter.settle(other, other.documentId); // another document: nothing to wait for
    expect(settled).toBe(false);
    release();
    await waiting;
    expect(settled).toBe(true);
  });

  it("cancel stops every run number this process took and ignores one Loom does not hold", async () => {
    const r = ref();
    const first = suggestTagsExecutionId(r.userId, r.documentId, 1);
    const cancel = vi.fn(async (id: string, _reason: string) => {
      if (id === first) throw new Error(`No execution found for id: ${id}`);
      return true;
    });
    const finished = { waitForCompletion: () => Promise.resolve() } as unknown as ExecutionHandle;
    const starter = loomSuggestTagsStarter({ start: vi.fn(async () => finished), cancel } as never);
    expect(await starter.start(r)).toEqual({ kind: "started", run: 1 });
    await vi.waitFor(async () =>
      expect(await starter.start(r)).toEqual({ kind: "started", run: 2 }),
    );
    await starter.cancel(r, r.documentId, "erased");
    expect(cancel.mock.calls.map((c) => c[0])).toEqual([
      first,
      suggestTagsExecutionId(r.userId, r.documentId, 2),
    ]);
    expect(cancel.mock.calls.map((c) => c[1])).toEqual(["erased", "erased"]);
  });

  it("cancel rethrows any other failure, so the erasure step is retried", async () => {
    const r = ref();
    const cancel = vi.fn(async () => {
      throw new RangeError("db down");
    });
    const starter = loomSuggestTagsStarter({ start: vi.fn(async () => never), cancel } as never);
    await starter.start(r);
    await expect(starter.cancel(r, r.documentId, "erased")).rejects.toThrow(RangeError);
  });
});
```

Run: `pnpm --filter @docmind/server exec vitest run app/flows/suggest-tags/start.test.ts` Expected: FAIL. Create `apps/server/app/flows/suggest-tags/start.ts`:

```ts
import type { Identity } from "@docmind/auth";
import {
  ExecutionAlreadyExistsError,
  type ExecutionHandle,
  type WorkflowRuntime,
} from "@loom/workflow-runtime";
import { type UserExecutionId, executionIdFor } from "../../subject";
import { MAX_RERUNS, rerunTracker } from "../rerunTracker";
import { SuggestTagsInput, suggestTagsFlow } from "./flow";

export type SuggestTagsStart =
  | { kind: "started"; run: number }
  | { kind: "running" }
  | { kind: "disabled" };

export interface SuggestTagsStarter {
  /**
   * Starts a run for the document unless one is in flight for it (`running`; also when every number is taken) or the model role
   * is off (`disabled`). One request at a time per document: the check, the probe and the start are one step. Throws on a
   * malformed ref (synchronously) or a Loom failure other than an id already taken.
   */
  start(ref: SuggestTagsInput): Promise<SuggestTagsStart>;
  /** Erasure: resolves when the document's pending starts have settled, so a cancel never runs before a start lands. */
  settle(identity: Pick<Identity, "userId">, documentId: string): Promise<void>;
  /**
   * Erasure: cancels every run number this process took for the document (unknown ones are fine). `reason` lands in the
   * log in the clear: a fixed word, never content. Runs are not recovery-owned, so none survives a restart to cancel.
   */
  cancel(identity: Identity, documentId: string, reason: string): Promise<void>;
  /** Resolves when every pending start has settled (shutdown, and before an erasure's shred). */
  idle(): Promise<void>;
}

/** `suggest-tags-<doc>-r<n>`: the name holds ids and a number, never content. */
export function suggestTagsExecutionId(
  userId: string,
  documentId: string,
  run: number,
): UserExecutionId {
  return executionIdFor(userId, `suggest-tags-${documentId.toLowerCase()}-r${run}`);
}

const keyOf = (userId: string, documentId: string) => `${userId}:${documentId.toLowerCase()}`;

export function loomSuggestTagsStarter(
  runtime: Pick<WorkflowRuntime, "start" | "cancel">,
  o: { enabled?: () => boolean } = {},
): SuggestTagsStarter {
  const tracker = rerunTracker();
  const pending = new Set<Promise<unknown>>();
  const byDocument = new Map<string, Set<Promise<unknown>>>();
  return {
    start(ref) {
      const input = SuggestTagsInput.parse(ref);
      const key = keyOf(input.userId, input.documentId);
      const work = tracker.exclusive(key, async (): Promise<SuggestTagsStart> => {
        if (o.enabled && !o.enabled()) return { kind: "disabled" };
        if (tracker.running(key)) return { kind: "running" };
        const out = await tracker.probe(key, 0, async (n): Promise<ExecutionHandle | null> => {
          const executionId = suggestTagsExecutionId(input.userId, input.documentId, n);
          try {
            const handle = await runtime.start(suggestTagsFlow, input, {
              executionId,
              principal: { tenant: input.tenantId, actor: input.userId },
            });
            tracker.track(key, executionId, handle);
            return handle;
          } catch (err) {
            if (err instanceof ExecutionAlreadyExistsError) return null;
            throw err;
          }
        });
        return out.kind === "started" ? { kind: "started", run: out.rerun } : { kind: "running" };
      });
      const mark = work.then(
        () => undefined,
        () => undefined,
      );
      const set = byDocument.get(key) ?? new Set<Promise<unknown>>();
      byDocument.set(key, set);
      pending.add(mark);
      set.add(mark);
      void mark.finally(() => {
        pending.delete(mark);
        set.delete(mark);
        if (set.size === 0 && byDocument.get(key) === set) byDocument.delete(key);
      });
      return work;
    },
    async settle(identity, documentId) {
      while (true) {
        const runs = byDocument.get(keyOf(identity.userId, documentId));
        if (!runs || runs.size === 0) return;
        await Promise.all([...runs]);
      }
    },
    async cancel(identity, documentId, reason) {
      const principal = { tenant: identity.tenantId, actor: identity.userId };
      const top = Math.min(tracker.last(keyOf(identity.userId, documentId)), MAX_RERUNS);
      for (let n = 1; n <= top; n++) {
        const executionId = suggestTagsExecutionId(identity.userId, documentId, n);
        try {
          await runtime.cancel(executionId, reason, { principal });
        } catch (err) {
          // Loom throws a plain Error (no class) for an execution that never existed; match its exact message for this id only.
          if (
            !(err instanceof Error && err.message === `No execution found for id: ${executionId}`)
          )
            throw err;
        }
      }
    },
    async idle() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
```

Run the starter tests: PASS (including the settle and cancel cases, which Step 9a wires into erasure). (`SuggestTagsInput.parse` throws synchronously, which the `rejects a malformed ref` test relies on: `start` is not `async`.)

- [ ] **Step 6: Wire the flow: security, config, gen**

`apps/server/app/security.ts`: add `import { SUGGEST_TAGS_FLOW_ID } from "./flows/suggest-tags/flow";` and, after the `[CHAT_TITLE_FLOW_ID]` line: `// The on-demand tag suggestions flow (one step; the step id is its tool id).` / `[SUGGEST_TAGS_FLOW_ID]: ["suggest-tags"],`. In `security.test.ts` add next to the chat-title test (import `SUGGEST_TAGS_FLOW_ID`):

```ts
  it("lets suggest-tags run its one step and nothing else", () => {
    expect(authorizer.authorize(request(SUGGEST_TAGS_FLOW_ID, "suggest-tags")).allowed).toBe(true);
    expect(authorizer.authorize(request(SUGGEST_TAGS_FLOW_ID, "ingest-summarize")).allowed).toBe(false);
    expect(authorizer.authorize(request("ingest-document", "suggest-tags")).allowed).toBe(false);
  });
```

`apps/server/app/config.ts`: add `import { type SuggestTagsDeps, suggestTagsEffect } from "./flows/suggest-tags/step";`; in `FlowDeps` add `/** The on-demand tag suggestions step's dependencies; without them the flow's step fails at its first use. */ suggestTags?: SuggestTagsDeps;`; in `registerEffects`, after the `chatTitle` line: `if (deps.suggestTags) effects.register("suggest-tags", suggestTagsEffect(deps.suggestTags));`.

Regenerate the flow modules: `pnpm --filter @docmind/server gen`. Expected diff in `apps/server/app/loom.gen.ts`: `./flows/suggest-tags/flow` is added to the imports and `flowModules` (sorted by path: chat-title, ingest-document, suggest-tags, visualize-document). If the generator cannot run, make that edit by hand to match.

- [ ] **Step 7: The flow through Loom, test first**

Create `apps/server/app/flows/suggest-tags/flow.pg.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import type { DocumentProgressEvent } from "@docmind/contracts";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import type { LlmProvider } from "@loom/llm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../config";
import { TagKeys } from "../../crypto/tagKeys";
import { PG_URL } from "../../db/testSupport";
import { InMemoryProgressBus } from "../../documents/progress";
import { TagService } from "../../tags/service";
import { type PgFixture, startPgFixture } from "../ingest-document/pgFixture";
import { PgDocumentResults } from "../ingest-document/pgResults";
import { loomSuggestTagsStarter } from "./start";

describe.skipIf(!PG_URL)("suggest-tags through Loom (needs DOCMIND_TEST_PG_URL)", () => {
  let fx: PgFixture;
  beforeAll(async () => {
    fx = await startPgFixture();
  });
  afterAll(async () => void (await fx?.close()));

  it("runs durably, stores suggestions once for a double click, and leaves no tag or summary text in the log", async () => {
    const ref = await fx.doc(randomUUID().replaceAll("-", "").padEnd(64, "0"));
    await new PgDocumentResults(fx.app, fx.fields).putSummary(ref, {
      tldr: "Zebra-Secret-Summary",
      keyPoints: [],
      entities: [],
      topics: [],
      suggestedQuestions: [],
    });
    const tags = new TagService(fx.app, fx.fields, new TagKeys(fx.keys));
    const events: DocumentProgressEvent[] = [];
    const bus = new InMemoryProgressBus();
    bus.subscribe({ userId: ref.userId }, (e) => events.push(e));
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const llm: LlmProvider = {
      complete: async () => {
        calls++;
        await gate;
        return {
          content: JSON.stringify({ suggestedTags: ["Zebra-Secret-Tag"] }),
          stopReason: "end_turn",
        };
      },
    };
    const log = new InMemoryAsyncEventStore();
    const app = buildApp({ kind: "custom", eventStore: log }, undefined, {
      suggestTags: { pool: fx.app, fields: fx.fields, tags, bus, llm },
    });
    try {
      const starter = loomSuggestTagsStarter(app.runtime);
      const [a, b] = await Promise.all([starter.start(ref), starter.start(ref)]);
      expect([a.kind, b.kind].sort()).toEqual(["running", "started"]);
      release();
      await vi.waitFor(() => expect(events).toHaveLength(1));
      expect(calls).toBe(1);
      expect((await tags.detail(ref, ref.documentId))?.suggestedTags).toEqual(["Zebra-Secret-Tag"]);
      expect(events[0]).toEqual({
        documentId: ref.documentId,
        status: "ready",
        step: "finalize",
        tags: "suggested",
      });
      const id = `u_${ref.userId}:suggest-tags-${ref.documentId}-r1`;
      await vi.waitFor(async () =>
        expect(JSON.stringify(await log.read(id))).toContain("EXECUTION_COMPLETED"),
      );
      const text = JSON.stringify(await log.read(id));
      expect(text).not.toContain("Zebra");
      expect(text).toContain('"outcome":"suggested"');
    } finally {
      await app.close();
    }
  });
});
```

Run: `set -a; . ./.env; set +a; pnpm --filter @docmind/server exec vitest run app/flows/suggest-tags/flow.pg.test.ts`
Expected: FAIL (`suggestTags` is not a `FlowDeps` key) until Step 6 is done; after it, PASS.

- [ ] **Step 8: The routes, test first**

In `apps/server/app/documents/testHarness.ts`: add to the `startDocumentServer` `overrides` type `/** Test seam: the suggest-tags starter and limiter the refresh route uses (default: the role is off). */ suggest?: { starter: Pick<SuggestTagsStarter, "start">; limiter: { tryAcquire(userId: string): boolean } };`; import `suggestRoutes` and `type SuggestTagsStarter`; and in `createHttpServer({ … })` add after the `tagRoutes` line:

```ts
      ...suggestRoutes({
        pool: app,
        authenticator: testAuthenticator,
        tags: wrapped.tags,
        starter: overrides.suggest?.starter ?? { start: async () => ({ kind: "disabled" as const }) },
        limiter: overrides.suggest?.limiter ?? { tryAcquire: () => true },
      }),
```

Create `apps/server/app/tags/suggestRoutes.pg.test.ts`:

```ts
import { DocumentTagsResponse, SuggestTagsResponse } from "@docmind/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FieldCrypto } from "../crypto/fields";
import { PG_URL } from "../db/testSupport";
import {
  ALICE,
  BOB,
  type DocumentHarness,
  callApi,
  errorCode as code,
  seedNext,
  startDocumentServer,
} from "../documents/testHarness";
import { PgDocumentResults } from "../flows/ingest-document/pgResults";
import type { SuggestTagsStart } from "../flows/suggest-tags/start";

describe.skipIf(!PG_URL)("tag suggestion routes (needs DOCMIND_TEST_PG_URL)", () => {
  const state = { answer: { kind: "started", run: 1 } as SuggestTagsStart, allow: true };
  const start = vi.fn(async () => state.answer);
  let h: DocumentHarness;
  beforeAll(async () => {
    h = await startDocumentServer({
      suggest: { starter: { start }, limiter: { tryAcquire: () => state.allow } },
    });
  });
  afterAll(async () => void (await h?.close()));
  beforeEach(async () => {
    state.answer = { kind: "started", run: 1 };
    state.allow = true;
    start.mockClear();
    await h.owner.query("DELETE FROM tags");
    await h.owner.query("DELETE FROM documents");
  });
  const post = (user: string, path: string, body?: unknown) => callApi(h, user, "POST", path, body);
  const seed = async (who = ALICE, summary = true) => {
    const id = await seedNext(h, who);
    if (summary)
      await new PgDocumentResults(h.app, new FieldCrypto(h.keys)).putSummary(
        { ...who, documentId: id },
        { tldr: "t", keyPoints: [], entities: [], topics: [], suggestedQuestions: [] },
      );
    return id;
  };

  it("accept creates or reuses the tag, links it and removes it from the suggestions", async () => {
    const d = await seed();
    await h.tags.putSuggestions({ ...ALICE, documentId: d }, ["Finance", "Legal"]);
    const res = await post("alice", `/api/documents/${d}/tag-suggestions/accept`, {
      name: "finance",
    });
    const body = DocumentTagsResponse.parse(await res.json());
    expect([res.status, body.tags.map((t) => t.name), body.suggestedTags]).toEqual([
      200,
      ["finance"],
      ["Legal"],
    ]);
  });

  it("dismiss removes the name and leaves the tags alone", async () => {
    const d = await seed();
    await h.tags.putSuggestions({ ...ALICE, documentId: d }, ["Finance", "Legal"]);
    const res = await post("alice", `/api/documents/${d}/tag-suggestions/dismiss`, {
      name: "LEGAL",
    });
    const body = DocumentTagsResponse.parse(await res.json());
    expect([body.tags, body.suggestedTags]).toEqual([[], ["Finance"]]);
  });

  it("answers 404 for a document that is not yours or a malformed id, and 400 for a bad name", async () => {
    const mine = await seed();
    const theirs = await seed(BOB);
    for (const action of ["accept", "dismiss"]) {
      expect(
        (await post("alice", `/api/documents/${theirs}/tag-suggestions/${action}`, { name: "x" }))
          .status,
      ).toBe(404);
      expect(
        (await post("alice", `/api/documents/nope/tag-suggestions/${action}`, { name: "x" }))
          .status,
      ).toBe(404);
      const bad = await post("alice", `/api/documents/${mine}/tag-suggestions/${action}`, {
        name: "",
      });
      expect([bad.status, await code(bad)]).toEqual([400, "invalid_request"]);
    }
  });

  it("accept answers 409 tag_limit when the document holds 20 tags", async () => {
    const d = await seed();
    for (let i = 0; i < 20; i++) await h.tags.addToDocument(ALICE, d, `t${i}`);
    const res = await post("alice", `/api/documents/${d}/tag-suggestions/accept`, {
      name: "one more",
    });
    expect([res.status, await code(res)]).toEqual([409, "tag_limit"]);
  });

  it("refresh starts the flow for the caller's document and answers 202", async () => {
    const d = await seed();
    const res = await post("alice", `/api/documents/${d}/tag-suggestions/refresh`);
    expect([res.status, SuggestTagsResponse.parse(await res.json())]).toEqual([
      202,
      { started: true },
    ]);
    expect(start).toHaveBeenCalledWith({
      tenantId: ALICE.tenantId,
      userId: ALICE.userId,
      documentId: d,
    });
  });

  it("refresh answers 404 (not yours, malformed), 409 no_summary, 409 suggest_running, 409 suggest_unavailable and 429", async () => {
    const d = await seed();
    expect((await post("bob", `/api/documents/${d}/tag-suggestions/refresh`)).status).toBe(404);
    expect((await post("alice", "/api/documents/nope/tag-suggestions/refresh")).status).toBe(404);
    const bare = await seed(ALICE, false);
    const noSummary = await post("alice", `/api/documents/${bare}/tag-suggestions/refresh`);
    expect([noSummary.status, await code(noSummary)]).toEqual([409, "no_summary"]);
    expect(start).not.toHaveBeenCalled();
    state.answer = { kind: "running" };
    const running = await post("alice", `/api/documents/${d}/tag-suggestions/refresh`);
    expect([running.status, await code(running)]).toEqual([409, "suggest_running"]);
    state.answer = { kind: "disabled" };
    const off = await post("alice", `/api/documents/${d}/tag-suggestions/refresh`);
    expect([off.status, await code(off)]).toEqual([409, "suggest_unavailable"]);
    state.allow = false;
    const limited = await post("alice", `/api/documents/${d}/tag-suggestions/refresh`);
    expect([limited.status, limited.headers.get("retry-after"), await code(limited)]).toEqual([
      429,
      "60",
      "too_many_requests",
    ]);
  });
});
```

Run: `pnpm --filter @docmind/server exec vitest run app/tags/suggestRoutes.pg.test.ts` Expected: FAIL (`./suggestRoutes` does not exist). Create `apps/server/app/tags/suggestRoutes.ts`:

```ts
import type { Authenticator } from "@docmind/auth";
import {
  type DocumentTagsResponse,
  type SuggestTagsResponse,
  TagNameRequest,
} from "@docmind/contracts";
import type { Pool } from "pg";
import { withTenant } from "../db/tenant";
import { getDocument } from "../documents/repo";
import type { SuggestTagsStarter } from "../flows/suggest-tags/start";
import { readJson } from "../http/body";
import type { AuthedHandler } from "../http/requireAuth";
import { type Handler, json, sendError } from "../http/respond";
import { authed, idOf, notFound } from "./routes";
import type { TagService } from "./service";

export interface SuggestRoutesDeps {
  pool: Pool;
  authenticator: Authenticator;
  tags: TagService;
  starter: Pick<SuggestTagsStarter, "start">;
  /** At most 10 refreshes per user per minute (a model call each). */
  limiter: { tryAcquire(userId: string): boolean };
}

/** Accept, dismiss and refresh (spec section 5). A foreign, unknown or malformed document id all answer the same 404. */
export function suggestRoutes(deps: SuggestRoutesDeps): Record<string, Handler> {
  const auth = authed(deps.authenticator);
  const choose =
    (op: "accept" | "dismiss"): AuthedHandler =>
    async (req, res, identity, ctx) => {
      const body = await readJson(req, res, TagNameRequest);
      if (!body) return;
      const id = idOf(ctx.params.id);
      const view = id ? await deps.tags[op](identity, id, body.name) : null;
      if (!view) return notFound(res, "document");
      json(res, 200, view satisfies DocumentTagsResponse);
    };
  return {
    "POST /api/documents/:id/tag-suggestions/accept": auth(choose("accept")),
    "POST /api/documents/:id/tag-suggestions/dismiss": auth(choose("dismiss")),

    "POST /api/documents/:id/tag-suggestions/refresh": auth(async (_req, res, identity, ctx) => {
      const id = idOf(ctx.params.id);
      const row = id
        ? await withTenant(deps.pool, identity.tenantId, (tx) =>
            getDocument(tx, identity.userId, id),
          )
        : undefined;
      if (!row) return notFound(res, "document");
      // The button is disabled for this case; the server says so too, before it spends a model call.
      if (row.summary_enc == null)
        return sendError(
          res,
          409,
          "no_summary",
          "this document has no summary to suggest tags from",
        );
      if (!deps.limiter.tryAcquire(identity.userId)) {
        res.setHeader("retry-after", "60");
        return sendError(res, 429, "too_many_requests", "too many requests; try again in a minute");
      }
      const started = await deps.starter.start({
        tenantId: identity.tenantId,
        userId: identity.userId,
        documentId: row.id,
      });
      if (started.kind === "disabled")
        return sendError(res, 409, "suggest_unavailable", "tag suggestions are not available");
      if (started.kind === "running")
        return sendError(res, 409, "suggest_running", "tags for this document are being suggested");
      json(res, 202, { started: true } satisfies SuggestTagsResponse);
    }),
  };
}
```

- [ ] **Step 9: Compose, shutdown**

`apps/server/app/compose.ts`: add imports `import { loomSuggestTagsStarter } from "./flows/suggest-tags/start";`, `import { suggestRoutes } from "./tags/suggestRoutes";` (the `UserRateLimit` import exists); pass the deps to `buildApp` (next to `chatTitle`): 

```ts
    suggestTags: {
      pool,
      fields,
      tags,
      bus: options.ingest.bus,
      ...(options.ingest.llm.summary && { llm: options.ingest.llm.summary }),
    },
```

After `const titles = …;` add:

```ts
  // On-demand tag suggestions: one flow, one model call; off with the `summary` role.
  const suggestTags = loomSuggestTagsStarter(app.runtime, {
    enabled: () => options.ingest.llm.summary !== undefined,
  });
```

in the routes, after `...tagRoutes({ authenticator, tags }),` add `...suggestRoutes({ pool, authenticator, tags, starter: suggestTags, limiter: new UserRateLimit() }),`; add `suggestTags,` to the returned object (with a doc comment `/** Starts the on-demand tag suggestions; shutdown awaits `idle()` with the other starts. */`).

`apps/server/app/bootIngest.ts`: destructure `suggestTags` from `built` next to `titles` and `turns` (lines ~106 and `BootIngestParts`' `built` type follows `buildServer`'s return), and in `startsIdle` add `await suggestTags?.idle();` after `await turns?.idle();`. A test that builds `parts()` without it keeps passing (optional chaining).

- [ ] **Step 9a: Erasure settles and cancels the suggest-tags starts (preflight F8), test first**

`erasure/wire.ts` drains and cancels the ingest, visualize and title starts before the key is shredded. A suggest-tags start fired just before an erasure could otherwise create an execution (and its log) after `eraseSubject`. Add this case to `apps/server/app/erasure/wire.test.ts`, inside `describe("erasureDeps", …)` (it uses the file's `parts()` and `who`):

```ts
  it("settles and cancels the document's suggest-tags runs with its other starts, and awaits the starter with the titles", async () => {
    const calls: string[] = [];
    const { parts: p } = parts({
      suggestTags: {
        settle: async (_who, doc) => void calls.push(`suggest.settle:${doc}`),
        cancel: async (_who, doc, reason) => void calls.push(`suggest.cancel:${doc}:${reason}`),
        idle: async () => void calls.push("suggest.idle"),
      },
    });
    const deps = erasureDeps(p);
    await deps.settleStart(who, "d");
    await deps.cancelVisualize(who, "d", 3);
    await deps.settleTitles();
    expect(calls).toEqual(["suggest.settle:d", "suggest.cancel:d:erased", "suggest.idle"]);
  });
```

Run: `pnpm --filter @docmind/server exec vitest run app/erasure/wire.test.ts` Expected: FAIL (`suggestTags` is not a part). In `apps/server/app/erasure/wire.ts`: add `import type { SuggestTagsStarter } from "../flows/suggest-tags/start";` (with the other flow imports); add to `ErasureParts`, after `visuals`: `/** The on-demand tag suggestion starter: its pending starts are settled and its runs cancelled like the other flows'. */ suggestTags?: Pick<SuggestTagsStarter, "cancel" | "idle" | "settle">;`; and change three members of the object `erasureDeps` returns:

```ts
    settleStart: (identity, documentId) =>
      drainWithin(
        Promise.all([
          p.starts.settle(identity, documentId),
          p.visuals.settle(identity, documentId),
          p.suggestTags?.settle(identity, documentId),
        ]).then(() => undefined),
        SETTLE_MS,
      ),
    settleTitles: async () => {
      await p.titles?.idle();
      await p.visuals.idle(); // a fired visualize start has landed (and is cancelled by cancelVisualize) before the shred
      await p.suggestTags?.idle(); // likewise a fired suggest-tags start
    },
```

and

```ts
    cancelVisualize: async (identity, documentId, generation) => {
      await p.visuals.cancel(identity, documentId, generation, ERASED);
      await p.suggestTags?.cancel(identity, documentId, ERASED); // the document's on-demand tag runs stop at the same point
    },
```

In `apps/server/app/compose.ts`, in the `erasureDeps({ … })` call (around line 440) add `suggestTags,` after `visuals,` (the starter is built earlier in this step). Run the wire tests and `pnpm --filter @docmind/server exec vitest run app/erasure/eraser.test.ts app/erasure/wiring.pg.test.ts` with the Postgres env: PASS (the eraser's own tests build `ErasureDeps` directly, and `suggestTags` is optional in the parts).

- [ ] **Step 10: Run everything**

Run: `set -a; . ./.env; set +a; pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm --filter @docmind/server exec vitest run app/flows/suggest-tags app/tags app/erasure/wire.test.ts app/security.test.ts app/bootIngest.test.ts app/config.test.ts app/documents && pnpm --filter @docmind/contracts exec vitest run`
Expected: PASS; the pg files ran. `app/executionIds.test.ts` (the ratchet that every start passes an `executionIdFor` id) passes: the starter uses `suggestTagsExecutionId`.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat(tags): on-demand suggest-tags flow, accept, dismiss and refresh routes"
```

---

## Task 6: The documents page: tag filter through the library view, tag bar, manage panel, URL state

**Files:**
- Modify (server half, the `library` view's `documents` provider): `packages/experiences/src/invoker.ts`, `views.ts`, `reshapers.ts`, `providers.ts`; tests `hydrate.test.ts`, `reshapers.test.ts`, `visuals.test.ts` (the pin list), and any other test naming `documents.list@1` or `document.get@1`
- Modify: `apps/server/app/ui/readers.ts` (`documents` takes `tags` and `match`); test `apps/server/app/ui/tagFilter.pg.test.ts`
- Modify (web): `apps/web/src/router.ts`, `router.test.ts`, `api/client.ts`, `api/client.test.ts`, `components/dm-documents-page.ts`, `components/dm-documents-page.test.ts`, `components/index.ts` (import the new elements if it lists them), `testing/fakeServer.ts`, `testing/fakeServer.test.ts` (the tag routes, moved here from the detail task)
- Modify: `apps/server/app/ui/ui.pg.test.ts` (its `readers.documents` calls take `tags` and `match`)
- Create: `apps/web/src/testing/tags.ts` (helpers shared by the tag component tests and the page test)
- Create: `apps/web/src/components/dm-tag-bar.ts`, `dm-tag-bar.test.ts`, `dm-tag-manage.ts`, `dm-tag-manage.test.ts`

**Interfaces:**
- Consumes: `TagIdList`, `TagMatch`, `TagSummary`, `DocumentTag`, `ListTagsResponse`, `TagResponse`, `DocumentTagsResponse` (Task 1); `DocumentDto.tags` (Task 3); the tag routes (Tasks 3 and 5); `listDocuments(tx, owner, { tenantId, filter })` (Task 3); `ServicesController`, `confirmDialog`, `ApiError`, `unnamedControls` (`testing/dom.ts`).
- Produces:
  - `UiReaders.documents(a: { limit: number; status: ...; tags: string[]; match: "any" | "all" })`; the `documents` provider's `overridable` is `["status", "tags", "match"]` (`tags` a comma-separated id string on the wire, validated by `TagIdList`); `PINS["documents.list"]` and `PINS["document.get"]` are `@2`; the library table's columns are `Name, Tags, Type, Size, Status, Added`, and the Tags cell of a row is the loom-ui token cell `{ tokens: [{ id: <tag id>, label: <tag name> }] }`
  - `Route` for the library: `{ name: "documents"; tags?: string[]; match?: "all" }` (`match` omitted means Any); `hrefOf` writes `/documents?tags=<id>,<id>&match=all`
  - `Api`: `listTags(): Promise<ListTagsResponse>`, `createTag(name): Promise<TagResponse>`, `renameTag(id, name): Promise<DocumentTag>`, `deleteTag(id): Promise<void>`, `addDocumentTag(id, name): Promise<DocumentTagsResponse>`, `removeDocumentTag(id, tagId): Promise<DocumentTagsResponse>`, `acceptTagSuggestion(id, name): Promise<DocumentTagsResponse>`, `dismissTagSuggestion(id, name): Promise<DocumentTagsResponse>`, `refreshTagSuggestions(id): Promise<void>`
  - `<dm-tag-bar>`: properties `tags: TagSummary[]`, `selected: string[]`, `match: "any" | "all"`, `count: number | null`, `managing: boolean`; events `tag-selection` (`detail: { tags: string[]; match: "any" | "all" }`) and `manage-toggle`
  - `<dm-tag-manage>`: property `tags: TagSummary[]`; event `tags-changed`
  - `<dm-documents-page>` answers the table's `TABLE_TOKEN` action (`payload: { rowKey, tokenId }`, from `@loom-ui/core/browser`) by navigating to `{ name: "documents", tags: [tokenId] }` when the served table holds that token in that row (the selection is replaced, not added to); it is not an `intentOf` intent, because it only navigates
  - `apps/web/src/testing/tags.ts`: `tag(n, name, documents)`, `root(el)`, `q(el, selector)`, `all(el, selector)`

- [ ] **Step 0: Gate: the linked loom-ui has token cells (preflight F1)**

The row chips of spec section 6 are a loom-ui **token cell**, delivered by loom-ui PR #131 (pin `fc34435285e3411b720107f06990d5f0d76a67c2`). The contract this task uses, read from `packages/core/src/tableRows.ts` and `index.ts`/`browser.ts` at that SHA:
- a `TableCell` may be `{ tokens: { id: string; label: string }[] }` (types `TableToken`, `TableTokenCell`); at most `MAX_CELL_TOKENS` = 20 tokens (over the cap the whole value is refused, never truncated); a token id matches `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$` and is unique within the cell (a tag uuid fits); a label is 1 to `MAX_TOKEN_LABEL` = 80 characters of plain text; any other key is refused; problems surface through `tableRowProblems` at `["rows", r, c]`; `rowKeys` stay optional;
- each chip renders as `<button type="button" class="chip" data-token=<id>>` (disabled when the table has no `onAction`), and `tableCellText(cell)` gives the labels joined with `", "`;
- pressing a chip calls `onAction` with `{ type: "TABLE_TOKEN", widgetId, payload }` (constant `TABLE_TOKEN`), `payload: { rowKey, tokenId }` for a table with `rowKeys` (the library table has them), `{ rowIndex, tokenId }` otherwise.

Run: `grep -n "TABLE_TOKEN\|MAX_CELL_TOKENS" ../loom-ui/packages/core/src/tableRows.ts && git -C ../loom-ui merge-base --is-ancestor fc34435285e3411b720107f06990d5f0d76a67c2 HEAD && echo pinned`
Expected: lines naming `TABLE_TOKEN` and `MAX_CELL_TOKENS`, then `pinned`. If it fails, STOP and report it: do **not** fall back to a text column (there is no fallback path in this plan). CI's loom-ui pin is moved to that SHA separately; `ci.yml` is not part of this plan.

- [ ] **Step 1: The provider takes `tags` and `match`, test first**

In `packages/experiences/src/hydrate.test.ts` change the expectations that name the reader call to the new arguments: every `toHaveBeenCalledWith({ limit: 200, status: "all" })` becomes `toHaveBeenCalledWith({ limit: 200, status: "all", tags: [], match: "any" })` and `{ limit: 200, status: "failed" }` becomes `{ limit: 200, status: "failed", tags: [], match: "any" }`. Then add (the file has `req`, `views`, `readers` helpers and `id(n)` for uuids):

```ts
  it("a tags and match parameter override only the documents step, and reach the reader as ids", async () => {
    // Ids with hex letters: an upper-cased digit-only id is unchanged, and the case folding would go untested.
    const a = "0a000000-0000-4000-8000-00000000000a";
    const b = "0b000000-0000-4000-8000-00000000000b";
    expect(b.toUpperCase()).not.toBe(b);
    const r = readers();
    await views().hydrate(
      "library",
      [req("library", "documents", { tags: `${a},${b.toUpperCase()},${a}`, match: "all" })],
      r,
      "u",
    );
    expect(r.documents).toHaveBeenCalledWith({ limit: 200, status: "all", tags: [a, b], match: "all" });
    const counts = readers();
    await views().hydrate("library", [req("library", "doc-total", { tags: a, match: "all" })], counts, "u");
    expect(counts.documents).toHaveBeenCalledWith({ limit: 200, status: "all", tags: [], match: "any" });
  });

  it("refuses a malformed tags or match parameter before any reader runs", async () => {
    const r = readers();
    const eleven = Array.from({ length: 11 }, (_, i) => id(i + 1)).join(",");
    for (const params of [{ tags: "nope" }, { tags: eleven }, { match: "some" }]) {
      const [out] = await views().hydrate("library", [req("library", "documents", params)], r, "u");
      expect(out?.state).not.toBe("ready");
    }
    expect(r.documents).not.toHaveBeenCalled();
  });
```

Run: `pnpm --filter @docmind/experiences exec vitest run src/hydrate.test.ts` Expected: FAIL.

In `packages/experiences/src/invoker.ts`: import `TagIdList, TagMatch` from `@docmind/contracts` (where `Uuid` comes from), change the `documents` reader to `documents(a: { limit: number; status: "all" | "ready" | "processing" | "failed"; tags: string[]; match: "any" | "all" }): Promise<RawDocuments>;`, and the `documents.list` args to:

```ts
  "documents.list": z
    .object({
      limit: z.number().int().min(1).max(LIST_CAP),
      status: z.enum(["all", "ready", "processing", "failed"]).default("all"),
      /** Comma-separated tag ids (at most 10, deduplicated, lower-cased); empty is no filter. */
      tags: TagIdList.default(""),
      match: TagMatch.default("any"),
    })
    .strict(),
```

In `views.ts`, the `documents` provider: `overridable: ["status", "tags", "match"],`. In `providers.ts`: `"documents.list": "docmind:documents.list@2",` and `"document.get": "docmind:document.get@2",` (their raw output now carries `tags`). Update every test that names those pins (`grep -rn "@1" packages/experiences apps | grep -i "documents.list\|document.get"`, e.g. `visuals.test.ts:540`). In `reshapers.ts` replace the `library-table` reshaper's `columns` and `rows` (the Tags cell is a loom-ui token cell, one token per tag; its rules hold by construction: a document has at most 20 tags, the cell cap, a tag id is a uuid and a name is 1 to 40 characters):

```ts
    columns: ["Name", "Tags", "Type", "Size", "Status", "Added"],
    rows: raw.items.map((d) => [
      d.title,
      { tokens: d.tags.map((t) => ({ id: t.id, label: t.name })) },
      typeOf(d.mime),
      formatBytes(d.sizeBytes),
      STATUS_TEXT[d.status],
      d.createdAt.slice(0, 10),
    ]),
```

and extend `reshapers.test.ts`'s library-table case: the columns are `["Name", "Tags", "Type", "Size", "Status", "Added"]` and column 1 is a token cell: a document with tags `[{ id: a, name: "Finance" }, { id: b, name: "Q3" }]` gives `{ tokens: [{ id: a, label: "Finance" }, { id: b, label: "Q3" }] }` (and `{ tokens: [] }` with none). In the same case assert that loom-ui accepts the whole value: `expect(tableRowProblems({ rows: out.rows, rowKeys: out.rowKeys, rowActions: out.rowActions })).toEqual([])` (`import { tableRowProblems } from "@loom-ui/core"`, as the other experiences tests import loom-ui). Run the experiences suite: PASS.

- [ ] **Step 2: The reader filters, test first**

Create `apps/server/app/ui/tagFilter.pg.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FieldCrypto } from "../crypto/fields";
import { PG_URL } from "../db/testSupport";
import {
  ALICE,
  type DocumentHarness,
  seedDoc,
  startDocumentServer,
} from "../documents/testHarness";
import { readersFor } from "./readers";

describe.skipIf(!PG_URL)("the library reader with a tag filter (needs DOCMIND_TEST_PG_URL)", () => {
  let h: DocumentHarness;
  let docs: string[];
  let tag: { a: string; b: string };
  beforeAll(async () => {
    h = await startDocumentServer();
  });
  afterAll(async () => void (await h?.close()));
  beforeEach(async () => {
    await h.owner.query("DELETE FROM tags");
    await h.owner.query("DELETE FROM documents");
    const fields = new FieldCrypto(h.keys);
    docs = [];
    for (let i = 0; i < 4; i++)
      docs.push(
        await seedDoc(
          h.owner,
          h.app,
          fields,
          ALICE,
          (i + 1).toString(16).padStart(64, "0"),
          (i + 1) * 10,
        ),
      );
    tag = {
      a: (await h.tags.create(ALICE, "a")).tag.id,
      b: (await h.tags.create(ALICE, "b")).tag.id,
    };
    await h.tags.setForDocument(ALICE, docs[0] as string, [tag.a]);
    await h.tags.setForDocument(ALICE, docs[1] as string, [tag.a, tag.b]);
    await h.tags.setForDocument(ALICE, docs[2] as string, [tag.b]);
  });
  const readers = () =>
    readersFor(
      { pool: h.app, fields: new FieldCrypto(h.keys), status: h.status, tags: h.tags } as never,
      ALICE,
    );
  const ids = async (a: {
    tags: string[];
    match: "any" | "all";
    status?: "all" | "processing" | "ready" | "failed";
  }) =>
    (
      await readers().documents({
        limit: 100,
        status: a.status ?? "all",
        tags: a.tags,
        match: a.match,
      })
    ).items.map((d) => d.id);

  it("filters in SQL by any or all, newest first, and carries each row's tags", async () => {
    expect(await ids({ tags: [tag.a, tag.b], match: "any" })).toEqual([docs[0], docs[1], docs[2]]);
    expect(await ids({ tags: [tag.a, tag.b], match: "all" })).toEqual([docs[1]]);
    expect(await ids({ tags: [], match: "all" })).toEqual(docs);
    const page = await readers().documents({
      limit: 100,
      status: "all",
      tags: [tag.a],
      match: "any",
    });
    expect(page.items.map((d) => d.tags.map((t) => t.name))).toEqual([["a"], ["a", "b"]]);
  });

  it("combines with the status filter and the limit (truncated says there were more matches)", async () => {
    expect(await ids({ tags: [tag.a], match: "any", status: "failed" })).toEqual([]);
    expect(await ids({ tags: [tag.a], match: "any", status: "processing" })).toEqual([
      docs[0],
      docs[1],
    ]); // seeded documents are queued
    const one = await readers().documents({ limit: 1, status: "all", tags: [tag.a], match: "any" });
    expect([one.items.length, one.truncated]).toEqual([1, true]);
  });
});
```

Run: `set -a; . ./.env; set +a; pnpm --filter @docmind/server exec vitest run app/ui/tagFilter.pg.test.ts` Expected: FAIL. In `apps/server/app/ui/readers.ts` change `async documents({ limit, status })` to `async documents({ limit, status, tags, match })` and the `listDocuments` call to:

```ts
          (tx) =>
            listDocuments(tx, identity.userId, {
              cursor,
              limit: PAGE,
              tenantId: identity.tenantId,
              ...(tags.length > 0 && { filter: { tagIds: tags, match } }),
            }),
```

Run the test, `pnpm --filter @docmind/server exec vitest run app/ui` and `pnpm typecheck`: PASS (the fake readers in other tests that implement `documents` accept the wider argument; fix any whose type annotates the parameter).

In `apps/server/app/ui/ui.pg.test.ts` (the documents-reader test near line 245) the two calls become `readers.documents({ limit: 200, status: "processing", tags: [], match: "any" })` and `readers.documents({ limit: 1, status: "all", tags: [], match: "any" })` (both arguments are required now; the `readersFor` deps got `tags` in Task 3).

- [ ] **Step 3: URL state in the router, test first**

Add to the `table` in `apps/web/src/router.test.ts`'s first `describe` (these entries use the file's `ID`), and a new `describe`:

```ts
    ["/documents", `?tags=${ID}`, { name: "documents", tags: [ID] }],
    ["/documents", `?tags=${ID},${ID2}&match=all`, { name: "documents", tags: [ID, ID2], match: "all" }],
    ["/documents", `?tags=${ID.toUpperCase()},${ID}`, { name: "documents", tags: [ID] }],
    ["/documents", "?tags=nope,&match=all", { name: "documents" }],
    ["/documents", "?match=all", { name: "documents" }],
    ["/documents", `?tags=${ID}&match=any`, { name: "documents", tags: [ID] }],
```

(define `const ID2 = "1c5e8a63-7d64-4d7f-8e5a-3c1f8b4a0b21";` beside `ID`), and:

```ts
describe("the library route's tag filter in the address", () => {
  const ID2 = "1c5e8a63-7d64-4d7f-8e5a-3c1f8b4a0b21";
  it("round-trips: Any is omitted, All and the ids are written", () => {
    expect(hrefOf({ name: "documents" })).toBe("/documents");
    expect(hrefOf({ name: "documents", tags: [ID] })).toBe(`/documents?tags=${ID}`);
    expect(hrefOf({ name: "documents", tags: [ID, ID2], match: "all" })).toBe(
      `/documents?tags=${ID},${ID2}&match=all`,
    );
    expect(hrefOf({ name: "documents", tags: [] , match: "all"})).toBe("/documents");
  });
  it("keeps at most 10 distinct valid ids", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `1c5e8a63-7d64-4d7f-8e5a-${String(i).padStart(12, "0")}`);
    const r = parseRoute("/documents", `?tags=${ids.join(",")}`);
    expect(r).toEqual({ name: "documents", tags: ids.slice(0, 10) });
  });
});
```

Run: `pnpm --filter @docmind/web exec vitest run src/router.test.ts` Expected: FAIL. In `apps/web/src/router.ts`: change the `documents` member of `Route` to `| { name: "documents"; tags?: string[]; match?: "all" }`; add above `parseRoute`:

```ts
const MAX_TAGS = 10;

/** The library's `?tags=<id>,<id>&match=all`: valid ids only, lower-cased, deduplicated, at most 10; match is All or (omitted) Any. */
function libraryRoute(search: string): Route {
  const p = new URLSearchParams(search);
  const ids = [
    ...new Set(
      (p.get("tags") ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(isUuid),
    ),
  ].slice(0, MAX_TAGS);
  if (ids.length === 0) return { name: "documents" };
  return { name: "documents", tags: ids, ...(p.get("match") === "all" && { match: "all" as const }) };
}
```

change the `case "/documents":` to `return libraryRoute(search);` and add to `hrefOf`:

```ts
    case "documents": {
      if (!r.tags || r.tags.length === 0) return "/documents";
      return `/documents?tags=${r.tags.join(",")}${r.match === "all" ? "&match=all" : ""}`;
    }
```

Run the router tests: PASS.

- [ ] **Step 4: The API client, test first**

Add to `apps/web/src/api/client.test.ts` (inside `describe("createApi", …)`):

```ts
  it("reads, creates, renames and deletes tags, and tags a document, on the documented routes", async () => {
    const t = { id: "6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f", name: "Finance" };
    const view = { tags: [t], suggestedTags: ["Legal"] };
    const { api, calls } = apiWith((url, init) =>
      init.method === "DELETE" && url.startsWith("/api/tags/")
        ? new Response(null, { status: 204 })
        : url === "/api/tags" && init.method === "GET"
          ? ok({ tags: [{ ...t, documents: 2 }] })
          : url === "/api/tags"
            ? ok({ tag: t }, 201)
            : url.startsWith("/api/tags/")
              ? ok({ tag: { ...t, name: "Money" } })
              : url.endsWith("/refresh")
                ? ok({ started: true }, 202)
                : ok(view),
    );
    expect((await api.listTags()).tags[0]?.documents).toBe(2);
    expect((await api.createTag("Finance")).tag).toEqual(t);
    expect(await api.renameTag(t.id, "Money")).toEqual({ ...t, name: "Money" });
    await api.deleteTag(t.id);
    expect(await api.addDocumentTag("d1", "Finance")).toEqual(view);
    expect(await api.removeDocumentTag("d1", t.id)).toEqual(view);
    expect(await api.acceptTagSuggestion("d1", "Legal")).toEqual(view);
    expect(await api.dismissTagSuggestion("d1", "Legal")).toEqual(view);
    await api.refreshTagSuggestions("d1");
    expect(calls).toEqual([
      { url: "/api/tags", method: "GET" },
      { url: "/api/tags", method: "POST", body: { name: "Finance" } },
      { url: `/api/tags/${t.id}`, method: "PATCH", body: { name: "Money" } },
      { url: `/api/tags/${t.id}`, method: "DELETE" },
      { url: "/api/documents/d1/tags", method: "POST", body: { name: "Finance" } },
      { url: `/api/documents/d1/tags/${t.id}`, method: "DELETE" },
      { url: "/api/documents/d1/tag-suggestions/accept", method: "POST", body: { name: "Legal" } },
      { url: "/api/documents/d1/tag-suggestions/dismiss", method: "POST", body: { name: "Legal" } },
      { url: "/api/documents/d1/tag-suggestions/refresh", method: "POST" },
    ]);
  });
```

Run it: FAIL. In `apps/web/src/api/client.ts`: import `DocumentTag, DocumentTagsResponse, ListTagsResponse, SuggestTagsResponse, TagResponse` from `@docmind/contracts`; add to the `Api` interface (after `getDocument`):

```ts
  listTags(): Promise<ListTagsResponse>;
  createTag(name: string): Promise<TagResponse>;
  renameTag(id: string, name: string): Promise<DocumentTag>;
  deleteTag(id: string): Promise<void>;
  addDocumentTag(documentId: string, name: string): Promise<DocumentTagsResponse>;
  removeDocumentTag(documentId: string, tagId: string): Promise<DocumentTagsResponse>;
  acceptTagSuggestion(documentId: string, name: string): Promise<DocumentTagsResponse>;
  dismissTagSuggestion(documentId: string, name: string): Promise<DocumentTagsResponse>;
  /** Starts the on-demand suggestions (202). Rejects with `ApiError`: 409 `no_summary` / `suggest_running` / `suggest_unavailable`, 429. */
  refreshTagSuggestions(documentId: string): Promise<void>;
```

and to `createApi`'s returned object (after `getDocument`):

```ts
    listTags: () => http.request("GET", "/api/tags", { schema: ListTagsResponse }),
    createTag: (name) =>
      http.request("POST", "/api/tags", { body: { name }, schema: TagResponse }),
    renameTag: async (id, name) =>
      (
        await http.request("PATCH", `/api/tags/${seg(id)}`, {
          body: { name },
          schema: TagResponse,
        })
      ).tag,
    deleteTag: (id) => http.request("DELETE", `/api/tags/${seg(id)}`),
    addDocumentTag: (id, name) =>
      http.request("POST", `/api/documents/${seg(id)}/tags`, {
        body: { name },
        schema: DocumentTagsResponse,
      }),
    removeDocumentTag: (id, tagId) =>
      http.request("DELETE", `/api/documents/${seg(id)}/tags/${seg(tagId)}`, {
        schema: DocumentTagsResponse,
      }),
    acceptTagSuggestion: (id, name) =>
      http.request("POST", `/api/documents/${seg(id)}/tag-suggestions/accept`, {
        body: { name },
        schema: DocumentTagsResponse,
      }),
    dismissTagSuggestion: (id, name) =>
      http.request("POST", `/api/documents/${seg(id)}/tag-suggestions/dismiss`, {
        body: { name },
        schema: DocumentTagsResponse,
      }),
    refreshTagSuggestions: async (id) => {
      await http.request("POST", `/api/documents/${seg(id)}/tag-suggestions/refresh`, {
        schema: SuggestTagsResponse,
      });
    },
```

Run the client tests: PASS. (`http.request("DELETE", …)` with no `schema` answers `void` for the 204, as `deleteDocument` does.)

- [ ] **Step 5: `<dm-tag-bar>`, test first**

Create `apps/web/src/testing/tags.ts` (shared by `dm-tag-bar.test.ts`, `dm-tag-manage.test.ts`, `dm-doc-tags.test.ts` and `dm-documents-page.test.ts`; no test file keeps its own copy):

```ts
import type { TagSummary } from "@docmind/contracts";

/** A tag as the server lists it; the id is a valid uuid made from `n`. */
export const tag = (n: number, name: string, documents: number): TagSummary => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  name,
  documents,
});
/** The shadow root of a mounted element. */
export const root = (el: Element) => el.shadowRoot as ShadowRoot;
/** The first match inside an element's shadow root. */
export const q = <T extends Element>(el: Element, selector: string) =>
  root(el).querySelector(selector) as T;
/** Every match inside an element's shadow root. */
export const all = <T extends Element>(el: Element, selector: string) =>
  [...root(el).querySelectorAll(selector)] as T[];
```

Create `apps/web/src/components/dm-tag-bar.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { unnamedControls } from "../testing/dom";
import { root, tag } from "../testing/tags";
import "./dm-tag-bar";

const TAGS = [tag(1, "Finance", 3), tag(2, "Legal", 1), tag(3, "Q3", 0)];

async function mount(props: Record<string, unknown> = {}) {
  const el = document.createElement("dm-tag-bar") as HTMLElement & {
    updateComplete: Promise<unknown>;
  };
  Object.assign(el, {
    tags: TAGS,
    selected: [],
    match: "any",
    count: null,
    managing: false,
    ...props,
  });
  document.body.append(el);
  await el.updateComplete;
  return el;
}
const chips = (el: Element) => [
  ...root(el).querySelectorAll<HTMLButtonElement>("button[data-tag]"),
];
const listen = (el: Element, name: string) => {
  const seen: unknown[] = [];
  el.addEventListener(name, (e) => seen.push((e as CustomEvent).detail));
  return seen;
};

describe("dm-tag-bar", () => {
  it("draws one toggle chip per tag with its count, and says which are pressed", async () => {
    const el = await mount({ selected: [TAGS[1]?.id] });
    expect(chips(el).map((b) => b.textContent?.replace(/\s+/g, " ").trim())).toEqual([
      "Finance 3",
      "Legal 1",
      "Q3 0",
    ]);
    expect(chips(el).map((b) => b.getAttribute("aria-pressed"))).toEqual([
      "false",
      "true",
      "false",
    ]);
  });

  it("toggling a chip reports the new selection with the current mode", async () => {
    const el = await mount({ selected: [TAGS[0]?.id], match: "all" });
    const seen = listen(el, "tag-selection");
    chips(el)[1]?.click();
    chips(el)[0]?.click();
    expect(seen).toEqual([
      { tags: [TAGS[0]?.id, TAGS[1]?.id], match: "all" },
      { tags: [], match: "all" },
    ]);
  });

  it("offers Any and All as a radio group, enabled from 2 selected tags", async () => {
    const one = await mount({ selected: [TAGS[0]?.id] });
    const group = root(one).querySelector("[role=radiogroup]");
    expect(group?.getAttribute("aria-label")).toBe("Match");
    const radios = (el: Element) => [
      ...root(el).querySelectorAll<HTMLInputElement>("input[type=radio]"),
    ];
    expect(radios(one).map((r) => [r.value, r.disabled, r.checked])).toEqual([
      ["any", true, true],
      ["all", true, false],
    ]);
    const two = await mount({ selected: [TAGS[0]?.id, TAGS[1]?.id], match: "all" });
    expect(radios(two).map((r) => [r.disabled, r.checked])).toEqual([
      [false, false],
      [false, true],
    ]);
    const seen = listen(two, "tag-selection");
    radios(two)[0]?.click();
    expect(seen).toEqual([{ tags: [TAGS[0]?.id, TAGS[1]?.id], match: "any" }]);
  });

  it("Clear empties the selection and is disabled when there is none", async () => {
    const empty = await mount();
    expect(root(empty).querySelector<HTMLButtonElement>("[data-clear]")?.disabled).toBe(true);
    const el = await mount({ selected: [TAGS[0]?.id], match: "all" });
    const seen = listen(el, "tag-selection");
    root(el).querySelector<HTMLButtonElement>("[data-clear]")?.click();
    expect(seen).toEqual([{ tags: [], match: "any" }]);
  });

  it("stops at 10 selected tags: the others cannot be pressed, the pressed ones can be released", async () => {
    const many = Array.from({ length: 11 }, (_, i) => tag(i + 1, `t${i}`, 1));
    const el = await mount({ tags: many, selected: many.slice(0, 10).map((t) => t.id) });
    expect(chips(el).map((b) => b.disabled)).toEqual([...Array(10).fill(false), true]);
  });

  it("announces the result count politely, only while a filter is on", async () => {
    const el = await mount({ selected: [TAGS[0]?.id], count: 3 });
    const live = root(el).querySelector("[role=status]");
    expect(live?.getAttribute("aria-live")).toBe("polite");
    expect(live?.textContent?.trim()).toBe("3 documents match");
    (el as unknown as { count: number }).count = 1;
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
    expect(live?.textContent?.trim()).toBe("1 document matches");
    const none = await mount({ selected: [], count: 7 });
    expect(root(none).querySelector("[role=status]")?.textContent?.trim()).toBe("");
  });

  it("Manage tags toggles the panel and says whether it is open", async () => {
    const el = await mount({ managing: true });
    const button = root(el).querySelector<HTMLButtonElement>("[data-manage]");
    expect(button?.getAttribute("aria-expanded")).toBe("true");
    const seen = listen(el, "manage-toggle");
    button?.click();
    expect(seen).toHaveLength(1);
  });

  it("has no control without an accessible name", async () => {
    expect(
      unnamedControls(await mount({ selected: [TAGS[0]?.id, TAGS[1]?.id], managing: true })),
    ).toEqual([]);
  });
});
```

Run: `pnpm --filter @docmind/web exec vitest run src/components/dm-tag-bar.test.ts` Expected: FAIL. Create `apps/web/src/components/dm-tag-bar.ts`:

```ts
import type { TagSummary } from "@docmind/contracts";
import { LitElement, css, html } from "lit";
import { baseStyles } from "../styles/base";

export type TagMatch = "any" | "all";
export interface TagSelectionDetail {
  tags: string[];
  match: TagMatch;
}
/** A filter holds at most 10 tags (the server refuses more). */
export const MAX_SELECTED_TAGS = 10;

/**
 * The library's tag bar: one toggle chip per tag, an Any / All radio group (enabled from 2 selected tags), Clear and Manage
 * tags. It owns no data: the page gives it the tags and the selection, and it reports changes as `tag-selection`.
 */
export class DmTagBar extends LitElement {
  static properties = {
    tags: { attribute: false },
    selected: { attribute: false },
    match: { type: String },
    count: { attribute: false },
    managing: { type: Boolean },
  };
  static styles = [
    baseStyles,
    css`
      :host { display: block; margin-bottom: 12px; }
      .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .chips { display: flex; flex-wrap: wrap; gap: 6px; }
      .chip { display: inline-flex; align-items: center; gap: 6px; padding: 2px 10px; min-height: 28px; border-radius: 999px; border: 1px solid var(--dm-divider); background: transparent; color: var(--dm-text); cursor: pointer; }
      .chip[aria-pressed="true"] { border-color: var(--dm-accent); color: var(--dm-accent); background: color-mix(in srgb, var(--dm-accent) 12%, transparent); }
      .chip:disabled { opacity: 0.45; cursor: default; }
      .chip .n { color: var(--dm-muted); font-size: 12px; }
      .mode { display: inline-flex; gap: 10px; align-items: center; }
      .mode label { display: inline-flex; gap: 4px; align-items: center; }
      .mode input:disabled + span { color: var(--dm-muted); }
    `,
  ];
  declare tags: TagSummary[];
  declare selected: string[];
  declare match: TagMatch;
  /** How many documents the filtered table shows; null while unknown. */
  declare count: number | null;
  declare managing: boolean;
  constructor() {
    super();
    this.tags = [];
    this.selected = [];
    this.match = "any";
    this.count = null;
    this.managing = false;
  }

  private emit(tags: string[], match: TagMatch): void {
    this.dispatchEvent(
      new CustomEvent<TagSelectionDetail>("tag-selection", {
        detail: { tags, match },
        bubbles: true,
        composed: true,
      }),
    );
  }
  private toggle(id: string): void {
    this.emit(
      this.selected.includes(id) ? this.selected.filter((x) => x !== id) : [...this.selected, id],
      this.match,
    );
  }
  private announcement(): string {
    if (this.selected.length === 0 || this.count === null) return "";
    return this.count === 1 ? "1 document matches" : `${this.count} documents match`;
  }

  render() {
    const full = this.selected.length >= MAX_SELECTED_TAGS;
    return html`
      <div class="bar" role="group" aria-label="Filter by tag">
        <div class="chips">
          ${this.tags.map((t) => {
            const on = this.selected.includes(t.id);
            return html`<button type="button" class="chip" data-tag=${t.id} aria-pressed=${on ? "true" : "false"} ?disabled=${full && !on} @click=${() => this.toggle(t.id)}>${t.name} <span class="n">${t.documents}</span></button>`;
          })}
        </div>
        <div class="mode" role="radiogroup" aria-label="Match">
          ${(["any", "all"] as const).map(
            (m) =>
              html`<label><input type="radio" name="match" value=${m} .checked=${this.match === m} ?disabled=${this.selected.length < 2} @change=${() => this.emit(this.selected, m)} /><span>${m === "any" ? "Any" : "All"}</span></label>`,
          )}
        </div>
        <button type="button" class="btn ghost" data-clear ?disabled=${this.selected.length === 0} @click=${() => this.emit([], "any")}>Clear</button>
        <button type="button" class="btn ghost" data-manage aria-expanded=${this.managing ? "true" : "false"} @click=${() => this.dispatchEvent(new CustomEvent("manage-toggle", { bubbles: true, composed: true }))}>Manage tags</button>
      </div>
      <p class="sr-only" role="status" aria-live="polite" data-count>${this.announcement()}</p>`;
  }
}
customElements.define("dm-tag-bar", DmTagBar);
```

Run the bar tests: PASS. (The test's `Clear` expects `match: "any"`: Clear resets the mode too, and the URL drops both.)

- [ ] **Step 6: `<dm-tag-manage>`, test first**

Create `apps/web/src/components/dm-tag-manage.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/http";
import { createServices } from "../services";
import { unnamedControls } from "../testing/dom";
import { mountWith } from "../testing/mount";
import { q, root, tag } from "../testing/tags";
import "./dm-tag-manage";

type El = HTMLElement & { updateComplete: Promise<unknown> };

async function setup(tags = [tag(1, "Finance", 3), tag(2, "Legal", 1), tag(3, "Unused", 0)]) {
  const api = {
    renameTag: vi.fn(async (id: string, name: string) => ({ id, name })),
    deleteTag: vi.fn(async () => {}),
  };
  const services = createServices({ api: api as never });
  const el = await mountWith<El>(services, "dm-tag-manage", { tags });
  const changed: number[] = [];
  el.addEventListener("tags-changed", () => changed.push(1));
  return { el, api, changed };
}

describe("dm-tag-manage", () => {
  it("lists every tag with its document count and a named Rename and Delete", async () => {
    const t = await setup();
    expect(
      [...root(t.el).querySelectorAll("li")].map(
        (li) => li.textContent?.replace(/\s+/g, " ").trim().split(" Rename")[0],
      ),
    ).toEqual(["Finance 3 documents", "Legal 1 document", "Unused 0 documents"]);
    expect(unnamedControls(t.el)).toEqual([]);
    expect(q<HTMLButtonElement>(t.el, "button[aria-label='Rename Finance']")).not.toBeNull();
    expect(q<HTMLButtonElement>(t.el, "button[aria-label='Delete Finance']")).not.toBeNull();
  });

  it("renames inline: edit, Enter or Save, then tags-changed", async () => {
    const t = await setup();
    q<HTMLButtonElement>(t.el, "button[aria-label='Rename Finance']").click();
    await t.el.updateComplete;
    const input = q<HTMLInputElement>(t.el, "input[aria-label='New name for Finance']");
    expect(input.value).toBe("Finance");
    input.value = "  Money ";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await vi.waitFor(() => expect(t.api.renameTag).toHaveBeenCalledWith(tag(1, "", 0).id, "Money"));
    await vi.waitFor(() => expect(t.changed).toHaveLength(1));
  });

  it("Escape cancels the edit without calling the server", async () => {
    const t = await setup();
    q<HTMLButtonElement>(t.el, "button[aria-label='Rename Legal']").click();
    await t.el.updateComplete;
    q<HTMLInputElement>(t.el, "input[aria-label='New name for Legal']").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape" }),
    );
    await t.el.updateComplete;
    expect(q(t.el, "input")).toBeNull();
    expect(t.api.renameTag).not.toHaveBeenCalled();
  });

  it("shows a fixed sentence for a name that is taken, and keeps editing", async () => {
    const t = await setup();
    t.api.renameTag.mockRejectedValueOnce(new ApiError(409, "tag_exists"));
    q<HTMLButtonElement>(t.el, "button[aria-label='Rename Legal']").click();
    await t.el.updateComplete;
    const input = q<HTMLInputElement>(t.el, "input[aria-label='New name for Legal']");
    input.value = "Finance";
    input.dispatchEvent(new Event("input"));
    q<HTMLButtonElement>(t.el, "button[data-save]").click();
    await vi.waitFor(() =>
      expect(q(t.el, "[role=alert]")?.textContent).toContain(
        "A tag with that name already exists.",
      ),
    );
    expect(q(t.el, "input")).not.toBeNull();
    expect(t.changed).toHaveLength(0);
  });

  it("asks before deleting, naming how many documents use the tag, and deletes on yes", async () => {
    const t = await setup();
    q<HTMLButtonElement>(t.el, "button[aria-label='Delete Finance']").click();
    await vi.waitFor(() => expect(document.querySelector("dm-dialog")).not.toBeNull());
    expect(document.querySelector("dm-dialog")?.textContent).toContain("Finance");
    expect(document.querySelector("dm-dialog")?.textContent).toContain("3 documents");
    [...document.querySelectorAll("dm-dialog button")]
      .find((b) => b.textContent === "Delete")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(t.api.deleteTag).toHaveBeenCalledWith(tag(1, "", 0).id));
    await vi.waitFor(() => expect(t.changed).toHaveLength(1));
  });

  it("does not delete on Cancel, and says so plainly for a tag no document uses", async () => {
    const t = await setup();
    q<HTMLButtonElement>(t.el, "button[aria-label='Delete Unused']").click();
    await vi.waitFor(() => expect(document.querySelector("dm-dialog")).not.toBeNull());
    expect(document.querySelector("dm-dialog")?.textContent).toContain("no document");
    [...document.querySelectorAll("dm-dialog button")]
      .find((b) => b.textContent === "Cancel")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector("dm-dialog")).toBeNull());
    expect(t.api.deleteTag).not.toHaveBeenCalled();
  });
});
```

Run: FAIL. Create `apps/web/src/components/dm-tag-manage.ts`:

```ts
import type { TagSummary } from "@docmind/contracts";
import { LitElement, css, html } from "lit";
import { ApiError } from "../api/http";
import { ServicesController } from "../state/services-controller";
import { baseStyles } from "../styles/base";
import { confirmDialog } from "./confirm";

const used = (n: number): string => `${n} ${n === 1 ? "document" : "documents"}`;

/** The Manage tags panel: rename a tag inline, delete it after a confirmation that names how many documents use it. */
export class DmTagManage extends LitElement {
  static properties = {
    tags: { attribute: false },
    editing: { state: true },
    draft: { state: true },
    error: { state: true },
    busy: { state: true },
  };
  static styles = [
    baseStyles,
    css`
      :host { display: block; margin: 0 0 16px; padding: 12px; border: 1px solid var(--dm-divider); border-radius: var(--dm-radius-md); }
      ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
      li { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
      .name { min-width: 8ch; font-weight: 500; }
      .n { color: var(--dm-muted); }
      input { min-width: 16ch; }
      [role="alert"] { color: var(--dm-danger, #b3261e); margin: 8px 0 0; }
    `,
  ];
  declare tags: TagSummary[];
  declare editing: string | null;
  declare draft: string;
  declare error: string | null;
  declare busy: boolean;
  private readonly ctx = new ServicesController(this);
  private leaving = new AbortController();
  constructor() {
    super();
    this.tags = [];
    this.editing = null;
    this.draft = "";
    this.error = null;
    this.busy = false;
  }
  connectedCallback(): void {
    super.connectedCallback();
    if (this.leaving.signal.aborted) this.leaving = new AbortController();
  }
  disconnectedCallback(): void {
    this.leaving.abort(); // a confirmation still open then answers no
    super.disconnectedCallback();
  }

  private changed(): void {
    this.dispatchEvent(new CustomEvent("tags-changed", { bubbles: true, composed: true }));
  }
  private edit(t: TagSummary): void {
    this.editing = t.id;
    this.draft = t.name;
    this.error = null;
  }
  private async save(t: TagSummary): Promise<void> {
    const api = this.ctx.services?.api;
    const name = this.draft.trim();
    if (!api || this.busy) return;
    if (name === "") {
      this.error = "Enter a name.";
      return;
    }
    if (name === t.name) {
      this.editing = null;
      return;
    }
    this.busy = true;
    this.error = null;
    try {
      await api.renameTag(t.id, name);
      this.editing = null;
      this.changed();
    } catch (err) {
      this.error =
        err instanceof ApiError && err.status === 409
          ? "A tag with that name already exists."
          : err instanceof ApiError && err.status === 400
            ? "That is not a valid tag name (1 to 40 characters, no control characters)."
            : "Couldn't rename the tag. Try again.";
    } finally {
      this.busy = false;
    }
  }
  private async remove(t: TagSummary): Promise<void> {
    const api = this.ctx.services?.api;
    if (!api) return;
    const body =
      t.documents === 0
        ? `"${t.name}" is used by no document. Deleting it cannot change any document.`
        : `"${t.name}" is used by ${used(t.documents)}. Deleting it removes it from them; the documents are kept.`;
    if (!(await confirmDialog("Delete this tag?", body, "Delete", true, this.leaving.signal)))
      return;
    this.error = null;
    try {
      await api.deleteTag(t.id);
      this.changed();
    } catch {
      this.error = "Couldn't delete the tag. Try again.";
    }
  }
  private onKey(e: KeyboardEvent, t: TagSummary): void {
    if (e.key === "Enter") void this.save(t);
    else if (e.key === "Escape") this.editing = null;
  }

  render() {
    return html`
      <ul>
        ${this.tags.map((t) =>
          this.editing === t.id
            ? html`<li><input aria-label=${`New name for ${t.name}`} maxlength="40" .value=${this.draft} @input=${(
                e: Event,
              ) => {
                this.draft = (e.target as HTMLInputElement).value;
              }} @keydown=${(e: KeyboardEvent) => this.onKey(e, t)} />
                <button type="button" class="btn primary" data-save ?disabled=${this.busy} @click=${() => void this.save(t)}>Save</button>
                <button type="button" class="btn ghost" data-cancel @click=${() => {
                  this.editing = null;
                }}>Cancel</button></li>`
            : html`<li><span class="name">${t.name}</span> <span class="n">${used(t.documents)}</span>
                <button type="button" class="btn ghost" aria-label=${`Rename ${t.name}`} @click=${() => this.edit(t)}>Rename</button>
                <button type="button" class="btn ghost" aria-label=${`Delete ${t.name}`} @click=${() => void this.remove(t)}>Delete</button></li>`,
        )}
      </ul>
      ${this.error ? html`<p role="alert">${this.error}</p>` : null}`;
  }
}
customElements.define("dm-tag-manage", DmTagManage);
```

Run the manage tests: PASS. (The confirmation body quotes the tag name inside `dm-dialog` text content; the dialog is the existing `confirmDialog`.)

- [ ] **Step 7: The page, test first**

**Part A: the fake server serves the tag routes (moved here from the detail task, preflight F5).** The page calls `GET /api/tags` from now on, and `acceptance.test.ts` runs against this fake in Step 8; the routes are written here once and the detail task reuses them.

Append to `apps/web/src/testing/fakeServer.test.ts` (it has the `post(s, path, body?, method?)` helper and `signedIn()` that returns a signed-in `FakeServer`; add `type DocumentDto` to its contracts import):

```ts
  it("serves tags: create or reuse by name, link, accept, dismiss, rename, delete, and suggestions", async () => {
    const s = await signedIn();
    const fakeDoc = (id: string): DocumentDto => ({
      id, title: id, filename: id, mime: "text/plain", sizeBytes: 1, status: "ready", error: null,
      stats: null, summary: null, tags: [], createdAt: "2026-11-10T10:00:00.000Z", updatedAt: "2026-11-10T10:00:00.000Z",
    });
    s.docs = [fakeDoc("d1"), fakeDoc("d2")];
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await post(s, path, body, method);
      return { status: res.status, body: res.status === 204 ? null : await res.json() };
    };
    const a = await call("POST", "/api/documents/d1/tags", { name: "Finance" });
    expect(a.body.tags.map((t: { name: string }) => t.name)).toEqual(["Finance"]);
    expect((await call("POST", "/api/documents/d1/tags", { name: " finance " })).body.tags).toHaveLength(1);
    expect((await call("GET", "/api/tags")).body.tags).toEqual([{ id: a.body.tags[0].id, name: "Finance", documents: 1 }]);
    s.suggestions.set("d1", ["Legal", "Misc"]);
    expect((await call("POST", "/api/documents/d1/tag-suggestions/accept", { name: "legal" })).body).toMatchObject({ suggestedTags: ["Misc"] });
    expect((await call("POST", "/api/documents/d1/tag-suggestions/dismiss", { name: "Misc" })).body.suggestedTags).toEqual([]);
    const id = a.body.tags[0].id;
    expect((await call("PATCH", `/api/tags/${id}`, { name: "Money" })).body.tag.name).toBe("Money");
    expect((await call("PATCH", `/api/tags/${id}`, { name: "legal" })).status).toBe(409);
    expect((await call("DELETE", `/api/tags/${id}`)).status).toBe(204);
    expect(s.docs[0]?.tags.map((t) => t.name)).toEqual(["legal"]);
    expect((await call("POST", "/api/documents/d1/tag-suggestions/refresh")).status).toBe(202);
    expect(s.refreshes).toEqual(["d1"]);
  });
```

Run: FAIL. In `apps/web/src/testing/fakeServer.ts` add the imports `type DocumentTag, type TagSummary` from `@docmind/contracts`, the fields:

```ts
  /** The user's tags (a tag with no document stays); documents carry their tags in `docs[i].tags`. */
  tagDefs: DocumentTag[] = [];
  /** Open suggestions by document id. */
  suggestions = new Map<string, string[]>();
  /** Document ids the suggest-tags refresh was asked for, in order. */
  refreshes: string[] = [];
```

and, in the request handler right before the `/api/chats` GET (so the more specific document sub-routes come first), these routes (names compared by lower-cased, whitespace-collapsed form):

```ts
    const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
    const view = (doc: DocumentDto) =>
      json(200, { tags: doc.tags, suggestedTags: this.suggestions.get(doc.id) ?? [] });
    const ensureTag = (name: string): DocumentTag => {
      const found = this.tagDefs.find((t) => norm(t.name) === norm(name));
      if (found) return found;
      const tag = { id: crypto.randomUUID(), name: name.trim() };
      this.tagDefs.push(tag);
      return tag;
    };
    if (path === "/api/tags" && method === "GET")
      return json(200, {
        tags: [...this.tagDefs]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((t): TagSummary => ({ ...t, documents: this.docs.filter((d) => d.tags.some((x) => x.id === t.id)).length })),
      });
    if (path === "/api/tags" && method === "POST") {
      const existed = this.tagDefs.some((t) => norm(t.name) === norm(String(body.name)));
      return json(existed ? 200 : 201, { tag: ensureTag(String(body.name)) });
    }
    m = /^\/api\/tags\/([^/]+)$/.exec(path);
    if (m) {
      const tag = this.tagDefs.find((t) => t.id === m?.[1]);
      if (!tag) return fail(404, "not_found");
      if (method === "PATCH") {
        if (this.tagDefs.some((t) => t !== tag && norm(t.name) === norm(String(body.name)))) return fail(409, "tag_exists");
        tag.name = String(body.name).trim();
        for (const d of this.docs) for (const x of d.tags) if (x.id === tag.id) x.name = tag.name;
        return json(200, { tag });
      }
      if (method === "DELETE") {
        this.tagDefs = this.tagDefs.filter((t) => t !== tag);
        for (const d of this.docs) d.tags = d.tags.filter((x) => x.id !== tag.id);
        return new Response(null, { status: 204 });
      }
    }
    m = /^\/api\/documents\/([^/]+)\/(tags|tags\/([^/]+)|tag-suggestions\/(accept|dismiss|refresh))$/.exec(path);
    if (m) {
      const doc = this.docs.find((d) => d.id === m?.[1]);
      if (!doc) return fail(404, "not_found");
      const link = (name: string) => {
        const tag = ensureTag(name);
        if (!doc.tags.some((x) => x.id === tag.id)) doc.tags = [...doc.tags, { ...tag }].sort((a, b) => a.name.localeCompare(b.name));
      };
      const drop = (name: string) =>
        this.suggestions.set(doc.id, (this.suggestions.get(doc.id) ?? []).filter((n) => norm(n) !== norm(name)));
      if (m[2] === "tags" && method === "POST") {
        if (doc.tags.length >= 20 && !doc.tags.some((t) => norm(t.name) === norm(String(body.name)))) return fail(409, "tag_limit");
        link(String(body.name));
        return view(doc);
      }
      if (m[3] && method === "DELETE") {
        doc.tags = doc.tags.filter((x) => x.id !== m?.[3]);
        return view(doc);
      }
      if (m[4] === "accept" && method === "POST") {
        link(String(body.name));
        drop(String(body.name));
        return view(doc);
      }
      if (m[4] === "dismiss" && method === "POST") {
        drop(String(body.name));
        return view(doc);
      }
      if (m[4] === "refresh" && method === "POST") {
        this.refreshes.push(doc.id);
        return json(202, { started: true });
      }
    }
```

and make `GET /api/documents/:id` (the `if (method === "GET") return json(200, doc);` line) return `json(200, { ...doc, suggestedTags: this.suggestions.get(doc.id) ?? [] })`. (`body` is the parsed JSON body the handler already has for the chat routes.) Run the fake-server tests: PASS.

**Part B: the page.** Edit `apps/web/src/components/dm-documents-page.test.ts`:
- add imports `import type { TagSummary } from "@docmind/contracts";`, `import { deepAll, unnamedControls } from "../testing/dom";` and `import { tag } from "../testing/tags";`
- add `tags: [],` to the `doc()` fixture (after `summary: null,`)
- change `setup(items: DocumentDto[])` to `setup(items: DocumentDto[], tagList: TagSummary[] = [])` and its fake reader to honour the filter:

```ts
    documents: async ({ status, tags, match }) => ({
      items: live.items.filter(
        (d) =>
          (status === "all" ||
            (status === "processing"
              ? ["uploaded", "parsing", "embedding"].includes(d.status)
              : d.status === status)) &&
          (tags.length === 0 ||
            (match === "all"
              ? tags.every((t) => d.tags.some((x) => x.id === t))
              : tags.some((t) => d.tags.some((x) => x.id === t)))),
      ),
      truncated: false,
    }),
```

- add to the `api` object in `setup`: `listTags: vi.fn(async () => ({ tags: live.tagList })),` (declare `const live = { items, tagList };`), and give `setup` a third parameter, `url = "/documents"`: call `window.history.replaceState(null, "", url)` just before `createServices(…)`, so the router starts at that address and a test never inherits the previous test's. (Today's `setup()` does not touch the address.)

Append:

```ts
const tg = (n: number, name: string, documents: number): TagSummary => tag(900 + n, name, documents);
const withTags = (d: DocumentDto, ...t: TagSummary[]): DocumentDto => ({ ...d, tags: t.map(({ id: i, name }) => ({ id: i, name })) });
const bar = (p: Element) => p.shadowRoot?.querySelector("dm-tag-bar") as HTMLElement | null;
const chip = (p: Element, t: TagSummary) =>
  bar(p)?.shadowRoot?.querySelector(`button[data-tag='${t.id}']`) as HTMLButtonElement;
const tableText = (p: Element) => table(p)?.shadowRoot?.textContent ?? "";
/** The chips of the Tags cells (loom-ui token buttons) in the served table, for one tag. */
const rowChips = (p: Element, t: TagSummary) =>
  deepAll(p, `button[data-token='${t.id}']`) as HTMLButtonElement[];

describe("dm-documents-page tag filter", () => {
  const fin = tg(1, "Finance", 2);
  const leg = tg(2, "Legal", 1);
  const items = () => [
    withTags(doc(1), fin),
    withTags(doc(2), fin, leg),
    doc(3),
  ];

  it("draws the tag bar with the user's tags, and each row's tags as chips in the table", async () => {
    const t = await setup(items(), [fin, leg]);
    await vi.waitFor(() => expect(bar(t.page)).not.toBeNull());
    await vi.waitFor(() => expect(rowChips(t.page, fin)).toHaveLength(2)); // rows 1 and 2
    expect(rowChips(t.page, leg)).toHaveLength(1); // row 2 only
    expect(rowChips(t.page, leg)[0]?.textContent?.trim()).toBe("Legal");
    expect(chip(t.page, fin).getAttribute("aria-pressed")).toBe("false");
  });

  it("clicking a chip in a row filters the list to that tag alone and writes it to the address (spec section 6)", async () => {
    const t = await setup(items(), [fin, leg]);
    await vi.waitFor(() => expect(tableText(t.page)).toContain("Title 3"));
    await vi.waitFor(() => expect(rowChips(t.page, leg)).toHaveLength(1));
    rowChips(t.page, leg)[0]?.click();
    await vi.waitFor(() => expect(tableText(t.page)).not.toContain("Title 1"));
    expect(tableText(t.page)).toContain("Title 2"); // the only document with Legal
    expect(tableText(t.page)).not.toContain("Title 3");
    expect(window.location.search).toBe(`?tags=${leg.id}`);
    expect(chip(t.page, leg).getAttribute("aria-pressed")).toBe("true");
  });

  it("a chip click replaces the selection: one tag alone, Any and All reset", async () => {
    const t = await setup(items(), [fin, leg], `/documents?tags=${fin.id},${leg.id}&match=all`);
    await vi.waitFor(() => expect(tableText(t.page)).not.toContain("Title 1")); // All: only document 2
    await vi.waitFor(() => expect(rowChips(t.page, fin)).toHaveLength(1));
    rowChips(t.page, fin)[0]?.click();
    await vi.waitFor(() => expect(tableText(t.page)).toContain("Title 1")); // Finance alone: documents 1 and 2
    expect(window.location.search).toBe(`?tags=${fin.id}`);
    expect(chip(t.page, leg).getAttribute("aria-pressed")).toBe("false");
  });

  it("refuses a chip action for a tag or a row the served table does not hold", async () => {
    const t = await setup(items(), [fin, leg]);
    await vi.waitFor(() => expect(rowChips(t.page, leg)).toHaveLength(1));
    const act = (t.page as unknown as { act: (a: unknown) => Promise<unknown> }).act;
    const forge = (rowKey: string, tokenId: string) =>
      act.call(t.page, { type: "TABLE_TOKEN", widgetId: "w", payload: { rowKey, tokenId } });
    expect(await forge(id(1), leg.id)).toEqual({ ok: false, reason: "refused" }); // row 1 has no Legal
    expect(await forge(id(77), fin.id)).toEqual({ ok: false, reason: "refused" }); // not a served row
    expect(await forge(id(2), "not-a-tag")).toEqual({ ok: false, reason: "refused" });
    expect(window.location.search).toBe("");
    expect(await forge(id(2), leg.id)).toEqual({ ok: true });
    expect(window.location.search).toBe(`?tags=${leg.id}`);
  });

  it("does not show the bar for a library that has no tags yet", async () => {
    const t = await setup([doc(1)], []);
    await vi.waitFor(() => expect(view(t.page).getAttribute("name")).toBe("library"));
    expect(bar(t.page)).toBeNull();
  });

  it("pressing a chip filters the table, writes ?tags= to the address and announces the count", async () => {
    const t = await setup(items(), [fin, leg]);
    await vi.waitFor(() => expect(tableText(t.page)).toContain("Title 3"));
    chip(t.page, leg).click();
    await vi.waitFor(() => expect(tableText(t.page)).not.toContain("Title 1"));
    expect(tableText(t.page)).toContain("Title 2");
    expect(tableText(t.page)).not.toContain("Title 3");
    expect(window.location.search).toBe(`?tags=${leg.id}`);
    expect(chip(t.page, leg).getAttribute("aria-pressed")).toBe("true");
    await vi.waitFor(() =>
      expect(bar(t.page)?.shadowRoot?.querySelector("[role=status]")?.textContent?.trim()).toBe("1 document matches"),
    );
  });

  it("Any and All: two tags, then All keeps only the document with both, and match=all is in the address", async () => {
    const t = await setup(items(), [fin, leg]);
    await vi.waitFor(() => expect(tableText(t.page)).toContain("Title 3"));
    chip(t.page, fin).click();
    await vi.waitFor(() => expect(tableText(t.page)).not.toContain("Title 3"));
    chip(t.page, leg).click();
    await vi.waitFor(() => expect(window.location.search).toBe(`?tags=${fin.id},${leg.id}`)); // Any: omitted
    expect(tableText(t.page)).toContain("Title 1");
    const all = bar(t.page)?.shadowRoot?.querySelector<HTMLInputElement>("input[value=all]") as HTMLInputElement;
    await vi.waitFor(() => expect(all.disabled).toBe(false));
    all.click();
    await vi.waitFor(() => expect(tableText(t.page)).not.toContain("Title 1"));
    expect(tableText(t.page)).toContain("Title 2");
    expect(window.location.search).toBe(`?tags=${fin.id},${leg.id}&match=all`);
  });

  it("starts from the address (a bookmark) and follows back and forward", async () => {
    const t = await setup(items(), [fin, leg], `/documents?tags=${leg.id}`);
    await vi.waitFor(() => expect(chip(t.page, leg)?.getAttribute("aria-pressed")).toBe("true"));
    await vi.waitFor(() => expect(tableText(t.page)).not.toContain("Title 3"));
    window.history.replaceState(null, "", "/documents");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await vi.waitFor(() => expect(tableText(t.page)).toContain("Title 3"));
    expect(chip(t.page, leg).getAttribute("aria-pressed")).toBe("false");
  });

  it("Clear removes the filter and the address", async () => {
    const t = await setup(items(), [fin, leg], `/documents?tags=${fin.id},${leg.id}&match=all`);
    await vi.waitFor(() => expect(tableText(t.page)).not.toContain("Title 3"));
    (bar(t.page)?.shadowRoot?.querySelector("[data-clear]") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(tableText(t.page)).toContain("Title 3"));
    expect(window.location.search).toBe("");
  });

  it("says no document matches, with Clear, when the filter finds nothing", async () => {
    const lonely = tg(3, "Lonely", 0);
    const t = await setup(items(), [fin, leg, lonely]);
    await vi.waitFor(() => expect(tableText(t.page)).toContain("Title 3"));
    chip(t.page, lonely).click();
    await vi.waitFor(() => expect(t.page.shadowRoot?.querySelector("[data-no-match]")?.textContent).toContain("No documents match these tags"));
    (t.page.shadowRoot?.querySelector("[data-clear-filter]") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(t.page.shadowRoot?.querySelector("[data-no-match]")).toBeNull());
    expect(view(t.page).getAttribute("name")).toBe("library"); // never the empty-library view
  });

  it("drops a tag from the address once the server no longer has it", async () => {
    const ghost = tg(9, "Gone", 0);
    const t = await setup(items(), [fin, leg], `/documents?tags=${ghost.id},${fin.id}`);
    await vi.waitFor(() => expect(window.location.search).toBe(`?tags=${fin.id}`));
    expect(t.services.router.get()).toEqual({ name: "documents", tags: [fin.id] });
  });

  it("opens Manage tags, and refreshes the bar after a rename", async () => {
    const t = await setup(items(), [fin, leg]);
    await vi.waitFor(() => expect(bar(t.page)).not.toBeNull());
    (bar(t.page)?.shadowRoot?.querySelector("[data-manage]") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(t.page.shadowRoot?.querySelector("dm-tag-manage")).not.toBeNull());
    t.page.shadowRoot?.querySelector("dm-tag-manage")?.dispatchEvent(new CustomEvent("tags-changed", { bubbles: true, composed: true }));
    await vi.waitFor(() => expect(t.api.listTags).toHaveBeenCalledTimes(2));
  });

  it("leaves no control without an accessible name", async () => {
    const t = await setup(items(), [fin, leg]);
    await vi.waitFor(() => expect(bar(t.page)).not.toBeNull());
    expect(unnamedControls(bar(t.page) as Element)).toEqual([]);
  });
});
```

(`t.services` and `t.api` are returned by `setup`; extend its return with `services` and `api` if missing — they are in the current `return { page, services, api, live, sse, ui }`.)

Run: `pnpm --filter @docmind/web exec vitest run src/components/dm-documents-page.test.ts` Expected: FAIL. Now edit `apps/web/src/components/dm-documents-page.ts`:

- imports: `import type { TagSummary } from "@docmind/contracts";` (next to the existing contracts import), `import { TABLE_TOKEN } from "@loom-ui/core/browser";` (the browser entry: the main entry of `@loom-ui/core` is Node-only), `import "./dm-tag-bar"; import "./dm-tag-manage"; import type { TagSelectionDetail } from "./dm-tag-bar";`, and add `type ActionAnswer` to the existing import from `"../ui/session"`; a module constant `/** The Tags column of the library table (see the reshaper). */ const TAGS_COLUMN = 1;`
- `static properties = { empty: { state: true }, tags: { state: true }, managing: { state: true }, count: { state: true } };` with `declare tags: TagSummary[]; declare managing: boolean; declare count: number | null;` and in the constructor `this.tags = []; this.managing = false; this.count = null;`
- `private readonly ctx = new ServicesController(this, (s) => [s.uploads, s.router]);` (the page re-renders when the address changes)
- in `start()`, after `services.uploads.startEvents(…)`: `void this.loadTags();`
- in `refresh()`, as its first line: `void this.loadTags(); // the counts on the chips change with uploads and deletes`
- add these members:

```ts
  private paramsKey = "";
  private libraryParams: Record<string, string | number> = { tags: "", match: "any" };

  /** What the address says is selected: ids and the mode. */
  private selection(): { tags: string[]; match: "any" | "all" } {
    const r = this.ctx.services?.router.get();
    return r?.name === "documents"
      ? { tags: r.tags ?? [], match: r.match ?? "any" }
      : { tags: [], match: "any" };
  }
  /** One params object per selection, so a re-render never re-sends the parameters (the view applies it when the object changes). */
  private paramsFor(sel: { tags: string[]; match: string }): Record<string, string | number> {
    const key = `${sel.tags.join(",")}|${sel.match}`;
    if (key !== this.paramsKey) {
      this.paramsKey = key;
      this.libraryParams = { tags: sel.tags.join(","), match: sel.match };
    }
    return this.libraryParams;
  }
  private async loadTags(): Promise<void> {
    const api = this.ctx.services?.api;
    if (!api) return;
    const epoch = this.epoch;
    try {
      const { tags } = await api.listTags();
      if (epoch !== this.epoch) return;
      this.tags = tags;
      this.pruneSelection();
    } catch {
      // The bar keeps what it had; the table still works without it.
    }
  }
  /** A tag the server no longer has leaves the address (replacing the entry, not adding one). */
  private pruneSelection(): void {
    const router = this.ctx.services?.router;
    const sel = this.selection();
    const known = new Set(this.tags.map((t) => t.id));
    const kept = sel.tags.filter((id) => known.has(id));
    if (!router || kept.length === sel.tags.length) return;
    router.navigate(
      {
        name: "documents",
        ...(kept.length > 0 && { tags: kept, ...(sel.match === "all" && { match: "all" as const }) }),
      },
      { replace: true },
    );
  }
  private onSelect = (e: Event) => {
    const { tags, match } = (e as CustomEvent<TagSelectionDetail>).detail;
    this.ctx.services?.router.navigate({
      name: "documents",
      ...(tags.length > 0 && { tags, ...(match === "all" && { match: "all" as const }) }),
    });
  };
  private clear(): void {
    this.ctx.services?.router.navigate({ name: "documents" });
  }
  /**
   * A tag chip in a row (`TABLE_TOKEN`, `payload: { rowKey, tokenId }`): filter the list to that tag alone. The selection is
   * replaced (Any and All reset: one tag has no mode). What the surface holds is what the server served in the table's value,
   * read now, never the action's own claim: the row key must be one of `rowKeys`, and the tag a token of that row's Tags cell.
   */
  private onTagChip(session: ViewSession, payload: Record<string, unknown>): ActionAnswer {
    const table = session.valueOf("documents") as { rowKeys?: unknown; rows?: unknown } | undefined;
    const { rowKey, tokenId } = payload;
    const at = Array.isArray(table?.rowKeys) ? table.rowKeys.indexOf(rowKey) : -1;
    const row = at >= 0 && Array.isArray(table?.rows) ? table.rows[at] : undefined;
    const cell = Array.isArray(row) ? (row[TAGS_COLUMN] as { tokens?: unknown } | undefined) : undefined;
    const tokens = Array.isArray(cell?.tokens) ? (cell.tokens as { id?: unknown }[]) : [];
    if (typeof tokenId !== "string" || !tokens.some((t) => t?.id === tokenId))
      return { ok: false, reason: "refused" };
    this.ctx.services?.router.navigate({ name: "documents", tags: [tokenId] });
    return { ok: true };
  }
```

- in `act` (the existing handler), right after its `if (!session || !services) { … return { ok: false }; }` check and before `const keys = …`, add: `if (a.type === TABLE_TOKEN) return this.onTagChip(session, a.payload); // a chip navigates; it is not an intent (intentOf has no case for it)`.

- in `onReady`, replace the `check` function with:

```ts
    const check = () => {
      const total = session.valueOf("doc-total") as { value?: number } | undefined;
      if (session.statusOf("doc-total") === "ready" && total?.value === 0) this.empty = true;
      const rows = session.valueOf("documents") as { rowKeys?: unknown } | undefined;
      this.count =
        session.statusOf("documents") === "ready" && Array.isArray(rows?.rowKeys)
          ? rows.rowKeys.length
          : null;
    };
```

- replace `render()` with:

```ts
  render() {
    const sel = this.selection();
    const filtering = sel.tags.length > 0;
    const showBar = !this.empty && (this.tags.length > 0 || filtering);
    return html`
      <header>
        <h1>Documents</h1>
        ${this.empty ? null : html`<dm-upload-zone variant="compact"></dm-upload-zone>`}
      </header>
      ${this.empty ? html`<dm-upload-zone variant="empty"></dm-upload-zone>` : null}
      ${
        showBar
          ? html`<dm-tag-bar .tags=${this.tags} .selected=${sel.tags} .match=${sel.match} .count=${this.count} .managing=${this.managing} @tag-selection=${this.onSelect} @manage-toggle=${() => { this.managing = !this.managing; }}></dm-tag-bar>
            ${this.managing ? html`<dm-tag-manage .tags=${this.tags} @tags-changed=${() => void this.loadTags()}></dm-tag-manage>` : null}`
          : null
      }
      ${
        !this.empty && filtering && this.count === 0
          ? html`<p data-no-match role="status">No documents match these tags. <button class="btn ghost" data-clear-filter @click=${() => this.clear()}>Clear</button></p>`
          : null
      }
      <dm-view name=${this.empty ? "library-empty" : "library"} .params=${this.empty ? undefined : this.paramsFor(sel)} .onAct=${this.act} @view-ready=${this.onReady}></dm-view>`;
  }
```

The fake server (`apps/web/src/testing/fakeServer.ts`, used by `acceptance.test.ts`) got its tag routes in Part A. Its `readers().documents` must honour the new arguments too: change `documents: async ({ limit, status }) =>` to filter by `tags` and `match` exactly as the page test's reader above does.

- [ ] **Step 8: Run everything**

Run: `set -a; . ./.env; set +a; pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm --filter @docmind/web exec vitest run && pnpm --filter @docmind/experiences exec vitest run && pnpm --filter @docmind/server exec vitest run app/ui`
Expected: PASS. If an existing documents-page test now fails because the table gained a column (a chip cell: its text is the tag names without separators, `tableCellText` joins them with ", ") or `getDocument`/`listTags` is missing from a stub `api`, fix the stub (`listTags: async () => ({ tags: [] })`), not the component. Verify in a browser before the PR (the project's rule): `pnpm serve`, open `/documents`, create two tags from a document (Task 7), press chips, switch Any/All, use back and forward, rename and delete in Manage tags.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(tags): tag filter on the documents page (bar, Any/All, URL state, manage panel)"
```

---

## Task 7: The document detail page: the Tags row and the Suggested line

**Files:**
- Create: `apps/web/src/components/dm-doc-tags.ts`, `apps/web/src/components/dm-doc-tags.test.ts`
- Modify: `apps/web/src/components/dm-doc-detail.ts`, `apps/web/src/components/dm-doc-detail.test.ts`
- (The fake server's tag routes, `testing/fakeServer.ts` and its test, are Task 6 Step 7, Part A.)

**Interfaces:**
- Consumes: the `Api` tag methods and `<dm-tag-*>` conventions (Task 6); `DocumentDto.tags` and `suggestedTags`; the `tags` progress event (Task 5); `ApiError`; `unnamedControls`.
- Produces: `<dm-doc-tags>` with property `documentId: string`, a public `onEvent(kind: "suggested" | "failed" | "resync"): Promise<void>`, and the exported `TAG_SUGGEST_TIMEOUT_MS = 60_000`; instance seam `timeoutMs`.

- [ ] **Step 1: The fake server's tag routes (moved to Task 6 Step 7)**

The fake server's tag routes and their test are written in Task 6 Step 7, Part A, where the page first needs them (the page calls `GET /api/tags`, and `acceptance.test.ts` runs against this fake in Task 6). Nothing to write here: confirm they are in place.

Run: `pnpm --filter @docmind/web exec vitest run src/testing/fakeServer.test.ts`
Expected: PASS.

- [ ] **Step 2: `<dm-doc-tags>`, test first**

Create `apps/web/src/components/dm-doc-tags.test.ts`:

```ts
import type { DocumentDto, DocumentTag, DocumentTagsResponse } from "@docmind/contracts";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/http";
import { createServices } from "../services";
import { unnamedControls } from "../testing/dom";
import { mountWith } from "../testing/mount";
import { all, q, root } from "../testing/tags";
import "./dm-doc-tags";

const DOC = "00000000-0000-4000-8000-000000000001";
const t = (n: number, name: string): DocumentTag => ({
  id: `00000000-0000-4000-8000-${String(900 + n).padStart(12, "0")}`,
  name,
});
const dto = (tags: DocumentTag[], suggestedTags: string[], summary = true): DocumentDto =>
  ({
    id: DOC,
    title: "x",
    filename: "x",
    mime: "text/plain",
    sizeBytes: 1,
    status: "ready",
    error: null,
    stats: null,
    summary: summary
      ? { tldr: "t", keyPoints: [], entities: [], topics: [], suggestedQuestions: [] }
      : null,
    tags,
    suggestedTags,
    createdAt: "2026-11-10T10:00:00.000Z",
    updatedAt: "2026-11-10T10:00:00.000Z",
  }) as DocumentDto;

type El = HTMLElement & {
  updateComplete: Promise<unknown>;
  onEvent(k: "suggested" | "failed" | "resync"): Promise<void>;
  timeoutMs: number;
};

async function setup(initial: DocumentDto) {
  const state = { doc: initial };
  const respond = async (): Promise<DocumentTagsResponse> => ({
    tags: state.doc.tags,
    suggestedTags: state.doc.suggestedTags ?? [],
  });
  const api = {
    getDocument: vi.fn(async () => state.doc),
    listTags: vi.fn(async () => ({
      tags: [t(1, "Finance"), t(2, "Legal"), t(3, "Spare")].map((x) => ({ ...x, documents: 1 })),
    })),
    addDocumentTag: vi.fn(async (_id: string, name: string) => {
      state.doc = { ...state.doc, tags: [...state.doc.tags, { id: t(50, name).id, name }] };
      return respond();
    }),
    removeDocumentTag: vi.fn(async (_id: string, tagId: string) => {
      state.doc = { ...state.doc, tags: state.doc.tags.filter((x) => x.id !== tagId) };
      return respond();
    }),
    acceptTagSuggestion: vi.fn(async (_id: string, name: string) => {
      state.doc = {
        ...state.doc,
        tags: [...state.doc.tags, { id: t(60, name).id, name }],
        suggestedTags: (state.doc.suggestedTags ?? []).filter((n) => n !== name),
      };
      return respond();
    }),
    dismissTagSuggestion: vi.fn(async (_id: string, name: string) => {
      state.doc = {
        ...state.doc,
        suggestedTags: (state.doc.suggestedTags ?? []).filter((n) => n !== name),
      };
      return respond();
    }),
    refreshTagSuggestions: vi.fn(async () => {}),
  };
  const services = createServices({ api: api as never });
  const el = await mountWith<El>(services, "dm-doc-tags", { documentId: DOC });
  await vi.waitFor(() => expect(api.getDocument).toHaveBeenCalled());
  await el.updateComplete;
  return { el, api, state };
}
const settle = async (el: El) => {
  await Promise.resolve();
  await el.updateComplete;
};

describe("dm-doc-tags", () => {
  it("draws the document's tags as chips with a named remove button, and removes one", async () => {
    const s = await setup(dto([t(1, "Finance"), t(2, "Legal")], []));
    await vi.waitFor(() =>
      expect(all(s.el, "[data-tags] .chip").map((c) => c.firstChild?.textContent?.trim())).toEqual([
        "Finance",
        "Legal",
      ]),
    );
    expect(q(s.el, "[role=group][aria-label=Tags]")).not.toBeNull();
    q<HTMLButtonElement>(s.el, "button[aria-label='Remove tag Finance']").click();
    await vi.waitFor(() => expect(s.api.removeDocumentTag).toHaveBeenCalledWith(DOC, t(1, "").id));
    await vi.waitFor(() => expect(all(s.el, "[data-tags] .chip")).toHaveLength(1));
  });

  it("adds the typed name on Enter (trimmed), clears the box, and ignores an empty box", async () => {
    const s = await setup(dto([], []));
    const input = q<HTMLInputElement>(s.el, "input[aria-label='Add a tag']");
    input.value = "   ";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(s.api.addDocumentTag).not.toHaveBeenCalled();
    input.value = "  Q3 plan ";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await vi.waitFor(() => expect(s.api.addDocumentTag).toHaveBeenCalledWith(DOC, "Q3 plan"));
    await vi.waitFor(() =>
      expect(all(s.el, "[data-tags] .chip").map((c) => c.firstChild?.textContent?.trim())).toEqual([
        "Q3 plan",
      ]),
    );
    expect(q<HTMLInputElement>(s.el, "input[aria-label='Add a tag']").value).toBe("");
  });

  it("says why when the document already holds 20 tags", async () => {
    const s = await setup(dto([], []));
    s.api.addDocumentTag.mockRejectedValueOnce(new ApiError(409, "tag_limit"));
    const input = q<HTMLInputElement>(s.el, "input[aria-label='Add a tag']");
    input.value = "one more";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await vi.waitFor(() =>
      expect(q(s.el, "[role=alert]")?.textContent).toContain("at most 20 tags"),
    );
  });

  it("offers the user's other tags as autocomplete, loaded once, without the ones the document has", async () => {
    const s = await setup(dto([t(1, "Finance")], []));
    const input = q<HTMLInputElement>(s.el, "input[aria-label='Add a tag']");
    input.dispatchEvent(new Event("focus"));
    input.dispatchEvent(new Event("focus"));
    await vi.waitFor(() => expect(s.api.listTags).toHaveBeenCalledTimes(1));
    await s.el.updateComplete;
    expect(all<HTMLOptionElement>(s.el, "datalist option").map((o) => o.value)).toEqual([
      "Legal",
      "Spare",
    ]);
    expect(input.getAttribute("list")).toBe(q(s.el, "datalist").id);
  });

  it("shows each suggestion with Accept and Dismiss, and accepting moves it to the tags", async () => {
    const s = await setup(dto([], ["Legal", "Misc"]));
    await vi.waitFor(() => expect(all(s.el, "[data-suggested] .chip")).toHaveLength(2));
    expect(q(s.el, "[role=group][aria-label='Suggested tags']")).not.toBeNull();
    q<HTMLButtonElement>(s.el, "button[aria-label='Accept suggested tag Legal']").click();
    await vi.waitFor(() => expect(s.api.acceptTagSuggestion).toHaveBeenCalledWith(DOC, "Legal"));
    await vi.waitFor(() =>
      expect(all(s.el, "[data-tags] .chip").map((c) => c.firstChild?.textContent?.trim())).toEqual([
        "Legal",
      ]),
    );
    q<HTMLButtonElement>(s.el, "button[aria-label='Dismiss suggested tag Misc']").click();
    await vi.waitFor(() => expect(s.api.dismissTagSuggestion).toHaveBeenCalledWith(DOC, "Misc"));
    await vi.waitFor(() => expect(all(s.el, "[data-suggested] .chip")).toHaveLength(0));
  });

  it("disables Suggest tags with the reason when the document has no summary", async () => {
    const s = await setup(dto([], [], false));
    const button = q<HTMLButtonElement>(s.el, "[data-suggest]");
    expect(button.disabled).toBe(true);
    const reason = q(s.el, "[data-reason]");
    expect(reason.textContent).toContain("summary");
    expect(button.getAttribute("aria-describedby")).toBe(reason.id);
  });

  it("shows a busy state while the flow runs, and ends it on the suggested event with fresh suggestions", async () => {
    const s = await setup(dto([], []));
    q<HTMLButtonElement>(s.el, "[data-suggest]").click();
    await vi.waitFor(() => expect(s.api.refreshTagSuggestions).toHaveBeenCalledWith(DOC));
    await settle(s.el);
    const busy = q<HTMLButtonElement>(s.el, "[data-suggest]");
    expect([busy.disabled, busy.getAttribute("aria-busy"), busy.textContent?.trim()]).toEqual([
      true,
      "true",
      "Suggesting…",
    ]);
    s.state.doc = dto([], ["Fresh"]);
    await s.el.onEvent("suggested");
    await settle(s.el);
    expect(q<HTMLButtonElement>(s.el, "[data-suggest]").getAttribute("aria-busy")).not.toBe("true");
    expect(all(s.el, "[data-suggested] .chip")).toHaveLength(1);
  });

  it("a failed run says Couldn't suggest tags with Retry, which starts it again", async () => {
    const s = await setup(dto([], []));
    q<HTMLButtonElement>(s.el, "[data-suggest]").click();
    await vi.waitFor(() => expect(s.api.refreshTagSuggestions).toHaveBeenCalledTimes(1));
    await s.el.onEvent("failed");
    await settle(s.el);
    expect(q(s.el, "[data-suggest-failed]")?.textContent).toContain("Couldn't suggest tags");
    q<HTMLButtonElement>(s.el, "[data-suggest-retry]").click();
    await vi.waitFor(() => expect(s.api.refreshTagSuggestions).toHaveBeenCalledTimes(2));
    await settle(s.el);
    expect(q(s.el, "[data-suggest-failed]")).toBeNull();
  });

  it("keeps waiting when a run is already going, and gives fixed notes for the other refusals", async () => {
    const s = await setup(dto([], []));
    s.api.refreshTagSuggestions.mockRejectedValueOnce(new ApiError(409, "suggest_running"));
    q<HTMLButtonElement>(s.el, "[data-suggest]").click();
    await vi.waitFor(() => expect(s.api.refreshTagSuggestions).toHaveBeenCalled());
    await settle(s.el);
    expect(q<HTMLButtonElement>(s.el, "[data-suggest]").getAttribute("aria-busy")).toBe("true");
    await s.el.onEvent("suggested");
    await settle(s.el);
    s.api.refreshTagSuggestions.mockRejectedValueOnce(new ApiError(429, "too_many_requests"));
    q<HTMLButtonElement>(s.el, "[data-suggest]").click();
    await vi.waitFor(() =>
      expect(q(s.el, "[data-suggest-note]")?.textContent).toContain("Too many"),
    );
    expect(q<HTMLButtonElement>(s.el, "[data-suggest]").disabled).toBe(false);
  });

  it("falls back to reading the state when no event arrives within the timeout", async () => {
    const s = await setup(dto([], []));
    s.el.timeoutMs = 10;
    q<HTMLButtonElement>(s.el, "[data-suggest]").click();
    await vi.waitFor(() => expect(s.api.refreshTagSuggestions).toHaveBeenCalled());
    const reads = s.api.getDocument.mock.calls.length;
    await vi.waitFor(() => expect(s.api.getDocument.mock.calls.length).toBeGreaterThan(reads));
    await settle(s.el);
    expect(q<HTMLButtonElement>(s.el, "[data-suggest]").getAttribute("aria-busy")).not.toBe("true");
  });

  it("a resync reloads, and no control lacks an accessible name", async () => {
    const s = await setup(dto([t(1, "Finance")], ["Legal"]));
    const reads = s.api.getDocument.mock.calls.length;
    await s.el.onEvent("resync");
    expect(s.api.getDocument.mock.calls.length).toBe(reads + 1);
    await settle(s.el);
    expect(unnamedControls(s.el)).toEqual([]);
  });
});
```

Run: `pnpm --filter @docmind/web exec vitest run src/components/dm-doc-tags.test.ts` Expected: FAIL. Create `apps/web/src/components/dm-doc-tags.ts`:

```ts
import type { DocumentTag, DocumentTagsResponse, TagSummary } from "@docmind/contracts";
import { LitElement, css, html } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import type { Api } from "../api/client";
import { ApiError } from "../api/http";
import { ServicesController } from "../state/services-controller";
import { baseStyles } from "../styles/base";

/** "Suggesting…" lasts until a `tags` event or this long: a run that ended with no event (a missed frame, a restart) must not freeze the button. */
export const TAG_SUGGEST_TIMEOUT_MS = 60_000;

const NOTES: Record<string, string> = {
  tag_limit: "A document holds at most 20 tags.",
  invalid_request: "A tag name is 1 to 40 characters, with no control characters.",
};

/** One document's Tags row (chips with remove, an input with autocomplete) and Suggested line (accept, dismiss, Suggest tags). */
export class DmDocTags extends LitElement {
  static properties = {
    documentId: { type: String },
    tags: { state: true },
    suggested: { state: true },
    hasSummary: { state: true },
    all: { state: true },
    draft: { state: true },
    suggesting: { state: true },
    failed: { state: true },
    note: { state: true },
    suggestNote: { state: true },
  };
  static styles = [
    baseStyles,
    css`
      :host { display: grid; gap: 8px; margin-bottom: 16px; }
      .row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
      .label { color: var(--dm-muted); min-width: 64px; }
      .chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 4px 2px 10px; min-height: 28px; border-radius: 999px; border: 1px solid var(--dm-divider); }
      .chip.suggested { border-style: dashed; }
      .chip button { border: 0; background: transparent; cursor: pointer; color: var(--dm-muted); min-width: 24px; min-height: 24px; border-radius: 999px; }
      .chip button:hover { color: var(--dm-text); background: color-mix(in srgb, var(--dm-text) 8%, transparent); }
      input { min-width: 18ch; }
      [role="alert"] { color: var(--dm-danger, #b3261e); margin: 0; }
    `,
  ];
  declare documentId: string;
  declare tags: DocumentTag[];
  declare suggested: string[];
  declare hasSummary: boolean;
  declare all: TagSummary[] | null;
  declare draft: string;
  declare suggesting: boolean;
  declare failed: boolean;
  declare note: string | null;
  declare suggestNote: string | null;
  /** Test seam: how long "Suggesting…" waits for an event (default TAG_SUGGEST_TIMEOUT_MS). */
  timeoutMs = TAG_SUGGEST_TIMEOUT_MS;
  private readonly ctx = new ServicesController(this);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private loadedFor: string | undefined;
  constructor() {
    super();
    this.documentId = "";
    this.tags = [];
    this.suggested = [];
    this.hasSummary = false;
    this.all = null;
    this.draft = "";
    this.suggesting = false;
    this.failed = false;
    this.note = null;
    this.suggestNote = null;
  }

  protected willUpdate(): void {
    if (this.documentId && this.documentId !== this.loadedFor && this.ctx.services) {
      this.loadedFor = this.documentId;
      this.tags = [];
      this.suggested = [];
      this.all = null;
      this.stopWaiting();
      void this.reload();
    }
  }
  disconnectedCallback(): void {
    clearTimeout(this.timer);
    super.disconnectedCallback();
  }

  /** Reads the document's tags and suggestions again. */
  private async reload(): Promise<void> {
    const api = this.ctx.services?.api;
    const id = this.documentId;
    if (!api || !id) return;
    try {
      const doc = await api.getDocument(id);
      if (id !== this.documentId) return;
      this.tags = doc.tags;
      this.suggested = doc.suggestedTags ?? [];
      this.hasSummary = doc.summary !== null;
    } catch {
      // The row keeps what it had; the next event or action reads again.
    }
  }
  private take(r: DocumentTagsResponse): void {
    this.tags = r.tags;
    this.suggested = r.suggestedTags;
    this.note = null;
  }
  private stopWaiting(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.suggesting = false;
  }
  private armWatch(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.suggesting = false;
      void this.reload();
    }, this.timeoutMs);
  }

  /** A `tags` progress event of this document (or a resync after a missed frame): the run ended, so read again. */
  async onEvent(kind: "suggested" | "failed" | "resync"): Promise<void> {
    if (kind === "failed") {
      this.stopWaiting();
      this.failed = true;
      return;
    }
    if (kind === "suggested") {
      this.stopWaiting();
      this.failed = false;
    }
    await this.reload();
  }

  private async act(work: (api: Api, id: string) => Promise<DocumentTagsResponse>): Promise<void> {
    const api = this.ctx.services?.api;
    if (!api) return;
    const id = this.documentId;
    try {
      const r = await work(api, id);
      if (id === this.documentId) this.take(r);
    } catch (err) {
      this.note =
        err instanceof ApiError && NOTES[err.code ?? ""]
          ? (NOTES[err.code ?? ""] as string)
          : "Couldn't update the tags. Try again.";
    }
  }
  private add(): void {
    const name = this.draft.trim();
    if (name === "") return;
    this.draft = "";
    void this.act((api, id) => api.addDocumentTag(id, name));
  }
  private async loadAll(): Promise<void> {
    const api = this.ctx.services?.api;
    if (this.all !== null || !api) return;
    this.all = []; // one load, whatever the number of focuses
    try {
      this.all = (await api.listTags()).tags;
    } catch {
      this.all = [];
    }
  }
  private suggest(): void {
    const api = this.ctx.services?.api;
    if (!api || this.suggesting || !this.hasSummary) return;
    this.suggesting = true;
    this.failed = false;
    this.suggestNote = null;
    this.armWatch();
    const id = this.documentId;
    void api.refreshTagSuggestions(id).catch((err: unknown) => {
      if (id !== this.documentId) return;
      if (err instanceof ApiError && err.status === 409 && err.code === "suggest_running") return; // keep waiting for its event
      this.stopWaiting();
      if (err instanceof ApiError && err.status === 429)
        this.suggestNote = "Too many requests. Try again in a minute.";
      else if (err instanceof ApiError && err.status === 409 && err.code === "no_summary")
        this.suggestNote = "This document has no summary yet.";
      else if (err instanceof ApiError && err.status === 409)
        this.suggestNote = "Tag suggestions are not available.";
      else this.failed = true;
    });
  }

  render() {
    const have = new Set(this.tags.map((t) => t.name.toLowerCase()));
    const options = (this.all ?? []).filter((t) => !have.has(t.name.toLowerCase()));
    const reasonId = "suggest-reason";
    return html`
      <div class="row" role="group" aria-label="Tags" data-tags>
        <span class="label">Tags</span>
        ${this.tags.map((t) => html`<span class="chip">${t.name}<button type="button" aria-label=${`Remove tag ${t.name}`} @click=${() => void this.act((api, id) => api.removeDocumentTag(id, t.id))}>×</button></span>`)}
        <input aria-label="Add a tag" list="doc-tag-options" autocomplete="off" maxlength="40" .value=${this.draft}
          @focus=${() => void this.loadAll()}
          @input=${(e: Event) => {
            this.draft = (e.target as HTMLInputElement).value;
          }}
          @keydown=${(e: KeyboardEvent) => {
            if (e.key === "Enter") {
              e.preventDefault();
              this.add();
            }
          }} />
        <datalist id="doc-tag-options">${options.map((t) => html`<option value=${t.name}></option>`)}</datalist>
      </div>
      ${this.note ? html`<p role="alert" data-note>${this.note}</p>` : null}
      <div class="row" role="group" aria-label="Suggested tags" data-suggested-row>
        <span class="label">Suggested</span>
        <span class="row" data-suggested>${this.suggested.map((name) => html`<span class="chip suggested">${name}<button type="button" aria-label=${`Accept suggested tag ${name}`} @click=${() => void this.act((api, id) => api.acceptTagSuggestion(id, name))}>✓</button><button type="button" aria-label=${`Dismiss suggested tag ${name}`} @click=${() => void this.act((api, id) => api.dismissTagSuggestion(id, name))}>×</button></span>`)}</span>
        <button type="button" class="btn secondary" data-suggest ?disabled=${this.suggesting || !this.hasSummary} aria-busy=${this.suggesting ? "true" : "false"} aria-describedby=${ifDefined(this.hasSummary ? undefined : reasonId)} @click=${() => this.suggest()}>${this.suggesting ? "Suggesting…" : "Suggest tags"}</button>
        ${this.hasSummary ? null : html`<span class="muted" id=${reasonId} data-reason>Available once the document has a summary.</span>`}
        ${this.suggestNote ? html`<span data-suggest-note role="status">${this.suggestNote}</span>` : null}
      </div>
      ${this.failed ? html`<p class="muted" role="status" data-suggest-failed>Couldn't suggest tags. <button type="button" class="btn secondary" data-suggest-retry @click=${() => this.suggest()}>Retry</button></p>` : null}`;
  }
}
customElements.define("dm-doc-tags", DmDocTags);
```

Run the component tests: PASS. (If `willUpdate` runs before the services arrive through the context, the first load is skipped: call it again from `updated()` the way `dm-doc-detail` does with `start()`. The test mounts under `mountWith`, which provides the services before the element connects, so the first update loads.)

- [ ] **Step 3: The page shows it and forwards the events, test first**

In `apps/web/src/components/dm-doc-detail.test.ts`: add `tags: [],` to the `mine` fixture; in `setup()` add to the `api` object `getDocument: vi.fn(async () => ({ ...(live.doc ?? mine), suggestedTags: [] })), listTags: vi.fn(async () => ({ tags: [] })), refreshTagSuggestions: vi.fn(async () => {}),`; and append:

```ts
describe("dm-doc-detail tags", () => {
  it("shows the Tags row once the document is served, and not for a missing one", async () => {
    const t = setup({ name: "document", id: id(1) });
    const page = await t.mount();
    await vi.waitFor(() => expect(page.shadowRoot?.querySelector("dm-doc-tags")).not.toBeNull());
    expect((page.shadowRoot?.querySelector("dm-doc-tags") as unknown as { documentId: string }).documentId).toBe(id(1));
    const gone = setup({ name: "document", id: id(9) }, null);
    const missing = await gone.mount();
    await vi.waitFor(() => expect(missing.shadowRoot?.querySelector("[data-not-found]")).not.toBeNull());
    expect(missing.shadowRoot?.querySelector("dm-doc-tags")).toBeNull();
  });

  it("reloads the tags on this document's tags event, and ignores another document's", async () => {
    const t = setup({ name: "document", id: id(1) });
    const page = await t.mount();
    await vi.waitFor(() => expect(t.api.getDocument).toHaveBeenCalledTimes(1));
    t.progress(id(2), "ready", { tags: "suggested" });
    await Promise.resolve();
    expect(t.api.getDocument).toHaveBeenCalledTimes(1);
    t.progress(id(1), "ready", { tags: "suggested" });
    await vi.waitFor(() => expect(t.api.getDocument).toHaveBeenCalledTimes(2));
    expect(page.shadowRoot?.querySelector("dm-doc-tags")).not.toBeNull();
  });
});
```

Run: FAIL. In `apps/web/src/components/dm-doc-detail.ts`: add `import "./dm-doc-tags";` and a type import for the element (`import type { DmDocTags } from "./dm-doc-tags";`); in `onProgress`, after the early `return` for another document's id and before the existing `visuals` handling, add:

```ts
    // The tag suggestions of this document changed (or a resync may have missed that): its Tags row reads again.
    if (e === "resync" || e.tags !== undefined)
      void this.renderRoot.querySelector<DmDocTags>("dm-doc-tags")?.onEvent(e === "resync" ? "resync" : (e.tags as "suggested" | "failed"));
```

and in `render()`, in the final branch, between `${this.visualsBanner()}` and `<dm-view …>` add `${this.served ? html`<dm-doc-tags .documentId=${route.id}></dm-doc-tags>` : null}`.

Run the page tests: PASS. (A resync also fires the existing `reloadSession`; both run.)

- [ ] **Step 4: Run everything**

Run: `set -a; . ./.env; set +a; pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm --filter @docmind/web exec vitest run`
Expected: PASS (including `acceptance.test.ts`, whose fake server now has the tag routes). Verify in a browser before the PR: upload a document with a model configured, see Suggested chips appear, accept one, press Suggest tags on an older document and watch the busy state end, add a tag by typing, and check keyboard use (Tab order, Enter, the buttons' names).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(tags): tags row and suggested tags on the document page"
```

---

## Task 8: End to end, documents, and the rollout note

**Files:**
- Modify: `apps/server/app/documents/testHarness.ts` (the real `suggest-tags` flow behind the refresh route)
- Modify: `apps/server/app/erasure/e2eSupport.ts` (the erasure scan covers tag names and suggestions)
- Test: `apps/server/app/documents/tags.e2e.pg.test.ts`
- Modify: `docs/architecture.md`, `docs/codebase-guide.md`, `docs/operations/cloud-deploy.md`

**Interfaces:**
- Consumes: everything above. Test helpers: `startDocumentServer({ llm: true })`, `callApi`, `uploadAndAwaitTerminal`, `getDoc`, `h.fake.reply`, `h.fake.requests`, `h.fake.holdNext()`, `h.eventStore`, `ingestExecutionId` (`documents/ingest.ts`), `suggestTagsExecutionId` (Task 5).
- Produces: nothing later tasks use.

- [ ] **Step 1: Run the real flow behind the harness's refresh route**

In `apps/server/app/documents/testHarness.ts`:
- add `tags: TagService` as the last parameter of `makeIngest(...)` and pass `tags` where it is called (`makeIngest(app, fields, keys, (id) => effectiveBlobs(id), wiring, twinOverPgChunks(app, wiring), tags)`; move the existing `const tags = new TagService(...)` line above that call if needed);
- in `makeIngest`'s `buildApp(..., { onEvent: …, ingest: {…} })` add `suggestTags: { pool: app, fields, tags, bus, ...(wiring.llm.summary && { llm: wiring.llm.summary }) },`;
- add `runtime: loom.runtime,` to the object `makeIngest` returns (and `runtime: WorkflowRuntime` to its return type, imported as `type WorkflowRuntime` from `@loom/workflow-runtime`);
- in `startDocumentServer`, change the `suggestRoutes({ … })` default starter from the disabled one to `overrides.suggest?.starter ?? loomSuggestTagsStarter(ingest.runtime, { enabled: () => wiring.llm.summary !== undefined })` (import `loomSuggestTagsStarter`).

Run `pnpm --filter @docmind/server exec vitest run app/tags app/documents/visualsRetry.pg.test.ts` with the Postgres env: still PASS (the suggest route tests inject their own starter).

- [ ] **Step 2: Write the end-to-end test**

Create `apps/server/app/documents/tags.e2e.pg.test.ts`:

```ts
import { DocumentTagsResponse, ListDocumentsResponse, TagResponse } from "@docmind/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PG_URL } from "../db/testSupport";
import { suggestTagsExecutionId } from "../flows/suggest-tags/start";
import { ingestExecutionId } from "./ingest";
import {
  ALICE,
  type DocumentHarness,
  callApi,
  getDoc,
  startDocumentServer,
  uploadAndAwaitTerminal,
} from "./testHarness";

const WAIT = 60_000;
const md = (word: string) =>
  `# Notes\n\n${Array.from({ length: 4 }, (_, i) => `Paragraph ${i}. ${`${word} programme ledger `.repeat(22)}`).join("\n\n")}`;
const TLDR = "Reduce answer: the programme is on track";

describe.skipIf(!PG_URL)("document tags end to end (needs DOCMIND_TEST_PG_URL)", () => {
  let h: DocumentHarness;
  const DEFAULTS = {
    ingestTags: ["Finance", "Q3 plan", "Kestrel", "Fourth new one"] as unknown,
    suggestTags: ["Legal", "Q3 plan"] as unknown,
  };
  const state = { ...DEFAULTS };
  beforeAll(async () => {
    h = await startDocumentServer({ llm: true });
    h.fake.reply((body) => {
      const system = String((body as { system?: unknown }).system ?? "");
      if (system.startsWith("You combine"))
        return {
          text: JSON.stringify({
            tldr: TLDR,
            keyPoints: ["k"],
            entities: [],
            topics: ["t"],
            suggestedQuestions: ["q?"],
            suggestedTags: state.ingestTags,
          }),
        };
      if (system.startsWith("You suggest tags"))
        return { text: JSON.stringify({ suggestedTags: state.suggestTags }) };
      return { text: JSON.stringify({ summary: "part", entities: [] }) };
    });
  }, WAIT);
  afterAll(async () => void (await h?.close()));
  // Each test starts from the same model answers and no tags, so none depends on what an earlier one left (preflight F13).
  beforeEach(async () => {
    Object.assign(state, DEFAULTS);
    await h.owner.query("DELETE FROM tags");
  });

  const call = (method: string, path: string, body?: unknown) =>
    callApi(h, "alice", method, path, body);
  const list = async (qs: string) =>
    ListDocumentsResponse.parse(await (await call("GET", `/api/documents?${qs}`)).json()).items.map(
      (d) => d.id,
    );
  const tagIdOf = async (name: string) =>
    (
      (await (await call("GET", "/api/tags")).json()) as { tags: { id: string; name: string }[] }
    ).tags.find((t) => t.name === name)?.id as string;

  it(
    "upload, suggestions appear without being applied, accept one; the log holds no tag name; existing tags steer the next prompt",
    async () => {
      const id = await uploadAndAwaitTerminal(h, "alice", "a.md", md("Kestrel"), "ready");
      const doc = await getDoc(h, "alice", id);
      expect(doc.tags).toEqual([]); // never applied automatically
      expect(doc.suggestedTags).toEqual(["Finance", "Q3 plan", "Kestrel"]); // at most 3 new names
      const accepted = DocumentTagsResponse.parse(
        await (
          await call("POST", `/api/documents/${id}/tag-suggestions/accept`, { name: "q3 PLAN" })
        ).json(),
      );
      expect([accepted.tags.map((t) => t.name), accepted.suggestedTags]).toEqual([
        ["q3 PLAN"],
        ["Finance", "Kestrel"],
      ]);
      const dismissed = DocumentTagsResponse.parse(
        await (
          await call("POST", `/api/documents/${id}/tag-suggestions/dismiss`, { name: "Kestrel" })
        ).json(),
      );
      expect(dismissed.suggestedTags).toEqual(["Finance"]);

      const log = JSON.stringify(await h.eventStore.read(ingestExecutionId(ALICE.userId, id, 1)));
      for (const name of ["Finance", "Q3 plan", "q3 PLAN", "Kestrel", "Fourth new one"])
        expect(log).not.toContain(name);

      // The user's tag names go to the configured provider in the next summary prompt, and the model maps onto them.
      state.ingestTags = ["Q3 PLAN", "brand new"];
      const second = await uploadAndAwaitTerminal(h, "alice", "b.md", md("Osprey"), "ready");
      const reduce = h.fake.requests.filter(
        (r) =>
          JSON.stringify(r).includes("suggestedTags") && JSON.stringify(r).includes("already uses"),
      );
      expect(JSON.stringify(reduce.at(-1))).toContain('[\\"q3 PLAN\\"]');
      expect((await getDoc(h, "alice", second)).suggestedTags).toEqual(["q3 PLAN", "brand new"]); // the existing tag keeps its display name
    },
    WAIT,
  );

  it(
    "filters across three documents with Any and with All, paged without a gap",
    async () => {
      await h.owner.query("DELETE FROM tags");
      const ids = [
        await uploadAndAwaitTerminal(h, "alice", "x1.md", md("Alpha"), "ready"),
        await uploadAndAwaitTerminal(h, "alice", "x2.md", md("Bravo"), "ready"),
        await uploadAndAwaitTerminal(h, "alice", "x3.md", md("Charlie"), "ready"),
      ];
      const add = (doc: string, name: string) =>
        call("POST", `/api/documents/${doc}/tags`, { name });
      for (const [doc, names] of [
        [ids[0], ["red"]],
        [ids[1], ["red", "blue"]],
        [ids[2], ["blue"]],
      ] as const)
        for (const n of names) await add(doc as string, n);
      const red = await tagIdOf("red");
      const blue = await tagIdOf("blue");
      const onlyMine = (found: string[]) => found.filter((x) => ids.includes(x)).sort();
      const sorted = (...xs: (string | undefined)[]) => xs.filter(Boolean).sort() as string[];
      expect(onlyMine(await list(`tags=${red},${blue}&match=any`))).toEqual(sorted(...ids));
      expect(onlyMine(await list(`tags=${red},${blue}&match=all`))).toEqual(sorted(ids[1]));
      expect(onlyMine(await list(`tags=${red}`))).toEqual(sorted(ids[0], ids[1]));
      const paged: string[] = [];
      let cursor: string | null = null;
      do {
        const res: Response = await call(
          "GET",
          `/api/documents?tags=${red},${blue}&limit=1${cursor ? `&cursor=${cursor}` : ""}`,
        );
        const page = ListDocumentsResponse.parse(await res.json());
        paged.push(...page.items.map((d) => d.id));
        cursor = page.nextCursor;
      } while (cursor);
      expect(paged.sort()).toEqual(sorted(...ids));
    },
    WAIT,
  );

  it(
    "renames a tag (rows follow) and deletes one (the documents stay, the links go)",
    async () => {
      const id = await uploadAndAwaitTerminal(h, "alice", "r.md", md("Delta"), "ready");
      const tag = TagResponse.parse(
        await (await call("POST", "/api/tags", { name: "temp-name" })).json(),
      ).tag;
      await call("PUT", `/api/documents/${id}/tags`, { tagIds: [tag.id] });
      expect((await call("PATCH", `/api/tags/${tag.id}`, { name: "final-name" })).status).toBe(200);
      expect((await getDoc(h, "alice", id)).tags.map((t) => t.name)).toEqual(["final-name"]);
      expect((await call("DELETE", `/api/tags/${tag.id}`)).status).toBe(204);
      expect((await getDoc(h, "alice", id)).tags).toEqual([]);
      expect(await list(`tags=${tag.id}`)).toEqual([]);
      expect((await call("GET", `/api/documents/${id}`)).status).toBe(200);
    },
    WAIT,
  );

  it(
    "Suggest tags on an existing document: one run for a double press, reads only the summary, no tag name in the log",
    async () => {
      const id = await uploadAndAwaitTerminal(h, "alice", "s.md", md("Echo"), "ready");
      const before = h.fake.requests.length;
      const gate = h.fake.holdNext(); // the suggestion call parks, so the second press finds a run in flight
      const first = await call("POST", `/api/documents/${id}/tag-suggestions/refresh`);
      expect(first.status).toBe(202);
      const second = await call("POST", `/api/documents/${id}/tag-suggestions/refresh`);
      expect([
        second.status,
        ((await second.json()) as { error: { code: string } }).error.code,
      ]).toEqual([409, "suggest_running"]);
      gate.release();
      await expectSuggestions(id, ["Legal", "Q3 plan"]);
      const calls = h.fake.requests
        .slice(before)
        .filter((r) => JSON.stringify(r).includes("You suggest tags"));
      expect(calls).toHaveLength(1);
      const sent = JSON.stringify(calls[0]);
      expect(sent).toContain(TLDR); // the stored summary
      expect(sent).not.toContain("Paragraph 0."); // never a passage
      const log = JSON.stringify(
        await h.eventStore.read(suggestTagsExecutionId(ALICE.userId, id, 1)),
      );
      for (const name of ["Legal", "Q3 plan"]) expect(log).not.toContain(name);
      expect(log).toContain('"outcome":"suggested"');
    },
    WAIT,
  );

  async function expectSuggestions(id: string, want: string[]) {
    await vi.waitFor(
      async () => expect((await getDoc(h, "alice", id)).suggestedTags).toEqual(want),
      { timeout: WAIT },
    );
  }
});
```

Run: `set -a; . ./.env; set +a; pnpm --filter @docmind/server exec vitest run app/documents/tags.e2e.pg.test.ts`
Expected: PASS and not skipped. Adjustments that are the test's own detail, not the contract: the exact `h.fake.requests` shape (`FakeRequest` has the parsed body; `JSON.stringify` of it is what the other e2e tests search), `holdNext()`'s return (as in `retry.e2e.pg.test.ts`: the gate's `release()`), and the fake's reply routing by `system` prefix (`You combine`, `You suggest tags`). If `uploadAndAwaitTerminal` returns before suggestions are stored, they are written before the summary, which `ready` follows, so they are present.

- [ ] **Step 2a: The erasure end-to-end scan covers tag names and suggestions (preflight F16)**

The only erasure test so far is `DELETE FROM users` in `service.pg.test.ts`. The real pipeline is `erasure/erasure.e2e.pg.test.ts`, whose `seedUser` (in `erasure/e2eSupport.ts`) writes strings only that user wrote ("sentinels") and whose `assertErased` scans every column of every table for them. Make it seed a tag and a suggestion. In `apps/server/app/erasure/e2eSupport.ts`:

- in `seedUser`, extend the sentinel tuple: `const [inDoc, inFile, inAsk, inAnswer, inTitle, inTag, inSuggest] = [` … with two more entries ``` `sentinel-tag-${tag()}`, `sentinel-suggest-${tag()}`, ``` (the module's `tag()` is its random hex helper; both needles are at least 8 characters);
- right after `expect(seen.at(-1)?.status).toBe("ready");` add:

```ts
  // A tag the user named and a suggestion the model made: both sealed under the user's key. The sentinels prove that the
  // pipeline leaves neither name anywhere, and the row counts prove the scan has something to find the absence of.
  const added = await st.chatReq(who.cookie, "POST", `/api/documents/${documentId}/tags`, {
    name: inTag,
  });
  expect(added.status).toBe(200);
  const ref = { tenantId: who.tenantId, userId: who.userId, documentId };
  expect(await st.composed.tags.putSuggestions(ref, [inSuggest])).toBe(true);
  for (const table of ["tags", "document_tags", "document_tag_suggestions"]) {
    const rows = await st.db.owner.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE owner_id = $1`,
      [who.userId],
    );
    expect(rows.rows[0].n).toBe(1);
  }
```

- in the returned object: `sentinels: [inDoc, inFile, inAsk, inAnswer, inTitle, inTag, inSuggest],` (they join every scan, `needlesOf`, the log checks and `logs.assertClean`, which already take `sentinels`);
- in `assertErased`, in the list `["public.users", "public.read_model_state", "loom.events", "loom.fences"]` of tables the scan must have read, add `"public.tags"` and `"public.document_tag_suggestions"`, and after step 1's `expect(unexpected(hits, who)).toEqual([]);` add:

```ts
  // 1b. The tag tables hold nothing of the user: their rows cascade from the user row, and the names were sealed under the
  //     destroyed key (the scan above found neither sentinel in any column).
  for (const table of ["tags", "document_tags", "document_tag_suggestions"]) {
    const left = await db.owner.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE owner_id = $1`,
      [user.userId],
    );
    expect(left.rows[0].n).toBe(0);
  }
```

Run: `set -a; . ./.env; set +a; pnpm --filter @docmind/server exec vitest run app/erasure/erasure.e2e.pg.test.ts app/erasure/erasure.after.e2e.pg.test.ts app/erasure/erasure.resume.e2e.pg.test.ts`
Expected: PASS and not skipped. (If another e2e file asserts the exact number of sentinels or tables, update that assertion: the three files above are the ones that call `seedUser` and `assertErased`.)

- [ ] **Step 3: Update the documents**

`docs/architecture.md`:
- line 3: change `Last updated 2026-10-23.` to `Last updated 2026-11-10.`
- §4.1 table: after the `` | `flows/chat-title/` | … | `` row add:
  `` | `flows/suggest-tags/` | Suggests tags for one document from its stored summary, on demand (one step, one model call) | ``
  and after the `` | `documents/` | … | `` row's neighbour add `` | `tags/` | The tag service (sealed names, keyed lookup hash, links, suggestions), the tag and suggestion routes, the suggestion normaliser | ``.
- §5.1 table: after the `Link graph and entity keys` row add `` | Tags, tag links, tag suggestions | `tags`, `document_tags`, `document_tag_suggestions` | RLS by tenant; names sealed with the user's key; uniqueness on `tags.name_bind`, an HMAC of the normalised name under a key derived from the user's data key (plaintext never compared) | ``; and append `, `tags`, `document_tags`, `document_tag_suggestions`` to the end of the `Tables, by migration:` list.
- New section, inserted before `## 8. Chat and retrieval`:

```markdown
### 7.3 Tags

A user groups documents with their own tags (no hierarchy, no colours) and filters the library by them.

- **Storage.** `tags` holds a sealed name (`tag:<id>:name`) and `name_bind`, an HMAC-SHA256 of the normalised name (NFKC, trim, one inner space, case-fold) under a key derived from the owner's data key with its own HKDF info (`crypto/tagKeys.ts`, the `EntityKeys` pattern), unique per owner. `document_tags` links a document and a tag through composite foreign keys on `(tenant_id, owner_id, id)`, so both always share the owner; `document_tag_suggestions` holds one sealed list of up to 5 names per document. All three cascade with the document, the tag and the user (migration 0036; the same tenant-isolation policy as `documents`, and the owner is named in every query), so erasure needs no step of its own and crypto-shredding also covers the names. Limits: 20 tags per document, 200 per user, 10 per filter.
- **Suggestions (never applied automatically).** The ingest `summarize` step reads the owner's tag names (decrypted in memory, at most 200, most used first), puts them in the reduce prompt as a quoted JSON list with one line asking for `suggestedTags` (up to 5, reusing existing names, at most 3 new), parses the field leniently (missing or malformed is `[]`), runs `normaliseSuggestions` (clip to 40 characters, map onto an existing tag by normalised form, dedupe, drop tags the document already has) and stores the result before the summary. A suggestion problem never fails ingest; a key-store outage still fails the step. An existing document gets the on-demand `suggest-tags` flow (`flows/suggest-tags/`, one step, `u_<user>:suggest-tags-<doc>-r<n>`, one run at a time per document through `rerunTracker`, at most 10 presses per user per minute): it reads only the stored summary and the tag names, makes one model call with the same answer and normalisation, replaces the row and emits a `tags` document event. It is not recovery-owned: an interrupted run is pressed again, and the page's busy state ends after 60 seconds.
- **The ingest flow identity is unchanged.** Loom's flow hash covers the step list, ids, tool ids, timeouts, retry policies, the deadline and the version, and nothing inside a step, so a prompt change in `summarize` leaves `ingest-document` at 3.0.0 with the same hash (`flowHash.test.ts` pins it); no legacy definition is needed.
- **Listing.** `GET /api/documents?tags=<id>,<id>&match=any|all` filters in SQL before the cursor cut, with explicit owner and tenant predicates (`any` an `EXISTS`, `all` the documents holding every id), and the cursor carries a fingerprint of the filter, so a cursor reused under another filter answers 400. The library page is a hydrated view: its `documents` provider takes the same `tags` and `match` as parameters, and each row's Tags cell is a loom-ui token cell, so a chip in a row filters the list to that tag alone.
- **Privacy.** Names and suggestions are sealed and never appear in logs, the event log, lineage or error messages. The user's tag names reach their configured model provider inside the summary and suggestion prompts, the same boundary as the document text.
```

- §10, after the sentence `The user's visuals lineage needs no step of its own: …` add a paragraph: `Tags, their links and the sealed suggestions need no step of their own either: the foreign keys cascade from the user row in \`rows\`, and the names are sealed under the key \`shred\` destroys. Erasure settles and cancels a user's on-demand \`suggest-tags\` starts like the other flows' starts (\`erasure/wire.ts\`), and a run that still got through would find no document and no sealing key.`
- §13 Known limits: add `- After 999 "Suggest tags" presses for one document the button answers busy (the run number is the execution id's suffix).`

`docs/codebase-guide.md` line 77: `0001–0035` becomes `0001–0036`, and the same row's list gains `tags`. Add a row to the table that lists server folders if one exists for `flows/chat-title` (search `grep -n "chat-title" docs/codebase-guide.md`) naming `flows/suggest-tags` and `tags/`.

`docs/operations/cloud-deploy.md`: after the structure-diagrams rollback bullet add:

```markdown
- **The tags release (migration 0036, flow `suggest-tags` 1.0.0) can be rolled back.** Migration 0036 is additive (three new tables and one extra unique constraint on `documents`), so older code ignores it. `ingest-document` stays at 3.0.0 with an unchanged flow hash (the summarize prompt is not part of it; `apps/server/app/flows/ingest-document/flowHash.test.ts` pins it), so executions in flight resume on either build. A build without `suggest-tags` registered cannot resume a `suggest-tags` execution that was in flight (`FlowCodeMismatchError`); nothing recovers those anyway (they are not recovery-owned), the document page's busy state ends by itself after 60 seconds, and pressing the button again after the roll forward starts a fresh run. Tags already made stay in the database, and the older build neither shows nor uses them.
```

- [ ] **Step 4: Full verification**

Run, from the worktree root: `set -a; . ./.env; set +a; pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm build && pnpm test`
Expected: all PASS, and in the vitest summaries the new pg files ran (`service.pg.test.ts`, `routes.pg.test.ts`, `suggestRoutes.pg.test.ts`, `tags.list.pg.test.ts`, `tags.explain.pg.test.ts`, `tagFilter.pg.test.ts`, `summarize.tags.pg.test.ts`, `suggest-tags/step.pg.test.ts`, `suggest-tags/flow.pg.test.ts`, `tags.e2e.pg.test.ts`, `erasure/erasure.e2e.pg.test.ts`). Then the browser check the project requires before a PR: `pnpm serve`, sign in, upload two documents with a model configured, accept a suggestion, filter with Any and All, watch the address, back and forward, rename and delete in Manage tags, press Suggest tags on an older document (the busy state ends), and tab through the page with the keyboard.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs(tags): architecture, codebase guide and rollout note; end-to-end tag tests"
```

---

## Self-review

**Spec coverage** (section by section; every row has a task):

| Spec | Task |
|---|---|
| 1 Goal: manual tags, suggestions at ingest and on demand, Any/All filter | 3, 4, 5, 6, 7 |
| T1 per-user tags, no hierarchy or colours | 1, 2 |
| T2 sealed names, keyed lookup hash, no plaintext comparison | 1 (`TagKeys`), 2 (`tags_owner_name_key`, seal test) |
| T3 suggestions at ingest and on demand | 4, 5 |
| T4 never applied automatically | 4 (stored as suggestions), 5 (accept route), e2e in 8 |
| T5 filter by id, any/all, SQL before the cut | 3 (`listDocumentsQuery`), 6 (reader) |
| T6 one additive migration | 2 (0036, free number checked: 0035 is the last on `main`) |
| 3 tables and columns, uniqueness, same-owner guarantee, RLS, erasure, limits, reuse of a normalised name, tag with no documents stays, rename collision | 2 (tests for each), 3 (409 `tag_exists`, `tag_limit`) |
| 4 prompt and answer, lenient `suggestedTags`, `normaliseSuggestions`, storage, `DocumentSummary` unchanged | 1, 4 |
| 4 on demand flow, `rerunTracker`, summary only, event, disabled button with reason | 5 (starter, step, routes `no_summary`), 7 (button and reason) |
| 4 ingest flow version | Plan decision D1, Task 4 `flowHash.test.ts`, Task 8 rollout note |
| 4 failures: never fails ingest; on-demand "Couldn't suggest tags" with Retry; key-store outage fails | 4 (`tolerant`), 5, 7 |
| 5 every route and its statuses; rows and detail gain `tags` and `suggestedTags` | 3 and 5 |
| 5 listing filter syntax, both SQL forms, cursor filter validity, explicit owner and tenant predicates, zero tags unfiltered | 3 (D7: `all` is the set-based form of the spec's count) |
| 6 documents page: bar, chips with count and `aria-pressed`, Any/All radio group enabled from 2, Clear, URL state, empty message, polite count, Manage tags with rename and confirmed delete | 6 |
| 6 row chips that filter by one tag | 6 (D8: loom-ui token cell, pin `fc34435`; the page answers `TABLE_TOKEN`; the web test clicks a chip in a row) |
| 6 detail: Tags row with × and autocomplete, Enter adds, Suggested line with ✓ and ×, Suggest tags with a busy state | 7 |
| 7 privacy and cost | 4 (no name in logs or step input), 5 and 8 (log checks), D2 |
| 8 testing list | unit (1), Postgres (2, 3 including a 6,600-document seed with an index-use check and an equality check against a brute-force read), routes (3, 5), flow (4, 5), e2e (8), erasure scan (8 Step 2a), erasure wiring (5 Step 9a), web (6, 7) |
| 8 erasure | 2 (cascade and shred), 5 Step 9a (starts settled and cancelled), 8 Step 2a (the real pipeline: tag and suggestion needles absent) |
| 9 out of scope | not built |

**Placeholder scan:** no "TBD", "TODO" or "similar to Task N"; every step carries its code or exact edit. The places that depend on code not read while planning say how to settle them: a test fixture list for `tags: []` (found by `typecheck:tests`), the fake Anthropic's `requests` shape (copied from the existing e2e tests), the generator output for `loom.gen.ts`.

**Type consistency:** `TagService` method names and the `DocumentTagsView` shape (`{tags, suggestedTags}`) are the ones used in Tasks 3, 4, 5, 6, 7; `ExistingTag` (`{id, name, linked}`) is the type of `suggestionContext` and the argument of `normaliseSuggestions`; `SuggestTagsStart` kinds `started | running | disabled` map to the route's 202, 409 `suggest_running`, 409 `suggest_unavailable`; the `tags: "suggested" | "failed"` event field is the one the step publishes, the contract validates and `dm-doc-detail` forwards; `Route.documents.match` is `"all"` only, and `selection()` turns the omitted value into `"any"`; `listDocumentsQuery(ownerId, { cursor, limit, tenantId, filter })` is called by the route, the reader, `pgDocumentReads` and the EXPLAIN test with the same shape (`tenantId` required); `SuggestTagsStarter` has `start`, `settle`, `cancel` and `idle`, and `ErasureParts.suggestTags` picks the last three; `authed`, `idOf`, `notFound` and `answering` are exported once from `tags/routes.ts`; the library table's Tags cell is `{ tokens: [{ id, label }] }` and its action is `TABLE_TOKEN` with `{ rowKey, tokenId }`; `DocumentDto.tags` is required and `suggestedTags` optional everywhere.

**Spec points that could not be planned cleanly:**
1. Row chips needed a loom-ui change (requested from `loom-ba`); it landed as PR #131 and Task 6 gates on it at the pin `fc34435`, with no text-column fallback.
2. The spec says owner-scoped RLS "with the same policies as `documents`": `documents` has tenant isolation only (there is no per-owner database setting), so the tables carry that policy and every query names the owner (D3).
3. The spec's `all` form is a correlated count; the plan uses the equivalent set-based form so the planner can start from the tag index (D7), guarded by the EXPLAIN test.
4. The spec names `entityNameBind` as the lookup pattern; in the code it is only the seal bind, and the lookup key is `EntityKeys.nameKey` (D2).
5. The spec's "single-pass path" does not exist: the summary always maps and reduces (D5).

**Execution handoff:** Plan complete and saved to `docs/superpowers/plans/2026-11-10-document-tags.md`. Two execution options: (1) Subagent-Driven (recommended): a fresh subagent per task with review between tasks; (2) Inline Execution with `superpowers:executing-plans`.
