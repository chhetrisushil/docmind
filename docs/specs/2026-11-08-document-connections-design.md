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
| K3 | Built from existing data only: `chunk_links`, `chunk_entities`, `entities`, `chunks`, `documents`. No extraction, no new stored data, no migration. |
| K4 | Two catalogue entries: `RelatedDocuments` (Table) and `ConnectionMap` (Diagram, network layout). The planner chooses table, map, both or neither. |
| K5 | The capability is always offered, and the widgets show an empty state, so a document uploaded first still gets the section and fills it in later. |
| K6 | The fact-format fingerprint gains the connections pin; for this release, done runs with a NULL fingerprint also count as stale, so every visualized document is re-planned once (no extraction) to add the section. |
| K7 | Document visuals only. Chat-turn visuals do not offer connections. |

Rejected:
- **Snapshot `crossDoc` facts revised with `planner.revise` plus `@loom-ui/changes`** (the original §9). Every upload would cost model calls for each neighbouring document, and it needs affected-set and coalescing rules plus persistent unread cursors. Live data has no staleness to repair.
- **A fixed Connections panel outside the planner.** Always current, but not part of the planned experience, and every document would get the same layout.

## 3. The provider `doc.connections`

- Tool `doc.connections`, pin `docmind:doc.connections@1`.
- Args: `{ documentId }`, from the server-held view, never from a pin or the client. Served under the owner's `sensitive` clearance (R27).
- One owner-scoped query (tenant via `withTenant`, `documents.owner_id = <caller>`), counting only ready, non-deleted documents. It returns:
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
  - Each row carries a row key and an "Open" row action (`TABLE_ROW_ACTION`). The web answers it by navigating to `/documents/<id>`, owner-checked by the existing routes.
  - Empty: zero rows with the caption "No connected documents yet".
- **`ConnectionMap` → Diagram `network`.**
  - Nodes: this document (`group: "self"`), the related documents (`group: "document"`) and the shared entities (`group: "entity"`, `kind`: the entity kind).
  - Edges: document → entity for each shared entity, and self → document for a reference or similar link, labelled with the kind.
  - At most 21 nodes. Ids are prefixed (`doc:` / `ent:`) and unique, and the value passes loom-ui's `diagramProblems`.
  - Empty: a single self node.
- Both values carry no fact refs (they cite no passages).
- The web registers `@loom-ui/renderer-lit/diagram`, covered by the element-registration test.

## 5. Planning and rollout

- `visualize-document` always adds the connections capability (handle `connections`, one per document) next to the fact capabilities.
- `VISUALS_INTENT` gains one sentence: connections are live and may grow; include a compact Connections section when the document has, or is likely to gain, related material.
- `factFormatFingerprint()` includes the connections pin.
- For this release, the boot stale pass treats done runs with a NULL format as stale, so each visualized document is re-planned once:
  - over its stored facts (no extraction), one planner call each, at most 2 at a time;
  - then stamped, so it runs once.

## 6. Errors, privacy, testing

- **Errors:**
  - A failed connections query gives that widget its own error state; the other widgets render.
  - The reshapers never throw on empty data.
- **Privacy:**
  - Owner-scoped query and routes.
  - Names are decrypted only into rendered values, never logs or the event log.
  - No new stored data.
- **Testing:**
  - **Reshaper unit tests:** table rows, map nodes and edges, caps, empty states, `diagramProblems` clean.
  - **Postgres query tests:** another user's documents excluded, deleted and not-ready excluded, decryption for the owner only, ordering, caps, the `EXPLAIN` check.
  - **Hydration:** owner clearance; args only from the server.
  - **End to end:** upload A, then B sharing an entity. A's connections show B with no re-plan; deleting B removes it.
  - **Web:** the diagram element is registered; the row "Open" navigates.
  - **Boot:** the re-plan of NULL-format runs happens once.

## 7. Out of scope

Comparing figures across documents; connections in chat answers; revising visuals in place and `@loom-ui/changes`; user-edited or pinned connections.
