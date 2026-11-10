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
| D5 | **Rollout is on demand only, and re-extracts once.** New uploads and re-ingests get the new facts automatically and stamp the document with the extraction format (`docmind.extract@2`). An existing document is stamped nothing (NULL) until it is extracted again. A re-run the user asks for (the "Refresh visuals" button on the Visuals tab, or Retry after a failure) re-extracts only when the stored stamp is missing or is not the current one: one extraction call per document, once. After that, re-runs are cheap re-plans as today. The boot re-plan is not triggered and a boot pass never extracts, so the fact-format fingerprint is unchanged. |
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
  - The ask is for the relationships between the people, organisations, projects, products and places the document names, each as subject → short verb phrase → object.
  - `from` and `to` are those names as written.
  - `rel` is a short verb phrase.

The prompt tells the model:
- copy dates and names as the document states them;
- never infer or compute a date;
- leave out relative or undated phrases;
- cite the passages each item comes from.

The prompt does not tell the model to leave a field out for having too few items; the server's minimums (3 events, 3 links) are the only gate.

**Accepted shapes.** The parser is lenient about obvious variants and stays bounded and validated as before (wrong types are dropped, never thrown):
- a top-level `relationships` is read as `relations` when `relations` gave no links;
- a bare array under `relations` or `relationships` is read as `links`, and a bare array under `timeline` as `events`.

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

**Extraction limits.** The answer is longer (up to 40 events and 30 links beside the facts), so the document extraction does not share the planner's limits. The `visuals` role has one provider for the planner and for chat's extraction (8192 answer tokens, the role's request timeout `DOCMIND_LLM_TIMEOUT_MS`, 60 s by default), and an answer of up to about 14 000 tokens can pass that timeout, which would end the step `visuals-model-unavailable` and cost the facts. So the document extraction runs on a second provider of the same role and model with its own limits:
- a 16 000-token answer cap (`VISUALS_EXTRACT_MAX_TOKENS`, as vision's);
- its own request timeout, `DOCMIND_VISUALS_EXTRACT_TIMEOUT_MS`: default 180 s (vision's), at most 600 s, configured like the other timeouts;
- the planner and chat's extraction keep the shared provider and its limits, unchanged;
- each window is asked for its share, `ceil(40 / windows)` events and `ceil(30 / windows)` links (at least 3); the server's caps stay as they are;
- the 600 s step clock running out ends the step `visuals-model-unavailable` at once (no retry; the user can re-run), while a per-call `LlmUnavailableError` keeps its 6 attempts.

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
- **Extraction format stamp.** Migration 0037 also adds a nullable `documents.visual_extract_format` (a plain token, no content). The extraction write (`PgVisualFacts.replace`) sets it to `docmind.extract@2` in the same transaction as the facts, including an extraction that finds nothing or is refused. Chat's turn extraction never writes it and never reads it. NULL means the document was extracted before c2.

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
- **Re-extract once.** The user asks for it with "Refresh visuals" (always present on a served document's Visuals tab, or Retry when the visuals failed); both call the retry route. The route's re-run (never a boot pass) is marked as asked by the user. The extract step extracts again for such a re-run only when the document's `visual_extract_format` is not `docmind.extract@2` (NULL for a document extracted before c2). The note is spent only after the extraction has been written (or when the step settles without extracting), so a step that fails and is retried still extracts. The extraction stamps it, so a second re-run, and the re-run of a document stamped by a c2 upload, re-plan without extracting. A boot pass never extracts over stored facts, as before. A future extraction change bumps the token and gets the same one-time behaviour.

## 6. Privacy and cost

- Event labels, written dates, entity names and relation phrases are sealed per user. They never appear in logs, the event log, lineage or error text.
- The planner sees capability descriptions and counts only.
- Erasure shreds them. The erasure plaintext scan gains timeline and relation needles.
- Cost:
  - No extra call. The extraction answer is longer.
  - No boot spending.
  - One extraction call per document, the first time the user re-runs it after c2.

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
- **Re-extract once:**
  - a re-run the user asks for on a document with no stamp extracts, and stamps it;
  - a second re-run does not extract;
  - the re-run of a document stamped by a c2 upload does not extract;
  - a boot pass never extracts, stamped or not;
  - chat's extraction never writes or reads the stamp.
- **Browser:** both diagrams render, and a citation opens its passage.

## 8. Out of scope

- An automatic backfill of existing documents.
- Timelines or relationships in chat answers.
- Cross-document timelines or relationship graphs.
- Merging relationship nodes with the `entities` table, or with c1's entity map.
- Editing extracted events or links.

## As built

- Re-runs happen from "Refresh visuals" (a secondary button on the Visuals tab, shown whenever the document is served, except while a run this page did not start is in flight (then only "Making visuals…" shows); it reads "Refreshing…" and is disabled until a `visuals` event or 60 s) or from Retry when the visuals failed. Both reuse the existing `POST /api/documents/:id/visuals/retry` path, its refusal notes ("limited", "busy") and its rate limit. Its visible help text says a refresh may re-read the document once (one model call) on an older document, and is otherwise a re-plan.
- The relations ask names "people, organisations, projects, products and places" (subject → short verb phrase → object), not "parties"; it was too narrow, and a model-side "fewer than 3" gate (dropped for the timeline too) gave a second chance to drop the field. The lenient parser accepts a top-level `relationships` alias and a bare array as `links` / `events`.
- Each document extraction logs counts only: `visualize-extract aggregates {events: "received/kept", links: "received/kept"}`, never a label or a name.
