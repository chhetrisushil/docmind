# Structure Diagrams, Phase C2 (Timeline and Relationships) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a document's dated events (a timeline) and the named relationships between the parties it mentions (a labelled network) on its Visuals tab, both extracted by the model in the existing extraction call, with no second call and no boot spending.

**Architecture:** The document extraction answer gains two optional top-level fields, `timeline` and `relations`. Pure normalisers validate each item (date precision, clipping, citations, dedupe, order, caps, minimums) and drop bad items without touching the facts. The survivors are two sealed aggregate facts in `visual_facts` at reserved ordinals 18 (`timeline`) and 19 (`relations`); migration 0037 widens the ordinal and kind rules; the extraction write owns ordinals 0..15 and 18..19 together, the c1 structure write keeps 16..17. The document catalogue becomes `docmind.visuals.v4` with `DocumentTimeline` (loom-ui `Diagram`, `timeline` layout) and `Relationships` (`Diagram`, `network` layout); `factFormatFingerprint()` and the flow hash do not move, so nothing re-plans at boot.

**Tech Stack:** TypeScript, zod, Postgres (RLS, `withTenant`), Loom (`step$`, `flow$`, `stepEffectOf`, `flowContentHash`), loom-ui pinned at fc34435 (`@loom-ui/core` `DiagramValue`, `diagramProblems`, `TimeFormat`, `MAX_DIAGRAM_NODES`; `MAX_WIDGET_REFS` 16), vitest, pnpm/turbo, biome.

**Spec:** `docs/specs/2026-11-10-structure-diagrams-c2-design.md` (binding; read it first). Precedent: `docs/specs/2026-11-10-structure-diagrams-c1-design.md` and `docs/superpowers/plans/2026-11-10-structure-diagrams-c1.md`. Background: `docs/specs/2026-11-08-document-visuals-design.md` §10.

## Pre-flight record (read before starting)

Every existing name in this plan was verified against the code at `main` ae6e52a (this worktree's base), Loom pin 4af27eaa and loom-ui pin fc34435. Findings that shape the plan:

| Id | Finding | Where handled |
|---|---|---|
| F1 | **Flow hash (D7) is unaffected.** Loom's `flowContentHash` (`packages/core/src/flowHash.ts`, identical at 4af27eaa and at Loom HEAD) covers only the flow id and version, the deadline and each step's `id`, tool id, timeout and retry. It reads nothing inside a step: not a prompt, not an output schema. Changing the extract step's prompt and output therefore leaves the `visualize-document` 1.1.0 hash at `sha256:d3bfb104f3d015ab8165a9784f5f958bd46a347f3a2fb66f4d0d7be6c4e25f9e` (computed with the real `flowContentHash` on `main`; the same method reproduces the already-pinned 1.0.0 hash `sha256:d8491324...`). No flow version bump, no new legacy definition. | Task 4 step 1 (pin test, new `flowHash.test.ts`, modelled on `ingest-document/flowHash.test.ts`) |
| F2 | **The v4 catalogue id does NOT trigger a re-plan.** The boot stale pass (`pgStaleFormatDocuments`, migrations 0030/0032) compares `visual_runs.format` with `factFormatFingerprint()`, which is built from the three tool pins and `STRUCTURE_FORMAT` only; the catalogue id is not in it. Stored plans carry no catalogue id (compile checks node types against the catalogue it is given), and v3's eight entries are the first eight of v4 byte for byte (guarded by a sha256 of `VISUALS_CATALOG.entries.slice(0, 8)` = `26bc046f4768d49e9cc97ed29a5689e0d8857f229e7e5e810e22b072eea065aa`, computed on `main`). The id and the new entries do change a NEW planner decision's keyed id (loom-ui keys a decision on catalogue content, intent and capabilities), which only affects runs started after the deploy. A run in flight at the deploy replays its recorded decision or, if it had not decided yet, decides once under v4. | Task 3 (v4 guard, hydrate test), Task 6 steps 1 and 2 (e2e stamp and stale list, rollout test: a sweep starts only the stale document) |
| F3 | **Spec gap, D5 (ruled by the user: re-extract once).** The spec said an existing document "gets them when the user presses re-run", but in the code a re-run (`-r<n>`) never extracts when the document has stored extracted facts, and skips extraction after a `done` run (`extract.ts`, the `rerun > 0` branch; docs/architecture.md "Retry"). Ruling: mark each document's extraction with a format, `docmind.extract@2`; a re-run the USER asks for (never a boot pass) extracts again only when the stored marker is missing or not the current one, and the extraction stamps it, so that costs one extraction call per document, once; every later re-run is a cheap re-plan. **Where the marker lives:** a nullable `documents.visual_extract_format` column added by migration 0037, set by `PgVisualFacts.replace` in the same transaction as the facts. Why there: it is per document, plain (a token, no content, so no sealing), and atomic with the extraction it describes; `visual_facts` cannot hold it (a document whose extraction found nothing has no rows); `visual_runs` cannot (one row per generation whose newest run replaces the last, stamped only by the lossy event feed after the fact, and it already carries the unrelated fact-format stamp that must not move). NULL on every existing document means "extracted before c2" with no backfill. Chat never writes or reads it (its extraction path has no store write, and a test guards the source). | Tasks 2 and 5 |
| F4 | The extraction prompt, `askForFacts` and `ExtractAnswer` are shared with the chat turn (`visualize-turn/steps.ts`). Chat must not pay for a longer prompt or answer, and its request must stay byte-identical. The document path gets its own `EXTRACT_DOCUMENT_SYSTEM`, `DocumentAnswer` and `askForExtraction`; `askForFacts` and `EXTRACT_SYSTEM` are untouched. | Task 4 |
| F5 | `VISUALS_MAX_TOKENS` is 8192 (`ingest-document/limits.ts`). A longer answer (up to 40 events and 30 links with citations, beside up to 16 facts) can exceed it, and a truncated answer is `LlmOutputError`, which would fail the whole extraction and so cost the existing facts. The cap moves to 16 000 (the `VISION_MAX_TOKENS` precedent), and the prompt asks for at most 2 cited passages per item. | Task 4 steps 3 and 5 |
| F6 | `ExtractResult.count` is what the flow reads as "extracted facts" (a plan failure with none is `empty`, not `failed`). Aggregates are counted apart (`aggregates`, present only when above 0) so a timeline-only document is treated like a structure-only one, and the skip-extraction re-plan reports them so the load step still runs. | Task 4 steps 4 and 5 |
| F7 | Rolling back to the c1 build after any document has a timeline or relations row is unsafe: the c1 `visual_facts` reader rejects unknown kinds, so the load step and the document page's reader fail for that document. The migration itself is safe under old code. | Task 6 (cloud-deploy note) |

## How the c1 pre-flight mistakes are avoided here

| c1 mistake | c2 design |
|---|---|
| Ordinal schemas that cap at 15 | `StoredEntry` has one literal ordinal per aggregate kind (18, 19) and per structure kind (16, 17); `StoredFact` (chat) stays 0..15. Tested in `facts.test.ts` (Task 2 step 1). |
| `VISUAL_SHAPES` / views dropping high ordinals | `VISUAL_SHAPES` gains exactly `visual-timeline-18` and `visual-relations-19` (count 66 to 68); the pin regexes already accept two digits; `DETAIL_ENTRIES` and `entryFitsOrdinal` get both entries. Tested (Task 3 steps 1 and 4). |
| `LoadOutput.facts` max counts | `MAX_STORED_FACTS` = `MAX_FACTS` + 4 = 20, imported never redeclared; tested at 20 and 21 (Task 2 step 1). |
| Planner samples that fail binding validation | The timeline and relations samples carry content-free placeholder `nodes` (and `edges`); tests run `jsonPathSelect` over them and plan a real binding with no `reshape-invalid` (Task 3 step 1). |
| Flaky EXPLAIN tests on tiny tables | None are added: the only new SQL is one count and two range predicates on the existing `(tenant_id, document_id, ordinal)` unique index, asserted by behaviour (rows), not by plan. |
| Random-UUID ordering | No test depends on the order of random ids: facts are ordered by ordinal, events by `(at, passage position, input order)`, links by input order, parties by first appearance. |
| Vacuous assertions | Every ratchet is paired with a control (a boundary just inside and just outside); counts are asserted with their contents; no `toHaveLength(n)` stands alone where the content matters. |
| Redeclared constants | `MAX_FACTS`, `STRUCTURE_ORDINAL_BASE`, the two aggregate ordinals and the date precisions are declared once in `facts.ts` / `dates.ts` and imported everywhere (the experiences package keeps its own reserved-ordinal map, as c1 did, and `plan.test.ts` pins the copies equal). |
| SQL without explicit owner and tenant predicates | Every new statement (`DELETE`, `aggregateCount`) names `tenant_id` and `owner_id`, plus `lockDocument`. |

## Global Constraints

Every task's requirements include these (values copied from the spec):

- D1: **Approach A:** the existing extraction call returns the new data. No second call.
- D2: Two aggregate facts at reserved ordinals, outside the 16-fact chart pool: `timeline` at 18, `relations` at 19.
- D3: Dates are kept at day, month, quarter or year precision and shown as written. Relative or undated phrases are dropped.
- D4: Relationships get their own Diagram entry. c1's entity map is unchanged.
- D5: **Rollout is on demand only, and re-extracts once.** New uploads and re-ingests get the new facts automatically and stamp the document with the extraction format (`docmind.extract@2`). An existing document is stamped nothing (NULL) until it is extracted again. A re-run the user asks for re-extracts only when the stored stamp is missing or is not the current one: one extraction call per document, once. After that, re-runs are cheap re-plans as today. The boot re-plan is not triggered and a boot pass never extracts, so the fact-format fingerprint is unchanged.
- D6: Migration 0037 widens the ordinal CHECK to 0..19 and extends the kind/ordinal rule.
- D7: The visualize-document flow version is unchanged: only the extract step's prompt and output change. This is verified against Loom's flow hash and pinned by a test.
- The `EXTRACT_SYSTEM` answer gains two optional top-level fields next to `facts`: `timeline: {"events":[{"when","date","label","chunkIds"}]}`, at most 40 events (`when` is the date as written; `date` is `YYYY`, `YYYY-Qn`, `YYYY-MM` or `YYYY-MM-DD`); `relations: {"links":[{"from","rel","to","chunkIds"}]}`, at most 30 links (`from` and `to` are entities as written; `rel` is a short verb phrase).
- The prompt tells the model: copy dates and names as the document states them; never infer or compute a date; leave out relative or undated phrases; cite the passages each item comes from.
- Server-side validation: each bad item is dropped. A bad item never fails the run or affects other facts.
- Dates: `date` must parse at its precision: year 1000-9999; quarter 1-4; a real month; a real day for that month. The stored event keeps `at` (the ISO first day of the period), `precision` (`day | month | quarter | year`) and `when`, clipped to 40.
- Text: `label` is clipped to 80 characters, `rel` to 40, and entity names to 80. Control and invisible characters are stripped.
- Citations: `chunkIds` must be passages of this document (the existing fact check). Items with none left are dropped.
- Events: dedupe by (`at`, `precision`, normalised label); sort by `at`, then by the position of the first cited passage; cap at 40; a timeline needs at least 3 events.
- Links: drop self-links (the same normalised endpoints); dedupe by (from, rel, to), normalised; cap at 30; relations need at least 3 links.
- A missing field is the old behaviour: no timeline or relations fact.
- Storage: new sealed fact kinds in `visual_facts`: `timeline` (ordinal 18) and `relations` (ordinal 19). Migration 0037: `ordinal BETWEEN 0 AND 19`; the kind/ordinal CHECK becomes: extracted kinds `< 16`, `outline`/`cooccurrence` at 16/17, and `timeline`/`relations` at 18/19 (each kind at its own ordinal).
- Who replaces what: the extraction write replaces ordinals 0..15 and 18..19 together, so a new extraction with no timeline removes the old one; a re-plan that skips extraction keeps 18..19, because they can't be re-derived without the model; c1's structure write keeps owning 16..17.
- Sealed per user, owner-scoped, and erased with the user.
- `DocumentTimeline` (Diagram, `timeline` layout): nodes are events: `at` is the ISO start, and the label is the event label; when precision is not `day`, the label is prefixed with `when` ("Q3 2025 · Launch"), so the axis never implies a false day; `timeFormat` is date-only; `refs` holds at most 16 event passages.
- `Relationships` (Diagram, `network` layout): nodes are the link endpoints, deduped by normalised name (at most 60); edges are directed from -> to and labelled with `rel`; `refs` holds at most 16 cited passages.
- Reshapers return values that pass loom-ui's `diagramProblems`. `fitsShape` and `entryFitsOrdinal`: each entry reads only its own ordinal (18 and 19), and misfits are dropped at plan time. The planner sample holds content-free placeholders.
- The document catalogue becomes `docmind.visuals.v4`. `FACT_VISUALS_CATALOG` (chat) stays byte-identical, and its sha256 guard stands (`e9096cf41a01d1b87ef45b3eba3744600ae81e36d78fff476f6117f1455af080` in `packages/experiences/src/visuals.test.ts`).
- `VISUALS_INTENT` gains: use a timeline when the document narrates dated events, and a relationships diagram when it states how parties relate. Leave them out for a few scattered dates or links.
- Rollout (D5): `factFormatFingerprint()` is unchanged, so the boot stale-format pass does not re-plan anything. Existing plans stay valid, because v3's entries are a subset of v4's. The plan verifies that a stored plan from v3 still hydrates under v4. Re-extract once: the route's re-run (never a boot pass) is marked as asked by the user; the extract step extracts again for such a re-run only when the document's `visual_extract_format` is not `docmind.extract@2` (NULL for a document extracted before c2); the extraction stamps it, so a second re-run, and the re-run of a document stamped by a c2 upload, re-plan without extracting. A boot pass never extracts over stored facts, as before. A future extraction change bumps the token and gets the same one-time behaviour.
- Privacy: event labels, written dates, entity names and relation phrases are sealed per user. They never appear in logs, the event log, lineage or error text. The planner sees capability descriptions and counts only. Erasure shreds them. The erasure plaintext scan gains timeline and relation needles.
- Cost: no extra call (the extraction answer is longer); no boot spending; one extraction call per document, the first time the user re-runs it after c2.
- Out of scope: an automatic backfill of existing documents; timelines or relationships in chat answers; cross-document timelines or relationship graphs; merging relationship nodes with the `entities` table, or with c1's entity map; editing extracted events or links.
- Verification commands (run from the worktree root `/Users/such/workspace/docmind/.worktrees/structure-c2`): `pnpm typecheck`, `pnpm typecheck:tests`, `pnpm lint`, `pnpm build`, and the suites named in each task. Postgres suites need `set -a; . ./.env; set +a` first (it sets `DOCMIND_TEST_PG_URL`); **a skipped pg test is not a pass**: check the vitest summary shows the pg tests ran, not "skipped". The worktree has no `node_modules` of its own: run `pnpm install --frozen-lockfile` once at the root before the first command. The snippets in this plan are not pre-wrapped to biome's line width: run `pnpm exec biome check --write <the files you changed>` before each commit (and before `pnpm lint`), and keep the code's meaning exactly as written.

## Plan decisions (where the spec is silent or the code constrains it)

Each is repeated as a "Plan decision:" next to the step that applies it.

- **Plan decision: ordinal ownership (spec 4).** One table, tested in Task 2:

  | Ordinals | Kinds | Written by | Cleared by |
  |---|---|---|---|
  | 0..15 | `series`, `figure`, `factTable` | `PgVisualFacts.replace` (extraction) | `replace` |
  | 16 | `outline` | `PgVisualFacts.replaceStructure` (c1) | `replaceStructure` |
  | 17 | `cooccurrence` | `replaceStructure` | `replaceStructure` |
  | 18 | `timeline` | `replace` (extraction) | `replace` |
  | 19 | `relations` | `replace` (extraction) | `replace` |

  `replace` deletes `ordinal < 16 OR ordinal >= 18` and refuses a fact outside its set; `replaceStructure` deletes `ordinal >= 16 AND ordinal < 18`. A re-plan that skips extraction never calls `replace`, so 18..19 survive; the structure step re-derives 16..17 only. A refusal (`LlmRefusalError`) calls `replace(ref, [])`, which clears 0..15 and 18..19 (the stored facts must reflect that run).
- **Plan decision: stored shapes.** `timeline`: `{ kind, events[3..40] of { at (ISO day), precision, when (1..40), label (1..80), chunkId (uuid) }, chunkIds[1..40] }`, `chunkId` being the earliest-positioned valid passage the event cites and `chunkIds` the distinct `chunkId`s in event order (so the first 16 become the widget's refs). `relations`: `{ kind, entities[2..60] of string (1..80, distinct by normalised name, in order of first appearance), links[3..30] of { from, to (indexes into entities, from != to), rel (1..40), chunkId (uuid) }, chunkIds[1..30] }`. Parties are deduplicated once, on the server, when the fact is built (spec 5 "deduped by normalised name"), so the reshaper needs no normalisation function and none is duplicated into the experiences package. Both `.strict()`. `at` must be a real date and consistent with `precision` (first day of its period), checked in `StoredEntry`'s refinement.
- **Plan decision: "position of the first cited passage" (spec 3).** The position of a passage is its index in the document's passage order (`sectionsOf`). An item's `chunkId` is the cited passage with the lowest position; ties on `at` sort by that position, then by the item's index in the model's answer.
- **Plan decision: `when` fallback.** A missing or empty `when` falls back to the `date` string as the model gave it (trimmed). The date still parses, so the item is kept; the label prefix then reads "2025-Q3 · Launch".
- **Plan decision: cap order.** Events: dedupe, then sort, then cap at 40 (the 40 earliest survive), as the spec orders them. Links: dedupe, then cap at 30 in the model's order (the first 30 survive); links are not sorted.
- **Plan decision: raw input bound.** Each normaliser reads at most 200 raw items of an answer (merged over windows), so a runaway answer cannot cost more than a bounded scan.
- **Plan decision: windows.** The extraction asks per window (24 000 characters); each answer's raw events and links are concatenated in window order and normalised once, so duplicates across windows are removed by the same dedupe.
- **Plan decision: `aggregateCount`.** A cheap `VisualFactStore.aggregateCount(ref)` (a `count(*)` over ordinals >= 18, owner-scoped, no decrypt) lets the extract step ask whether a document already has a timeline or relations without opening any fact.
- **Plan decision: timeline axis.** `timeFormat` is `{ granularity: "day" }` with no `timeZone` (loom-ui reads every granularity coarser than `datetime` in UTC and draws a date-only tick as the written date in every viewer zone), and node `at` is always an ISO date (`YYYY-MM-DD`), so `Date.parse` accepts it (`diagramProblems`: "a timeline node needs `at`" and "`at` must be a date").
- **Plan decision: planner sample (placeholders).** Timeline: `{ kind: "timeline", events: <count>, nodes: [{ label: "Event", at: "2000-01-01" }, { label: "Event", at: "2000-06-01" }] }`. Relations: `{ kind: "relations", parties: <count>, links: <count>, nodes: [{ label: "Party", group: "party" }, { label: "Party", group: "party" }], edges: [{ from: "n0", to: "n1", label: "relation" }] }`. Descriptions state counts only. No document text, no real date.
- **Plan decision: migration 0037 replaces all three CHECKs** (`visual_facts_kind_check`, `visual_facts_ordinal_check`, `visual_facts_kind_ordinal_check`, names kept), because the third is `(kind IN ('outline','cooccurrence')) = (ordinal >= 16)` in 0035 and would refuse `timeline` at 18 as an "extracted" row and let `outline` sit at 17. The new rule pins each kind to its own ordinal. Every existing row satisfies it (the c1 step writes outline at 16 and cooccurrence at 17 only, and `StoredEntry` is tightened the same way in Task 2). 0035 and 0026 are never edited.
- **Plan decision: re-extract once (F3, the user's ruling).** The marker is `documents.visual_extract_format` (nullable `text`, at most 64 characters), `EXTRACT_FORMAT = "docmind.extract@2"` in `facts.ts`. `PgVisualFacts.replace` (extraction only: `replaceStructure` and chat never touch it) sets it under the document lock in the same transaction as the facts, also for an empty or refused extraction (the extraction ran under the c2 prompt), and `extractFormat(ref)` reads it. `VisualsStarterOptions.reextract` and `ExtractDeps.reextract` are one shared `Set<string>` created in `compose.ts` beside `afterDone`; only `starter.rerun` (the route) notes an id, `rerunWith` called by a boot pass does not. The extract step consumes its note and, for a noted re-run, extracts when `extractFormat(ref) !== EXTRACT_FORMAT` (missing or older: the rule is inequality, so a later bump of the token re-extracts once more). A noted re-run of a stamped document, and any un-noted re-run, keep today's rules. Accepted: the note is in-process, so a run recovered after a crash re-plans only (and the next press extracts). A re-ingest keeps the old stamp until its own first extraction restamps it, which always happens (the automatic run extracts).

## File Structure

Created (server, `apps/server/app/flows/visualize-document/`):
- `dates.ts`: `parseEventDate`, `isStoredAt`, `DATE_PRECISIONS`.
- `timeline.ts`: `buildTimeline`, `rawEventsOf`, the draft types and limits.
- `relations.ts`: `buildRelations`, `rawLinksOf`, the draft types and limits.
- `flowHash.test.ts`: the flow identity pin (D7).
- Tests beside each (`dates.test.ts`, `timeline.test.ts`, `relations.test.ts`, `structureText.test.ts`).

Created (migration): `infra/migrations/0037_visual_facts_aggregate_kinds.sql`.

Modified (server): `structureText.ts` (`cleanText`, `nameKey`, `earliestPassage`, `isRecord`), `facts.ts`, `pgFacts.ts`, `prompts.ts`, `extract.ts`, `flow.ts`, `start.ts`, `deps.ts`, `plan.ts`, `testing.ts`, `../ingest-document/limits.ts`, `../../compose.ts`, `../../erasure/e2eSupport.ts`, and the tests named per task.

Modified (experiences, `packages/experiences/src/`): `structureShapes.ts`, `visuals.ts`, `views.ts`, `index.ts` and their tests.

Modified (web): `apps/web/src/ui/elements.test.ts`.

Modified (docs): `docs/architecture.md`, `docs/specs/2026-11-08-document-visuals-design.md`, `docs/operations/cloud-deploy.md`.

---

### Task 1: Pure date, text and aggregate normalisers

**Files:**
- Create: `apps/server/app/flows/visualize-document/dates.ts`
- Create: `apps/server/app/flows/visualize-document/timeline.ts`
- Create: `apps/server/app/flows/visualize-document/relations.ts`
- Modify: `apps/server/app/flows/visualize-document/structureText.ts`
- Test: `apps/server/app/flows/visualize-document/dates.test.ts`, `structureText.test.ts`, `timeline.test.ts`, `relations.test.ts` (all created)

**Interfaces:**
- Consumes: `clipText` from `apps/server/app/http/clip.ts` (existing, `(text: string, max: number) => string`, never cuts a surrogate pair).
- Produces (Tasks 2, 3 and 4 rely on these exact names):
  - `dates.ts`: `export const DATE_PRECISIONS = ["day", "month", "quarter", "year"] as const; export type DatePrecision = (typeof DATE_PRECISIONS)[number]; export interface EventDate { at: string; precision: DatePrecision } export function parseEventDate(raw: unknown): EventDate | null; export function isStoredAt(at: string, precision: DatePrecision): boolean`
  - `structureText.ts` (added to the existing exports `MAX_STRUCTURE_LABEL`, `clipLabel`): `export const MAX_RAW_ITEMS = 200; export const isRecord: (v: unknown) => v is Record<string, unknown>; export const cleanText: (raw: string, max: number) => string; export const nameKey: (raw: string) => string; export function earliestPassage(ids: unknown, position: ReadonlyMap<string, number>): string | null`
  - `timeline.ts`: `export const MAX_EVENTS = 40; MIN_EVENTS = 3; MAX_WHEN = 40; MAX_EVENT_LABEL = 80;` and a re-export of `MAX_RAW_ITEMS` (declared once, in `structureText.ts`); `export interface TimelineEvent { at: string; precision: DatePrecision; when: string; label: string; chunkId: string } export interface TimelineDraft { kind: "timeline"; events: TimelineEvent[]; chunkIds: string[] } export const rawEventsOf: (field: unknown) => unknown[]; export function buildTimeline(raw: readonly unknown[], position: ReadonlyMap<string, number>): TimelineDraft | null`
  - `relations.ts`: `export const MAX_LINKS = 30; MIN_LINKS = 3; MAX_PARTY = 80; MAX_REL = 40; export interface RelationLink { from: number; to: number; rel: string; chunkId: string } export interface RelationsDraft { kind: "relations"; entities: string[]; links: RelationLink[]; chunkIds: string[] } export const rawLinksOf: (field: unknown) => unknown[]; export function buildRelations(raw: readonly unknown[], position: ReadonlyMap<string, number>): RelationsDraft | null`
  - `position` is a map from a document's passage id (lowercase) to its index in passage order; its keys are "the passages of this document".

- [ ] **Step 1: Write the failing tests**

Create `apps/server/app/flows/visualize-document/dates.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { type DatePrecision, isStoredAt, parseEventDate } from "./dates";

describe("parseEventDate", () => {
  it.each([
    ["2025", "2025-01-01", "year"],
    ["1000", "1000-01-01", "year"],
    ["9999", "9999-01-01", "year"],
    ["2025-Q1", "2025-01-01", "quarter"],
    ["2025-Q2", "2025-04-01", "quarter"],
    ["2025-Q3", "2025-07-01", "quarter"],
    ["2025-Q4", "2025-10-01", "quarter"],
    ["2025-02", "2025-02-01", "month"],
    ["2025-12", "2025-12-01", "month"],
    ["2025-02-28", "2025-02-28", "day"],
    ["2024-02-29", "2024-02-29", "day"],
    ["2000-02-29", "2000-02-29", "day"],
    ["  2025-03-04  ", "2025-03-04", "day"],
  ] as const)("reads %j as %s at %s precision", (raw, at, precision) => {
    expect(parseEventDate(raw)).toEqual({ at, precision });
  });

  it.each([
    "999",
    "0999",
    "10000",
    "2025-Q0",
    "2025-Q5",
    "2025-q3",
    "2025-00",
    "2025-13",
    "2025-02-29",
    "2023-02-29",
    "2100-02-29",
    "2025-04-31",
    "2025-01-00",
    "2025-01-32",
    "2025-1-5",
    "2025/03/04",
    "2025-03-04T10:00:00Z",
    "last year",
    "next month",
    "recently",
    "Q3 2025",
    "",
  ])("drops %j (not a date at any of the four precisions)", (raw) => {
    expect(parseEventDate(raw)).toBeNull();
  });

  it("drops anything that is not a string", () => {
    for (const v of [undefined, null, 2025, {}, ["2025"], true])
      expect(parseEventDate(v)).toBeNull();
  });
});

describe("isStoredAt", () => {
  it.each<[string, DatePrecision, boolean]>([
    ["2025-07-01", "quarter", true],
    ["2025-08-01", "quarter", false],
    ["2025-07-02", "quarter", false],
    ["2025-01-01", "year", true],
    ["2025-02-01", "year", false],
    ["2025-02-01", "month", true],
    ["2025-02-03", "month", false],
    ["2025-02-28", "day", true],
    ["2025-02-30", "day", false],
    ["0999-01-01", "year", false],
    ["2025-1-1", "day", false],
    ["2025-01", "month", false],
  ])("%s at %s precision is %s", (at, precision, ok) => {
    expect(isStoredAt(at, precision)).toBe(ok);
  });
});
```

Create `apps/server/app/flows/visualize-document/structureText.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { cleanText, earliestPassage, isRecord, nameKey } from "./structureText";

describe("cleanText", () => {
  it("turns control characters and line breaks into one space and drops invisible format characters", () => {
    expect(cleanText("A\u0000B", 80)).toBe("A B");
    expect(cleanText("  x \n\t y  ", 80)).toBe("x y");
    expect(cleanText("Ac​me⁠ Corp﻿", 80)).toBe("Acme Corp");
    expect(cleanText("line break here", 80)).toBe("line break here");
  });

  it("clips at the limit, never inside a surrogate pair, and trims after clipping", () => {
    expect(cleanText("abcdef", 3)).toBe("abc");
    expect(cleanText("ab cdef", 3)).toBe("ab");
    expect(cleanText(`${"a".repeat(79)}\u{1F600}`, 80)).toBe("a".repeat(79));
  });

  it("is empty when nothing visible is left", () => {
    expect(cleanText(" ​\u0007 ", 80)).toBe("");
    expect(cleanText("", 80)).toBe("");
  });
});

describe("nameKey", () => {
  it("folds case, width, ligatures and runs of spaces, so spellings of one name collide", () => {
    expect(nameKey("  ACME   Corp ")).toBe("acme corp");
    expect(nameKey("ﬁnance")).toBe("finance");
    expect(nameKey("Ｃｏｒａ")).toBe("cora");
    expect(nameKey("Acme")).not.toBe(nameKey("Acme Corp"));
  });
});

describe("earliestPassage", () => {
  const position = new Map([
    ["aaaa", 0],
    ["bbbb", 1],
    ["cccc", 2],
  ]);
  it("is the cited passage of this document with the lowest position, matched case-insensitively", () => {
    expect(earliestPassage(["cccc", "BBBB", "zzzz", 5], position)).toBe("bbbb");
    expect(earliestPassage(["cccc"], position)).toBe("cccc");
  });
  it("is null when nothing cited belongs to this document, or the field is not a list", () => {
    expect(earliestPassage(["zzzz"], position)).toBeNull();
    expect(earliestPassage([], position)).toBeNull();
    expect(earliestPassage("aaaa", position)).toBeNull();
    expect(earliestPassage(undefined, position)).toBeNull();
  });
});

describe("isRecord", () => {
  it("accepts plain objects only", () => {
    expect(isRecord({})).toBe(true);
    for (const v of [null, [], "x", 1, undefined]) expect(isRecord(v)).toBe(false);
  });
});
```

Create `apps/server/app/flows/visualize-document/timeline.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  MAX_EVENTS,
  MAX_EVENT_LABEL,
  MAX_RAW_ITEMS,
  MAX_WHEN,
  MIN_EVENTS,
  buildTimeline,
  rawEventsOf,
} from "./timeline";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** Five passages of this document, in document order. */
const POS = new Map([1, 2, 3, 4, 5].map((n, i) => [ID(n), i] as const));
const ev = (date: string, label: string, over: Record<string, unknown> = {}) => ({
  when: date,
  date,
  label,
  chunkIds: [ID(1)],
  ...over,
});
const GOOD = [ev("2024-03", "Alpha"), ev("2025-Q3", "Beta"), ev("2026-02-14", "Gamma")];

describe("buildTimeline", () => {
  it("keeps the limits the spec names", () => {
    expect([MAX_EVENTS, MIN_EVENTS, MAX_WHEN, MAX_EVENT_LABEL, MAX_RAW_ITEMS]).toEqual([
      40, 3, 40, 80, 200,
    ]);
  });

  it("orders events by date whatever order the model gave, keeping each precision and what was written", () => {
    const shuffled = [GOOD[2], GOOD[0], GOOD[1]];
    const t = buildTimeline(shuffled, POS);
    expect(t?.kind).toBe("timeline");
    expect(t?.events).toEqual([
      { at: "2024-03-01", precision: "month", when: "2024-03", label: "Alpha", chunkId: ID(1) },
      { at: "2025-07-01", precision: "quarter", when: "2025-Q3", label: "Beta", chunkId: ID(1) },
      { at: "2026-02-14", precision: "day", when: "2026-02-14", label: "Gamma", chunkId: ID(1) },
    ]);
  });

  it("keeps `when` as the document wrote it, clipped to 40, and falls back to the date when it is missing or empty", () => {
    const t = buildTimeline(
      [
        ev("2024-03", "Alpha", { when: "x".repeat(60) }),
        ev("2025-Q3", "Beta", { when: undefined }),
        ev("2026-02-14", "Gamma", { when: "  " }),
      ],
      POS,
    );
    expect(t?.events.map((e) => e.when)).toEqual(["x".repeat(MAX_WHEN), "2025-Q3", "2026-02-14"]);
  });

  it("drops an event whose date is relative, undated or does not parse, and keeps the others", () => {
    const t = buildTimeline(
      [
        ...GOOD,
        ev("last year", "Relative"),
        ev("2025-13", "Bad month"),
        ev("2025-02-30", "Bad day"),
        ev("", "Empty"),
        { when: "soon", label: "No date field", chunkIds: [ID(1)] },
      ],
      POS,
    );
    expect(t?.events.map((e) => e.label)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("drops an event with no usable label, and one that is not an object", () => {
    const t = buildTimeline(
      [...GOOD, ev("2027", " ​ "), ev("2027", ""), ev("2027", "x", { label: 7 }), null, "x", 3],
      POS,
    );
    expect(t?.events.map((e) => e.label)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("strips control characters from labels and clips them to 80", () => {
    const t = buildTimeline(
      [
        ev("2024", "Open\u0000ing\nnight"),
        ev("2025", "y".repeat(120)),
        ev("2026", "Third"),
      ],
      POS,
    );
    expect(t?.events[0]?.label).toBe("Open ing night");
    expect(t?.events[1]?.label).toBe("y".repeat(MAX_EVENT_LABEL));
  });

  it("cites only passages of this document: foreign and missing citations are removed, and an event with none left is dropped", () => {
    const t = buildTimeline(
      [
        ...GOOD,
        ev("2027", "Foreign", { chunkIds: [ID(99)] }),
        ev("2028", "Empty", { chunkIds: [] }),
        ev("2029", "Missing", { chunkIds: undefined }),
        ev("2030", "Mixed", { chunkIds: [ID(99), ID(3)] }),
      ],
      POS,
    );
    expect(t?.events.map((e) => [e.label, e.chunkId])).toEqual([
      ["Alpha", ID(1)],
      ["Beta", ID(1)],
      ["Gamma", ID(1)],
      ["Mixed", ID(3)],
    ]);
  });

  it("cites the earliest-positioned of an event's passages, and lists each passage once in event order", () => {
    const t = buildTimeline(
      [
        ev("2024", "A", { chunkIds: [ID(3), ID(1)] }),
        ev("2025", "B", { chunkIds: [ID(2)] }),
        ev("2026", "C", { chunkIds: [ID(2), ID(4)] }),
      ],
      POS,
    );
    expect(t?.events.map((e) => e.chunkId)).toEqual([ID(1), ID(2), ID(2)]);
    expect(t?.chunkIds).toEqual([ID(1), ID(2)]);
  });

  it("dedupes by date, precision and normalised label, and keeps events that differ in precision", () => {
    const t = buildTimeline(
      [
        ev("2024-03", "Launch"),
        ev("2024-03", "  LAUNCH "),
        ev("2024", "Launch"),
        ev("2024-03-01", "Launch"),
        ev("2025", "Other"),
        ev("2026", "More"),
      ],
      POS,
    );
    expect(t?.events.map((e) => [e.at, e.precision, e.label])).toEqual([
      ["2024-01-01", "year", "Launch"],
      ["2024-03-01", "month", "Launch"],
      ["2024-03-01", "day", "Launch"],
      ["2025-01-01", "year", "Other"],
      ["2026-01-01", "year", "More"],
    ]);
  });

  it("breaks a tie on the date by the first cited passage's position, then by the model's order", () => {
    const t = buildTimeline(
      [
        ev("2024", "Late passage", { chunkIds: [ID(3)] }),
        ev("2024", "Early passage", { chunkIds: [ID(1)] }),
        ev("2024", "Same passage first", { chunkIds: [ID(2)] }),
        ev("2024", "Same passage second", { chunkIds: [ID(2)] }),
      ],
      POS,
    );
    expect(t?.events.map((e) => e.label)).toEqual([
      "Early passage",
      "Same passage first",
      "Same passage second",
      "Late passage",
    ]);
  });

  it("caps at 40 after sorting, so the 40 earliest survive", () => {
    const raw = Array.from({ length: 45 }, (_, i) => ev(String(2045 - i), `Event ${2045 - i}`));
    const t = buildTimeline(raw, POS);
    expect(t?.events).toHaveLength(MAX_EVENTS);
    expect(t?.events[0]?.at).toBe("2001-01-01");
    expect(t?.events.at(-1)?.at).toBe("2040-01-01");
  });

  it("needs at least 3 events after every drop: 3 is a timeline, 2 and 0 are none", () => {
    expect(buildTimeline(GOOD, POS)).not.toBeNull();
    expect(buildTimeline(GOOD.slice(0, 2), POS)).toBeNull();
    expect(buildTimeline([GOOD[0], GOOD[0], GOOD[1], GOOD[2]].slice(0, 3), POS)).toBeNull(); // a duplicate is not a third event
    expect(buildTimeline([], POS)).toBeNull();
  });

  it("reads at most 200 raw items", () => {
    const junk = Array.from({ length: MAX_RAW_ITEMS }, () => null);
    expect(buildTimeline([...junk, ...GOOD], POS)).toBeNull(); // the good ones sit past the bound
  });
});

describe("rawEventsOf", () => {
  it("reads the events list of a timeline field, and nothing from anything else", () => {
    expect(rawEventsOf({ events: [1, 2] })).toEqual([1, 2]);
    for (const v of [undefined, null, "x", [], { events: "x" }, { events: null }, {}])
      expect(rawEventsOf(v)).toEqual([]);
  });
  it("hands over at most 200 items", () => {
    expect(rawEventsOf({ events: Array.from({ length: 500 }, (_, i) => i) })).toHaveLength(200);
  });
});
```

Create `apps/server/app/flows/visualize-document/relations.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  MAX_LINKS,
  MAX_PARTY,
  MAX_REL,
  MIN_LINKS,
  buildRelations,
  rawLinksOf,
} from "./relations";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const POS = new Map([1, 2, 3, 4, 5].map((n, i) => [ID(n), i] as const));
const link = (from: string, rel: string, to: string, over: Record<string, unknown> = {}) => ({
  from,
  rel,
  to,
  chunkIds: [ID(1)],
  ...over,
});
const GOOD = [
  link("Acme", "acquired", "Beta Corp"),
  link("Cora", "leads", "Project X"),
  link("Acme", "owns", "Project X"),
];

describe("buildRelations", () => {
  it("keeps the limits the spec names", () => {
    expect([MAX_LINKS, MIN_LINKS, MAX_PARTY, MAX_REL]).toEqual([30, 3, 80, 40]);
  });

  it("lists each party once in order of first appearance and joins links by index, directed from to to", () => {
    const r = buildRelations(GOOD, POS);
    expect(r?.entities).toEqual(["Acme", "Beta Corp", "Cora", "Project X"]);
    expect(r?.links).toEqual([
      { from: 0, to: 1, rel: "acquired", chunkId: ID(1) },
      { from: 2, to: 3, rel: "leads", chunkId: ID(1) },
      { from: 0, to: 3, rel: "owns", chunkId: ID(1) },
    ]);
  });

  it("dedupes parties by normalised name and keeps the first spelling", () => {
    const r = buildRelations(
      [
        link("Acme Corp", "acquired", "Beta"),
        link("  ACME   corp ", "owns", "Gamma"),
        link("Beta", "supplies", "ACME CORP"),
      ],
      POS,
    );
    expect(r?.entities).toEqual(["Acme Corp", "Beta", "Gamma"]);
    expect(r?.links.map((l) => [l.from, l.to])).toEqual([
      [0, 1],
      [0, 2],
      [1, 0],
    ]);
  });

  it("drops a self-link (the same normalised endpoints) but keeps a link between two spellings of different parties", () => {
    const r = buildRelations(
      [...GOOD, link("Acme", "is", " acme "), link("Acme", "is", "Acme Inc")],
      POS,
    );
    expect(r?.links).toHaveLength(4);
    expect(r?.entities).toEqual(["Acme", "Beta Corp", "Cora", "Project X", "Acme Inc"]);
  });

  it("dedupes by from, rel and to, normalised, but keeps another relation between the same pair and the reverse direction", () => {
    const r = buildRelations(
      [
        link("Acme", "acquired", "Beta"),
        link(" ACME ", "Acquired", "beta"),
        link("Acme", "owns", "Beta"),
        link("Beta", "acquired", "Acme"),
      ],
      POS,
    );
    expect(r?.links.map((l) => [l.from, l.rel, l.to])).toEqual([
      [0, "acquired", 1],
      [0, "owns", 1],
      [1, "acquired", 0],
    ]);
  });

  it("clips parties to 80 and the relation to 40, and strips control characters", () => {
    const r = buildRelations(
      [
        link("p".repeat(120), "r".repeat(70), "Q\u0000uark"),
        link("Quark", "x\ny", "Third"),
        link("Third", "ok", "Fourth"),
      ],
      POS,
    );
    expect(r?.entities[0]).toBe("p".repeat(MAX_PARTY));
    expect(r?.links[0]?.rel).toBe("r".repeat(MAX_REL));
    expect(r?.entities[1]).toBe("Q uark");
    expect(r?.links[1]?.rel).toBe("x y");
  });

  it("drops a link with an empty or non-string endpoint or relation, and one that is not an object", () => {
    const r = buildRelations(
      [
        ...GOOD,
        link("", "r", "B"),
        link("A", " ​", "B"),
        link("A", "r", ""),
        { from: 1, rel: "r", to: "B", chunkIds: [ID(1)] },
        null,
        "x",
      ],
      POS,
    );
    expect(r?.links).toHaveLength(3);
  });

  it("cites only passages of this document and drops a link with none left; the cited passage is the earliest", () => {
    const r = buildRelations(
      [
        link("A", "r", "B", { chunkIds: [ID(4), ID(2)] }),
        link("B", "r", "C", { chunkIds: [ID(99)] }),
        link("C", "r", "D", { chunkIds: [] }),
        link("D", "r", "E", { chunkIds: undefined }),
        link("E", "r", "F", { chunkIds: [ID(99), ID(5)] }),
        link("F", "r", "G", { chunkIds: [ID(3)] }),
      ],
      POS,
    );
    expect(r?.links.map((l) => l.chunkId)).toEqual([ID(2), ID(5), ID(3)]);
    expect(r?.chunkIds).toEqual([ID(2), ID(5), ID(3)]);
    expect(r?.entities).toEqual(["A", "B", "E", "F", "G"]); // parties of dropped links are not listed
  });

  it("caps at 30 links in the model's order, and a capped fact never lists more than 60 parties", () => {
    const raw = Array.from({ length: 40 }, (_, i) => link(`From ${i}`, "to", `To ${i}`));
    const r = buildRelations(raw, POS);
    expect(r?.links).toHaveLength(MAX_LINKS);
    expect(r?.links.at(-1)).toEqual({ from: 58, to: 59, rel: "to", chunkId: ID(1) });
    expect(r?.entities).toHaveLength(60);
    expect(r?.entities.at(-1)).toBe("To 29");
  });

  it("needs at least 3 links after every drop: 3 is a fact, 2 and 0 are none", () => {
    expect(buildRelations(GOOD, POS)).not.toBeNull();
    expect(buildRelations(GOOD.slice(0, 2), POS)).toBeNull();
    expect(buildRelations([GOOD[0], GOOD[0], GOOD[1]], POS)).toBeNull();
    expect(buildRelations([], POS)).toBeNull();
  });
});

describe("rawLinksOf", () => {
  it("reads the links list of a relations field, and nothing from anything else", () => {
    expect(rawLinksOf({ links: [1, 2] })).toEqual([1, 2]);
    for (const v of [undefined, null, "x", [], { links: "x" }, {}]) expect(rawLinksOf(v)).toEqual([]);
  });
  it("hands over at most 200 items", () => {
    expect(rawLinksOf({ links: Array.from({ length: 500 }, (_, i) => i) })).toHaveLength(200);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/visualize-document/dates.test.ts app/flows/visualize-document/structureText.test.ts app/flows/visualize-document/timeline.test.ts app/flows/visualize-document/relations.test.ts`
Expected: FAIL (the modules `./dates`, `./timeline`, `./relations` and the new `structureText` exports do not exist).

- [ ] **Step 3: Write the implementation**

Create `apps/server/app/flows/visualize-document/dates.ts`:

```ts
/** How exactly a document wrote a date. The stored event keeps the first day of the period at that precision. */
export const DATE_PRECISIONS = ["day", "month", "quarter", "year"] as const;
export type DatePrecision = (typeof DATE_PRECISIONS)[number];

export interface EventDate {
  /** The ISO first day of the period: `YYYY-MM-DD`. */
  at: string;
  precision: DatePrecision;
}

const MIN_YEAR = 1000;
const MAX_YEAR = 9999;
const YEAR = /^(\d{4})$/;
const QUARTER = /^(\d{4})-Q([1-4])$/;
const MONTH = /^(\d{4})-(\d{2})$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad = (n: number) => String(n).padStart(2, "0");
const yearOk = (y: number) => y >= MIN_YEAR && y <= MAX_YEAR;
/** The last day of `month` (1 to 12) of `year`: day 0 of the next month, so leap years come out right. */
const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * A model's `date` field at its precision: `YYYY`, `YYYY-Qn`, `YYYY-MM` or `YYYY-MM-DD` (surrounding space ignored, a quarter
 * written with a capital Q). Anything else, or a date that does not exist, is null: a relative or undated phrase is dropped,
 * never repaired. Pure; the input is never echoed.
 */
export function parseEventDate(raw: unknown): EventDate | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  const year = YEAR.exec(s);
  if (year) return yearOk(Number(year[1])) ? { at: `${year[1]}-01-01`, precision: "year" } : null;
  const quarter = QUARTER.exec(s);
  if (quarter) {
    if (!yearOk(Number(quarter[1]))) return null;
    return { at: `${quarter[1]}-${pad((Number(quarter[2]) - 1) * 3 + 1)}-01`, precision: "quarter" };
  }
  const month = MONTH.exec(s);
  if (month) {
    const m = Number(month[2]);
    return yearOk(Number(month[1])) && m >= 1 && m <= 12
      ? { at: `${month[1]}-${month[2]}-01`, precision: "month" }
      : null;
  }
  const day = DAY.exec(s);
  if (day) {
    const [y, m, d] = [Number(day[1]), Number(day[2]), Number(day[3])];
    return yearOk(y) && m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m)
      ? { at: s, precision: "day" }
      : null;
  }
  return null;
}

/** True when `at` is a real `YYYY-MM-DD` that is the first day of a period of `precision` (what `parseEventDate` stores). */
export function isStoredAt(at: string, precision: DatePrecision): boolean {
  const m = DAY.exec(at);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!yearOk(y) || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return false;
  switch (precision) {
    case "day":
      return true;
    case "month":
      return d === 1;
    case "quarter":
      return d === 1 && mo % 3 === 1;
    case "year":
      return d === 1 && mo === 1;
  }
}
```

Append to `apps/server/app/flows/visualize-document/structureText.ts` (after the existing `clipLabel`; the file already imports `clipText`):

```ts
/** The most raw items of one answer (merged over windows) a normaliser reads: a runaway answer costs a bounded scan. */
export const MAX_RAW_ITEMS = 200;

/** A plain object (not null, not a list): the shape every untrusted model item is checked for first. */
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Untrusted model text as a short label: control characters and line breaks become one space, invisible format characters
 * (zero-width, BOM, word joiner) are dropped, runs of space collapse, then it is trimmed and clipped to `max` UTF-16 units
 * (never inside a surrogate pair). "" when nothing visible is left.
 */
export const cleanText = (raw: string, max: number): string =>
  clipText(
    raw
      .replace(/[\p{Cc}  ]/gu, " ")
      .replace(/\p{Cf}/gu, "")
      .replace(/\s+/g, " ")
      .trim(),
    max,
  ).trimEnd();

/** What two spellings of one name share: NFKC, lower case, one inner space. The dedupe key of events, links and parties. */
export const nameKey = (raw: string): string =>
  raw.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/**
 * The passage of this document an item cites that comes first in the document, or null when none of its `ids` is one of the
 * document's passages. `position` maps each passage id (lower case) to its index in passage order, so its keys are exactly
 * "the passages of this document". Ids are matched case-insensitively; anything that is not a string is ignored.
 */
export function earliestPassage(
  ids: unknown,
  position: ReadonlyMap<string, number>,
): string | null {
  if (!Array.isArray(ids)) return null;
  let best: string | null = null;
  for (const raw of ids) {
    if (typeof raw !== "string") continue;
    const id = raw.toLowerCase();
    const at = position.get(id);
    if (at === undefined) continue;
    if (best === null || at < (position.get(best) as number)) best = id;
  }
  return best;
}
```

Create `apps/server/app/flows/visualize-document/timeline.ts`:

```ts
import { type DatePrecision, parseEventDate } from "./dates";
import {
  MAX_RAW_ITEMS,
  cleanText,
  earliestPassage,
  isRecord,
  nameKey,
} from "./structureText";

export { MAX_RAW_ITEMS };
export const MAX_EVENTS = 40;
export const MIN_EVENTS = 3;
/** `when` is the date as the document wrote it. */
export const MAX_WHEN = 40;
export const MAX_EVENT_LABEL = 80;

export interface TimelineEvent {
  /** The ISO first day of the event's period. */
  at: string;
  precision: DatePrecision;
  /** The date as written, at most 40 characters. */
  when: string;
  label: string;
  /** The earliest passage of this document the event cites. */
  chunkId: string;
}
export interface TimelineDraft {
  kind: "timeline";
  events: TimelineEvent[];
  /** The distinct `chunkId`s in event order. */
  chunkIds: string[];
}

/** The raw events of the answer's `timeline` field: its `events` list when it is one, at most 200 items; else none. */
export const rawEventsOf = (field: unknown): unknown[] =>
  isRecord(field) && Array.isArray(field.events) ? field.events.slice(0, MAX_RAW_ITEMS) : [];

/**
 * The timeline of a document from the model's raw events, or null (no timeline). Every bad item is dropped on its own:
 * a `date` that is not a real date at one of the four precisions, an empty label, no cited passage of this document.
 * Survivors are deduped by (`at`, `precision`, normalised label), sorted by `at`, then by the position of the cited passage,
 * then by the model's order, and capped at 40 (the earliest). Fewer than 3 survivors is no timeline. Never throws, never
 * echoes an item. `position` maps this document's passage ids (lower case) to their index in passage order.
 */
export function buildTimeline(
  raw: readonly unknown[],
  position: ReadonlyMap<string, number>,
): TimelineDraft | null {
  const seen = new Set<string>();
  const kept: { event: TimelineEvent; at: number; order: number }[] = [];
  raw.slice(0, MAX_RAW_ITEMS).forEach((item, order) => {
    if (!isRecord(item)) return;
    const date = parseEventDate(item.date);
    const label = typeof item.label === "string" ? cleanText(item.label, MAX_EVENT_LABEL) : "";
    const chunkId = earliestPassage(item.chunkIds, position);
    if (date === null || label === "" || chunkId === null) return;
    const key = `${date.at}|${date.precision}|${nameKey(label)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const written = typeof item.when === "string" ? cleanText(item.when, MAX_WHEN) : "";
    kept.push({
      event: {
        at: date.at,
        precision: date.precision,
        when: written === "" ? String(item.date).trim() : written,
        label,
        chunkId,
      },
      at: position.get(chunkId) as number,
      order,
    });
  });
  kept.sort(
    (a, b) =>
      (a.event.at < b.event.at ? -1 : a.event.at > b.event.at ? 1 : 0) ||
      a.at - b.at ||
      a.order - b.order,
  );
  const events = kept.slice(0, MAX_EVENTS).map((k) => k.event);
  if (events.length < MIN_EVENTS) return null;
  return { kind: "timeline", events, chunkIds: [...new Set(events.map((e) => e.chunkId))] };
}
```

Create `apps/server/app/flows/visualize-document/relations.ts`:

```ts
import {
  MAX_RAW_ITEMS,
  cleanText,
  earliestPassage,
  isRecord,
  nameKey,
} from "./structureText";

export const MAX_LINKS = 30;
export const MIN_LINKS = 3;
/** The longest party name; at most 30 links name at most 60 parties. */
export const MAX_PARTY = 80;
export const MAX_REL = 40;

export interface RelationLink {
  /** Indexes into `RelationsDraft.entities`; the link is directed from to to. */
  from: number;
  to: number;
  rel: string;
  chunkId: string;
}
export interface RelationsDraft {
  kind: "relations";
  /** The parties, distinct by normalised name, in order of first appearance. */
  entities: string[];
  links: RelationLink[];
  /** The distinct `chunkId`s in link order. */
  chunkIds: string[];
}

/** The raw links of the answer's `relations` field: its `links` list when it is one, at most 200 items; else none. */
export const rawLinksOf = (field: unknown): unknown[] =>
  isRecord(field) && Array.isArray(field.links) ? field.links.slice(0, MAX_RAW_ITEMS) : [];

/**
 * The relationships of a document from the model's raw links, or null (no relations). Every bad item is dropped on its
 * own: an empty or non-text party or relation, a self-link (the same normalised endpoints), no cited passage of this
 * document, a repeat of (from, rel, to) once normalised. The first 30 survivors in the model's order are kept; parties are
 * listed once each, in order of first appearance, by normalised name (the first spelling is shown). Fewer than 3 links is
 * no relations. Never throws, never echoes an item. `position` maps this document's passage ids (lower case) to their index.
 */
export function buildRelations(
  raw: readonly unknown[],
  position: ReadonlyMap<string, number>,
): RelationsDraft | null {
  const entities: string[] = [];
  const indexOf = new Map<string, number>();
  const seen = new Set<string>();
  const links: RelationLink[] = [];
  const partyIndex = (name: string, key: string): number => {
    const known = indexOf.get(key);
    if (known !== undefined) return known;
    entities.push(name);
    indexOf.set(key, entities.length - 1);
    return entities.length - 1;
  };
  for (const item of raw.slice(0, MAX_RAW_ITEMS)) {
    if (links.length >= MAX_LINKS) break;
    if (!isRecord(item)) continue;
    const from = typeof item.from === "string" ? cleanText(item.from, MAX_PARTY) : "";
    const to = typeof item.to === "string" ? cleanText(item.to, MAX_PARTY) : "";
    const rel = typeof item.rel === "string" ? cleanText(item.rel, MAX_REL) : "";
    const chunkId = earliestPassage(item.chunkIds, position);
    if (from === "" || to === "" || rel === "" || chunkId === null) continue;
    const [fromKey, toKey] = [nameKey(from), nameKey(to)];
    if (fromKey === toKey) continue;
    const key = `${fromKey}|${nameKey(rel)}|${toKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ from: partyIndex(from, fromKey), to: partyIndex(to, toKey), rel, chunkId });
  }
  if (links.length < MIN_LINKS) return null;
  return {
    kind: "relations",
    entities,
    links,
    chunkIds: [...new Set(links.map((l) => l.chunkId))],
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/visualize-document/dates.test.ts app/flows/visualize-document/structureText.test.ts app/flows/visualize-document/timeline.test.ts app/flows/visualize-document/relations.test.ts`
Expected: PASS (all four files).

- [ ] **Step 5: Typecheck and lint, then commit**

Run: `pnpm typecheck && pnpm typecheck:tests && pnpm lint`
Expected: clean. If biome orders imports differently (`relations.ts` imports `./timeline` before `./structureText`), run `pnpm exec biome check --write apps/server/app/flows/visualize-document` and re-run.

```bash
git add apps/server/app/flows/visualize-document/dates.ts apps/server/app/flows/visualize-document/dates.test.ts apps/server/app/flows/visualize-document/structureText.ts apps/server/app/flows/visualize-document/structureText.test.ts apps/server/app/flows/visualize-document/timeline.ts apps/server/app/flows/visualize-document/timeline.test.ts apps/server/app/flows/visualize-document/relations.ts apps/server/app/flows/visualize-document/relations.test.ts
git commit -m "feat(visuals): c2 date, text and aggregate normalisers (timeline events, relation links)"
```


---

### Task 2: Aggregate fact kinds, migration 0037 and the ownership of ordinals

**Files:**
- Create: `infra/migrations/0037_visual_facts_aggregate_kinds.sql` (the three CHECKs and the `documents.visual_extract_format` column)
- Modify: `apps/server/app/flows/visualize-document/facts.ts`
- Modify: `apps/server/app/flows/visualize-document/pgFacts.ts`
- Modify: `apps/server/app/flows/visualize-document/testing.ts` (the `aggregateFacts` fixture)
- Modify: `apps/server/app/flows/visualize-document/plan.ts` (a comment only)
- Test: `apps/server/app/flows/visualize-document/facts.test.ts`, `pgFacts.pg.test.ts`, `plan.test.ts`
- Modify (compile only, new store method): the fake stores of `flow.test.ts`, `recovery.test.ts`, `rollout.pg.test.ts` (step 8)

**Interfaces:**
- Consumes: `TimelineDraft`, `RelationsDraft`, `DATE_PRECISIONS`, `isStoredAt`, `nameKey` (Task 1).
- Produces (Tasks 3 to 6 rely on these exact names):
  - `facts.ts`: `STRUCTURE_ORDINAL_BASE = 16` (existing), `AGGREGATE_ORDINAL_BASE = 18`, `TIMELINE_ORDINAL = 18`, `RELATIONS_ORDINAL = 19`, `MAX_STORED_FACTS = MAX_FACTS + 4` (20), `EXTRACT_FORMAT = "docmind.extract@2"`; `type AggregateFact = (TimelineDraft | RelationsDraft) & { ordinal: number }`; `type ExtractionWrite = Fact | AggregateFact`; `type AnyFact = Fact | StructureFact | AggregateFact`; `isAggregateFact(f: { kind: string }): f is AggregateFact`; `DocumentAnswer` (zod: `{ facts: DraftFact[] (max 32), timeline?: unknown, relations?: unknown }`, strict); `StoredEntry` now also parses `timeline` at ordinal 18 and `relations` at ordinal 19 (each kind at its own ordinal, outline only at 16 and cooccurrence only at 17); `StoredFact` is unchanged (extracted kinds, 0..15).
  - `pgFacts.ts`: `VisualFactStore.replace(ref: VisualizeRef, facts: readonly ExtractionWrite[], signal?: AbortSignal, generation?: number): Promise<number>` (owns 0..15 and 18..19), `replaceStructure` (owns 16..17, unchanged signature), `list` (extracted only, `ordinal < 16`, unchanged), `listAll` (everything), new `aggregateCount(ref: VisualizeRef): Promise<number>` (rows at ordinal >= 18, owner-scoped, nothing decrypted), and new `extractFormat(ref: VisualizeRef): Promise<string | null>` (the document's `visual_extract_format`, NULL when never stamped); `replace` also stamps `documents.visual_extract_format = EXTRACT_FORMAT` in its transaction (nothing else does).
  - `testing.ts`: `aggregateFacts(chunk: string): { timeline: AggregateFact; relations: AggregateFact }`, a valid 3-event timeline (ordinal 18) and 3-link, 3-party relations fact (ordinal 19), every text starting `Zebra-`.
  - Migration `0037`: constraints `visual_facts_kind_check`, `visual_facts_ordinal_check` (0..19) and `visual_facts_kind_ordinal_check` replaced under the same names; `documents.visual_extract_format text NULL`.

- [ ] **Step 1: Write the failing tests**

In `apps/server/app/flows/visualize-document/facts.test.ts`:

1. Extend the existing import from `./facts` with `AGGREGATE_ORDINAL_BASE`, `DocumentAnswer`, `RELATIONS_ORDINAL`, `STRUCTURE_ORDINAL_BASE`, `TIMELINE_ORDINAL` and `isAggregateFact` (keep the rest), and add `import { buildRelations } from "./relations";` and `import { buildTimeline } from "./timeline";` beside `import { buildOutline } from "./outline";`.
2. In the existing test "reserves ordinals 16 and 17 above the 16 extracted ones" change the last line to `expect(MAX_STORED_FACTS).toBe(MAX_FACTS + 4);` (extracted, outline, entity map, timeline, relations).
3. Append this block:

```ts
describe("aggregate facts (timeline at 18, relations at 19)", () => {
  const cid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const position = new Map([1, 2, 3].map((n, i) => [cid(n), i] as const));
  const builtTimeline = buildTimeline(
    [
      { when: "March 2024", date: "2024-03", label: "Alpha", chunkIds: [cid(1)] },
      { when: "Q3 2025", date: "2025-Q3", label: "Beta", chunkIds: [cid(2)] },
      { when: "14 Feb 2026", date: "2026-02-14", label: "Gamma", chunkIds: [cid(3)] },
    ],
    position,
  );
  const builtRelations = buildRelations(
    [
      { from: "Acme", rel: "acquired", to: "Beta Corp", chunkIds: [cid(1)] },
      { from: "Cora", rel: "leads", to: "Project X", chunkIds: [cid(2)] },
      { from: "Acme", rel: "owns", to: "Project X", chunkIds: [cid(3)] },
    ],
    position,
  );
  const TIMELINE = builtTimeline as NonNullable<typeof builtTimeline>;
  const RELATIONS = builtRelations as NonNullable<typeof builtRelations>;
  const T = { ...TIMELINE, ordinal: TIMELINE_ORDINAL };
  const R = { ...RELATIONS, ordinal: RELATIONS_ORDINAL };
  const FIGURE = { kind: "figure", label: "x", value: 1, chunkIds: [cid(1)] } as const;

  it("reserves 18 and 19 above the structure ordinals and sizes a document's rows", () => {
    expect([STRUCTURE_ORDINAL_BASE, AGGREGATE_ORDINAL_BASE, TIMELINE_ORDINAL, RELATIONS_ORDINAL]).toEqual([
      16, 18, 18, 19,
    ]);
    // 16 extracted + outline + entity map + timeline + relations
    expect(MAX_STORED_FACTS).toBe(MAX_FACTS + 4);
    expect(MAX_STORED_FACTS).toBe(RELATIONS_ORDINAL + 1);
  });

  it("the built facts parse as stored facts, and are aggregate facts", () => {
    expect(builtTimeline).not.toBeNull();
    expect(builtRelations).not.toBeNull();
    const t = StoredEntry.parse(T);
    const r = StoredEntry.parse(R);
    expect(isAggregateFact(t) && isAggregateFact(r)).toBe(true);
    expect(isAggregateFact(StoredEntry.parse({ ...FIGURE, ordinal: 0 }))).toBe(false);
    expect(isStructureFact(t) || isStructureFact(r)).toBe(false);
  });

  it("pins every kind to its own ordinal (no schema stops at 15)", () => {
    const ok = (f: object) => StoredEntry.safeParse(f).success;
    expect(ok(T)).toBe(true);
    expect(ok(R)).toBe(true);
    for (const wrong of [0, 15, 16, 17, 19, 20]) expect(ok({ ...T, ordinal: wrong }), `timeline@${wrong}`).toBe(false);
    for (const wrong of [0, 15, 16, 17, 18, 20]) expect(ok({ ...R, ordinal: wrong }), `relations@${wrong}`).toBe(false);
    expect(ok({ ...FIGURE, ordinal: 15 })).toBe(true);
    for (const wrong of [16, 17, 18, 19]) expect(ok({ ...FIGURE, ordinal: wrong }), `figure@${wrong}`).toBe(false);
    // c1's structure kinds are tightened the same way: the outline only at 16, the entity map only at 17.
    const outline = buildOutline("Report", [
      { chunkId: cid(1), sectionOrdinal: 1, headingPath: ["A"] },
      { chunkId: cid(2), sectionOrdinal: 2, headingPath: ["B"] },
      { chunkId: cid(3), sectionOrdinal: 3, headingPath: ["C"] },
    ]) as NonNullable<ReturnType<typeof buildOutline>>;
    expect(ok({ ...outline, ordinal: OUTLINE_ORDINAL })).toBe(true);
    expect(ok({ ...outline, ordinal: ENTITY_MAP_ORDINAL })).toBe(false);
    // chat reads StoredFact: extracted kinds only
    expect(StoredFact.safeParse(T).success).toBe(false);
    expect(StoredFact.safeParse({ ...T, ordinal: 15 }).success).toBe(false);
  });

  it("refuses an unknown key, too few events or links, over-long text and a missing citation", () => {
    const t = (over: object) => StoredEntry.safeParse({ ...T, ...over }).success;
    const r = (over: object) => StoredEntry.safeParse({ ...R, ...over }).success;
    const e0 = T.events[0] as (typeof T.events)[number];
    expect(t({})).toBe(true); // the control
    expect(t({ extra: 1 })).toBe(false);
    expect(t({ events: T.events.slice(0, 2) })).toBe(false);
    expect(t({ events: [{ ...e0, label: "x".repeat(81) }, ...T.events.slice(1)] })).toBe(false);
    expect(t({ events: [{ ...e0, when: "w".repeat(41) }, ...T.events.slice(1)] })).toBe(false);
    expect(t({ events: [{ ...e0, when: "" }, ...T.events.slice(1)] })).toBe(false);
    expect(t({ events: [{ ...e0, chunkId: "nope" }, ...T.events.slice(1)] })).toBe(false);
    expect(t({ chunkIds: [] })).toBe(false);
    const l0 = R.links[0] as (typeof R.links)[number];
    expect(r({})).toBe(true);
    expect(r({ extra: 1 })).toBe(false);
    expect(r({ links: R.links.slice(0, 2) })).toBe(false);
    expect(r({ links: [{ ...l0, rel: "r".repeat(41) }, ...R.links.slice(1)] })).toBe(false);
    expect(r({ links: [{ ...l0, rel: "" }, ...R.links.slice(1)] })).toBe(false);
    expect(r({ entities: ["only one"] })).toBe(false);
    expect(r({ chunkIds: [] })).toBe(false);
  });

  it("refuses an event date that is not real at its precision", () => {
    const t = (event: object) =>
      StoredEntry.safeParse({ ...T, events: [event, ...T.events.slice(1)] }).success;
    const e0 = T.events[0] as (typeof T.events)[number];
    expect(t(e0)).toBe(true);
    expect(t({ ...e0, at: "2025-02-30", precision: "day" })).toBe(false);
    expect(t({ ...e0, at: "2025-08-01", precision: "quarter" })).toBe(false);
    expect(t({ ...e0, at: "2025-03-02", precision: "month" })).toBe(false);
    expect(t({ ...e0, at: "2025-02-01", precision: "year" })).toBe(false);
    expect(t({ ...e0, at: "2025-07-01", precision: "decade" })).toBe(false);
    expect(t({ ...e0, at: "0999-01-01", precision: "year" })).toBe(false);
  });

  it("refuses a link that joins a party to itself or to one that is not listed, and repeated party names", () => {
    const r = (over: object) => StoredEntry.safeParse({ ...R, ...over }).success;
    const l0 = R.links[0] as (typeof R.links)[number];
    const rest = R.links.slice(1);
    expect(r({ links: [l0, ...rest] })).toBe(true);
    expect(r({ links: [{ ...l0, from: 1, to: 1 }, ...rest] })).toBe(false);
    expect(r({ links: [{ ...l0, to: R.entities.length }, ...rest] })).toBe(false);
    expect(r({ links: [{ ...l0, from: R.entities.length }, ...rest] })).toBe(false);
    expect(r({ entities: ["Acme", " ACME ", "Cora", "Project X"] })).toBe(false);
  });
});

describe("DocumentAnswer", () => {
  it("keeps the aggregates unparsed so a bad one never costs the facts, but still refuses a bad fact or an unknown key", () => {
    expect(
      DocumentAnswer.safeParse({ facts: [], timeline: "nope", relations: [1, 2] }).success,
    ).toBe(true);
    expect(DocumentAnswer.safeParse({ facts: [] }).success).toBe(true);
    expect(DocumentAnswer.safeParse({ facts: [], timeline: null }).success).toBe(true);
    expect(DocumentAnswer.safeParse({ facts: [{ kind: "figure" }] }).success).toBe(false);
    expect(DocumentAnswer.safeParse({ facts: [], extra: 1 }).success).toBe(false);
    expect(DocumentAnswer.safeParse({ timeline: { events: [] } }).success).toBe(false);
  });
});
```

In `apps/server/app/flows/visualize-document/plan.test.ts`: extend the import from `./facts` to `import { ENTITY_MAP_ORDINAL, type Fact, MAX_FACTS, MAX_STORED_FACTS, OUTLINE_ORDINAL, type StructureFact } from "./facts";`, change `import { recording, scriptedPlannerModel } from "./testing";` to `import { aggregateFacts, recording, scriptedPlannerModel } from "./testing";`, and append:

```ts
describe("LoadOutput.facts holds every row a document can have", () => {
  const chunk = randomUUID();
  const figures = Array.from({ length: MAX_FACTS }, (_, ordinal) => ({
    kind: "figure" as const,
    label: `Figure ${ordinal}`,
    value: ordinal,
    chunkIds: [chunk],
    ordinal,
  }));
  const outline = {
    kind: "outline" as const,
    title: "Report",
    nodes: ["A", "B", "C"].map((label, i) => ({
      id: `s${i}`,
      label,
      level: 1,
      passageCount: 1,
      firstChunkId: chunk,
    })),
    chunkIds: [chunk],
    ordinal: OUTLINE_ORDINAL,
  };
  const map = {
    kind: "cooccurrence" as const,
    entities: ["P1", "P2", "P3"].map((name) => ({
      name,
      entityKind: "person" as const,
      passages: 2,
    })),
    edges: [
      { a: 0, b: 1, weight: 2, firstChunkId: chunk },
      { a: 1, b: 2, weight: 2, firstChunkId: chunk },
    ],
    chunkIds: [chunk],
    ordinal: ENTITY_MAP_ORDINAL,
  };
  const { timeline, relations } = aggregateFacts(chunk);
  const all = [...figures, outline, map, timeline, relations];

  it("accepts 20 rows (16 extracted, outline, entity map, timeline, relations) and refuses a 21st", () => {
    expect(all).toHaveLength(MAX_STORED_FACTS);
    expect(all.map((f) => f.ordinal)).toEqual(Array.from({ length: 20 }, (_, i) => i)); // the control: ordinals really span 0..19
    expect(LoadOutput.safeParse({ outcome: "done", facts: all }).success).toBe(true);
    expect(LoadOutput.safeParse({ outcome: "done", facts: [...all, figures[0]] }).success).toBe(
      false,
    );
  });
});
```

In `apps/server/app/flows/visualize-document/pgFacts.pg.test.ts`:

1. Add `import { aggregateFacts } from "./testing";` and extend the `./facts` import with `EXTRACT_FORMAT` and `type ExtractionWrite`.
2. Edit the existing 0035 test: change `await expect(insert("diagram", 3)).rejects.toThrow(/visual_facts_kind_check/);` to `await expect(insert("diagram", 3)).rejects.toThrow(/visual_facts_kind_(ordinal_)?check/);` (0037's rule also names a kind it does not know, and Postgres reports one failing constraint). Edit the existing "refuses a fact outside the writer's ordinal range" test: its first expectation becomes `await expect(store.replace(ref, [fig(16, chunk)])).rejects.toThrow(/extraction writes ordinals/);`.
3. Append inside the `describe.skipIf(!PG_URL)` block:

```ts
  it("migration 0037 admits each aggregate kind at its own ordinal only, pins every kind to its own ordinal, and keeps the constraint names", async () => {
    const ref = await fx.doc("c0".repeat(32));
    const chunk = await seedChunk(ref);
    const insert = (kind: string, ordinal: number) =>
      fx.db.owner.query(
        "INSERT INTO visual_facts (id, tenant_id, owner_id, document_id, kind, ordinal, fact_enc, chunk_ids) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, '{}'::jsonb, $6::uuid[])",
        [ref.tenantId, ref.userId, ref.documentId, kind, ordinal, [chunk]],
      );
    await insert("timeline", 18);
    await insert("relations", 19);
    await insert("outline", 16);
    await insert("cooccurrence", 17);
    await insert("series", 0);
    await insert("factTable", 15);
    const pinned = /visual_facts_kind_ordinal_check/;
    await expect(insert("timeline", 3)).rejects.toThrow(pinned);
    await expect(insert("figure", 18)).rejects.toThrow(pinned);
    await expect(insert("figure", 19)).rejects.toThrow(pinned);
    await expect(insert("relations", 18)).rejects.toThrow(pinned);
    await expect(insert("timeline", 19)).rejects.toThrow(pinned);
    await expect(insert("relations", 17)).rejects.toThrow(pinned);
    await expect(insert("outline", 17)).rejects.toThrow(pinned);
    await expect(insert("cooccurrence", 16)).rejects.toThrow(pinned);
    await expect(insert("figure", 20)).rejects.toThrow(/visual_facts_(kind_)?ordinal_check/);
    await expect(insert("timeline", 20)).rejects.toThrow(/visual_facts_(kind_)?ordinal_check/);
    await expect(insert("diagram", 18)).rejects.toThrow(/visual_facts_kind_(ordinal_)?check/);
    const names = await fx.db.owner.query(
      "SELECT conname FROM pg_constraint WHERE conrelid = 'visual_facts'::regclass AND contype = 'c' ORDER BY conname",
    );
    expect(names.rows.map((r) => r.conname)).toEqual([
      "visual_facts_kind_check",
      "visual_facts_kind_ordinal_check",
      "visual_facts_ordinal_check",
    ]);
  });

  it("ownership of ordinals: extraction owns 0..15 and 18..19 together, structure owns 16..17, and a re-plan that skips extraction keeps the aggregates", async () => {
    const ref = await fx.doc("c1".repeat(32));
    const chunk = await seedChunk(ref);
    const store = new PgVisualFacts(fx.app, fx.fields);
    const { timeline, relations } = aggregateFacts(chunk);
    const ordinals = async () => (await store.listAll(ref)).map((f) => f.ordinal);

    expect(await store.replace(ref, [fig(0, chunk), timeline, relations])).toBe(3);
    expect(await ordinals()).toEqual([0, 18, 19]);
    // structure facts land beside them without touching them
    await store.replaceStructure(ref, [outlineFact(chunk), mapFact(chunk)]);
    expect(await ordinals()).toEqual([0, 16, 17, 18, 19]);
    // a re-plan that skips extraction only re-derives structure: 18..19 survive both an empty and a full structure replace
    await store.replaceStructure(ref, []);
    expect(await ordinals()).toEqual([0, 18, 19]);
    await store.replaceStructure(ref, [outlineFact(chunk)]);
    expect(await ordinals()).toEqual([0, 16, 18, 19]);
    // a new extraction with no timeline removes the old one, and keeps the structure facts
    await store.replace(ref, [fig(0, chunk), relations]);
    expect(await ordinals()).toEqual([0, 16, 19]);
    await store.replace(ref, [fig(1, chunk)]);
    expect(await ordinals()).toEqual([1, 16]);
    // an empty extraction (a refusal) clears 0..15 and 18..19 together, never the structure facts
    await store.replace(ref, [fig(2, chunk), timeline, relations]);
    await store.replace(ref, []);
    expect(await ordinals()).toEqual([16]);
  });

  it("list returns the extracted facts only, so chat never sees a timeline or relations fact", async () => {
    const ref = await fx.doc("c2".repeat(32));
    const chunk = await seedChunk(ref);
    const store = new PgVisualFacts(fx.app, fx.fields);
    const { timeline, relations } = aggregateFacts(chunk);
    await store.replace(ref, [fig(0, chunk), timeline, relations]);
    await store.replaceStructure(ref, [outlineFact(chunk)]);
    expect((await store.list(ref)).map((f) => [f.ordinal, f.kind])).toEqual([[0, "figure"]]);
    expect((await store.listAll(ref)).map((f) => f.kind)).toEqual([
      "figure",
      "outline",
      "timeline",
      "relations",
    ]);
  });

  it("refuses an aggregate outside its own ordinal, a fact outside 0..15, and an aggregate that would not read back, writing nothing", async () => {
    const ref = await fx.doc("c3".repeat(32));
    const chunk = await seedChunk(ref);
    const store = new PgVisualFacts(fx.app, fx.fields);
    const { timeline, relations } = aggregateFacts(chunk);
    await store.replace(ref, [fig(0, chunk), timeline]);
    const refused = /extraction writes ordinals/;
    await expect(store.replace(ref, [{ ...timeline, ordinal: 19 }])).rejects.toThrow(refused);
    await expect(store.replace(ref, [{ ...relations, ordinal: 18 }])).rejects.toThrow(refused);
    await expect(store.replace(ref, [fig(17, chunk)])).rejects.toThrow(refused);
    await expect(store.replace(ref, [fig(18, chunk)])).rejects.toThrow(refused);
    const short = { ...timeline, events: (timeline as { events: unknown[] }).events.slice(0, 2) };
    await expect(store.replace(ref, [short as unknown as ExtractionWrite])).rejects.toThrow(
      /unexpected shape/,
    );
    // every refusal left the stored rows as they were
    expect((await store.listAll(ref)).map((f) => f.ordinal)).toEqual([0, 18]);
  });

  it("stores aggregates sealed, with their own column kind, owner-scoped", async () => {
    const ref = await fx.doc("c4".repeat(32));
    const chunk = await seedChunk(ref);
    const store = new PgVisualFacts(fx.app, fx.fields);
    const { timeline, relations } = aggregateFacts(chunk);
    await store.replace(ref, [timeline, relations]);
    const raw = await fx.db.owner.query(
      "SELECT kind, fact_enc::text AS t FROM visual_facts WHERE document_id = $1 ORDER BY ordinal",
      [ref.documentId],
    );
    expect(raw.rows.map((r) => r.kind)).toEqual(["timeline", "relations"]);
    for (const r of raw.rows) {
      expect(r.t).not.toContain("Zebra");
      expect(r.t).not.toContain("acquired");
      expect(r.t).not.toContain("March 2024");
    }
    expect((await store.listAll(ref)).map((f) => f.kind)).toEqual(["timeline", "relations"]);
    await expect(store.replace({ ...ref, userId: U1B }, [])).rejects.toBeInstanceOf(
      DocumentGoneError,
    );
  });

  it("aggregateCount counts this document's timeline and relations rows without opening any fact", async () => {
    const ref = await fx.doc("c5".repeat(32));
    const other = await fx.doc("c6".repeat(32));
    const chunk = await seedChunk(ref);
    const otherChunk = await seedChunk(other);
    const store = new PgVisualFacts(fx.app, fx.fields);
    const { timeline, relations } = aggregateFacts(chunk);
    expect(await store.aggregateCount(ref)).toBe(0);
    await store.replace(ref, [fig(0, chunk), timeline]);
    await store.replace(other, [aggregateFacts(otherChunk).timeline, aggregateFacts(otherChunk).relations]);
    expect(await store.aggregateCount(ref)).toBe(1); // not the figure, not the other document's rows
    await store.replace(ref, [fig(0, chunk), timeline, relations]);
    expect(await store.aggregateCount(ref)).toBe(2);
    await store.replaceStructure(ref, [outlineFact(chunk)]);
    expect(await store.aggregateCount(ref)).toBe(2); // structure facts are not aggregates
    await store.replace(ref, [fig(0, chunk)]);
    expect(await store.aggregateCount(ref)).toBe(0);
    await expect(store.aggregateCount({ ...ref, userId: U1B })).rejects.toBeInstanceOf(
      DocumentGoneError,
    );
  });

  it("a stale ingest generation changes no aggregate (the extraction writer is fenced)", async () => {
    const ref = await fx.doc("c7".repeat(32));
    const chunk = await seedChunk(ref);
    const store = new PgVisualFacts(fx.app, fx.fields);
    const { timeline } = aggregateFacts(chunk);
    await fx.db.owner.query("UPDATE documents SET ingest_generation = 5 WHERE id = $1", [
      ref.documentId,
    ]);
    await store.replace(ref, [timeline], undefined, 5);
    await expect(store.replace(ref, [], undefined, 4)).rejects.toBeInstanceOf(DocumentGoneError);
    expect(await store.aggregateCount(ref)).toBe(1);
  });

  it("the extraction write stamps the document with the extraction format in its own transaction; nothing else does", async () => {
    const ref = await fx.doc("c8".repeat(32));
    const other = await fx.doc("c9".repeat(32));
    const chunk = await seedChunk(ref);
    const store = new PgVisualFacts(fx.app, fx.fields);
    expect(await store.extractFormat(ref)).toBeNull(); // a document extracted before c2: never stamped
    await store.replaceStructure(ref, [outlineFact(chunk)]);
    expect(await store.extractFormat(ref)).toBeNull(); // the structure writer never stamps
    await store.replace(ref, [fig(0, chunk)]);
    expect(await store.extractFormat(ref)).toBe(EXTRACT_FORMAT);
    expect(EXTRACT_FORMAT).toBe("docmind.extract@2");
    expect(await store.extractFormat(other)).toBeNull(); // another document is untouched
    // an extraction that found nothing, or was refused, is still an extraction under this format
    await fx.db.owner.query("UPDATE documents SET visual_extract_format = NULL WHERE id = $1", [ref.documentId]);
    await store.replace(ref, []);
    expect(await store.extractFormat(ref)).toBe(EXTRACT_FORMAT);
    // an older stamp is replaced by the current one
    await fx.db.owner.query("UPDATE documents SET visual_extract_format = 'docmind.extract@1' WHERE id = $1", [ref.documentId]);
    expect(await store.extractFormat(ref)).toBe("docmind.extract@1");
    await store.replace(ref, [fig(0, chunk)]);
    expect(await store.extractFormat(ref)).toBe(EXTRACT_FORMAT);
  });

  it("a refused or superseded extraction write does not stamp, and the stamp is owner-scoped and bounded", async () => {
    const ref = await fx.doc("ca".repeat(32));
    const chunk = await seedChunk(ref);
    const store = new PgVisualFacts(fx.app, fx.fields);
    await expect(store.replace(ref, [fig(17, chunk)])).rejects.toThrow(/extraction writes ordinals/);
    expect(await store.extractFormat(ref)).toBeNull();
    await fx.db.owner.query("UPDATE documents SET ingest_generation = 5 WHERE id = $1", [ref.documentId]);
    await expect(store.replace(ref, [fig(0, chunk)], undefined, 4)).rejects.toBeInstanceOf(DocumentGoneError);
    expect(await store.extractFormat(ref)).toBeNull(); // the stale writer's transaction rolled back, stamp included
    await expect(store.extractFormat({ ...ref, userId: U1B })).rejects.toBeInstanceOf(DocumentGoneError);
    await expect(
      fx.db.owner.query("UPDATE documents SET visual_extract_format = $2 WHERE id = $1", [ref.documentId, "x".repeat(65)]),
    ).rejects.toThrow(/check/i);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/visualize-document/facts.test.ts app/flows/visualize-document/plan.test.ts`
Expected: FAIL (`aggregateFacts`, `DocumentAnswer`, `TIMELINE_ORDINAL` and the rest are not exported yet).

- [ ] **Step 3: Implement `facts.ts`**

Edit `apps/server/app/flows/visualize-document/facts.ts`.

3a. Replace the import block and the constants at the top (everything from `import { z } from "zod";` through `export const MAX_STORED_FACTS = MAX_FACTS + 2;`) with:

```ts
import { z } from "zod";
import { ENTITY_KINDS } from "../../crypto/entityKeys";
import type { CooccurrenceDraft } from "./cooccurrence";
import { DATE_PRECISIONS, isStoredAt } from "./dates";
import type { OutlineDraft } from "./outline";
import type { RelationsDraft } from "./relations";
import { nameKey } from "./structureText";
import type { TimelineDraft } from "./timeline";

export const MAX_FACTS = 16;
/**
 * The ordinal map of `visual_facts` (migration 0037): the extracted facts at 0..15 (`MAX_FACTS`, extraction's own pool), the
 * derived structure facts at 16 (outline) and 17 (entity map), and the model's two aggregates at 18 (timeline) and 19
 * (relations). `PgVisualFacts.replace` (extraction) owns 0..15 and 18..19 together; `replaceStructure` owns 16..17.
 */
export const STRUCTURE_ORDINAL_BASE = 16;
export const OUTLINE_ORDINAL = 16;
export const ENTITY_MAP_ORDINAL = 17;
export const AGGREGATE_ORDINAL_BASE = 18;
export const TIMELINE_ORDINAL = 18;
export const RELATIONS_ORDINAL = 19;
/** The most rows one document holds: the extracted facts, the outline, the entity map, the timeline and the relations. */
export const MAX_STORED_FACTS = MAX_FACTS + 4;
/** The format of the extraction that made a document's facts (its prompt and answer): `PgVisualFacts.replace` stamps it on the document, and a user's re-run extracts again when the stamp is missing or different. Bump it when the extraction's prompt or answer changes in a way existing documents should be re-extracted for. */
export const EXTRACT_FORMAT = "docmind.extract@2";
```

3b. After the `EntityMap` schema (the `const EntityMap = z.object({ ... }).strict();` block that ends just before `export const DraftFact`), insert:

```ts
const Timeline = z
  .object({
    kind: z.literal("timeline"),
    events: z
      .array(
        z
          .object({
            at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            precision: z.enum(DATE_PRECISIONS),
            when: z.string().trim().min(1).max(40),
            label: StructureLabel,
            chunkId: PassageId,
          })
          .strict(),
      )
      .min(3)
      .max(40),
    chunkIds: z.array(PassageId).min(1).max(40),
  })
  .strict();
const PartyIndex = z.number().int().min(0).max(59);
const Relations = z
  .object({
    kind: z.literal("relations"),
    entities: z.array(StructureLabel).min(2).max(60),
    links: z
      .array(
        z
          .object({
            from: PartyIndex,
            to: PartyIndex,
            rel: z.string().trim().min(1).max(40),
            chunkId: PassageId,
          })
          .strict(),
      )
      .min(3)
      .max(30),
    chunkIds: z.array(PassageId).min(1).max(30),
  })
  .strict();
```

3c. Replace everything from the line `/** A derived fact (never extracted by a model): the document's outline or its entity map. */` through the end of the `isStructureFact` declaration (c1's `StructureFact`, `AnyFact`, `StructureOrdinal`, `StoredEntryUnion`, `StoredEntry`, `isStructureFact`) with:

```ts
/** A derived fact (never extracted by a model): the document's outline or its entity map. */
export type StructureFact = (OutlineDraft | CooccurrenceDraft) & { ordinal: number };
/** A fact the extraction call returns beside the charts: the document's timeline or its relationships. */
export type AggregateFact = (TimelineDraft | RelationsDraft) & { ordinal: number };
/** What the extraction write (`PgVisualFacts.replace`) takes: facts at 0..15 and aggregates at 18..19. */
export type ExtractionWrite = Fact | AggregateFact;
/** Everything `visual_facts` holds for a document. */
export type AnyFact = Fact | StructureFact | AggregateFact;
/** A stored row of any kind, each kind at its own ordinal. `StoredFact` (extracted kinds, 0..15) stays what chat reads. */
const StoredEntryUnion = z.discriminatedUnion("kind", [
  Series.extend(Ordinal.shape),
  Figure.extend(Ordinal.shape),
  FactTable.extend(Ordinal.shape),
  Outline.extend({ ordinal: z.literal(OUTLINE_ORDINAL) }),
  EntityMap.extend({ ordinal: z.literal(ENTITY_MAP_ORDINAL) }),
  Timeline.extend({ ordinal: z.literal(TIMELINE_ORDINAL) }),
  Relations.extend({ ordinal: z.literal(RELATIONS_ORDINAL) }),
]);
/** Also enforces what a union member cannot carry as a refinement: a map's edges (`a < b < entities.length`), a timeline's dates (real, at their precision) and a relations fact's parties and links. */
export const StoredEntry = StoredEntryUnion.superRefine((f, ctx) => {
  if (f.kind === "cooccurrence") {
    f.edges.forEach((e, i) => {
      if (e.a >= e.b || e.b >= f.entities.length)
        ctx.addIssue({
          code: "custom",
          path: ["edges", i],
          message: "edge must satisfy a < b < entities.length",
        });
    });
  } else if (f.kind === "timeline") {
    f.events.forEach((e, i) => {
      if (!isStoredAt(e.at, e.precision))
        ctx.addIssue({
          code: "custom",
          path: ["events", i],
          message: "event date must be a real date at its precision",
        });
    });
  } else if (f.kind === "relations") {
    if (new Set(f.entities.map(nameKey)).size !== f.entities.length)
      ctx.addIssue({ code: "custom", path: ["entities"], message: "party names must be distinct" });
    f.links.forEach((l, i) => {
      if (l.from === l.to || l.from >= f.entities.length || l.to >= f.entities.length)
        ctx.addIssue({
          code: "custom",
          path: ["links", i],
          message: "a link joins two different listed parties",
        });
    });
  }
});
export const isStructureFact = (f: { kind: string }): f is StructureFact =>
  f.kind === "outline" || f.kind === "cooccurrence";
export const isAggregateFact = (f: { kind: string }): f is AggregateFact =>
  f.kind === "timeline" || f.kind === "relations";
```

3d. Directly after the existing line `export const ExtractAnswer = z.object({ facts: z.array(DraftFact).max(32) }).strict();` add:

```ts
/**
 * The document extraction's answer: the facts (strict, as always) and two optional aggregates kept UNPARSED here. Each item
 * of `timeline` and `relations` is validated and dropped on its own (`buildTimeline`, `buildRelations`), so a bad one never
 * costs the facts. Chat keeps `ExtractAnswer`.
 */
export const DocumentAnswer = z
  .object({
    facts: z.array(DraftFact).max(32),
    timeline: z.unknown().optional(),
    relations: z.unknown().optional(),
  })
  .strict();
```

Add to `apps/server/app/flows/visualize-document/testing.ts`: extend `import type { Fact } from "./facts";` to `import { type AggregateFact, type Fact, RELATIONS_ORDINAL, TIMELINE_ORDINAL } from "./facts";` and append:

```ts
/** A valid timeline (3 events, ordinal 18) and relations fact (3 parties, 3 links, ordinal 19), all citing `chunk`, every text starting `Zebra-`. */
export function aggregateFacts(chunk: string): { timeline: AggregateFact; relations: AggregateFact } {
  return {
    timeline: {
      kind: "timeline",
      events: [
        { at: "2024-03-01", precision: "month", when: "March 2024", label: "Zebra-Event-One", chunkId: chunk },
        { at: "2025-07-01", precision: "quarter", when: "Q3 2025", label: "Zebra-Event-Two", chunkId: chunk },
        { at: "2026-02-14", precision: "day", when: "14 February 2026", label: "Zebra-Event-Three", chunkId: chunk },
      ],
      chunkIds: [chunk],
      ordinal: TIMELINE_ORDINAL,
    },
    relations: {
      kind: "relations",
      entities: ["Zebra-Party-A", "Zebra-Party-B", "Zebra-Party-C"],
      links: [
        { from: 0, to: 1, rel: "acquired", chunkId: chunk },
        { from: 1, to: 2, rel: "leads", chunkId: chunk },
        { from: 0, to: 2, rel: "owns", chunkId: chunk },
      ],
      chunkIds: [chunk],
      ordinal: RELATIONS_ORDINAL,
    },
  };
}
```

Edit `apps/server/app/flows/visualize-document/plan.ts`: change the comment above `facts: z.array(StoredEntry).max(MAX_STORED_FACTS)` to `// The extracted facts (up to 16), the structure facts (up to 2) and the aggregates (up to 2): at most MAX_STORED_FACTS (20) rows, ordinals 0..19.`

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/visualize-document/facts.test.ts app/flows/visualize-document/plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the migration**

Create `infra/migrations/0037_visual_facts_aggregate_kinds.sql`:

```sql
-- 0037: visual_facts also holds the model's two aggregate facts, the timeline (ordinal 18) and the relations (ordinal 19)
-- (spec docs/specs/2026-11-10-structure-diagrams-c2-design.md D2, D6). 0026 and 0035 are never edited: their three CHECKs are
-- replaced here under the same names. The ordinal range widens to 0..19, and the kind/ordinal rule now pins every kind to its
-- own ordinal: the extracted kinds below 16, outline at 16, cooccurrence at 17, timeline at 18, relations at 19. 0035's rule was
-- `(kind IN ('outline','cooccurrence')) = (ordinal >= 16)`, which would refuse a timeline as an "extracted" row and let an
-- outline sit at 17. Every existing row satisfies the new rule: the structure step writes outline at 16 and cooccurrence at
-- 17 only, and the extracted kinds are below 16. No data changes; UNIQUE (tenant_id, document_id, ordinal) is untouched.
--
-- It also adds the extraction format stamp (spec D5, re-extract once): `documents.visual_extract_format`, the format of the
-- extraction that made the document's facts, set by the extraction write in the same transaction as the facts. NULL on every
-- existing document means "extracted before c2" (no backfill). A plain token, no content, so it is not sealed.
ALTER TABLE documents ADD COLUMN visual_extract_format text
  CHECK (visual_extract_format IS NULL OR length(visual_extract_format) <= 64);
ALTER TABLE visual_facts DROP CONSTRAINT visual_facts_kind_ordinal_check;
ALTER TABLE visual_facts DROP CONSTRAINT visual_facts_kind_check;
ALTER TABLE visual_facts DROP CONSTRAINT visual_facts_ordinal_check;
ALTER TABLE visual_facts ADD CONSTRAINT visual_facts_kind_check
  CHECK (kind IN ('series', 'figure', 'factTable', 'outline', 'cooccurrence', 'timeline', 'relations'));
ALTER TABLE visual_facts ADD CONSTRAINT visual_facts_ordinal_check CHECK (ordinal BETWEEN 0 AND 19);
ALTER TABLE visual_facts ADD CONSTRAINT visual_facts_kind_ordinal_check
  CHECK (
    (kind IN ('series', 'figure', 'factTable') AND ordinal < 16)
    OR (kind = 'outline' AND ordinal = 16)
    OR (kind = 'cooccurrence' AND ordinal = 17)
    OR (kind = 'timeline' AND ordinal = 18)
    OR (kind = 'relations' AND ordinal = 19)
  );
```

- [ ] **Step 6: Implement `pgFacts.ts`**

Replace the whole of `apps/server/app/flows/visualize-document/pgFacts.ts` with:

```ts
import { randomUUID } from "node:crypto";
import { ParseAbortedError } from "@docmind/parsers";
import type { Pool } from "pg";
import type { FieldCrypto } from "../../crypto/fields";
import { withTenant } from "../../db/tenant";
import { DocumentGoneError } from "../ingest-document/errors";
import { lockDocument } from "../ingest-document/pgEntities";
import {
  AGGREGATE_ORDINAL_BASE,
  type AnyFact,
  ENTITY_MAP_ORDINAL,
  EXTRACT_FORMAT,
  type ExtractionWrite,
  type Fact,
  OUTLINE_ORDINAL,
  RELATIONS_ORDINAL,
  STRUCTURE_ORDINAL_BASE,
  StoredEntry,
  StoredFact,
  type StructureFact,
  TIMELINE_ORDINAL,
  isAggregateFact,
} from "./facts";

export type VisualizeRef = { tenantId: string; userId: string; documentId: string };

export interface VisualFactStore {
  /**
   * Replaces the document's EXTRACTION-owned rows in one transaction: the extracted facts (ordinals 0..15) and the model's
   * aggregates (the timeline at 18, the relations at 19), together, so an extraction with no timeline removes the old one.
   * Returns the rows written. The structure facts (16 and 17) are not touched.
   */
  replace(
    ref: VisualizeRef,
    facts: readonly ExtractionWrite[],
    signal?: AbortSignal,
    generation?: number,
  ): Promise<number>;
  /** Replaces the document's STRUCTURE facts (ordinals 16 and 17) in one transaction; every other row is not touched. */
  replaceStructure(
    ref: VisualizeRef,
    facts: readonly StructureFact[],
    signal?: AbortSignal,
    generation?: number,
  ): Promise<number>;
  /** The document's extracted facts in ordinal order: what chat and the extraction re-plan check read. Throws DocumentGoneError if the user does not own it. */
  list(ref: VisualizeRef): Promise<Fact[]>;
  /** Every fact of the document, structure facts and aggregates included, in ordinal order. Throws DocumentGoneError if the user does not own it. */
  listAll(ref: VisualizeRef): Promise<AnyFact[]>;
  /** How many aggregate rows (timeline, relations) the document has. Counts rows only: nothing is opened. Throws DocumentGoneError if the user does not own it. */
  aggregateCount(ref: VisualizeRef): Promise<number>;
  /** The format of the extraction that last wrote this document's facts (`EXTRACT_FORMAT`), or null when it was extracted before the stamp existed. Throws DocumentGoneError if the user does not own it. */
  extractFormat(ref: VisualizeRef): Promise<string | null>;
}

const factBind = (id: string) => `visualfact:${id}:fact`;

/** The ordinal each aggregate kind lives at. */
const AGGREGATE_ORDINAL = { timeline: TIMELINE_ORDINAL, relations: RELATIONS_ORDINAL } as const;

/** True when `f` is a row the extraction writer owns: a fact at 0..15, the timeline at 18 or the relations at 19. */
const extractionOwns = (f: ExtractionWrite): boolean =>
  isAggregateFact(f)
    ? f.ordinal === AGGREGATE_ORDINAL[f.kind]
    : Number.isInteger(f.ordinal) && f.ordinal >= 0 && f.ordinal < STRUCTURE_ORDINAL_BASE;

/**
 * The ordinals each writer replaces, as a SQL predicate over `ordinal` with `$4` = 16 and `$5` = 18: extraction owns
 * `< 16` and `>= 18`, structure owns `>= 16` and `< 18`. The two sets are disjoint and together cover 0..19.
 */
const OWNED = {
  extraction: "(ordinal < $4 OR ordinal >= $5)",
  structure: "(ordinal >= $4 AND ordinal < $5)",
} as const;

export class PgVisualFacts implements VisualFactStore {
  constructor(
    private readonly pool: Pool,
    private readonly fields: FieldCrypto,
  ) {}

  // `async`, so a refused range is a rejected promise (as every caller and test sees it), never a synchronous throw.
  async replace(
    ref: VisualizeRef,
    facts: readonly ExtractionWrite[],
    signal?: AbortSignal,
    generation?: number,
  ): Promise<number> {
    if (!facts.every(extractionOwns))
      throw new Error("extraction writes ordinals 0..15, the timeline at 18 and the relations at 19");
    // Refuse an aggregate no reader could parse: the step fails here, instead of every `listAll` failing on every later run.
    for (const f of facts)
      if (isAggregateFact(f) && !StoredEntry.safeParse(f).success)
        throw new Error("aggregate fact has an unexpected shape");
    return this.write(ref, facts, "extraction", signal, generation);
  }

  async replaceStructure(
    ref: VisualizeRef,
    facts: readonly StructureFact[],
    signal?: AbortSignal,
    generation?: number,
  ): Promise<number> {
    if (facts.some((f) => f.ordinal !== OUTLINE_ORDINAL && f.ordinal !== ENTITY_MAP_ORDINAL))
      throw new Error("structure facts use ordinals 16 and 17");
    // Refuse a fact no reader could parse: the step fails here, instead of every `listAll` failing on every later run.
    for (const f of facts)
      if (!StoredEntry.safeParse(f).success)
        throw new Error("structure fact has an unexpected shape");
    return this.write(ref, facts, "structure", signal, generation);
  }

  /** `owner` names the writer: it decides which ordinals the transaction deletes before it inserts. */
  private async write(
    ref: VisualizeRef,
    facts: readonly AnyFact[],
    owner: keyof typeof OWNED,
    signal?: AbortSignal,
    generation?: number,
  ): Promise<number> {
    // Sealing may call the key store: do it before the transaction, never under row locks.
    const cipher = this.fields.forUser(ref.userId);
    const rows = await Promise.all(
      facts.map(async (f) => {
        const id = randomUUID();
        return {
          id,
          // The column carries the fact's own kind (migrations 0035 and 0037 widened its CHECKs); the sealed fact's `kind` is what readers use.
          kind: f.kind,
          ordinal: f.ordinal,
          chunkIds: f.chunkIds,
          sealed: JSON.stringify(await cipher.seal(factBind(id), f)),
        };
      }),
    );
    await withTenant(this.pool, ref.tenantId, async (tx) => {
      await lockDocument(tx, ref);
      if (generation !== undefined) {
        // The step guard checked this at begin; a re-ingest can land after that. Under the document lock, a run of a
        // superseded generation writes nothing (the same outcome as the guard: the document is gone for this run).
        const { rows } = await tx.query<{ ingest_generation: number }>(
          "SELECT ingest_generation FROM documents WHERE id = $1 AND owner_id = $2 AND tenant_id = $3",
          [ref.documentId, ref.userId, ref.tenantId],
        );
        if (Number(rows[0]?.ingest_generation) !== generation) throw new DocumentGoneError();
      }
      await tx.query(
        `DELETE FROM visual_facts
          WHERE tenant_id = $1 AND owner_id = $2 AND document_id = $3 AND ${OWNED[owner]}`,
        [ref.tenantId, ref.userId, ref.documentId, STRUCTURE_ORDINAL_BASE, AGGREGATE_ORDINAL_BASE],
      );
      for (const r of rows) {
        await tx.query(
          `INSERT INTO visual_facts (id, tenant_id, owner_id, document_id, kind, ordinal, fact_enc, chunk_ids)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::uuid[])`,
          [r.id, ref.tenantId, ref.userId, ref.documentId, r.kind, r.ordinal, r.sealed, r.chunkIds],
        );
      }
      // Only the extraction write stamps: the stamp says which extraction made these facts (spec D5), in the same transaction.
      if (owner === "extraction")
        await tx.query(
          "UPDATE documents SET visual_extract_format = $4 WHERE id = $1 AND owner_id = $2 AND tenant_id = $3",
          [ref.documentId, ref.userId, ref.tenantId, EXTRACT_FORMAT],
        );
      if (signal?.aborted) throw new ParseAbortedError();
    });
    return rows.length;
  }

  async listAll(ref: VisualizeRef): Promise<AnyFact[]> {
    return this.read(ref, StoredEntry, "");
  }

  /** Extracted facts only: every other row is filtered in SQL, so chat never opens or parses it. */
  async list(ref: VisualizeRef): Promise<Fact[]> {
    return (await this.read(ref, StoredFact, `AND ordinal < ${STRUCTURE_ORDINAL_BASE}`)) as Fact[];
  }

  async aggregateCount(ref: VisualizeRef): Promise<number> {
    const res = await withTenant(this.pool, ref.tenantId, async (tx) => {
      await lockDocument(tx, ref);
      return tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM visual_facts
          WHERE tenant_id = $1 AND owner_id = $2 AND document_id = $3 AND ordinal >= $4`,
        [ref.tenantId, ref.userId, ref.documentId, AGGREGATE_ORDINAL_BASE],
      );
    });
    return res.rows[0]?.n ?? 0;
  }

  async extractFormat(ref: VisualizeRef): Promise<string | null> {
    const res = await withTenant(this.pool, ref.tenantId, async (tx) => {
      await lockDocument(tx, ref);
      return tx.query<{ format: string | null }>(
        "SELECT visual_extract_format AS format FROM documents WHERE id = $1 AND owner_id = $2 AND tenant_id = $3",
        [ref.documentId, ref.userId, ref.tenantId],
      );
    });
    return res.rows[0]?.format ?? null;
  }

  private async read(
    ref: VisualizeRef,
    schema: { safeParse(v: unknown): { success: boolean; data?: unknown } },
    extra: string,
  ): Promise<AnyFact[]> {
    const res = await withTenant(this.pool, ref.tenantId, async (tx) => {
      await lockDocument(tx, ref);
      return tx.query<{ id: string; fact_enc: unknown }>(
        `SELECT id, fact_enc FROM visual_facts
          WHERE tenant_id = $1 AND owner_id = $2 AND document_id = $3 ${extra} ORDER BY ordinal`,
        [ref.tenantId, ref.userId, ref.documentId],
      );
    });
    const cipher = this.fields.forUser(ref.userId);
    return Promise.all(
      res.rows.map(async (r) => {
        const parsed = schema.safeParse(await cipher.open(factBind(r.id), r.fact_enc));
        if (!parsed.success) throw new Error("visual fact has an unexpected shape");
        return parsed.data as AnyFact;
      }),
    );
  }
}
```

- [ ] **Step 7: Run the pg tests to verify they pass**

Run: `set -a; . ./.env; set +a; pnpm --filter @docmind/server exec vitest run app/flows/visualize-document/pgFacts.pg.test.ts`
Expected: PASS, and the summary lists the pg tests as passed (not skipped). The new migration is applied by the test fixture's `migrate`.

- [ ] **Step 8: Make the fake stores compile (a new method on the interface)**

`VisualizeDeps.facts` is a full `VisualFactStore`, so every fake that builds it needs `aggregateCount` and `extractFormat`, and a fake whose `replace` now receives `ExtractionWrite[]` needs a wider `held`. Run `pnpm typecheck:tests`: it names each place. The expected three:

- `apps/server/app/flows/visualize-document/flow.test.ts`: change the import `import type { Fact, StructureFact } from "./facts";` to `import { AGGREGATE_ORDINAL_BASE, type ExtractionWrite, type Fact, STRUCTURE_ORDINAL_BASE, type StructureFact } from "./facts";`; in `stack` change `let held: Fact[] = [];` to `let held: ExtractionWrite[] = [];`; replace the `list` and `listAll` entries of the `facts` fake with

```ts
      list: async () => held.filter((f) => f.ordinal < STRUCTURE_ORDINAL_BASE) as Fact[],
      listAll: async () => {
        if (o.listAllError) throw o.listAllError;
        return [...held, ...structured].sort((a, b) => a.ordinal - b.ordinal);
      },
      aggregateCount: async () => held.filter((f) => f.ordinal >= AGGREGATE_ORDINAL_BASE).length,
      extractFormat: async () => (stamped ? EXTRACT_FORMAT : null),
```

(and declare `let stamped = false;` beside `held`, set `stamped = true;` as the first line after the `replaceError` check inside the `replace` fake; add `EXTRACT_FORMAT` to the `./facts` import), and change `hold: (facts: Fact[]) => {` to `hold: (facts: ExtractionWrite[]) => {`. (Keep `Fact` imported: other lines of the file use it.)

- `apps/server/app/flows/visualize-document/recovery.test.ts`: import `AGGREGATE_ORDINAL_BASE`, `type ExtractionWrite`, `STRUCTURE_ORDINAL_BASE` from `./facts` beside `Fact`; `let held: Fact[] = [];` becomes `let held: ExtractionWrite[] = [];`; the fake's `list`/`listAll` become

```ts
        list: async () => held.filter((f) => f.ordinal < STRUCTURE_ORDINAL_BASE) as Fact[],
        listAll: async () => held,
        aggregateCount: async () => held.filter((f) => f.ordinal >= AGGREGATE_ORDINAL_BASE).length,
        extractFormat: async () => null,
```

- `apps/server/app/flows/visualize-document/rollout.pg.test.ts`: the same changes (`let held: ExtractionWrite[]`, the `list` filter, and `aggregateCount` and `extractFormat: async () => null` beside `listAll: async () => [...held, ...structured]`).

Run: `pnpm typecheck && pnpm typecheck:tests && pnpm lint`
Expected: clean. Then run `pnpm --filter @docmind/server exec vitest run app/flows/visualize-document` (with the pg env set) and confirm everything passes: the only behavioural change so far is the stricter `StoredEntry` and the wider ranges.

- [ ] **Step 9: Commit**

```bash
git add infra/migrations/0037_visual_facts_aggregate_kinds.sql apps/server/app/flows/visualize-document/facts.ts apps/server/app/flows/visualize-document/facts.test.ts apps/server/app/flows/visualize-document/pgFacts.ts apps/server/app/flows/visualize-document/pgFacts.pg.test.ts apps/server/app/flows/visualize-document/testing.ts apps/server/app/flows/visualize-document/plan.ts apps/server/app/flows/visualize-document/plan.test.ts apps/server/app/flows/visualize-document/flow.test.ts apps/server/app/flows/visualize-document/recovery.test.ts apps/server/app/flows/visualize-document/rollout.pg.test.ts
git commit -m "feat(visuals): c2 timeline and relations fact kinds, migration 0037, ordinal ownership"
```


---

### Task 3: Catalogue v4, the two diagram reshapers, fit, planner capabilities, intent and the rollout guarantee

**Files:**
- Modify: `packages/experiences/src/structureShapes.ts`
- Modify: `packages/experiences/src/visuals.ts`
- Modify: `packages/experiences/src/views.ts`
- Modify: `packages/experiences/src/index.ts`
- Modify: `apps/server/app/flows/visualize-document/plan.ts` (`VISUALS_INTENT`)
- Test: `packages/experiences/src/structureShapes.test.ts`, `visuals.test.ts`, `views.test.ts`, `providers.test.ts`; `apps/server/app/flows/visualize-document/plan.test.ts`, `fit.test.ts`

**Interfaces:**
- Consumes: the stored shapes of Task 2 (structurally: `AggregateFact` is assignable to the new `TimelineFact` and `RelationsFact`); `aggregateFacts(chunk)` from `testing.ts` (Task 2).
- Produces (Tasks 4 and 6 rely on these exact names):
  - `visuals.ts`: `interface TimelineFact { kind: "timeline"; events: { at: string; precision: "day" | "month" | "quarter" | "year"; when: string; label: string; chunkId: string }[]; chunkIds: string[]; ordinal: number }`; `interface RelationsFact { kind: "relations"; entities: string[]; links: { from: number; to: number; rel: string; chunkId: string }[]; chunkIds: string[]; ordinal: number }`; `VisualFactRaw` gains both; `VISUALS_CATALOG.id === "docmind.visuals.v4"` with entries `DocumentTimeline` and `Relationships` (both `Diagram`) appended after the eight v3 entries; `VISUAL_SHAPES` gains exactly `visual-timeline-18` and `visual-relations-19` (68 names); `VisualEntry` gains `"DocumentTimeline" | "Relationships"`; `entryFitsOrdinal("DocumentTimeline", 18)` and `("Relationships", 19)` only.
  - `structureShapes.ts`: `timelineDiagram(f: TimelineFact): DiagramShape | null`, `relationshipsDiagram(f: RelationsFact): DiagramShape | null`; `DiagramShape.layout` gains `"timeline"` and an optional `timeFormat`; `DiagramNode` gains an optional `at`.
  - `plan.ts`: `VISUALS_INTENT.objective` names `DocumentTimeline` and `Relationships`.
  - `factFormatFingerprint()` is unchanged (spec D5): pinned by a test.

- [ ] **Step 1: Write the failing tests**

In `packages/experiences/src/structureShapes.test.ts`: extend the imports to `import { entityMapDiagram, outlineDiagram, relationshipsDiagram, timelineDiagram } from "./structureShapes";` and `import type { EntityMapFact, OutlineFact, RelationsFact, TimelineFact } from "./visuals";`, then append:

```ts
const TIMELINE: TimelineFact = {
  kind: "timeline",
  events: [
    { at: "2024-03-01", precision: "month", when: "March 2024", label: "Acme acquires Beta", chunkId: cid(1) },
    { at: "2025-07-01", precision: "quarter", when: "Q3 2025", label: "Launch", chunkId: cid(2) },
    { at: "2026-02-14", precision: "day", when: "14 February 2026", label: "Office opens", chunkId: cid(3) },
  ],
  chunkIds: [cid(1), cid(2), cid(3)],
  ordinal: 18,
};
const E0 = TIMELINE.events[0] as TimelineFact["events"][number];
const RELATIONS: RelationsFact = {
  kind: "relations",
  entities: ["Acme", "Beta Corp", "Cora", "Project X"],
  links: [
    { from: 0, to: 1, rel: "acquired", chunkId: cid(1) },
    { from: 2, to: 3, rel: "leads", chunkId: cid(2) },
    { from: 0, to: 3, rel: "owns", chunkId: cid(3) },
  ],
  chunkIds: [cid(1), cid(2), cid(3)],
  ordinal: 19,
};
const L0 = RELATIONS.links[0] as RelationsFact["links"][number];

describe("timelineDiagram", () => {
  it("is a timeline of dated nodes with no edges and a date-only axis; the written date prefixes every label that is not dated to the day", () => {
    const v = timelineDiagram(TIMELINE);
    expect(v?.layout).toBe("timeline");
    expect(v?.timeFormat).toEqual({ granularity: "day" });
    expect(v?.edges).toEqual([]);
    expect(v?.nodes).toEqual([
      { id: "t0", label: "March 2024 · Acme acquires Beta", group: "month", kind: "event", at: "2024-03-01" },
      { id: "t1", label: "Q3 2025 · Launch", group: "quarter", kind: "event", at: "2025-07-01" },
      { id: "t2", label: "Office opens", group: "day", kind: "event", at: "2026-02-14" },
    ]);
  });

  it("is a value loom-ui accepts as a Diagram, and every node has a parseable `at`", () => {
    const v = timelineDiagram(TIMELINE);
    expect(diagramProblems(v as never)).toEqual([]);
    expect(DiagramValue.safeParse(v).success).toBe(true);
    for (const n of v?.nodes ?? []) expect(Number.isNaN(Date.parse(n.at as string))).toBe(false);
    // the control: loom-ui does refuse an undated timeline node
    expect(
      diagramProblems({ layout: "timeline", nodes: [{ id: "a", label: "A" }], edges: [] }).length,
    ).toBeGreaterThan(0);
  });

  it("is null for no events, an `at` that is not a date, and more events than a diagram holds (at the cap it still fits)", () => {
    expect(timelineDiagram({ ...TIMELINE, events: [] })).toBeNull();
    expect(
      timelineDiagram({ ...TIMELINE, events: [{ ...E0, at: "soon" }, ...TIMELINE.events.slice(1)] }),
    ).toBeNull();
    const events = (n: number) => Array.from({ length: n }, (_, i) => ({ ...E0, label: `E${i}` }));
    expect(timelineDiagram({ ...TIMELINE, events: events(MAX_DIAGRAM_NODES) })).not.toBeNull();
    expect(timelineDiagram({ ...TIMELINE, events: events(MAX_DIAGRAM_NODES + 1) })).toBeNull();
  });
});

describe("relationshipsDiagram", () => {
  it("is a network of the parties, a directed edge from to to labelled with the relation", () => {
    const v = relationshipsDiagram(RELATIONS);
    expect(v?.layout).toBe("network");
    expect(v?.nodes).toEqual([
      { id: "n0", label: "Acme", group: "party", kind: "party" },
      { id: "n1", label: "Beta Corp", group: "party", kind: "party" },
      { id: "n2", label: "Cora", group: "party", kind: "party" },
      { id: "n3", label: "Project X", group: "party", kind: "party" },
    ]);
    expect(v?.edges).toEqual([
      { from: "n0", to: "n1", label: "acquired" },
      { from: "n2", to: "n3", label: "leads" },
      { from: "n0", to: "n3", label: "owns" },
    ]);
    expect(DiagramValue.safeParse(v).success).toBe(true);
  });

  it("keeps two relations between the same pair as two labelled edges", () => {
    const v = relationshipsDiagram({
      ...RELATIONS,
      links: [L0, { ...L0, rel: "owns" }, ...RELATIONS.links.slice(1)],
    });
    expect(v?.edges.filter((e) => e.from === "n0" && e.to === "n1").map((e) => e.label)).toEqual([
      "acquired",
      "owns",
    ]);
    expect(DiagramValue.safeParse(v).success).toBe(true);
  });

  it("is null for fewer than 2 parties, no links, a self-link, a link to an unlisted party, and more parties than a diagram holds", () => {
    expect(relationshipsDiagram({ ...RELATIONS, entities: ["Only"] })).toBeNull();
    expect(relationshipsDiagram({ ...RELATIONS, links: [] })).toBeNull();
    expect(relationshipsDiagram({ ...RELATIONS, links: [{ ...L0, from: 1, to: 1 }] })).toBeNull();
    expect(relationshipsDiagram({ ...RELATIONS, links: [{ ...L0, to: 9 }] })).toBeNull();
    const parties = (n: number) => Array.from({ length: n }, (_, i) => `P${i}`);
    expect(relationshipsDiagram({ ...RELATIONS, entities: parties(MAX_DIAGRAM_NODES) })).not.toBeNull();
    expect(relationshipsDiagram({ ...RELATIONS, entities: parties(MAX_DIAGRAM_NODES + 1) })).toBeNull();
  });
});
```

In `packages/experiences/src/visuals.test.ts`:

1. Extend the import from `./visuals` with `type RelationsFact` and `type TimelineFact`.
2. Edit the two assertions `expect(VISUALS_CATALOG.id).toBe("docmind.visuals.v3");` (line 140, inside the chat catalogue test, and line 689, inside "structure widgets") to `"docmind.visuals.v4"`, and rename the line-689 test to "the document catalogue is v4 and has the two diagram entries of c1; the chat catalogue has neither".
3. Edit the test "register all 66 names ..." to:

```ts
  it("register all 68 names: the four fact families at ordinals 0..15, the outline at 16, the map at 17, the timeline at 18 and the relations at 19", () => {
    expect(Object.keys(VISUAL_SHAPES)).toHaveLength(68);
    for (const f of ["bar", "trend", "kpi", "table"])
      for (let n = 0; n < 16; n++) expect(() => shapeOf(`visual-${f}-${n}`, [])).toThrow("missing");
    expect(() => shapeOf("visual-outline-16", [])).toThrow("missing");
    expect(() => shapeOf("visual-entitymap-17", [])).toThrow("missing");
    expect(() => shapeOf("visual-timeline-18", [])).toThrow("missing");
    expect(() => shapeOf("visual-relations-19", [])).toThrow("missing");
  });
```

4. Append:

```ts
describe("timeline and relationships widgets", () => {
  const doc = "11111111-1111-4111-8111-111111111111";
  const cites = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      documentId: doc,
      passageId: cid(i + 1),
      label: `Report, passage ${i + 1}`,
    }));
  const TIMELINE: TimelineFact = {
    kind: "timeline",
    events: [
      { at: "2024-03-01", precision: "month", when: "Zebra-When-A", label: "Zebra-Event-A", chunkId: cid(1) },
      { at: "2025-07-01", precision: "quarter", when: "Q3 2025", label: "Zebra-Event-B", chunkId: cid(2) },
      { at: "2026-02-14", precision: "day", when: "14 Feb 2026", label: "Zebra-Event-C", chunkId: cid(3) },
    ],
    chunkIds: [cid(1), cid(2), cid(3)],
    ordinal: 18,
  };
  const RELATIONS: RelationsFact = {
    kind: "relations",
    entities: ["Zebra-Party-A", "Zebra-Party-B", "Zebra-Party-C"],
    links: [
      { from: 0, to: 1, rel: "Zebra-acquired", chunkId: cid(1) },
      { from: 1, to: 2, rel: "Zebra-leads", chunkId: cid(2) },
      { from: 0, to: 2, rel: "Zebra-owns", chunkId: cid(3) },
    ],
    chunkIds: [cid(1), cid(2), cid(3)],
    ordinal: 19,
  };

  it("the document catalogue is v4: the eight v3 entries come first and are byte for byte what v3 was, then the two new Diagram entries", () => {
    expect(VISUALS_CATALOG.id).toBe("docmind.visuals.v4");
    expect(VISUALS_CATALOG.entries.map((e) => e.name)).toEqual([
      "FigureChart",
      "FigureTrend",
      "KeyFigure",
      "FactTable",
      "RelatedDocuments",
      "ConnectionMap",
      "DocumentOutline",
      "EntityMap",
      "DocumentTimeline",
      "Relationships",
    ]);
    // Measured on `main` before this release: a plan stored under v3 compiles against v4 only while these stay identical (spec D5).
    expect(
      createHash("sha256").update(JSON.stringify(VISUALS_CATALOG.entries.slice(0, 8))).digest("hex"),
    ).toBe("26bc046f4768d49e9cc97ed29a5689e0d8857f229e7e5e810e22b072eea065aa");
    const web = (name: string) =>
      (VISUALS_CATALOG.entries.find((e) => e.name === name)?.surfaces.web as { kind: string }).kind;
    expect(web("DocumentTimeline")).toBe("Diagram");
    expect(web("Relationships")).toBe("Diagram");
    const chat = FACT_VISUALS_CATALOG.entries.map((e) => e.name);
    expect(chat).not.toContain("DocumentTimeline");
    expect(chat).not.toContain("Relationships");
  });

  it("reshapes the timeline to a valid timeline whose refs are the cited passages (at most 16), a quarter shown as written", () => {
    const v = shape("visual-timeline-18", [{ ...TIMELINE, cites: cites(20) }]) as {
      layout: string;
      timeFormat: { granularity: string };
      nodes: { label: string; at: string }[];
      refs: { id: string; label: string }[];
    };
    expect(v.layout).toBe("timeline");
    expect(v.timeFormat).toEqual({ granularity: "day" });
    expect(v.nodes.map((n) => [n.label, n.at])).toEqual([
      ["Zebra-When-A · Zebra-Event-A", "2024-03-01"],
      ["Q3 2025 · Zebra-Event-B", "2025-07-01"],
      ["Zebra-Event-C", "2026-02-14"],
    ]);
    expect(v.refs).toHaveLength(16);
    expect(v.refs[0]).toEqual({ id: `${doc}:${cid(1)}`, label: "Report, passage 1" });
    expect(checkKindValue("Diagram", v)).toMatchObject({ ok: true });
    expect((shape("visual-timeline-18", [TIMELINE]) as { refs?: unknown }).refs).toBeUndefined();
  });

  it("reshapes the relations to a valid labelled network with refs", () => {
    const v = shape("visual-relations-19", [{ ...RELATIONS, cites: cites(3) }]) as {
      layout: string;
      edges: { from: string; to: string; label: string }[];
      refs: unknown[];
    };
    expect(v.layout).toBe("network");
    expect(v.edges.map((e) => [e.from, e.to, e.label])).toEqual([
      ["n0", "n1", "Zebra-acquired"],
      ["n1", "n2", "Zebra-leads"],
      ["n0", "n2", "Zebra-owns"],
    ]);
    expect(v.refs).toHaveLength(3);
    expect(checkKindValue("Diagram", v)).toMatchObject({ ok: true });
  });

  it("fitsShape accepts the right fact and rejects every other, as hydration would", () => {
    expect(fitsShape("DocumentTimeline", TIMELINE)).toBe(true);
    for (const wrong of [RELATIONS, OUTLINE, MAP, FIGURE, SERIES, TABLE])
      expect(fitsShape("DocumentTimeline", wrong), wrong.kind).toBe(false);
    expect(fitsShape("DocumentTimeline", undefined)).toBe(false);
    expect(fitsShape("Relationships", RELATIONS)).toBe(true);
    for (const wrong of [TIMELINE, OUTLINE, MAP, FIGURE, SERIES, TABLE])
      expect(fitsShape("Relationships", wrong), wrong.kind).toBe(false);
    expect(
      fitsShape("Relationships", { ...RELATIONS, links: [{ from: 0, to: 9, rel: "r", chunkId: cid(1) }] }),
    ).toBe(false);
    expect(fitsShape("DocumentOutline", TIMELINE)).toBe(false);
    expect(fitsShape("EntityMap", RELATIONS)).toBe(false);
    expect(fitsShape("FigureChart", TIMELINE)).toBe(false);
    expect(fitsShape("KeyFigure", RELATIONS)).toBe(false);
  });

  it("builds the aggregate reshapers only at their own ordinals, and an entry reads only its own ordinal", () => {
    const keys = Object.keys(VISUAL_SHAPES);
    for (const k of ["visual-timeline-18", "visual-relations-19", "visual-outline-16", "visual-kpi-15"])
      expect(keys, k).toContain(k);
    for (const k of [
      "visual-timeline-19",
      "visual-timeline-17",
      "visual-timeline-3",
      "visual-relations-18",
      "visual-relations-17",
      "visual-kpi-18",
      "visual-bar-19",
      "visual-trend-18",
      "visual-table-19",
      "visual-outline-18",
      "visual-entitymap-19",
    ])
      expect(keys, k).not.toContain(k);
    expect([18, 19, 16, 3].map((n) => entryFitsOrdinal("DocumentTimeline", n))).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect([18, 19, 17, 3].map((n) => entryFitsOrdinal("Relationships", n))).toEqual([
      false,
      true,
      false,
      false,
    ]);
    expect([0, 15, 16, 17, 18, 19].map((n) => entryFitsOrdinal("KeyFigure", n))).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(entryFitsOrdinal("DocumentOutline", 18)).toBe(false);
    expect(entryFitsOrdinal("EntityMap", 19)).toBe(false);
  });

  it("a provider reads the fact by ordinal for either entry, and the fact pins parse at two digits", () => {
    expect(factProvider(18, doc, "DocumentTimeline").reshaping).toMatchObject({
      scriptRef: "visual-timeline-18",
    });
    expect(factProvider(19, doc, "Relationships").reshaping).toMatchObject({
      scriptRef: "visual-relations-19",
    });
    expect(factRefOfPin("visual.facts", `${PINS["visual.facts"]}#fact-19`)).toEqual({
      kind: "detail",
      ordinal: 19,
    });
    expect(factRefOfPin("visual.facts", `${PINS["visual.facts"]}#${doc}/fact-18`)).toEqual({
      kind: "doc",
      documentId: doc,
      ordinal: 18,
    });
  });

  it("offers each aggregate as one capability with a count-only description and a content-free sample", () => {
    const [timeline, relations] = capabilitiesOf([TIMELINE, RELATIONS]);
    expect([timeline?.handle, relations?.handle]).toEqual(["fact-18", "fact-19"]);
    expect([timeline?.toolSchemaHash, relations?.toolSchemaHash]).toEqual([
      `${PINS["visual.facts"]}#fact-18`,
      `${PINS["visual.facts"]}#fact-19`,
    ]);
    expect(timeline?.description).toBe("a timeline of 3 dated events");
    expect(relations?.description).toBe("3 named parties and 3 stated relationships between them");
    expect(timeline?.sensitivity).toBe("sensitive");
    // Nothing the planner is shown carries the fact's text or a real date (the fixtures are all "Zebra" and 2024 to 2026).
    const shown = JSON.stringify([timeline, relations]);
    for (const secret of ["Zebra", "2024-03", "2025-07", "2026-02", "Q3 2025", "14 Feb"])
      expect(shown, secret).not.toContain(secret);
    // The sample lets a `nodes` (and `edges`) binding validate; a count-only sample would not (loom-ui `reshape-invalid`).
    expect(timeline?.sampleOutput).toMatchObject({ kind: "timeline", events: 3 });
    expect(relations?.sampleOutput).toMatchObject({ kind: "relations", parties: 3, links: 3 });
    expect(jsonPathSelect(timeline?.sampleOutput, "nodes").ok).toBe(true);
    expect(jsonPathSelect(relations?.sampleOutput, "nodes").ok).toBe(true);
    expect(jsonPathSelect(relations?.sampleOutput, "edges").ok).toBe(true);
    expect(jsonPathSelect({ kind: "timeline", events: 3 }, "nodes").ok).toBe(false);
  });
});
```

The existing fixtures `OUTLINE`, `MAP`, `FIGURE`, `SERIES`, `TABLE`, `cid`, `shape`, `PINS`, `jsonPathSelect`, `createHash`, `checkKindValue`, `capabilitiesOf`, `entryFitsOrdinal`, `factProvider`, `factRefOfPin` are all already defined or imported at the top of that file.

In `packages/experiences/src/views.test.ts`, inside `describe("detailWithVisuals", ...)` after the test "adopts the outline at fact-16 ...", add:

```ts
  it("adopts the timeline at fact-18 and the relations at fact-19 with their own reshapers, and no other pairing", () => {
    const exp = detailWithVisuals(
      visualsOf([
        kf("t", "DocumentTimeline", "fact-18"),
        kf("r", "Relationships", "fact-19"),
        kf("swap", "DocumentTimeline", "fact-19"), // an aggregate entry on the other aggregate
        kf("low", "Relationships", "fact-3"), // an aggregate entry on an extracted fact
        kf("struct", "DocumentTimeline", "fact-16"), // an aggregate entry on a structure fact
        kf("high", "KeyFigure", "fact-18"), // a fact entry on an aggregate
        kf("outline", "DocumentOutline", "fact-18"), // a structure entry on an aggregate
      ]),
      DOC,
    );
    expect(node(exp, "visuals").children.map((c) => c.id)).toEqual(["v-t", "v-r"]);
    expect(exp.providers["fact-18"]).toEqual(factProvider(18, DOC, "DocumentTimeline"));
    expect(exp.providers["fact-19"]).toEqual(factProvider(19, DOC, "Relationships"));
    expect((exp.providers["fact-18"]?.reshaping as { scriptRef: string }).scriptRef).toBe(
      "visual-timeline-18",
    );
    expect((exp.providers["fact-19"]?.reshaping as { scriptRef: string }).scriptRef).toBe(
      "visual-relations-19",
    );
    for (const h of ["fact-18-b", "fact-19-b", "fact-3", "fact-16"])
      expect(exp.providers[h], h).toBeUndefined();
  });

  it("a plan stored under catalogue v3 (every fact and structure entry it offered) still adopts and compiles under v4, as does one with the new entries", () => {
    const v3 = [
      kf("a", "KeyFigure", "fact-0"),
      kf("b", "FigureChart", "fact-1"),
      kf("c", "FigureTrend", "fact-2"),
      kf("d", "FactTable", "fact-3"),
      kf("e", "DocumentOutline", "fact-16"),
      kf("f", "EntityMap", "fact-17"),
    ];
    const v4 = [...v3, kf("g", "DocumentTimeline", "fact-18"), kf("h", "Relationships", "fact-19")];
    for (const [nodes, ids] of [
      [v3, ["v-a", "v-b", "v-c", "v-d", "v-e", "v-f"]],
      [v4, ["v-a", "v-b", "v-c", "v-d", "v-e", "v-f", "v-g", "v-h"]],
    ] as const) {
      const exp = detailWithVisuals(visualsOf([...nodes]), DOC);
      expect(node(exp, "visuals").children.map((c) => c.id)).toEqual(ids);
      for (const surface of ["web", "terminal"] as const) {
        const r = compile(exp, {
          surface,
          catalog: mergedCatalog(),
          hydrationProjectionId: HYDRATION_PROJECTION_ID,
          hydrationProjectionVersion: HYDRATION_PROJECTION_VERSION,
          viewer: {},
          placeholderKey: KEY,
        });
        expect(r.findings, `${surface} ${ids.length}`).toEqual([]);
      }
    }
  });
```

and inside `describe("turnWithVisuals", ...)` after "never adopts a structure widget or a structure ordinal in chat":

```ts
  it("never adopts a timeline or relations widget, or an aggregate ordinal, in chat", () => {
    const e = experience(
      [
        node("n1", "DocumentTimeline", "p-a"),
        node("n2", "Relationships", "p-b"),
        node("n3", "KeyFigure", "p-c"),
        node("n4", "FactTable", "p-d"),
      ],
      [
        planned("p-a", "visual.facts", `docmind:visual.facts@1#${A}/fact-18`),
        planned("p-b", "visual.facts", `docmind:visual.facts@1#${A}/fact-19`),
        planned("p-c", "visual.facts", `docmind:visual.facts@1#${A}/fact-18`),
        planned("p-d", "visual.facts", `docmind:visual.facts@1#${A}/fact-19`),
      ],
    );
    expect(turnWithVisuals(e, { chatId: CHAT, ord: 6 }, live)).toBeNull();
  });
```

In `packages/experiences/src/providers.test.ts` add to the first `describe`:

```ts
  it("is unchanged by the timeline and relations release, so the boot stale pass re-plans nothing (spec D5)", () => {
    // The literal is the fingerprint on `main` before this release; a run stamped with it must still read as current.
    expect(factFormatFingerprint()).toBe(
      "docmind:visual.facts@1+docmind:turn.facts@1+docmind:doc.connections@1+docmind.structure@1",
    );
  });
```

In `apps/server/app/flows/visualize-document/plan.test.ts` (imports already extended in Task 2; add `RELATIONS_ORDINAL` and `TIMELINE_ORDINAL` to the `./facts` import), append:

```ts
describe("planning the timeline and relations", () => {
  const chunk = FIGURE.chunkIds[0] as string;
  const { timeline, relations } = aggregateFacts(chunk);
  const bind = (id: string, type: string, capability: string, path: string) => ({
    id,
    type,
    label: id,
    span: 12,
    props: {},
    binding: { capability, arguments: {}, path, priority: "P1" },
  });

  it("plans a timeline bound at nodes and relations bound at edges, with no reshape-invalid", async () => {
    const planner = new ReferencePlanner({
      model: scriptedPlannerModel([
        draft(
          [
            bind("timeline", "DocumentTimeline", "fact-18", "nodes"),
            bind("relations", "Relationships", "fact-19", "edges"),
          ],
          "The story",
        ),
      ]),
      modelId: "t",
    });
    const plan = await planVisuals(planner, [FIGURE, timeline, relations], recording());
    expect(plan.findings.map((f) => f.code)).not.toContain("reshape-invalid");
    expect(plan.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(insertedIds(plan.ops)).toEqual(["timeline", "relations"]);
  });

  it("offers the aggregates as capabilities between the facts and the connections, and shows the planner no text", () => {
    expect(visualCapabilities([FIGURE, timeline, relations]).map((c) => c.handle)).toEqual([
      "fact-0",
      "fact-18",
      "fact-19",
      "connections",
    ]);
    const shown = JSON.stringify(visualCapabilities([timeline, relations]));
    expect(shown).not.toContain("Zebra");
    expect(shown).not.toContain("March 2024");
  });

  it("the server's aggregate ordinals are the ones the experiences reshapers serve", () => {
    expect(() => shape(`visual-timeline-${TIMELINE_ORDINAL}`, [timeline])).not.toThrow();
    expect(() => shape(`visual-relations-${RELATIONS_ORDINAL}`, [relations])).not.toThrow();
    expect(() => shape(`visual-timeline-${RELATIONS_ORDINAL}`, [timeline])).toThrow();
  });

  it("tells the planner when to show a timeline and a relationships diagram, and when to leave them out", () => {
    const o = VISUALS_INTENT.objective;
    expect(o).toContain("DocumentTimeline");
    expect(o).toContain("Relationships");
    expect(o).toMatch(/narrates dated events/);
    expect(o).toMatch(/states how parties relate/);
    expect(o).toMatch(/few scattered dates or links/);
    // c1's guidance and the connections guidance are still there
    expect(o).toMatch(/long, sectioned documents/);
    expect(o).toContain("compact Connections section");
  });
});
```

In `apps/server/app/flows/visualize-document/fit.test.ts` extend the `./testing` import with `aggregateFacts` and append inside `describe("dropUnfittingOps", ...)`:

```ts
  it("keeps a DocumentTimeline and a Relationships bound to their own facts, and drops each on the wrong or a missing fact", async () => {
    const { timeline, relations } = aggregateFacts(CHUNK);
    const widget = (id: string, type: string, capability: string, path: string) => ({
      ...node(id, type, capability),
      span: 12,
      binding: { capability, arguments: {}, path, priority: "P1" },
    });
    const p = await planVisuals(
      new ReferencePlanner({
        model: scriptedPlannerModel([
          JSON.stringify({
            summary: "s",
            nodes: [
              widget("timeline", "DocumentTimeline", "fact-18", "nodes"),
              widget("relations", "Relationships", "fact-19", "edges"),
            ],
          }),
        ]),
        modelId: "t",
      }),
      [FIGURE, timeline, relations],
      recording(),
    );
    expect(p.findings.filter((f) => f.severity === "error")).toEqual([]);
    const kept = dropUnfittingOps(p.ops, lookupOf([FIGURE, timeline, relations]));
    expect(inserted(kept.ops)).toEqual(["timeline", "relations"]);
    expect(kept.dropped).toEqual([]);
    // each ordinal holds the other aggregate: neither widget fits
    const swapped = dropUnfittingOps(
      p.ops,
      lookupOf([FIGURE, { ...relations, ordinal: 18 }, { ...timeline, ordinal: 19 }]),
    );
    expect(inserted(swapped.ops)).toEqual([]);
    expect(swapped.dropped).toEqual(["DocumentTimeline", "Relationships"]);
    // a chart at 18 fits neither, and a fact that is gone fits nothing
    expect(
      inserted(dropUnfittingOps(p.ops, lookupOf([FIGURE, { ...FIGURE, ordinal: 18 }])).ops),
    ).toEqual([]);
    expect(inserted(dropUnfittingOps(p.ops, lookupOf([FIGURE, timeline])).ops)).toEqual(["timeline"]);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @docmind/experiences exec vitest run src/structureShapes.test.ts src/visuals.test.ts src/views.test.ts src/providers.test.ts && pnpm --filter @docmind/server exec vitest run app/flows/visualize-document/plan.test.ts app/flows/visualize-document/fit.test.ts`
Expected: FAIL (`timelineDiagram`, `RelationsFact`, the v4 id and the rest do not exist; the providers test already passes).

- [ ] **Step 3: Implement the diagram builders**

In `packages/experiences/src/structureShapes.ts`:

3a. Change the import to `import type { EntityMapFact, OutlineFact, RelationsFact, TimelineFact } from "./visuals";`.

3b. Replace the `DiagramNode` and `DiagramShape` interfaces with:

```ts
export interface DiagramNode {
  id: string;
  label: string;
  group: string;
  kind: string;
  /** A timeline node's date (`YYYY-MM-DD`); loom-ui refuses a timeline node without a parseable one. */
  at?: string;
}
export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
}
export interface DiagramShape {
  layout: "tree" | "network" | "timeline";
  /** How a timeline's dates read (loom-ui `TimeFormat`). */
  timeFormat?: { granularity: "day" };
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}
```

(keep the existing `DiagramEdge` declaration only once: delete the old one.)

3c. Append:

```ts
/**
 * The document's dated events as a timeline: one node per event, `at` its ISO first day, no edges. An event dated to the day
 * is labelled with its text alone; any coarser event ("Q3 2025", "March 2024") is prefixed with the date as written, so the axis
 * never implies a day the document did not give. `timeFormat` is date-only (`day`, no zone): a tick is drawn as the written
 * date in every viewer zone. Null when loom-ui would refuse the value (no events, an `at` that is not a date, over the node cap).
 */
export function timelineDiagram(f: TimelineFact): DiagramShape | null {
  if (f.events.length === 0) return null;
  const nodes = f.events.map((e, i) => ({
    id: `t${i}`,
    label: e.precision === "day" ? e.label : `${e.when} · ${e.label}`,
    group: e.precision,
    kind: "event",
    at: e.at,
  }));
  return accepted({ layout: "timeline", timeFormat: { granularity: "day" }, nodes, edges: [] });
}

/**
 * The parties as a network (they are already one node per normalised name), a directed edge from to to per link labelled with
 * the relation: two relations between one pair are two edges. Null when loom-ui would refuse the value, a link names a party
 * that is not listed, or joins a party to itself.
 */
export function relationshipsDiagram(f: RelationsFact): DiagramShape | null {
  if (f.entities.length < 2 || f.links.length === 0) return null;
  const nodes = f.entities.map((name, i) => ({
    id: `n${i}`,
    label: name,
    group: "party",
    kind: "party",
  }));
  const edges: DiagramEdge[] = [];
  for (const l of f.links) {
    if (l.from === l.to || nodes[l.from] === undefined || nodes[l.to] === undefined) return null;
    edges.push({ from: `n${l.from}`, to: `n${l.to}`, label: l.rel });
  }
  return accepted({ layout: "network", nodes, edges });
}
```

- [ ] **Step 4: Implement the catalogue, reshapers, capabilities and views**

In `packages/experiences/src/visuals.ts`:

4a. Import: `import { entityMapDiagram, outlineDiagram, relationshipsDiagram, timelineDiagram } from "./structureShapes";`

4b. After the `EntityMapFact` interface add the `TimelineFact` and `RelationsFact` interfaces exactly as in this task's Interfaces block, and add `| TimelineFact | RelationsFact` after `| EntityMapFact` in the `VisualFactRaw` union.

4c. In `ENTRIES`, append after `["EntityMap", "Diagram"],`:

```ts
  ["DocumentTimeline", "Diagram"],
  ["Relationships", "Diagram"],
```

and change the id: `"docmind.visuals.v3",` to `"docmind.visuals.v4",` (in `VISUALS_CATALOG`). The two new entries sit AFTER the eight v3 entries, which is what the sha256 guard of the first eight checks; `FACT_VISUALS_CATALOG` filters by `FACT_ENTRY_NAMES`, so it is byte-identical.

4d. In `describeFact` replace the last two lines

```ts
          ? `${f.entities.length} named parties and ${f.edges.length} links between those that appear together`
          : "a table of facts";
```

with

```ts
          ? `${f.entities.length} named parties and ${f.edges.length} links between those that appear together`
          : f.kind === "timeline"
            ? `a timeline of ${f.events.length} dated ${f.events.length === 1 ? "event" : "events"}`
            : f.kind === "relations"
              ? `${f.entities.length} named parties and ${f.links.length} stated relationships between them`
              : "a table of facts";
```

4e. Replace the `sampleOf` constant (from its doc comment `/** What the planner is shown of a fact: ...` through the closing `: f;`) with:

```ts
const TIMELINE_PLACEHOLDER = [
  { label: "Event", at: "2000-01-01" },
  { label: "Event", at: "2000-06-01" },
];
const RELATIONS_PLACEHOLDER = {
  nodes: [
    { label: "Party", group: "party" },
    { label: "Party", group: "party" },
  ],
  edges: [{ from: "n0", to: "n1", label: "relation" }],
};
/** What the planner is shown of a fact: extracted facts show themselves; every other kind shows counts and neutral placeholders only (no text, no real date). */
const sampleOf = (f: VisualFactRaw): unknown => {
  switch (f.kind) {
    case "outline":
      return {
        kind: "outline",
        sections: f.nodes.length,
        levels: depthOf(f),
        nodes: OUTLINE_PLACEHOLDER,
      };
    case "cooccurrence":
      return {
        kind: "cooccurrence",
        entities: f.entities.length,
        links: f.edges.length,
        ...MAP_PLACEHOLDER,
      };
    case "timeline":
      return { kind: "timeline", events: f.events.length, nodes: TIMELINE_PLACEHOLDER };
    case "relations":
      return {
        kind: "relations",
        parties: f.entities.length,
        links: f.links.length,
        ...RELATIONS_PLACEHOLDER,
      };
    default:
      return f;
  }
};
```

4f. Replace the `VisualEntry` union, `FAMILY` and `STRUCTURE_ORDINAL` with:

```ts
export type VisualEntry =
  | "FigureChart"
  | "FigureTrend"
  | "KeyFigure"
  | "FactTable"
  | "DocumentOutline"
  | "EntityMap"
  | "DocumentTimeline"
  | "Relationships";
const FAMILY: Record<VisualEntry, string> = {
  FigureChart: "visual-bar",
  FigureTrend: "visual-trend",
  KeyFigure: "visual-kpi",
  FactTable: "visual-table",
  DocumentOutline: "visual-outline",
  EntityMap: "visual-entitymap",
  DocumentTimeline: "visual-timeline",
  Relationships: "visual-relations",
};
/** The reserved ordinal each non-chart entry reads (the server's `OUTLINE_ORDINAL`, `ENTITY_MAP_ORDINAL`, `TIMELINE_ORDINAL` and `RELATIONS_ORDINAL`: experiences does not import the server; server tests pin them equal). */
const STRUCTURE_ORDINAL: Partial<Record<VisualEntry, number>> = {
  DocumentOutline: 16,
  EntityMap: 17,
  DocumentTimeline: 18,
  Relationships: 19,
};
```

(The comment above `entryFitsOrdinal` says "a structure entry only its own reserved ordinal": it now covers the aggregates too; `entryFitsOrdinal` and `ordinalsOf` need no change because both read `STRUCTURE_ORDINAL`.)

4g. In the `TO` table append, after `"visual-entitymap"`:

```ts
  "visual-timeline": (f) => {
    const v = f.kind === "timeline" ? timelineDiagram(f) : null;
    return v === null ? wrong() : { ...v, ...refsOf(f) };
  },
  "visual-relations": (f) => {
    const v = f.kind === "relations" ? relationshipsDiagram(f) : null;
    return v === null ? wrong() : { ...v, ...refsOf(f) };
  },
```

In `packages/experiences/src/views.ts` replace the `DETAIL_ENTRIES` comment and declaration with:

```ts
/** A document's page can draw the fact widgets and the four structure widgets (outline, entity map, timeline, relationships); chat only the fact widgets (S5). */
const DETAIL_ENTRIES = new Set<string>([
  ...FACT_ENTRIES,
  "DocumentOutline",
  "EntityMap",
  "DocumentTimeline",
  "Relationships",
]);
```

In `packages/experiences/src/index.ts` add `RelationsFact` and `TimelineFact` to the `export type { ... } from "./visuals";` list (alphabetical: after `OutlineFact`).

In `apps/server/app/flows/visualize-document/plan.ts` append to the end of `VISUALS_INTENT.objective` (before the closing quote), keeping everything before it:

```
 Show a DocumentTimeline when the document narrates dated events and a Relationships diagram when it states how parties relate; leave them out when it has only a few scattered dates or links.
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @docmind/experiences exec vitest run && pnpm --filter @docmind/server exec vitest run app/flows/visualize-document/plan.test.ts app/flows/visualize-document/fit.test.ts`
Expected: PASS, including the unchanged chat guard (`createHash("sha256").update(JSON.stringify(FACT_VISUALS_CATALOG))` = `e9096cf4...`).

- [ ] **Step 6: Whole-repo verification and commit**

Run: `pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm build`
Expected: clean. (`pnpm build` matters here: the server resolves `@docmind/experiences` through its build in production.)

```bash
git add packages/experiences/src apps/server/app/flows/visualize-document/plan.ts apps/server/app/flows/visualize-document/plan.test.ts apps/server/app/flows/visualize-document/fit.test.ts
git commit -m "feat(visuals): c2 catalogue v4, timeline and relationships diagrams, fit, intent"
```


---

### Task 4: Extraction wiring: the prompt, the answer, the write, the flow and the flow-hash pin

**Files:**
- Modify: `apps/server/app/flows/visualize-document/prompts.ts`
- Modify: `apps/server/app/flows/visualize-document/extract.ts`
- Modify: `apps/server/app/flows/visualize-document/flow.ts`
- Modify: `apps/server/app/flows/ingest-document/limits.ts`
- Create: `apps/server/app/flows/visualize-document/flowHash.test.ts`
- Test: `apps/server/app/flows/visualize-document/extract.test.ts`, `flow.test.ts`; `apps/server/app/flows/ingest-document/limits.test.ts`

**Interfaces:**
- Consumes: `buildTimeline`, `rawEventsOf` (Task 1), `buildRelations`, `rawLinksOf` (Task 1), `DocumentAnswer`, `AggregateFact`, `ExtractionWrite`, `TIMELINE_ORDINAL`, `RELATIONS_ORDINAL`, `VisualFactStore.replace`/`aggregateCount` (Task 2), `aggregateFacts` (Task 2), the v4 catalogue (Task 3).
- Produces (Task 5 and Task 6 rely on these):
  - `prompts.ts`: `EXTRACT_DOCUMENT_SYSTEM` (starts with the unchanged first sentence of `EXTRACT_SYSTEM`, which the e2e stubs match on); `EXTRACT_SYSTEM` and `EXTRACT_INSTRUCTION` unchanged.
  - `extract.ts`: `interface Extraction { drafts: DraftFact[]; events: unknown[]; links: unknown[] }`; `askForExtraction(llm: LlmProvider, chunks: Chunk[], signal?: AbortSignal): Promise<Extraction>`; `askForFacts` unchanged in signature and request (chat); `ExtractResult` gains `aggregates?: number` (0..2, present only above 0); `ExtractDeps.facts` is `Pick<VisualFactStore, "replace" | "list" | "aggregateCount">`; the extraction write is `replace(ref, [...facts, ...aggregates], signal, generation)`.
  - `flow.ts`: the zero-fact rule counts `extracted.count + extracted.aggregates + derived`.
  - `limits.ts`: `VISUALS_MAX_TOKENS = 16_000`.

- [ ] **Step 1: Write the failing tests**

In `apps/server/app/flows/visualize-document/extract.test.ts`:

1. Change the imports to include `import { UNTRUSTED_CONTENT_SYSTEM_NOTE } from "@loom/llm";` (merge with the existing `@loom/llm` import: `import { type LlmProvider, type LlmRequest, UNTRUSTED_CONTENT_SYSTEM_NOTE, guardRequest } from "@loom/llm";`), `import { EXTRACT_WINDOW_CHARS, askForExtraction, askForFacts, extractEffect } from "./extract";`, `import type { ExtractionWrite, Fact } from "./facts";`, `import { EXTRACT_DOCUMENT_SYSTEM, EXTRACT_SYSTEM } from "./prompts";` and `import { aggregateFacts } from "./testing";`.
2. Replace the `store` fake inside `setup` with:

```ts
  const store = {
    writes: [] as ExtractionWrite[][],
    held: [] as ExtractionWrite[],
    replace: async (_r: VisualizeRef, facts: readonly ExtractionWrite[]) => {
      store.writes.push([...facts]);
      store.held = [...facts];
      return facts.length;
    },
    list: async () => store.held.filter((f) => f.ordinal < 16) as Fact[],
    aggregateCount: async () => store.held.filter((f) => f.ordinal >= 18).length,
  };
```

3. Append this block (before the final closing of the file; it is a new top-level `describe`):

```ts
const EVENTS = [
  { when: "March 2024", date: "2024-03", label: "Alpha launch", chunkIds: [C0] },
  { when: "Q3 2025", date: "2025-Q3", label: "Beta rollout", chunkIds: [C1] },
  { when: "14 February 2026", date: "2026-02-14", label: "Gamma review", chunkIds: [C0, C1] },
];
const LINKS = [
  { from: "Acme", rel: "acquired", to: "Beta Corp", chunkIds: [C0] },
  { from: "Cora", rel: "leads", to: "Project X", chunkIds: [C1] },
  { from: "Acme", rel: "owns", to: "Project X", chunkIds: [C0] },
];
/** A document extraction's answer: one good fact, a timeline and relations; `over` replaces any field. */
const answer = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    facts: [GOOD],
    timeline: { events: EVENTS },
    relations: { links: LINKS },
    ...over,
  });

describe("the timeline and relations of a document extraction", () => {

  it("stores the timeline at 18 and the relations at 19 beside the facts, in one write and one model call", async () => {
    const { llm, requests } = scripted(() => answer());
    const s = setup({ llm });
    expect(await run(s)).toEqual({
      outcome: "done",
      count: 1,
      aggregates: 2,
      model: "claude-test",
    });
    expect(requests).toHaveLength(1);
    expect(s.store.writes).toHaveLength(1);
    const written = s.store.writes[0] as ExtractionWrite[];
    expect(written.map((f) => [f.ordinal, f.kind])).toEqual([
      [0, "series"],
      [18, "timeline"],
      [19, "relations"],
    ]);
    expect(written[1]).toMatchObject({
      kind: "timeline",
      events: [
        { at: "2024-03-01", precision: "month", when: "March 2024", label: "Alpha launch", chunkId: C0 },
        { at: "2025-07-01", precision: "quarter", when: "Q3 2025", label: "Beta rollout", chunkId: C1 },
        { at: "2026-02-14", precision: "day", when: "14 February 2026", label: "Gamma review", chunkId: C0 },
      ],
      chunkIds: [C0, C1],
    });
    expect(written[2]).toMatchObject({
      kind: "relations",
      entities: ["Acme", "Beta Corp", "Cora", "Project X"],
      links: [
        { from: 0, to: 1, rel: "acquired", chunkId: C0 },
        { from: 2, to: 3, rel: "leads", chunkId: C1 },
        { from: 0, to: 3, rel: "owns", chunkId: C0 },
      ],
      chunkIds: [C0, C1],
    });
  });

  it("keeps the old behaviour when the answer has neither field: the facts only, no aggregates key", async () => {
    const { llm } = scripted(() => JSON.stringify({ facts: [GOOD] }));
    const s = setup({ llm });
    expect(await run(s)).toEqual({ outcome: "done", count: 1, model: "claude-test" });
    expect(s.store.writes[0]?.map((f) => f.ordinal)).toEqual([0]);
  });

  it.each([
    ["fields that are not objects", { timeline: "oops", relations: [1, 2] }],
    ["null fields", { timeline: null, relations: null }],
    ["lists that are not lists", { timeline: { events: "x" }, relations: { links: {} } }],
    [
      "too few valid items",
      { timeline: { events: EVENTS.slice(0, 2) }, relations: { links: LINKS.slice(0, 2) } },
    ],
    [
      "items that are all bad",
      {
        timeline: {
          events: [{ when: "soon", date: "last year", label: "x", chunkIds: [C0] }, 5, null, "x"],
        },
        relations: { links: [{ from: "A", to: "A", rel: "is", chunkIds: [C0] }, {}, 7] },
      },
    ],
  ])("%s never cost the facts: they are stored, with no aggregate", async (_name, over) => {
    const { llm } = scripted(() => answer(over));
    const s = setup({ llm });
    expect(await run(s)).toEqual({ outcome: "done", count: 1, model: "claude-test" });
    expect(s.store.writes[0]?.map((f) => f.ordinal)).toEqual([0]);
  });

  it("drops only the bad items: a timeline with a bad date among three good events keeps the three", async () => {
    const bad = { when: "next year", date: "next year", label: "Soon", chunkIds: [C0] };
    const { llm } = scripted(() => answer({ timeline: { events: [bad, ...EVENTS] } }));
    const s = setup({ llm });
    expect(await run(s)).toMatchObject({ count: 1, aggregates: 2 });
    const t = s.store.writes[0]?.[1] as { events: { label: string }[] };
    expect(t.events.map((e) => e.label)).toEqual(["Alpha launch", "Beta rollout", "Gamma review"]);
  });

  it("cites only passages of this document: events that cite a foreign passage are dropped, and two left is no timeline", async () => {
    const foreign = (e: (typeof EVENTS)[number]) => ({ ...e, chunkIds: [randomUUID()] });
    const { llm } = scripted(() =>
      answer({ timeline: { events: [foreign(EVENTS[0] as never), EVENTS[1], EVENTS[2]] } }),
    );
    const s = setup({ llm });
    expect(await run(s)).toEqual({ outcome: "done", count: 1, aggregates: 1, model: "claude-test" });
    expect(s.store.writes[0]?.map((f) => f.kind)).toEqual(["series", "relations"]);
  });

  it("merges the answers of several windows and dedupes across them", async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const texts = Object.fromEntries(ids.map((id) => [id, "x".repeat(10_000)]));
    const answers = [
      {
        facts: [],
        timeline: {
          events: [
            { when: "2024", date: "2024", label: "One", chunkIds: [ids[0]] },
            { when: "2025", date: "2025", label: "Two", chunkIds: [ids[1]] },
          ],
        },
      },
      {
        facts: [],
        timeline: {
          events: [
            { when: "2025", date: "2025", label: "two", chunkIds: [ids[2]] },
            { when: "2026", date: "2026", label: "Three", chunkIds: [ids[2]] },
          ],
        },
      },
    ];
    let n = 0;
    const { llm, requests } = scripted(() => JSON.stringify(answers[n++]));
    const s = setup({ llm, texts });
    expect(await run(s)).toEqual({ outcome: "done", count: 0, aggregates: 1, model: "claude-test" });
    expect(requests).toHaveLength(2);
    const t = s.store.writes[0]?.[0] as { kind: string; ordinal: number; events: { label: string; chunkId: string }[] };
    expect([t.kind, t.ordinal]).toEqual(["timeline", 18]);
    expect(t.events.map((e) => [e.label, e.chunkId])).toEqual([
      ["One", ids[0]],
      ["Two", ids[1]], // the first spelling and the first passage of the duplicate
      ["Three", ids[2]],
    ]);
  });

  it("asks a document extraction for the two fields, and never asks chat's extraction for them", async () => {
    const { llm, requests } = scripted(() => answer());
    await run(setup({ llm }));
    const system = String(requests[0]?.system);
    expect(system).toBe(`${EXTRACT_DOCUMENT_SYSTEM}\n\n${UNTRUSTED_CONTENT_SYSTEM_NOTE}`);
    expect(system.startsWith("You extract facts")).toBe(true);
    for (const phrase of [
      '"timeline"',
      '"relations"',
      "at most 40",
      "at most 30",
      "Never infer, compute or complete a date",
      "relative",
      "at most 2 passage ids",
    ])
      expect(system, phrase).toContain(phrase);
    // chat's call is byte-identical to what it was: the original prompt, no aggregates
    const chat = scripted(() => '{"facts":[]}');
    await askForFacts(chat.llm, [{ id: C0, text: "t" }]);
    expect(String(chat.requests[0]?.system)).toBe(
      `${EXTRACT_SYSTEM}\n\n${UNTRUSTED_CONTENT_SYSTEM_NOTE}`,
    );
    expect(String(chat.requests[0]?.system)).not.toContain("timeline");
  });

  it("askForExtraction returns the facts and the raw, unvalidated aggregates of the window", async () => {
    const { llm } = scripted(() => answer());
    expect(await askForExtraction(llm, [{ id: C0, text: "t" }])).toEqual({
      drafts: [GOOD],
      events: EVENTS,
      links: LINKS,
    });
  });

  it("a refusal clears a timeline and relations a previous run stored, with the facts", async () => {
    const llm = Object.assign(
      {
        complete: async () => {
          throw new LlmRefusalError();
        },
      },
      { model: "claude-test" },
    );
    const s = setup({ llm });
    const { timeline, relations } = aggregateFacts(C0);
    s.store.held = [{ ...GOOD, ordinal: 0 } as Fact, timeline, relations];
    expect(await run(s)).toEqual({ outcome: "done", count: 0, model: "claude-test" });
    expect(s.store.held).toEqual([]);
  });

  it("a new extraction with no timeline replaces the old one (the write carries no ordinal 18)", async () => {
    const { llm } = scripted(() => JSON.stringify({ facts: [GOOD], relations: { links: LINKS } }));
    const s = setup({ llm });
    s.store.held = [{ ...GOOD, ordinal: 0 } as Fact, aggregateFacts(C0).timeline];
    await run(s);
    expect(s.store.held.map((f) => f.ordinal)).toEqual([0, 19]);
  });

  describe("a re-run (-r<n> execution) over stored aggregates", () => {
    const rerunCtx = (s: ReturnType<typeof setup>, n = 1) =>
      ({ executionId: visualizeExecutionId(s.ref.userId, s.ref.documentId, 1, n) }) as never;

    it("reports the timeline and relations it keeps and makes no model call", async () => {
      const { llm, requests } = scripted(() => answer());
      const s = setup({ llm });
      const { timeline, relations } = aggregateFacts(C0);
      s.store.held = [{ ...GOOD, ordinal: 0 } as Fact, timeline, relations];
      expect(await extractEffect(s.d).execute(s.ref, rerunCtx(s))).toEqual({
        outcome: "done",
        count: 1,
        aggregates: 2,
        model: "claude-test",
      });
      expect(requests).toEqual([]);
      expect(s.store.writes).toEqual([]);
    });

    it("a document that has only a timeline is re-planned, not extracted again, and reports it", async () => {
      const { llm, requests } = scripted(() => answer());
      const s = setup({ llm });
      s.store.held = [aggregateFacts(C0).timeline];
      expect(await extractEffect(s.d).execute(s.ref, rerunCtx(s))).toEqual({
        outcome: "done",
        count: 0,
        aggregates: 1,
        model: "claude-test",
      });
      expect(requests).toEqual([]);
    });
  });
});
```

(`C0`, `C1`, `GOOD`, `setup`, `run`, `scripted`, `LlmRefusalError`, `visualizeExecutionId`, `randomUUID` are already defined or imported at the top of this file.)

In `apps/server/app/flows/visualize-document/flow.test.ts`:

1. Add `import { FieldKeyStoreError } from "../../crypto/fields";`, extend the testing import to `import { aggregateFacts, childrenOf, noStructure } from "./testing";`.
2. In the `stack` options type add:

```ts
    /** The extraction write throws this while it returns an error (a key-store outage). */
    replaceError?: () => Error | undefined;
```

and make the `replace` fake begin with `const err = o.replaceError?.(); if (err) throw err;`:

```ts
      replace: async (_r, facts) => {
        const err = o.replaceError?.();
        if (err) throw err;
        held = [...facts];
        return facts.length;
      },
```

3. Append:

```ts
describe("visualize-document flow: timeline and relations", () => {
  const EVENTS = [
    { when: "March 2024", date: "2024-03", label: "Zebra-Event-One", chunkIds: [CHUNK] },
    { when: "Q3 2025", date: "2025-Q3", label: "Zebra-Event-Two", chunkIds: [CHUNK] },
    { when: "14 February 2026", date: "2026-02-14", label: "Zebra-Event-Three", chunkIds: [CHUNK] },
  ];
  const LINKS = [
    { from: "Zebra-Party-A", rel: "Zebra-rel-one", to: "Zebra-Party-B", chunkIds: [CHUNK] },
    { from: "Zebra-Party-B", rel: "Zebra-rel-two", to: "Zebra-Party-C", chunkIds: [CHUNK] },
    { from: "Zebra-Party-A", rel: "Zebra-rel-three", to: "Zebra-Party-C", chunkIds: [CHUNK] },
  ];
  const FACT_LIST = JSON.parse(FACTS).facts;
  const ANSWER = JSON.stringify({
    facts: FACT_LIST,
    timeline: { events: EVENTS },
    relations: { links: LINKS },
  });
  const AGGREGATES_ONLY = JSON.stringify({
    facts: [],
    timeline: { events: EVENTS },
    relations: { links: LINKS },
  });

  it("stores both beside the facts from the one extraction call, plans over them, and shows the planner no text", async () => {
    const s = stack([ANSWER, PLAN]);
    expect(await s.run()).toEqual({ outcome: "done" });
    expect(s.held().map((f) => [f.ordinal, f.kind])).toEqual([
      [0, "figure"],
      [18, "timeline"],
      [19, "relations"],
    ]);
    expect(s.model?.requests).toHaveLength(2); // one extraction window and one planner call: no second call for the aggregates
    const planner = JSON.stringify(s.model?.requests[1]);
    expect(planner).toContain("fact-18");
    expect(planner).toContain("fact-19");
    for (const secret of ["Zebra-Event", "Zebra-Party", "Zebra-rel", "March 2024", "2024-03"])
      expect(planner, secret).not.toContain(secret);
  });

  it("a bad timeline and bad relations still store and plan the good facts", async () => {
    const s = stack([
      JSON.stringify({ facts: FACT_LIST, timeline: "nope", relations: { links: [1, null] } }),
      PLAN,
    ]);
    expect(await s.run()).toEqual({ outcome: "done" });
    expect(s.held().map((f) => f.ordinal)).toEqual([0]);
  });

  it("ends empty, not failed, for a document whose only facts are aggregates when the planner emits nothing", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = stack([AGGREGATES_ONLY, EMPTY_PLAN]);
    expect(await s.run()).toEqual({ outcome: "empty" });
    expect(s.held().map((f) => f.ordinal)).toEqual([18, 19]); // stored, only the plan is empty
    expect(JSON.stringify(s.model?.requests[1])).toContain("fact-18"); // and the planner was offered them
  });

  it("retries a key-store outage on the extraction write, then stores everything", async () => {
    let failures = 1;
    const s = stack([ANSWER, ANSWER, PLAN], {
      replaceError: () => (failures-- > 0 ? new FieldKeyStoreError() : undefined),
    });
    expect(await s.run()).toEqual({ outcome: "done" });
    expect(s.held().map((f) => f.ordinal)).toEqual([0, 18, 19]);
    expect(s.model?.requests).toHaveLength(3); // the window twice (the step retried), the planner once
  });

  it("a re-run that skips extraction keeps the aggregates, reports them, and offers them to the planner", async () => {
    const s = stack([PLAN]);
    const { timeline, relations } = aggregateFacts(CHUNK);
    s.hold([
      { kind: "figure", label: LABEL, value: 4242, unit: "USD", chunkIds: [CHUNK], ordinal: 0 },
      timeline,
      relations,
    ]);
    const rerun = visualizeExecutionId(s.ref.userId, s.ref.documentId, 2, 1);
    expect(await s.run(rerun)).toEqual({ outcome: "done" });
    expect(s.model?.requests).toHaveLength(1); // the planner only
    expect(s.held().map((f) => f.ordinal)).toEqual([0, 18, 19]); // nothing replaced
    expect(JSON.stringify(s.model?.requests[0])).toContain("fact-19");
  });

  it("a document that has only aggregates still loads them on a re-run (they count as stored facts)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const s = stack([EMPTY_PLAN]);
    s.hold([aggregateFacts(CHUNK).timeline]);
    const rerun = visualizeExecutionId(s.ref.userId, s.ref.documentId, 2, 1);
    expect(await s.run(rerun)).toEqual({ outcome: "empty" });
    expect(s.model?.requests).toHaveLength(1); // no extraction
    expect(JSON.stringify(s.model?.requests[0])).toContain("fact-18");
  });
});
```

Create `apps/server/app/flows/visualize-document/flowHash.test.ts`:

```ts
import { flowContentHash } from "@loom/core";
import { describe, expect, it } from "vitest";
import { visualizeDocumentFlow } from "./flow";

describe("the visualize-document flow identity", () => {
  /**
   * Loom's flow hash covers the flow id and version, the ordered steps (id, tool id, timeout, retry) and the deadline, and
   * nothing inside a step: not its prompt, its output schema or its code (packages/core/src/flowHash.ts at Loom 4af27eaa;
   * DocMind sets no codeFingerprint). The timeline and relations change only the extract step's prompt and what its effect
   * reads and writes, so the hash did not move and the flow stays 1.1.0 with no new legacy definition. This literal is the
   * 1.1.0 hash on main before the change (computed with `flowContentHash`; the same method reproduces the 1.0.0 pin in
   * `flow.test.ts`). If you edit the step list, the ids, a retry policy or the version, this fails and you must follow the
   * 1.0.0 to 1.1.0 treatment (a new version, the old one kept registered, a resume test, a rollback note).
   */
  it("is unchanged by the timeline and relations extraction", () => {
    const flow = visualizeDocumentFlow();
    expect(flow.definition.version).toBe("1.1.0");
    expect(flow.definition.steps.map((s) => s.id)).toEqual([
      "visualize-extract",
      "visualize-structure",
      "visualize-load",
      "visualize-commit",
    ]);
    expect(flowContentHash(flow.definition)).toBe(
      "sha256:d3bfb104f3d015ab8165a9784f5f958bd46a347f3a2fb66f4d0d7be6c4e25f9e",
    );
  });
});
```

In `apps/server/app/flows/ingest-document/limits.test.ts` add `VISUALS_MAX_TOKENS` to the existing import from `./limits` and append:

```ts
describe("VISUALS_MAX_TOKENS", () => {
  it("leaves room for a document extraction's timeline and relations on top of the room its facts had", () => {
    // Worst case of the two new fields alone: 40 events and 30 links, each citing two passages (36-character ids), at about
    // 3 characters per token. A truncated answer is an LlmOutputError that fails the whole extraction, facts included.
    const id = "00000000-0000-4000-8000-000000000001";
    const event = JSON.stringify({
      when: "w".repeat(40),
      date: "2026-02-14",
      label: "l".repeat(80),
      chunkIds: [id, id],
    });
    const link = JSON.stringify({
      from: "f".repeat(80),
      rel: "r".repeat(40),
      to: "t".repeat(80),
      chunkIds: [id, id],
    });
    const extra = Math.ceil((40 * event.length + 30 * link.length) / 3);
    expect(extra).toBeGreaterThan(5_000); // the control: the new fields alone are most of the old 8192 cap
    expect(VISUALS_MAX_TOKENS).toBeGreaterThanOrEqual(8192 + extra);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/visualize-document/extract.test.ts app/flows/visualize-document/flow.test.ts app/flows/visualize-document/flowHash.test.ts app/flows/ingest-document/limits.test.ts`
Expected: FAIL (`askForExtraction`, `EXTRACT_DOCUMENT_SYSTEM` and the aggregates do not exist; the flow hash test already PASSES: it pins today's value, which is the point).

- [ ] **Step 3: Implement the prompt**

In `apps/server/app/flows/visualize-document/prompts.ts` keep `EXTRACT_SYSTEM` and `EXTRACT_INSTRUCTION` exactly as they are (chat uses them) and insert between them:

```ts
/** The document extraction's extra ask: the dated events and the stated relationships, beside the facts. Chat never sends it. */
const EXTRACT_AGGREGATES = `The JSON object may also carry two more top-level fields next to "facts". Leave a field out when the document does not support it.
- "timeline": {"events":[{"when","date","label","chunkIds":[...]}]}, the dated events the document narrates, at most 40, in any order.
  "when" is the date exactly as the document writes it. "date" is that same date as YYYY, YYYY-Qn, YYYY-MM or YYYY-MM-DD, at the precision the document gives (a quarter is YYYY-Q1 to YYYY-Q4).
  Never infer, compute or complete a date. Leave out an event whose date is relative ("last year", "next month", "recently") or missing.
  "label" is a short description of the event, at most 80 characters.
- "relations": {"links":[{"from","rel","to","chunkIds":[...]}]}, how the parties the document names relate to each other, at most 30.
  "from" and "to" are parties exactly as the document names them. "rel" is a short verb phrase of at most 40 characters ("acquired", "leads", "reports to").
Cite at most 2 passage ids in "chunkIds" for each event and each link.
Copy dates, names and phrases as the document states them. Leave "timeline" out when fewer than 3 events qualify and "relations" out when fewer than 3 links qualify.`;
/** What a DOCUMENT extraction sends: the facts prompt, then the aggregates. It starts with `EXTRACT_SYSTEM`'s first sentence. */
export const EXTRACT_DOCUMENT_SYSTEM = `${EXTRACT_SYSTEM}\n\n${EXTRACT_AGGREGATES}`;
```

- [ ] **Step 4: Implement `extract.ts`**

Replace `apps/server/app/flows/visualize-document/extract.ts` with:

```ts
import { LlmOutputError, LlmRefusalError, LlmUnavailableError } from "@docmind/llm-anthropic";
import { tainted } from "@loom/classify";
import type { Effect } from "@loom/effect-runtime";
import { type LlmProvider, UNTRUSTED_CONTENT_SYSTEM_NOTE, guardRequest } from "@loom/llm";
import { z } from "zod";
import { parseVisualizeExecution, visualizeGenerationOf } from "../../status/model";
import { FAILURE_CODES } from "../ingest-document/errors";
import { jsonAnswer } from "../ingest-document/llmJson";
import type { ChunkStore } from "../ingest-document/pgChunks";
import {
  LLM_BACKOFF_CAP_MS,
  LLM_RETRY,
  type StepGuard,
  StepResult,
  type StepSeams,
  ingestStepOptions,
  stepEffectOf,
} from "../ingest-document/stepEffect";
import {
  type AggregateFact,
  DocumentAnswer,
  type DraftFact,
  ExtractAnswer,
  RELATIONS_ORDINAL,
  TIMELINE_ORDINAL,
  admit,
} from "./facts";
import type { VisualFactStore, VisualizeRef } from "./pgFacts";
import { EXTRACT_DOCUMENT_SYSTEM, EXTRACT_INSTRUCTION, EXTRACT_SYSTEM } from "./prompts";
import { buildRelations, rawLinksOf } from "./relations";
import type { VisualRuns } from "./runs";
import { buildTimeline, rawEventsOf } from "./timeline";

/** The most chunk text sent to the model in one request; a window never splits a chunk. */
export const EXTRACT_WINDOW_CHARS = 24_000;
const READ_BATCH = 200;
export const EXTRACT_STEP_TIMEOUT_MS = 600_000;

/**
 * The extract step's output: a `StepResult` that may also end `visuals-model-unavailable` (the model stayed unreachable
 * through every attempt). A code, never text.
 */
export const ExtractResult = StepResult.extend({
  code: z.enum([...FAILURE_CODES, "visuals-model-unavailable"]).optional(),
  /** The timeline and relations stored (1 or 2; absent when none). Counted apart from `count`, which is the extracted facts. */
  aggregates: z.number().int().min(1).max(2).optional(),
});
export type ExtractResult = z.infer<typeof ExtractResult>;

/** The extract step's own end: the model stayed unavailable through every attempt. */
export type ModelUnavailableEnd = { outcome: "failed"; code: "visuals-model-unavailable" };

export interface ExtractDeps extends StepSeams {
  guard: StepGuard;
  chunks: Pick<ChunkStore, "sectionsOf" | "read">;
  facts: Pick<VisualFactStore, "replace" | "list" | "aggregateCount">;
  /** The most chunk text read, in chunk order (the summary cap, DOCMIND_SUMMARY_MAX_CHARS): it bounds the model calls. */
  summaryMaxChars: number;
  /** Absent when the visuals role is off: the step is then done with no facts. */
  llm?: LlmProvider;
  /** The run reader: a re-run of a document whose previous run ended `done` re-plans over its stored facts even when there are none. */
  runs?: Pick<VisualRuns, "last">;
  /**
   * Execution ids of re-runs the starter began right after a `done` run (it knew the previous state before the new run
   * overwrote it in visual_runs). In-process only: a run recovered after a crash has no note and may extract once.
   */
  afterDone?: Set<string>;
}

export type Chunk = { id: string; text: string };

/** Consecutive chunks while the running length stays within `max`; an oversized chunk is its own window. */
export function windows(chunks: Chunk[], max: number): Chunk[][] {
  const out: Chunk[][] = [];
  let cur: Chunk[] = [];
  let len = 0;
  for (const c of chunks) {
    if (cur.length > 0 && len + c.text.length > max) {
      out.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(c);
    len += c.text.length;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** Chunks in `ids` order, read `batch` ids at a time through `read`; a chunk that vanished (document being deleted) is skipped; none is added once `cap` characters are read (the last one may cross it). */
export async function readChunks(
  read: (ids: string[]) => Promise<Map<string, string>>,
  ids: string[],
  cap: number,
  batch: number,
): Promise<Chunk[]> {
  const out: Chunk[] = [];
  let used = 0;
  for (let i = 0; i < ids.length && used < cap; i += batch) {
    const slice = ids.slice(i, i + batch);
    const byId = await read(slice);
    for (const id of slice) {
      const text = byId.get(id);
      if (text === undefined) continue;
      if (used >= cap) break;
      out.push({ id, text });
      used += text.length;
    }
  }
  return out;
}

/** One model call per window of `chunks`, fenced as untrusted data, each answer's text read by `read`. */
async function askWindows<T>(
  llm: LlmProvider,
  chunks: Chunk[],
  system: string,
  read: (content: string) => T,
  signal?: AbortSignal,
): Promise<T[]> {
  const out: T[] = [];
  for (const window of windows(chunks, EXTRACT_WINDOW_CHARS)) {
    const text = window.map((c) => `[[${c.id}]]\n${c.text}`).join("\n\n");
    const request = guardRequest({
      system: `${system}\n\n${UNTRUSTED_CONTENT_SYSTEM_NOTE}`,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: tainted(text, "document") },
            { type: "text", text: EXTRACT_INSTRUCTION },
          ],
        },
      ],
      temperature: 0,
    });
    const res = await llm.complete({ ...request, ...(signal && { signal }) });
    if (res.stopReason === "max_tokens") throw new LlmOutputError(); // truncated JSON
    out.push(read(res.content));
  }
  return out;
}

/**
 * The facts the `visuals` model finds in `chunks`: windowed, fenced as untrusted data. Not grounded, not stored. This is
 * the CHAT turn's call (and its request is unchanged): it asks for facts only.
 */
export async function askForFacts(
  llm: LlmProvider,
  chunks: Chunk[],
  signal?: AbortSignal,
): Promise<DraftFact[]> {
  const answers = await askWindows(
    llm,
    chunks,
    EXTRACT_SYSTEM,
    (content) => jsonAnswer(content, ExtractAnswer).facts,
    signal,
  );
  return answers.flat();
}

/** What a document extraction reads from the model: the facts (strict) and the raw events and links of every window, not yet validated. */
export interface Extraction {
  drafts: DraftFact[];
  events: unknown[];
  links: unknown[];
}

/**
 * The DOCUMENT extraction's call: the same windows, with the prompt that also asks for a timeline and relations. The raw
 * events and links of every window are concatenated in window order and normalised once (`aggregatesOf`), so a duplicate
 * across windows is removed by the same dedupe. A fact that is malformed still fails its window (as `askForFacts`); a bad
 * aggregate never does.
 */
export async function askForExtraction(
  llm: LlmProvider,
  chunks: Chunk[],
  signal?: AbortSignal,
): Promise<Extraction> {
  const answers = await askWindows(
    llm,
    chunks,
    EXTRACT_DOCUMENT_SYSTEM,
    (content) => jsonAnswer(content, DocumentAnswer),
    signal,
  );
  return {
    drafts: answers.flatMap((a) => a.facts),
    events: answers.flatMap((a) => rawEventsOf(a.timeline)),
    links: answers.flatMap((a) => rawLinksOf(a.relations)),
  };
}

/**
 * The timeline (ordinal 18) and the relations (ordinal 19) the answers carried, validated against this document's passages
 * (`ids`, in passage order). Either may be absent; neither costs anything else.
 */
function aggregatesOf(extraction: Extraction, ids: readonly string[]): AggregateFact[] {
  const position = new Map(ids.map((id, i) => [id.toLowerCase(), i] as const));
  const timeline = buildTimeline(extraction.events, position);
  const relations = buildRelations(extraction.links, position);
  return [
    ...(timeline ? [{ ...timeline, ordinal: TIMELINE_ORDINAL }] : []),
    ...(relations ? [{ ...relations, ordinal: RELATIONS_ORDINAL }] : []),
  ];
}

/**
 * Visualize-extract step: the document's chunks go to the `visuals` model in windows, as fenced
 * untrusted data; the answer is parsed, the facts grounded against the chunks, the timeline and relations validated, and the
 * survivors stored sealed (one write that owns ordinals 0..15 and 18..19).
 */
export function extractEffect(deps: ExtractDeps): Effect<VisualizeRef, ExtractResult> {
  return stepEffectOf<ExtractResult, VisualizeRef, ModelUnavailableEnd>(
    "visualize-extract",
    deps.guard,
    async (ref, signal, _progress, executionId) => {
      const llm = deps.llm;
      if (!llm) return { model: "none" };
      const generation =
        executionId === undefined
          ? undefined
          : (deps.generationOf ?? visualizeGenerationOf)(executionId);
      const model = String((llm as { model?: unknown }).model ?? "unknown").slice(0, 200);
      // A re-run (`-r<n>`) re-plans over the stored facts without extracting, when there are some or the previous run
      // already ended `done` (a document that has no facts: its plan is the connections alone). It extracts otherwise.
      const id = executionId === undefined ? null : parseVisualizeExecution(executionId);
      const rerun = id?.rerun ?? 0;
      if (executionId !== undefined && id && rerun > 0) {
        // The starter's note is read once and removed here (stored facts or not), so the set never fills up over a large boot.
        const noted = deps.afterDone?.delete(executionId) === true;
        const stored = await deps.facts.list(ref);
        // A timeline or relations fact is a stored fact too: the model already answered for this document.
        const held = await deps.facts.aggregateCount(ref);
        if (stored.length > 0 || held > 0)
          return { count: stored.length, ...(held > 0 && { aggregates: held }), model };
        // The new run is recorded `running` right after it starts, which replaces the previous state: the starter's note
        // is the sure source; the reader only helps if it runs before this run's own `running` record lands.
        const last = noted ? null : await deps.runs?.last(ref, ref.documentId, id.generation);
        if (noted || (last?.state === "done" && last.run < rerun)) return { count: 0, model };
      }
      const ids = (await deps.chunks.sectionsOf(ref)).map((s) => s.id);
      const chunks = await readChunks(
        async (batch) => new Map((await deps.chunks.read(ref, batch)).map((c) => [c.id, c.text])),
        ids,
        deps.summaryMaxChars,
        READ_BATCH,
      );
      const texts = new Map(chunks.map((c) => [c.id, c.text]));
      let extraction: Extraction;
      try {
        extraction = await askForExtraction(llm, chunks, signal);
      } catch (err) {
        if (!(err instanceof LlmRefusalError)) throw err;
        // A refusal is no facts, not a failure; the stored facts (and aggregates) must reflect this run, so clear them.
        await deps.facts.replace(ref, [], signal, generation);
        return { count: 0, model };
      }
      const { facts, dropped } = admit(extraction.drafts, texts, new Set(ids));
      // The count only, never a fact's content (spec 5: ungrounded facts are counted).
      console.info("visualize-extract dropped ungrounded facts", dropped);
      const aggregates = aggregatesOf(extraction, ids);
      await deps.facts.replace(ref, [...facts, ...aggregates], signal, generation);
      return {
        count: facts.length,
        ...(aggregates.length > 0 && { aggregates: aggregates.length }),
        model,
      };
    },
    {
      schema: ExtractResult,
      ended: (end) => end,
    },
    {
      ...ingestStepOptions(
        { ...deps, stepTimeoutMs: EXTRACT_STEP_TIMEOUT_MS },
        LLM_RETRY,
        LLM_BACKOFF_CAP_MS,
      ),
      // The model stayed unreachable (a timeout, a 5xx, a rate limit) through every attempt: a recorded failure the user
      // can retry, not a failed execution.
      exhausted: (err) =>
        err instanceof LlmUnavailableError
          ? { outcome: "failed", code: "visuals-model-unavailable" }
          : undefined,
    },
  );
}
```

(The only changes from the current file: `askWindows` factors out the request loop, `askForFacts` keeps its request byte for byte, `askForExtraction` and `aggregatesOf` are new, `ExtractResult` gains `aggregates`, the re-run branch also consults `aggregateCount`, and the write carries the aggregates. Every import the original had is kept or replaced by the block above.)

- [ ] **Step 5: Implement the flow count and the token cap**

In `apps/server/app/flows/visualize-document/flow.ts`, replace

```ts
    const stored = (extracted.count ?? 0) + derived;
```

with

```ts
    const stored = (extracted.count ?? 0) + (extracted.aggregates ?? 0) + derived;
```

and extend the comment above it: after "No facts at all (none extracted and none derived)" add " (the timeline and relations count as stored facts: a document with only those still loads them)". The `(extracted.count ?? 0) === 0` empty-plan rule below it is deliberately unchanged: a document whose only facts are aggregates ends `empty`, not `failed`, when the planner emits nothing, like a structure-only one.

In `apps/server/app/flows/ingest-document/limits.ts` change `export const VISUALS_MAX_TOKENS = 8192;` to

```ts
/** The `visuals` role's answer cap. 16 000 (as `VISION_MAX_TOKENS`): a document extraction may add up to 40 events and 30 links to its facts, and a truncated answer fails the whole extraction (`limits.test.ts` measures the worst case). */
export const VISUALS_MAX_TOKENS = 16_000;
```

- [ ] **Step 6: Run to verify pass**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/visualize-document app/flows/visualize-turn app/flows/ingest-document/limits.test.ts`
Expected: PASS. The visualize-turn suites passing proves chat's extraction is unaffected (its request is byte-identical, asserted in `extract.test.ts`).

- [ ] **Step 7: Whole-repo verification and commit**

Run: `pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm build`
Expected: clean.

```bash
git add apps/server/app/flows/visualize-document/prompts.ts apps/server/app/flows/visualize-document/extract.ts apps/server/app/flows/visualize-document/extract.test.ts apps/server/app/flows/visualize-document/flow.ts apps/server/app/flows/visualize-document/flow.test.ts apps/server/app/flows/visualize-document/flowHash.test.ts apps/server/app/flows/ingest-document/limits.ts apps/server/app/flows/ingest-document/limits.test.ts
git commit -m "feat(visuals): c2 extraction returns a timeline and relations; flow hash pinned"
```


---

### Task 5: Re-extract once: a user's re-run extracts a pre-c2 document (spec D5, finding F3)

Without this task a re-run would never produce a timeline: the extract step re-plans over stored facts and never extracts on a `-r<n>` run that has any (or whose previous run was `done`). The user ruled: mark each extraction with its format (`docmind.extract@2`, stored on `documents.visual_extract_format`, Task 2) and let a re-run the USER asks for extract again only when the stored marker is missing or not current. That is one extraction call per document, once (the extraction stamps it); every later re-run is a cheap re-plan; a boot pass never extracts; chat's extraction never touches the marker.

**Files:**
- Modify: `apps/server/app/flows/visualize-document/extract.ts`
- Modify: `apps/server/app/flows/visualize-document/start.ts`
- Modify: `apps/server/app/flows/visualize-document/deps.ts`
- Modify: `apps/server/app/compose.ts`
- Test: `apps/server/app/flows/visualize-document/extract.test.ts`, `start.test.ts`

**Interfaces:**
- Consumes: `ExtractDeps` (Task 4); `EXTRACT_FORMAT`, `VisualFactStore.extractFormat` and the stamping `replace` (Task 2).
- Produces: `ExtractDeps.reextract?: Set<string>`, `VisualizeDeps.reextract?: Set<string>`, `VisualsStarterOptions.reextract?: Set<string>` (one shared set, created in `compose.ts`); `VisualsStarter.rerun` (the route's call) notes the execution id it starts; `rerunWith(ref, generation, assumeDone = false, byUser = false)` is internal and the boot passes never pass `byUser`.

- [ ] **Step 1: Write the failing tests**

In `apps/server/app/flows/visualize-document/extract.test.ts`:

1. Add `import { readFileSync } from "node:fs";` and extend the `./facts` import with `EXTRACT_FORMAT`.
2. In `setup`'s `store` fake add a stamp that behaves like the real store (the extraction write stamps it): add the field and method, and make `replace` set it:

```ts
    format: null as string | null,
    extractFormat: async () => store.format,
```

and as the first line of `replace` (before `store.writes.push`): `store.format = EXTRACT_FORMAT;`.
3. Append this top-level block (it reuses the module-level `EVENTS`, `LINKS`, `answer`, `GOOD`, `C0` of Task 4):

```ts
describe("re-extract once (spec D5): a re-run the user asked for extracts a pre-c2 document", () => {
  const ctxOf = (s: ReturnType<typeof setup>, n = 1) =>
    ({ executionId: visualizeExecutionId(s.ref.userId, s.ref.documentId, 1, n) }) as never;
  const noteFor = (s: ReturnType<typeof setup>, n = 1) =>
    new Set([visualizeExecutionId(s.ref.userId, s.ref.documentId, 1, n)]);
  const existing = { ...GOOD, ordinal: 0 } as Fact; // an existing document: a chart fact and no timeline

  it("a re-run the user asked for extracts a document with no stamp, stamps it, and consumes its note", async () => {
    const { llm, requests } = scripted(() => answer());
    const s = setup({ llm });
    s.store.held = [existing]; // extracted before c2: format is null
    expect(s.store.format).toBeNull();
    const reextract = noteFor(s);
    expect(await extractEffect({ ...s.d, reextract }).execute(s.ref, ctxOf(s))).toEqual({
      outcome: "done",
      count: 1,
      aggregates: 2,
      model: "claude-test",
    });
    expect(requests).toHaveLength(1);
    expect(s.store.held.map((f) => f.ordinal)).toEqual([0, 18, 19]);
    expect(s.store.format).toBe(EXTRACT_FORMAT);
    expect(reextract.size).toBe(0);
  });

  it("a second re-run does not extract, even for a document whose extraction found no timeline or relations", async () => {
    const { llm, requests } = scripted(() => JSON.stringify({ facts: [GOOD] })); // the model finds no aggregates
    const s = setup({ llm });
    s.store.held = [existing];
    await extractEffect({ ...s.d, reextract: noteFor(s, 1) }).execute(s.ref, ctxOf(s, 1));
    expect(requests).toHaveLength(1);
    expect(s.store.held.map((f) => f.ordinal)).toEqual([0]); // stamped, with nothing aggregate to show for it
    const second = noteFor(s, 2);
    expect(await extractEffect({ ...s.d, reextract: second }).execute(s.ref, ctxOf(s, 2))).toEqual({
      outcome: "done",
      count: 1,
      model: "claude-test",
    });
    expect(requests).toHaveLength(1); // no new extraction
    expect(second.size).toBe(0);
  });

  it("the re-run of a document a c2 extraction stamped does not extract", async () => {
    const { llm, requests } = scripted(() => answer());
    const s = setup({ llm });
    s.store.held = [existing];
    s.store.format = EXTRACT_FORMAT;
    expect(await extractEffect({ ...s.d, reextract: noteFor(s) }).execute(s.ref, ctxOf(s))).toEqual({
      outcome: "done",
      count: 1,
      model: "claude-test",
    });
    expect(requests).toEqual([]);
    expect(s.store.writes).toEqual([]);
  });

  it("an older stamp counts as pre-c2: the rule is inequality, so a later bump of the format re-extracts once more", async () => {
    const { llm, requests } = scripted(() => answer());
    const s = setup({ llm });
    s.store.held = [existing];
    s.store.format = "docmind.extract@1";
    await extractEffect({ ...s.d, reextract: noteFor(s) }).execute(s.ref, ctxOf(s));
    expect(requests).toHaveLength(1);
    expect(s.store.format).toBe(EXTRACT_FORMAT);
  });

  it("a zero-fact document whose last run was done is extracted by the user's re-run when it has no stamp, and not when stamped", async () => {
    const done = { last: async () => ({ run: 0, state: "done" as const, code: null }) };
    const { llm, requests } = scripted(() => answer());
    const s = setup({ llm });
    await extractEffect({ ...s.d, runs: done, reextract: noteFor(s) }).execute(s.ref, ctxOf(s));
    expect(requests).toHaveLength(1);
    const t = setup({ llm });
    t.store.format = EXTRACT_FORMAT;
    await extractEffect({ ...t.d, runs: done, reextract: noteFor(t) }).execute(t.ref, ctxOf(t));
    expect(requests).toHaveLength(1); // the stamped one re-planned
  });

  it("a boot pass never extracts: an un-noted re-run of a pre-c2 document re-plans over its stored facts, and another run's note is left alone", async () => {
    const { llm, requests } = scripted(() => answer());
    const s = setup({ llm });
    s.store.held = [existing]; // no stamp: the user's press would extract
    const reextract = noteFor(s, 7); // a note for another run of this document
    expect(await extractEffect({ ...s.d, reextract }).execute(s.ref, ctxOf(s, 1))).toEqual({
      outcome: "done",
      count: 1,
      model: "claude-test",
    });
    expect(requests).toEqual([]);
    expect(s.store.format).toBeNull(); // nothing was extracted, so nothing was stamped
    expect(reextract.size).toBe(1);
  });

  it("the automatic run extracts as before and stamps the format (a new upload or re-ingest)", async () => {
    const { llm, requests } = scripted(() => answer());
    const s = setup({ llm });
    const ctx = { executionId: visualizeExecutionId(s.ref.userId, s.ref.documentId, 1) } as never;
    await extractEffect(s.d).execute(s.ref, ctx);
    expect(requests).toHaveLength(1);
    expect(s.store.format).toBe(EXTRACT_FORMAT);
  });

  it("chat's extraction code never writes or reads the stamp: its sources do not mention it", () => {
    for (const file of ["../visualize-turn/steps.ts", "../visualize-turn/deps.ts", "../visualize-turn/pgTurnFacts.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/extractFormat|EXTRACT_FORMAT|visual_extract_format|aggregateCount/);
    }
  });
});
```

In `apps/server/app/flows/visualize-document/start.test.ts`, inside `describe("rerun and the retry sweep", ...)` after its first test, add:

```ts
  it("notes a user's re-run for the extract step (so it can extract again), and never a boot pass's", async () => {
    const f = fake();
    const reextract = new Set<string>();
    const r = ref();
    const starter = loomVisualsStarter(f.runtime, flow, { runs: runsStore(), reextract });
    expect(await starter.rerun(r, 2)).toEqual({ kind: "started", rerun: 1 });
    expect([...reextract]).toEqual([visualizeExecutionId(r.userId, r.documentId, 2, 1)]);

    // a boot sweep's retry pass re-runs another document: it is not the user's, so nothing is noted for it
    const doc: ReadyDocument = { ...ref(), generation: 1 };
    const sweepRuntime = {
      cancel: vi.fn(),
      start: vi.fn(
        async (_f: unknown, _i: unknown, o: { executionId: string }) =>
          ({ executionId: o.executionId, waitForCompletion: async () => {} }) as never,
      ),
    } as unknown as Pick<WorkflowRuntime, "start" | "cancel">;
    const sweeper = loomVisualsStarter(sweepRuntime, flow, {
      runs: runsStore(),
      reextract,
      retry: async (after) => (after === "00000000-0000-0000-0000-000000000000" ? [doc] : []),
    });
    expect(await sweeper.sweep()).toBe(1);
    expect(sweepRuntime.start).toHaveBeenCalledTimes(1);
    expect(reextract.size).toBe(1); // still only the user's
  });

  it("notes nothing when the visuals role is off (nothing starts)", async () => {
    const f = fake();
    const reextract = new Set<string>();
    const off = loomVisualsStarter(f.runtime, flow, { runs: runsStore(), reextract, enabled: false });
    expect(await off.rerun(ref(), 1)).toEqual({ kind: "disabled" });
    expect(reextract.size).toBe(0);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/visualize-document/extract.test.ts app/flows/visualize-document/start.test.ts`
Expected: FAIL (the extract step ignores `reextract` and the stamp; the starter has no such option).

- [ ] **Step 3: Implement the extract step's branch**

In `apps/server/app/flows/visualize-document/extract.ts`: add `EXTRACT_FORMAT` to the `./facts` import; change `ExtractDeps.facts` to `Pick<VisualFactStore, "replace" | "list" | "aggregateCount" | "extractFormat">`; add to `ExtractDeps` after `afterDone`:

```ts
  /**
   * Execution ids of re-runs the USER asked for (the starter's `rerun`; a boot pass never notes one). A noted re-run extracts
   * again when the document's stored extraction predates this format (`extractFormat` is missing or not `EXTRACT_FORMAT`),
   * which is how an existing document gets its timeline and relations once (spec D5). In-process only: a run recovered after a
   * crash has no note and re-plans over what is stored.
   */
  reextract?: Set<string>;
```

and replace the `if (executionId !== undefined && id && rerun > 0) { ... }` block with:

```ts
      if (executionId !== undefined && id && rerun > 0) {
        // The starter's notes are read once and removed here (stored facts or not), so the sets never fill up over a large boot.
        const noted = deps.afterDone?.delete(executionId) === true;
        const asked = deps.reextract?.delete(executionId) === true;
        const stored = await deps.facts.list(ref);
        // A timeline or relations fact is a stored fact too: the model already answered for this document.
        const held = await deps.facts.aggregateCount(ref);
        // The user's own re-run of a document whose extraction predates this format (no stamp, or an older one) extracts once
        // more, and the extraction stamps it (spec D5: re-extract once). Every other re-run re-plans over what is stored,
        // a boot pass's included; so does a second press, and the re-run of a document a c2 extraction stamped.
        const predates = asked && (await deps.facts.extractFormat(ref)) !== EXTRACT_FORMAT;
        if (!predates) {
          if (stored.length > 0 || held > 0)
            return { count: stored.length, ...(held > 0 && { aggregates: held }), model };
          // The new run is recorded `running` right after it starts, which replaces the previous state: the starter's note
          // is the sure source; the reader only helps if it runs before this run's own `running` record lands.
          const last = noted ? null : await deps.runs?.last(ref, ref.documentId, id.generation);
          if (noted || (last?.state === "done" && last.run < rerun)) return { count: 0, model };
        }
      }
```

The stamp itself is written by `PgVisualFacts.replace` (Task 2), in the extraction's own transaction, so this step writes nothing extra. Chat's turn extraction (`visualize-turn`) calls `askForFacts` and its own store; it never reaches this branch or the stamp.

- [ ] **Step 4: Implement the starter, the deps and the composition**

In `apps/server/app/flows/visualize-document/start.ts`:

4a. In `VisualsStarterOptions`, after `afterDone?: Set<string>;` add:

```ts
  /**
   * Shared with the extract step (`ExtractDeps.reextract`): the execution ids of re-runs the USER asked for (`rerun`, the
   * route's call), so the step extracts again when the stored extraction predates `EXTRACT_FORMAT`. A boot pass never notes
   * one. Ids only; a lost note just means the run re-plans.
   */
  reextract?: Set<string>;
```

4b. In the destructuring inside `loomVisualsStarter`, add `reextract,` after `afterDone,`.

4c. Replace the head of `rerunWith` and the probe callback:

```ts
  const rerunWith = async (
    ref: VisualizeRef,
    generation: number,
    assumeDone = false,
    byUser = false,
  ): Promise<VisualsRerun & { handle?: ExecutionHandle }> => {
```

and, inside `tracker.probe(key, last?.run ?? 0, (n) => { ... })`, add after the `if (wasDone && afterDone) { ... }` block and before `return startOne(ref, generation, n);`:

```ts
        if (byUser && reextract) {
          if (reextract.size >= 1000) reextract.clear(); // ids only; a lost note just means the run re-plans
          reextract.add(visualizeExecutionId(ref.userId, ref.documentId, generation, n));
        }
```

4d. In the route's `rerun`, change `rerunWith(ref, generation)` to `rerunWith(ref, generation, false, true)`:

```ts
    const { handle: _handle, ...answer } = await pend(ref, rerunWith(ref, generation, false, true));
```

4e. In the `VisualsStarter` interface, extend the comment of `rerun`: after "The run re-plans over the stored facts and extracts only when there are none." add " The one exception is a re-run the user asked for (this method, not a boot pass): it extracts again when the document's stored extraction predates the current format (spec D5, re-extract once)."

In `apps/server/app/flows/visualize-document/deps.ts`, after `afterDone?: Set<string>;` in `VisualizeDeps` add:

```ts
  /** The execution ids of re-runs the user asked for, shared with the starter (`VisualsStarterOptions.reextract`): the extract step reads and removes its note. */
  reextract?: Set<string>;
```

In `apps/server/app/compose.ts`: after `const afterDone = new Set<string>();` add

```ts
  const reextract = new Set<string>(); // re-runs the user asked for: the extract step extracts again when the stored extraction predates c2
```

add `reextract,` after `afterDone,` in `visualize.deps` (the object that has `runs: visualRuns, afterDone,`), and add `reextract,` after `afterDone,` in the `loomVisualsStarter(app.runtime, visualize.flow, { ... })` options.

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/visualize-document app/documents/visualsRetry.pg.test.ts` (with `set -a; . ./.env; set +a` first for the pg suite)
Expected: PASS.

- [ ] **Step 6: Whole-repo verification and commit**

Run: `pnpm typecheck && pnpm typecheck:tests && pnpm lint`
Expected: clean.

```bash
git add apps/server/app/flows/visualize-document/extract.ts apps/server/app/flows/visualize-document/extract.test.ts apps/server/app/flows/visualize-document/start.ts apps/server/app/flows/visualize-document/start.test.ts apps/server/app/flows/visualize-document/deps.ts apps/server/app/compose.ts
git commit -m "feat(visuals): re-extract once, on a user's re-run of a pre-c2 document"
```

---

### Task 6: End to end, rollout proof, erasure, web and docs

**Files:**
- Modify: `apps/server/app/documents/visuals.e2e.pg.test.ts`
- Modify: `apps/server/app/flows/visualize-document/rollout.pg.test.ts`
- Modify: `apps/server/app/erasure/e2eSupport.ts`
- Modify: `apps/web/src/ui/elements.test.ts`
- Modify: `docs/architecture.md`, `docs/specs/2026-11-08-document-visuals-design.md`, `docs/operations/cloud-deploy.md`

**Interfaces:**
- Consumes: everything above (the whole feature), `startIngestStack({ visuals: true })`, `PgVisualFacts`, `pgStaleFormatDocuments`, `factFormatFingerprint`.
- Produces: nothing later tasks use.

- [ ] **Step 1: Write the end-to-end tests**

In `apps/server/app/documents/visuals.e2e.pg.test.ts`:

1. Extend the imports: `import { factFormatFingerprint } from "@docmind/experiences";` and change `import { visualizeExecutionId } from "../flows/visualize-document/start";` to `import { pgStaleFormatDocuments, visualizeExecutionId } from "../flows/visualize-document/start";`.
2. Add, inside the `describe.skipIf(!PG_URL)` block after the existing "a short flat document gets neither an outline nor an entity map" test (it uses the block's `upload`, `visualizeOutcome`, `visualizeEnd`, `hydrate`, `get`, `detail`, `eventLog` helpers):

```ts
  const NARRATIVE = [
    "Zebra-Chronicle: In January 2024 Acme Holdings acquired Beta Works.",
    "By Q3 2025 Cora Lindqvist led the integration of Project Orion.",
    "On 2026-02-14 Acme Holdings opened the Lisbon office.",
  ].join(" ");
  const NARRATIVE_SECRETS = [
    "Acme Holdings acquired Beta Works",
    "Integration of Project Orion begins",
    "Lisbon office opens",
    "Cora Lindqvist",
    "Project Orion",
    "Beta Works",
    "January 2024",
    "Q3 2025",
    "14 February 2026",
  ];

  /**
   * A visuals model for the narrative documents: it finds no chart facts, and a timeline and relations in a document that
   * carries `Zebra-Chronicle` while `state.aggregates` is on (it counts its extraction calls), and it plans whatever
   * aggregate capabilities the prompt offers, plus the connections section when `state.connections` is on.
   */
  function stubNarrative(
    claude: FakeAnthropic,
    state: { aggregates: boolean; extractions: number; connections?: boolean },
  ) {
    claude.reply((body) => {
      const system = typeof body.system === "string" ? body.system : JSON.stringify(body.system);
      const text = JSON.stringify(body.messages);
      if (system.includes("You extract facts")) {
        state.extractions++;
        const chunk = CHUNK_ID.exec(text)?.[1];
        if (!state.aggregates || !chunk || !text.includes("Zebra-Chronicle"))
          return { text: '{"facts":[]}' };
        return {
          text: JSON.stringify({
            facts: [],
            timeline: {
              events: [
                {
                  when: "January 2024",
                  date: "2024-01",
                  label: "Acme Holdings acquired Beta Works",
                  chunkIds: [chunk],
                },
                {
                  when: "Q3 2025",
                  date: "2025-Q3",
                  label: "Integration of Project Orion begins",
                  chunkIds: [chunk],
                },
                {
                  when: "14 February 2026",
                  date: "2026-02-14",
                  label: "Lisbon office opens",
                  chunkIds: [chunk],
                },
              ],
            },
            relations: {
              links: [
                { from: "Acme Holdings", rel: "acquired", to: "Beta Works", chunkIds: [chunk] },
                { from: "Cora Lindqvist", rel: "leads", to: "Project Orion", chunkIds: [chunk] },
                { from: "Acme Holdings", rel: "opened", to: "Lisbon office", chunkIds: [chunk] },
              ],
            },
          }),
        };
      }
      const widget = (id: string, type: string, capability: string, path: string) => ({
        id,
        type,
        label: id,
        span: 12,
        props: {},
        binding: { capability, arguments: {}, path, priority: "P1" },
      });
      const nodes = [
        ...(state.connections ? [CONNECTIONS_PLAN_NODE] : []),
        ...(text.includes("fact-18")
          ? [widget("timeline", "DocumentTimeline", "fact-18", "nodes")]
          : []),
        ...(text.includes("fact-19")
          ? [widget("relations", "Relationships", "fact-19", "edges")]
          : []),
      ];
      return { text: JSON.stringify({ summary: "The story", nodes }) };
    });
  }

  it("a narrative document gets a timeline and relationships from its one extraction call, a citation opens the passage, boot re-plans nothing, and nothing is plaintext", async () => {
    const st = await startIngestStack({ visuals: true });
    stacks.push(st);
    const state = { aggregates: true, extractions: 0 };
    stubNarrative(st.visualsClaude as FakeAnthropic, state);
    const ada = await st.signUpAndLogIn("ada@example.com");
    const id = await upload(st, ada.cookie, NARRATIVE, { visuals: true, name: "chronicle.txt" });
    expect(await visualizeOutcome(st, ada.userId, id)).toBe("done");
    expect(state.extractions).toBe(1); // the aggregates cost no second call
    const ref = { tenantId: ada.tenantId, userId: ada.userId, documentId: id };
    const facts = new PgVisualFacts(st.app, st.fields);
    // No headings and no entities (ingest is keyless): only the model's two aggregates exist.
    expect((await facts.listAll(ref)).map((f) => [f.ordinal, f.kind])).toEqual([
      [18, "timeline"],
      [19, "relations"],
    ]);
    expect(await facts.list(ref)).toEqual([]); // chat's facts stay extracted-only
    expect(await facts.aggregateCount(ref)).toBe(2);

    const timeline = (await hydrate(st, ada.cookie, id, "fact-18")) as {
      state: string;
      value: {
        layout: string;
        timeFormat: unknown;
        nodes: { label: string; at: string }[];
        refs: { id: string }[];
      };
    };
    expect(timeline.state).toBe("ready");
    expect(timeline.value.layout).toBe("timeline");
    expect(timeline.value.timeFormat).toEqual({ granularity: "day" });
    expect(timeline.value.nodes.map((n) => [n.label, n.at])).toEqual([
      ["January 2024 · Acme Holdings acquired Beta Works", "2024-01-01"],
      ["Q3 2025 · Integration of Project Orion begins", "2025-07-01"],
      ["Lisbon office opens", "2026-02-14"],
    ]);
    const passages = (
      await st.db.owner.query("SELECT id FROM chunks WHERE document_id = $1 ORDER BY ordinal", [id])
    ).rows.map((r) => r.id as string);
    const cited = timeline.value.refs.map((r) => r.id.split(":")[1] as string);
    expect(cited.length).toBeGreaterThan(0);
    for (const c of cited) expect(passages).toContain(c);
    const source = await get(st, ada.cookie, `/api/documents/${id}/source?passage=${cited[0]}`);
    expect(source.status).toBe(200);
    expect(await source.json()).toMatchObject({ focus: expect.anything() });

    const relations = (await hydrate(st, ada.cookie, id, "fact-19")) as {
      state: string;
      value: {
        layout: string;
        nodes: { label: string }[];
        edges: { label: string }[];
        refs: unknown[];
      };
    };
    expect(relations.state).toBe("ready");
    expect(relations.value.layout).toBe("network");
    expect(relations.value.nodes.map((n) => n.label).sort()).toEqual([
      "Acme Holdings",
      "Beta Works",
      "Cora Lindqvist",
      "Lisbon office",
      "Project Orion",
    ]);
    expect(relations.value.edges.map((e) => e.label).sort()).toEqual(["acquired", "leads", "opened"]);
    expect(relations.value.refs.length).toBeGreaterThan(0);

    // D5: the run is stamped with the current fingerprint (unchanged by c2), so the boot stale pass lists nothing
    const stamped = await st.db.owner.query(
      "SELECT format FROM visual_runs WHERE document_id = $1",
      [id],
    );
    expect(stamped.rows).toEqual([{ format: factFormatFingerprint() }]);
    expect(await pgStaleFormatDocuments(st.app)("00000000-0000-0000-0000-000000000000", 10)).toEqual(
      [],
    );

    // Nothing sealed is readable: the rows, and every execution's raw event log.
    const rows = await st.db.owner.query(
      "SELECT kind, fact_enc::text AS t FROM visual_facts WHERE document_id = $1 ORDER BY ordinal",
      [id],
    );
    expect(rows.rows.map((r) => r.kind)).toEqual(["timeline", "relations"]);
    for (const r of rows.rows) for (const s of NARRATIVE_SECRETS) expect(r.t).not.toContain(s);
    const log = await eventLog(st);
    expect(log.length).toBeGreaterThan(0);
    assertNoPlaintext(log, NARRATIVE_SECRETS);
  }, 180_000);

  it("a flat document gets neither a timeline nor relationships", async () => {
    const st = await startIngestStack({ visuals: true });
    stacks.push(st);
    const state = { aggregates: true, extractions: 0 };
    stubNarrative(st.visualsClaude as FakeAnthropic, state);
    const ada = await st.signUpAndLogIn("ada@example.com");
    const id = await upload(st, ada.cookie, `${NO_FACTS} A short note with no dates and no parties.`, {
      visuals: false,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await visualizeOutcome(st, ada.userId, id)).toBe("empty");
    } finally {
      warn.mockRestore();
    }
    expect(state.extractions).toBe(1);
    const left = await st.db.owner.query("SELECT 1 FROM visual_facts WHERE document_id = $1", [id]);
    expect(left.rowCount).toBe(0);
    expect(await (await detail(st, ada.cookie, id)).text()).not.toContain('"id":"visuals"');
  }, 120_000);

  it("re-extract once: a pre-c2 document gets both diagrams on the user's first re-run; a stamped document, and every later re-run, only re-plan", async () => {
    const st = await startIngestStack({ visuals: true });
    stacks.push(st);
    // The model of before c2 (facts only) and a connections-only plan: the first run ends `done`, so a plain re-run would
    // re-plan and never extract (the extract step's rule); only the marker lets the user's press extract again.
    const state = { aggregates: false, extractions: 0, connections: true };
    stubNarrative(st.visualsClaude as FakeAnthropic, state);
    const ada = await st.signUpAndLogIn("ada@example.com");
    const id = await upload(st, ada.cookie, NARRATIVE, { visuals: true, name: "chronicle.txt" });
    expect(await visualizeOutcome(st, ada.userId, id)).toBe("done");
    expect(state.extractions).toBe(1);
    const ref = { tenantId: ada.tenantId, userId: ada.userId, documentId: id };
    const facts = new PgVisualFacts(st.app, st.fields);
    expect(await facts.aggregateCount(ref)).toBe(0);
    // A new upload stamps the extraction format.
    expect(await facts.extractFormat(ref)).toBe("docmind.extract@2");

    const press = async (rerun: number) => {
      const events = await st.events(ada.cookie);
      try {
        const retry = await fetch(`${st.base}/api/documents/${id}/visuals/retry`, {
          method: "POST",
          headers: { cookie: ada.cookie },
        });
        expect(retry.status).toBe(202);
        await st.until(events, id, () => true);
      } finally {
        events.close();
      }
      expect(await visualizeEnd(st, ada.userId, id, rerun)).toEqual({ outcome: "done" });
    };
    state.aggregates = true; // the model now answers with the new fields
    await press(1); // a document a c2 extraction stamped: a re-plan only
    expect(state.extractions).toBe(1);
    expect(await facts.aggregateCount(ref)).toBe(0);

    // Make it a document extracted before c2: no stamp.
    await st.db.owner.query("UPDATE documents SET visual_extract_format = NULL WHERE id = $1", [id]);
    await press(2); // the first re-run of a pre-c2 document extracts, once
    expect(state.extractions).toBe(2);
    expect((await facts.listAll(ref)).map((f) => [f.ordinal, f.kind])).toEqual([
      [18, "timeline"],
      [19, "relations"],
    ]);
    expect(await facts.extractFormat(ref)).toBe("docmind.extract@2");
    expect(((await hydrate(st, ada.cookie, id, "fact-18")) as { state: string }).state).toBe("ready");

    await press(3); // every later re-run is a re-plan
    expect(state.extractions).toBe(2);
    expect(await facts.aggregateCount(ref)).toBe(2);
  }, 300_000);
- [ ] **Step 2: Write the rollout proof**

In `apps/server/app/flows/visualize-document/rollout.pg.test.ts` add `vi` to the vitest import, and append inside the `describe.skipIf(!PG_URL)` block:

```ts
  it("D5 (timeline and relations): a document planned before c2, stamped with the current fingerprint, is not listed by the stale pass, and a boot sweep re-plans only the one stamped with an older format", async () => {
    // The literal is the fingerprint on `main` before the c2 release: if a change moves factFormatFingerprint(), this fails.
    const C1_FORMAT =
      "docmind:visual.facts@1+docmind:turn.facts@1+docmind:doc.connections@1+docmind.structure@1";
    expect(factFormatFingerprint()).toBe(C1_FORMAT);
    const runs = new PgVisualRuns(app);
    const seed = async (fingerprint: string, age: number, format: string) => {
      const id = await seedDoc(owner, app, fields, ALICE, fingerprint, age);
      const g = Number(
        (await owner.query("SELECT ingest_generation FROM documents WHERE id = $1", [id])).rows[0]
          .ingest_generation,
      );
      await seedRow(
        owner,
        ingestExecutionId(U1, id, g),
        id,
        U1,
        '{"status":"ready","step":"finalize","code":null}',
      );
      await runs.record({ userId: U1, documentId: id, generation: g, run: 0 }, "done", undefined, format);
      return { id, g };
    };
    const current = await seed("e".repeat(64), 610, C1_FORMAT);
    const older = await seed(
      "d".repeat(64),
      611,
      "docmind:visual.facts@1+docmind:turn.facts@1+docmind:doc.connections@1", // before c1: the control
    );
    const listed = (await pgStaleFormatDocuments(app)(NIL, 50)).map((d) => d.documentId);
    expect(listed).toContain(older.id); // the control: the pass does list a stale document
    expect(listed).not.toContain(current.id);

    // A boot sweep over the real stale source re-plans the stale document and nothing for the current one.
    const start = vi.fn(
      async (_f: unknown, _i: unknown, o: { executionId: string }) =>
        ({ executionId: o.executionId, waitForCompletion: async () => {} }) as never,
    );
    const starter = loomVisualsStarter(
      { start, cancel: vi.fn() } as unknown as Pick<WorkflowRuntime, "start" | "cancel">,
      visualizeDocumentFlow(),
      { stale: pgStaleFormatDocuments(app), runs },
    );
    expect(await starter.sweep()).toBe(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect((start.mock.calls[0] as unknown[])[2]).toMatchObject({
      executionId: visualizeExecutionId(U1, older.id, older.g, 1),
    });
  });
```

with the import `import { loomVisualsStarter, pgStaleFormatDocuments, visualizeExecutionId } from "./start";` already present in the file (it imports all three), and `vi` added to `import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";`.

- [ ] **Step 3: Extend the erasure scan**

In `apps/server/app/erasure/e2eSupport.ts`:

3a. Add `import { PgVisualFacts } from "../flows/visualize-document/pgFacts";` beside the other `../` imports.

3b. In `seedUser`, extend the tag declaration `const [inDoc, inFile, inAsk, inAnswer, inTitle, inTag, inSuggest] = [...]` by adding two entries: change the destructuring to `const [inDoc, inFile, inAsk, inAnswer, inTitle, inTag, inSuggest, inEvent, inParty] = [` and append to the array literal, after the `sentinel-suggest-` line:

```ts
    `sentinel-event-${tag()}`,
    `sentinel-party-${tag()}`,
```

3c. After `const passageId = (...).rows[0].id as string;` add:

```ts
  // A timeline and relations the model found: sealed under the user's key, so no event label, written date, party name or
  // relation phrase may be anywhere once the key is gone. The row count proves the scan has something to find the absence of.
  await new PgVisualFacts(st.app, st.fields).replace(ref, [
    {
      kind: "timeline",
      events: [
        { at: "2024-03-01", precision: "month", when: `March 2024 ${inEvent}`, label: `Launch ${inEvent}`, chunkId: passageId },
        { at: "2025-07-01", precision: "quarter", when: "Q3 2025", label: `Review ${inEvent}`, chunkId: passageId },
        { at: "2026-02-14", precision: "day", when: "14 February 2026", label: `Close ${inEvent}`, chunkId: passageId },
      ],
      chunkIds: [passageId],
      ordinal: 18,
    },
    {
      kind: "relations",
      entities: [`Acme ${inParty}`, `Beta ${inParty}`, "Gamma"],
      links: [
        { from: 0, to: 1, rel: `acquired ${inParty}`, chunkId: passageId },
        { from: 1, to: 2, rel: "supplies", chunkId: passageId },
        { from: 0, to: 2, rel: "owns", chunkId: passageId },
      ],
      chunkIds: [passageId],
      ordinal: 19,
    },
  ]);
  expect(
    (await st.db.owner.query("SELECT count(*)::int AS n FROM visual_facts WHERE owner_id = $1", [who.userId]))
      .rows[0].n,
  ).toBe(2);
```

3d. In the returned object change `sentinels: [inDoc, inFile, inAsk, inAnswer, inTitle, inTag, inSuggest],` to `sentinels: [inDoc, inFile, inAsk, inAnswer, inTitle, inTag, inSuggest, inEvent, inParty],`.

3e. In `assertErased`, add `"public.visual_facts",` to the list of tables whose columns the scan must have read (the array after `"public.document_tag_suggestions",`), and after the "1b" tag-table loop add:

```ts
  // 1c. The visual facts hold nothing of the user: their rows cascade from the document and the user, and the labels were
  //     sealed under the destroyed key (the scan above found neither sentinel in any column, and none of the user's rows is left).
  const factsLeft = await db.owner.query(
    "SELECT count(*)::int AS n FROM visual_facts WHERE owner_id = $1",
    [user.userId],
  );
  expect(factsLeft.rows[0].n).toBe(0);
```

- [ ] **Step 4: Web test**

In `apps/web/src/ui/elements.test.ts`, inside `describe("the structure widgets", ...)` add after the existing test:

```ts
  it("the timeline and the relationships are Diagram entries too (loom-ui's lu-diagram draws the timeline and network layouts)", () => {
    createViewRegistry();
    for (const name of ["DocumentTimeline", "Relationships"]) {
      const entry = mergedCatalog().entries.find((e) => e.name === name);
      expect(entry, name).toBeDefined();
      const kind = (entry?.surfaces as { web: { kind: string } }).web.kind;
      expect(kind).toBe("Diagram");
      expect(customElements.get(TAG[kind] as string)).toBeDefined();
    }
  });
```

No registration change is needed: `lu-diagram` is already registered for c1 (`registerDiagramWidgets` in `apps/web/src/ui/session.ts`), and the renderer at loom-ui fc34435 draws both layouts (`lu-diagram.ts` reads `timeFormat` and the timeline axis).

- [ ] **Step 5: Run to verify**

Run (pg env set first):

```
set -a; . ./.env; set +a
pnpm --filter @docmind/server exec vitest run app/documents/visuals.e2e.pg.test.ts app/flows/visualize-document/rollout.pg.test.ts app/erasure
pnpm --filter @docmind/web exec vitest run src/ui/elements.test.ts
```

Expected: PASS, the summary showing the pg and e2e tests passed (not skipped). The first e2e is the one place the whole chain runs: extraction answer, normalisers, sealed store, planner, fit, commit, hydrate and citation.

- [ ] **Step 6: Docs**

6a. `docs/architecture.md`:

- In the §7.1 mermaid diagram replace `extract["visualize-extract<br/>LLM facts, grounding check"]` with `extract["visualize-extract<br/>LLM facts, timeline, relations, grounding check"]`.
- Replace `The SQL is in `infra/migrations` (0001–0036).` with `The SQL is in `infra/migrations` (0001–0037).`
- Insert this bullet immediately before the line that begins `- **Plan.** A loom-ui planner decides the nodes`:

```
- **Timeline and relations.** The document extraction call (`askForExtraction`; chat keeps `askForFacts` and its own prompt, so a chat request is unchanged) also returns two optional top-level fields next to `facts`: `timeline` (at most 40 events: the date as written, the date as `YYYY`, `YYYY-Qn`, `YYYY-MM` or `YYYY-MM-DD`, a label, the cited passages) and `relations` (at most 30 links: from, a short relation phrase, to, the cited passages). They are validated item by item on the server (`dates.ts`, `timeline.ts`, `relations.ts`): a date must be real at its precision (year 1000 to 9999), relative or undated phrases are dropped, text is stripped of control and invisible characters and clipped (label 80, relation 40, party 80, written date 40), every citation must be a passage of this document, events are deduped by date, precision and label and sorted by date then by the first cited passage, links are deduped by (from, relation, to) with self-links dropped, parties are deduped by normalised name, and fewer than 3 events or 3 links is none. A bad item never fails the run or costs another fact. The survivors are two sealed facts in `visual_facts`: the **timeline** at ordinal 18 and the **relations** at ordinal 19. Ordinal ownership: `PgVisualFacts.replace` (extraction) owns 0..15 and 18..19 together, so a new extraction with no timeline removes the old one, `replaceStructure` owns 16..17, and a re-plan that skips extraction never writes, so 18..19 survive it. Migration 0037 widens the `visual_facts` ordinal CHECK to 0..19 and pins every kind to its own ordinal (`visual_facts_kind_ordinal_check`: extracted kinds below 16, `outline` 16, `cooccurrence` 17, `timeline` 18, `relations` 19). `list` (chat, the extraction re-plan check) still returns ordinals below 16 only; `aggregateCount` counts the rows without opening them. The answer is longer, so `VISUALS_MAX_TOKENS` is 16 000. The extract step's prompt and output are not part of Loom's flow hash (which covers the flow id, version, steps, retry and timeout), so `visualize-document` stays 1.1.0 with an unchanged hash (`flowHash.test.ts` pins it). The reshapers (`structureShapes.ts`) turn the timeline into a loom-ui `Diagram` with the `timeline` layout (a node per event, `at` the ISO first day, the label prefixed with the written date unless the event is dated to the day, `timeFormat` date-only) and the relations into a `network` (a node per party, a directed edge per link labelled with the relation); both pass `diagramProblems`, and `refs` carry at most 16 cited passages. Rollout is on demand: a new upload or re-ingest gets them from its own extraction, and `factFormatFingerprint()` is unchanged, so the boot stale pass re-plans nothing. An existing document gets them when the user presses re-run, once: the route's re-run (never a boot pass) notes its execution id, and the extract step then extracts again only when the document's `documents.visual_extract_format` (added by migration 0037, set by the extraction write in its own transaction, NULL for a document extracted before c2) is missing or is not `docmind.extract@2`; the extraction stamps it, so every later re-run is a re-plan. Chat's turn extraction never writes or reads the stamp.
```

- In the **Plan.** bullet, append at its end: ` The timeline and relations are offered the same way (counts only; the sample holds placeholder nodes and edges, with a neutral date for the timeline), and `VISUALS_INTENT` says to show a timeline when the document narrates dated events and a relationships diagram when it states how parties relate, and to leave them out for a few scattered dates or links.`
- In the **Fact-format re-plan.** bullet, append: ` The timeline and relations release changes neither the fingerprint nor the flow hash, so it re-plans nothing at boot (`rollout.pg.test.ts` pins the fingerprint and that the stale pass and a boot sweep start nothing for a document stamped with it).`
- In the **Connections.** bullet replace `(both loom-ui `Diagram`), is `docmind.visuals.v3`.` with `and `DocumentOutline`, `EntityMap`, `DocumentTimeline` (the `timeline` layout) and `Relationships` (the `network` layout), all loom-ui `Diagram`, is `docmind.visuals.v4`; its first eight entries are byte for byte v3's (a stored plan carries no catalogue id, so a v3 plan still hydrates under v4, and the catalogue id is not part of the fingerprint).` — and remove the now-duplicated words `and `DocumentOutline` and `EntityMap`` just before it, so the sentence reads: "the document catalogue, which adds the two connections types, `DocumentOutline`, `EntityMap`, `DocumentTimeline` (the `timeline` layout) and `Relationships` (the `network` layout), all loom-ui `Diagram`, is `docmind.visuals.v4`; ...".
- In the **Retry.** bullet replace `A re-run re-plans over the stored `visual_facts` and extracts only when the document has none; it also skips extraction` with `A re-run re-plans over the stored `visual_facts` and extracts only when the document has none, except a re-run the user asked for (the route, not a boot pass), which also extracts when the document's `visual_extract_format` is missing or older than `docmind.extract@2` (once: the extraction stamps it); a re-run also skips extraction`.

6b. `docs/specs/2026-11-08-document-visuals-design.md`: append at the end of the file:

```
### As built: structure diagrams, phase c2

- The document extraction call (`askForExtraction`) returns optional `timeline` and `relations` fields beside `facts`; chat's
  extraction is unchanged. Items are validated one by one (`dates.ts`, `timeline.ts`, `relations.ts`) and a bad item never costs
  a fact. Two sealed aggregate facts are stored at ordinals 18 (`timeline`) and 19 (`relations`). `PgVisualFacts.replace`
  owns 0..15 and 18..19 together, `replaceStructure` owns 16..17, and a re-plan that skips extraction keeps 18..19. Migration
  0037 widens the ordinal CHECK to 0..19 and pins each kind to its own ordinal.
- `DocumentTimeline` (Diagram, `timeline` layout) and `Relationships` (Diagram, `network` layout) join the document catalogue,
  now `docmind.visuals.v4`; the eight v3 entries are unchanged byte for byte and the chat catalogue is byte-identical (sha256
  guard). `VISUAL_SHAPES` serves them only at ordinals 18 and 19.
- Rollout is on demand: `factFormatFingerprint()` and the `visualize-document` 1.1.0 flow hash (the extract step's prompt and
  output are not part of it) are both unchanged, so nothing re-plans at boot. A new upload or re-ingest gets both diagrams from
  its own extraction; an existing document gets them when the user presses re-run (the route's re-run extracts once more when
  the document's `documents.visual_extract_format` is missing or older than `docmind.extract@2`, and the extraction stamps it, so
  later re-runs only re-plan; a boot pass never extracts).
- `VISUALS_MAX_TOKENS` is 16 000 for the longer answer. Do not roll back to the c1 build while any document has a timeline or
  relations row (`docs/operations/cloud-deploy.md`).
- Not done in c2: an automatic backfill, timelines or relationships in chat, cross-document timelines or relationship graphs,
  merging relationship nodes with the `entities` table, editing extracted events or links.
```

6c. `docs/operations/cloud-deploy.md`: insert after the bullet that begins `- **Do not roll back past the structure-diagrams release`:

```
- **The timeline and relationships release (migration 0037) needs a data step before a rollback.** `visualize-document` stays 1.1.0 with an unchanged flow hash (the extract step's prompt and output are not part of it; `apps/server/app/flows/visualize-document/flowHash.test.ts` pins it), so executions in flight resume on either build, and migration 0037 only widens CHECKs, so it is safe under old code. But the previous `visual_facts` reader rejects the `timeline` and `relations` rows (ordinals 18 and 19), so the load step and the document page's reader fail for every document that has one. Before rolling back, delete them as the owner role: `DELETE FROM visual_facts WHERE kind IN ('timeline', 'relations');` (a user's re-run makes them again after the roll forward).
```

- [ ] **Step 7: Browser check**

Per the project's workflow (check the feature in a real browser before the PR), run the app (the `run` skill; it needs a `visuals` model: `DOCMIND_VISUALS_PROVIDER`, optionally `DOCMIND_VISUALS_MODEL`, and `DOCMIND_PLANNER_DECISION_KEY`), sign in, and upload a text file containing:

```
In January 2024 Acme Holdings acquired Beta Works. By Q3 2025 Cora Lindqvist led the integration of Project Orion. On 14 February 2026 Acme Holdings opened the Lisbon office. Acme Holdings later partnered with Beta Works on the Lisbon launch, and Cora Lindqvist reports to Acme Holdings.
```

Open the document's Visuals tab and check, with screenshots: (1) a timeline with three dated events in date order, the quarter event reading "Q3 2025 · ..." and not as a single day, the day event reading as written; (2) a network of the named parties with a labelled arrow per relation; (3) activating a numbered source marker opens `/documents/<id>?passage=<passageId>` on that passage; (4) a document with no dates (a short prose note) shows neither diagram; (5) for a document uploaded before this release, pressing re-run adds both. Fix anything that fails before opening the PR.

- [ ] **Step 8: Full verification**

Run:
```
pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm build
set -a; . ./.env; set +a
pnpm --filter @docmind/experiences exec vitest run
pnpm --filter @docmind/web exec vitest run
pnpm --filter @docmind/server exec vitest run
```
Expected: all green; the server run includes the pg suites and the e2e (check the summary: pg tests passed, none skipped; a skipped pg test is not a pass). Re-check specifically: the chat guard (`pnpm --filter @docmind/experiences exec vitest run src/visuals.test.ts -t "chat"`) passes with the original sha256, `flowHash.test.ts` passes with the pinned hash, and `visualize-turn` suites pass untouched.

- [ ] **Step 9: Commit**

```bash
git add apps/server/app/documents/visuals.e2e.pg.test.ts apps/server/app/flows/visualize-document/rollout.pg.test.ts apps/server/app/erasure/e2eSupport.ts apps/web/src/ui/elements.test.ts docs/architecture.md docs/specs/2026-11-08-document-visuals-design.md docs/operations/cloud-deploy.md
git commit -m "test(visuals): c2 end to end, rollout proof and erasure scan; docs for phase c2"
```

---

## Self-Review (spec section to task)

| Spec section | Where it is implemented and tested |
|---|---|
| 1 Goal (timeline and relationships on the Visuals tab) | Tasks 3, 4, 6; e2e in Task 6 |
| 2 D1 (existing extraction call, no second call) | Task 4 (`askForExtraction`; extract and flow tests assert one model call); Task 6 e2e (`extractions` is 1) |
| 2 D2 (aggregates at 18 and 19, outside the 16-fact pool) | Task 2 (ordinals, `StoredEntry`, pg tests); Plan decisions (ordinal ownership table) |
| 2 D3 (precision, as written, relative phrases dropped) | Task 1 (`dates.ts`, `timeline.ts`); Task 3 (label shows `when`) |
| 2 D4 (relationships get their own entry, c1's map unchanged) | Task 3 (`Relationships` entry; the map's tests untouched) |
| 2 D5 (on demand, re-extract once, fingerprint unchanged) | Task 2 (the `documents.visual_extract_format` column and the stamping write, pg tests), Task 3 (fingerprint literal, v3 subset guard, v3 hydrate test), Task 5 (a user's re-run of a pre-c2 document extracts; a second re-run, a stamped document and a boot pass do not; chat never touches the stamp), Task 6 (`rollout.pg.test.ts`, e2e stamp and stale pass, e2e re-extract once) |
| 2 D6 (migration 0037) | Task 2 steps 5 and 7 (`pgFacts.pg.test.ts`: `timeline@3` and `figure@18` refused) |
| 2 D7 (flow version unchanged, hash pinned) | Task 4 step 1 (`flowHash.test.ts`) and finding F1 |
| 3 extraction answer and prompt | Task 4 (prompt test asserts every instruction: never infer, relative, 40, 30, cite) |
| 3 server validation: dates, text, citations, events, links, missing field | Task 1 (every rule has a boundary test); Task 4 (item-level drops never cost facts, windows merge, foreign citations) |
| 4 storage: kinds, migration, who replaces what | Task 2 (ownership test across all combinations; `list` extracted-only; sealed; owner-scoped; stale generation) |
| 4 "a re-plan that skips extraction keeps 18..19" | Task 2 (pg ownership test) and Task 4 (flow test: re-run keeps and offers them) |
| 5 `DocumentTimeline` (nodes, prefix, `timeFormat`, refs 16) | Task 3 (`structureShapes.test.ts`, `visuals.test.ts`) |
| 5 `Relationships` (nodes deduped, edges labelled, refs 16) | Task 1 (dedupe by normalised name, at most 60), Task 3 (shape, refs) |
| 5 reshapers pass `diagramProblems`; fit; placeholders | Task 3 (`DiagramValue.safeParse`, `fitsShape`, `fit.test.ts`, sample tests, plan with no `reshape-invalid`) |
| 5 catalogue v4, chat guard, intent | Task 3 (v4 id, chat sha256 unchanged, intent test) |
| 5 rollout: fingerprint unchanged, v3 plan hydrates under v4 | Task 3 (views test: v3 plan adopts and compiles), Task 6 (rollout pg test) |
| 6 privacy: sealed, no plaintext in logs/event log, planner counts only | Task 2 (sealed), Task 3 (no text in capabilities), Task 4 (planner request has no text), Task 6 (e2e event-log scan, erasure) |
| 6 erasure scan gains needles | Task 6 step 3 (`inEvent`, `inParty`, `visual_facts` scanned and emptied) |
| 6 cost: no extra call, no boot spending, one extraction per document once | Task 4 (one call), Task 6 (stale list empty, sweep starts nothing; the first re-run of a pre-c2 document extracts, later ones do not) |
| 7 testing: unit, reshapers, Postgres, flow, chat, e2e, browser | Tasks 1 to 6 (the flow's "key-store outage is retried" is in Task 4; the browser check is Task 6 step 7) |
| 8 out of scope | Not implemented: no backfill, no chat timelines, no cross-document graphs, no entity merge, no editing |

**Placeholder scan:** no "TBD", "TODO", "similar to" or "add appropriate"; every code step carries its code. The only non-code step is the browser check (a manual verification with exact input and expected results), which the workflow requires.

**Type consistency:** `TimelineDraft` and `RelationsDraft` (Task 1) match the zod `Timeline` and `Relations` (Task 2: `events` with `at/precision/when/label/chunkId`, `entities: string[]`, `links` with `from/to/rel/chunkId`), `AggregateFact`, `aggregateFacts` (Task 2) and `TimelineFact` and `RelationsFact` (Task 3) field for field; `TIMELINE_ORDINAL` 18 and `RELATIONS_ORDINAL` 19 are used by `extract.ts` (Task 4), the capability handles `fact-18` and `fact-19` (Tasks 3, 4, 6), the experiences `STRUCTURE_ORDINAL` map (Task 3, pinned equal by a `plan.test.ts` test) and the e2e hydrate handles (Task 6); `ExtractionWrite` is what `replace` takes (Task 2) and what `extract.ts` passes (Task 4); `aggregateCount` and `extractFormat` are declared in Task 2 (with `EXTRACT_FORMAT`, which only `PgVisualFacts.replace` writes and only the extract step's re-run branch reads), used by `extract.ts` (Tasks 4 and 5) and the e2e (Task 6); `ExtractResult.aggregates` (Task 4) is read by `flow.ts` (Task 4); `reextract` is one name in `ExtractDeps`, `VisualizeDeps`, `VisualsStarterOptions` and `compose.ts` (Task 5); `timelineDiagram` and `relationshipsDiagram` (Task 3) are called only from `visuals.ts` `TO` families `visual-timeline` and `visual-relations`, registered at 18 and 19 only.
