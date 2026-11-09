# Document visuals: ambient, planner-composed (design)

Date: 2026-11-08. Status: draft for review.

## 1. Goal

Help a reader grasp a document faster by showing, next to its summary, the visuals that make it
clearer than prose: its figures as charts and metric cards, and its key facts as tables. The visuals
are composed by a model through loom-ui's planner (`@loom-ui/planner`), in **ambient** mode: a
background Loom flow composes them after ingestion, outside any request, and the view replays the
recorded result with no model call.

This is sub-project 1 of two. Sub-project 2 (visuals inline in chat answers, composed ambiently
after a turn) gets its own spec and reuses the catalogue, capabilities and lineage built here.

Sub-project 1 ships in three steps on one design:

- **(a)** Figures and structured facts, with kinds loom-ui already draws. Specified in full here.
- **(b)** Cross-document visuals and in-place revision (section 9).
- **(c)** Structure diagrams, after a generic loom-ui `Diagram` kind (section 10).

## 2. Decisions

| Id | Decision |
|---|---|
| V1 | Extract, then plan. A model extracts typed, cited facts; the planner composes over them as data-provider capabilities. The planner never writes data into node props. |
| V2 | Ambient. Visuals are composed by a separate flow, `visualize-document`, started after `ingest-document` finishes. A document's `ready` state never waits for visuals. |
| V3 | Visuals are optional. The tab exists only when a lineage head exists; an empty, failed or disabled run leaves it hidden. |
| V4 | Every fact cites at least one chunk of its document, and every number in it must appear in a cited chunk's text. A fact that fails is dropped. |
| V5 | A separate, closed catalogue `docmind.visuals.v1`; the M6 catalogue is untouched. |
| V6 | Everything stored is per-user sealed: `visual_facts.fact_enc` under `FieldCrypto`, the lineage on the sealed event store. Erasure shreds it with the user's key. |
| V7 | Gaps in loom-ui are closed generically in loom-ui first (M6 D11). Step (a) needs one (V8); step (c) needs another. |
| V8 | **Prerequisite.** `@loom-ui/lineage` streams (`__loom_ui_lineage__:*`) sit in loom's reserved namespace, which `shredSubject` refuses, and lineage stores artifacts in the content store without per-subject access. Step (a) waits for a generic loom / loom-ui change that makes a lineage line erasable with its subject: events sealed under the subject's key and artifacts stored under the subject's content access. It has its own spec. |
| V9 | The Visuals tab is part of a per-document detail experience: the static detail view plus a "Visuals" panel holding the planner's nodes and providers, compiled per (document, visuals head) and cached. loom-ui has no experience-in-experience embedding. |
| V10 | `visualize-document` starts when the ingest-status fold turns a document `ready`, plus a boot sweep for ready documents without a visualize execution. The start is idempotent through its execution id. |

Approaches considered and rejected: the planner writing data inline into node props (charts require
a binding; data would sit outside per-user sealing; no drift detection), and fixed rules with no
planner (cannot judge what is worth showing; kept as a possible fallback, not built).

## 3. Trigger and flow

- Ingest has no commit point for `ready`: the `ingest-status` read model folds it from the
  `STEP_COMPLETED` event of `ingest-finalize`, and executions resumed by boot recovery have no
  scheduler completion handle. So a `VisualsStarter` subscribes to the status fold and starts
  `visualize-document` when a document turns `ready` (V10). At boot, after recovery starts, it sweeps
  ready documents that have no visualize execution. `ExecutionAlreadyExistsError` means "already
  started" and is ignored, as `chat-title/start.ts` does. Its `idle()` joins the shutdown
  `startsIdle`.
- `stepEffect` is generalised from ingest's steps (its step label, start input and generation
  guard become parameters) so both flows share one retry and failure policy.
- Input is ids only and strict: `{ tenantId, userId, documentId }`. The execution id is
  `executionIdFor(userId, "visualize-" + documentId)`, which is also the idempotency key.
- As built: steps `visualize-extract`, `visualize-load` and `visualize-commit` (granted in
  `security.ts`), with the planner's `ctx.decide` in the flow runner between load and commit (the
  planner needs the flow's context). The execution id carries the ingest generation
  (`visualize-<doc>[.<gen>]`). Visualize steps take their own gate (1 slot per tenant), never the
  ingest gate, so ingest never queues behind visuals; the boot sweep keeps at most 2 executions in
  flight.
- Output: `{ outcome: "done" | "empty" | "skipped" | "failed" | "document_gone", code? }`.
- Deleting a document cancels every generation of `visualize-document` as it does for ingest.
  `POST /api/documents/:id/retry` re-runs it. Boot recovery resumes an interrupted run through the
  `recovery.ts` pattern.

## 4. Model role

A new LLM role `visuals` in `apps/server/app/llm/roles.ts`, beside `chat`, `title`, `summary`,
`vision` and `visionPdf`: `DOCMIND_VISUALS_PROVIDER`, its model variable, and `off`. As built, the
role is OFF unless `DOCMIND_VISUALS_PROVIDER` is set explicitly (a shared `DOCMIND_LLM_PROVIDER` does
not turn it on), and turning it on also requires the deployment secret `DOCMIND_PLANNER_DECISION_KEY`
(keys the planner's recorded decision id). When it is off no visualize execution is started at all, and `llmWarnings` says
"visuals are off: DOCMIND_VISUALS_PROVIDER is off". The runbook `docs/operations/llm-providers.md`
gains the role.

## 5. Extraction (`visualize-extract`)

The step reads the document's chunks in order, at most `DOCMIND_SUMMARY_MAX_CHARS` of text (the
summarizer's cap), windowed as the summarizer does, and asks the
`visuals` model for JSON through the `llmJson.ts` helpers, validated by a strict zod schema.

Fact kinds (schema version 1):

| `kind` | Fields | Limits |
|---|---|---|
| `series` | `label`, `unit?`, `points: { x: string, y: number }[]` (`x` may be an ISO date) | 2 to 64 points |
| `figure` | `label`, `value: number`, `unit?`, `compare?: { label, value }` | |
| `factTable` | `title`, `columns: string[]`, `rows: string[][]` | 12 rows x 8 columns, 200 chars per cell |
| `structure`, `crossDoc` | reserved; rejected in schema version 1 | |

Every fact carries `chunkIds: string[]` (at least one, each a chunk of this document) and an
`ordinal`. At most 16 facts per document; extras are dropped in order.

**Grounding check (V4).** The check covers every number in a fact: `y`, `value` and
`compare.value`, plus every number written inside `label`, `title`, `columns`, `compare.label`,
series `x` and table cells. `unit` is excluded. Fact and text go through one normaliser before the
step looks for the number in the cited chunks' text. It handles:
- digit grouping (`1,200`, `1 200`; `1.200` reads as 1200);
- suffixes (`1.2k` grounds both 1.2 and 1200);
- percent forms (`12 %`, `12%`; `0.12` only when the fact's unit is `%`);
- leading currency signs;
- sign (a leading `-` or `−` is negative, a parenthesised number grounds either sign, and unsigned text grounds only non-negative values);
- an ISO-date series `x` grounds on its year alone.

A fact with any number not found is dropped, and the drop is counted, never logged with its
content.

**Storage.** Table `visual_facts`:

```
id uuid primary key, tenant_id uuid, owner_id uuid, document_id uuid,
kind text, ordinal int, fact_enc jsonb, chunk_ids uuid[], schema_version int
```

Under row-level security like `entities`; `fact_enc` is `FieldCrypto`-encrypted under the user's
key. A run replaces the document's rows in one transaction. With no surviving fact the flow ends
`empty` and the planner is not called.

Out of scope: facts from embedded images beyond the text the vision step already produced; editing
facts by hand.

## 6. Planning (`visualize-plan`)

**Catalogue `docmind.visuals.v1`** in `@docmind/experiences`, every entry resolved on `web` and
`terminal`:

| Entry | Kind | Binds |
|---|---|---|
| `FigureChart` | `BarChart` (`{ unit?, format?, bars: [{ label, value }] }`) | a `series` fact |
| `FigureTrend` | `TimeSeries` (`{ timeFormat, series: [{ label, unit?, points: [{ timestamp, value }] }] }`) | a `series` fact whose `x` values are dates |
| `KeyFigure` | `Kpi` (`{ value, unit?, label?, deltaPct? }`, `deltaPct` a fraction) | a `figure` fact |
| `FactTable` | `Table` (`{ columns, rows }`) | a `factTable` fact |

As built, a trend declares its time axis: `timeFormat: { granularity }` (no `timeZone`, so loom-ui reads a period in
UTC) is the coarsest granularity any label was written at (year > half > quarter > month > week > day), so "Q1 2026" to
"Q4 2026" is drawn as "Q1 2026".."Q4 2026" rather than as month ticks. Labels are normalised to ISO dates as before
(`visuals.ts` `toIso`); only date-only labels are accepted, so `datetime` and `week` are never produced.

These are loom-ui framework kinds (`FRAMEWORK_KINDS`); the terminal renderer draws all four.
Offered containers: `section` and `grid` (`PLAIN_CONTAINERS`).

**Capabilities.** One `CapabilityRef` per surviving fact: handle `fact-<ordinal>`, `kind: "docmind"`,
tool `visual.facts` version `1.0.0`, `toolSchemaHash` `docmind:visual.facts@1` (added to `PINS`).
All handles read the same target with the same arguments (`{ id }`), so the invoker's memo makes
one read per hydrate however many facts there are (the budget is 8 distinct reads per POST); each
handle's Named reshaper picks its fact and maps it to the value contract of the entry the planner
chose: one family per entry (`visual-bar-<n>`, `visual-trend-<n>`, `visual-kpi-<n>`, `visual-table-<n>`,
n 0 to 15); a fact that does not fit its widget gives the per-widget placeholder. Each capability's `sampleOutput` is its decrypted fact, and its `sensitivity` is `"sensitive"` (Loom's `DataClass`; DocMind has
no per-document class, and all user content is treated alike). Declaring it keeps the planner's
summary from being withheld. The host's read floor is `declaredToolClassesFrom(capabilities)`.

**Intent.** A fixed, versioned instruction carrying no document text: help a reader grasp this
document at a glance; show only what a visual makes clearer than prose; prefer fewer widgets; every
widget binds a fact. Fact values reach the model only as fenced, untrusted data, as
`ReferencePlanner` does.

**Call.** `new ReferencePlanner({ model, modelId })` with the `visuals` role's provider, then
`compose({ intent, catalog, capabilities, containers }, ctx)` with the step's execution context, so
the plan is one recorded `ctx.decide`. Error findings fail the attempt (the planner's two attempts).
As built in step (a) there is no step-level retry of planning: a model error is recorded in the
decision and the flow ends `failed` with `visuals-plan-invalid`. Zero nodes is a valid plan: the flow ends `empty`.
As built (retry item): a model that stayed unreachable (`LlmUnavailableError` through every attempt of the extract step, or
the planner's own attempts all ending in `model-error` for that class) ends `failed` with `visuals-model-unavailable`
instead of a thrown failure, and `POST /api/documents/:id/visuals/retry` re-runs the document as `<id>-r<n>`: it re-plans over
the stored facts and extracts only when there are none. The last run is recorded in `visual_runs` (migration 0030), the
detail response carries `visuals: { state }`, the progress stream a `visuals: "failed"` event, and the boot sweep re-runs
once the documents whose last run ended `visuals-model-unavailable`. A permanent model error still fails the execution.

**Decision sealing.** The plan is recorded as a `DECISION_RECORDED` event in the visualize
execution's log; the paths of the planner's recorded choice that hold ops and summary are added to
`SENSITIVE_EVENT_PATHS` in the same PR, and the raw-event content proof covers the new flow.

**Lineage** (after V8). `@loom-ui/lineage` with `eventStoreLineageStore` over DocMind's sealed
Postgres event store, and the erasable-line mechanism V8 delivers. Experience id
`visuals-<userId>-<documentId>` (ids only). First version: `start(genesis, by)` then `compose({
expectedHead, ops, by, summary, summaryClass })`, each op wrapped as a `RecordedOperation { op, by, at
}`; provenance from `plannerProvenance(plan, { agentId: "docmind-visualizer" })`. On `head-moved`,
retry once, then fail.

## 7. Serving and change delivery

- V9: `@docmind/experiences` gains `detailWithVisuals(visuals: Experience): Experience`, which
  builds the static detail view with a fourth `panel("visuals", "Visuals", …)` in its `tabs`
  holding the head's root children and providers. Without a head, the static detail is served.
- A new route `GET /api/ui/documents/:id/detail` returns that experience compiled for the surface,
  cached per (surface, visuals head hash); `POST /api/ui/hydrate` accepts `{ document: id }` in
  place of a view name to hydrate against it. `ViewSession` and the API client learn this second
  source; the web detail page uses it.
- The `fact-N` handles hydrate through the new invoker target `visual.facts`: one owner-scoped read
  under RLS that decrypts the document's facts, inside the existing limits (8 distinct reads, 4
  concurrent).
- Deferred (not built in step (a)): each widget's caption carrying its citations as reference
  markers (the generic loom-ui support from Task 176b). Facts keep their `chunkIds`, so this needs no
  data change.
- Status reaches the browser over SSE (`GET /api/documents/events`), not a poll.
  `DocumentProgressEvent` gains an optional `visuals: "ready"`; when `visualize-document` commits a
  head, the server sends it, and the open detail page calls `ViewSession.reload()` (which re-GETs
  the view), not `invalidate()`. `@loom-ui/changes` is deferred to step (b).

## 8. Failure, erasure, testing

**Failure.**

| Case | Result |
|---|---|
| Model unavailable / plan invalid | flow `failed`, `visuals-plan-invalid` (step (a) does not re-run it; deferred); tab hidden; ingest status untouched |
| A fact fails grounding | that fact dropped; others kept |
| A fact row gone at read time | per-widget error placeholder |
| Pin mismatch (`schemaDrift`) | per-widget placeholder; cannot occur from stored data, because served providers are rebuilt at every hydrate with the current pin. Handled instead by the format stamp below (as built) |

**Delete and erasure.** Deleting a document cancels the flow (both cancel points of the delete
route) and its `visual_facts` rows go with the document by FK cascade; the lineage line is left to
the mechanism V8 delivers. Erasure deletes rows by cascade from `users` (`visual_facts` FK-cascades,
and the comment in `erasure/pgSteps.ts` is updated), `erasure/wire.ts` gains `cancelVisualize`, and
the user's key destruction shreds `fact_enc`, the sealed decision and (after V8) the lineage line.

**Tests.**

- Unit: the extraction schema and limits; the grounding check over digit, suffix, percent and
  currency forms; catalogue resolution on both surfaces; capability building; an empty plan gives
  `empty`; the role is `off` gives `skipped`.
- Planner conformance: `checkPlannerConformance` on DocMind's inputs with a fresh recording context
  and `modelCalls`, proving a second compose makes no model call.
- Postgres: RLS on `visual_facts`, encryption round trip, replace in one transaction, the head's
  compare-and-set race.
- End to end (`*.e2e.pg.test.ts`, stub model): upload a document with a figures table; the flow ends
  `done`; the detail view lists a Visuals panel; hydrating `fact-0` returns the series; citations
  resolve. Then delete, and erase: every read fails closed.
- M7 retrieval-eval fixture: documents with known figures, measuring surviving and wrong facts.

## 9. Step (b): cross-document

Superseded by `2026-11-08-document-connections-design.md`. Connections are LIVE data: a `doc.connections`
provider is read at hydrate time and bound by the planner once. Another document's ingest or deletion therefore
needs no `planner.revise`, no `@loom-ui/changes` and no `crossDoc` fact kind. Figure comparison across documents
is out of scope.

## 10. Step (c): diagrams

First a generic loom-ui change: a `Diagram` kind (nodes, edges, a layout hint, an accessible text
fallback) with renderer-conformance coverage for Lit and the terminal, naming no DocMind concept.
Then DocMind adds derived structure facts and diagram catalogue entries. Phase c1 (outline and entity map, derived from
passage headings and entity mentions, no model call) is specified in `2026-11-10-structure-diagrams-c1-design.md`; phase c2
(timeline and named relationships, model-extracted) has its own spec.

## 11. Out of scope

Visuals in chat answers (sub-project 2); user editing or pinning of visuals; interactive filtering
inside charts; facts spanning documents before step (b).

Deferred from step (a) after the final review (owner to schedule): citation markers in widget captions (done, see
"As built: source markers on visuals" below);
reclaiming erased or orphaned `lineage_content` rows (done, see "As built: reclaiming `lineage_content`" below).


### As built: re-planning over a changed fact format (instead of re-running on `schemaDrift`)

Re-running on a hydrate-time `schemaDrift` was dropped: the pins a hydrate checks are never read from storage. The served
experience is rebuilt on every hydrate (`detailWithVisuals`, `turnExperience`, `factProvider`) and its providers carry the
CURRENT `PINS`, so the invoker's check always passes; a `PINS` bump changes both sides at once and a stale client fails on its
version hash, not on a pin. What can go stale is the stored plan, made over an older fact format. So:

- `factFormatFingerprint()` (packages/experiences) is the canonical string of `PINS["visual.facts"]` and `PINS["turn.facts"]`.
- A visualize run that ends `done` (a lineage head was written) is stamped with it in `visual_runs.format` (migration 0030; set
  by the event-feed sink only, not by the boot reconcile, which cannot know which code wrote a run). A run that ends empty,
  skipped or failed leaves the last stamp as it was.
- The boot sweep's third pass (`docmind_visual_stale_format_documents`, own try, as the running pass) re-runs once per boot,
  through `rerun(ref, generation)` (shared lock and `-r<n>` probe, so it never duplicates a user's retry), each ready document
  whose last run is `done` with a non-NULL `format` different from the current fingerprint. It re-plans over the stored facts
  and stamps the new fingerprint on commit. Bounded by the shared gate (2 in flight); nothing while the `visuals` role is off.
- Rows from before the column (format NULL) are NOT stale: they are re-planned only on the user's Retry, or by a later format
  bump after a re-run stamped them.
- Chat turns record no format: they are re-made lazily, only by the Visualize action.

### As built: reclaiming `lineage_content`

- `storage/lineageGc.ts` (`collectLineageContent`, `startLineageGc`) is due daily (`DOCMIND_LINEAGE_GC_INTERVAL_MS`, default
  86400000, `0` off, 60000 to 2592000000 otherwise); it ticks every min(interval, 1 h) and, under the lock, runs when the last
  completed run (`maintenance_runs`, migration 0031, database clock; no row means due) is at least an interval old, so frequent
  redeploys do not postpone it; a refusal or failure is not recorded and retries next tick. One replica at a time
  (`pg_try_advisory_lock` on the Loom pool, `docmind:lineage-gc`), skipped while a run is in progress, unref'd.
- Roots: `Lineage.pins({ keepLast: Infinity })` of THE one visuals `Lineage`, which holds every document and chat-turn line
  of all users and finds the refs inside retained artifacts (`pgLineageGc.ts`). A confirmed-erased line (destroyed key)
  contributes none, so its blobs are reclaimed; any other read, fold or open failure throws and the run ends with nothing deleted.
- The sweep is Loom's `sweepUnpinnedContent` (loom 4af27eaa; ADR 0055 D5-D7) with `eventStores: []`, `roots`, `reclaimOrphans:
  { completeScan: true }`, `olderThanMs` 24 h and an explicit `touchedBefore` read from the store's clock BEFORE the roots, so a
  blob a promote, a branch or a put touched while the roots were read survives. Loom refuses to erase without `touch` and `touchClock`.
- Completeness rests on the visuals Lineage being the only user of the store; `storage/contentUsers.test.ts` pins that.
- Fail closed also on an empty root set. Logs: counts and error classes only.


### As built: source markers on visuals

loom-ui's value-level `refs` (PR #129, pin 9bcf82b) replace the caption idea: every `Kpi`, `BarChart`, `TimeSeries` and
`Table` value carries numbered markers, one per passage its fact cites. A fact's `chunkIds` are passage ids, so no
mapping is needed. The readers attach `cites` (document id, passage id, "<title>, <place>" label) after one owner-scoped
lookup, and the reshaper turns them into `refs` with id `<documentId>:<passageId>` (deduplicated, in order, at most 16,
omitted when empty). A deleted document's chunks are gone, so its markers are dropped. Activating a marker raises
`REF_OPEN`; `intentOf` maps it to `source.open` and the page opens `/documents/<id>?passage=<passageId>`. Chat turn
visuals use the same path (`dm-turn-visuals` answers `REF_OPEN`; it still has no other action).

### As built: structure diagrams, phase c1

- Two derived fact kinds, `outline` and `cooccurrence`, are written by the `visualize-structure` step (after extract; also on a
  re-plan that skips extraction) with `PgVisualFacts.replaceStructure`, on reserved ordinals 16 and 17 of `visual_facts`
  (extraction keeps 16 facts at 0..15). Each store writer owns its own ordinal range. Migration 0035 relaxes the `kind`
  and `ordinal` CHECKs of 0026 (`kind` also allows `outline` and `cooccurrence`; `ordinal` 0..17); the sealed fact's `kind` decides.
- `DocumentOutline` (Diagram, tree) and `EntityMap` (Diagram, network) are in the document catalogue `docmind.visuals.v3`;
  the chat catalogue `FACT_VISUALS_CATALOG` is byte-identical (sha256 guard). Their reshapers (`structureShapes.ts`) pass
  loom-ui's `diagramProblems`, and `fitsShape` drops a misfit before commit. `VISUAL_SHAPES` serves them only at ordinals 16
  and 17, and a document page adopts an entry only on its own ordinal (`entryFitsOrdinal`).
- The planner sees counts and neutral placeholders only for a structure capability (never a heading or a name). `factFormatFingerprint()` ends `+docmind.structure@1`, which makes
  the boot stale pass re-plan each visualized document once.
- The flow is `visualize-document` 1.1.0; the `legacy` 1.0.0 definition stays registered before it so runs in flight at deploy finish on
  1.0.0 (no structure facts until the next re-plan). Do not roll back past this release (see `docs/operations/cloud-deploy.md`).
- Not done in c1: timeline and relationships (c2), diagrams in chat, cross-document structure.
