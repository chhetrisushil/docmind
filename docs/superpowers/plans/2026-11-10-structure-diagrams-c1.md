# Structure Diagrams, Phase C1 (Outline and Entity Map) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a document's section outline (a tree) and an entity map (a network of entities that appear together) on its Visuals tab, derived at visualize time from data that already exists, with no model call.

**Architecture:** A new `visualize-structure` step runs after `visualize-extract` (and on the extraction-skipping re-plan path too). It reads this document's passage heading paths and entity mentions under the owner's key, builds two derived facts (`outline`, `cooccurrence`) with pure builders, and stores them sealed in `visual_facts` on reserved ordinals 16 and 17 (migration 0035 relaxes the `kind` and `ordinal` CHECKs for them). The document catalogue becomes `docmind.visuals.v3` with `DocumentOutline` and `EntityMap` (loom-ui `Diagram`), whose reshapers build `DiagramValue`s that pass `diagramProblems`; `fitsShape` guards them at plan time. Chat is untouched.

**Tech Stack:** TypeScript, zod, Postgres (RLS, `withTenant`), Loom (`step$`, `flow$`, `stepEffectOf`), loom-ui pinned at 3b4d046 (`@loom-ui/core` `DiagramValue`, `diagramProblems`, `MAX_DIAGRAM_NODES`; `Diagram` kind; `MAX_WIDGET_REFS` 16), vitest, pnpm/turbo, biome.

**Spec:** `docs/specs/2026-11-10-structure-diagrams-c1-design.md` (binding; read it first). Background: `docs/specs/2026-11-08-document-visuals-design.md` §10.

## Amendments (preflight)

This plan was amended after the pre-flight review (`.superpowers/sdd/2026-11-10-structure-diagrams-c1/preflight.md`: 15 rows, 18 findings; rulings P1 to P18 in `progress.md`). Where an older plan decision or step says otherwise, the amended text governs.

| Ruling | What changed | Where |
|---|---|---|
| P1 | Structure facts have their own ordinal schema (16 or 17); `StoredEntry` and `list`/`listAll` span 0..17; extraction's `Ordinal` stays 0..15 | Task 3 step 1 (test) and step 3 (`StructureOrdinal`, `StoredEntry`); Plan decision: ordinal space |
| P2 | `VISUAL_SHAPES` gains exactly `visual-outline-16` and `visual-entitymap-17`; views adopt a structure entry only on its own ordinal (`entryFitsOrdinal`) and a fact entry only below 16 | Task 4 steps 1 and 4; Plan decision: chat adoption |
| P3 | The planner sample of a structure capability carries neutral placeholder `nodes`/`edges` (no document text), so the `nodes`/`edges` bindings validate; tested | Task 3 step 12b (tests and code), step 13 and Task 4 (planning tests), Task 5 e2e; Plan decision: planner sample |
| P4 | `replace` and `replaceStructure` are `async`, so their range guards reject instead of throwing synchronously | Task 3 step 7 |
| P5 | Unique fingerprint values for every new fixture document sharing one fixture database | Task 3 steps 4b and 5 |
| P6 | Mention order within a passage is never relied on (random entity ids): tests sort by (ordinal, name); candidates sort by count desc, name, id | Task 3 step 9; Plan decision: deterministic order |
| P7 | One `LoadOutput.facts` maximum, 18 (`MAX_STORED_FACTS`) | Task 3 interfaces, steps 3 and 15 |
| P8 | `MAX_FACTS` is imported, never redeclared | Task 3 step 3 |
| P9 | The vacuous "admit stops at the cap" test is replaced by a test of the ordinal ranges | Task 3 step 1 |
| P10 | Weak assertions replaced: the title is asserted exactly; the log test asserts the exact call | Task 3 steps 9 and 13 |
| P11 | The EXPLAIN suite seeds a library of 500 documents (4000 passages, about 8000 mention rows, 5000 entities, a hub entity), asserts rows visited (independent of plan shape) and forbids a sequential scan only on the two large tables. `MENTIONS_SQL` now walks from this document's passages through a `LATERAL ... LIMIT`: a plain join was sequentially scanned over the library once a hub entity was among the ids (reproduced on Postgres 17) | Task 3 steps 9 and 11; Plan decision: mentions walk |
| P12 | The duplicated chat-catalogue test is dropped (the existing test already asserts the id and the four entries) | Task 4 step 1 |
| P13 | The views, fit and legacy-flow (1.0.0 beside 1.1.0, registration order) tests are written out | Task 4 step 1 (views, fit); Task 3 step 15b (legacy flow, `visualizeFlows`) |
| P14 | `OutlineFact` and `EntityMapFact` are defined in Task 3 step 12b and only consumed by Task 4 | Task 3 step 12b; Task 4 interfaces |
| P15 | Explicit owner and tenant predicates in every structure SQL statement, reads and the store's `DELETE` | Task 3 steps 7 and 11; Plan decision: explicit predicates |
| P16 | `((ordinal 16);` double parentheses fixed | Task 5 step 4 |
| P17 | The near-tautological "cites each firstChunkId once" test replaced by one whose edges have distinct first passages | Task 2 step 1 |
| P18 | Outline nodes carry an `id` (`s<index>`, spec 3) from the builder through the stored shape to the diagram | Task 1; Task 3 step 3; Task 4 |

Found while writing the real code (beyond the rulings): `ui/readers.test.ts` stubs rename `list` to `listAll`; the existing `visuals.test.ts` "register all 64 names" becomes 66; `config.ts` is a modified file (`visualizeFlows`); a `LIMIT`-less plain join in `MENTIONS_SQL` was the P11 root cause.

## Global Constraints

Every task's requirements include these (values copied from the spec):

- Outline: at most **120 outline nodes**; labels are the heading text trimmed and clipped to **80 characters**; **fewer than 3 headings produces no outline**; the root is the document title; siblings keep document order; a duplicate heading under one parent is a separate node; over the cap the deepest levels are pruned first and a pruned node's passage count is folded into its parent.
- Entity map: keep the **top 20 entities** by mention count (the number of this document's passages it appears in; ties break by name); an edge links two kept entities that share **at least 2 passages** (weight = shared count, `firstChunkId` = first shared passage); keep the **40 strongest edges**; entities left with no edge are dropped; **fewer than 3 linked entities produces no map**.
- Widget `refs` carry at most **16** passages (loom-ui `MAX_WIDGET_REFS`).
- The document catalogue id becomes **`docmind.visuals.v3`**; `factFormatFingerprint()` changes.
- The chat catalogue `FACT_VISUALS_CATALOG` stays **byte-identical** (id `docmind.visuals.v1`; the sha256 guard `e9096cf41a01d1b87ef45b3eba3744600ae81e36d78fff476f6117f1455af080` in `packages/experiences/src/visuals.test.ts` stays unchanged and green).
- **One migration (0035)**, no new table (S7): it relaxes the two CHECKs of `visual_facts` (`visual_facts_kind_check` also allows `outline` and `cooccurrence`; `visual_facts_ordinal_check` allows 0..17). Migration 0026 is merged and never edited. Extraction keeps `MAX_FACTS` 16 at ordinals 0..15; structure facts take the reserved ordinals 16 (outline) and 17 (cooccurrence).
- **Ordinal schemas (P1, P7).** Extracted kinds keep `Ordinal` (0..15, unchanged). The structure kinds have their own `StructureOrdinal` (16 or 17). `StoredEntry` (what `listAll` and the load step parse) therefore spans 0..17, `StoredFact` (extracted only, what chat reads) stays 0..15, and `LoadOutput.facts` holds at most 18 (`MAX_STORED_FACTS` = `MAX_FACTS` + 2).
- **Experiences ordinals (P2).** `VISUAL_SHAPES` gains only `visual-outline-16` and `visual-entitymap-17`. A document page adopts a structure entry only on its own ordinal and a fact entry only below 16; chat adopts the four fact entries below 16 only.
- **Explicit predicates (P15).** Every SQL statement the structure code adds (the reader's reads and the store's `DELETE`) names the owner and the tenant, in addition to row-level security.
- **No model call** in c1 (S1). The planner sees capability descriptions and content-free samples only (counts and neutral placeholder nodes and edges, P3), never outline or entity text (spec §5).
- **Document visuals only** (S5): chat never offers or plans a structure widget.
- Structure facts are sealed per user like other facts: no plaintext in logs, the event log, or the `visual_facts` row.
- A passage or entity name that does not open skips that structure fact and the step continues; a key-store outage still fails the step.
- Verification commands (run from the worktree root `/Users/such/workspace/docmind/.worktrees/structure-c1`): `pnpm typecheck`, `pnpm typecheck:tests`, `pnpm lint`, `pnpm build`, and the suites named in each task. Postgres suites need `set -a; . ./.env; set +a` first (it sets `DOCMIND_TEST_PG_URL`); **a skipped pg test is not a pass**: check the vitest summary shows the pg tests ran, not "skipped".

## Plan decisions (where the spec is silent or the code constrains it)

Each is repeated as a "Plan decision:" next to the step that applies it.

- **Plan decision: ordinal space.** `visual_facts.ordinal` has `CHECK (ordinal BETWEEN 0 AND 15)` and `UNIQUE (tenant_id, document_id, ordinal)` (migration 0026), and extraction can fill all 16 (`MAX_FACTS`, unchanged). Migration 0035 (below) widens the ordinal CHECK to 0..17, and structure facts get **reserved ordinals: outline = 16, entity map = 17**. Extraction is NOT capped below 16. Reason: a collision would make one writer's insert fail or the other's replace delete the fact. **Ordinal schemas (P1):** the extracted kinds keep `Ordinal` (0..15, unchanged); the structure kinds have their own `StructureOrdinal` (16 or 17); `StoredEntry` accepts both (0..17), `StoredFact` (extracted only) still refuses 16 and 17.
- **Plan decision: each writer owns a range.** `PgVisualFacts.replace` (extraction) now deletes and writes only ordinals `< 16`; the new `replaceStructure` deletes and writes only ordinals `>= 16`. Neither can wipe the other. Order in one run: extract, then structure, then load. On the re-plan path that skips extraction, extraction writes nothing and the structure step still re-derives and replaces. A legacy extracted fact cannot exist (extraction never wrote above 15 and 16..17 were not allowed before migration 0035), so `replaceStructure` never removes an extracted fact. Reason: spec 3 "Storage" demands the structure facts survive an extraction replace and be re-derived on a re-plan.
- **Plan decision: `list` stays extracted-only; `listAll` is new.** `list` (used by extract's re-plan check and by chat) filters structure kinds out, so chat can never see a structure fact (S5) and extract's "stored facts" check ignores them. `listAll` (used by the load step and the UI reader that serves `visual.facts`) returns everything in ordinal order.
- **Plan decision: migration 0035 (the `kind` and `ordinal` CHECKs).** Migration 0026 declared `kind` and `ordinal` with inline, unnamed CHECKs, so Postgres named them `visual_facts_kind_check` (`kind IN ('series','figure','factTable')`) and `visual_facts_ordinal_check` (`ordinal BETWEEN 0 AND 15`). Controller ruling: structure facts are stored as their own kinds, not as `factTable`, and extraction is not cut. `infra/migrations/0035_visual_facts_structure_kinds.sql` drops both constraints and re-adds them under the same names: `kind IN ('series','figure','factTable','outline','cooccurrence')` and `ordinal BETWEEN 0 AND 17`, in one migration (one transaction). No data changes; the `UNIQUE (tenant_id, document_id, ordinal)` is untouched. The sealed fact's own `kind` is still authoritative; the column now also agrees with it.
- **Plan decision: fact shapes.** `outline`: `{ kind, title (1..80), nodes[3..120] of { id ("s" + the node's index among the kept nodes, so unique by position, spec 3), label (1..80), level (1..32), passageCount (0..100000), firstChunkId (uuid) }, chunkIds[1..120] }`, nodes in document (pre-)order with `level` encoding the tree (a node's parent is the nearest earlier node of `level - 1`). `cooccurrence`: `{ kind, entities[3..20] of { name (1..80), entityKind (the six entity kinds), passages (1..100000) }, edges[2..40] of { a, b (indexes into entities, a < b), weight (2..100000), firstChunkId (uuid) }, chunkIds[1..40] }`. Both `.strict()`; the stored ordinal is 16 (outline) or 17 (map). The shared `ChunkIds` cap of 8 does not apply to them.
- **Plan decision: root does not count toward the 120.** 120 heading nodes plus the title root (121 diagram nodes, under loom-ui's 200). The spec says "Cap: 120 nodes" and "the root is the document title" without saying which; counting headings keeps the cap meaning "sections".
- **Plan decision: pruning.** Whole deepest levels are removed while over 120 (never below level 1); if level 1 alone exceeds 120, the first 120 in document order are kept and the rest dropped (their count would fold into the root, which stores none). If fewer than 3 nodes remain after pruning there is no outline. Heading depth is clamped to 32.
- **Plan decision: what is a distinct heading.** Passages carry `section_ordinal` (plaintext) and a sealed `headingPath`. A new `section_ordinal` starts a new section: its ancestors reuse the open path when the text matches, and its **leaf is always a new node** (that is how a duplicate heading under one parent stays separate). A section with an empty heading path (text before the first heading) makes no node. A heading with no text becomes "Untitled section"; an empty document title becomes "Untitled document". `passageCount` = the passages of that section plus folded descendants; an ancestor node that has no section of its own gets `firstChunkId` of its first descendant passage and count 0.
- **Plan decision: entity candidates query.** SQL ranks this document's entities by passage count and returns those with `rank() <= 20` (so ties at the boundary are included), capped at 200 rows, so names are opened only for those few; the pure `topEntities` then sorts by count desc, name, id and keeps 20. A second index-bound query reads the kept entities' passages. Reason: ties break by decrypted name, which SQL cannot do, but a library-sized or document-sized name decrypt must be avoided.
- **Plan decision: unreadable means null.** The reader returns `null` for the whole kind when any heading passage, the title, or any candidate name fails to open (a non-key-store failure); the step then skips that one fact. A `FieldKeyStoreError` is rethrown, so the step fails and retries (STEP_RETRY).
- **Plan decision: step position and flow identity.** `visualize-structure` runs only when extraction did not end `skipped` (role off means no planner either). It is a plain `STEP_RETRY` step (no model). The facts present for the zero-fact rule are `extracted.count + structured.count`. The step list is part of the flow identity, so the flow version moves to `1.1.0` (the identity test is updated). **Deploy behaviour of in-flight runs.** Loom's flow hash covers the flow id and version, and pinned resumption resumes an execution only on the registered version whose hash matches the one recorded at its start (ADR 0023 K11.2); a build that registers only 1.1.0 would throw `FlowCodeMismatchError` for every `visualize-document` execution started on 1.0.0, and a changed step list would also trip replay-divergence detection (ADR 0113). Chat handled its 1.0.0 to 1.1.0 bump (docs/specs rolling-summary spec section 3, commit 0d6932b) by keeping 1.0.0 registered unchanged and registering 1.1.0 after it (Loom treats the last-registered version of an id as current). This plan does the same: `visualizeDocumentFlow(planner, { legacy: true })` builds the 1.0.0 definition (steps extract, load, commit; its runner never calls the structure step), `visualize` in `compose.ts` gains `legacyFlow`, and `buildApp` (`config.ts`) registers it BEFORE the 1.1.0 flow, so runs in flight at deploy finish on 1.0.0 (they simply have no structure facts; the next re-plan or retry, or the stale-format re-plan that the v3 catalogue triggers, adds them) and every new run starts on 1.1.0. Without the legacy runner a 1.0.0 execution would be replayed through the new runner and ask for a `visualize-structure` step its log never recorded. Task 3 step 15b does this and tests it (registration order, different hashes, a 1.0.0 run finishes without a structure step). 1.0.0 can be removed once no 1.0.0 `visualize-document` execution is live. Do not roll back past this release.
- **Plan decision: citation order.** `chunkIds` are ordered so the 16 refs are the most useful: the outline cites top-level sections first (level ascending, then document order); the map cites its strongest pairs first (weight desc).
- **Plan decision: planner sample (P3).** A structure capability's `sampleOutput` is content-free: counts plus a couple of neutral placeholder nodes and edges that carry no document text (outline `{ kind, sections, levels, nodes: [{ label: "Section", level: 1 }, ...] }`; map `{ kind, entities, links, nodes: [{ label: "Entity", group: "person" }, ...], edges: [{ from, to, label }] }`). The planner pins a binding by running its JSONPath over the sample (`jsonPathSelect`; loom-ui `materialize.ts` reports `reshape-invalid` when it selects nothing), so a count-only sample would make the `nodes` and `edges` paths select nothing and no structure widget could ever be planned. The placeholders make those paths validate while the fact itself stays out of the prompt (spec §5). The description states only counts. Tests: the sample selects `nodes` and `edges`, carries none of the fact's text, and planning an outline and a map binding raises no `reshape-invalid`.
- **Plan decision: fingerprint.** `factFormatFingerprint()` gains a `+docmind.structure@1` suffix (`STRUCTURE_FORMAT`) instead of bumping `PINS["visual.facts"]`. Reason: stored chat heads carry `docmind:visual.facts@1#...` pins that `factRefOfPin` must keep parsing; a pin bump would silently drop old chat widgets.
- **Plan decision: chat adoption (P2).** The turn path of `adoptVisuals` gets its own entry set (the four fact entries), so even a hand-made chat head with `DocumentOutline` is dropped. Adoption also pairs each entry with its ordinal (`entryFitsOrdinal`): fact entries read ordinals below 16, `DocumentOutline` only 16 and `EntityMap` only 17, so a hand-made head cannot read a structure fact through a fact widget or the reverse; `VISUAL_SHAPES` is built to match (`visual-outline-16`, `visual-entitymap-17`, and nothing else new).
- **Plan decision: e2e entities.** Ingest is keyless in `startIngestStack`, so no entities are extracted at upload. The e2e seeds entities with `PgEntityStore.replaceForDocument` after the first run, then re-plans through `POST /api/documents/:id/visuals/retry` (which is also the extraction-skipping path the spec requires to re-derive).
- **Plan decision: explicit owner and tenant predicates (P15).** Row-level security already scopes every statement to the tenant, but the structure SQL does not rely on it alone (as `connections.ts` does not): `PgVisualFacts` reads and deletes `WHERE tenant_id = $ AND owner_id = $ AND document_id = $`, and the reader's statements reach chunks and mentions through a `documents d` row with `d.tenant_id = $` and `d.owner_id = $`. `lockDocument` still guards the write path.
- **Plan decision: deterministic order (P6).** Nothing depends on the order of mentions within one passage (entity ids are random UUIDs): the builder keys on passage ordinal and set membership. `topEntities` orders by count desc, then name, then id. Tests that read mentions sort by (ordinal, name).
- **Plan decision: mentions walk from this document's passages (P11).** `MENTIONS_SQL` materializes this document's passages and probes `chunk_entities` once per passage through its primary key in a `LATERAL ... LIMIT` (the limit keeps the planner from flattening it into a join). Reason: with a "hub" entity (on every passage of the library) among the ids, the plain join `entity_id = ANY(...)` was planned as a sequential scan of the whole `chunk_entities` table (reproduced on Postgres 17 with 500 documents); the lateral form reads only this document's rows. The candidates query is index-bound in both shapes tried (200 and 5000 entities).

## File Structure

Created (server, `apps/server/app/flows/visualize-document/`):
- `structureText.ts`, `clipText`, `clipLabel`, `MAX_STRUCTURE_LABEL`.
- `outline.ts`, pure `buildOutline` and its constants/types.
- `cooccurrence.ts`, pure `topEntities`, `buildCooccurrence` and types.
- `structure.ts`, the `StructureReader` interface and the `visualize-structure` step effect.
- `pgStructure.ts`, `PgStructureReader` (owner-scoped, index-bound queries, opens sealed fields).
- Tests beside each (`*.test.ts`, `*.pg.test.ts`).

Created (experiences, `packages/experiences/src/`): `structureShapes.ts` (the two `DiagramValue` builders) and `structureShapes.test.ts`.

Modified: `facts.ts`, `pgFacts.ts`, `plan.ts`, `flow.ts`, `deps.ts`, `extract.ts` (server visualize-document); `visualize-turn/{deps,steps}.ts` (narrowed store type); `ui/readers.ts`; `compose.ts`; `config.ts`; `security.ts`; `packages/experiences/src/{visuals,providers,views}.ts` and their tests; `docs/architecture.md`, `docs/specs/2026-11-08-document-visuals-design.md`.

---

### Task 1: Pure outline builder

**Files:**
- Create: `apps/server/app/flows/visualize-document/structureText.ts`
- Create: `apps/server/app/flows/visualize-document/outline.ts`
- Test: `apps/server/app/flows/visualize-document/outline.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces (Tasks 3, 4 rely on these exact names):
  - `structureText.ts`: `export const MAX_STRUCTURE_LABEL = 80; export const clipText: (text: string, max: number) => string; export const clipLabel: (raw: string) => string`
  - `outline.ts`:
    - `export const MAX_OUTLINE_NODES = 120; export const MIN_HEADINGS = 3; export const MAX_OUTLINE_LEVEL = 32; export const UNTITLED_DOCUMENT = "Untitled document"`
    - `export interface OutlineNode { id: string; label: string; level: number; passageCount: number; firstChunkId: string }` (`id` = `s<index>` among the kept nodes, P18)
    - `export interface OutlineDraft { kind: "outline"; title: string; nodes: OutlineNode[]; chunkIds: string[] }`
    - `export interface HeadingRow { chunkId: string; sectionOrdinal: number; headingPath: readonly string[] }`
    - `export const outlineTitle: (raw: string) => string`
    - `export function buildOutline(title: string, rows: readonly HeadingRow[]): OutlineDraft | null` (rows in passage order; null = no outline)

- [ ] **Step 1: Write the failing test**

Create `apps/server/app/flows/visualize-document/outline.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  type HeadingRow,
  MAX_OUTLINE_NODES,
  UNTITLED_DOCUMENT,
  buildOutline,
  outlineTitle,
} from "./outline";
import { clipLabel, clipText } from "./structureText";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Rows of consecutive sections: `section(ordinal, path, passages)` makes `passages` rows sharing one section ordinal. */
function sections(...specs: [number, string[], number?][]): HeadingRow[] {
  const rows: HeadingRow[] = [];
  let n = 0;
  for (const [sectionOrdinal, headingPath, passages = 1] of specs)
    for (let i = 0; i < passages; i++) rows.push({ chunkId: id(++n), sectionOrdinal, headingPath });
  return rows;
}

describe("clipText and clipLabel", () => {
  it("clips to the limit without ending in half a surrogate pair", () => {
    expect(clipText("abcdef", 3)).toBe("abc");
    expect(clipText("ab😀", 3)).toBe("ab"); // the emoji is two UTF-16 units: 3 would cut it in half
    expect(clipText("abc", 5)).toBe("abc");
  });
  it("trims, then clips to 80 characters", () => {
    expect(clipLabel("  Methods  ")).toBe("Methods");
    expect(clipLabel("x".repeat(100))).toHaveLength(80);
    expect(clipLabel("   ")).toBe("");
  });
});

describe("buildOutline", () => {
  it("nests headings in document order and counts each section's own passages", () => {
    const rows = sections(
      [0, []], // text before the first heading makes no node
      [1, ["Intro"], 2],
      [2, ["Methods"]],
      [3, ["Methods", "Data"]],
      [4, ["Methods", "Model"]],
      [5, ["Results"]],
    );
    const o = buildOutline("Report", rows);
    expect(o?.title).toBe("Report");
    expect(o?.nodes.map((n) => [n.label, n.level, n.passageCount])).toEqual([
      ["Intro", 1, 2],
      ["Methods", 1, 1],
      ["Data", 2, 1],
      ["Model", 2, 1],
      ["Results", 1, 1],
    ]);
    // each node cites its first passage (rows are numbered from 1; row 1 is the empty-path preamble)
    expect(o?.nodes.map((n) => n.firstChunkId)).toEqual([id(2), id(4), id(5), id(6), id(7)]);
    // each node has an id unique by position (spec 3): the diagram node id
    expect(o?.nodes.map((n) => n.id)).toEqual(["s0", "s1", "s2", "s3", "s4"]);
  });

  it("makes the ancestors of a deep first section, with no passages of their own", () => {
    const rows = sections([1, ["A", "B"]], [2, ["A", "C"]], [3, ["D"]]);
    const o = buildOutline("T", rows);
    expect(o?.nodes.map((n) => [n.label, n.level, n.passageCount])).toEqual([
      ["A", 1, 0],
      ["B", 2, 1],
      ["C", 2, 1],
      ["D", 1, 1],
    ]);
    expect(o?.nodes[0]?.firstChunkId).toBe(id(1)); // the first descendant passage
  });

  it("keeps a duplicate heading under one parent as a separate node", () => {
    const o = buildOutline("T", sections([1, ["Notes"]], [2, ["Notes"]], [3, ["Other"]]));
    expect(o?.nodes.map((n) => n.label)).toEqual(["Notes", "Notes", "Other"]);
    expect(o?.nodes[0]?.firstChunkId).not.toBe(o?.nodes[1]?.firstChunkId);
  });

  it("produces no outline for fewer than 3 headings, counting distinct nodes", () => {
    expect(buildOutline("T", sections([1, ["A"]], [2, ["B"]]))).toBeNull();
    expect(buildOutline("T", sections([0, [], 5]))).toBeNull(); // a flat document
    expect(buildOutline("T", [])).toBeNull();
    expect(buildOutline("T", sections([1, ["A"]], [2, ["A", "B"]], [3, ["A", "C"]]))).not.toBeNull();
  });

  it("trims and clips labels to 80 characters and names an empty one", () => {
    const o = buildOutline(
      "T",
      sections([1, ["  Spaced  "]], [2, ["x".repeat(120)]], [3, ["   "]]),
    );
    expect(o?.nodes.map((n) => n.label)).toEqual(["Spaced", "x".repeat(80), "Untitled section"]);
  });

  it("titles the root, naming an empty title", () => {
    expect(outlineTitle("  My doc  ")).toBe("My doc");
    expect(outlineTitle("")).toBe(UNTITLED_DOCUMENT);
    expect(outlineTitle("t".repeat(200))).toHaveLength(80);
  });

  it("prunes the deepest level first over the cap and folds its passage counts into the parent", () => {
    // 2 level-1 + 20 level-2 + 140 level-3 = 162 headings, one passage each.
    const specs: [number, string[]][] = [];
    let s = 0;
    for (const a of ["A", "B"])
      for (let b = 0; b < 10; b++) {
        specs.push([++s, [a, `${a}${b}`]]);
        for (let c = 0; c < 7; c++) specs.push([++s, [a, `${a}${b}`, `${a}${b}.${c}`]]);
      }
    const o = buildOutline("T", sections(...specs));
    expect(o?.nodes).toHaveLength(22); // level 3 gone; 22 <= 120
    expect(o?.nodes.every((n) => n.level <= 2)).toBe(true);
    // ids are numbered over the kept nodes, so they stay unique and contiguous after pruning
    expect(o?.nodes.map((n) => n.id)).toEqual(Array.from({ length: 22 }, (_, i) => `s${i}`));
    const level2 = o?.nodes.filter((n) => n.level === 2) ?? [];
    expect(level2.every((n) => n.passageCount === 8)).toBe(true); // 1 own + 7 folded
  });

  it("keeps the first 120 level-1 headings when level 1 alone is over the cap", () => {
    const specs: [number, string[]][] = Array.from({ length: 130 }, (_, i) => [i + 1, [`H${i}`]]);
    const o = buildOutline("T", sections(...specs));
    expect(o?.nodes).toHaveLength(MAX_OUTLINE_NODES);
    expect(o?.nodes[119]?.label).toBe("H119");
  });

  it("produces nothing when pruning leaves fewer than 3 nodes", () => {
    const specs: [number, string[]][] = [];
    for (let i = 0; i < 130; i++) specs.push([i + 1, ["Only", `Sub${i}`]]);
    expect(buildOutline("T", sections(...specs))).toBeNull(); // pruning level 2 leaves just "Only"
  });

  it("orders the cited passages by level, then document order, without repeats", () => {
    const rows = sections([1, ["A"]], [2, ["A", "B"]], [3, ["C"]], [4, ["C", "D"]]);
    const o = buildOutline("T", rows);
    expect(o?.nodes.map((n) => n.label)).toEqual(["A", "B", "C", "D"]);
    expect(o?.chunkIds).toEqual([id(1), id(3), id(2), id(4)]); // A, C (level 1), then B, D
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/visualize-document/outline.test.ts`
Expected: FAIL (cannot find module `./outline` / `./structureText`).

- [ ] **Step 3: Write the implementation**

Create `apps/server/app/flows/visualize-document/structureText.ts`:

```ts
/** The longest label (a heading or an entity name) a structure fact keeps. */
export const MAX_STRUCTURE_LABEL = 80;

/** Cuts to at most `max` UTF-16 units, never ending in half a surrogate pair. */
export const clipText = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
};

/** A heading or a name as a label: trimmed and clipped to 80 characters; "" when nothing is left. */
export const clipLabel = (raw: string): string =>
  clipText(raw.trim(), MAX_STRUCTURE_LABEL).trimEnd();
```

Create `apps/server/app/flows/visualize-document/outline.ts`:

```ts
import { clipLabel } from "./structureText";

export const MAX_OUTLINE_NODES = 120;
export const MIN_HEADINGS = 3;
/** Heading depth is clamped here (markdown stops at 6, other formats go deeper). */
export const MAX_OUTLINE_LEVEL = 32;
export const UNTITLED_DOCUMENT = "Untitled document";
const UNTITLED_SECTION = "Untitled section";

export interface OutlineNode {
  /** `s<index>` among the kept nodes: unique by position (spec 3), and the diagram node id. */
  id: string;
  label: string;
  /** 1 for a top-level heading. A node's parent is the nearest earlier node of `level - 1`. */
  level: number;
  /** The passages of this section, plus those of pruned descendants folded into it. */
  passageCount: number;
  /** The first passage of the section (of its first descendant, for an ancestor with no section of its own). */
  firstChunkId: string;
}

export interface OutlineDraft {
  kind: "outline";
  title: string;
  /** In document (pre-)order. */
  nodes: OutlineNode[];
  /** The distinct `firstChunkId`s, top-level sections first, then document order. */
  chunkIds: string[];
}

/** A passage as the outline sees it: its section (plaintext ordinal) and the sealed heading path, opened. */
export interface HeadingRow {
  chunkId: string;
  sectionOrdinal: number;
  headingPath: readonly string[];
}

export const outlineTitle = (raw: string): string => clipLabel(raw) || UNTITLED_DOCUMENT;

interface Built {
  label: string;
  level: number;
  parent: number;
  own: number;
  first: string;
}

/**
 * The document's sections as a tree, or null when it has fewer than 3 headings (also after pruning). `rows` are the
 * document's passages in passage order. A new `sectionOrdinal` starts a new section: its ancestors reuse the open path
 * where the text matches and its leaf is always a new node, so a duplicate heading under one parent stays separate.
 * Over `MAX_OUTLINE_NODES` the deepest levels go first, each pruned node's passages folded into its parent.
 */
export function buildOutline(title: string, rows: readonly HeadingRow[]): OutlineDraft | null {
  const nodes: Built[] = [];
  let stack: number[] = [];
  let section: number | undefined;
  for (const row of rows) {
    const path = row.headingPath
      .slice(0, MAX_OUTLINE_LEVEL)
      .map((h) => clipLabel(h) || UNTITLED_SECTION);
    if (path.length === 0) {
      stack = []; // text before the first heading: no node
      section = row.sectionOrdinal;
      continue;
    }
    if (row.sectionOrdinal !== section) {
      section = row.sectionOrdinal;
      let shared = 0;
      while (
        shared < path.length - 1 &&
        shared < stack.length &&
        nodes[stack[shared] as number]?.label === path[shared]
      )
        shared++;
      stack = stack.slice(0, shared);
      for (let depth = shared; depth < path.length; depth++) {
        nodes.push({
          label: path[depth] as string,
          level: depth + 1,
          parent: depth === 0 ? -1 : (stack[depth - 1] as number),
          own: 0,
          first: row.chunkId,
        });
        stack.push(nodes.length - 1);
      }
    }
    const leaf = stack[stack.length - 1];
    if (leaf !== undefined) (nodes[leaf] as Built).own += 1;
  }
  if (nodes.length < MIN_HEADINGS) return null;

  const alive = nodes.map(() => true);
  let count = nodes.length;
  while (count > MAX_OUTLINE_NODES) {
    let deepest = 0;
    nodes.forEach((n, i) => {
      if (alive[i] && n.level > deepest) deepest = n.level;
    });
    if (deepest <= 1) break;
    nodes.forEach((n, i) => {
      if (!alive[i] || n.level !== deepest) return;
      alive[i] = false;
      count--;
      (nodes[n.parent] as Built).own += n.own;
    });
  }
  if (count > MAX_OUTLINE_NODES) {
    // Only level 1 is left: keep the first 120 in document order.
    let kept = 0;
    nodes.forEach((_, i) => {
      if (!alive[i]) return;
      if (kept < MAX_OUTLINE_NODES) kept++;
      else {
        alive[i] = false;
        count--;
      }
    });
  }
  const live = nodes.filter((_, i) => alive[i]);
  if (live.length < MIN_HEADINGS) return null;
  const out: OutlineNode[] = live.map((n, i) => ({
    id: `s${i}`,
    label: n.label,
    level: n.level,
    passageCount: n.own,
    firstChunkId: n.first,
  }));
  const byLevel = [...out.keys()].sort(
    (a, b) => (out[a] as OutlineNode).level - (out[b] as OutlineNode).level || a - b,
  );
  const chunkIds = [...new Set(byLevel.map((i) => (out[i] as OutlineNode).firstChunkId))];
  return { kind: "outline", title: outlineTitle(title), nodes: out, chunkIds };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/visualize-document/outline.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Typecheck and lint, then commit**

Run: `pnpm --filter @docmind/server typecheck && pnpm lint`
Expected: no errors (fix biome formatting with `pnpm lint:fix` if it only reports formatting).

```bash
git add apps/server/app/flows/visualize-document/structureText.ts apps/server/app/flows/visualize-document/outline.ts apps/server/app/flows/visualize-document/outline.test.ts
git commit -m "feat(visuals): pure document outline builder (120 nodes, 80-char labels, deepest levels pruned first)"
```

---

### Task 2: Pure co-occurrence builder

**Files:**
- Create: `apps/server/app/flows/visualize-document/cooccurrence.ts`
- Test: `apps/server/app/flows/visualize-document/cooccurrence.test.ts`

**Interfaces:**
- Consumes: `clipLabel` from `./structureText` (Task 1); `EntityKind` type from `../../crypto/entityKeys` (existing).
- Produces:
  - `export const MAX_MAP_ENTITIES = 20; export const MIN_SHARED_PASSAGES = 2; export const MAX_MAP_EDGES = 40; export const MIN_LINKED = 3`
  - `export interface EntityCandidate { id: string; kind: EntityKind; name: string; passages: number }`
  - `export interface Mention { entityId: string; chunkId: string; ordinal: number }` (`ordinal` = the passage's position in the document)
  - `export interface MapEntity { name: string; entityKind: EntityKind; passages: number }`
  - `export interface MapEdge { a: number; b: number; weight: number; firstChunkId: string }`
  - `export interface CooccurrenceDraft { kind: "cooccurrence"; entities: MapEntity[]; edges: MapEdge[]; chunkIds: string[] }`
  - `export function topEntities(candidates: readonly EntityCandidate[]): EntityCandidate[]` (sorted passages desc, name, id; at most 20; names clipped to 80; nameless dropped)
  - `export function buildCooccurrence(top: readonly EntityCandidate[], mentions: readonly Mention[]): CooccurrenceDraft | null`

- [ ] **Step 1: Write the failing test**

Create `apps/server/app/flows/visualize-document/cooccurrence.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  type EntityCandidate,
  type Mention,
  buildCooccurrence,
  topEntities,
} from "./cooccurrence";

const cid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const eid = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
const cand = (n: number, name: string, passages: number): EntityCandidate => ({
  id: eid(n),
  kind: "organization",
  name,
  passages,
});
/** `appear(entity, ...passage ordinals)` as mentions; the chunk id of passage `p` is `cid(p)`. */
const appear = (n: number, ...ordinals: number[]): Mention[] =>
  ordinals.map((o) => ({ entityId: eid(n), chunkId: cid(o), ordinal: o }));

describe("topEntities", () => {
  it("keeps the 20 most mentioned, breaking ties by name then id", () => {
    const all = Array.from({ length: 25 }, (_, i) => cand(i, `Name${String(i).padStart(2, "0")}`, 10));
    all.push(cand(100, "Zeta", 11), cand(101, "Alpha", 11));
    const top = topEntities(all);
    expect(top).toHaveLength(20);
    expect(top.slice(0, 3).map((e) => e.name)).toEqual(["Alpha", "Zeta", "Name00"]);
    expect(top[19]?.name).toBe("Name17");
  });

  it("clips names to 80 characters and drops a nameless candidate", () => {
    const top = topEntities([cand(1, "x".repeat(120), 3), cand(2, "   ", 9)]);
    expect(top).toHaveLength(1);
    expect(top[0]?.name).toHaveLength(80);
  });
});

describe("buildCooccurrence", () => {
  const trio = [cand(1, "Acme", 4), cand(2, "Bolt", 3), cand(3, "Cora", 2)];

  it("links entities that share at least 2 passages, weighted by the shared count", () => {
    const m = [
      ...appear(1, 1, 2, 3, 4),
      ...appear(2, 1, 2, 3),
      ...appear(3, 2, 3),
    ];
    const r = buildCooccurrence(trio, m);
    expect(r?.entities.map((e) => [e.name, e.passages])).toEqual([
      ["Acme", 4],
      ["Bolt", 3],
      ["Cora", 2],
    ]);
    // Acme-Bolt share 1,2,3 (3); Acme-Cora share 2,3 (2); Bolt-Cora share 2,3 (2)
    expect(r?.edges).toEqual([
      { a: 0, b: 1, weight: 3, firstChunkId: cid(1) },
      { a: 0, b: 2, weight: 2, firstChunkId: cid(2) },
      { a: 1, b: 2, weight: 2, firstChunkId: cid(2) },
    ]);
  });

  it("ignores a pair that shares only one passage", () => {
    const m = [...appear(1, 1, 2), ...appear(2, 1, 2), ...appear(3, 1)];
    const r = buildCooccurrence(trio, m);
    expect(r).toBeNull(); // Cora shares one passage with each: only Acme-Bolt is linked, 2 entities
  });

  it("drops an entity left with no edge and re-indexes the rest", () => {
    const four = [...trio, cand(4, "Dune", 2)];
    const m = [
      ...appear(1, 1, 2, 3),
      ...appear(2, 1, 2, 3),
      ...appear(3, 1, 2, 3),
      ...appear(4, 7, 8), // alone
    ];
    const r = buildCooccurrence(four, m);
    expect(r?.entities.map((e) => e.name)).toEqual(["Acme", "Bolt", "Cora"]);
    expect(r?.edges.every((e) => e.a < e.b && e.b <= 2)).toBe(true);
  });

  it("produces nothing with fewer than 3 linked entities", () => {
    const m = [...appear(1, 1, 2), ...appear(2, 1, 2)];
    expect(buildCooccurrence(trio.slice(0, 2), m)).toBeNull();
    expect(buildCooccurrence([], [])).toBeNull();
  });

  it("uses the first shared passage in document order, whatever order the mentions came in", () => {
    const m = [...appear(1, 9, 5, 7), ...appear(2, 7, 9, 5), ...appear(3, 5, 7)];
    const r = buildCooccurrence(trio, m);
    expect(r?.edges.find((e) => e.a === 0 && e.b === 1)?.firstChunkId).toBe(cid(5));
  });

  it("keeps the 40 strongest of 190 possible edges, strongest first, in a stable order", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => cand(i, `E${String(i).padStart(2, "0")}`, 5));
    // Every entity appears in passages 1..5, so all 190 pairs share 5 passages; a 6th passage links E00-E01 only.
    const m = twenty.flatMap((_, i) => appear(i, 1, 2, 3, 4, 5));
    m.push(...appear(0, 6), ...appear(1, 6));
    const r = buildCooccurrence(twenty.map((e, i) => (i < 2 ? { ...e, passages: 6 } : e)), m);
    expect(r?.entities).toHaveLength(20);
    expect(r?.edges).toHaveLength(40);
    expect(r?.edges[0]).toMatchObject({ a: 0, b: 1, weight: 6 });
    // The rest tie at weight 5 and keep pair order (a, then b): E00-E02 first, E02-E05 last.
    expect(r?.edges[1]).toMatchObject({ a: 0, b: 2, weight: 5 });
    expect(r?.edges[39]).toMatchObject({ a: 2, b: 5, weight: 5 });
    expect(r?.edges.every((e) => e.a < e.b)).toBe(true);
  });

  it("cites each distinct firstChunkId once, strongest edge first", () => {
    // Acme is in passages 1..6, Bolt in 1..3, Cora in 4..6, Dune in 1..2: the pairs' first shared passages differ.
    const four = [cand(1, "Acme", 6), cand(2, "Bolt", 3), cand(3, "Cora", 3), cand(4, "Dune", 2)];
    const m = [...appear(1, 1, 2, 3, 4, 5, 6), ...appear(2, 1, 2, 3), ...appear(3, 4, 5, 6), ...appear(4, 1, 2)];
    const r = buildCooccurrence(four, m);
    // Acme-Bolt 3 (first 1), Acme-Cora 3 (first 4), Acme-Dune 2 (first 1), Bolt-Dune 2 (first 1); Bolt-Cora and Cora-Dune share nothing
    expect(r?.edges).toEqual([
      { a: 0, b: 1, weight: 3, firstChunkId: cid(1) },
      { a: 0, b: 2, weight: 3, firstChunkId: cid(4) },
      { a: 0, b: 3, weight: 2, firstChunkId: cid(1) },
      { a: 1, b: 3, weight: 2, firstChunkId: cid(1) },
    ]);
    expect(r?.chunkIds).toEqual([cid(1), cid(4)]); // four edges, two distinct passages, strongest edge's passage first
  });

  it("leaves out the pair that shares a single passage and lists the others by weight", () => {
    const m = [...appear(1, 1, 2, 3, 4), ...appear(2, 3, 4, 1), ...appear(3, 1, 2)];
    const r = buildCooccurrence(trio, m);
    // Acme-Bolt weight 3 (first 1), Acme-Cora weight 2 (first 1), Bolt-Cora weight 1 (not an edge)
    expect(r?.edges.map((e) => e.weight)).toEqual([3, 2]);
    expect(r?.chunkIds).toEqual([cid(1)]);
  });
});
```

Note the last test's three entities link Acme to both others, so three entities are linked and a map is produced.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/visualize-document/cooccurrence.test.ts`
Expected: FAIL (cannot find module `./cooccurrence`).

- [ ] **Step 3: Write the implementation**

Create `apps/server/app/flows/visualize-document/cooccurrence.ts`:

```ts
import type { EntityKind } from "../../crypto/entityKeys";
import { clipLabel } from "./structureText";

export const MAX_MAP_ENTITIES = 20;
export const MIN_SHARED_PASSAGES = 2;
export const MAX_MAP_EDGES = 40;
export const MIN_LINKED = 3;

/** An entity of this document: its owner-scoped id, kind, opened name, and the number of this document's passages it is in. */
export interface EntityCandidate {
  id: string;
  kind: EntityKind;
  name: string;
  passages: number;
}

/** One passage an entity appears in; `ordinal` is the passage's position in the document. */
export interface Mention {
  entityId: string;
  chunkId: string;
  ordinal: number;
}

export interface MapEntity {
  name: string;
  entityKind: EntityKind;
  passages: number;
}
/** `a` and `b` index `entities` (a < b). */
export interface MapEdge {
  a: number;
  b: number;
  weight: number;
  firstChunkId: string;
}
export interface CooccurrenceDraft {
  kind: "cooccurrence";
  entities: MapEntity[];
  edges: MapEdge[];
  /** The distinct edge `firstChunkId`s, strongest edge first. */
  chunkIds: string[];
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The 20 most mentioned entities (ties by name, then id), names clipped to 80 characters; a nameless candidate is dropped. */
export function topEntities(candidates: readonly EntityCandidate[]): EntityCandidate[] {
  return candidates
    .map((c) => ({ ...c, name: clipLabel(c.name) }))
    .filter((c) => c.name !== "")
    .sort((a, b) => b.passages - a.passages || compare(a.name, b.name) || compare(a.id, b.id))
    .slice(0, MAX_MAP_ENTITIES);
}

interface Pair {
  a: number;
  b: number;
  weight: number;
  ordinal: number;
  chunkId: string;
}

/**
 * The entity map over `top` (from `topEntities`) and the passages those entities appear in: an edge for each pair sharing
 * at least 2 passages, the 40 strongest kept, entities with no edge dropped; null when fewer than 3 entities stay linked.
 */
export function buildCooccurrence(
  top: readonly EntityCandidate[],
  mentions: readonly Mention[],
): CooccurrenceDraft | null {
  const index = new Map(top.map((e, i) => [e.id, i]));
  const byChunk = new Map<string, { ordinal: number; members: number[] }>();
  for (const m of mentions) {
    const i = index.get(m.entityId);
    if (i === undefined) continue;
    const entry = byChunk.get(m.chunkId) ?? { ordinal: m.ordinal, members: [] };
    if (!entry.members.includes(i)) entry.members.push(i);
    byChunk.set(m.chunkId, entry);
  }
  const pairs = new Map<string, Pair>();
  for (const [chunkId, { ordinal, members }] of byChunk) {
    members.sort((x, y) => x - y);
    for (let x = 0; x < members.length; x++)
      for (let y = x + 1; y < members.length; y++) {
        const a = members[x] as number;
        const b = members[y] as number;
        const key = `${a}:${b}`;
        const pair = pairs.get(key);
        if (!pair) pairs.set(key, { a, b, weight: 1, ordinal, chunkId });
        else {
          pair.weight++;
          if (ordinal < pair.ordinal) {
            pair.ordinal = ordinal;
            pair.chunkId = chunkId;
          }
        }
      }
  }
  const strongest = [...pairs.values()]
    .filter((p) => p.weight >= MIN_SHARED_PASSAGES)
    .sort((p, q) => q.weight - p.weight || p.a - q.a || p.b - q.b)
    .slice(0, MAX_MAP_EDGES);
  const linked = [...new Set(strongest.flatMap((p) => [p.a, p.b]))].sort((x, y) => x - y);
  if (linked.length < MIN_LINKED) return null;
  const at = new Map(linked.map((old, i) => [old, i]));
  const entities = linked.map((i) => {
    const e = top[i] as EntityCandidate;
    return { name: e.name, entityKind: e.kind, passages: e.passages };
  });
  const edges = strongest.map((p) => ({
    a: at.get(p.a) as number,
    b: at.get(p.b) as number,
    weight: p.weight,
    firstChunkId: p.chunkId,
  }));
  return {
    kind: "cooccurrence",
    entities,
    edges,
    chunkIds: [...new Set(edges.map((e) => e.firstChunkId))],
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/visualize-document/cooccurrence.test.ts`
Expected: PASS. If the "ignores a pair that shares only one passage" or "orders the cited passages" expectations differ from your arithmetic, re-derive from the fixtures in the test (the fixtures are the contract), not by loosening the assertion.

- [ ] **Step 5: Typecheck, lint, commit**

Run: `pnpm --filter @docmind/server typecheck && pnpm lint`
Expected: clean.

```bash
git add apps/server/app/flows/visualize-document/cooccurrence.ts apps/server/app/flows/visualize-document/cooccurrence.test.ts
git commit -m "feat(visuals): pure entity co-occurrence builder (top 20, shared >= 2, 40 edges)"
```

---

### Task 3: Fact kinds, store, the `visualize-structure` step and the flow

**Files:**
- Modify: `apps/server/app/flows/visualize-document/facts.ts`, `pgFacts.ts`, `extract.ts`, `plan.ts`, `flow.ts`, `deps.ts`
- Create: `infra/migrations/0035_visual_facts_structure_kinds.sql`, `apps/server/app/flows/visualize-document/structure.ts`, `pgStructure.ts`
- Modify: `apps/server/app/flows/visualize-turn/deps.ts`, `apps/server/app/flows/visualize-turn/steps.ts`, `apps/server/app/ui/readers.ts`, `apps/server/app/compose.ts`, `apps/server/app/config.ts`, `apps/server/app/security.ts`, `packages/experiences/src/visuals.ts` and `index.ts` (types, description and sample only: step 12b)
- Test: `facts.test.ts`, `pgFacts.pg.test.ts`, `structure.test.ts`, `pgStructure.pg.test.ts`, `flow.test.ts`, `plan.test.ts` (existing stubs, plus the planning test), `security.test.ts`, `config.test.ts`, `ui/readers.test.ts` (stub rename), and in experiences `visuals.test.ts` (step 12b)

**Interfaces:**
- Consumes (Tasks 1 and 2): `OutlineDraft`, `HeadingRow`, `buildOutline`, `outlineTitle` from `./outline`; `CooccurrenceDraft`, `EntityCandidate`, `Mention`, `topEntities`, `buildCooccurrence`, `MAX_MAP_ENTITIES`, `MIN_LINKED` from `./cooccurrence`.
- Produces:
  - `facts.ts`: `STRUCTURE_ORDINAL_BASE = 16`, `OUTLINE_ORDINAL = 16`, `ENTITY_MAP_ORDINAL = 17`, `MAX_STORED_FACTS = MAX_FACTS + 2` (18); `type StructureFact = (OutlineDraft | CooccurrenceDraft) & { ordinal: number }`; `type AnyFact = Fact | StructureFact`; `StoredEntry` (zod discriminated union of the five kinds: the extracted kinds with `Ordinal` 0..15, the structure kinds with their own `StructureOrdinal` 16 | 17, so 0..17 in all); `isStructureFact(f: { kind: string }): f is StructureFact`; `MAX_FACTS`, `Ordinal`, `StoredFact` and `admit` unchanged (still capped at `MAX_FACTS` 16).
  - `pgFacts.ts` `VisualFactStore`: `async replace(ref, facts: readonly Fact[], signal?): Promise<number>` (owns ordinals < 16), `async replaceStructure(ref, facts: readonly StructureFact[], signal?): Promise<number>` (owns ordinals >= 16), `list(ref): Promise<Fact[]>` (extracted only), `listAll(ref): Promise<AnyFact[]>`.
  - `structure.ts`: `interface StructureReader { title(ref: VisualizeRef): Promise<string | null>; headings(ref): Promise<HeadingRow[] | null>; entities(ref): Promise<EntityCandidate[] | null>; mentions(ref, entityIds: readonly string[]): Promise<Mention[]> }`; `structureEffect(deps: StructureDeps): Effect<VisualizeRef, StepResult>`; `StructureDeps`.
  - `pgStructure.ts`: `class PgStructureReader implements StructureReader` (`constructor(pool: Pool, fields: FieldCrypto)`), `HEADINGS_SQL` (`$1` document, `$2` owner, `$3` tenant), `CANDIDATES_SQL` (`$1` owner, `$2` document, `$3` tenant, `$4` rank limit, `$5` row cap), `MENTIONS_SQL` (`$1` owner, `$2` document, `$3` tenant, `$4` entity ids), `ENTITY_CANDIDATE_CAP = 200`.
  - `flow.ts`: `visualizeStructureStep` (id `visualize-structure`), `VISUALIZE_STEPS` = extract, structure, load, commit, `LEGACY_VISUALIZE_STEPS` (the 1.0.0 list); `visualizeDocumentFlow(planner, { legacy })`; flow version `1.1.0` (legacy `1.0.0`).
  - `config.ts`: `visualizeFlows({ flow, legacyFlow? })` (the 1.0.0 flow first, then the current one) and `FlowDeps.visualize.legacyFlow`.
  - `deps.ts`: `VisualizeDeps.structure: StructureReader`; effect `"visualize-structure"`.
  - `plan.ts`: `LoadOutput.facts` is `z.array(StoredEntry).max(MAX_STORED_FACTS)` (18: 16 extracted plus the 2 structure facts); `planVisuals(planner, facts: readonly AnyFact[], ctx)`; `loadEffect` reads `facts.listAll`.

#### 3a. Fact kinds and the admit cap

- [ ] **Step 1: Write the failing tests**, append to `apps/server/app/flows/visualize-document/facts.test.ts` (extend its existing import from `./facts`, which already has `StoredFact` and `admit`, with `ENTITY_MAP_ORDINAL, MAX_FACTS, MAX_STORED_FACTS, OUTLINE_ORDINAL, StoredEntry, isStructureFact`; and add `import { buildCooccurrence, topEntities } from "./cooccurrence"; import { buildOutline } from "./outline";`):

```ts
describe("structure facts", () => {
  const cid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const eid = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
  const builtOutline = buildOutline("Report", [
    { chunkId: cid(1), sectionOrdinal: 1, headingPath: ["A"] },
    { chunkId: cid(2), sectionOrdinal: 2, headingPath: ["B"] },
    { chunkId: cid(3), sectionOrdinal: 3, headingPath: ["B", "C"] },
  ]);
  const cands = [1, 2, 3].map((n) => ({
    id: eid(n),
    kind: "person" as const,
    name: `P${n}`,
    passages: 2,
  }));
  const builtMap = buildCooccurrence(
    topEntities(cands),
    cands.flatMap((c) => [1, 2].map((o) => ({ entityId: c.id, chunkId: cid(o), ordinal: o }))),
  );
  // The builders are tested in Tasks 1 and 2; here they must have produced something (checked in the second test).
  const OUTLINE = builtOutline as NonNullable<typeof builtOutline>;
  const MAP = builtMap as NonNullable<typeof builtMap>;
  const FIGURE_FACT = { kind: "figure", label: "x", value: 1, chunkIds: [C1] } as const;

  it("reserves ordinals 16 and 17 above the 16 extracted ones", () => {
    expect([MAX_FACTS, OUTLINE_ORDINAL, ENTITY_MAP_ORDINAL]).toEqual([16, 16, 17]);
    expect(MAX_STORED_FACTS).toBe(MAX_FACTS + 2);
  });

  it("a built outline and a built map parse as stored facts and are structure facts", () => {
    expect(builtOutline).not.toBeNull();
    expect(builtMap).not.toBeNull();
    expect(OUTLINE.nodes.map((n) => n.id)).toEqual(["s0", "s1", "s2"]);
    const o = StoredEntry.parse({ ...OUTLINE, ordinal: OUTLINE_ORDINAL });
    const m = StoredEntry.parse({ ...MAP, ordinal: ENTITY_MAP_ORDINAL });
    expect(isStructureFact(o) && isStructureFact(m)).toBe(true);
    expect(isStructureFact(StoredEntry.parse({ ...FIGURE_FACT, ordinal: 0 }))).toBe(false);
  });

  it("keeps the ordinal ranges apart: extracted kinds 0..15, structure kinds 16 and 17 (separate schemas)", () => {
    const o = { ...OUTLINE, ordinal: 16 };
    const m = { ...MAP, ordinal: 17 };
    expect(StoredEntry.safeParse({ ...FIGURE_FACT, ordinal: 15 }).success).toBe(true);
    expect(StoredEntry.safeParse({ ...FIGURE_FACT, ordinal: 16 }).success).toBe(false);
    expect(StoredEntry.safeParse(o).success).toBe(true);
    expect(StoredEntry.safeParse(m).success).toBe(true);
    expect(StoredEntry.safeParse({ ...o, ordinal: 15 }).success).toBe(false);
    expect(StoredEntry.safeParse({ ...m, ordinal: 18 }).success).toBe(false);
    // StoredFact is what chat reads: extracted kinds only, 0..15
    expect(StoredFact.safeParse({ ...FIGURE_FACT, ordinal: 15 }).success).toBe(true);
    expect(StoredFact.safeParse({ ...FIGURE_FACT, ordinal: 16 }).success).toBe(false);
    expect(StoredFact.safeParse(o).success).toBe(false);
  });

  it("refuses an unknown key, too few nodes, an over-long label, a missing or empty node id and too few entities", () => {
    const base = { ...OUTLINE, ordinal: 16 };
    const first = base.nodes[0] as (typeof base.nodes)[number];
    const rest = base.nodes.slice(1);
    const parses = (over: object) => StoredEntry.safeParse({ ...base, ...over }).success;
    expect(parses({ extra: 1 })).toBe(false);
    expect(parses({ nodes: base.nodes.slice(0, 2) })).toBe(false);
    expect(parses({ nodes: [{ ...first, label: "x".repeat(81) }, ...rest] })).toBe(false);
    expect(parses({ nodes: [{ ...first, id: "" }, ...rest] })).toBe(false);
    expect(parses({ nodes: [{ ...first, id: undefined }, ...rest] })).toBe(false);
    const m = { ...MAP, ordinal: 17 };
    expect(StoredEntry.safeParse({ ...m, entities: m.entities.slice(0, 2) }).success).toBe(false);
  });
});
```

(`admit` and `MAX_FACTS` are unchanged, so the existing `admit` tests already cover the 16 cap; the ordinal-range test above is what is new.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/visualize-document/facts.test.ts`
Expected: FAIL (missing exports).

- [ ] **Step 3: Implement**, edit `apps/server/app/flows/visualize-document/facts.ts`.

Add imports at the top (after `import { z } from "zod";`):

```ts
import { ENTITY_KINDS } from "../../crypto/entityKeys";
import type { CooccurrenceDraft } from "./cooccurrence";
import type { OutlineDraft } from "./outline";
```

`MAX_FACTS` already exists (`export const MAX_FACTS = 16;`, line 3 of `facts.ts`): it is imported where needed and never redeclared (P8). Leave that line exactly as it is and add after it:

```ts
/**
 * Extraction keeps `MAX_FACTS` (16) facts at ordinals 0..15. `visual_facts.ordinal` is 0..17 after migration 0035, and 16 and 17
 * are reserved for the derived structure facts, which are written by their own step and never collide with an extracted fact.
 */
export const STRUCTURE_ORDINAL_BASE = 16;
export const OUTLINE_ORDINAL = 16;
export const ENTITY_MAP_ORDINAL = 17;
/** The most rows one document holds: the extracted facts plus the outline and the entity map. */
export const MAX_STORED_FACTS = MAX_FACTS + 2;
```

After the `FactTable` const, add the two zod shapes:

```ts
const StructureLabel = z.string().trim().min(1).max(80);
const PassageId = z.string().uuid();
const Count = z.number().int().min(0).max(100_000);
const Outline = z
  .object({
    kind: z.literal("outline"),
    title: StructureLabel,
    nodes: z
      .array(
        z
          .object({
            id: z.string().regex(/^s\d{1,3}$/), // "s" + the node's index: unique by position (spec 3)
            label: StructureLabel,
            level: z.number().int().min(1).max(32),
            passageCount: Count,
            firstChunkId: PassageId,
          })
          .strict(),
      )
      .min(3)
      .max(120),
    chunkIds: z.array(PassageId).min(1).max(120),
  })
  .strict();
const EntityIndex = z.number().int().min(0).max(19);
const EntityMap = z
  .object({
    kind: z.literal("cooccurrence"),
    entities: z
      .array(
        z
          .object({
            name: StructureLabel,
            entityKind: z.enum(ENTITY_KINDS),
            passages: z.number().int().min(1).max(100_000),
          })
          .strict(),
      )
      .min(3)
      .max(20),
    edges: z
      .array(
        z
          .object({
            a: EntityIndex,
            b: EntityIndex,
            weight: z.number().int().min(2).max(100_000),
            firstChunkId: PassageId,
          })
          .strict(),
      )
      .min(2)
      .max(40),
    chunkIds: z.array(PassageId).min(1).max(40),
  })
  .strict();
```

After `export type Fact = DraftFact & { ordinal: number };` and the `Ordinal`/`StoredFact` block, add:

```ts
/** A derived fact (never extracted by a model): the document's outline or its entity map. */
export type StructureFact = (OutlineDraft | CooccurrenceDraft) & { ordinal: number };
/** Everything `visual_facts` holds for a document. */
export type AnyFact = Fact | StructureFact;
/** Structure facts have their own ordinal schema: 16 for the outline, 17 for the map. The extracted `Ordinal` (0..15) is untouched. */
const StructureOrdinal = z.object({
  ordinal: z.union([z.literal(OUTLINE_ORDINAL), z.literal(ENTITY_MAP_ORDINAL)]),
});
/** A stored row of any kind (ordinals 0..17). `StoredFact` (extracted kinds, 0..15) stays what chat reads. */
export const StoredEntry = z.discriminatedUnion("kind", [
  Series.extend(Ordinal.shape),
  Figure.extend(Ordinal.shape),
  FactTable.extend(Ordinal.shape),
  Outline.extend(StructureOrdinal.shape),
  EntityMap.extend(StructureOrdinal.shape),
]);
export const isStructureFact = (f: { kind: string }): f is StructureFact =>
  f.kind === "outline" || f.kind === "cooccurrence";
```

`admit` and `extract.ts` are unchanged: extraction keeps `MAX_FACTS` (16) facts at ordinals 0..15, and the structure facts sit above them at 16 and 17.

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/visualize-document/facts.test.ts app/flows/visualize-document/extract.test.ts`
Expected: PASS. (No extract test changes: the cap stays 16.)

#### 3b. The store: shared replace semantics

- [ ] **Step 4b: Write the migration and its failing pg test.** Create `infra/migrations/0035_visual_facts_structure_kinds.sql` (0026 is merged: never edited; 0026's CHECKs were inline and unnamed, so Postgres named them `visual_facts_kind_check` and `visual_facts_ordinal_check`):

```sql
-- 0035: visual_facts also holds the derived structure facts (spec docs/specs/2026-11-10-structure-diagrams-c1-design.md S7).
-- 0026's inline CHECKs were auto-named; the new ones keep those names. Ordinals 16 and 17 are reserved for structure facts.
ALTER TABLE visual_facts DROP CONSTRAINT visual_facts_kind_check;
ALTER TABLE visual_facts DROP CONSTRAINT visual_facts_ordinal_check;
ALTER TABLE visual_facts ADD CONSTRAINT visual_facts_kind_check
  CHECK (kind IN ('series', 'figure', 'factTable', 'outline', 'cooccurrence'));
ALTER TABLE visual_facts ADD CONSTRAINT visual_facts_ordinal_check CHECK (ordinal BETWEEN 0 AND 17);
```

It grants nothing, so the function allowlist in `apps/server/app/db/embeddings.pg.test.ts` and the table-exemption lists in `tenancy.test.ts` need no change; still read both and `apps/server/app/db/migrate.test.ts` (it migrates temp directories, not the real list) and `docs/codebase-guide.md` line 77 ("Ordered SQL migrations 0001-0025" is already stale; set it to 0001-0035), and grep `apps packages infra` for any other test that enumerates migration names or counts them (`rg "0034_|schema_migrations"`) and extend it. In `apps/server/app/flows/visualize-document/pgFacts.pg.test.ts` add (raw inserts through `fx.db.owner`, using a seeded document `ref`):

```ts
  it("migration 0035 admits the structure kinds at ordinals 16 and 17 and still refuses anything else", async () => {
    const ref = await fx.doc("a0".repeat(32));
    const chunk = await seedChunk(ref);
    const insert = (kind: string, ordinal: number) =>
      fx.db.owner.query(
        "INSERT INTO visual_facts (id, tenant_id, owner_id, document_id, kind, ordinal, fact_enc, chunk_ids) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, '{}'::jsonb, $6::uuid[])",
        [ref.tenantId, ref.userId, ref.documentId, kind, ordinal, [chunk]],
      );
    await insert("outline", 16);
    await insert("cooccurrence", 17);
    await expect(insert("figure", 18)).rejects.toThrow(/visual_facts_ordinal_check/);
    await expect(insert("diagram", 3)).rejects.toThrow(/visual_facts_kind_check/);
    const names = await fx.db.owner.query(
      "SELECT conname FROM pg_constraint WHERE conrelid = 'visual_facts'::regclass AND contype = 'c' ORDER BY conname",
    );
    expect(names.rows.map((r) => r.conname)).toEqual(["visual_facts_kind_check", "visual_facts_ordinal_check"]);
  });
```

(Adapt `seedChunk` and the owner pool to the helpers already in that file; the table's `fact_enc` is only `NOT NULL`, so a bare `'{}'` is enough for a constraint test.) Run it before the migration exists to see it fail (`outline` violates `visual_facts_kind_check`), then after.

- [ ] **Step 5: Write the failing pg tests**, append inside the `describe.skipIf(!PG_URL)` block of `apps/server/app/flows/visualize-document/pgFacts.pg.test.ts` (add `import { ENTITY_MAP_ORDINAL, OUTLINE_ORDINAL, type StructureFact } from "./facts";` merged with the existing `import type { Fact }` line). **Fingerprints (P5):** the existing tests of this file already use `"1"` to `"5"` repeated 64 times, and a document's `(tenant, owner, fingerprint)` is UNIQUE, so every new test uses its own value (`"a0".repeat(32)` above, `"b1"`, `"b2"`, `"b3"`, `"b4"` repeated 32 times below):

```ts
  const outlineFact = (chunk: string): StructureFact => ({
    kind: "outline",
    title: "Zebra-Secret-Title",
    nodes: ["Zebra-Heading-A", "Zebra-Heading-B", "Zebra-Heading-C"].map((label, i) => ({
      id: `s${i}`,
      label,
      level: 1,
      passageCount: 1,
      firstChunkId: chunk,
    })),
    chunkIds: [chunk],
    ordinal: OUTLINE_ORDINAL,
  });
  const mapFact = (chunk: string): StructureFact => ({
    kind: "cooccurrence",
    entities: ["Zebra-Ent-A", "Zebra-Ent-B", "Zebra-Ent-C"].map((name) => ({
      name,
      entityKind: "organization" as const,
      passages: 2,
    })),
    edges: [
      { a: 0, b: 1, weight: 2, firstChunkId: chunk },
      { a: 1, b: 2, weight: 2, firstChunkId: chunk },
    ],
    chunkIds: [chunk],
    ordinal: ENTITY_MAP_ORDINAL,
  });

  it("extraction and structure each replace only their own ordinals", async () => {
    const ref = await fx.doc("b1".repeat(32));
    const chunk = await seedChunk(ref);
    const store = new PgVisualFacts(fx.app, fx.fields);
    await store.replace(ref, [fig(0, chunk), fig(1, chunk)]);
    expect(await store.replaceStructure(ref, [outlineFact(chunk), mapFact(chunk)])).toBe(2);
    expect((await store.listAll(ref)).map((f) => [f.ordinal, f.kind])).toEqual([
      [0, "figure"],
      [1, "figure"],
      [16, "outline"],
      [17, "cooccurrence"],
    ]);
    // A re-extraction does not wipe the structure facts...
    await store.replace(ref, [fig(0, chunk)]);
    expect((await store.listAll(ref)).map((f) => f.ordinal)).toEqual([0, 16, 17]);
    // ...and a structure replace does not wipe the extracted ones; an empty replace clears just its own range.
    await store.replaceStructure(ref, [outlineFact(chunk)]);
    expect((await store.listAll(ref)).map((f) => f.ordinal)).toEqual([0, 16]);
    await store.replaceStructure(ref, []);
    expect((await store.listAll(ref)).map((f) => f.ordinal)).toEqual([0]);
  });

  it("list returns the extracted facts only, so chat and the re-plan check never see a structure fact", async () => {
    const ref = await fx.doc("b2".repeat(32));
    const chunk = await seedChunk(ref);
    const store = new PgVisualFacts(fx.app, fx.fields);
    await store.replace(ref, [fig(0, chunk)]);
    await store.replaceStructure(ref, [outlineFact(chunk)]);
    expect((await store.list(ref)).map((f) => f.kind)).toEqual(["figure"]);
  });

  it("refuses a fact outside the writer's ordinal range", async () => {
    const ref = await fx.doc("b3".repeat(32));
    const chunk = await seedChunk(ref);
    const store = new PgVisualFacts(fx.app, fx.fields);
    await expect(store.replace(ref, [fig(16, chunk)])).rejects.toThrow(/ordinals below 16/);
    await expect(
      store.replaceStructure(ref, [{ ...outlineFact(chunk), ordinal: 3 }]),
    ).rejects.toThrow(/ordinals 16 and 17/);
  });

  it("stores structure facts sealed, with their own column kind (migration 0035), owner-scoped", async () => {
    const ref = await fx.doc("b4".repeat(32));
    const chunk = await seedChunk(ref);
    const store = new PgVisualFacts(fx.app, fx.fields);
    await store.replaceStructure(ref, [outlineFact(chunk), mapFact(chunk)]);
    const raw = await fx.db.owner.query(
      "SELECT kind, fact_enc::text AS t FROM visual_facts WHERE document_id = $1 ORDER BY ordinal",
      [ref.documentId],
    );
    expect(raw.rows.map((r) => r.kind)).toEqual(["outline", "cooccurrence"]);
    for (const r of raw.rows) {
      expect(r.t).not.toContain("Zebra");
      expect(r.t).not.toContain("outline");
    }
    await expect(store.listAll({ ...ref, userId: U1B })).rejects.toBeInstanceOf(DocumentGoneError);
    await expect(store.replaceStructure({ ...ref, userId: U1B }, [])).rejects.toBeInstanceOf(
      DocumentGoneError,
    );
  });
```

- [ ] **Step 6: Run to verify failure**

Run: `set -a; . ./.env; set +a; pnpm --filter @docmind/server exec vitest run app/flows/visualize-document/pgFacts.pg.test.ts`
Expected: FAIL (`replaceStructure`/`listAll` are not functions). Confirm the summary shows these tests ran, not skipped.

- [ ] **Step 7: Implement**, replace the body of `apps/server/app/flows/visualize-document/pgFacts.ts` from `import` through the class with:

```ts
import { randomUUID } from "node:crypto";
import { ParseAbortedError } from "@docmind/parsers";
import type { Pool } from "pg";
import type { FieldCrypto } from "../../crypto/fields";
import { withTenant } from "../../db/tenant";
import { lockDocument } from "../ingest-document/pgEntities";
import {
  type AnyFact,
  ENTITY_MAP_ORDINAL,
  type Fact,
  OUTLINE_ORDINAL,
  STRUCTURE_ORDINAL_BASE,
  StoredEntry,
  type StructureFact,
  isStructureFact,
} from "./facts";

export type VisualizeRef = { tenantId: string; userId: string; documentId: string };

export interface VisualFactStore {
  /**
   * Replaces the document's EXTRACTED facts (ordinals below 16) in one transaction; returns the rows written. The structure
   * facts (ordinals 16 and 17) are not touched.
   */
  replace(ref: VisualizeRef, facts: readonly Fact[], signal?: AbortSignal): Promise<number>;
  /** Replaces the document's STRUCTURE facts (ordinals 16 and 17) in one transaction; the extracted facts are not touched. */
  replaceStructure(
    ref: VisualizeRef,
    facts: readonly StructureFact[],
    signal?: AbortSignal,
  ): Promise<number>;
  /** The document's extracted facts in ordinal order: what chat and the extraction re-plan check read. Throws DocumentGoneError if the user does not own it. */
  list(ref: VisualizeRef): Promise<Fact[]>;
  /** Every fact of the document, structure facts included, in ordinal order. Throws DocumentGoneError if the user does not own it. */
  listAll(ref: VisualizeRef): Promise<AnyFact[]>;
}

const factBind = (id: string) => `visualfact:${id}:fact`;

export class PgVisualFacts implements VisualFactStore {
  constructor(
    private readonly pool: Pool,
    private readonly fields: FieldCrypto,
  ) {}

  // `async`, so a refused range is a rejected promise (as every caller and test sees it), never a synchronous throw.
  async replace(ref: VisualizeRef, facts: readonly Fact[], signal?: AbortSignal): Promise<number> {
    if (facts.some((f) => f.ordinal >= STRUCTURE_ORDINAL_BASE))
      throw new Error("extracted facts use ordinals below 16");
    return this.write(ref, facts, "<", signal);
  }

  async replaceStructure(
    ref: VisualizeRef,
    facts: readonly StructureFact[],
    signal?: AbortSignal,
  ): Promise<number> {
    if (facts.some((f) => f.ordinal !== OUTLINE_ORDINAL && f.ordinal !== ENTITY_MAP_ORDINAL))
      throw new Error("structure facts use ordinals 16 and 17");
    return this.write(ref, facts, ">=", signal);
  }

  /** `side` is the comparison of the writer's range against the base ordinal: `<` (extracted) or `>=` (structure). */
  private async write(
    ref: VisualizeRef,
    facts: readonly AnyFact[],
    side: "<" | ">=",
    signal?: AbortSignal,
  ): Promise<number> {
    // Sealing may call the key store: do it before the transaction, never under row locks.
    const cipher = this.fields.forUser(ref.userId);
    const rows = await Promise.all(
      facts.map(async (f) => {
        const id = randomUUID();
        return {
          id,
          // The column carries the fact's own kind (migration 0035 widened its CHECK); the sealed fact's `kind` is what readers use.
          kind: f.kind,
          ordinal: f.ordinal,
          chunkIds: f.chunkIds,
          sealed: JSON.stringify(await cipher.seal(factBind(id), f)),
        };
      }),
    );
    await withTenant(this.pool, ref.tenantId, async (tx) => {
      await lockDocument(tx, ref);
      await tx.query(
        `DELETE FROM visual_facts
          WHERE tenant_id = $1 AND owner_id = $2 AND document_id = $3 AND ordinal ${side} $4`,
        [ref.tenantId, ref.userId, ref.documentId, STRUCTURE_ORDINAL_BASE],
      );
      for (const r of rows) {
        await tx.query(
          `INSERT INTO visual_facts (id, tenant_id, owner_id, document_id, kind, ordinal, fact_enc, chunk_ids)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::uuid[])`,
          [r.id, ref.tenantId, ref.userId, ref.documentId, r.kind, r.ordinal, r.sealed, r.chunkIds],
        );
      }
      if (signal?.aborted) throw new ParseAbortedError();
    });
    return rows.length;
  }

  async listAll(ref: VisualizeRef): Promise<AnyFact[]> {
    const res = await withTenant(this.pool, ref.tenantId, async (tx) => {
      await lockDocument(tx, ref);
      return tx.query<{ id: string; fact_enc: unknown }>(
        `SELECT id, fact_enc FROM visual_facts
          WHERE tenant_id = $1 AND owner_id = $2 AND document_id = $3 ORDER BY ordinal`,
        [ref.tenantId, ref.userId, ref.documentId],
      );
    });
    const cipher = this.fields.forUser(ref.userId);
    return Promise.all(
      res.rows.map(async (r) => {
        const parsed = StoredEntry.safeParse(await cipher.open(factBind(r.id), r.fact_enc));
        if (!parsed.success) throw new Error("visual fact has an unexpected shape");
        return parsed.data as AnyFact;
      }),
    );
  }

  async list(ref: VisualizeRef): Promise<Fact[]> {
    return (await this.listAll(ref)).filter((f): f is Fact => !isStructureFact(f));
  }
}
```

Both the `DELETE` and the read name the tenant and the owner (P15) as well as the document; `$4` is the base ordinal 16 on either side of which a writer owns its range. `replace` and `replaceStructure` are `async` (P4), so the guard tests' `.rejects` see the throw.

Narrow what chat and the UI reader need, so their test stubs and the store's growth stay decoupled:

- `apps/server/app/flows/visualize-turn/deps.ts`: change `stored: VisualFactStore;` to `stored: Pick<VisualFactStore, "list">;`
- `apps/server/app/flows/visualize-turn/steps.ts`: change line 28 `facts: VisualFactStore;` to `facts: Pick<VisualFactStore, "list">;` and line 141 `stored: VisualFactStore;` to `stored: Pick<VisualFactStore, "list">;`
- `apps/server/app/flows/visualize-document/extract.ts`: change `facts: VisualFactStore;` (line 44) to `facts: Pick<VisualFactStore, "replace" | "list">;`
- `apps/server/app/ui/readers.ts`: change `visualFacts: VisualFactStore;` to `visualFacts: Pick<VisualFactStore, "listAll">;` and in `visualFacts({ id })` replace `await deps.visualFacts.list({` with `await deps.visualFacts.listAll({`.
- `apps/server/app/ui/readers.test.ts`: the `visualFacts` reader tests stub the store as `{ visualFacts: { list } }` (three places, in "the visualFacts reader" and "citations on facts"); rename the key to `listAll` (`{ visualFacts: { listAll: list } }`) so they exercise the reader's new call.
- `pnpm typecheck:tests` also flags, in `visualize-turn` tests such as `flow.test.ts` line 98 and `steps.facts.test.ts` line 84, a stub that passes `replace` where the narrowed `Pick<VisualFactStore, "list">` takes only `list` (excess property): drop the extra key there.

- [ ] **Step 8: Run to verify pass**

Run: `set -a; . ./.env; set +a; pnpm --filter @docmind/server exec vitest run app/flows/visualize-document/pgFacts.pg.test.ts`
Expected: PASS, none skipped.

#### 3c. The reader and its queries

- [ ] **Step 9: Write the failing pg test**, create `apps/server/app/flows/visualize-document/pgStructure.pg.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EntityKeys } from "../../crypto/entityKeys";
import { type FieldCrypto, FieldKeyStoreError } from "../../crypto/fields";
import { withTenant } from "../../db/tenant";
import { PG_URL } from "../../db/testSupport";
import { T1, T2, U1, U1B } from "../../documents/testHarness";
import { chunkIdFor } from "../ingest-document/chunker";
import { DocumentGoneError } from "../ingest-document/errors";
import { PgChunkStore } from "../ingest-document/pgChunks";
import { PgEntityStore } from "../ingest-document/pgEntities";
import { type PgFixture, startPgFixture } from "../ingest-document/pgFixture";
import { CANDIDATES_SQL, MENTIONS_SQL, PgStructureReader } from "./pgStructure";

const chunk = (ordinal: number, sectionOrdinal: number, headingPath: string[]) => ({
  ordinal,
  sectionOrdinal,
  headingPath,
  text: `Zebra passage text ${ordinal}`,
  tokenCount: 4,
  locator: { kind: "chars" as const, start: ordinal * 10, end: ordinal * 10 + 5 },
});

describe.skipIf(!PG_URL)("PgStructureReader (needs DOCMIND_TEST_PG_URL)", () => {
  let fx: PgFixture;
  beforeAll(async () => {
    fx = await startPgFixture();
  });
  afterAll(async () => {
    await fx?.close();
  });

  async function seed(fp: string, headings: string[][]) {
    const ref = await fx.doc(fp);
    await new PgChunkStore(fx.app, fx.fields).replace(
      ref,
      headings.map((path, i) => chunk(i, i, path)),
    );
    return ref;
  }
  const reader = (fields: FieldCrypto = fx.fields) => new PgStructureReader(fx.app, fields);
  const entities = () => new PgEntityStore(fx.app, fx.fields, new EntityKeys(fx.keys));

  it("reads each passage's section and opened heading path in passage order, and the title", async () => {
    const ref = await seed("a".repeat(64), [[], ["Intro"], ["Methods"], ["Methods", "Data"]]);
    const rows = await reader().headings(ref);
    expect(rows?.map((r) => [r.chunkId, r.sectionOrdinal, r.headingPath])).toEqual([
      [chunkIdFor(ref.documentId, 0), 0, []],
      [chunkIdFor(ref.documentId, 1), 1, ["Intro"]],
      [chunkIdFor(ref.documentId, 2), 2, ["Methods"]],
      [chunkIdFor(ref.documentId, 3), 3, ["Methods", "Data"]],
    ]);
    expect(await reader().title(ref)).toBe("Quarterly report"); // the fixture document's title, opened under the owner's key
  });

  it("is owner-scoped: another user's document is gone", async () => {
    const ref = await seed("b".repeat(64), [["A"]]);
    const other = { ...ref, userId: U1B };
    await expect(reader().headings(other)).rejects.toBeInstanceOf(DocumentGoneError);
    await expect(reader().title(other)).rejects.toBeInstanceOf(DocumentGoneError);
    await expect(reader().entities(other)).resolves.toEqual([]);
    await expect(reader().mentions(other, [randomUUID()])).resolves.toEqual([]);
  });

  it("returns null when a passage does not open, and rethrows a key-store outage", async () => {
    const ref = await seed("c".repeat(64), [["A"], ["B"]]);
    await fx.db.owner.query("UPDATE chunks SET text_enc = '{\"x\":1}'::jsonb WHERE id = $1", [
      chunkIdFor(ref.documentId, 0),
    ]);
    expect(await reader().headings(ref)).toBeNull();
    const down = {
      forUser: () => ({
        open: async () => {
          throw new FieldKeyStoreError();
        },
        openText: async () => {
          throw new FieldKeyStoreError();
        },
      }),
    } as unknown as FieldCrypto;
    await expect(reader(down).headings(ref)).rejects.toBeInstanceOf(FieldKeyStoreError);
    await expect(reader(down).title(ref)).rejects.toBeInstanceOf(FieldKeyStoreError);
  });

  it("counts this document's passages per entity, ranks them, and reads the kept entities' passages", async () => {
    const ref = await seed("d".repeat(64), [["A"], ["B"], ["C"], ["D"]]);
    const other = await seed("e".repeat(64), [["A"]]);
    const ids = [0, 1, 2, 3].map((i) => chunkIdFor(ref.documentId, i));
    await entities().replaceForDocument(ref, [
      { name: "Acme Ltd", kind: "organization", chunkIds: [ids[0], ids[1], ids[2]] as string[] },
      { name: "Bolt Inc", kind: "organization", chunkIds: [ids[1], ids[2]] as string[] },
      { name: "Cora", kind: "person", chunkIds: [ids[3]] as string[] },
    ]);
    // Acme also appears in another document: those passages must not count here.
    await entities().replaceForDocument(other, [
      { name: "Acme Ltd", kind: "organization", chunkIds: [chunkIdFor(other.documentId, 0)] },
    ]);
    const got = await reader().entities(ref);
    expect(got?.map((e) => [e.name, e.kind, e.passages])).toEqual([
      ["Acme Ltd", "organization", 3],
      ["Bolt Inc", "organization", 2],
      ["Cora", "person", 1],
    ]);
    const acme = got?.[0]?.id as string;
    const bolt = got?.[1]?.id as string;
    const mentions = await reader().mentions(ref, [acme, bolt]);
    // In passage order. Within one passage the order is by entity id (a random UUID), so it is not asserted:
    // the pairs are compared after sorting by (ordinal, name) (P6).
    expect(mentions.map((m) => m.ordinal)).toEqual([...mentions.map((m) => m.ordinal)].sort((a, b) => a - b));
    const nameOf = new Map(got?.map((e) => [e.id, e.name]));
    const pairs = mentions
      .map((m) => [m.ordinal, nameOf.get(m.entityId) as string] as const)
      .sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    expect(pairs).toEqual([
      [0, "Acme Ltd"],
      [1, "Acme Ltd"],
      [1, "Bolt Inc"],
      [2, "Acme Ltd"],
      [2, "Bolt Inc"],
    ]);
    expect(mentions.map((m) => m.chunkId).sort()).toEqual(
      [ids[0], ids[1], ids[1], ids[2], ids[2]].sort(),
    );
  });

  it("returns null when an entity name does not open", async () => {
    const ref = await seed("f".repeat(64), [["A"], ["B"]]);
    await entities().replaceForDocument(ref, [
      { name: "Acme Ltd", kind: "organization", chunkIds: [chunkIdFor(ref.documentId, 0)] },
    ]);
    await fx.db.owner.query("UPDATE entities SET name_enc = '{\"x\":1}'::jsonb WHERE owner_id = $1 AND id IN (SELECT entity_id FROM chunk_entities WHERE chunk_id = $2)", [
      U1,
      chunkIdFor(ref.documentId, 0),
    ]);
    expect(await reader().entities(ref)).toBeNull();
  });
});

describe.skipIf(!PG_URL)(
  "the co-occurrence queries on a library of 500 documents (needs DOCMIND_TEST_PG_URL)",
  () => {
    let fx: PgFixture;
    let selfId: string;
    const ENTITIES = 5000;
    beforeAll(async () => {
      fx = await startPgFixture();
      const c = await fx.db.owner.connect();
      try {
        // The library: 500 documents x 8 passages (4000), 5000 entities, one mention per passage, plus the cases below.
        await c.query(
          `INSERT INTO documents (id, tenant_id, owner_id, title_enc, filename_enc, mime, size_bytes, content_address, fingerprint)
           SELECT gen_random_uuid(), $1::uuid, $2::uuid, '{"x":1}'::jsonb, '{"x":1}'::jsonb, 'text/plain', 1,
                  'hmac-sha256:' || lpad(to_hex(g), 64, '0'), lpad(to_hex(g), 64, '0')
             FROM generate_series(1, 500) g`,
          [T1, U1],
        );
        await c.query(
          `INSERT INTO chunks (id, tenant_id, document_id, ordinal, section_ordinal, text_enc, locator, token_count)
           SELECT gen_random_uuid(), d.tenant_id, d.id, o, 0, '{"x":1}'::jsonb, '{"kind":"section","index":0}'::jsonb, 1
             FROM documents d CROSS JOIN generate_series(0, 7) o`,
        );
        await c.query(
          `INSERT INTO entities (id, tenant_id, owner_id, kind, name_enc, name_key)
           SELECT gen_random_uuid(), $1::uuid, $2::uuid, 'organization', '{"x":1}'::jsonb, lpad(to_hex(g), 64, '0')
             FROM generate_series(1, ${ENTITIES}) g`,
          [T1, U1],
        );
        await c.query(`CREATE TEMP TABLE seed_chunks AS
          SELECT tenant_id, id, row_number() OVER (ORDER BY id) AS rn FROM chunks`);
        await c.query(`CREATE TEMP TABLE seed_entities AS
          SELECT id, row_number() OVER (ORDER BY id) AS rn FROM entities`);
        await c.query(`INSERT INTO chunk_entities (tenant_id, chunk_id, entity_id)
          SELECT c.tenant_id, c.id, e.id FROM seed_chunks c JOIN seed_entities e ON e.rn = (c.rn % ${ENTITIES}) + 1`);
        // This document (the first by id) names 50 more entities, spread over its 8 passages.
        await c.query(
          `INSERT INTO chunk_entities (tenant_id, chunk_id, entity_id)
           SELECT mc.tenant_id, mc.id, e.id
             FROM (SELECT id, tenant_id FROM documents ORDER BY id LIMIT 1) d
             JOIN chunks mc ON mc.document_id = d.id
             JOIN seed_entities e ON e.rn <= 50 AND e.rn % 8 = mc.ordinal
           ON CONFLICT DO NOTHING`,
        );
        // A hub: one entity on every passage of the library, so on every passage of this document too.
        await c.query(
          `INSERT INTO entities (id, tenant_id, owner_id, kind, name_enc, name_key)
           VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'organization', '{"x":1}'::jsonb, lpad(to_hex(100000), 64, '0'))`,
          [T1, U1],
        );
        await c.query(`INSERT INTO chunk_entities (tenant_id, chunk_id, entity_id)
          SELECT c.tenant_id, c.id, e.id FROM chunks c, entities e WHERE e.name_key = lpad(to_hex(100000), 64, '0')`);
        await c.query("ANALYZE");
      } finally {
        c.release();
      }
      selfId = (await fx.db.owner.query("SELECT id FROM documents ORDER BY id LIMIT 1")).rows[0].id;
    }, 120_000);
    afterAll(async () => {
      await fx?.close();
    });

    type PlanNode = {
      "Node Type": string;
      "Relation Name"?: string;
      "Actual Rows"?: number;
      "Actual Loops"?: number;
      "Rows Removed by Filter"?: number;
      Plans?: PlanNode[];
    };
    const walk = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(walk)];
    /** Plans and runs `sql` as the app role under the DEFAULT planner settings, with the parameters as literals. */
    async function explain(sql: string, params: unknown[]) {
      return withTenant(fx.app, T1, async (tx) => {
        const inline = sql.replace(/\$(\d+)/g, (_m, n) => {
          const v = params[Number(n) - 1];
          return Array.isArray(v) ? `ARRAY[${v.map((x) => `'${x}'`).join(",")}]::uuid[]` : `'${v}'`;
        });
        const res = await tx.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${inline}`);
        const top = res.rows[0]["QUERY PLAN"][0];
        return { nodes: walk(top.Plan as PlanNode), ms: Number(top["Execution Time"]) };
      });
    }
    /** Rows a plan node touched: returned plus filtered out, over all its loops. */
    const visited = (n: PlanNode) =>
      ((n["Actual Rows"] ?? 0) + (n["Rows Removed by Filter"] ?? 0)) * (n["Actual Loops"] ?? 1);
    const LARGE = ["chunks", "chunk_entities"];
    const TABLES = ["chunks", "chunk_entities", "documents", "entities"];
    // This document has 8 passages and about 70 mention rows; the library has 500 documents, 4000 passages, 8000+ mention rows,
    // 5000 entities. Anything under 300 visited rows per table cannot have scanned the library, whatever plan the planner picks.
    const VISITED_BOUND = 300;

    async function expectBound(sql: string, params: unknown[]) {
      const { nodes, ms } = await explain(sql, params);
      // Robust to the plan shape: no table is read beyond this document's neighbourhood...
      for (const n of nodes) {
        const rel = n["Relation Name"];
        if (rel !== undefined && TABLES.includes(rel))
          expect(visited(n), `${n["Node Type"]} on ${rel}`).toBeLessThan(VISITED_BOUND);
      }
      // ...and the two large tables are never sequentially scanned (a tiny table may legitimately be: not asserted on).
      expect(
        nodes
          .filter((n) => n["Node Type"] === "Seq Scan" && LARGE.includes(n["Relation Name"] ?? ""))
          .map((n) => n["Relation Name"]),
      ).toEqual([]);
      expect(ms).toBeLessThan(2000);
    }

    const candidateIds = async () =>
      (
        await withTenant(fx.app, T1, async (tx) =>
          tx.query<{ entity_id: string }>(CANDIDATES_SQL, [U1, selfId, T1, 20, 200]),
        )
      ).rows.map((r) => r.entity_id);

    it("the candidates query walks out from this document and never scans the library", async () => {
      await expectBound(CANDIDATES_SQL, [U1, selfId, T1, 20, 200]);
    });
    it("the mentions query walks out from this document and never scans the library, hub entity included", async () => {
      const ids = await candidateIds();
      expect(ids.length).toBeGreaterThan(20); // the hub and the 50 named entities are in the ranked set
      await expectBound(MENTIONS_SQL, [U1, selfId, T1, ids]);
    });
    it("returns only this document's rows", async () => {
      const rows = await withTenant(fx.app, T1, async (tx) =>
        tx.query<{ n: number }>(CANDIDATES_SQL, [U1, selfId, T1, 20, 200]),
      );
      // This document has 8 passages: the hub is in all 8, never in the library's 4000.
      expect(Math.max(...rows.rows.map((r) => r.n))).toBe(8);
      const own = new Set(
        (await fx.db.owner.query("SELECT id FROM chunks WHERE document_id = $1", [selfId])).rows.map(
          (r) => r.id as string,
        ),
      );
      const mentions = await withTenant(fx.app, T1, async (tx) =>
        tx.query<{ chunk_id: string }>(MENTIONS_SQL, [U1, selfId, T1, await candidateIds()]),
      );
      expect(mentions.rows.length).toBeGreaterThan(0);
      expect(mentions.rows.every((r) => own.has(r.chunk_id))).toBe(true);
    });
    it("another owner or tenant reads nothing, even with this document's id", async () => {
      const none = await withTenant(fx.app, T1, async (tx) =>
        tx.query(CANDIDATES_SQL, [U1B, selfId, T1, 20, 200]),
      );
      expect(none.rowCount).toBe(0);
      const other = await withTenant(fx.app, T1, async (tx) =>
        tx.query(MENTIONS_SQL, [U1, selfId, T2, await candidateIds()]),
      );
      expect(other.rowCount).toBe(0);
    });
  },
);
```

- [ ] **Step 10: Run to verify failure**

Run: `set -a; . ./.env; set +a; pnpm --filter @docmind/server exec vitest run app/flows/visualize-document/pgStructure.pg.test.ts`
Expected: FAIL (cannot find module `./pgStructure`).

- [ ] **Step 11: Implement the interface, the reader and the step**, create `apps/server/app/flows/visualize-document/pgStructure.ts`:

```ts
import type { Pool } from "pg";
import { z } from "zod";
import { ENTITY_KINDS, type EntityKind } from "../../crypto/entityKeys";
import { type FieldCrypto, FieldKeyStoreError } from "../../crypto/fields";
import { withTenant } from "../../db/tenant";
import { titleBind } from "../../documents/repo";
import { DocumentGoneError } from "../ingest-document/errors";
import { chunkBind } from "../ingest-document/pgChunks";
import { entityNameBind } from "../ingest-document/pgEntities";
import { type EntityCandidate, MAX_MAP_ENTITIES, type Mention } from "./cooccurrence";
import type { HeadingRow } from "./outline";
import type { VisualizeRef } from "./pgFacts";
import type { StructureReader } from "./structure";

/** The most candidate entities one read returns: the top 20 plus any tied with the 20th, bounded. */
export const ENTITY_CANDIDATE_CAP = 200;

/**
 * $1 document, $2 owner, $3 tenant. Each passage's section (plaintext) and sealed text; `owned` is false when the document is
 * not the owner's (an owner and tenant predicate of its own, not only row-level security). A document with no passages yields
 * one row with a null `id`.
 */
export const HEADINGS_SQL = `SELECT o.owned, c.id, c.section_ordinal, c.text_enc
   FROM (SELECT EXISTS (
           SELECT 1 FROM documents d WHERE d.id = $1 AND d.owner_id = $2 AND d.tenant_id = $3) AS owned) o
   LEFT JOIN chunks c ON o.owned AND c.tenant_id = $3 AND c.document_id = $1
  ORDER BY c.ordinal`;

/**
 * $1 owner, $2 document, $3 tenant, $4 rank limit, $5 row cap. The owner's entities of THIS document's passages: the document
 * (owner and tenant named), its chunks (`chunks_document_ordinal_key`), their `chunk_entities` rows (the primary key leads with
 * the tenant and the chunk), counted per entity, ranked by that count; the entity row is read by key only for the ranked few.
 * MATERIALIZED so the planner cannot reorder it into a scan of the owner's library. `rank()` keeps every entity tied with the
 * last wanted one, so a tie at the boundary is broken by name later (names are sealed, SQL cannot), and the cap bounds a
 * document full of equal entities.
 */
export const CANDIDATES_SQL = `WITH counted AS MATERIALIZED (
  SELECT ce.tenant_id, ce.entity_id, count(*)::int AS n
    FROM documents d
    JOIN chunks c ON c.tenant_id = d.tenant_id AND c.document_id = d.id
    JOIN chunk_entities ce ON ce.tenant_id = c.tenant_id AND ce.chunk_id = c.id
   WHERE d.id = $2 AND d.owner_id = $1 AND d.tenant_id = $3
   GROUP BY ce.tenant_id, ce.entity_id),
ranked AS MATERIALIZED (
  SELECT k.tenant_id, k.entity_id, k.n, rank() OVER (ORDER BY k.n DESC) AS r FROM counted k)
SELECT en.id AS entity_id, en.kind, en.name_enc, k.n
  FROM ranked k
  JOIN entities en ON en.tenant_id = k.tenant_id AND en.id = k.entity_id AND en.owner_id = $1
 WHERE k.r <= $4
 ORDER BY k.n DESC, en.id
 LIMIT $5`;

/**
 * $1 owner, $2 document, $3 tenant, $4 entity ids. The kept entities' passages in this document, in passage order. It starts
 * from this document's passages (MATERIALIZED) and probes `chunk_entities` once per passage through its primary key, in a
 * LATERAL with a LIMIT (never reached: a passage has at most as many rows as there are ids, at most 200) so the planner
 * cannot flatten it into a join. A plain `JOIN ... entity_id = ANY($4)` was planned as a sequential scan of all of
 * `chunk_entities` once a hub entity (on every passage of the library) was among the ids.
 */
export const MENTIONS_SQL = `WITH mine AS MATERIALIZED (
  SELECT c.tenant_id, c.id, c.ordinal
    FROM documents d
    JOIN chunks c ON c.tenant_id = d.tenant_id AND c.document_id = d.id
   WHERE d.id = $2 AND d.owner_id = $1 AND d.tenant_id = $3)
SELECT x.entity_id, x.chunk_id, m.ordinal
  FROM mine m
  CROSS JOIN LATERAL (
    SELECT ce.entity_id, ce.chunk_id FROM chunk_entities ce
     WHERE ce.tenant_id = m.tenant_id AND ce.chunk_id = m.id AND ce.entity_id = ANY($4::uuid[])
     LIMIT ${ENTITY_CANDIDATE_CAP}) x
 ORDER BY m.ordinal, x.entity_id`;

const SEALED = z.object({ headingPath: z.array(z.string()) }).passthrough();
const KINDS: readonly string[] = ENTITY_KINDS;

/**
 * Reads what the structure step needs, under the owner's key and for this document only. A value that does not open (or
 * has an unexpected shape) makes the whole kind unreadable (`null`), and nothing is logged (headings and names are
 * content). A key-store outage is not "does not open": it is rethrown so the step fails and retries.
 */
export class PgStructureReader implements StructureReader {
  constructor(
    private readonly pool: Pool,
    private readonly fields: FieldCrypto,
  ) {}

  private async open<T>(read: () => Promise<T>): Promise<T | null> {
    try {
      return await read();
    } catch (err) {
      if (err instanceof FieldKeyStoreError) throw err;
      return null;
    }
  }

  async title(ref: VisualizeRef): Promise<string | null> {
    const rows = await withTenant(this.pool, ref.tenantId, async (tx) => {
      const res = await tx.query<{ title_enc: unknown }>(
        "SELECT title_enc FROM documents WHERE id = $1 AND owner_id = $2 AND tenant_id = $3",
        [ref.documentId, ref.userId, ref.tenantId],
      );
      return res.rows;
    });
    const row = rows[0];
    if (!row) throw new DocumentGoneError();
    const cipher = this.fields.forUser(ref.userId);
    return this.open(() => cipher.openText(titleBind(ref.documentId), row.title_enc));
  }

  async headings(ref: VisualizeRef): Promise<HeadingRow[] | null> {
    const rows = await withTenant(this.pool, ref.tenantId, async (tx) => {
      const res = await tx.query<{
        owned: boolean;
        id: string | null;
        section_ordinal: number;
        text_enc: unknown;
      }>(HEADINGS_SQL, [ref.documentId, ref.userId, ref.tenantId]);
      return res.rows;
    });
    if (!rows[0]?.owned) throw new DocumentGoneError();
    const cipher = this.fields.forUser(ref.userId);
    const opened = await Promise.all(
      rows.map(async (r): Promise<HeadingRow | null | "none"> => {
        if (r.id === null) return "none"; // the LEFT JOIN of a document with no passages
        const id = r.id;
        const sealed = SEALED.safeParse(await this.open(() => cipher.open(chunkBind(id), r.text_enc)));
        return sealed.success
          ? { chunkId: id, sectionOrdinal: r.section_ordinal, headingPath: sealed.data.headingPath }
          : null;
      }),
    );
    if (opened.includes(null)) return null;
    return opened.filter((r): r is HeadingRow => r !== "none" && r !== null);
  }

  async entities(ref: VisualizeRef): Promise<EntityCandidate[] | null> {
    const rows = await withTenant(this.pool, ref.tenantId, async (tx) => {
      const res = await tx.query<{ entity_id: string; kind: string; name_enc: unknown; n: number }>(
        CANDIDATES_SQL,
        [ref.userId, ref.documentId, ref.tenantId, MAX_MAP_ENTITIES, ENTITY_CANDIDATE_CAP],
      );
      return res.rows;
    });
    const cipher = this.fields.forUser(ref.userId);
    const out = await Promise.all(
      rows.map(async (r): Promise<EntityCandidate | null> => {
        const name = await this.open(() => cipher.openText(entityNameBind(r.entity_id), r.name_enc));
        if (name === null || !KINDS.includes(r.kind)) return null;
        return { id: r.entity_id, kind: r.kind as EntityKind, name, passages: r.n };
      }),
    );
    return out.includes(null) ? null : (out as EntityCandidate[]);
  }

  async mentions(ref: VisualizeRef, entityIds: readonly string[]): Promise<Mention[]> {
    if (entityIds.length === 0) return [];
    const rows = await withTenant(this.pool, ref.tenantId, async (tx) => {
      const res = await tx.query<{ entity_id: string; chunk_id: string; ordinal: number }>(
        MENTIONS_SQL,
        [ref.userId, ref.documentId, ref.tenantId, [...entityIds]],
      );
      return res.rows;
    });
    return rows.map((r) => ({ entityId: r.entity_id, chunkId: r.chunk_id, ordinal: r.ordinal }));
  }
}
```

Create `apps/server/app/flows/visualize-document/structure.ts`:

```ts
import type { Effect } from "@loom/effect-runtime";
import {
  type StepGuard,
  StepResult,
  type StepSeams,
  ingestStepOptions,
  stepEffectOf,
} from "../ingest-document/stepEffect";
import {
  type EntityCandidate,
  type Mention,
  MIN_LINKED,
  buildCooccurrence,
  topEntities,
} from "./cooccurrence";
import { ENTITY_MAP_ORDINAL, OUTLINE_ORDINAL, type StructureFact } from "./facts";
import { type HeadingRow, buildOutline } from "./outline";
import type { VisualFactStore, VisualizeRef } from "./pgFacts";

/** What the structure step reads, owner-scoped and for one document. `null` means a value did not open (that fact is skipped). */
export interface StructureReader {
  /** The document's title. Throws DocumentGoneError when it is not the owner's. */
  title(ref: VisualizeRef): Promise<string | null>;
  /** Each passage's section and opened heading path, in passage order. */
  headings(ref: VisualizeRef): Promise<HeadingRow[] | null>;
  /** The document's most-mentioned entities (at least the top 20, ties included), names opened. */
  entities(ref: VisualizeRef): Promise<EntityCandidate[] | null>;
  /** The passages of the given entities in this document, in passage order. */
  mentions(ref: VisualizeRef, entityIds: readonly string[]): Promise<Mention[]>;
}

export interface StructureDeps extends StepSeams {
  guard: StepGuard<VisualizeRef>;
  reader: StructureReader;
  facts: Pick<VisualFactStore, "replaceStructure">;
}

/**
 * Visualize-structure step: derives the document's outline and entity map (no model call) and replaces the document's
 * structure facts, leaving its extracted facts alone. It runs on every run, including a re-plan that skips extraction.
 * A kind whose inputs do not open, or that does not reach its thresholds, is simply not produced. The output is a count.
 */
export function structureEffect(deps: StructureDeps): Effect<VisualizeRef, StepResult> {
  return stepEffectOf<StepResult, VisualizeRef>(
    "visualize-structure",
    deps.guard,
    async (ref, signal) => {
      const facts: StructureFact[] = [];
      const title = await deps.reader.title(ref);
      const rows = title === null ? null : await deps.reader.headings(ref);
      const outline = title === null || rows === null ? null : buildOutline(title, rows);
      if (outline) facts.push({ ...outline, ordinal: OUTLINE_ORDINAL });

      const candidates = await deps.reader.entities(ref);
      const top = candidates === null ? [] : topEntities(candidates);
      const mentions =
        top.length >= MIN_LINKED ? await deps.reader.mentions(ref, top.map((e) => e.id)) : [];
      const map = buildCooccurrence(top, mentions);
      if (map) facts.push({ ...map, ordinal: ENTITY_MAP_ORDINAL });

      // The count only, never a heading or a name.
      console.info("visualize-structure facts", facts.length);
      return { count: await deps.facts.replaceStructure(ref, facts, signal) };
    },
    { schema: StepResult, ended: (end) => end },
    ingestStepOptions(deps),
  );
}
```

- [ ] **Step 12: Run to verify pass**

Run: `set -a; . ./.env; set +a; pnpm --filter @docmind/server exec vitest run app/flows/visualize-document/pgStructure.pg.test.ts`
Expected: PASS, none skipped. If the explain test reports a table read beyond this document's neighbourhood or a Seq Scan on `chunks` or `chunk_entities`, fix the query shape (keep each CTE MATERIALIZED and keyed on the document, and the `LATERAL ... LIMIT` in `MENTIONS_SQL`), do not loosen the assertion or the seed.

#### 3c-bis. Let experiences accept the structure kinds (types, description, content-free sample)

The flow now loads facts of five kinds, and `visualCapabilities` takes `VisualFactRaw[]`, so the experiences types must know the new kinds before the server typechecks. `OutlineFact` and `EntityMapFact` are defined here (P14) and Task 4 only consumes them; the catalogue entries, reshapers, ordinals and fingerprint follow in Task 4.

- [ ] **Step 12b: Write the failing capability tests, then extend `VisualFactRaw`, `describeFact` and the planner sample.**

First the tests. In `packages/experiences/src/visuals.test.ts` add `import { jsonPathSelect } from "@loom-ui/hydration";`, extend the existing import from `./visuals` with `type EntityMapFact, type OutlineFact`, and add after the `TABLE` fixture (Task 4 reuses `cid`, `OUTLINE` and `MAP`):

```ts
const cid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const OUTLINE: OutlineFact = {
  kind: "outline",
  title: "Zebra Report",
  nodes: ["Zebra-A", "Zebra-B", "Zebra-C"].map((label, i) => ({
    id: `s${i}`,
    label,
    level: 1,
    passageCount: 1,
    firstChunkId: cid(i + 1),
  })),
  chunkIds: [cid(1), cid(2), cid(3)],
  ordinal: 16,
};
const MAP: EntityMapFact = {
  kind: "cooccurrence",
  entities: ["Zebra-Ent-A", "Zebra-Ent-B", "Zebra-Ent-C"].map((name) => ({
    name,
    entityKind: "person",
    passages: 2,
  })),
  edges: [
    { a: 0, b: 1, weight: 2, firstChunkId: cid(1) },
    { a: 1, b: 2, weight: 2, firstChunkId: cid(2) },
  ],
  chunkIds: [cid(1), cid(2)],
  ordinal: 17,
};

describe("structure capabilities", () => {
  it("offers each structure fact as one capability with a count-only description", () => {
    const caps = capabilitiesOf([OUTLINE, MAP]);
    expect(caps.map((c) => c.handle)).toEqual(["fact-16", "fact-17"]);
    expect(caps.map((c) => c.toolSchemaHash)).toEqual([
      `${PINS["visual.facts"]}#fact-16`,
      `${PINS["visual.facts"]}#fact-17`,
    ]);
    expect(caps[0]?.description).toBe("a tree of 3 sections, 1 level deep");
    expect(caps[1]?.description).toBe("3 named parties and 2 links between those that appear together");
    expect(caps.every((c) => c.sensitivity === "sensitive")).toBe(true);
    // Nothing the planner is shown carries the fact's text (the fixtures are all "Zebra...").
    const shown = JSON.stringify(caps);
    for (const secret of ["Zebra-A", "Zebra-B", "Zebra-C", "Zebra Report", "Zebra-Ent"])
      expect(shown, secret).not.toContain(secret);
  });

  it("the planner sample carries placeholder nodes and edges, so a nodes or edges binding validates (P3)", () => {
    const [outline, map] = capabilitiesOf([OUTLINE, MAP]);
    expect(outline?.sampleOutput).toMatchObject({ kind: "outline", sections: 3, levels: 1 });
    expect(map?.sampleOutput).toMatchObject({ kind: "cooccurrence", entities: 3, links: 2 });
    expect(jsonPathSelect(outline?.sampleOutput, "nodes").ok).toBe(true);
    expect(jsonPathSelect(map?.sampleOutput, "nodes").ok).toBe(true);
    expect(jsonPathSelect(map?.sampleOutput, "edges").ok).toBe(true);
    // The control: a count-only sample selects nothing, which loom-ui's planner reports as `reshape-invalid`.
    expect(jsonPathSelect({ kind: "outline", sections: 3, levels: 1 }, "nodes").ok).toBe(false);
  });
});
```

Then the code. In `packages/experiences/src/visuals.ts` replace the `VisualFactRaw` type with the exported members plus the two new ones (keep the three existing members' fields exactly as they are today):

```ts
export interface OutlineFact {
  kind: "outline";
  title: string;
  nodes: { id: string; label: string; level: number; passageCount: number; firstChunkId: string }[];
  chunkIds: string[];
  ordinal: number;
}
export interface EntityMapFact {
  kind: "cooccurrence";
  entities: { name: string; entityKind: string; passages: number }[];
  edges: { a: number; b: number; weight: number; firstChunkId: string }[];
  chunkIds: string[];
  ordinal: number;
}

/** A fact the visualize step stored for a document; structurally the server's `AnyFact` (which experiences does not depend on) plus the reader's `cites`. */
export type VisualFactRaw = (
  | { kind: "series"; label: string; unit?: string; points: { x: string; y: number }[]; chunkIds: string[]; ordinal: number }
  | { kind: "figure"; label: string; value: number; unit?: string; compare?: { label: string; value: number }; chunkIds: string[]; ordinal: number }
  | { kind: "factTable"; title: string; columns: string[]; rows: string[][]; chunkIds: string[]; ordinal: number }
  | OutlineFact
  | EntityMapFact
) & { cites?: readonly FactCite[] };
```

Replace `describeFact` and the `sampleOutput` line of `capability` (Plan decision: a structure capability's sample is counts plus neutral placeholders: the existing `sampleOutput: f` would put heading and entity text in the planner prompt, which spec 5 forbids, while a count-only sample would make a `nodes` or `edges` binding select nothing):

```ts
const depthOf = (f: OutlineFact) => Math.max(1, ...f.nodes.map((n) => n.level));
const describeFact = (f: VisualFactRaw) =>
  f.kind === "series"
    ? "a series of numbers from the document"
    : f.kind === "figure"
      ? "one headline figure"
      : f.kind === "outline"
        ? `a tree of ${f.nodes.length} ${f.nodes.length === 1 ? "section" : "sections"}, ${depthOf(f)} ${depthOf(f) === 1 ? "level" : "levels"} deep`
        : f.kind === "cooccurrence"
          ? `${f.entities.length} named parties and ${f.edges.length} links between those that appear together`
          : "a table of facts";

/** Neutral stand-ins for a structure fact's nodes and edges: shape only, no document text. They let the planner's JSONPath over the sample (`nodes`, `edges`) select something. */
const OUTLINE_PLACEHOLDER = [
  { label: "Section", level: 1 },
  { label: "Subsection", level: 2 },
];
const MAP_PLACEHOLDER = {
  nodes: [
    { label: "Entity", group: "person" },
    { label: "Entity", group: "organization" },
  ],
  edges: [{ from: "e0", to: "e1", label: "2" }],
};
/** What the planner is shown of a fact: extracted facts show themselves; a structure fact shows counts and placeholders only. */
const sampleOf = (f: VisualFactRaw): unknown =>
  f.kind === "outline"
    ? { kind: "outline", sections: f.nodes.length, levels: depthOf(f), nodes: OUTLINE_PLACEHOLDER }
    : f.kind === "cooccurrence"
      ? { kind: "cooccurrence", entities: f.entities.length, links: f.edges.length, ...MAP_PLACEHOLDER }
      : f;
```
and in `capability(...)` use `sampleOutput: sampleOf(f),`. Export `OutlineFact` and `EntityMapFact` from `packages/experiences/src/index.ts` next to `VisualFactRaw` (`export type { FactCite, FactOrigin, FactRef, OfferedFact, VisualFactRaw, OutlineFact, EntityMapFact } from "./visuals";`).

Run: `pnpm --filter @docmind/experiences typecheck && pnpm --filter @docmind/experiences exec vitest run src/visuals.test.ts`
Expected: PASS (nothing existing changes for the extracted kinds; the two new tests were red before the code).

#### 3d. The step in the flow, both paths

- [ ] **Step 13: Write the failing unit tests**, create `apps/server/app/flows/visualize-document/structure.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FieldKeyStoreError } from "../../crypto/fields";
import { DocumentGoneError } from "../ingest-document/errors";
import type { EntityCandidate, Mention } from "./cooccurrence";
import type { StructureFact } from "./facts";
import type { HeadingRow } from "./outline";
import type { VisualizeRef } from "./pgFacts";
import { type StructureReader, structureEffect } from "./structure";

const cid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const eid = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
const ref: VisualizeRef = { tenantId: randomUUID(), userId: randomUUID(), documentId: randomUUID() };
const HEADINGS: HeadingRow[] = [
  { chunkId: cid(1), sectionOrdinal: 1, headingPath: ["Zebra-A"] },
  { chunkId: cid(2), sectionOrdinal: 2, headingPath: ["Zebra-B"] },
  { chunkId: cid(3), sectionOrdinal: 3, headingPath: ["Zebra-B", "Zebra-C"] },
];
const CANDS: EntityCandidate[] = [1, 2, 3].map((n) => ({
  id: eid(n),
  kind: "person",
  name: `Person${n}`,
  passages: 2,
}));
const MENTIONS: Mention[] = CANDS.flatMap((c) =>
  [1, 2].map((o) => ({ entityId: c.id, chunkId: cid(o), ordinal: o })),
);

function setup(over: Partial<StructureReader> = {}) {
  const written: StructureFact[][] = [];
  const reader: StructureReader = {
    title: async () => "Zebra Report",
    headings: async () => HEADINGS,
    entities: async () => CANDS,
    mentions: async () => MENTIONS,
    ...over,
  };
  const deps = {
    guard: { begin: async () => {} },
    reader,
    facts: {
      replaceStructure: async (_r: VisualizeRef, facts: readonly StructureFact[]) => {
        written.push([...facts]);
        return facts.length;
      },
    },
    sleep: async () => {},
  };
  return { written, run: () => structureEffect(deps).execute(ref, {} as never) };
}

describe("visualize-structure step", () => {
  afterEach(() => vi.restoreAllMocks());

  it("derives the outline (ordinal 16) and the entity map (ordinal 17) and replaces the structure facts", async () => {
    const s = setup();
    expect(await s.run()).toEqual({ outcome: "done", count: 2 });
    expect(s.written).toHaveLength(1);
    expect(s.written[0]?.map((f) => [f.ordinal, f.kind])).toEqual([
      [16, "outline"],
      [17, "cooccurrence"],
    ]);
  });

  it("clears stale structure facts when nothing reaches its threshold", async () => {
    const s = setup({ headings: async () => [], entities: async () => [] });
    expect(await s.run()).toEqual({ outcome: "done", count: 0 });
    expect(s.written).toEqual([[]]);
  });

  it("skips only the outline when a passage or the title does not open", async () => {
    const s = setup({ headings: async () => null });
    expect(await s.run()).toEqual({ outcome: "done", count: 1 });
    expect(s.written[0]?.map((f) => f.kind)).toEqual(["cooccurrence"]);
    const t = setup({ title: async () => null });
    expect(await t.run()).toEqual({ outcome: "done", count: 1 });
  });

  it("skips only the map when an entity name does not open, and reads no mentions then", async () => {
    const mentions = vi.fn(async () => MENTIONS);
    const s = setup({ entities: async () => null, mentions });
    expect(await s.run()).toEqual({ outcome: "done", count: 1 });
    expect(s.written[0]?.map((f) => f.kind)).toEqual(["outline"]);
    expect(mentions).not.toHaveBeenCalled();
  });

  it("reports a vanished document as document_gone and writes nothing", async () => {
    const s = setup({
      title: async () => {
        throw new DocumentGoneError();
      },
    });
    expect(await s.run()).toEqual({ outcome: "document_gone" });
    expect(s.written).toEqual([]);
  });

  it("fails the step on a key-store outage, writing nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const s = setup({
      headings: async () => {
        throw new FieldKeyStoreError();
      },
    });
    await expect(s.run()).rejects.toThrow(/^ingest step failed: visualize-structure$/);
    expect(s.written).toEqual([]);
  });

  it("logs the count only, never a heading or a name", async () => {
    const spies = (["info", "log", "warn", "error"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const [info] = spies;
    await setup().run();
    // The step logs exactly this one line (so the assertion below is not vacuous)...
    expect(info?.mock.calls).toEqual([["visualize-structure facts", 2]]);
    // ...and nothing it logs, anywhere, carries a heading, the title or an entity name.
    const logged = JSON.stringify(spies.map((spy) => spy.mock.calls));
    for (const secret of ["Zebra", "Person1", "Person2", "Person3"])
      expect(logged, secret).not.toContain(secret);
  });
});
```

Add to `apps/server/app/flows/visualize-document/flow.test.ts`:

1. In `stack`, add the structure reader, the structure-aware store stub and the 1.0.0 flow. Change the signature and the state:

```ts
function stack(
  replies: string[] | null,
  o: {
    provider?: ReturnType<typeof scripted>;
    executionId?: string;
    structure?: StructureReader;
    /** Start the execution on the 1.0.0 flow, as one that was in flight at deploy was. */
    legacy?: boolean;
  } = {},
) {
  // ...unchanged down to `let held: Fact[] = [];`, then:
  let structured: StructureFact[] = [];
```

Replace the `facts:` stub of `deps` and add the reader beside it:

```ts
    facts: {
      replace: async (_r, facts) => {
        held = [...facts];
        return facts.length;
      },
      replaceStructure: async (_r, facts) => {
        structured = [...facts];
        return facts.length;
      },
      list: async () => held,
      listAll: async () => [...held, ...structured],
    },
    structure: o.structure ?? noStructure(),
```

Replace the `buildApp(...)` call and the `run` function so both flow versions are registered (as `compose.ts` will) and the execution starts on the one asked for:

```ts
  const current = () => visualizeDocumentFlow(() => planner);
  const legacy = () => visualizeDocumentFlow(() => planner, { legacy: true });
  const app = buildApp(
    { kind: "custom", eventStore: sealed },
    { events: sealed },
    { visualize: { flow: current(), legacyFlow: legacy(), deps } },
  );
  apps.push(app);
  // ...ref and executionId unchanged, then:
  const run = async (id: string = executionId) => {
    const handle = await app.runtime.start(o.legacy ? legacy() : current(), ref, {
      executionId: id as typeof executionId,
      principal: { tenant: ref.tenantId, actor: ref.userId },
    });
    const state = await handle.waitForCompletion();
    return VisualizeOutput.parse(state.variables._output);
  };
```

and add `structured: () => structured,` to the returned object of `stack`. Imports for the file: `type StructureFact` (from `./facts`, beside `type Fact`), `type StructureReader` (from `./structure`), `noStructure` (from `./testing`, beside `childrenOf`), `flowContentHash, flowHashMatches` (from `@loom/core`, beside the `EventEnvelope` type import), and `visualizeStructureStep`, `LEGACY_VISUALIZE_STEPS` (from `./flow`).

2. Add `noStructure` to `apps/server/app/flows/visualize-document/testing.ts`:

```ts
import type { StructureReader } from "./structure";

/** A structure reader for a document with no headings and no entities: the structure step writes nothing. */
export const noStructure = (): StructureReader => ({
  title: async () => "",
  headings: async () => [],
  entities: async () => [],
  mentions: async () => [],
});
```

3. Update the identity test (`pins its identity`): `expect(flow.definition.version).toBe("1.1.0");` and the step ids to `["visualize-extract", "visualize-structure", "visualize-load", "visualize-commit"]`, and add `expect(visualizeStructureStep.retry).toEqual(STEP_RETRY);` (the two imports are listed in item 1).

4. Append these tests inside `describe("visualize-document flow", ...)`:

```ts
  const STRUCTURE_READER: StructureReader = {
    title: async () => "Zebra-Secret-Report",
    headings: async () => [
      { chunkId: CHUNK, sectionOrdinal: 1, headingPath: ["Zebra-Heading-One"] },
      { chunkId: CHUNK, sectionOrdinal: 2, headingPath: ["Zebra-Heading-Two"] },
      { chunkId: CHUNK, sectionOrdinal: 3, headingPath: ["Zebra-Heading-Two", "Zebra-Heading-Sub"] },
    ],
    entities: async () => [],
    mentions: async () => [],
  };

  it("derives the structure facts after extraction and stores them beside the extracted ones, with no extra model call", async () => {
    const s = stack([FACTS, PLAN], { structure: STRUCTURE_READER });
    expect(await s.run()).toEqual({ outcome: "done" });
    expect(s.held().map((f) => f.ordinal)).toEqual([0]);
    expect(s.structured().map((f) => [f.ordinal, f.kind])).toEqual([[16, "outline"]]);
    expect(s.model?.requests).toHaveLength(2); // one extract window, one planner call: structure made no model call
    // The planner is offered the outline as a capability but is never shown a heading.
    expect(JSON.stringify(s.model?.requests[1])).not.toContain("Zebra-Heading");
    expect(JSON.stringify(s.model?.requests[1])).not.toContain("Zebra-Secret-Report");
  });

  it("re-derives and replaces the structure facts on a re-run that skips extraction", async () => {
    const s = stack([PLAN], { structure: STRUCTURE_READER });
    s.hold(JSON.parse(FACTS).facts.map((f: object, i: number) => ({ ...f, ordinal: i })) as Fact[]);
    const rerun = visualizeExecutionId(s.ref.userId, s.ref.documentId, 2, 1);
    expect(await s.run(rerun)).toEqual({ outcome: "done" });
    expect(s.model?.requests).toHaveLength(1); // the planner only: no extraction
    expect(s.structured().map((f) => f.ordinal)).toEqual([16]); // re-derived on the re-plan path
  });

  it("still ends empty, not failed, for a document with neither facts nor structure when the planner emits nothing", async () => {
    const s = stack([JSON.stringify({ facts: [] }), EMPTY_PLAN]);
    expect(await s.run()).toEqual({ outcome: "empty" });
  });

  it("makes no structure and no write when the visuals role is off", async () => {
    const s = stack(null, { structure: STRUCTURE_READER });
    expect(await s.run()).toEqual({ outcome: "skipped" });
    expect(s.structured()).toEqual([]);
  });
```

Also in `apps/server/app/security.ts` line 24 change to `"visualize-document": ["visualize-extract", "visualize-structure", "visualize-load", "visualize-commit"],`. In `security.test.ts` add inside the existing grants test (follow its `request(flow, tool)` helper): 

```ts
    expect(authorizer.authorize(request("visualize-document", "visualize-structure")).allowed).toBe(true);
    expect(authorizer.authorize(request("visualize-turn", "visualize-structure")).allowed).toBe(false);
```

In `plan.test.ts` the load-step stubs now read `listAll`: change both stubs from `facts: { list: async () => [FIGURE], replace: async () => 0 }` to `facts: { listAll: async () => [FIGURE] }` and the document-gone stub to `facts: { listAll: async () => { throw new DocumentGoneError(); } }`.

- [ ] **Step 14: Run to verify failure**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/visualize-document/structure.test.ts app/flows/visualize-document/flow.test.ts app/flows/visualize-document/plan.test.ts app/security.test.ts`
Expected: FAIL (`./structure` effect not registered in the flow, version/steps mismatch, `listAll` missing).

- [ ] **Step 15: Implement the wiring**

`plan.ts`, change the facts imports and the load output and effect:

```ts
import { type AnyFact, MAX_STORED_FACTS, StoredEntry } from "./facts";
```
(this replaces `import { type Fact, MAX_FACTS, StoredFact } from "./facts";`: `Fact`, `MAX_FACTS` and `StoredFact` have no other use in `plan.ts`), then:

```ts
export const LoadOutput = z
  .object({
    outcome: z.enum(["done", "document_gone", "failed"]),
    code: z.enum(FAILURE_CODES).optional(),
    // The extracted facts (up to 16) and the structure facts (up to 2): at most MAX_STORED_FACTS (18) rows, ordinals 0..17.
    facts: z.array(StoredEntry).max(MAX_STORED_FACTS),
  })
  .strict();
```
```ts
export function loadEffect(
  deps: { guard: StepGuard; facts: Pick<VisualFactStore, "listAll"> } & StepSeams,
): Effect<VisualizeRef, LoadOutput> {
  return stepEffectOf(
    "visualize-load",
    deps.guard,
    async (ref) => ({ facts: await deps.facts.listAll(ref) }),
    { schema: LoadOutput, ended: (end) => ({ ...end, facts: [] }) },
    ingestStepOptions(deps),
  );
}
```
and `planVisuals = (planner, facts: readonly AnyFact[], ctx)`.

`deps.ts`, add imports and field, and register the effect:

```ts
import type { StructureReader } from "./structure";
import { structureEffect } from "./structure";
```
in `VisualizeDeps`: `facts: VisualFactStore;` stays, add
```ts
  /** The structure step's reads (headings, entity mentions), owner-scoped. */
  structure: StructureReader;
```
in `visualizeEffects` return:
```ts
    "visualize-extract": extractEffect(deps) as unknown as Effect,
    "visualize-structure": structureEffect({ ...deps, reader: deps.structure }) as unknown as Effect,
    "visualize-load": loadEffect(deps) as unknown as Effect,
```

`flow.ts`: add the step, then replace `VISUALIZE_STEPS`, `runVisualize` and `visualizeDocumentFlow` (everything from `export const VISUALIZE_STEPS` to the end of the file) with the code below. The load step, the commit step, the inputs and the outputs above them are unchanged.

```ts
export const visualizeStructureStep = step$({
  id: "visualize-structure",
  name: "VisualizeStructure",
  inputSchema: VisualizeInput,
  outputSchema: StepResult,
  retry: STEP_RETRY, // no model: it reads this document and derives
});

export const VISUALIZE_STEPS = [
  visualizeExtractStep,
  visualizeStructureStep,
  visualizeLoadStep,
  visualizeCommitStep,
];
/** The 1.0.0 steps: what a run that was in flight at deploy was started with (it has no structure step). */
export const LEGACY_VISUALIZE_STEPS = [visualizeExtractStep, visualizeLoadStep, visualizeCommitStep];

/**
 * extract (model, facts stored sealed) -> structure (the derived outline and entity map, no model; also on a re-plan that
 * skips extraction) -> load (the stored facts, for the decision; skipped when there are none) -> one planner decision (over
 * the facts and the live connections) -> commit (the plan to the document's lineage). `planner` is read after the load
 * step, so a role that went off in between ends the run as `skipped`. A failure here never reaches the document's ingest
 * status. `withStructure` is false only for the 1.0.0 flow (see `visualizeDocumentFlow`).
 */
export const runVisualize =
  (
    planner: () => Planner | undefined,
    withStructure = true,
  ): FlowRunner<VisualizeRef, VisualizeOutput> =>
  async (ctx, input) => {
    const extracted = await ctx.run(visualizeExtractStep, input);
    if (extracted.outcome !== "done")
      return { outcome: extracted.outcome, ...(extracted.code && { code: extracted.code }) };
    if (extracted.model === "none") return { outcome: "skipped" };
    // The structure facts are derived on every run (a re-plan that skips extraction included): no model, this document only.
    let derived = 0;
    if (withStructure) {
      const structured = await ctx.run(visualizeStructureStep, input);
      if (structured.outcome !== "done") return { outcome: structured.outcome };
      derived = structured.count ?? 0;
    }
    // No facts at all (none extracted and none derived): there is nothing to load, but the connections are live data, so
    // the planner still runs, offered only the connections capability.
    const stored = (extracted.count ?? 0) + derived;
    let facts: LoadOutput["facts"] = [];
    if (stored !== 0) {
      const loaded = await ctx.run(visualizeLoadStep, input);
      if (loaded.outcome !== "done") return { outcome: loaded.outcome };
      facts = loaded.facts;
    }
    const p = planner();
    if (!p) return { outcome: "skipped" };
    const plan = await planVisuals(p, facts, ctx);
    if (plannerUnavailable(plan)) return { outcome: "failed", code: "visuals-model-unavailable" };
    // With no facts, a plan the planner could not make (it refuses an empty plan) is just nothing to show.
    if (
      stored === 0 &&
      (plan.ops.length === 0 || plan.findings.some((f) => f.severity === "error"))
    ) {
      // Codes only, never text: a broken connections binding must not hide behind a quiet `empty`.
      const codes = plan.findings.filter((f) => f.severity === "error").map((f) => f.code);
      if (codes.length > 0) console.warn("visualize connections-only plan failed", codes);
      return { outcome: "empty" };
    }
    if (plan.findings.some((f) => f.severity === "error"))
      return { outcome: "failed", code: "visuals-plan-invalid" };
    // Facts that do not fit their widget would only hydrate as error placeholders: commit the ones that fit.
    const byOrdinal = new Map(facts.map((f) => [f.ordinal, f]));
    const fitted = dropUnfittingOps(plan.ops, (ref) =>
      ref.kind === "detail" ? byOrdinal.get(ref.ordinal) : undefined,
    );
    logDropped("visualize", fitted.dropped);
    if (fitted.ops.length === 0) return { outcome: "empty" };
    const shown = fittedSummary(plan, fitted);
    const committed = await ctx.run(visualizeCommitStep, {
      ...input,
      ops: fitted.ops,
      report: shown.report,
      ...(shown.summary && { summary: shown.summary, summaryClass: plan.summaryClass }),
    });
    return committed.outcome === "done" ? { outcome: "done" } : { outcome: committed.outcome };
  };

/**
 * The flow, with the planner of this app. Flows are static modules, but the planner holds a secret and a model: per app.
 * `legacy` builds the 1.0.0 definition (extract, load, commit; its runner never asks for the structure step) that a run in
 * flight at deploy needs (see the Plan decision on in-flight runs); the default is 1.1.0.
 */
export const visualizeDocumentFlow = (
  planner: () => Planner | undefined = () => undefined,
  o: { legacy?: boolean } = {},
): RegisteredFlow => ({
  definition: flow$({
    id: "visualize-document",
    name: "VisualizeDocument",
    version: o.legacy ? "1.0.0" : "1.1.0",
    inputSchema: VisualizeInput,
    outputSchema: VisualizeOutput,
    steps: o.legacy ? LEGACY_VISUALIZE_STEPS : VISUALIZE_STEPS,
  }),
  runner: runVisualize(planner, !o.legacy) as FlowRunner<unknown, unknown>,
});
```

`byOrdinal` holds the loaded `AnyFact`s, which are structurally the experiences `VisualFactRaw` union, so `dropUnfittingOps` takes them as they are.

`compose.ts`, add `import { PgStructureReader } from "./flows/visualize-document/pgStructure";` beside the other visualize imports and in the `visualize.deps` object after `facts: new PgVisualFacts(pool, fields),` add `structure: new PgStructureReader(pool, fields),`.

Every other constructor of `VisualizeDeps` in tests (`start.test.ts`, `recovery.test.ts`, `runs.pg.test.ts`, `flow.test.ts`) gets `structure: noStructure()` and, where the `facts` stub is hand-written, `replaceStructure: async () => 0, listAll: async () => []`. `pnpm typecheck:tests` lists each one.

- [ ] **Step 15b: Keep 1.0.0 registered (in-flight runs at deploy).** `flow.ts` already builds both definitions (step 15). Wire and test the registration.

`apps/server/app/config.ts`: add the optional legacy flow to the `visualize` dep, add a helper that orders the registrations, and use it where the flows list is built:

```ts
  visualize?: { flow: RegisteredFlow; legacyFlow?: RegisteredFlow; deps: VisualizeDeps };
```
```ts
/**
 * The visualize-document flows to register: the 1.0.0 flow first (when there is one), then the current one. Loom resumes an
 * execution on the registered version whose hash matches the one recorded at its start, and treats the LAST-registered
 * version of an id as current (as for chat 1.0.0 and 1.1.0 in `chats/wiring.ts`).
 */
export const visualizeFlows = (v: {
  flow: RegisteredFlow;
  legacyFlow?: RegisteredFlow;
}): RegisteredFlow[] => (v.legacyFlow ? [v.legacyFlow, v.flow] : [v.flow]);
```
```ts
    ...(deps.visualize ? visualizeFlows(deps.visualize) : []),
```
(that last line replaces `...(deps.visualize ? [deps.visualize.flow] : []),` in `flows`).

`apps/server/app/compose.ts`: in the `visualize` object add, after `flow: visualizeDocumentFlow(() => planner),`:

```ts
    legacyFlow: visualizeDocumentFlow(() => planner, { legacy: true }),
```
`loomVisualsStarter(app.runtime, visualize.flow, ...)` and `start.ts` keep starting by the 1.1.0 flow value, so every new run records the 1.1.0 hash; runs in flight at deploy resume on 1.0.0.

Tests. In `apps/server/app/config.test.ts` add (with `import { visualizeDocumentFlow } from "./flows/visualize-document/flow";` and `visualizeFlows` added to the existing `import { buildApp } from "./config";`):

```ts
describe("visualizeFlows", () => {
  it("registers the 1.0.0 visualize flow before the current one, and only the current one without it", () => {
    const current = visualizeDocumentFlow();
    const legacy = visualizeDocumentFlow(undefined, { legacy: true });
    expect(visualizeFlows({ flow: current, legacyFlow: legacy }).map((f) => f.definition.version)).toEqual([
      "1.0.0",
      "1.1.0",
    ]);
    expect(visualizeFlows({ flow: current }).map((f) => f.definition.version)).toEqual(["1.1.0"]);
  });
});
```

In `apps/server/app/flows/visualize-document/flow.test.ts`, inside `describe("visualize-document flow", ...)` (the `STRUCTURE_READER` fixture is the one of step 13):

```ts
  it("keeps 1.0.0 beside 1.1.0: the same flow id, its own steps and its own flow hash", () => {
    const legacy = visualizeDocumentFlow(undefined, { legacy: true });
    const current = visualizeDocumentFlow();
    expect(legacy.definition.id).toBe(current.definition.id);
    expect(legacy.definition.version).toBe("1.0.0");
    expect(legacy.definition.steps.map((s) => s.id)).toEqual(LEGACY_VISUALIZE_STEPS.map((s) => s.id));
    expect(legacy.definition.steps.map((s) => s.id)).toEqual([
      "visualize-extract",
      "visualize-load",
      "visualize-commit",
    ]);
    expect(flowHashMatches(flowContentHash(current.definition), legacy.definition)).toBe(false);
    expect(flowHashMatches(flowContentHash(legacy.definition), legacy.definition)).toBe(true);
  });

  it("finishes a run started on 1.0.0 on the legacy runner: no structure step, no structure fact", async () => {
    const s = stack([FACTS, PLAN], { legacy: true, structure: STRUCTURE_READER });
    expect(await s.run()).toEqual({ outcome: "done" });
    expect(s.held().map((f) => f.ordinal)).toEqual([0]);
    expect(s.structured()).toEqual([]);
    const log = await s.inner.read(s.executionId);
    const started = log.find((e) => e.eventType === "EXECUTION_STARTED");
    const recorded = (started?.payload as { flowHash: string }).flowHash;
    const legacy = visualizeDocumentFlow(undefined, { legacy: true });
    expect(flowHashMatches(recorded, legacy.definition)).toBe(true);
    const steps = log
      .filter((e) => e.eventType === "STEP_STARTED")
      .map((e) => (e.payload as { stepId: string }).stepId);
    expect(steps).toContain("visualize-extract");
    expect(steps).not.toContain("visualize-structure");
  });

  it("a run started on 1.1.0 records the 1.1.0 hash and the structure step", async () => {
    const s = stack([FACTS, PLAN], { structure: STRUCTURE_READER });
    expect(await s.run()).toEqual({ outcome: "done" });
    const log = await s.inner.read(s.executionId);
    const started = log.find((e) => e.eventType === "EXECUTION_STARTED");
    const recorded = (started?.payload as { flowHash: string }).flowHash;
    expect(flowHashMatches(recorded, visualizeDocumentFlow().definition)).toBe(true);
    expect(flowHashMatches(recorded, visualizeDocumentFlow(undefined, { legacy: true }).definition)).toBe(false);
    const steps = log
      .filter((e) => e.eventType === "STEP_STARTED")
      .map((e) => (e.payload as { stepId: string }).stepId);
    expect(steps).toContain("visualize-structure");
  });
```

Expected: PASS. (Loom's own resume-by-hash rule is its test suite's; these tests pin DocMind's side: two registered definitions with different hashes, the legacy one without the structure step, the legacy runner never asking for it, and the registration order that makes 1.1.0 current.)

- [ ] **Step 16: Run to verify pass**

Run:
```
pnpm --filter @docmind/server exec vitest run app/flows/visualize-document app/flows/visualize-turn app/ui app/security.test.ts app/config.test.ts
pnpm --filter @docmind/experiences exec vitest run src/visuals.test.ts
set -a; . ./.env; set +a; pnpm --filter @docmind/server exec vitest run app/flows/visualize-document app/ui
pnpm typecheck && pnpm typecheck:tests && pnpm lint
```
Expected: PASS everywhere, pg tests run (not skipped), typecheck clean.

- [ ] **Step 17: Commit**

```bash
git add apps/server/app packages/experiences infra/migrations/0035_visual_facts_structure_kinds.sql docs/codebase-guide.md
git commit -m "feat(visuals): structure facts (outline, co-occurrence), shared replace semantics and the visualize-structure step"
```

---

### Task 4: Catalogue v3, reshapers, fit, capabilities, fingerprint, intent

**Files:**
- Create: `packages/experiences/src/structureShapes.ts`, `packages/experiences/src/structureShapes.test.ts`
- Modify: `packages/experiences/src/visuals.ts`, `packages/experiences/src/providers.ts`, `packages/experiences/src/views.ts`
- Modify (server): `apps/server/app/flows/visualize-document/plan.ts` (the intent)
- Test: `packages/experiences/src/visuals.test.ts`, `packages/experiences/src/providers.test.ts`, `packages/experiences/src/views.test.ts` (existing), `apps/server/app/flows/visualize-document/{plan,fit,flow}.test.ts`

**Interfaces:**
- Consumes: the stored shapes of Task 3 and `OutlineFact`, `EntityMapFact`, the extended `VisualFactRaw` and the content-free sample, all defined in Task 3 step 12b (not here, P14); `diagramProblems`, `MAX_DIAGRAM_NODES` from `@loom-ui/core`.
- Produces:
  - `visuals.ts`: catalogue entries `DocumentOutline` and `EntityMap` (kind `Diagram`); `VISUALS_CATALOG.id === "docmind.visuals.v3"`; `VisualEntry` includes both; reshaper families `visual-outline`, `visual-entitymap`, built into `VISUAL_SHAPES` only as `visual-outline-16` and `visual-entitymap-17`; `entryFitsOrdinal(entry: string, ordinal: number): boolean` (a structure entry reads only its own ordinal, any other entry ordinals 0..15); `fitsShape("DocumentOutline" | "EntityMap", fact)`.
  - `structureShapes.ts`: `outlineDiagram(f: OutlineFact): DiagramShape | null`, `entityMapDiagram(f: EntityMapFact): DiagramShape | null` where `DiagramShape = { layout: "tree" | "network"; nodes: DiagramNode[]; edges: DiagramEdge[] }` (null = does not fit).
  - `providers.ts`: `export const STRUCTURE_FORMAT = "docmind.structure@1"`; `factFormatFingerprint()` ends `+${STRUCTURE_FORMAT}`.

- [ ] **Step 1: Write the failing tests.** First the shape tests, create `packages/experiences/src/structureShapes.test.ts`:

```ts
import { DiagramValue, MAX_DIAGRAM_NODES, diagramProblems } from "@loom-ui/core";
import { describe, expect, it } from "vitest";
import { entityMapDiagram, outlineDiagram } from "./structureShapes";
import type { EntityMapFact, OutlineFact } from "./visuals";

const cid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** Outline nodes from (label, level) pairs, with the ids `s<index>` the builder gives them. */
const nodes = (...specs: [string, number][]) =>
  specs.map(([label, level], i) => ({
    id: `s${i}`,
    label,
    level,
    passageCount: 1,
    firstChunkId: cid(i + 1),
  }));
const OUTLINE: OutlineFact = {
  kind: "outline",
  title: "Annual report",
  nodes: nodes(["Intro", 1], ["Methods", 1], ["Data", 2], ["Model", 2], ["Results", 1]),
  chunkIds: [cid(1)],
  ordinal: 16,
};
const MAP: EntityMapFact = {
  kind: "cooccurrence",
  entities: [
    { name: "Acme", entityKind: "organization", passages: 4 },
    { name: "Bolt", entityKind: "organization", passages: 3 },
    { name: "Cora", entityKind: "person", passages: 2 },
  ],
  edges: [
    { a: 0, b: 1, weight: 3, firstChunkId: cid(1) },
    { a: 0, b: 2, weight: 2, firstChunkId: cid(2) },
  ],
  chunkIds: [cid(1), cid(2)],
  ordinal: 17,
};

describe("outlineDiagram", () => {
  it("is a tree rooted at the document title, with parent to child edges, the fact's node ids and the level as the group", () => {
    const v = outlineDiagram(OUTLINE);
    expect(v?.layout).toBe("tree");
    expect(v?.nodes[0]).toEqual({ id: "root", label: "Annual report", group: "0", kind: "document" });
    expect(v?.nodes.map((n) => [n.id, n.label, n.group])).toEqual([
      ["root", "Annual report", "0"],
      ["s0", "Intro", "1"],
      ["s1", "Methods", "1"],
      ["s2", "Data", "2"],
      ["s3", "Model", "2"],
      ["s4", "Results", "1"],
    ]);
    expect(v?.edges.map((e) => [e.from, e.to])).toEqual([
      ["root", "s0"],
      ["root", "s1"],
      ["s1", "s2"],
      ["s1", "s3"],
      ["root", "s4"],
    ]);
    expect(diagramProblems(v as never)).toEqual([]);
    expect(DiagramValue.safeParse(v).success).toBe(true);
  });

  it("does not fit when the nesting is broken or the diagram is over loom-ui's cap", () => {
    expect(outlineDiagram({ ...OUTLINE, nodes: nodes(["Deep", 2], ["A", 1], ["B", 1]) })).toBeNull(); // first node is level 2
    expect(outlineDiagram({ ...OUTLINE, nodes: nodes(["A", 1], ["B", 3], ["C", 1]) })).toBeNull(); // a level is skipped
    const many = nodes(...Array.from({ length: MAX_DIAGRAM_NODES }, (_, i): [string, number] => [`H${i}`, 1]));
    expect(outlineDiagram({ ...OUTLINE, nodes: many })).toBeNull(); // the root makes 201
  });

  it("does not fit when a node id repeats or is the root's", () => {
    expect(outlineDiagram({ ...OUTLINE, nodes: OUTLINE.nodes.map((n) => ({ ...n, id: "s0" })) })).toBeNull();
    expect(
      outlineDiagram({ ...OUTLINE, nodes: OUTLINE.nodes.map((n, i) => (i === 1 ? { ...n, id: "root" } : n)) }),
    ).toBeNull();
  });

  it("stays a valid tree at the 120-node cap", () => {
    const at = nodes(...Array.from({ length: 120 }, (_, i): [string, number] => [`H${i}`, i % 3 === 0 ? 1 : 2]));
    const v = outlineDiagram({ ...OUTLINE, nodes: at });
    expect(v?.nodes).toHaveLength(121);
    expect(diagramProblems(v as never)).toEqual([]);
  });
});

describe("entityMapDiagram", () => {
  it("is a network of entities grouped by kind, with the shared-passage count on each edge", () => {
    const v = entityMapDiagram(MAP);
    expect(v?.layout).toBe("network");
    expect(v?.nodes).toEqual([
      { id: "e0", label: "Acme", group: "organization", kind: "organization" },
      { id: "e1", label: "Bolt", group: "organization", kind: "organization" },
      { id: "e2", label: "Cora", group: "person", kind: "person" },
    ]);
    expect(v?.edges).toEqual([
      { from: "e0", to: "e1", label: "3" },
      { from: "e0", to: "e2", label: "2" },
    ]);
    expect(diagramProblems(v as never)).toEqual([]);
  });

  it("does not fit when an edge names an entity that is not there", () => {
    expect(entityMapDiagram({ ...MAP, edges: [{ a: 0, b: 7, weight: 2, firstChunkId: cid(1) }] })).toBeNull();
  });
});
```

Then the catalogue, reshaper, fit and provider tests, in `packages/experiences/src/visuals.test.ts`. Extend the existing import from `./visuals` with `entryFitsOrdinal`. (The module-level `cid`, `OUTLINE` and `MAP` fixtures and the capability tests were added in Task 3 step 12b; do not redefine them.) Add:

```ts
describe("structure widgets", () => {
  const doc = "11111111-1111-4111-8111-111111111111";
  const cites = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      documentId: doc,
      passageId: cid(i + 1),
      label: `Report, passage ${i + 1}`,
    }));

  it("the document catalogue is v3 and has the two diagram entries; the chat catalogue has neither", () => {
    expect(VISUALS_CATALOG.id).toBe("docmind.visuals.v3");
    const web = (name: string) =>
      (VISUALS_CATALOG.entries.find((e) => e.name === name)?.surfaces.web as { kind: string }).kind;
    expect(web("DocumentOutline")).toBe("Diagram");
    expect(web("EntityMap")).toBe("Diagram");
    expect(FACT_VISUALS_CATALOG.entries.map((e) => e.name)).not.toContain("DocumentOutline");
    expect(FACT_VISUALS_CATALOG.entries.map((e) => e.name)).not.toContain("EntityMap");
  });

  it("reshapes the outline to a valid tree whose refs are the cited passages (at most 16)", () => {
    const v = shape("visual-outline-16", [{ ...OUTLINE, cites: cites(20) }]) as {
      layout: string;
      refs: { id: string; label: string }[];
    };
    expect(v.layout).toBe("tree");
    expect(v.refs).toHaveLength(16);
    expect(v.refs[0]).toEqual({ id: `${doc}:${cid(1)}`, label: "Report, passage 1" });
    expect(checkKindValue("Diagram", v)).toMatchObject({ ok: true });
  });

  it("reshapes the map to a valid network with refs, and carries no refs when nothing is cited", () => {
    const v = shape("visual-entitymap-17", [{ ...MAP, cites: cites(2) }]) as {
      layout: string;
      refs?: unknown[];
    };
    expect(v.layout).toBe("network");
    expect(v.refs).toHaveLength(2);
    expect(checkKindValue("Diagram", v)).toMatchObject({ ok: true });
    expect((shape("visual-entitymap-17", [MAP]) as { refs?: unknown }).refs).toBeUndefined();
  });

  it("fitsShape accepts the right fact and rejects the wrong one, as hydration would", () => {
    expect(fitsShape("DocumentOutline", OUTLINE)).toBe(true);
    expect(fitsShape("DocumentOutline", MAP)).toBe(false);
    expect(fitsShape("DocumentOutline", FIGURE)).toBe(false);
    expect(fitsShape("DocumentOutline", undefined)).toBe(false);
    expect(fitsShape("EntityMap", MAP)).toBe(true);
    expect(fitsShape("EntityMap", OUTLINE)).toBe(false);
    expect(
      fitsShape("EntityMap", { ...MAP, edges: [{ a: 0, b: 9, weight: 2, firstChunkId: cid(1) }] }),
    ).toBe(false);
    expect(fitsShape("FigureChart", OUTLINE)).toBe(false); // an outline fits no extracted-fact widget
    expect(fitsShape("KeyFigure", MAP)).toBe(false);
  });

  it("builds the structure reshapers only at their reserved ordinals, and an entry reads only its own ordinal (P2)", () => {
    const keys = Object.keys(VISUAL_SHAPES);
    for (const k of ["visual-outline-16", "visual-entitymap-17", "visual-kpi-15", "visual-table-0"])
      expect(keys, k).toContain(k);
    for (const k of [
      "visual-outline-17",
      "visual-outline-3",
      "visual-entitymap-16",
      "visual-entitymap-0",
      "visual-kpi-16",
      "visual-bar-17",
      "visual-trend-16",
      "visual-table-16",
    ])
      expect(keys, k).not.toContain(k);
    expect([16, 17, 3].map((n) => entryFitsOrdinal("DocumentOutline", n))).toEqual([true, false, false]);
    expect([16, 17, 0].map((n) => entryFitsOrdinal("EntityMap", n))).toEqual([false, true, false]);
    expect([0, 15, 16, 17].map((n) => entryFitsOrdinal("KeyFigure", n))).toEqual([true, true, false, false]);
    expect([0, 15, 16, 17].map((n) => entryFitsOrdinal("FactTable", n))).toEqual([true, true, false, false]);
  });

  it("a provider reads the fact by ordinal for either entry", () => {
    expect(factProvider(16, doc, "DocumentOutline").reshaping).toMatchObject({ scriptRef: "visual-outline-16" });
    expect(factProvider(17, doc, "EntityMap").reshaping).toMatchObject({ scriptRef: "visual-entitymap-17" });
  });
});
```

In the same file, change the existing "the fact catalogue (chat)" test's `expect(VISUALS_CATALOG.id).toBe("docmind.visuals.v2");` to `"docmind.visuals.v3"`; in "resolves every entry on web and terminal" append `["DocumentOutline", "Diagram"], ["EntityMap", "Diagram"],` to the expected list; and change the existing test "register all 64 names" to:

```ts
  it("register all 66 names: the four fact families at ordinals 0..15, plus the outline at 16 and the map at 17", () => {
    expect(Object.keys(VISUAL_SHAPES)).toHaveLength(66);
    for (const f of ["bar", "trend", "kpi", "table"])
      for (let n = 0; n < 16; n++) expect(() => shapeOf(`visual-${f}-${n}`, [])).toThrow("missing");
    expect(() => shapeOf("visual-outline-16", [])).toThrow("missing");
    expect(() => shapeOf("visual-entitymap-17", [])).toThrow("missing");
  });
```

(The existing chat-catalogue tests already assert the chat id `docmind.visuals.v1`, its four entries and the sha256 guard: no companion test is added, P12.)

The fingerprint test: replace the first test of `packages/experiences/src/providers.test.ts` with:

```ts
import { PINS, STRUCTURE_FORMAT, factFormatFingerprint } from "./providers";

describe("factFormatFingerprint", () => {
  it("is stable and names the pins of both fact tools, of the connections tool, and the structure format", () => {
    expect(factFormatFingerprint()).toBe(factFormatFingerprint());
    expect(factFormatFingerprint()).toBe(
      `${PINS["visual.facts"]}+${PINS["turn.facts"]}+${PINS["doc.connections"]}+${STRUCTURE_FORMAT}`,
    );
    expect(STRUCTURE_FORMAT).toBe("docmind.structure@1");
    expect(factFormatFingerprint().length).toBeLessThanOrEqual(200);
  });
```
(keep the rest of the file; its second test still holds).

The views tests, in `packages/experiences/src/views.test.ts`. Inside `describe("detailWithVisuals", ...)`, before the test "compiles for web and terminal with no findings", add (it uses that describe's `visualsOf`, `kf`, `node`, `DOC`):

```ts
  it("adopts the outline at fact-16 and the entity map at fact-17 with their own reshapers, and no other pairing (P2)", () => {
    const exp = detailWithVisuals(
      visualsOf([
        kf("o", "DocumentOutline", "fact-16"),
        kf("m", "EntityMap", "fact-17"),
        kf("swap", "DocumentOutline", "fact-17"), // a structure entry on the other structure fact
        kf("low", "DocumentOutline", "fact-3"), // a structure entry on an extracted fact
        kf("high", "KeyFigure", "fact-16"), // a fact entry on a structure fact
      ]),
      DOC,
    );
    expect(node(exp, "visuals").children.map((c) => c.id)).toEqual(["v-o", "v-m"]);
    expect(exp.providers["fact-16"]).toEqual(factProvider(16, DOC, "DocumentOutline"));
    expect(exp.providers["fact-17"]).toEqual(factProvider(17, DOC, "EntityMap"));
    expect((exp.providers["fact-16"]?.reshaping as { scriptRef: string }).scriptRef).toBe("visual-outline-16");
    expect((exp.providers["fact-17"]?.reshaping as { scriptRef: string }).scriptRef).toBe("visual-entitymap-17");
    // the dropped pairings left no provider behind
    for (const h of ["fact-16-b", "fact-17-b", "fact-3"]) expect(exp.providers[h], h).toBeUndefined();
  });
```

and inside `describe("turnWithVisuals", ...)`, after the test "gives two entries over one fact separate providers" (uses that describe's `node`, `planned`, `experience`, `CHAT`, `A`, `live`):

```ts
  it("never adopts a structure widget or a structure ordinal in chat", () => {
    const e = experience(
      [
        node("n1", "DocumentOutline", "p-a"),
        node("n2", "EntityMap", "p-b"),
        node("n3", "KeyFigure", "p-c"),
      ],
      [
        planned("p-a", "visual.facts", `docmind:visual.facts@1#${A}/fact-16`),
        planned("p-b", "visual.facts", `docmind:visual.facts@1#${A}/fact-17`),
        planned("p-c", "visual.facts", `docmind:visual.facts@1#${A}/fact-16`),
      ],
    );
    // a structure entry is not a chat entry, and a fact entry may not read a structure ordinal: nothing is left
    expect(turnWithVisuals(e, { chatId: CHAT, ord: 6 }, live)).toBeNull();
  });
```

The fit test, in `apps/server/app/flows/visualize-document/fit.test.ts` (merge the type imports: `import type { FactRef, VisualFactRaw } from "@docmind/experiences";` and `import type { Fact, StructureFact } from "./facts";`), after `byOrdinal`:

```ts
const OUTLINE: StructureFact = {
  kind: "outline",
  title: "Zebra Report",
  nodes: ["A", "B", "C"].map((label, i) => ({
    id: `s${i}`,
    label,
    level: 1,
    passageCount: 1,
    firstChunkId: CHUNK,
  })),
  chunkIds: [CHUNK],
  ordinal: 16,
};
const lookupOf = (facts: readonly VisualFactRaw[]) => (ref: FactRef) =>
  ref.kind === "detail" ? facts.find((f) => f.ordinal === ref.ordinal) : undefined;
```
and inside `describe("dropUnfittingOps", ...)`:

```ts
  it("keeps a DocumentOutline bound to the outline fact and drops it when fact-16 holds something else", async () => {
    const outlineNode = {
      ...node("outline", "DocumentOutline", "fact-16"),
      span: 12,
      binding: { capability: "fact-16", arguments: {}, path: "nodes", priority: "P1" },
    };
    const p = await planVisuals(
      new ReferencePlanner({
        model: scriptedPlannerModel([JSON.stringify({ summary: "s", nodes: [outlineNode] })]),
        modelId: "t",
      }),
      [FIGURE, OUTLINE],
      recording(),
    );
    expect(p.findings.filter((f) => f.severity === "error")).toEqual([]);
    const kept = dropUnfittingOps(p.ops, lookupOf([FIGURE, OUTLINE]));
    expect(inserted(kept.ops)).toEqual(["outline"]);
    expect(kept.dropped).toEqual([]);
    // fact-16 now holds a figure: an outline widget does not fit it
    const gone = dropUnfittingOps(p.ops, lookupOf([FIGURE, { ...FIGURE, ordinal: 16 }]));
    expect(inserted(gone.ops)).toEqual([]);
    expect(gone.dropped).toEqual(["DocumentOutline"]);
    // and a fact that is gone fits nothing
    expect(inserted(dropUnfittingOps(p.ops, lookupOf([FIGURE])).ops)).toEqual([]);
  });
```

The planning tests, in `apps/server/app/flows/visualize-document/plan.test.ts` (add `ENTITY_MAP_ORDINAL, OUTLINE_ORDINAL, type StructureFact` to the import from `./facts`, and `import { shape } from "@docmind/experiences";` merged with the existing `@docmind/experiences` import):

```ts
describe("planning the structure facts", () => {
  const chunk = FIGURE.chunkIds[0] as string;
  const OUTLINE: StructureFact = {
    kind: "outline",
    title: "Zebra Report",
    nodes: ["A", "B", "C"].map((label, i) => ({ id: `s${i}`, label, level: 1, passageCount: 1, firstChunkId: chunk })),
    chunkIds: [chunk],
    ordinal: OUTLINE_ORDINAL,
  };
  const MAP: StructureFact = {
    kind: "cooccurrence",
    entities: ["P1", "P2", "P3"].map((name) => ({ name, entityKind: "person" as const, passages: 2 })),
    edges: [
      { a: 0, b: 1, weight: 2, firstChunkId: chunk },
      { a: 1, b: 2, weight: 2, firstChunkId: chunk },
    ],
    chunkIds: [chunk],
    ordinal: ENTITY_MAP_ORDINAL,
  };
  const bind = (id: string, type: string, capability: string, path: string) => ({
    id,
    type,
    label: id,
    span: 12,
    props: {},
    binding: { capability, arguments: {}, path, priority: "P1" },
  });

  it("plans an outline bound at nodes and a map bound at edges, with no reshape-invalid (P3)", async () => {
    const planner = new ReferencePlanner({
      model: scriptedPlannerModel([
        draft(
          [bind("outline", "DocumentOutline", "fact-16", "nodes"), bind("map", "EntityMap", "fact-17", "edges")],
          "The structure",
        ),
      ]),
      modelId: "t",
    });
    const plan = await planVisuals(planner, [FIGURE, OUTLINE, MAP], recording());
    expect(plan.findings.map((f) => f.code)).not.toContain("reshape-invalid");
    expect(plan.findings.filter((f) => f.severity === "error")).toEqual([]);
    const inserted = (plan.ops as { type: string; node?: { id: string } }[])
      .filter((o) => o.type === "insertNode")
      .map((o) => o.node?.id);
    expect(inserted).toEqual(["outline", "map"]);
  });

  it("the server's reserved ordinals are the ones the experiences reshapers serve", () => {
    expect(() => shape(`visual-outline-${OUTLINE_ORDINAL}`, [OUTLINE])).not.toThrow();
    expect(() => shape(`visual-entitymap-${ENTITY_MAP_ORDINAL}`, [MAP])).not.toThrow();
  });
});
```

And the intent test, appended to the same file:

```ts
describe("the intent", () => {
  it("tells the planner when to show the outline and the entity map, and when to leave them out", () => {
    expect(VISUALS_INTENT.objective).toContain("DocumentOutline");
    expect(VISUALS_INTENT.objective).toContain("EntityMap");
    expect(VISUALS_INTENT.objective).toMatch(/long, sectioned documents/);
    expect(VISUALS_INTENT.objective).toMatch(/short or flat documents/);
  });
});
```
(`VISUALS_INTENT` is already imported by `plan.test.ts`.)

The flow tests, in `apps/server/app/flows/visualize-document/flow.test.ts` (inside `describe("visualize-document flow", ...)`, using `STRUCTURE_READER` from Task 3 step 13). The path is `nodes`: it validates against the placeholder sample of step 12b.

```ts
  const OUTLINE_NODE = {
    id: "outline",
    type: "DocumentOutline",
    label: "Outline",
    span: 12,
    props: {},
    binding: { capability: "fact-16", arguments: {}, path: "nodes", priority: "P1" },
  };
  const OUTLINE_PLAN = JSON.stringify({ summary: "The outline", nodes: [OUTLINE_NODE] });

  it("plans over both an extracted fact and the outline, and commits both widgets", async () => {
    const s = stack([FACTS, JSON.stringify({ summary: SUMMARY, nodes: [NODE, OUTLINE_NODE] })], {
      structure: STRUCTURE_READER,
    });
    expect(await s.run()).toEqual({ outcome: "done" });
    const latest = await s.lineage.resolveLatest(experienceIdOf(s.ref));
    expect(latest.ok && childrenOf(latest.value.root).map((c) => c.id)).toEqual([
      "revenue",
      "outline",
    ]);
  });

  it("plans a document that has only a structure fact (no extracted facts)", async () => {
    const s = stack([JSON.stringify({ facts: [] }), OUTLINE_PLAN], { structure: STRUCTURE_READER });
    expect(await s.run()).toEqual({ outcome: "done" });
    expect(s.held()).toEqual([]);
    const latest = await s.lineage.resolveLatest(experienceIdOf(s.ref));
    expect(latest.ok && childrenOf(latest.value.root).map((c) => c.id)).toEqual(["outline"]);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @docmind/experiences exec vitest run src/structureShapes.test.ts src/visuals.test.ts src/providers.test.ts src/views.test.ts && pnpm --filter @docmind/server exec vitest run app/flows/visualize-document/plan.test.ts app/flows/visualize-document/fit.test.ts app/flows/visualize-document/flow.test.ts`
Expected: FAIL (`./structureShapes` missing, catalogue still v2).

- [ ] **Step 3: Implement the diagram builders**, create `packages/experiences/src/structureShapes.ts`:

```ts
import { MAX_DIAGRAM_NODES, diagramProblems } from "@loom-ui/core";
import type { EntityMapFact, OutlineFact } from "./visuals";

export interface DiagramNode {
  id: string;
  label: string;
  group: string;
  kind: string;
}
export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
}
export interface DiagramShape {
  layout: "tree" | "network";
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

/** The shape if loom-ui accepts it as a `Diagram` value (`diagramProblems`: unique ids, one root, nodes and edges in range), else null. */
const accepted = (v: DiagramShape): DiagramShape | null =>
  v.nodes.length <= MAX_DIAGRAM_NODES && diagramProblems(v).length === 0 ? v : null;

/**
 * The document's sections as a tree: a root for the title, one node per section under the fact's own node id (group = its
 * level), an edge from each node's parent. The parent is the nearest earlier node one level up, so a first node below level 1
 * or a skipped level does not fit; an id that repeats or is "root" does not fit either (`diagramProblems`: unique ids).
 * Labels are text only.
 */
export function outlineDiagram(f: OutlineFact): DiagramShape | null {
  const nodes: DiagramNode[] = [{ id: "root", label: f.title, group: "0", kind: "document" }];
  const edges: DiagramEdge[] = [];
  const open = ["root"]; // open[level] is the latest node id at that level
  for (const n of f.nodes) {
    const parent = open[n.level - 1];
    if (parent === undefined) return null;
    nodes.push({ id: n.id, label: n.label, group: String(n.level), kind: "section" });
    edges.push({ from: parent, to: n.id });
    open.length = n.level;
    open.push(n.id);
  }
  return accepted({ layout: "tree", nodes, edges });
}

/** The entities as a network (group = their kind), an edge per co-occurrence labelled with the shared-passage count. */
export function entityMapDiagram(f: EntityMapFact): DiagramShape | null {
  const nodes = f.entities.map((e, i) => ({
    id: `e${i}`,
    label: e.name,
    group: e.entityKind,
    kind: e.entityKind,
  }));
  const edges: DiagramEdge[] = [];
  for (const e of f.edges) {
    if (e.a === e.b || nodes[e.a] === undefined || nodes[e.b] === undefined) return null;
    edges.push({ from: `e${e.a}`, to: `e${e.b}`, label: String(e.weight) });
  }
  return accepted({ layout: "network", nodes, edges });
}
```

- [ ] **Step 4: Implement the catalogue, reshapers, capabilities and fingerprint**

`packages/experiences/src/visuals.ts`:

1. Add the import `import { entityMapDiagram, outlineDiagram } from "./structureShapes";` (below `import { KIND, PINS, provider } from "./providers";`).
2. (Done in Task 3 step 12b, P14: `OutlineFact`, `EntityMapFact`, the extended `VisualFactRaw`.)
3. `ENTRIES`: after `["ConnectionMap", "Diagram"],` add `["DocumentOutline", "Diagram"],` and `["EntityMap", "Diagram"],`.
4. `VISUALS_CATALOG` id: `"docmind.visuals.v3"`. Leave `FACT_ENTRY_NAMES`, `FACT_VISUALS_CATALOG` and the `catalogOf` helper untouched (the chat catalogue is built from the four fact names only, so its bytes do not change).
5. (Done in Task 3 step 12b: `describeFact`, `depthOf`, the placeholders and `sampleOf`.)
6. `VisualEntry` and `FAMILY`:

```ts
export type VisualEntry =
  | "FigureChart"
  | "FigureTrend"
  | "KeyFigure"
  | "FactTable"
  | "DocumentOutline"
  | "EntityMap";
const FAMILY: Record<VisualEntry, string> = {
  FigureChart: "visual-bar",
  FigureTrend: "visual-trend",
  KeyFigure: "visual-kpi",
  FactTable: "visual-table",
  DocumentOutline: "visual-outline",
  EntityMap: "visual-entitymap",
};
/** The reserved ordinal each structure entry reads (the server's `OUTLINE_ORDINAL` and `ENTITY_MAP_ORDINAL`: experiences does not import the server; a server test pins them equal). */
const STRUCTURE_ORDINAL: Partial<Record<VisualEntry, number>> = { DocumentOutline: 16, EntityMap: 17 };
/** True when `entry` may read the fact at `ordinal`: a structure entry only its own reserved ordinal, any other entry the extracted ones (0..15). */
export const entryFitsOrdinal = (entry: string, ordinal: number): boolean => {
  const own = STRUCTURE_ORDINAL[entry as VisualEntry];
  return own !== undefined
    ? ordinal === own
    : Number.isInteger(ordinal) && ordinal >= 0 && ordinal < MAX_VISUAL_FACTS;
};
```
7. Two entries in `TO`, after `"visual-table"`:

```ts
  "visual-outline": (f) => {
    const v = f.kind === "outline" ? outlineDiagram(f) : null;
    return v === null ? wrong() : { ...v, ...refsOf(f) };
  },
  "visual-entitymap": (f) => {
    const v = f.kind === "cooccurrence" ? entityMapDiagram(f) : null;
    return v === null ? wrong() : { ...v, ...refsOf(f) };
  },
```
`refsOf` already caps at 16 distinct cites in the fact's order; `fitsShape` picks the entries up through `FAMILY`/`TO`.

8. `VISUAL_SHAPES` (P2): replace the `Array.from({ length: MAX_VISUAL_FACTS }, ...)` that builds each family's names so a structure family is built only at its reserved ordinal (the table today would otherwise stop at 15, and a plain widening would also create `visual-kpi-16` and `visual-outline-3`):

```ts
/** The ordinals a reshaper family serves: an extracted-fact family 0..15, a structure family exactly its reserved one. */
const ordinalsOf = (family: string): number[] => {
  const entry = (Object.keys(FAMILY) as VisualEntry[]).find((e) => FAMILY[e] === family);
  const own = entry === undefined ? undefined : STRUCTURE_ORDINAL[entry];
  return own !== undefined ? [own] : Array.from({ length: MAX_VISUAL_FACTS }, (_, n) => n);
};

export const VISUAL_SHAPES: Record<string, (raw: never) => unknown> = Object.fromEntries(
  Object.entries(TO).flatMap(([family, to]) =>
    ordinalsOf(family).map((n) => [
      `${family}-${n}`,
      (raw: VisualFactRaw[]) => {
        const f = raw.find((x) => x.ordinal === n);
        if (!f) throw new Error("visual fact missing");
        return to(f);
      },
    ]),
  ),
);
```
`MAX_VISUAL_FACTS` stays 16: it is the extraction bound, not a bound on stored ordinals.

`packages/experiences/src/providers.ts`, add above `factFormatFingerprint` and extend it:

```ts
/**
 * The form of the derived structure facts (outline, co-occurrence) inside `visual.facts`. Bump it when their stored or served
 * shape changes. It is part of the fingerprint rather than a new pin: stored chat heads carry `docmind:visual.facts@1#...`
 * pins, which must keep parsing.
 */
export const STRUCTURE_FORMAT = "docmind.structure@1";

export function factFormatFingerprint(): string {
  return `${PINS["visual.facts"]}+${PINS["turn.facts"]}+${PINS["doc.connections"]}+${STRUCTURE_FORMAT}`;
}
```
and update its doc comment to say it also names the structure format.

`packages/experiences/src/views.ts`:
- Replace `const VISUAL_ENTRIES = new Set<string>([...])` with

```ts
const FACT_ENTRIES = ["FigureChart", "FigureTrend", "KeyFigure", "FactTable"];
/** A document's page can draw the fact widgets and the two structure widgets; chat only the fact widgets (S5). */
const DETAIL_ENTRIES = new Set<string>([...FACT_ENTRIES, "DocumentOutline", "EntityMap"]);
const TURN_ENTRIES = new Set<string>(FACT_ENTRIES);
```
- In the import from `./visuals` replace `MAX_VISUAL_FACTS,` (no other use in `views.ts`) with `entryFitsOrdinal,`, in biome's order: `type FactRef, type VisualEntry, entryFitsOrdinal, factProvider, factRefOfPin, turnFactProvider`.
- In `interface Adopt<R>` add `/** The catalogue entries this host draws. */ entries: ReadonlySet<string>;`
- In `adoptVisuals` replace the condition `ref.ordinal >= MAX_VISUAL_FACTS || !VISUAL_ENTRIES.has(n.type)` with `!o.entries.has(n.type) || !entryFitsOrdinal(n.type, ref.ordinal)` (P2: a fact entry only reads ordinals below 16, `DocumentOutline` only 16, `EntityMap` only 17).
- In `detailWithVisuals`'s `adoptVisuals(visuals, { ... })` object add `entries: DETAIL_ENTRIES,`; in `turnWithVisuals`'s add `entries: TURN_ENTRIES,`.

`apps/server/app/flows/visualize-document/plan.ts`, replace `VISUALS_INTENT.objective` with:

```ts
  objective:
    "Help a reader grasp this document at a glance. Show only what a visual makes clearer than prose. Prefer fewer widgets. Every widget binds one fact, except RelatedDocuments and ConnectionMap, which bind the live connections capability: it may grow, so include a compact Connections section when the document has, or is likely to gain, related material. Show a DocumentOutline for long, sectioned documents and an EntityMap when several parties interact; leave them out for short or flat documents.",
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter @docmind/experiences exec vitest run && pnpm --filter @docmind/server exec vitest run app/flows/visualize-document app/flows/visualize-turn`
Expected: PASS, including the unchanged sha256 chat guard (`e9096cf4...`), the two outline-planning flow tests added above, and the unchanged chat catalogue tests. If the sha256 guard fails, the chat catalogue changed: undo the edit that touched `catalogOf`, `PROPS`, `FACT_ENTRY_NAMES` or the `Diagram` props, do not edit the hash.

- [ ] **Step 6: Whole-repo verification and commit**

Run: `pnpm typecheck && pnpm typecheck:tests && pnpm lint`
Expected: clean (`pnpm lint:fix` for formatting only).

```bash
git add packages/experiences apps/server/app/flows/visualize-document/plan.ts apps/server/app/flows/visualize-document/plan.test.ts apps/server/app/flows/visualize-document/fit.test.ts apps/server/app/flows/visualize-document/flow.test.ts
git commit -m "feat(visuals): DocumentOutline and EntityMap on catalogue docmind.visuals.v3 (reshapers, fit check, capabilities, fingerprint)"
```

---

### Task 5: End to end, web, and docs

**Files:**
- Test: `apps/server/app/documents/visuals.e2e.pg.test.ts` (new tests), `apps/web/src/ui/elements.test.ts`
- Modify: `docs/architecture.md`, `docs/specs/2026-11-08-document-visuals-design.md`

**Interfaces:**
- Consumes: everything above; the existing e2e helpers in `visuals.e2e.pg.test.ts` (`startIngestStack`, `stubVisuals`, `upload`, `visualizeOutcome`, `visualizeEnd`, `hydrate`, `detail`, `get`, `assertNoPlaintext`), `PgEntityStore`, `EntityKeys`, `PgVisualFacts`.
- Produces: nothing later tasks use.

- [ ] **Step 1: Write the e2e tests**, in `apps/server/app/documents/visuals.e2e.pg.test.ts` add the imports `import { EntityKeys } from "../crypto/entityKeys";`, `import { PgEntityStore } from "../flows/ingest-document/pgEntities";` and `import { chunkIdFor } from "../flows/ingest-document/chunker";` (merge with existing import lines), then add a stub and the tests inside the `describe.skipIf(!PG_URL)` block:

```ts
  const SECTIONED = [
    "# Zebra-Handbook-Title",
    "## Zebra-Overview-Section",
    `${NO_FACTS} Acme Corp and Bolt Ltd met Cora Diaz about the plan.`,
    "## Zebra-Details-Section",
    `${NO_FACTS} Acme Corp, Bolt Ltd and Cora Diaz agreed the terms.`,
    "### Zebra-Pricing-Subsection",
    `${NO_FACTS} Acme Corp, Bolt Ltd and Cora Diaz signed.`,
  ].join("\n\n");
  const SECRETS = [
    "Zebra-Overview-Section",
    "Zebra-Details-Section",
    "Zebra-Pricing-Subsection",
    "Acme Corp",
    "Cora Diaz",
  ];

  /** A visuals model that finds no extracted facts and plans whatever structure capabilities the prompt offers. */
  function stubStructure(claude: FakeAnthropic) {
    claude.reply((body) => {
      const system = typeof body.system === "string" ? body.system : JSON.stringify(body.system);
      const text = JSON.stringify(body.messages);
      if (system.includes("You extract facts")) return { text: '{"facts":[]}' };
      const widget = (id: string, type: string, capability: string, path: string) => ({
        id,
        type,
        label: id,
        span: 12,
        props: {},
        binding: { capability, arguments: {}, path, priority: "P1" },
      });
      const nodes = [
        ...(text.includes("fact-16") ? [widget("outline", "DocumentOutline", "fact-16", "nodes")] : []),
        ...(text.includes("fact-17") ? [widget("map", "EntityMap", "fact-17", "edges")] : []),
      ];
      return { text: JSON.stringify({ summary: "The document's structure", nodes }) };
    });
  }

  it("a long sectioned document gets an outline and an entity map, a citation opens the section, and nothing is plaintext", async () => {
    const st = await startIngestStack({ visuals: true });
    stacks.push(st);
    stubStructure(st.visualsClaude as FakeAnthropic);
    const ada = await st.signUpAndLogIn("ada@example.com");
    const id = await upload(st, ada.cookie, SECTIONED, { visuals: true, name: "handbook.md" });
    expect(await visualizeOutcome(st, ada.userId, id)).toBe("done");
    const ref = { tenantId: ada.tenantId, userId: ada.userId, documentId: id };
    const facts = new PgVisualFacts(st.app, st.fields);

    // Ingest is keyless here, so no entities exist yet: only the outline was derived (ordinal 16).
    expect((await facts.listAll(ref)).map((f) => [f.ordinal, f.kind])).toEqual([[16, "outline"]]);

    // The outline hydrates to a valid tree whose first ref is a real passage of the document.
    const outline = (await hydrate(st, ada.cookie, id, "fact-16")) as {
      state: string;
      value: { layout: string; nodes: { label: string }[]; refs: { id: string }[] };
    };
    expect(outline.state).toBe("ready");
    expect(outline.value.layout).toBe("tree");
    expect(outline.value.nodes.map((n) => n.label)).toEqual(
      expect.arrayContaining(["Zebra-Overview-Section", "Zebra-Details-Section", "Zebra-Pricing-Subsection"]),
    );
    const cited = (outline.value.refs[0] as { id: string }).id.split(":")[1] as string;
    const source = await get(st, ada.cookie, `/api/documents/${id}/source?passage=${cited}`);
    expect(source.status).toBe(200);
    expect(await source.json()).toMatchObject({ focus: expect.anything() });

    // Entities arrive (seeded: ingest is keyless); a re-run re-plans without extraction and re-derives the structure.
    const passages = (
      await st.db.owner.query("SELECT id FROM chunks WHERE document_id = $1 ORDER BY ordinal", [id])
    ).rows.map((r) => r.id as string);
    expect(passages.length).toBeGreaterThanOrEqual(3);
    await new PgEntityStore(st.app, st.fields, new EntityKeys(st.keys)).replaceForDocument(ref, [
      { name: "Acme Corp", kind: "organization", chunkIds: passages },
      { name: "Bolt Ltd", kind: "organization", chunkIds: passages },
      { name: "Cora Diaz", kind: "person", chunkIds: passages },
    ]);
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
    expect(await visualizeEnd(st, ada.userId, id, 1)).toEqual({ outcome: "done" });
    expect((await facts.listAll(ref)).map((f) => [f.ordinal, f.kind])).toEqual([
      [16, "outline"],
      [17, "cooccurrence"],
    ]);
    const map = (await hydrate(st, ada.cookie, id, "fact-17")) as {
      state: string;
      value: { layout: string; nodes: { label: string }[]; edges: { label: string }[]; refs: unknown[] };
    };
    expect(map.state).toBe("ready");
    expect(map.value.layout).toBe("network");
    expect(map.value.nodes.map((n) => n.label).sort()).toEqual(["Acme Corp", "Bolt Ltd", "Cora Diaz"]);
    expect(map.value.edges.every((e) => Number(e.label) >= 2)).toBe(true);
    expect(map.value.refs.length).toBeGreaterThan(0);

    // Nothing sealed is readable: the rows, and every execution's raw event log.
    const rows = await st.db.owner.query(
      "SELECT fact_enc::text AS t FROM visual_facts WHERE document_id = $1",
      [id],
    );
    for (const r of rows.rows) for (const s of SECRETS) expect(r.t).not.toContain(s);
    for (const execution of (await st.durable.raw.eventStore.listExecutions?.()) ?? [])
      assertNoPlaintext(await st.durable.raw.eventStore.read(execution), SECRETS);
    // The chat's facts for this document stay extracted-only.
    expect(await facts.list(ref)).toEqual([]);
    expect(chunkIdFor(id, 0)).toBe(passages[0]);
  }, 180_000);

  it("a short flat document gets neither an outline nor an entity map", async () => {
    const st = await startIngestStack({ visuals: true });
    stacks.push(st);
    stubStructure(st.visualsClaude as FakeAnthropic);
    const ada = await st.signUpAndLogIn("ada@example.com");
    const id = await upload(st, ada.cookie, `${NO_FACTS} A short note with no headings.`, {
      visuals: false,
    });
    expect(await visualizeOutcome(st, ada.userId, id)).toBe("empty");
    const left = await st.db.owner.query("SELECT 1 FROM visual_facts WHERE document_id = $1", [id]);
    expect(left.rowCount).toBe(0);
    expect(await (await detail(st, ada.cookie, id)).text()).not.toContain('"id":"visuals"');
  }, 120_000);
```

- [ ] **Step 2: Run to verify** (it runs against the implementation of Tasks 1 to 4; a failure is a real defect to fix there)

Run: `set -a; . ./.env; set +a; pnpm --filter @docmind/server exec vitest run app/documents/visuals.e2e.pg.test.ts`
Expected: PASS, with these two new tests listed as passed, not skipped. If the outline `refs[0]` is not a passage of the document or the entity map has no refs, check `withCites` (`ui/readers.ts`) is reading `listAll` and that `chunkIds` order is as Task 1/2 define.

- [ ] **Step 3: Web test**, append to `apps/web/src/ui/elements.test.ts`:

```ts
describe("the structure widgets", () => {
  it("the outline and the entity map are Diagram entries, and lu-diagram is defined for them", () => {
    createViewRegistry();
    for (const name of ["DocumentOutline", "EntityMap"]) {
      const entry = mergedCatalog().entries.find((e) => e.name === name);
      expect(entry, name).toBeDefined();
      const kind = (entry?.surfaces as { web: { kind: string } }).web.kind;
      expect(kind).toBe("Diagram");
      expect(customElements.get(TAG[kind] as string)).toBeDefined();
    }
  });
});
```

Run: `pnpm --filter @docmind/web exec vitest run src/ui/elements.test.ts`
Expected: PASS. (The existing `it.each(kinds)` block already proves every merged-catalogue kind has an element; this names the two new entries.)

- [ ] **Step 4: Docs**, apply these edits.

`docs/architecture.md`, §7.1 diagram: replace the two lines

```
  ready(["status: ready"]) --> extract["visualize-extract<br/>LLM facts, grounding check"]
  extract --> load["visualize-load"] --> plan["planner ctx.decide<br/>keyed decision id"] --> commit["visualize-commit<br/>lineage head, SSE"]
```
with
```
  ready(["status: ready"]) --> extract["visualize-extract<br/>LLM facts, grounding check"]
  extract --> structure["visualize-structure<br/>outline and entity map, no model"]
  structure --> load["visualize-load"] --> plan["planner ctx.decide<br/>keyed decision id"] --> commit["visualize-commit<br/>lineage head, SSE"]
```
and add this bullet after the **Extract.** bullet:

```
- **Structure.** The `visualize-structure` step (no model call, `STEP_RETRY`) runs after extract, and on a re-plan that skips extraction too. It reads only this document under the owner's key and derives two sealed facts stored in `visual_facts` on reserved ordinals: the **outline** (ordinal 16; the passages' heading paths as a tree, at most 120 nodes, labels clipped to 80 characters, deepest levels pruned first with their passage counts folded into the parent, none for fewer than 3 headings) and the **entity map** (ordinal 17; the 20 most-mentioned entities, an edge for each pair sharing at least 2 passages, the 40 strongest edges, entities left with no edge dropped, none for fewer than 3 linked). Extraction keeps its 16 facts (ordinals 0..15), and `PgVisualFacts.replace` and `replaceStructure` each own their own ordinal range, so neither wipes the other. Migration 0035 relaxes the table's `kind` and `ordinal` CHECKs for them (the `kind` column carries `outline` / `cooccurrence`; the sealed fact's own `kind` is authoritative). `list` returns extracted facts only (chat and the extraction re-plan check); `listAll` returns everything (load, the UI reader). A heading or entity name that does not open skips that one fact; a key-store outage fails the step. The entity query (`pgStructure.ts`) is owner-scoped and walks out from this document (`chunks_document_ordinal_key`, then the `chunk_entities` primary key), opening names only for the ranked few.
```
and extend the **Plan.** bullet's end with: ` The planner is offered the structure facts as capabilities whose description is counts only and whose sample is counts plus neutral placeholder nodes and edges (never a heading or a name), and \`VISUALS_INTENT\` says to show an outline for long, sectioned documents and an entity map when several parties interact.` Update the final sentence of the **Connections.** bullet (`Catalogue ids: ...`) to: `Catalogue ids: the chat catalogue keeps \`docmind.visuals.v1\` (byte-identical, sha256-guarded; chat never offers a structure widget); the document catalogue, which adds the two connections types and \`DocumentOutline\` and \`EntityMap\` (both loom-ui \`Diagram\`), is \`docmind.visuals.v3\`.` and the **Fact-format re-plan.** bullet's first sentence's list of fingerprint parts to add `and the structure format (\`docmind.structure@1\`)`; add: `The structure release re-plans every visualized document once (one planner call each, at most 2 at a time, no extraction): the step derives the structure facts first.`

`docs/specs/2026-11-08-document-visuals-design.md`, §10: replace the sentence

```
Then DocMind adds a `structure` fact (outline, timeline, relationships) and a `DocumentDiagram`
catalogue entry.
```
with
```
Then DocMind adds derived structure facts and diagram catalogue entries. Phase c1 (outline and entity map, derived from
passage headings and entity mentions, no model call) is specified in `2026-11-10-structure-diagrams-c1-design.md`; phase c2
(timeline and named relationships, model-extracted) has its own spec.
```
and append at the end of the file a section:

```
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
- Not done in c1: timeline and relationships (c2), diagrams in chat, cross-document structure.
```

- [ ] **Step 5: Full verification**

Run:
```
pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm build
set -a; . ./.env; set +a
pnpm --filter @docmind/experiences exec vitest run
pnpm --filter @docmind/web exec vitest run
pnpm --filter @docmind/server exec vitest run
```
Expected: all green; the server run includes the pg suites and the e2e (check the summary: pg tests passed, none skipped; a skipped pg test is not a pass). Re-check the chat guard specifically: `pnpm --filter @docmind/experiences exec vitest run src/visuals.test.ts -t "chat catalogue"` passes with the original hash.

- [ ] **Step 6: Commit**

```bash
git add apps/server/app/documents/visuals.e2e.pg.test.ts apps/web/src/ui/elements.test.ts docs/architecture.md docs/specs/2026-11-08-document-visuals-design.md
git commit -m "test(visuals): structure diagrams end to end; docs for phase c1"
```

---

## Self-Review (spec section to task)

| Spec section | Where it is implemented and tested |
|---|---|
| 1 Goal (outline, entity map on the Visuals tab) | Tasks 3 to 5; e2e in Task 5 |
| 2 S1 (existing data only, no model call) | Task 3 step (`structure.ts` makes no model call; flow test asserts 2 requests); Global Constraints |
| 2 S2 (derived at visualize time, stored) | Task 3 (step + `replaceStructure`); never live at hydrate |
| 2 S3 (two kinds `outline`, `cooccurrence`, sealed, cite passages, never sent to a model as text) | Task 3 3a (zod, `StructureOrdinal`, `chunkIds`), 3b (sealed, pg test), step 12b (counts-and-placeholders sample; tests assert no fact text in the capabilities and that `nodes`/`edges` validate) |
| 2 S4 (two catalogue entries on Diagram) | Task 4 (`ENTRIES`, reshaper families, tests) |
| 2 S5 (document visuals only; chat catalogue byte-identical, sha256 guard) | Task 4 (catalogue untouched, `TURN_ENTRIES` and `entryFitsOrdinal`, the existing id/entries/sha256 tests unchanged, the chat views test), Task 3 (`list` extracted-only) |
| 2 S6 (rollout reuses the format re-plan; v3; fingerprint changes) | Task 4 (`STRUCTURE_FORMAT`, id v3, fingerprint test); Task 5 docs |
| 2 S7 (one migration 0035 relaxing the kind and ordinal CHECKs, no table) | Task 3 3b (migration step 4b and its pg test; the column carries the fact's own kind), Plan decisions |
| 3 outline (nodes, root, order, duplicates, cap 120, pruning, fold, <3) | Task 1 (all cases tested) |
| 3 co-occurrence (counts, top 20, ties by name, edges >=2, 40, isolated dropped, <3 linked) | Task 2 (tested); query in Task 3 3c |
| 3 Storage (replace beside extracted, own ordinals, cite passages, re-plan path re-derives) | Task 3 3b and 3d (store tests with disjoint ordinal ranges; flow re-run test) |
| 3 Errors (unreadable skips that fact, key-store outage fails the step) | Task 3 3c (reader returns null / rethrows), 3d (`structure.test.ts`) |
| 4 catalogue entries (labels, groups, edges, refs <= 16) | Task 4 (`structureShapes.ts`, `refsOf`, tests) |
| 4 reshapers pass `diagramProblems`, text-only labels, `fitsShape` | Task 4 (`accepted()` in shapes; visuals tests; `fit.test.ts`) |
| 4 planning (capabilities with pins, intent sentence, v3, fingerprint) | Task 3 step 12b and Task 4 (capabilities and sample tests, planning test with no `reshape-invalid`, intent test, providers test) |
| 5 privacy and cost (sealed, no plaintext in logs/event log, planner counts and neutral placeholders only, one decrypt pass + one entity query, one planner call rollout) | Task 3 (log test, pg sealed test, index-bound test), Task 4 (no text in capabilities), Task 5 (e2e `assertNoPlaintext`) |
| 6 testing: outline builder / co-occurrence builder | Tasks 1 and 2 |
| 6 reshapers, refs within cap, `fitsShape` | Task 4 (shape, visuals, views, fit and plan tests; `VISUAL_SHAPES` at 16 and 17 only) |
| 6 step on full run and extraction-skipping re-plan; undecryptable field skips only that fact | Task 3 3d |
| 6 chat sha256 guard unchanged | Task 4 (existing guard untouched) and Task 5 full run |
| 6 Postgres: sealed, owner-scoped, index-bound, only this document's rows | Task 3 3b and 3c |
| 6 e2e: long sectioned doc gets both, citation opens the section; short flat gets neither; no plaintext in the event log | Task 5 |
| 6 Web: both diagrams render (`lu-diagram` registered) | Task 5 step 3 |
| 3 outline node `{ id, label, level, passageCount, firstChunkId }` (P18) | Task 1 (`id` by position), Task 3 3a (zod), Task 4 (`outlineDiagram` uses it) |
| S6 rollout: runs in flight at deploy | Task 3 step 15b (1.0.0 stays registered before 1.1.0; hash, runner and registration-order tests) |
| 7 Out of scope | Not implemented: no timeline, relationships, chat diagrams, cross-document structure, node editing |

**Placeholder scan:** no "TBD"/"TODO"/"similar to"; every code step carries the code. The views, fit, plan and legacy-flow tests that the first version described against existing helpers are now written out (P13), against helpers verified in the repo (`visualsOf`/`kf` and `experience`/`planned` in `views.test.ts`, `plan`/`node`/`inserted` in `fit.test.ts`, `stack` in `flow.test.ts`).

**Type consistency:** `OutlineDraft`/`CooccurrenceDraft` (Tasks 1, 2) match `StoredEntry` (Task 3: nodes `id/label/level/passageCount/firstChunkId`, entities `name/entityKind/passages`, edges `a/b/weight/firstChunkId`) and `OutlineFact`/`EntityMapFact` (Task 3 step 12b, consumed by Task 4) field for field; `OUTLINE_ORDINAL` 16 and `ENTITY_MAP_ORDINAL` 17 are used by the step (Task 3), the capability handles `fact-16`/`fact-17` (step 12b, Task 4 tests), the experiences `STRUCTURE_ORDINAL`/`VISUAL_SHAPES`/`entryFitsOrdinal` (Task 4; a `plan.test.ts` test pins the two copies equal) and the e2e hydrate handles (Task 5); the ordinal schemas are `Ordinal` 0..15 (extracted), `StructureOrdinal` 16 | 17, `StoredEntry` over both and `MAX_STORED_FACTS` 18 in `LoadOutput`; `StructureReader` methods (`title`, `headings`, `entities`, `mentions`) are the same in `structure.ts`, `pgStructure.ts`, `testing.ts` (`noStructure`) and the tests; `visualize-structure` is the id in `flow.ts`, `deps.ts`, `security.ts` and `structure.ts`; `listAll` is read by `plan.ts` `loadEffect` and `ui/readers.ts` and `list` by chat and extract; `visualizeFlows` (config) orders `legacyFlow` (1.0.0) before `flow` (1.1.0).
