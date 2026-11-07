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
| V7 | Gaps in loom-ui are closed generically in loom-ui first (M6 D11). Step (c) needs one. |

Approaches considered and rejected: the planner writing data inline into node props (charts require
a binding; data would sit outside per-user sealing; no drift detection), and fixed rules with no
planner (cannot judge what is worth showing; kept as a possible fallback, not built).

## 3. Trigger and flow

- `ingest-finalize` marks the document `ready`. After that commits, the server starts
  `visualize-document` the way the upload route starts `ingest-document`.
- Input is ids only and strict: `{ tenantId, userId, documentId }`. The execution id is
  `executionIdFor(userId, "visualize-" + documentId)`, which is also the idempotency key.
- Steps: `visualize-extract` then `visualize-plan`, each with `LLM_RETRY`, granted in `security.ts`
  like the ingest steps.
- Output: `{ outcome: "done" | "empty" | "skipped" | "failed", code? }`.
- Deleting a document cancels every generation of `visualize-document` as it does for ingest.
  `POST /api/documents/:id/retry` re-runs it. Boot recovery resumes an interrupted run through the
  `recovery.ts` pattern.

## 4. Model role

A new LLM role `visuals` in `apps/server/app/llm/roles.ts`, beside `chat`, `title`, `summary`,
`vision` and `visionPdf`: `DOCMIND_VISUALS_PROVIDER` (default Ollama), its model variable, and `off`.
When it is `off` the flow ends at once with `outcome: "skipped"`, and `llmWarnings` says
"visuals are off: DOCMIND_VISUALS_PROVIDER is off". The runbook `docs/operations/llm-providers.md`
gains the role.

## 5. Extraction (`visualize-extract`)

The step reads the document's chunks in order, windowed as the summarizer does, and asks the
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

**Grounding check (V4).** For each number in a fact (`y`, `value`, `compare.value`, and numeric
cells), the step looks for it in the text of the cited chunks after normalising: digit grouping
(`1,200`, `1 200`, `1.200` by locale), suffixes (`1.2k`, `3M`), percent forms (`12 %`, `12%`,
`0.12` when the unit is `%`), and leading currency signs. A fact with any number not found is
dropped, and the drop is counted, never logged with its content.

**Storage.** Table `visual_facts`:

```
id uuid primary key, tenant_id uuid, owner_id uuid, document_id uuid,
kind text, ordinal int, fact_enc bytea, chunk_ids uuid[], schema_version int
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
| `FigureChart` | `BarChart` | a `series` fact |
| `FigureTrend` | `Timeseries` | a `series` fact whose `x` values are dates |
| `KeyFigure` | `MetricCard` | a `figure` fact |
| `FactTable` | `DataTable` | a `factTable` fact |

Offered containers: `section` and `grid`. The terminal's gaps for charts are accepted as M6 accepted
its renderer's gaps.

**Capabilities.** One `CapabilityRef` per surviving fact: handle `fact:<ordinal>`, `kind: "docmind"`,
tool `visual.fact` version `1.0.0`, `toolSchemaHash` `docmind:visual.fact@1` (added to `PINS`),
`sampleOutput` the decrypted fact, and `sensitivity: "sensitive"` (Loom's `DataClass`; DocMind has
no per-document class, and all user content is treated alike). Declaring it keeps the planner's
summary from being withheld. The host's read floor is `declaredToolClassesFrom(capabilities)`.

**Intent.** A fixed, versioned instruction carrying no document text: help a reader grasp this
document at a glance; show only what a visual makes clearer than prose; prefer fewer widgets; every
widget binds a fact. Fact values reach the model only as fenced, untrusted data, as
`ReferencePlanner` does.

**Call.** `new ReferencePlanner({ model, modelId })` with the `visuals` role's provider, then
`compose({ intent, catalog, capabilities, containers }, ctx)` with the step's execution context, so
the plan is one recorded `ctx.decide`. Error findings fail the attempt (planner's two attempts, then
the step's `LLM_RETRY`). Zero nodes is a valid plan: the flow ends `empty`.

**Lineage.** `@loom-ui/lineage` with `eventStoreLineageStore` over DocMind's sealed Postgres event
store. Experience id `visuals:<documentId>`. The plan's ops are replayed onto `genesis`, sealed, and
written with compare-and-set; provenance from `plannerProvenance(plan, { agentId:
"docmind-visualizer" })`. If the head moved underneath, retry once, then fail.

## 7. Serving and change delivery

- The detail experience's `tabs` container gains a fourth panel, "Visuals", an embedded slot present
  only when a head exists for the document.
- `GET /api/ui/views/detail` returns the head's blueprint and inventory, compiled per surface, with
  the static ones.
- Each `fact:N` handle hydrates through `POST /api/ui/hydrate`. A new reader target `visual.fact`
  decrypts one row for the session's user, under RLS, inside the existing per-request read limits
  (8 distinct reads, 4 concurrent).
- Each widget's caption carries its citations as reference markers (the generic loom-ui support from
  Task 176b); a marker opens the passage in the Sources view.
- The document status poll gains `visualsHead` (the head's hash). When it changes while the detail
  view is open, the browser re-fetches the view. `@loom-ui/changes` is deferred to step (b).

## 8. Failure, erasure, testing

**Failure.**

| Case | Result |
|---|---|
| Model unavailable / plan invalid after retries | flow `failed`, `visuals-model-unavailable` / `visuals-plan-invalid`; tab hidden; ingest status untouched |
| A fact fails grounding | that fact dropped; others kept |
| A fact row gone at read time | per-widget error placeholder |
| Pin mismatch (`schemaDrift`) | server re-runs `visualize-document` for that document |

**Delete and erasure.** Deleting a document cancels the flow, deletes its `visual_facts` rows and
tombstones the lineage head. Erasure shreds `fact_enc`, the sealed lineage events and the sealed
experience through the user's key; the `Eraser` adds `visual_facts` to the tables it clears. New
sensitive event paths are registered in `apps/server/app/sensitive.ts`.

**Tests.**

- Unit: the extraction schema and limits; the grounding check over digit, suffix, percent and
  currency forms; catalogue resolution on both surfaces; capability building; an empty plan gives
  `empty`; the role is `off` gives `skipped`.
- Planner conformance: `checkPlannerConformance` on DocMind's inputs with a fresh recording context
  and `modelCalls`, proving a second compose makes no model call.
- Postgres: RLS on `visual_facts`, encryption round trip, replace in one transaction, the head's
  compare-and-set race.
- End to end (`*.e2e.pg.test.ts`, stub model): upload a document with a figures table; the flow ends
  `done`; the detail view lists a Visuals panel; hydrating `fact:0` returns the series; citations
  resolve. Then delete, and erase: every read fails closed.
- M7 retrieval-eval fixture: documents with known figures, measuring surviving and wrong facts.

## 9. Step (b): cross-document

A `crossDoc` fact kind built from the existing `entities` and `chunk_links` (shared entities,
related documents), cited on both sides. When a linked document is ingested or deleted, affected
documents' visuals are revised in place with `planner.revise` against the head, not recomposed.
`@loom-ui/changes` then supplies the "visuals updated" signal and unread cursors. Its own design
note settles which documents count as affected and how revisions are coalesced.

## 10. Step (c): diagrams

First a generic loom-ui change: a `Diagram` kind (nodes, edges, a layout hint, an accessible text
fallback) with renderer-conformance coverage for Lit and the terminal, naming no DocMind concept.
Then DocMind adds a `structure` fact (outline, timeline, relationships) and a `DocumentDiagram`
catalogue entry.

## 11. Out of scope

Visuals in chat answers (sub-project 2); user editing or pinning of visuals; interactive filtering
inside charts; facts spanning documents before step (b).
