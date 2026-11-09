# Structure Diagrams, Phase C1 (Outline and Entity Map) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a document's section outline (a tree) and an entity map (a network of entities that appear together) on its Visuals tab, derived at visualize time from data that already exists, with no model call.

**Architecture:** A new `visualize-structure` step runs after `visualize-extract` (and on the extraction-skipping re-plan path too). It reads this document's passage heading paths and entity mentions under the owner's key, builds two derived facts (`outline`, `cooccurrence`) with pure builders, and stores them sealed in `visual_facts` on reserved ordinals 16 and 17 (migration 0035 relaxes the `kind` and `ordinal` CHECKs for them). The document catalogue becomes `docmind.visuals.v3` with `DocumentOutline` and `EntityMap` (loom-ui `Diagram`), whose reshapers build `DiagramValue`s that pass `diagramProblems`; `fitsShape` guards them at plan time. Chat is untouched.

**Tech Stack:** TypeScript, zod, Postgres (RLS, `withTenant`), Loom (`step$`, `flow$`, `stepEffectOf`), loom-ui pinned at 3b4d046 (`@loom-ui/core` `DiagramValue`, `diagramProblems`, `MAX_DIAGRAM_NODES`; `Diagram` kind; `MAX_WIDGET_REFS` 16), vitest, pnpm/turbo, biome.

**Spec:** `docs/specs/2026-11-10-structure-diagrams-c1-design.md` (binding; read it first). Background: `docs/specs/2026-11-08-document-visuals-design.md` §10.

## Global Constraints

Every task's requirements include these (values copied from the spec):

- Outline: at most **120 outline nodes**; labels are the heading text trimmed and clipped to **80 characters**; **fewer than 3 headings produces no outline**; the root is the document title; siblings keep document order; a duplicate heading under one parent is a separate node; over the cap the deepest levels are pruned first and a pruned node's passage count is folded into its parent.
- Entity map: keep the **top 20 entities** by mention count (the number of this document's passages it appears in; ties break by name); an edge links two kept entities that share **at least 2 passages** (weight = shared count, `firstChunkId` = first shared passage); keep the **40 strongest edges**; entities left with no edge are dropped; **fewer than 3 linked entities produces no map**.
- Widget `refs` carry at most **16** passages (loom-ui `MAX_WIDGET_REFS`).
- The document catalogue id becomes **`docmind.visuals.v3`**; `factFormatFingerprint()` changes.
- The chat catalogue `FACT_VISUALS_CATALOG` stays **byte-identical** (id `docmind.visuals.v1`; the sha256 guard `e9096cf41a01d1b87ef45b3eba3744600ae81e36d78fff476f6117f1455af080` in `packages/experiences/src/visuals.test.ts` stays unchanged and green).
- **One migration (0035)**, no new table (S7): it relaxes the two CHECKs of `visual_facts` (`visual_facts_kind_check` also allows `outline` and `cooccurrence`; `visual_facts_ordinal_check` allows 0..17). Migration 0026 is merged and never edited. Extraction keeps `MAX_FACTS` 16 at ordinals 0..15; structure facts take the reserved ordinals 16 (outline) and 17 (cooccurrence).
- **No model call** in c1 (S1). The planner sees capability descriptions only, never outline or entity text (spec §5).
- **Document visuals only** (S5): chat never offers or plans a structure widget.
- Structure facts are sealed per user like other facts: no plaintext in logs, the event log, or the `visual_facts` row.
- A passage or entity name that does not open skips that structure fact and the step continues; a key-store outage still fails the step.
- Verification commands (run from the worktree root `/Users/such/workspace/docmind/.worktrees/structure-c1`): `pnpm typecheck`, `pnpm typecheck:tests`, `pnpm lint`, `pnpm build`, and the suites named in each task. Postgres suites need `set -a; . ./.env; set +a` first (it sets `DOCMIND_TEST_PG_URL`); **a skipped pg test is not a pass**: check the vitest summary shows the pg tests ran, not "skipped".

## Plan decisions (where the spec is silent or the code constrains it)

Each is repeated as a "Plan decision:" next to the step that applies it.

- **Plan decision: ordinal space.** `visual_facts.ordinal` has `CHECK (ordinal BETWEEN 0 AND 15)` and `UNIQUE (tenant_id, document_id, ordinal)` (migration 0026), and extraction can fill all 16 (`MAX_FACTS`, unchanged). Migration 0035 (below) widens the ordinal CHECK to 0..17, and structure facts get **reserved ordinals: outline = 16, entity map = 17**. Extraction is NOT capped below 16. Reason: a collision would make one writer's insert fail or the other's replace delete the fact.
- **Plan decision: each writer owns a range.** `PgVisualFacts.replace` (extraction) now deletes and writes only ordinals `< 16`; the new `replaceStructure` deletes and writes only ordinals `>= 16`. Neither can wipe the other. Order in one run: extract, then structure, then load. On the re-plan path that skips extraction, extraction writes nothing and the structure step still re-derives and replaces. A legacy extracted fact cannot exist (extraction never wrote above 15 and 16..17 were not allowed before migration 0035), so `replaceStructure` never removes an extracted fact. Reason: spec 3 "Storage" demands the structure facts survive an extraction replace and be re-derived on a re-plan.
- **Plan decision: `list` stays extracted-only; `listAll` is new.** `list` (used by extract's re-plan check and by chat) filters structure kinds out, so chat can never see a structure fact (S5) and extract's "stored facts" check ignores them. `listAll` (used by the load step and the UI reader that serves `visual.facts`) returns everything in ordinal order.
- **Plan decision: migration 0035 (the `kind` and `ordinal` CHECKs).** Migration 0026 declared `kind` and `ordinal` with inline, unnamed CHECKs, so Postgres named them `visual_facts_kind_check` (`kind IN ('series','figure','factTable')`) and `visual_facts_ordinal_check` (`ordinal BETWEEN 0 AND 15`). Controller ruling: structure facts are stored as their own kinds, not as `factTable`, and extraction is not cut. `infra/migrations/0035_visual_facts_structure_kinds.sql` drops both constraints and re-adds them under the same names: `kind IN ('series','figure','factTable','outline','cooccurrence')` and `ordinal BETWEEN 0 AND 17`, in one migration (one transaction). No data changes; the `UNIQUE (tenant_id, document_id, ordinal)` is untouched. The sealed fact's own `kind` is still authoritative; the column now also agrees with it.
- **Plan decision: fact shapes.** `outline`: `{ kind, title (1..80), nodes[3..120] of { label (1..80), level (1..32), passageCount (0..100000), firstChunkId (uuid) }, chunkIds[1..120] }`, nodes in document (pre-)order with `level` encoding the tree (a node's parent is the nearest earlier node of `level - 1`). `cooccurrence`: `{ kind, entities[3..20] of { name (1..80), entityKind (the six entity kinds), passages (1..100000) }, edges[2..40] of { a, b (indexes into entities, a < b), weight (2..100000), firstChunkId (uuid) }, chunkIds[1..40] }`. Both `.strict()`. The shared `ChunkIds` cap of 8 does not apply to them.
- **Plan decision: root does not count toward the 120.** 120 heading nodes plus the title root (121 diagram nodes, under loom-ui's 200). The spec says "Cap: 120 nodes" and "the root is the document title" without saying which; counting headings keeps the cap meaning "sections".
- **Plan decision: pruning.** Whole deepest levels are removed while over 120 (never below level 1); if level 1 alone exceeds 120, the first 120 in document order are kept and the rest dropped (their count would fold into the root, which stores none). If fewer than 3 nodes remain after pruning there is no outline. Heading depth is clamped to 32.
- **Plan decision: what is a distinct heading.** Passages carry `section_ordinal` (plaintext) and a sealed `headingPath`. A new `section_ordinal` starts a new section: its ancestors reuse the open path when the text matches, and its **leaf is always a new node** (that is how a duplicate heading under one parent stays separate). A section with an empty heading path (text before the first heading) makes no node. A heading with no text becomes "Untitled section"; an empty document title becomes "Untitled document". `passageCount` = the passages of that section plus folded descendants; an ancestor node that has no section of its own gets `firstChunkId` of its first descendant passage and count 0.
- **Plan decision: entity candidates query.** SQL ranks this document's entities by passage count and returns those with `rank() <= 20` (so ties at the boundary are included), capped at 200 rows, so names are opened only for those few; the pure `topEntities` then sorts by count desc, name, id and keeps 20. A second index-bound query reads the kept entities' passages. Reason: ties break by decrypted name, which SQL cannot do, but a library-sized or document-sized name decrypt must be avoided.
- **Plan decision: unreadable means null.** The reader returns `null` for the whole kind when any heading passage, the title, or any candidate name fails to open (a non-key-store failure); the step then skips that one fact. A `FieldKeyStoreError` is rethrown, so the step fails and retries (STEP_RETRY).
- **Plan decision: step position and flow identity.** `visualize-structure` runs only when extraction did not end `skipped` (role off means no planner either). It is a plain `STEP_RETRY` step (no model). The facts present for the zero-fact rule are `extracted.count + structured.count`. The step list is part of the flow identity, so the flow version moves to `1.1.0` (the identity test is updated). **Deploy behaviour of in-flight runs.** Loom's flow hash covers the flow id and version, and pinned resumption resumes an execution only on the registered version whose hash matches the one recorded at its start (ADR 0023 K11.2); a build that registers only 1.1.0 would throw `FlowCodeMismatchError` for every `visualize-document` execution started on 1.0.0, and a changed step list would also trip replay-divergence detection (ADR 0113). Chat handled its 1.0.0 to 1.1.0 bump (docs/specs rolling-summary spec section 3, commit 0d6932b) by keeping 1.0.0 registered unchanged and registering 1.1.0 after it (Loom treats the last-registered version of an id as current). This plan does the same: `visualizeDocumentFlow(planner, { legacy: true })` builds the 1.0.0 definition (steps extract, load, commit; its runner never calls the structure step), `visualize` in `compose.ts` gains `legacyFlow`, and `buildApp` (`config.ts`) registers it BEFORE the 1.1.0 flow, so runs in flight at deploy finish on 1.0.0 (they simply have no structure facts; the next re-plan or retry, or the stale-format re-plan that the v3 catalogue triggers, adds them) and every new run starts on 1.1.0. Without the legacy runner a 1.0.0 execution would be replayed through the new runner and ask for a `visualize-structure` step its log never recorded. Task 3 step 15b does this and tests it (registration order, different hashes, a 1.0.0 run finishes without a structure step). 1.0.0 can be removed once no 1.0.0 `visualize-document` execution is live. Do not roll back past this release.
- **Plan decision: citation order.** `chunkIds` are ordered so the 16 refs are the most useful: the outline cites top-level sections first (level ascending, then document order); the map cites its strongest pairs first (weight desc).
- **Plan decision: planner sample.** A structure capability's `sampleOutput` is a content-free count shape (`{ kind: "outline", sections, levels }`, `{ kind: "cooccurrence", entities, links }`) and its description states only counts, because the existing fact `sampleOutput` is the fact itself and would put heading and entity text in the planner prompt (spec §5).
- **Plan decision: fingerprint.** `factFormatFingerprint()` gains a `+docmind.structure@1` suffix (`STRUCTURE_FORMAT`) instead of bumping `PINS["visual.facts"]`. Reason: stored chat heads carry `docmind:visual.facts@1#...` pins that `factRefOfPin` must keep parsing; a pin bump would silently drop old chat widgets.
- **Plan decision: chat adoption.** The turn path of `adoptVisuals` gets its own entry set (the four fact entries), so even a hand-made chat head with `DocumentOutline` is dropped.
- **Plan decision: e2e entities.** Ingest is keyless in `startIngestStack`, so no entities are extracted at upload. The e2e seeds entities with `PgEntityStore.replaceForDocument` after the first run, then re-plans through `POST /api/documents/:id/visuals/retry` (which is also the extraction-skipping path the spec requires to re-derive).

## File Structure

Created (server, `apps/server/app/flows/visualize-document/`):
- `structureText.ts`, `clipText`, `clipLabel`, `MAX_STRUCTURE_LABEL`.
- `outline.ts`, pure `buildOutline` and its constants/types.
- `cooccurrence.ts`, pure `topEntities`, `buildCooccurrence` and types.
- `structure.ts`, the `StructureReader` interface and the `visualize-structure` step effect.
- `pgStructure.ts`, `PgStructureReader` (owner-scoped, index-bound queries, opens sealed fields).
- Tests beside each (`*.test.ts`, `*.pg.test.ts`).

Created (experiences, `packages/experiences/src/`): `structureShapes.ts` (the two `DiagramValue` builders) and `structureShapes.test.ts`.

Modified: `facts.ts`, `pgFacts.ts`, `plan.ts`, `flow.ts`, `deps.ts`, `extract.ts` (server visualize-document); `visualize-turn/{deps,steps}.ts` (narrowed store type); `ui/readers.ts`; `compose.ts`; `security.ts`; `packages/experiences/src/{visuals,providers,views}.ts` and their tests; `docs/architecture.md`, `docs/specs/2026-11-08-document-visuals-design.md`.

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
    - `export interface OutlineNode { label: string; level: number; passageCount: number; firstChunkId: string }`
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
  const out: OutlineNode[] = live.map((n) => ({
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

  it("keeps the 40 strongest of up to 190 edges, strongest first, and cites each firstChunkId once", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => cand(i, `E${String(i).padStart(2, "0")}`, 5));
    // Every entity appears in passages 1..5, so all 190 pairs share 5 passages; a 6th passage links E00-E01 only.
    const m = twenty.flatMap((_, i) => appear(i, 1, 2, 3, 4, 5));
    m.push(...appear(0, 6), ...appear(1, 6));
    const r = buildCooccurrence(twenty.map((e, i) => (i < 2 ? { ...e, passages: 6 } : e)), m);
    expect(r?.edges).toHaveLength(40);
    expect(r?.edges[0]).toMatchObject({ a: 0, b: 1, weight: 6 });
    expect(r?.chunkIds).toEqual([...new Set(r?.edges.map((e) => e.firstChunkId))]);
    expect(r?.chunkIds.length).toBeLessThanOrEqual(40);
  });

  it("orders the cited passages by edge strength", () => {
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
- Modify: `apps/server/app/flows/visualize-turn/deps.ts`, `apps/server/app/flows/visualize-turn/steps.ts`, `apps/server/app/ui/readers.ts`, `apps/server/app/compose.ts`, `apps/server/app/security.ts`, `packages/experiences/src/visuals.ts` and `index.ts` (types, description and sample only: step 12b)
- Test: `facts.test.ts`, `pgFacts.pg.test.ts`, `structure.test.ts`, `pgStructure.pg.test.ts`, `flow.test.ts`, `plan.test.ts` (existing stubs), `security.test.ts`

**Interfaces:**
- Consumes (Tasks 1 and 2): `OutlineDraft`, `HeadingRow`, `buildOutline`, `outlineTitle` from `./outline`; `CooccurrenceDraft`, `EntityCandidate`, `Mention`, `topEntities`, `buildCooccurrence`, `MAX_MAP_ENTITIES`, `MIN_LINKED` from `./cooccurrence`.
- Produces:
  - `facts.ts`: `STRUCTURE_ORDINAL_BASE = 16`, `OUTLINE_ORDINAL = 16`, `ENTITY_MAP_ORDINAL = 17`; `type StructureFact = (OutlineDraft | CooccurrenceDraft) & { ordinal: number }`; `type AnyFact = Fact | StructureFact`; `StoredEntry` (zod discriminated union of the five kinds + ordinal); `isStructureFact(f: { kind: string }): f is StructureFact`; `admit` unchanged (still capped at `MAX_FACTS` 16).
  - `pgFacts.ts` `VisualFactStore`: `replace(ref, facts: readonly Fact[], signal?): Promise<number>` (owns ordinals < 16), `replaceStructure(ref, facts: readonly StructureFact[], signal?): Promise<number>` (owns ordinals >= 16), `list(ref): Promise<Fact[]>` (extracted only), `listAll(ref): Promise<AnyFact[]>`.
  - `structure.ts`: `interface StructureReader { title(ref: VisualizeRef): Promise<string | null>; headings(ref): Promise<HeadingRow[] | null>; entities(ref): Promise<EntityCandidate[] | null>; mentions(ref, entityIds: readonly string[]): Promise<Mention[]> }`; `structureEffect(deps: StructureDeps): Effect<VisualizeRef, StepResult>`; `StructureDeps`.
  - `pgStructure.ts`: `class PgStructureReader implements StructureReader` (`constructor(pool: Pool, fields: FieldCrypto)`), `HEADINGS_SQL`, `CANDIDATES_SQL`, `MENTIONS_SQL`, `ENTITY_CANDIDATE_CAP = 200`.
  - `flow.ts`: `visualizeStructureStep` (id `visualize-structure`), `VISUALIZE_STEPS` = extract, structure, load, commit; flow version `1.1.0`.
  - `deps.ts`: `VisualizeDeps.structure: StructureReader`; effect `"visualize-structure"`.
  - `plan.ts`: `LoadOutput.facts` is `z.array(StoredEntry).max(16)`; `planVisuals(planner, facts: readonly AnyFact[], ctx)`; `loadEffect` reads `facts.listAll`.

#### 3a. Fact kinds and the admit cap

- [ ] **Step 1: Write the failing tests**, append to `apps/server/app/flows/visualize-document/facts.test.ts` (add the new imports to the existing import line from `./facts`: `ENTITY_MAP_ORDINAL, MAX_FACTS, OUTLINE_ORDINAL, StoredEntry, isStructureFact`; and add `import { buildCooccurrence, topEntities } from "./cooccurrence"; import { buildOutline } from "./outline";`):

```ts
describe("structure facts", () => {
  const cid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const outline = buildOutline("Report", [
    { chunkId: cid(1), sectionOrdinal: 1, headingPath: ["A"] },
    { chunkId: cid(2), sectionOrdinal: 2, headingPath: ["B"] },
    { chunkId: cid(3), sectionOrdinal: 3, headingPath: ["B", "C"] },
  ]);
  const eid = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
  const cands = [1, 2, 3].map((n) => ({
    id: eid(n),
    kind: "person" as const,
    name: `P${n}`,
    passages: 2,
  }));
  const map = buildCooccurrence(
    topEntities(cands),
    cands.flatMap((c) => [1, 2].map((o) => ({ entityId: c.id, chunkId: cid(o), ordinal: o }))),
  );

  it("reserves ordinals 16 and 17 above the 16 extracted ones", () => {
    expect([MAX_FACTS, OUTLINE_ORDINAL, ENTITY_MAP_ORDINAL]).toEqual([16, 16, 17]);
  });

  it("a built outline and a built map parse as stored facts and are structure facts", () => {
    expect(outline).not.toBeNull();
    expect(map).not.toBeNull();
    const o = StoredEntry.parse({ ...outline, ordinal: OUTLINE_ORDINAL });
    const m = StoredEntry.parse({ ...map, ordinal: ENTITY_MAP_ORDINAL });
    expect(isStructureFact(o) && isStructureFact(m)).toBe(true);
    expect(isStructureFact(StoredEntry.parse({ ...FIGURE_FACT, ordinal: 0 }))).toBe(false);
  });

  it("refuses an unknown key, too few nodes, an over-long label and a bad index", () => {
    const base = { ...outline, ordinal: 16 };
    expect(StoredEntry.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(StoredEntry.safeParse({ ...base, nodes: base.nodes?.slice(0, 2) }).success).toBe(false);
    expect(
      StoredEntry.safeParse({ ...base, nodes: [{ ...base.nodes?.[0], label: "x".repeat(81) }, ...(base.nodes ?? []).slice(1)] })
        .success,
    ).toBe(false);
    const m = { ...map, ordinal: 17 };
    expect(StoredEntry.safeParse({ ...m, entities: m.entities?.slice(0, 2) }).success).toBe(false);
  });

  it("admit stops at the cap it is given, and defaults to 16", () => {
    const fig = { kind: "figure", label: "x", value: 5, chunkIds: [C1] } as const;
    const texts = text("five 5");
    const ids = new Set([C1]);
    expect(admit(Array(20).fill(fig), texts, ids).facts.map((f) => f.ordinal)).toEqual(
      Array.from({ length: 16 }, (_, i) => i),
    );
    expect(admit(Array(20).fill(fig), texts, ids).facts).toHaveLength(16);
  });
});

const FIGURE_FACT = { kind: "figure", label: "x", value: 1, chunkIds: [C1] } as const;
```

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

Keep `export const MAX_FACTS = 16;` and add after it:

```ts
/** What a chat turn keeps (turn facts have their own table). */
export const MAX_FACTS = 16;
/**
 * Extraction keeps `MAX_FACTS` (16) facts at ordinals 0..15. `visual_facts.ordinal` is 0..17 after migration 0035, and 16 and 17
 * are reserved for the derived structure facts, which are written by their own step and never collide with an extracted fact.
 */
export const STRUCTURE_ORDINAL_BASE = 16;
export const OUTLINE_ORDINAL = 16;
export const ENTITY_MAP_ORDINAL = 17;
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
/** A stored row of any kind. `StoredFact` (extracted kinds only) stays what chat reads. */
export const StoredEntry = z.discriminatedUnion("kind", [
  Series.extend(Ordinal.shape),
  Figure.extend(Ordinal.shape),
  FactTable.extend(Ordinal.shape),
  Outline.extend(Ordinal.shape),
  EntityMap.extend(Ordinal.shape),
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
    const ref = await fx.doc("a".repeat(64));
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

- [ ] **Step 5: Write the failing pg tests**, append inside the `describe.skipIf(!PG_URL)` block of `apps/server/app/flows/visualize-document/pgFacts.pg.test.ts` (add `import { ENTITY_MAP_ORDINAL, OUTLINE_ORDINAL, type StructureFact } from "./facts";` merged with the existing `import type { Fact }` line):

```ts
  const outlineFact = (chunk: string): StructureFact => ({
    kind: "outline",
    title: "Zebra-Secret-Title",
    nodes: ["Zebra-Heading-A", "Zebra-Heading-B", "Zebra-Heading-C"].map((label) => ({
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
    const ref = await fx.doc("5".repeat(64));
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
    const ref = await fx.doc("6".repeat(64));
    const chunk = await seedChunk(ref);
    const store = new PgVisualFacts(fx.app, fx.fields);
    await store.replace(ref, [fig(0, chunk)]);
    await store.replaceStructure(ref, [outlineFact(chunk)]);
    expect((await store.list(ref)).map((f) => f.kind)).toEqual(["figure"]);
  });

  it("refuses a fact outside the writer's ordinal range", async () => {
    const ref = await fx.doc("7".repeat(64));
    const chunk = await seedChunk(ref);
    const store = new PgVisualFacts(fx.app, fx.fields);
    await expect(store.replace(ref, [fig(16, chunk)])).rejects.toThrow(/ordinals below 16/);
    await expect(
      store.replaceStructure(ref, [{ ...outlineFact(chunk), ordinal: 3 }]),
    ).rejects.toThrow(/ordinals 16 and 17/);
  });

  it("stores structure facts sealed, with their own column kind (migration 0035), owner-scoped", async () => {
    const ref = await fx.doc("8".repeat(64));
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
  type Fact,
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
/** The `kind` column carries the fact's own kind (migration 0035 widened its CHECK); the sealed fact's `kind` is still what readers use. */
const columnKind = (f: AnyFact): string => f.kind;

export class PgVisualFacts implements VisualFactStore {
  constructor(
    private readonly pool: Pool,
    private readonly fields: FieldCrypto,
  ) {}

  replace(ref: VisualizeRef, facts: readonly Fact[], signal?: AbortSignal): Promise<number> {
    if (facts.some((f) => f.ordinal >= STRUCTURE_ORDINAL_BASE))
      throw new Error("extracted facts use ordinals below 16");
    return this.write(ref, facts, "ordinal < $2", signal);
  }

  replaceStructure(
    ref: VisualizeRef,
    facts: readonly StructureFact[],
    signal?: AbortSignal,
  ): Promise<number> {
    if (facts.some((f) => f.ordinal < STRUCTURE_ORDINAL_BASE || f.ordinal > 17))
      throw new Error("structure facts use ordinals 16 and 17");
    return this.write(ref, facts, "ordinal >= $2", signal);
  }

  private async write(
    ref: VisualizeRef,
    facts: readonly AnyFact[],
    range: string,
    signal?: AbortSignal,
  ): Promise<number> {
    // Sealing may call the key store: do it before the transaction, never under row locks.
    const cipher = this.fields.forUser(ref.userId);
    const rows = await Promise.all(
      facts.map(async (f) => {
        const id = randomUUID();
        return {
          id,
          kind: columnKind(f),
          ordinal: f.ordinal,
          chunkIds: f.chunkIds,
          sealed: JSON.stringify(await cipher.seal(factBind(id), f)),
        };
      }),
    );
    await withTenant(this.pool, ref.tenantId, async (tx) => {
      await lockDocument(tx, ref);
      await tx.query(`DELETE FROM visual_facts WHERE document_id = $1 AND ${range}`, [
        ref.documentId,
        STRUCTURE_ORDINAL_BASE,
      ]);
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
        "SELECT id, fact_enc FROM visual_facts WHERE document_id = $1 AND owner_id = $2 ORDER BY ordinal",
        [ref.documentId, ref.userId],
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

Note the `DELETE` binds `$2` in both ranges; `$1` is the document.

Narrow what chat and the UI reader need, so their test stubs and the store's growth stay decoupled:

- `apps/server/app/flows/visualize-turn/deps.ts`: change `stored: VisualFactStore;` to `stored: Pick<VisualFactStore, "list">;`
- `apps/server/app/flows/visualize-turn/steps.ts`: change line 28 `facts: VisualFactStore;` to `facts: Pick<VisualFactStore, "list">;` and line 141 `stored: VisualFactStore;` to `stored: Pick<VisualFactStore, "list">;`
- `apps/server/app/flows/visualize-document/extract.ts`: change `facts: VisualFactStore;` (line 44) to `facts: Pick<VisualFactStore, "replace" | "list">;`
- `apps/server/app/ui/readers.ts`: change `visualFacts: VisualFactStore;` to `visualFacts: Pick<VisualFactStore, "listAll">;` and in `visualFacts({ id })` replace `await deps.visualFacts.list({` with `await deps.visualFacts.listAll({`.

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
import { T1, U1, U1B } from "../../documents/testHarness";
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
    expect(typeof (await reader().title(ref))).toBe("string");
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
    expect(mentions.map((m) => [m.entityId === acme ? "acme" : "bolt", m.ordinal])).toEqual([
      ["acme", 0],
      ["acme", 1],
      ["bolt", 1],
      ["acme", 2],
      ["bolt", 2],
    ]);
    expect(mentions.every((m) => m.chunkId.length === 36)).toBe(true);
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
  "the co-occurrence queries on about 500 documents (needs DOCMIND_TEST_PG_URL)",
  () => {
    let fx: PgFixture;
    let selfId: string;
    beforeAll(async () => {
      fx = await startPgFixture();
      const c = await fx.db.owner.connect();
      try {
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
             FROM documents d CROSS JOIN generate_series(0, 3) o`,
        );
        await c.query(
          `INSERT INTO entities (id, tenant_id, owner_id, kind, name_enc, name_key)
           SELECT gen_random_uuid(), $1::uuid, $2::uuid, 'organization', '{"x":1}'::jsonb, lpad(to_hex(g), 64, '0')
             FROM generate_series(1, 200) g`,
          [T1, U1],
        );
        await c.query(`CREATE TEMP TABLE seed_chunks AS
          SELECT tenant_id, id, row_number() OVER (ORDER BY id) AS rn FROM chunks`);
        await c.query(`CREATE TEMP TABLE seed_entities AS
          SELECT id, row_number() OVER (ORDER BY id) AS rn FROM entities`);
        await c.query(`INSERT INTO chunk_entities (tenant_id, chunk_id, entity_id)
          SELECT c.tenant_id, c.id, e.id FROM seed_chunks c JOIN seed_entities e ON e.rn = (c.rn % 200) + 1`);
        // This document names 50 entities; a hub entity is on every chunk of the library.
        await c.query(
          `INSERT INTO chunk_entities (tenant_id, chunk_id, entity_id)
           SELECT mc.tenant_id, mc.id, e.id
             FROM (SELECT id, tenant_id FROM documents ORDER BY id LIMIT 1) d
             JOIN chunks mc ON mc.document_id = d.id
             JOIN seed_entities e ON e.rn <= 50 AND e.rn % 4 = mc.ordinal
           ON CONFLICT DO NOTHING`,
        );
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
      "Index Cond"?: string;
      "Actual Loops"?: number;
      Plans?: PlanNode[];
    };
    const walk = (n: PlanNode): PlanNode[] => [n, ...(n.Plans ?? []).flatMap(walk)];
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
    const BIG = ["chunks", "chunk_entities", "documents", "entities"];
    const LIBRARY = 500;

    async function expectBound(sql: string, params: unknown[]) {
      const { nodes, ms } = await explain(sql, params);
      expect(
        nodes
          .filter((n) => n["Node Type"] === "Seq Scan")
          .map((n) => n["Relation Name"])
          .filter((r) => r !== undefined && BIG.includes(r)),
      ).toEqual([]);
      // chunk_entities is reached only by an index on its chunk (primary key leads with tenant, chunk)
      const ce = nodes.filter(
        (n) => n["Relation Name"] === "chunk_entities" && /Scan/.test(n["Node Type"]),
      );
      expect(ce.length).toBeGreaterThan(0);
      for (const n of ce) {
        expect(n["Node Type"]).toMatch(/^Index/);
        expect(n["Index Cond"] ?? "").toMatch(/chunk_id/);
      }
      expect(nodes.filter((n) => (n["Actual Loops"] ?? 0) >= LIBRARY)).toEqual([]);
      expect(ms).toBeLessThan(2000);
    }

    it("the candidates query walks out from this document and never scans the library", async () => {
      await expectBound(CANDIDATES_SQL, [U1, selfId, 20, 200]);
    });
    it("the mentions query walks out from this document and never scans the library", async () => {
      const ids = (
        await withTenant(fx.app, T1, async (tx) =>
          tx.query<{ entity_id: string }>(CANDIDATES_SQL, [U1, selfId, 20, 200]),
        )
      ).rows.map((r) => r.entity_id);
      await expectBound(MENTIONS_SQL, [U1, selfId, ids]);
    });
    it("returns only this document's rows", async () => {
      const rows = await withTenant(fx.app, T1, async (tx) =>
        tx.query<{ n: number }>(CANDIDATES_SQL, [U1, selfId, 20, 200]),
      );
      // This document has 4 chunks: no entity can be in more than 4 of its passages, whatever the library says of the hub.
      expect(rows.rows.length).toBeGreaterThan(0);
      expect(Math.max(...rows.rows.map((r) => r.n))).toBeLessThanOrEqual(4);
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

/** $1 document, $2 owner. Each passage's section (plaintext) and sealed text; `owned` is false when the document is not the owner's. */
export const HEADINGS_SQL = `SELECT o.owned, c.id, c.section_ordinal, c.text_enc
   FROM (SELECT EXISTS (SELECT 1 FROM documents d WHERE d.id = $1 AND d.owner_id = $2) AS owned) o
   LEFT JOIN chunks c ON o.owned AND c.document_id = $1
  ORDER BY c.ordinal`;

/**
 * $1 owner, $2 document, $3 rank limit, $4 row cap. The owner's entities of THIS document's passages: the document, its
 * chunks (`chunks_document_ordinal_key`), their `chunk_entities` rows (the primary key leads with the chunk), counted per
 * entity, ranked by that count; the entity row is read by key only for the ranked few. MATERIALIZED so the planner cannot
 * reorder it into a scan of the owner's library. `rank()` keeps every entity tied with the last wanted one, so a tie at the
 * boundary is broken by name later (names are sealed, SQL cannot), and the cap bounds a document full of equal entities.
 */
export const CANDIDATES_SQL = `WITH counted AS MATERIALIZED (
  SELECT ce.tenant_id, ce.entity_id, count(*)::int AS n
    FROM documents d
    JOIN chunks c ON c.tenant_id = d.tenant_id AND c.document_id = d.id
    JOIN chunk_entities ce ON ce.tenant_id = c.tenant_id AND ce.chunk_id = c.id
   WHERE d.id = $2 AND d.owner_id = $1
   GROUP BY ce.tenant_id, ce.entity_id),
ranked AS MATERIALIZED (
  SELECT k.tenant_id, k.entity_id, k.n, rank() OVER (ORDER BY k.n DESC) AS r FROM counted k)
SELECT en.id AS entity_id, en.kind, en.name_enc, k.n
  FROM ranked k
  JOIN entities en ON en.tenant_id = k.tenant_id AND en.id = k.entity_id AND en.owner_id = $1
 WHERE k.r <= $3
 ORDER BY k.n DESC, en.id
 LIMIT $4`;

/** $1 owner, $2 document, $3 entity ids. The kept entities' passages in this document, in passage order. */
export const MENTIONS_SQL = `SELECT ce.entity_id, ce.chunk_id, c.ordinal
   FROM documents d
   JOIN chunks c ON c.tenant_id = d.tenant_id AND c.document_id = d.id
   JOIN chunk_entities ce ON ce.tenant_id = c.tenant_id AND ce.chunk_id = c.id
  WHERE d.id = $2 AND d.owner_id = $1 AND ce.entity_id = ANY($3::uuid[])
  ORDER BY c.ordinal, ce.entity_id`;

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
        "SELECT title_enc FROM documents WHERE id = $1 AND owner_id = $2",
        [ref.documentId, ref.userId],
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
      }>(HEADINGS_SQL, [ref.documentId, ref.userId]);
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
        [ref.userId, ref.documentId, MAX_MAP_ENTITIES, ENTITY_CANDIDATE_CAP],
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
        [ref.userId, ref.documentId, [...entityIds]],
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
Expected: PASS, none skipped. If the explain test reports a Seq Scan on a big table, fix the query shape (keep each CTE MATERIALIZED and keyed on the document), do not loosen the assertion.

#### 3c-bis. Let experiences accept the structure kinds (types, description, content-free sample)

The flow now loads facts of five kinds, and `visualCapabilities` takes `VisualFactRaw[]`, so the experiences types must know the new kinds before the server typechecks. This is the type-and-capability half of the catalogue change; the catalogue entries, reshapers and fingerprint follow in Task 4.

- [ ] **Step 12b: Extend `VisualFactRaw`, `describeFact` and the planner sample** in `packages/experiences/src/visuals.ts`.

Replace the `VisualFactRaw` type with the exported members plus the two new ones (keep the three existing members' fields exactly as they are today):

```ts
export interface OutlineFact {
  kind: "outline";
  title: string;
  nodes: { label: string; level: number; passageCount: number; firstChunkId: string }[];
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

Replace `describeFact` and the `sampleOutput` line of `capability` (Plan decision: a structure capability shows counts only, because the existing `sampleOutput: f` would put heading and entity text in the planner prompt, which spec 5 forbids):

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
/** What the planner is shown of a fact: extracted facts show themselves; a structure fact shows counts only. */
const sampleOf = (f: VisualFactRaw): unknown =>
  f.kind === "outline"
    ? { kind: "outline", sections: f.nodes.length, levels: depthOf(f) }
    : f.kind === "cooccurrence"
      ? { kind: "cooccurrence", entities: f.entities.length, links: f.edges.length }
      : f;
```
and in `capability(...)` use `sampleOutput: sampleOf(f),`. Export `OutlineFact` and `EntityMapFact` from `packages/experiences/src/index.ts` next to `VisualFactRaw`.

Run: `pnpm --filter @docmind/experiences typecheck && pnpm --filter @docmind/experiences exec vitest run src/visuals.test.ts`
Expected: PASS (nothing existing changes for the extracted kinds).

#### 3d. The step in the flow, both paths

- [ ] **Step 13: Write the failing unit tests**, create `apps/server/app/flows/visualize-document/structure.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
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
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await setup().run();
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain("Zebra");
    expect(logged).not.toContain("Person1");
  });
});
```

Add to `apps/server/app/flows/visualize-document/flow.test.ts`:

1. In the `stack` function, add the structure reader and the store methods. Replace the `facts:` stub with:

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
declare `let structured: StructureFact[] = [];` beside `let held: Fact[] = [];`, add `structure?: StructureReader` to the `o` options type of `stack(...)`, import `type StructureFact` (from `./facts`), `type StructureReader` (from `./structure`) and `noStructure` (from `./testing`), and return `structured: () => structured` from `stack`.

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

3. Update the identity test (`pins its identity`): `expect(flow.definition.version).toBe("1.1.0");` and the step ids to `["visualize-extract", "visualize-structure", "visualize-load", "visualize-commit"]`, add `visualizeStructureStep` to the imports and `expect(visualizeStructureStep.retry).toEqual(STEP_RETRY);`.

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
import { type AnyFact, StoredEntry } from "./facts";
```
(remove `MAX_FACTS, StoredFact, type Fact` from that import), then:

```ts
export const LoadOutput = z
  .object({
    outcome: z.enum(["done", "document_gone", "failed"]),
    code: z.enum(FAILURE_CODES).optional(),
    // The extracted facts (up to 16) and the structure facts (up to 2): at most 18 rows, ordinals 0..17.
    facts: z.array(StoredEntry).max(18),
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

`flow.ts`, add the step, the order, the version and the run logic:

```ts
export const visualizeStructureStep = step$({
  id: "visualize-structure",
  name: "VisualizeStructure",
  inputSchema: VisualizeInput,
  outputSchema: StepResult,
  retry: STEP_RETRY, // no model: it reads this document and derives
});
```
`export const VISUALIZE_STEPS = [visualizeExtractStep, visualizeStructureStep, visualizeLoadStep, visualizeCommitStep];`
In `runVisualize` replace the block from `if (extracted.model === "none")` through the `extracted.count === 0 &&` condition with:

```ts
    if (extracted.model === "none") return { outcome: "skipped" };
    // The structure facts are derived on every run (a re-plan that skips extraction included): no model, this document only.
    const structured = await ctx.run(visualizeStructureStep, input);
    if (structured.outcome !== "done") return { outcome: structured.outcome };
    // No facts at all (none extracted and none derived): there is nothing to load, but the connections are live data, so
    // the planner still runs, offered only the connections capability.
    const stored = (extracted.count ?? 0) + (structured.count ?? 0);
    let facts: LoadOutput["facts"] = [];
    if (stored !== 0) {
      const loaded = await ctx.run(visualizeLoadStep, input);
      if (loaded.outcome !== "done") return { outcome: loaded.outcome };
      facts = loaded.facts;
    }
```
and change the later `extracted.count === 0 &&` to `stored === 0 &&`. Update the doc comment above `runVisualize` to read: `extract (model, facts stored sealed) -> structure (derived outline and entity map, no model) -> load (...)`. Bump `version: "1.1.0"` (see the Plan decision on in-flight runs: keep 1.0.0 registered, below) and update the `byOrdinal` typing is inferred (`LoadOutput["facts"]` entries are `AnyFact`-compatible).

`compose.ts`, add `import { PgStructureReader } from "./flows/visualize-document/pgStructure";` beside the other visualize imports and in the `visualize.deps` object after `facts: new PgVisualFacts(pool, fields),` add `structure: new PgStructureReader(pool, fields),`.

Every other constructor of `VisualizeDeps` in tests (`start.test.ts`, `recovery.test.ts`, `runs.pg.test.ts`, `flow.test.ts`) gets `structure: noStructure()` and, where the `facts` stub is hand-written, `replaceStructure: async () => 0, listAll: async () => []`. `pnpm typecheck:tests` lists each one.

- [ ] **Step 15b: Keep 1.0.0 registered (in-flight runs at deploy).** In `flow.ts` make `runVisualize(planner, withStructure = true)` skip the structure branch when `withStructure` is false, and `visualizeDocumentFlow(planner, o: { legacy?: boolean } = {})` return, for `legacy`, `version: "1.0.0"`, `steps: [visualizeExtractStep, visualizeLoadStep, visualizeCommitStep]` and `runVisualize(planner, false)`. In `compose.ts` set `visualize.legacyFlow = visualizeDocumentFlow(() => planner, { legacy: true })`; in `config.ts` add `legacyFlow?: RegisteredFlow` to the `visualize` dep type and register `...(deps.visualize?.legacyFlow ? [deps.visualize.legacyFlow] : [])` immediately BEFORE `deps.visualize.flow` in `flows` (Loom treats the last-registered version of an id as current, as for chat 1.0.0/1.1.0 in `chats/wiring.ts`). `start.ts` keeps starting by the 1.1.0 flow value. Tests: in `flow.test.ts` assert the two definitions have different `flowHash`es (or ids+versions) and in `config.test.ts` (or the nearest test of the flows list) that `legacyFlow` precedes `flow`; run a 1.0.0 execution to completion and assert it writes no structure fact and records no `visualize-structure` step. Expected: PASS.

- [ ] **Step 16: Run to verify pass**

Run:
```
pnpm --filter @docmind/server exec vitest run app/flows/visualize-document app/flows/visualize-turn app/ui app/security.test.ts
set -a; . ./.env; set +a; pnpm --filter @docmind/server exec vitest run app/flows/visualize-document app/ui
pnpm typecheck && pnpm typecheck:tests && pnpm lint
```
Expected: PASS everywhere, pg tests run (not skipped), typecheck clean.

- [ ] **Step 17: Commit**

```bash
git add apps/server/app infra/migrations/0035_visual_facts_structure_kinds.sql docs/codebase-guide.md
git commit -m "feat(visuals): structure facts (outline, co-occurrence), shared replace semantics and the visualize-structure step"
```

---

### Task 4: Catalogue v3, reshapers, fit, capabilities, fingerprint, intent

**Files:**
- Create: `packages/experiences/src/structureShapes.ts`, `packages/experiences/src/structureShapes.test.ts`
- Modify: `packages/experiences/src/visuals.ts`, `packages/experiences/src/providers.ts`, `packages/experiences/src/views.ts`
- Modify (server): `apps/server/app/flows/visualize-document/plan.ts` (the intent)
- Test: `packages/experiences/src/visuals.test.ts`, `packages/experiences/src/providers.test.ts`, `packages/experiences/src/views.test.ts` (existing), `apps/server/app/flows/visualize-document/{plan,fit}.test.ts`

**Interfaces:**
- Consumes: the stored shapes of Task 3 (structurally the same as `VisualFactRaw` members below); `diagramProblems`, `MAX_DIAGRAM_NODES` from `@loom-ui/core`.
- Produces:
  - `visuals.ts`: `VisualFactRaw` gains `OutlineFact = { kind: "outline"; title: string; nodes: { label: string; level: number; passageCount: number; firstChunkId: string }[]; chunkIds: string[]; ordinal: number }` and `EntityMapFact = { kind: "cooccurrence"; entities: { name: string; entityKind: string; passages: number }[]; edges: { a: number; b: number; weight: number; firstChunkId: string }[]; chunkIds: string[]; ordinal: number }` (both exported types, both also carrying `cites?`); catalogue entries `DocumentOutline` and `EntityMap` (kind `Diagram`); `VISUALS_CATALOG.id === "docmind.visuals.v3"`; `VisualEntry` includes both; reshaper families `visual-outline`, `visual-entitymap` (`${family}-${ordinal}` names in `VISUAL_SHAPES`); `fitsShape("DocumentOutline" | "EntityMap", fact)`.
  - `structureShapes.ts`: `outlineDiagram(f: OutlineFact): DiagramShape | null`, `entityMapDiagram(f: EntityMapFact): DiagramShape | null` where `DiagramShape = { layout: "tree" | "network"; nodes: DiagramNode[]; edges: DiagramEdge[] }` (null = does not fit).
  - `providers.ts`: `export const STRUCTURE_FORMAT = "docmind.structure@1"`; `factFormatFingerprint()` ends `+${STRUCTURE_FORMAT}`.

- [ ] **Step 1: Write the failing shape tests**, create `packages/experiences/src/structureShapes.test.ts`:

```ts
import { DiagramValue, MAX_DIAGRAM_NODES, diagramProblems } from "@loom-ui/core";
import { describe, expect, it } from "vitest";
import { entityMapDiagram, outlineDiagram } from "./structureShapes";
import type { EntityMapFact, OutlineFact } from "./visuals";

const cid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const node = (label: string, level: number, n = 1) => ({
  label,
  level,
  passageCount: 1,
  firstChunkId: cid(n),
});
const OUTLINE: OutlineFact = {
  kind: "outline",
  title: "Annual report",
  nodes: [node("Intro", 1), node("Methods", 1), node("Data", 2), node("Model", 2), node("Results", 1)],
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
  it("is a tree rooted at the document title, with parent to child edges and the level as the group", () => {
    const v = outlineDiagram(OUTLINE);
    expect(v?.layout).toBe("tree");
    expect(v?.nodes[0]).toEqual({ id: "root", label: "Annual report", group: "0", kind: "document" });
    expect(v?.nodes.map((n) => [n.label, n.group])).toEqual([
      ["Annual report", "0"],
      ["Intro", "1"],
      ["Methods", "1"],
      ["Data", "2"],
      ["Model", "2"],
      ["Results", "1"],
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
    expect(outlineDiagram({ ...OUTLINE, nodes: [node("Deep", 2), ...OUTLINE.nodes] })).toBeNull(); // first node is level 2
    expect(outlineDiagram({ ...OUTLINE, nodes: [node("A", 1), node("B", 3), node("C", 1)] })).toBeNull(); // a level is skipped
    const many = Array.from({ length: MAX_DIAGRAM_NODES }, (_, i) => node(`H${i}`, 1));
    expect(outlineDiagram({ ...OUTLINE, nodes: many })).toBeNull(); // the root makes 201
  });

  it("stays a valid tree at the 120-node cap", () => {
    const nodes = Array.from({ length: 120 }, (_, i) => node(`H${i}`, (i % 3) + 1 > 1 ? 2 : 1));
    const fixed = nodes.map((n, i) => (i === 0 ? { ...n, level: 1 } : n));
    const v = outlineDiagram({ ...OUTLINE, nodes: fixed });
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

Add to `packages/experiences/src/visuals.test.ts` (extend the existing import from `./visuals` with `type EntityMapFact, type OutlineFact`, and `refIdOf` is not needed):

```ts
describe("structure widgets", () => {
  const cid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const doc = "11111111-1111-4111-8111-111111111111";
  const OUTLINE: OutlineFact = {
    kind: "outline",
    title: "Zebra Report",
    nodes: ["Zebra-A", "Zebra-B", "Zebra-C"].map((label, i) => ({
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
    expect(fitsShape("EntityMap", { ...MAP, edges: [{ a: 0, b: 9, weight: 2, firstChunkId: cid(1) }] })).toBe(false);
    expect(fitsShape("FigureChart", OUTLINE)).toBe(false); // an outline fits no extracted-fact widget
    expect(fitsShape("KeyFigure", MAP)).toBe(false);
  });

  it("offers each structure fact as one capability with a content-free description and sample", () => {
    const caps = capabilitiesOf([OUTLINE, MAP]);
    expect(caps.map((c) => c.handle)).toEqual(["fact-16", "fact-17"]);
    expect(caps.map((c) => c.toolSchemaHash)).toEqual([
      `${PINS["visual.facts"]}#fact-16`,
      `${PINS["visual.facts"]}#fact-17`,
    ]);
    const text = JSON.stringify(caps);
    for (const secret of ["Zebra-A", "Zebra-Report", "Zebra Report", "Zebra-Ent"])
      expect(text, secret).not.toContain(secret);
    expect(caps[0]?.description).toBe("a tree of 3 sections, 1 level deep");
    expect(caps[1]?.description).toBe("3 named parties and 2 links between those that appear together");
    expect(caps.every((c) => c.sensitivity === "sensitive")).toBe(true);
  });

  it("a provider reads the fact by ordinal for either entry", () => {
    expect(factProvider(16, doc, "DocumentOutline").reshaping).toMatchObject({ scriptRef: "visual-outline-16" });
    expect(factProvider(17, doc, "EntityMap").reshaping).toMatchObject({ scriptRef: "visual-entitymap-17" });
    expect(Object.keys(VISUAL_SHAPES)).toContain("visual-outline-16");
    expect(Object.keys(VISUAL_SHAPES)).toContain("visual-entitymap-17");
  });
});
```

and in the existing "the fact catalogue (chat)" test change `expect(VISUALS_CATALOG.id).toBe("docmind.visuals.v2");` to `"docmind.visuals.v3"`, and in "resolves every entry on web and terminal" append to the expected list: `["DocumentOutline", "Diagram"], ["EntityMap", "Diagram"],`.

Add the chat guard's companion beside the existing sha256 test (the existing test stays exactly as is):

```ts
  it("keeps chat's id and entries even though the document catalogue grew", () => {
    expect(FACT_VISUALS_CATALOG.id).toBe("docmind.visuals.v1");
    expect(FACT_VISUALS_CATALOG.entries.map((e) => e.name)).toEqual([
      "FigureChart",
      "FigureTrend",
      "KeyFigure",
      "FactTable",
    ]);
  });
```

Replace the first test of `packages/experiences/src/providers.test.ts` with:

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
(keep the rest of the file; its second test still holds.)

Add a `views` test (in the existing `packages/experiences/src/views.test.ts`, following how it builds a visuals experience for `turnWithVisuals`/`detailWithVisuals`; copy the closest existing helper there and bind a node of type `DocumentOutline` to a provider pinned `docmind:visual.facts@1#<doc>/fact-16`): `detailWithVisuals` keeps the node under a `fact-16` provider reading `visual-outline-16`, and `turnWithVisuals` returns null for a head whose only node is a `DocumentOutline`.

Add to `apps/server/app/flows/visualize-document/flow.test.ts` (inside `describe("visualize-document flow", ...)`, using `STRUCTURE_READER` from Task 3) the tests that plan the outline:

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

Add to `apps/server/app/flows/visualize-document/plan.test.ts`:

```ts
describe("the intent", () => {
  it("tells the planner when to show the outline and the entity map, and when to leave them out", async () => {
    const { VISUALS_INTENT } = await import("./plan");
    expect(VISUALS_INTENT.objective).toContain("DocumentOutline");
    expect(VISUALS_INTENT.objective).toContain("EntityMap");
    expect(VISUALS_INTENT.objective).toMatch(/long, sectioned documents/);
    expect(VISUALS_INTENT.objective).toMatch(/short or flat documents/);
  });
});
```
and to `fit.test.ts` a test that `dropUnfittingOps` keeps a `DocumentOutline` node bound to an outline fact and drops it when bound to a figure (mirror the existing KeyFigure/series test there: build the ops with its `node(...)` helper using `type: "DocumentOutline"`, `capability` `fact-16`, and a `factOf` returning the outline fact or a figure).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @docmind/experiences exec vitest run src/structureShapes.test.ts src/visuals.test.ts src/providers.test.ts src/views.test.ts && pnpm --filter @docmind/server exec vitest run app/flows/visualize-document/plan.test.ts app/flows/visualize-document/fit.test.ts`
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
 * The document's sections as a tree: a root for the title, one node per section (group = its level), an edge from each
 * node's parent. The parent is the nearest earlier node one level up, so a first node below level 1 or a skipped level
 * does not fit. Labels are text only.
 */
export function outlineDiagram(f: OutlineFact): DiagramShape | null {
  const nodes: DiagramNode[] = [{ id: "root", label: f.title, group: "0", kind: "document" }];
  const edges: DiagramEdge[] = [];
  const open = ["root"]; // open[level] is the latest node id at that level
  for (const [i, n] of f.nodes.entries()) {
    const parent = open[n.level - 1];
    if (parent === undefined) return null;
    const id = `s${i}`;
    nodes.push({ id, label: n.label, group: String(n.level), kind: "section" });
    edges.push({ from: parent, to: id });
    open.length = n.level;
    open.push(id);
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
2. (Done in Task 3 step 12b: `OutlineFact`, `EntityMapFact`, the extended `VisualFactRaw`.)
3. `ENTRIES`: after `["ConnectionMap", "Diagram"],` add `["DocumentOutline", "Diagram"],` and `["EntityMap", "Diagram"],`.
4. `VISUALS_CATALOG` id: `"docmind.visuals.v3"`. Leave `FACT_ENTRY_NAMES`, `FACT_VISUALS_CATALOG` and the `catalogOf` helper untouched (the chat catalogue is built from the four fact names only, so its bytes do not change).
5. (Done in Task 3 step 12b: `describeFact`, `depthOf` and `sampleOf`.)
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
`refsOf` already caps at 16 distinct cites in the fact's order; `fitsShape` and `VISUAL_SHAPES` pick the entries up through `FAMILY`/`TO`.

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
- In `interface Adopt<R>` add `/** The catalogue entries this host draws. */ entries: ReadonlySet<string>;`
- In `adoptVisuals` change `!VISUAL_ENTRIES.has(n.type)` to `!o.entries.has(n.type)`.
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
git add packages/experiences apps/server/app/flows/visualize-document/plan.ts apps/server/app/flows/visualize-document/plan.test.ts apps/server/app/flows/visualize-document/fit.test.ts
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
- **Structure.** The `visualize-structure` step (no model call, `STEP_RETRY`) runs after extract, and on a re-plan that skips extraction too. It reads only this document under the owner's key and derives two sealed facts stored in `visual_facts` on reserved ordinals: the **outline** ((ordinal 16); the passages' heading paths as a tree, at most 120 nodes, labels clipped to 80 characters, deepest levels pruned first with their passage counts folded into the parent, none for fewer than 3 headings) and the **entity map** ((ordinal 17); the 20 most-mentioned entities, an edge for each pair sharing at least 2 passages, the 40 strongest edges, entities left with no edge dropped, none for fewer than 3 linked). Extraction keeps its 16 facts (ordinals 0..15), and `PgVisualFacts.replace` and `replaceStructure` each own their own ordinal range, so neither wipes the other. Migration 0035 relaxes the table's `kind` and `ordinal` CHECKs for them (the `kind` column carries `outline` / `cooccurrence`; the sealed fact's own `kind` is authoritative). `list` returns extracted facts only (chat and the extraction re-plan check); `listAll` returns everything (load, the UI reader). A heading or entity name that does not open skips that one fact; a key-store outage fails the step. The entity query (`pgStructure.ts`) is owner-scoped and walks out from this document (`chunks_document_ordinal_key`, then the `chunk_entities` primary key), opening names only for the ranked few.
```
and extend the **Plan.** bullet's end with: ` The planner is offered the structure facts as capabilities whose description and sample are counts only (never a heading or a name), and \`VISUALS_INTENT\` says to show an outline for long, sectioned documents and an entity map when several parties interact.` Update the final sentence of the **Connections.** bullet (`Catalogue ids: ...`) to: `Catalogue ids: the chat catalogue keeps \`docmind.visuals.v1\` (byte-identical, sha256-guarded; chat never offers a structure widget); the document catalogue, which adds the two connections types and \`DocumentOutline\` and \`EntityMap\` (both loom-ui \`Diagram\`), is \`docmind.visuals.v3\`.` and the **Fact-format re-plan.** bullet's first sentence's list of fingerprint parts to add `and the structure format (\`docmind.structure@1\`)`; add: `The structure release re-plans every visualized document once (one planner call each, at most 2 at a time, no extraction): the step derives the structure facts first.`

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
  loom-ui's `diagramProblems`, and `fitsShape` drops a misfit before commit.
- The planner sees counts only for a structure capability. `factFormatFingerprint()` ends `+docmind.structure@1`, which makes
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
| 2 S3 (two kinds `outline`, `cooccurrence`, sealed, cite passages, never sent to a model as text) | Task 3 3a (zod, `chunkIds`), 3b (sealed, pg test), Task 4 (counts-only sample; test asserts no text in capabilities) |
| 2 S4 (two catalogue entries on Diagram) | Task 4 (`ENTRIES`, reshaper families, tests) |
| 2 S5 (document visuals only; chat catalogue byte-identical, sha256 guard) | Task 4 (catalogue untouched, `TURN_ENTRIES`, guard test unchanged plus companion), Task 3 (`list` extracted-only) |
| 2 S6 (rollout reuses the format re-plan; v3; fingerprint changes) | Task 4 (`STRUCTURE_FORMAT`, id v3, fingerprint test); Task 5 docs |
| 2 S7 (one migration 0035 relaxing the kind and ordinal CHECKs, no table) | Task 3 3a (migration and its pg test), 3b (`columnKind`), Plan decisions |
| 3 outline (nodes, root, order, duplicates, cap 120, pruning, fold, <3) | Task 1 (all cases tested) |
| 3 co-occurrence (counts, top 20, ties by name, edges >=2, 40, isolated dropped, <3 linked) | Task 2 (tested); query in Task 3 3c |
| 3 Storage (replace beside extracted, own ordinals, cite passages, re-plan path re-derives) | Task 3 3b and 3d (store tests; flow re-run test) |
| 3 Errors (unreadable skips that fact, key-store outage fails the step) | Task 3 3c (reader returns null / rethrows), 3d (`structure.test.ts`) |
| 4 catalogue entries (labels, groups, edges, refs <= 16) | Task 4 (`structureShapes.ts`, `refsOf`, tests) |
| 4 reshapers pass `diagramProblems`, text-only labels, `fitsShape` | Task 4 (`accepted()` in shapes; visuals tests; `fit.test.ts`) |
| 4 planning (capabilities with pins, intent sentence, v3, fingerprint) | Task 4 (capabilities test, intent test, providers test) |
| 5 privacy and cost (sealed, no plaintext in logs/event log, planner counts only, one decrypt pass + one entity query, one planner call rollout) | Task 3 (log test, pg sealed test, index-bound test), Task 4 (no text in capabilities), Task 5 (e2e `assertNoPlaintext`) |
| 6 testing: outline builder / co-occurrence builder | Tasks 1 and 2 |
| 6 reshapers, refs within cap, `fitsShape` | Task 4 |
| 6 step on full run and extraction-skipping re-plan; undecryptable field skips only that fact | Task 3 3d |
| 6 chat sha256 guard unchanged | Task 4 (existing guard untouched) and Task 5 full run |
| 6 Postgres: sealed, owner-scoped, index-bound, only this document's rows | Task 3 3b and 3c |
| 6 e2e: long sectioned doc gets both, citation opens the section; short flat gets neither; no plaintext in the event log | Task 5 |
| 6 Web: both diagrams render (`lu-diagram` registered) | Task 5 step 3 |
| 7 Out of scope | Not implemented: no timeline, relationships, chat diagrams, cross-document structure, node editing |

**Placeholder scan:** no "TBD"/"TODO"/"similar to"; every code step carries the code. The `views.test.ts` and `fit.test.ts` additions in Task 4 are described against the existing helper in each file because those helpers are not reproduced here; the executor must copy the closest existing test in the same file, which is a named, local instruction rather than an open decision.

**Type consistency:** `OutlineDraft`/`CooccurrenceDraft` (Tasks 1, 2) match `StoredEntry` (Task 3: nodes `label/level/passageCount/firstChunkId`, entities `name/entityKind/passages`, edges `a/b/weight/firstChunkId`) and `OutlineFact`/`EntityMapFact` (Task 4) field for field; `OUTLINE_ORDINAL` 16 and `ENTITY_MAP_ORDINAL` 17 are used by the step (Task 3), the capability handles `fact-16`/`fact-17` (Task 4 tests) and the e2e hydrate handles (Task 5); `StructureReader` methods (`title`, `headings`, `entities`, `mentions`) are the same in `structure.ts`, `pgStructure.ts`, `testing.ts` (`noStructure`) and the tests; `visualize-structure` is the id in `flow.ts`, `deps.ts`, `security.ts` and `structure.ts`; `listAll` is read by `plan.ts` `loadEffect` and `ui/readers.ts` and `list` by chat and extract.
