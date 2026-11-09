# Structure diagrams, phase c1: outline and entity map (design)

Date: 2026-11-10. Status: draft for review.

## 1. Goal

Show a document's structure on its Visuals tab:
- **Outline:** its sections as a tree.
- **Entity map:** the people, organisations, products, projects and places it discusses, linked when they appear together.

This is step (c) of document visuals (`2026-11-08-document-visuals-design.md` §10), phase c1. Phase c2 (timeline and named relationships, model-extracted by extending the existing extraction call) has its own spec.

## 2. Decisions

| Id | Decision |
|---|---|
| S1 | c1 is built only from data that exists today: passages' heading paths, and the entity mentions per passage. No model call. |
| S2 | **Derived at visualize time, stored.** A document's own structure only changes on re-ingest, which is a new generation and re-visualizes anyway. Building it live on each hydrate would decrypt every passage of the document per page load. |
| S3 | Two new derived fact kinds, `outline` and `cooccurrence` (the spec's reserved `structure` kind, split by shape). They are stored sealed in `visual_facts` beside extracted facts, never sent to a model as text, and they cite passages. |
| S4 | Two new catalogue entries, both on loom-ui's Diagram kind (already pinned at 3b4d046 and registered in the web): `DocumentOutline` (tree) and `EntityMap` (network). |
| S5 | **Document visuals only.** The chat catalogue `FACT_VISUALS_CATALOG` stays byte-identical; the sha256 guard test stands. |
| S6 | **Rollout reuses the existing format re-plan.** The document catalogue moves to `docmind.visuals.v3` and the fact-format fingerprint changes, so the boot stale pass re-plans every visualized document once: it derives the structure facts (no model call), then makes one planner call, with no extraction and at most 2 at a time. |
| S7 | One migration (0035) relaxes the kind and ordinal CHECKs of `visual_facts`; no new table. Why: migration 0026 CHECKs `kind IN ('series','figure','factTable')` and `ordinal BETWEEN 0 AND 15`, so the new kinds and the two reserved ordinals (16 outline, 17 cooccurrence) would be refused. Extraction keeps its 16 facts at 0..15. |

Rejected: a live provider like connections (S2), and model extraction for c1 (it isn't needed for outline or co-occurrence).

## 3. The `visualize-structure` step

A new step in `visualize-document` runs after `visualize-extract` (or in its place on a re-plan that skips extraction) and before planning. It reads only this document, under the owner's key.

**Outline**
- Built from the passages' `headingPath` (sealed in `chunks.text_enc`).
- Each distinct heading becomes a node: `{ id, label (heading text, trimmed and clipped to 80 characters), level, passageCount, firstChunkId }`.
- The root is the document title.
- Siblings keep document order. A duplicate heading text under the same parent is a separate node, made unique by its position.
- Cap: 120 nodes. Over the cap, the deepest levels are pruned first, and a pruned node's passage count is folded into its parent.
- Not produced when the document has fewer than 3 headings.

**Co-occurrence**
- Built from `chunk_entities` and `entities` (names sealed under the owner), for this document only.
- Mention count per entity = the number of this document's passages it appears in.
- Keep the 20 most-mentioned entities. Ties break by name.
- An edge links two kept entities sharing at least 2 passages. Its weight is the shared count, and its `firstChunkId` is the first shared passage. Keep the 40 strongest edges.
- Entities left with no edge are dropped.
- Not produced when fewer than 3 entities remain linked.

**Storage**
- The facts are written with the existing `PgVisualFacts` replace, next to extracted facts, under their own ordinals. They cite their passages: the outline cites each node's `firstChunkId`, and the map cites its edges' `firstChunkId`s.
- On a re-plan that skips extraction, the structure facts are still re-derived and replaced. This is cheap and needs no model.

**Errors**
- A passage or entity name that doesn't open makes that structure fact be skipped. The step continues, and the run's other facts are unaffected.
- A key-store outage still fails the step, as elsewhere.

## 4. Catalogue, reshapers and planning

**Catalogue entries (Diagram)**
- **`DocumentOutline`, tree layout.**
  - Nodes are sections, with the label = heading and group = level.
  - Edges run parent → child.
  - The widget's `refs` carry up to 16 section passages, so the citation markers open the section in the document.
- **`EntityMap`, network layout.**
  - Nodes are entities, with the label = name and group = kind.
  - Edges are co-occurrences, labelled with the shared-passage count.
  - The widget's `refs` carry the passages of the strongest pairs (≤16).

**Reshapers**
- `visual-outline` and `visual-entitymap` build `DiagramValue`s that pass loom-ui's `diagramProblems`: unique ids, a single root for the tree, under 200 nodes and 400 edges.
- Labels are text only.
- Both run through the plan-time fit check (`fitsShape`, #494), so a misfit is dropped before commit.

**Planning**
- The structure facts are offered as capabilities with the existing per-fact pins.
- The `VISUALS_INTENT` gains one sentence: show an outline for long, sectioned documents and an entity map when several parties interact; leave them out for short or flat documents.
- The catalogue id becomes `docmind.visuals.v3`, and `factFormatFingerprint()` changes.

## 5. Privacy and cost

- Structure facts are sealed per user like other facts; there is no plaintext in logs or the event log.
- The planner is given capability descriptions only (the same as for facts), never the outline text.
- The derive step decrypts the document's passages once per visualize run, which already happens for extraction, plus one query for entity mentions.
- Rollout cost: one planner call per visualized document, once.

## 6. Testing

- **Outline builder:** nesting, document order, duplicate headings, pruning at the cap with counts folded into the parent, and a flat document producing no outline.
- **Co-occurrence builder:** thresholds, caps, tie order, isolated entities dropped, and too few links producing nothing.
- **Reshapers:** both values pass `diagramProblems`; refs are within the cap; `fitsShape` accepts the right fact and rejects the wrong one.
- **Step:** derives and replaces on both a full run and an extraction-skipping re-plan; a field that won't decrypt skips only that fact.
- **Chat:** the sha256 guard for `FACT_VISUALS_CATALOG` is unchanged.
- **Postgres:** facts are stored sealed and owner-scoped, and the co-occurrence query is index-bound with only this document's rows.
- **End to end:**
  - a long sectioned document with several entities gets an outline and an entity map, and a citation marker opens the section;
  - a short flat document gets neither;
  - there is no plaintext in the event log.
- **Web:** both diagrams render (`lu-diagram` is registered).

## 7. Out of scope

- Timeline and named relationships (phase c2).
- Diagrams in chat answers.
- Cross-document structure (that is connections).
- Editing or collapsing tree nodes beyond what the Diagram widget offers.
