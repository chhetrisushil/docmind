# Document connections: live cross-document visuals (design)

Date: 2026-11-08. Status: draft for review.

## 1. Goal

Show, on a document's Visuals tab, how the document relates to the rest of the owner's library: which other
documents are related and why, and which people, organisations and products they share. This is step (b) of
document visuals (`2026-11-08-document-visuals-design.md` §9), redesigned: the connections are **live data**
bound by the planner once, not snapshot facts revised whenever another document changes.

## 2. Decisions

| Id | Decision |
|---|---|
| K1 | Connections only. Comparing figures across documents is out of scope. |
| K2 | Live binding. A new provider `doc.connections` is read at hydrate time; the planner binds it once. Another document's ingest or deletion needs no re-run, no model call and no change signal. |
| K3 | Built from existing data only: `chunk_links`, `chunk_entities`, `entities`, `chunks`, `documents`. No extraction, no new tables and no new stored data; one migration (0032, K6) replaces a function. |
| K4 | Two catalogue entries: `RelatedDocuments` (Table) and `ConnectionMap` (Diagram, network layout). The planner chooses table, map, both or neither. |
| K5 | The capability is always offered, and the widgets show an empty state, so a document uploaded first still gets the section and fills it in later. |
| K6 | The fact-format fingerprint gains the connections pin; for this release, done runs with a NULL fingerprint also count as stale, so every visualized document is re-planned once (no extraction) to add the section. |
| K7 | Document visuals only. Chat-turn visuals do not offer connections. |
| K8 | Connections are planned even when extraction finds no facts. `visualize-document` then runs the planner with only the connections capability (one planner call, no extraction), so a text-only document gets a Connections section. If the planner emits nothing, the outcome stays `empty`. |

Rejected:
- **Snapshot `crossDoc` facts revised with `planner.revise` plus `@loom-ui/changes`** (the original §9). Every upload would cost model calls for each neighbouring document, and it needs affected-set and coalescing rules plus persistent unread cursors. Live data has no staleness to repair.
- **A fixed Connections panel outside the planner.** Always current, but not part of the planned experience, and every document would get the same layout.

## 3. The provider `doc.connections`

- Tool `doc.connections`, pin `docmind:doc.connections@1`.
- Args: `{ documentId }`, from the server-held view, never from a pin or the client. Served under the owner's `sensitive` clearance (R27).
- One owner-scoped query (tenant via `withTenant`, `documents.owner_id = <caller>`), counting only ready, non-deleted documents. As planned: "ready" is read from `read_model_state` (the ingest status), not the vestigial `documents.status`. It returns:
  - **related**: up to 8 other documents with chunk links to this one, grouped per document:
    - `{ documentId, title, kinds: { entity, reference, similar } counts, strength }`, where strength is the maximum link weight;
    - ordered by strength, then link count, then document id.
  - **entities**: up to 12 entities this document shares with other documents, rarest first:
    - `{ entityId, name, kind, documents: [{ documentId, title }] }`, with up to 5 documents per entity, by title.
- Titles and entity names are decrypted with the owner's key (`fields.forUser`). An entity whose name doesn't open is dropped; a document gone since the query is absent.
- Performance: uses `chunks.document_id`, `chunk_entities.entity_id` and the `chunk_links` source index. The plan verifies it with `EXPLAIN` on a seeded library of about 500 documents.

## 4. Catalogue and reshapers

- **`RelatedDocuments` → Table.**
  - Columns: Document, Why, Strength.
  - "Why" is built from the kinds and the top shared entity names (e.g. "shares Acme Corp, Jane Doe", "similar content", "referenced").
  - Each row carries a row key and an "Open" row action (`TABLE_ROW_ACTION`). The web answers it by navigating to `/documents/<id>`, owner-checked by the existing routes. As planned: `intentOf("detail")` gains a `TABLE_ROW_ACTION` branch (action `open` only, the row key matched against the served `connections-table` row keys); today the detail view refuses row actions.
  - Empty: one placeholder row, `["No connected documents yet", "", ""]`, with no row key or action. As planned: loom-ui's Table has no caption field (its `<caption>` is screen-reader-only, from the node title), so a zero-row table would show nothing.
- **`ConnectionMap` → Diagram `network`.**
  - Nodes: this document (`group: "self"`), the related documents (`group: "document"`) and the shared entities (`group: "entity"`, `kind`: the entity kind).
  - Edges: document → entity for each shared entity, and self → document for a reference or similar link, labelled with the kind. As planned: an entity with no listed related document attaches to self (self → entity), so it still appears.
  - At most 21 nodes. Ids are prefixed (`doc:` / `ent:`) and unique, and the value passes loom-ui's `diagramProblems`.
  - Empty: a single self node.
- Both values carry no fact refs (they cite no passages).
- The web registers `@loom-ui/renderer-lit/diagram`, covered by the element-registration test.

## 5. Planning and rollout

- `visualize-document` always adds the connections capability (handle `connections`, one per document) next to the fact capabilities.
- On the document page the served providers are `connections-table` and `connections-map` (one per entry, generated from the planner's `connections` binding, nothing overridable).
- This release adds one migration, 0032 (`CREATE OR REPLACE` of the stale-format definer so a NULL-format done run counts as stale, K6). No new tables and no new stored data.
- When extraction finds no facts (including a model refusal, which still clears the stored facts), the flow does not end `empty` before planning (K8). It skips the load step, runs one planner call whose capabilities are only `connections`, and commits the plan. If that planner call emits nothing (or an invalid plan), the outcome is `empty`; an unreachable model is still `failed` (`visuals-model-unavailable`).
- `VISUALS_INTENT` gains one sentence: connections are live and may grow; include a compact Connections section when the document has, or is likely to gain, related material. As planned: its last sentence is rewritten, since "Every widget binds one fact." would contradict the connections widgets: "Every widget binds one fact, except RelatedDocuments and ConnectionMap, which bind the live connections capability: ...".
- `factFormatFingerprint()` includes the connections pin.
- For this release, the boot stale pass treats done runs with a NULL format as stale, so each visualized document is re-planned once:
  - over its stored facts (no extraction), one planner call each, at most 2 at a time;
  - then stamped, so it runs once.
  - a document with no facts that already has a `done` run is re-planned the same way (connections only, no extraction); the starter notes the previous state in-process, since a new run overwrites it in `visual_runs`, and the run reader is the fallback after a restart.
- Accepted costs:
  - A retry after a planner-unavailable failure on a zero-fact document may extract once per boot (bounded).
  - A document whose last run ended `empty` before this release is neither stale nor unvisualized, so it gets no Connections section until it is re-ingested or retried.

## 6. Errors, privacy, testing

- **Errors:**
  - A failed connections query gives that widget its own error state; the other widgets render.
  - The reshapers never throw on empty data.
- **Privacy:**
  - Owner-scoped query and routes.
  - Names are decrypted only into rendered values, never logs or the event log.
  - No new stored data (the one migration replaces a function only).
- **Testing:**
  - **Reshaper unit tests:** table rows, map nodes and edges, caps, empty states, `diagramProblems` clean.
  - **Postgres query tests:** another user's documents excluded, deleted and not-ready excluded, decryption for the owner only, ordering, caps, the `EXPLAIN` check.
  - **Hydration:** owner clearance; args only from the server.
  - **End to end:** upload A, then B sharing an entity. A's connections show B with no re-plan; deleting B removes it.
  - **Web:** the diagram element is registered; the row "Open" navigates.
  - **Boot:** the re-plan of NULL-format runs happens once.
  - **Flow:** zero facts plus one connection gives a plan with a connections widget and outcome `done`; zero facts and an empty planner answer give `empty`; a refusal clears the facts and still plans connections.

## 7. Out of scope

Comparing figures across documents; connections in chat answers; revising visuals in place and `@loom-ui/changes`; user-edited or pinned connections.
