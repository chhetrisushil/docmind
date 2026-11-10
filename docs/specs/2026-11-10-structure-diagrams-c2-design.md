# Structure diagrams, phase c2: timeline and relationships (design)

Date: 2026-11-10. Status: draft for review.

## 1. Goal

Two model-extracted structure diagrams on a document's Visuals tab:
- **Timeline:** the dated events the document narrates, in order.
- **Relationships:** how the parties it names relate, such as "Acme acquired Beta" or "Cora leads Project X".

This is step (c), phase c2 of document visuals. Phase c1 (outline and entity map, derived without a model) shipped in #495 (`2026-11-10-structure-diagrams-c1-design.md`).

## 2. Decisions

| Id | Decision |
|---|---|
| D1 | **Approach A:** the existing extraction call returns the new data. No second call. |
| D2 | Two aggregate facts at reserved ordinals, outside the 16-fact chart pool: `timeline` at 18, `relations` at 19. |
| D3 | Dates are kept at day, month, quarter or year precision and shown as written. Relative or undated phrases are dropped. |
| D4 | Relationships get their own Diagram entry. c1's entity map is unchanged. |
| D5 | **Rollout is on demand only.** New uploads and re-ingests get the new facts automatically. Existing documents get them when the user presses re-run (one extraction call each). The boot re-plan is not triggered, so the fact-format fingerprint is unchanged. |
| D6 | Migration 0037 widens the ordinal CHECK to 0..19 and extends the kind/ordinal rule. |
| D7 | The visualize-document flow version is unchanged: only the extract step's prompt and output change. This is verified against Loom's flow hash and pinned by a test. |

Rejected:
- Events and relations as facts in the 16-fact pool: they would compete with charts.
- A second extraction call: it doubles the cost.
- Labelling the entity map's edges with relations: that mixes co-occurrence with extracted claims.
- A boot backfill: it costs one extraction call per document.

## 3. Extraction

**The model's answer.** The `EXTRACT_SYSTEM` answer gains two optional top-level fields next to `facts`:
- `timeline: {"events":[{"when","date","label","chunkIds"}]}`, at most 40 events.
  - `when` is the date as written.
  - `date` is `YYYY`, `YYYY-Qn`, `YYYY-MM` or `YYYY-MM-DD`.
- `relations: {"links":[{"from","rel","to","chunkIds"}]}`, at most 30 links.
  - `from` and `to` are entities as written.
  - `rel` is a short verb phrase.

The prompt tells the model:
- copy dates and names as the document states them;
- never infer or compute a date;
- leave out relative or undated phrases;
- cite the passages each item comes from.

**Server-side validation.** Each bad item is dropped. A bad item never fails the run or affects other facts.
- **Dates.** `date` must parse at its precision:
  - year 1000–9999;
  - quarter 1–4;
  - a real month;
  - a real day for that month.
  - The stored event keeps `at` (the ISO first day of the period), `precision` (`day | month | quarter | year`) and `when`, clipped to 40.
- **Text.** `label` is clipped to 80 characters, `rel` to 40, and entity names to 80. Control and invisible characters are stripped.
- **Citations.** `chunkIds` must be passages of this document (the existing fact check). Items with none left are dropped.
- **Events.**
  - Dedupe by (`at`, `precision`, normalised label).
  - Sort by `at`, then by the position of the first cited passage.
  - Cap at 40.
  - A timeline needs at least 3 events.
- **Links.**
  - Drop self-links (the same normalised endpoints).
  - Dedupe by (from, rel, to), normalised.
  - Cap at 30.
  - Relations need at least 3 links.
- **A missing field** is the old behaviour: no timeline or relations fact.

## 4. Storage

- New sealed fact kinds in `visual_facts`: `timeline` (ordinal 18) and `relations` (ordinal 19).
- **Migration 0037:**
  - `ordinal BETWEEN 0 AND 19`.
  - The kind/ordinal CHECK becomes: extracted kinds `< 16`, `outline`/`cooccurrence` at 16/17, and `timeline`/`relations` at 18/19 (each kind at its own ordinal).
- **Who replaces what:**
  - The extraction write replaces ordinals 0..15 and 18..19 together, so a new extraction with no timeline removes the old one.
  - A re-plan that skips extraction keeps 18..19, because they can't be re-derived without the model.
  - c1's structure write keeps owning 16..17.
- Sealed per user, owner-scoped, and erased with the user.

## 5. Catalogue, diagrams and planning

**`DocumentTimeline`** (Diagram, `timeline` layout):
- Nodes are events: `at` is the ISO start, and the label is the event label.
- When precision is not `day`, the label is prefixed with `when` ("Q3 2025 · Launch"), so the axis never implies a false day.
- `timeFormat` is date-only.
- `refs` holds at most 16 event passages.

**`Relationships`** (Diagram, `network` layout):
- Nodes are the link endpoints, deduped by normalised name (at most 60).
- Edges are directed from → to and labelled with `rel`.
- `refs` holds at most 16 cited passages.

**Shared rules for both:**
- Reshapers return values that pass loom-ui's `diagramProblems`.
- `fitsShape` and `entryFitsOrdinal`: each entry reads only its own ordinal (18 and 19), and misfits are dropped at plan time.
- The planner sample holds content-free placeholders.

**The catalogue:**
- The document catalogue becomes `docmind.visuals.v4`.
- `FACT_VISUALS_CATALOG` (chat) stays byte-identical, and its sha256 guard stands.
- `VISUALS_INTENT` gains: use a timeline when the document narrates dated events, and a relationships diagram when it states how parties relate. Leave them out for a few scattered dates or links.

**Rollout (D5).**
- `factFormatFingerprint()` is unchanged, so the boot stale-format pass does not re-plan anything.
- Existing plans stay valid, because v3's entries are a subset of v4's.
- The plan verifies that a stored plan from v3 still hydrates under v4.

## 6. Privacy and cost

- Event labels, written dates, entity names and relation phrases are sealed per user. They never appear in logs, the event log, lineage or error text.
- The planner sees capability descriptions and counts only.
- Erasure shreds them. The erasure plaintext scan gains timeline and relation needles.
- Cost:
  - No extra call. The extraction answer is longer.
  - No boot spending.
  - One extraction call per document the user re-runs.

## 7. Testing

- **Unit:**
  - date parsing at each precision: quarters, invalid month or day, out-of-range year, relative phrases dropped;
  - dedupe, order, caps and the minimum of 3;
  - links: self-link, duplicate, clipping;
  - citations limited to this document.
- **Reshapers:**
  - both pass `diagramProblems`;
  - a quarter label is shown as written;
  - refs ≤ 16;
  - the fit check accepts the right ordinal and rejects the wrong one.
- **Postgres:**
  - 0037 refuses `timeline@3` and `figure@18`;
  - sealed storage;
  - extraction replaces 18..19;
  - a skip-extraction re-plan keeps them;
  - erasure removes them.
- **Flow:**
  - the visualize-document hash is pinned and unchanged;
  - an answer with bad `timeline` or `relations` still stores the good facts;
  - a key-store outage is retried.
- **Chat:** the sha256 guard is unchanged.
- **End to end:**
  - a narrative document gets both diagrams after a re-run;
  - a flat document gets neither;
  - no plaintext in the event log;
  - boot re-plans nothing.
- **Browser:** both diagrams render, and a citation opens its passage.

## 8. Out of scope

- An automatic backfill of existing documents.
- Timelines or relationships in chat answers.
- Cross-document timelines or relationship graphs.
- Merging relationship nodes with the `entities` table, or with c1's entity map.
- Editing extracted events or links.
