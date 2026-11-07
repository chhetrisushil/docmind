# Document Visuals, Step (a): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a document is ingested, a background Loom flow extracts cited figures and facts, has loom-ui's `ReferencePlanner` compose a visual experience from them, and shows it as a "Visuals" tab on the document detail page.

**Architecture:** `visualize-document` is a new Loom flow. It is started when the `ingest-status` fold turns a document `ready`, and by a boot sweep for ready documents that never got one. The flow's steps are:
- `visualize-extract`: an LLM extracts facts, the grounding check filters them, and the survivors are sealed in `visual_facts`.
- `visualize-load`: reads the facts back as planner capabilities. Its output is sealed.
- A `ctx.decide` made by `ReferencePlanner.compose` inside the flow runner.
- `visualize-commit`: writes the composed experience to `@loom-ui/lineage` and notifies the browser.

The server serves a per-document detail experience: the static detail view plus a Visuals panel built from the lineage head. Facts hydrate through one memoised `visual.facts` read.

**Tech Stack:** TypeScript, Loom (`@loom/core`, `@loom/workflow-runtime`, `@loom/llm`), loom-ui (`@loom-ui/core`, `@loom-ui/planner`, `@loom-ui/lineage`, `@loom-ui/hydration`), Postgres with RLS, vitest, Lit.

**Spec:** `docs/specs/2026-11-08-document-visuals-design.md`. Read it first: decisions V1 to V10, and sections 3 to 8.

## Global Constraints

- **Ids only.** Flow start input is `{ tenantId, userId, documentId }`, strict, UUIDs. Execution ids hold no content. Use `executionIdFor(userId, name)` from `apps/server/app/subject.ts`.
- **Register sensitive paths up front.** Every event path that can hold user content (facts, ops, labels, summaries) is registered in `apps/server/app/sensitive.ts` in the same task that first writes it. The raw-event content proof (`assertEventsAreContentFree`, `ID/testing.ts`) must pass for the new flow.
- **Sealed storage.** `visual_facts.fact_enc` is sealed with `FieldCrypto.forUser(userId).seal("visualfact:<id>:fact", value)`. Seal before opening the transaction; no KMS call under row locks.
- **Fact limits.** At most 16 facts per document, 2 to 64 points per series, at most 12 rows × 8 columns per table, and 200 characters per cell.
- **Planner limits.** Offered containers are `section` and `grid` only. Catalogue id `docmind.visuals.v1`. Kinds `BarChart`, `TimeSeries`, `Kpi`, `Table`.
- **Capabilities.** Handles are `fact-<ordinal>`. Tool `visual.facts` version `1.0.0`, pin `docmind:visual.facts@1`, `sensitivity: "sensitive"`.
- **LLM role.** The role is `visuals`, with env vars `DOCMIND_VISUALS_PROVIDER` and `DOCMIND_VISUALS_MODEL`. `off` means the flow outcome is `skipped`.
- **Never block ingest.** A document's `ready` status never waits on visuals. A visuals failure never changes ingest status.
- **Gaps go to loom-ui.** Any gap in loom-ui is closed in loom-ui with generic code, never with DocMind code (M6 D11).
- **Commit footer.** Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Before a task is done,** run `pnpm --filter @docmind/server typecheck`, `pnpm lint`, and the tests the task names. Postgres suites need `DOCMIND_TEST_PG_URL`; run `pnpm db:start && pnpm db:init-test` first.

**Gate.** Tasks 1 to 7 and 10 do not need lineage and can land now. Tasks 8, 9, 11 and 12 depend on the loom and loom-ui erasable-lineage change (spec V8), which the loom session (`loom-ba`) is proposing. Do not start Task 8 until that change has merged and its commit SHAs are known.

Paths: `S` = `apps/server/app`, `ID` = `S/flows/ingest-document`, `VD` = `S/flows/visualize-document`, `PE` = `packages/experiences/src`, `WEB` = `apps/web/src`.

---

### Task 1: Generalise `stepEffect` for a second flow

**Files:**
- Modify: `ID/stepEffect.ts` (`StepGuard` at :36, `stepEffect` at :169)
- Test: `ID/stepEffect.test.ts`

**Interfaces:**
- Produces: `stepEffect(step: string, guard: StepGuard, work, options)`, where `StepGuard.begin(ref, step: string, generation?: number)`. Adds `StepOptions.generationOf?: (executionId: string) => number | undefined`, which defaults to the current ingest `generationOf`. Ingest behaviour is unchanged.

- [ ] **Step 1: Write the failing test** (append to `ID/stepEffect.test.ts`)

```ts
it("runs under a non-ingest step label with a caller-supplied generation reader", async () => {
  const seen: { step: string; generation?: number }[] = [];
  const guard: StepGuard = { begin: async (_ref, step, generation) => { seen.push({ step, generation }); } };
  const effect = stepEffect("visualize-extract", guard, async () => ({ count: 3 }), {
    generationOf: () => 7,
  });
  const out = await runEffect(effect, REF, { executionId: "u_x:visualize-y" }); // existing test helper
  expect(out).toEqual({ outcome: "done", count: 3 });
  expect(seen).toEqual([{ step: "visualize-extract", generation: 7 }]);
});
```

`runEffect` and `REF` are this file's existing helpers. If the file names them differently, use its own names. Do not add new helpers.

- [ ] **Step 2: Run it and check it fails**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/ingest-document/stepEffect.test.ts`
Expected: a type or runtime failure. The step label is typed `IngestStep`, and `generationOf` is not an option yet.

- [ ] **Step 3: Implement**
  - In `StepGuard` and `stepEffect`, change the `step` parameter from `IngestStep` to `string`.
  - Add `generationOf?: (executionId: string) => number | undefined` to `StepOptions`.
  - Inside `stepEffect`, replace the direct `generationOf(executionId)` call with `(options.generationOf ?? generationOf)(executionId)`.
  - `PgStepGuard` keeps its ingest behaviour. It casts or validates `step` with `IngestStep.parse(step)` where it needs the enum.

- [ ] **Step 4: Run the ingest and step tests**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/ingest-document/`
Expected: PASS. Ingest behaviour is unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/server/app/flows/ingest-document/stepEffect.ts apps/server/app/flows/ingest-document/stepEffect.test.ts
git commit -m "refactor(ingest): stepEffect takes any step label and a generation reader"
```

---

### Task 2: The `visuals` LLM role

**Files:**
- Modify: `S/llm/roles.ts` (`LLM_ROLES` :4, `PREFIX` :24, `DEFAULT_MODEL` :41, the `llmWarnings` off table :218)
- Modify: `ID/limits.ts` (`IngestWiring.llm` :31, `createLlm` :128)
- Modify: `S/llm/roles.test.ts` (the full `toEqual` role maps at about lines 11-17, 32-38, 236 and 248, and the warning counts at about lines 268 and 282)
- Modify: `.env.example` (around lines 120-126), `docs/operations/llm-providers.md`

**Interfaces:**
- Produces: `IngestWiring["llm"].visuals?: LlmProvider`, which is undefined when the role is off. `VISUALS_MAX_TOKENS = 4096` is exported from `ID/limits.ts`.

- [ ] **Step 1: Write the failing tests** (in `S/llm/roles.test.ts`)

```ts
it("visuals is a role with its own provider and an off switch", () => {
  const s = loadLlmRoles({ DOCMIND_VISUALS_PROVIDER: "off" });
  expect(s.roles.visuals).toEqual({ provider: "off", model: "" });
  expect(llmWarnings(s, {})).toContain("visuals are off: DOCMIND_VISUALS_PROVIDER is off");
});
it("visuals defaults to ollama", () => {
  expect(loadLlmRoles({}).roles.visuals.provider).toBe("ollama");
});
```

Also add `visuals: …` to every full-map `toEqual` in this file, using the same value that file uses for `summary` under the same env.

- [ ] **Step 2: Run them and check they fail**

Run: `pnpm --filter @docmind/server exec vitest run app/llm/roles.test.ts`
Expected: FAIL, because `roles.visuals` is undefined.

- [ ] **Step 3: Implement**

```ts
// roles.ts
export const LLM_ROLES = ["chat", "title", "summary", "vision", "visionPdf", "visuals"] as const;
// PREFIX
visuals: "DOCMIND_VISUALS",
// DEFAULT_MODEL.anthropic
visuals: "claude-haiku-5-5",
// llmWarnings off table
["visuals", "visuals are off: DOCMIND_VISUALS_PROVIDER is off"],
```

```ts
// limits.ts
export const VISUALS_MAX_TOKENS = 4096;
// IngestWiring["llm"]: add  visuals?: LlmProvider;
// createLlm:
const visuals = make("visuals", VISUALS_MAX_TOKENS, config.timeoutMs);
return { roles, config, ...(summary && { summary }), ...(visuals && { visuals }), /* existing */ };
```

`.env.example`: add `# DOCMIND_VISUALS_PROVIDER=ollama` and `# DOCMIND_VISUALS_MODEL=`, next to the summary lines. Runbook: add a row for `visuals`. It extracts facts and plans document visuals, and `off` hides the Visuals tab.

- [ ] **Step 4: Run the LLM and limits tests**

Run: `pnpm --filter @docmind/server exec vitest run app/llm/ app/flows/ingest-document/limits.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/app/llm apps/server/app/flows/ingest-document/limits.ts .env.example docs/operations/llm-providers.md
git commit -m "feat(llm): visuals role (DOCMIND_VISUALS_PROVIDER, off hides visuals)"
```

---

### Task 3: The fact schema and the grounding check (pure)

**Files:**
- Create: `VD/facts.ts`
- Test: `VD/facts.test.ts`

**Interfaces:**
- Produces:
  - `Fact`: a zod discriminated union of `series`, `figure` and `factTable`.
  - `ExtractAnswer = z.object({ facts: z.array(DraftFact).max(32) })`, where `DraftFact` is `Fact` without `ordinal`.
  - `numbersOf(fact): number[]`
  - `grounded(fact, chunkTexts: ReadonlyMap<string, string>): boolean`
  - `admit(drafts, chunkTexts, documentChunkIds: ReadonlySet<string>): { facts: Fact[]; dropped: number }`
  - `MAX_FACTS = 16`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { admit, grounded, numbersOf } from "./facts";

const C1 = "11111111-1111-4111-8111-111111111111";
const text = (s: string) => new Map([[C1, s]]);

describe("grounded", () => {
  it.each([
    ["Revenue was 1,200 in 2024", 1200],
    ["Revenue was 1 200", 1200],
    ["Revenue was 1.2k", 1200],
    ["Revenue was $3M", 3_000_000],
    ["Margin 12 %", 12],
    ["Margin 12%", 12],
  ])("finds %s", (s, n) => {
    const fact = { kind: "figure", label: "x", value: n, chunkIds: [C1], ordinal: 0 } as const;
    expect(grounded(fact, text(s))).toBe(true);
  });
  it("accepts 0.12 for a percent unit when the text says 12%", () => {
    const fact = { kind: "figure", label: "m", value: 0.12, unit: "%", chunkIds: [C1], ordinal: 0 } as const;
    expect(grounded(fact, text("margin 12%"))).toBe(true);
  });
  it("rejects a number the cited text does not contain", () => {
    const fact = { kind: "figure", label: "x", value: 1300, chunkIds: [C1], ordinal: 0 } as const;
    expect(grounded(fact, text("Revenue was 1,200"))).toBe(false);
  });
});

describe("admit", () => {
  it("drops facts citing chunks of another document, caps at 16, assigns ordinals", () => {
    const ok = { kind: "figure", label: "x", value: 5, chunkIds: [C1] } as const;
    const foreign = { ...ok, chunkIds: ["22222222-2222-4222-8222-222222222222"] };
    const r = admit([foreign, ...Array(20).fill(ok)], text("five 5"), new Set([C1]));
    expect(r.facts).toHaveLength(16);
    expect(r.facts.map((f) => f.ordinal)).toEqual([...Array(16).keys()]);
    expect(r.dropped).toBe(1);
  });
  it("numbersOf lists series points, figure values and numeric table cells", () => {
    expect(numbersOf({ kind: "factTable", title: "t", columns: ["a"], rows: [["7"], ["n/a"]], chunkIds: [C1], ordinal: 0 })).toEqual([7]);
  });
});
```

- [ ] **Step 2: Run them and check they fail**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/visualize-document/facts.test.ts`
Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Implement `VD/facts.ts`**

```ts
import { z } from "zod";

export const MAX_FACTS = 16;
const Label = z.string().trim().min(1).max(120);
const ChunkIds = z.array(z.string().uuid()).min(1).max(8);

const Series = z.object({
  kind: z.literal("series"), label: Label, unit: z.string().max(16).optional(),
  points: z.array(z.object({ x: z.string().min(1).max(40), y: z.number().finite() })).min(2).max(64),
  chunkIds: ChunkIds,
}).strict();
const Figure = z.object({
  kind: z.literal("figure"), label: Label, value: z.number().finite(), unit: z.string().max(16).optional(),
  compare: z.object({ label: Label, value: z.number().finite() }).strict().optional(),
  chunkIds: ChunkIds,
}).strict();
const Cell = z.string().max(200);
const FactTable = z.object({
  kind: z.literal("factTable"), title: Label,
  columns: z.array(Cell).min(1).max(8), rows: z.array(z.array(Cell).max(8)).min(1).max(12),
  chunkIds: ChunkIds,
}).strict();

export const DraftFact = z.discriminatedUnion("kind", [Series, Figure, FactTable]);
export type DraftFact = z.infer<typeof DraftFact>;
export type Fact = DraftFact & { ordinal: number };
export const ExtractAnswer = z.object({ facts: z.array(DraftFact).max(32) }).strict();

const NUMERIC = /^[-+]?\d+(?:[.,]\d+)?$/;
export function numbersOf(f: DraftFact): number[] {
  switch (f.kind) {
    case "series": return f.points.map((p) => p.y);
    case "figure": return f.compare ? [f.value, f.compare.value] : [f.value];
    case "factTable":
      return f.rows.flat().map((c) => c.trim()).filter((c) => NUMERIC.test(c)).map((c) => Number(c.replace(",", ".")));
  }
}

const SUFFIX: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, bn: 1e9 };
/** Every number written in `text`, normalised: grouping (`1,200` `1 200` `1.200`), suffixes, currency, percent. */
function numbersIn(text: string): number[] {
  const out: number[] = [];
  const re = /[$€£¥]?\s?(\d{1,3}(?:[ ,. ]\d{3})+|\d+)(?:[.,](\d+))?\s?(k|m|bn|b)?\b\s?(%)?/gi;
  for (const m of text.matchAll(re)) {
    const whole = m[1].replace(/[ ,. ]/g, "");
    const n = Number(m[2] === undefined ? whole : `${whole}.${m[2]}`);
    if (!Number.isFinite(n)) continue;
    const mult = m[3] ? SUFFIX[m[3].toLowerCase()] : 1;
    out.push(n * mult);
    if (m[4]) out.push((n * mult) / 100); // 12% also grounds 0.12
  }
  return out;
}

const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-6);

export function grounded(f: DraftFact, chunkTexts: ReadonlyMap<string, string>): boolean {
  const pool = f.chunkIds.flatMap((id) => numbersIn(chunkTexts.get(id) ?? ""));
  return numbersOf(f).every((n) => pool.some((p) => close(p, n)));
}

export function admit(
  drafts: readonly DraftFact[], chunkTexts: ReadonlyMap<string, string>, documentChunkIds: ReadonlySet<string>,
): { facts: Fact[]; dropped: number } {
  const facts: Fact[] = [];
  let dropped = 0;
  for (const d of drafts) {
    const ok = d.chunkIds.every((id) => documentChunkIds.has(id)) && grounded(d, chunkTexts);
    if (!ok) { dropped++; continue; }
    if (facts.length < MAX_FACTS) facts.push({ ...d, ordinal: facts.length });
  }
  return { facts, dropped };
}
```

How the regex reads the test cases:
- The grouping alternative needs exactly three digits after each separator. So `1,200` and `1 200` read as 1200, while `1.2k` falls through to `\d+` (`1`), then the decimal part (`.2`), then the suffix `k`, giving 1200.
- A grouped run followed by more digits (`1 2024`) fails the word boundary and backtracks to `1`.
- `1.200` reads as 1200, never 1.2. That is accepted: a fact citing 1.2 against a document that writes `1.200` gets dropped, which is the safe direction.

- [ ] **Step 4: Run them and check they pass**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/visualize-document/facts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/app/flows/visualize-document/facts.ts apps/server/app/flows/visualize-document/facts.test.ts
git commit -m "feat(visuals): fact schema and the grounding check"
```

---

### Task 4: The `visual_facts` table and `PgVisualFacts`

**Files:**
- Create: `infra/migrations/0026_visual_facts.sql`
- Create: `VD/pgFacts.ts`
- Test: `VD/pgFacts.pg.test.ts`
- Modify: `S/erasure/pgSteps.ts:70` (the comment only: add `visual_facts` to the cascade list)

**Interfaces:**
- Consumes: `Fact` (Task 3), `FieldCrypto`, `withTenant`, and `lockDocument` (wherever `pgEntities.ts` imports it from).
- Produces:

```ts
export interface VisualFactStore {
  replace(ref: VisualizeRef, facts: readonly Fact[], signal?: AbortSignal): Promise<number>;
  list(ref: VisualizeRef): Promise<Fact[]>;  // ordinal order; throws DocumentGoneError if not owned
}
export type VisualizeRef = { tenantId: string; userId: string; documentId: string };
export class PgVisualFacts implements VisualFactStore { constructor(pool: Pool, fields: FieldCrypto) }
```

- [ ] **Step 1: Write the migration**

```sql
-- 0026: facts extracted for a document's visuals (spec docs/specs/2026-11-08-document-visuals-design.md §5).
CREATE TABLE visual_facts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  document_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('series', 'figure', 'factTable')),
  ordinal int NOT NULL CHECK (ordinal BETWEEN 0 AND 15),
  fact_enc jsonb NOT NULL,
  chunk_ids uuid[] NOT NULL,
  schema_version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT visual_facts_owner_fkey FOREIGN KEY (tenant_id, owner_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT visual_facts_document_fkey FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT visual_facts_document_ordinal_key UNIQUE (tenant_id, document_id, ordinal)
);
ALTER TABLE visual_facts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON visual_facts USING (tenant_id = app_tenant_id());
```

No GRANT is needed. `0001_app_role.sql` sets default privileges.

- [ ] **Step 2: Write the failing Postgres tests** (modelled on `ID/pgEntities.pg.test.ts`, using `startPgFixture`)

```ts
const pg = describe.skipIf(!process.env.DOCMIND_TEST_PG_URL);
pg("PgVisualFacts", () => {
  let fx: PgFixture; beforeAll(async () => { fx = await startPgFixture(); }); afterAll(() => fx.close());
  const fig = (ordinal: number, chunk: string): Fact => ({ kind: "figure", label: "Revenue", value: 1200, chunkIds: [chunk], ordinal });

  it("round-trips sealed facts in ordinal order and replaces in one transaction", async () => {
    const ref = await fx.doc("vf-1"); const chunk = await seedChunk(fx, ref); // seedChunk: insert one chunk via PgChunkStore.replace
    const store = new PgVisualFacts(fx.app, fx.fields);
    await store.replace(ref, [fig(1, chunk), fig(0, chunk)]);
    expect((await store.list(ref)).map((f) => f.ordinal)).toEqual([0, 1]);
    await store.replace(ref, [fig(0, chunk)]);
    expect(await store.list(ref)).toHaveLength(1);
  });
  it("stores no plaintext label", async () => {
    const ref = await fx.doc("vf-2"); const chunk = await seedChunk(fx, ref);
    await new PgVisualFacts(fx.app, fx.fields).replace(ref, [fig(0, chunk)]);
    const raw = await fx.db.owner.query("SELECT fact_enc::text FROM visual_facts");
    expect(raw.rows.map((r) => r.fact_enc).join()).not.toContain("Revenue");
  });
  it("is invisible to another tenant and gone with the document", async () => { /* RLS read under T2 → []; DELETE documents → rows gone */ });
  it("list throws DocumentGoneError for a document the user does not own", async () => { /* ... */ });
});
```

Write the two `/* */` cases in full, following `pgEntities.pg.test.ts`'s own RLS and ownership cases.

- [ ] **Step 3: Run them and check they fail**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/visualize-document/pgFacts.pg.test.ts`
Expected: FAIL, because the module isn't found.

- [ ] **Step 4: Implement `VD/pgFacts.ts`**

```ts
export class PgVisualFacts implements VisualFactStore {
  constructor(private readonly pool: Pool, private readonly fields: FieldCrypto) {}
  async replace(ref: VisualizeRef, facts: readonly Fact[], signal?: AbortSignal): Promise<number> {
    const cipher = this.fields.forUser(ref.userId);
    const rows = await Promise.all(facts.map(async (f) => {
      const id = randomUUID();
      return { id, kind: f.kind, ordinal: f.ordinal, chunkIds: f.chunkIds, sealed: JSON.stringify(await cipher.seal(`visualfact:${id}:fact`, f)) };
    }));
    await withTenant(this.pool, ref.tenantId, async (tx) => {
      await lockDocument(tx, ref);
      await tx.query("DELETE FROM visual_facts WHERE document_id = $1", [ref.documentId]);
      for (const r of rows) {
        await tx.query(
          `INSERT INTO visual_facts (id, tenant_id, owner_id, document_id, kind, ordinal, fact_enc, chunk_ids)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::uuid[])`,
          [r.id, ref.tenantId, ref.userId, ref.documentId, r.kind, r.ordinal, r.sealed, r.chunkIds]);
      }
      if (signal?.aborted) throw new ParseAbortedError();
    });
    return rows.length;
  }
  async list(ref: VisualizeRef): Promise<Fact[]> {
    const res = await withTenant(this.pool, ref.tenantId, async (tx) => {
      await lockDocument(tx, ref);
      return tx.query<{ id: string; fact_enc: unknown }>(
        "SELECT id, fact_enc FROM visual_facts WHERE document_id = $1 AND owner_id = $2 ORDER BY ordinal",
        [ref.documentId, ref.userId]);
    });
    const cipher = this.fields.forUser(ref.userId);
    return Promise.all(res.rows.map(async (r) => {
      const parsed = StoredFact.safeParse(await cipher.open(`visualfact:${r.id}:fact`, r.fact_enc));
      if (!parsed.success) throw new Error("visual fact has an unexpected shape");
      return parsed.data;
    }));
  }
}
```

`StoredFact` is `DraftFact.and(z.object({ ordinal: z.number().int().min(0).max(15) }))`. Export it from `facts.ts`. At most 16 rows go in, so the insert loops row by row; that is clearer than `unnest`. Take `lockDocument` and `ParseAbortedError` from the same imports `pgEntities.ts` uses.

- [ ] **Step 5: Run the Postgres tests and the migration test**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/visualize-document/pgFacts.pg.test.ts app/db/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add infra/migrations/0026_visual_facts.sql apps/server/app/flows/visualize-document/pgFacts.* apps/server/app/flows/visualize-document/facts.ts apps/server/app/erasure/pgSteps.ts
git commit -m "feat(visuals): visual_facts table (RLS, sealed, cascades) and its store"
```

---

### Task 5: The extraction step

**Files:**
- Create: `VD/extract.ts`, `VD/prompts.ts`
- Test: `VD/extract.test.ts`

**Interfaces:**
- Consumes:
  - `stepEffect` and `ingestStepOptions` (Task 1).
  - `LLM_RETRY`, `LLM_BACKOFF_CAP_MS`.
  - `ChunkStore.sectionsOf` and `.read` (`ID/pgChunks.ts:11`).
  - `jsonAnswer` (`ID/llmJson.ts`).
  - `guardRequest`, `UNTRUSTED_CONTENT_SYSTEM_NOTE` and `LlmProvider` from `@loom/llm`, and `tainted` from `@loom/classify`.
  - `admit` and `ExtractAnswer` (Task 3), and `VisualFactStore` (Task 4).
- Produces:

```ts
export interface ExtractDeps extends StepSeams { guard: StepGuard; chunks: Pick<ChunkStore, "sectionsOf" | "read">; facts: VisualFactStore; llm?: LlmProvider }
export function extractEffect(deps: ExtractDeps): Effect<VisualizeRef, StepResult>
// StepResult: count = facts kept; model = model name; llm absent → { model: "none" } (done, count 0)
export const EXTRACT_WINDOW_CHARS = 24_000;
```

- [ ] **Step 1: Write the failing tests**

Model the deps on `ID/steps/summarize.test.ts`: a scripted `LlmProvider & { model }`, `guard: { begin: async () => {} }`, in-memory chunks and an in-memory `VisualFactStore`. Cover these cases:
  1. Two chunks and a model answer with one grounded fact and one ungrounded fact. Expect `count: 1`, and the store holds ordinal 0.
  2. With `llm` undefined, expect `{ outcome: "done", model: "none" }` and no store write.
  3. When the model returns invalid JSON every time, expect `outcome: "failed"` with the code `jsonAnswer`'s `LlmOutputError` maps to via `permanentCode`. If it maps to none, expect retries and then a throw; assert the behaviour the existing summarize test asserts for the same error.
  4. Windows: with 3 chunks of 10,000 characters each, expect 2 model calls (24,000-character windows that never split a chunk).
  5. Every request's user message wraps the chunk text with `tainted(…, "document")`. Assert the request passed through `guardRequest`, the way the summarize test does.

- [ ] **Step 2: Run them and check they fail**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/visualize-document/extract.test.ts`
Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Implement**

`VD/prompts.ts`:

```ts
export const EXTRACT_SYSTEM = `You extract facts from a document that a chart or table would make clearer than prose.
Return JSON {"facts":[...]} only. Each fact is one of:
- {"kind":"series","label","unit"?,"points":[{"x","y"}],"chunkIds":[...]} for 2+ comparable numbers (x may be an ISO date)
- {"kind":"figure","label","value","unit"?,"compare"?:{"label","value"},"chunkIds":[...]} for one headline number
- {"kind":"factTable","title","columns":[...],"rows":[[...]],"chunkIds":[...]} for dates, parties, obligations or comparisons
Copy every number exactly as the document states it. Cite the ids of the passages each fact comes from.
Return {"facts":[]} when nothing qualifies. Never compute totals or averages that the document does not state.`;
export const EXTRACT_INSTRUCTION = "Extract the facts from the passages above. Each passage starts with its id in [[...]].";
```

`VD/extract.ts`:

```ts
export function extractEffect(deps: ExtractDeps): Effect<VisualizeRef, StepResult> {
  return stepEffect("visualize-extract", deps.guard, async (ref, signal) => {
    if (!deps.llm) return { model: "none" };
    const model = String((deps.llm as { model?: unknown }).model ?? "unknown").slice(0, 200);
    const ids = (await deps.chunks.sectionsOf(ref)).map((s) => s.id);
    const chunks = await readAll(deps.chunks, ref, ids);                 // read() in batches of 200
    const texts = new Map(chunks.map((c) => [c.id, c.text]));
    const drafts: DraftFact[] = [];
    for (const window of windows(chunks, EXTRACT_WINDOW_CHARS)) {
      const text = window.map((c) => `[[${c.id}]]\n${c.text}`).join("\n\n");
      const request = guardRequest({
        system: `${EXTRACT_SYSTEM}\n\n${UNTRUSTED_CONTENT_SYSTEM_NOTE}`,
        messages: [{ role: "user", content: [{ type: "text", text: tainted(text, "document") }, { type: "text", text: EXTRACT_INSTRUCTION }] }],
        temperature: 0,
      });
      const res = await deps.llm.complete({ ...request, signal });
      if (res.stopReason === "max_tokens") throw new LlmOutputError();
      drafts.push(...jsonAnswer(res.content, ExtractAnswer).facts);
    }
    const { facts } = admit(drafts, texts, new Set(ids));
    const count = await deps.facts.replace(ref, facts, signal);
    return { count, model };
  }, ingestStepOptions({ ...deps, stepTimeoutMs: 600_000 }, LLM_RETRY, LLM_BACKOFF_CAP_MS));
}
```

`windows(chunks, max)` groups consecutive chunks while the running length stays at or under `max`. A single chunk longer than `max` is its own window. `readAll` calls `chunks.read(ref, slice)` for each slice of 200 ids. Write both as local functions with the step.

- [ ] **Step 4: Run them and check they pass**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/visualize-document/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/app/flows/visualize-document/
git commit -m "feat(visuals): visualize-extract step (windowed, fenced, grounded)"
```

---

### Task 6: The visuals catalogue, capabilities, reshapers and the `visual.facts` read

**Files:**
- Create: `PE/visuals.ts` (catalogue, `capabilitiesOf`, reshapers), `PE/visuals.test.ts`
- Modify: `PE/providers.ts` (`PINS`: add `"visual.facts": "docmind:visual.facts@1"`)
- Modify: `PE/invoker.ts` (`UiReaders.visualFacts`, `ARGS["visual.facts"]`, a `case "visual.facts"`)
- Modify: `PE/reshapers.ts` (spread in `VISUAL_SHAPES`)
- Modify: `PE/index.ts` (export `VISUALS_CATALOG`, `capabilitiesOf`, `VisualFactRaw`)
- Modify: `S/ui/readers.ts` (implement `visualFacts`)
- Modify: `packages/experiences/package.json` (add `"@loom-ui/planner": "link:../../../loom-ui/packages/planner"` for the `CapabilityRef` type only), and `pnpm-workspace.yaml` (lines 35-38: add the planner link next to the others)
- Test: `PE/visuals.test.ts`, `PE/hydrate.test.ts` (one new case), `S/ui/readers.test.ts` (one new case)

**Interfaces:**
- Consumes: `Fact` (Task 3, duplicated as a structural type `VisualFactRaw` in `PE`, because experiences does not depend on the server), and `VisualFactStore.list` (Task 4).
- Produces:

```ts
export const VISUALS_CATALOG: SemanticCatalog;            // id "docmind.visuals.v1"; entries FigureChart, FigureTrend, KeyFigure, FactTable
export function capabilitiesOf(facts: readonly VisualFactRaw[]): CapabilityRef[];  // handle fact-<n>, kind "docmind", tool "visual.facts"
export type VisualEntry = "FigureChart" | "FigureTrend" | "KeyFigure" | "FactTable";
export function factProvider(ordinal: number, documentId: string, entry: VisualEntry): ProviderSpec;
// handle fact-<n>, target visual.facts, args {id}, reshaper `${FAMILY[entry]}-<n>`
export const VISUAL_SHAPES: Record<string, (raw: never) => unknown>;
// families visual-bar / visual-trend / visual-kpi / visual-table, each 0..15 (64 named reshapers)
// UiReaders.visualFacts(a: { id: string }): Promise<VisualFactRaw[] | null>
```

- [ ] **Step 1: Write the failing tests** (`PE/visuals.test.ts`)

```ts
it("the catalogue resolves every entry on web and terminal to a framework kind", () => {
  for (const e of VISUALS_CATALOG.entries) {
    expect(Object.keys(e.surfaces).sort()).toEqual(["terminal", "web"]);
    expect(e.binding).toBe("required");
  }
  expect(VISUALS_CATALOG.entries.map((e) => [e.name, (e.surfaces.web as { kind: string }).kind])).toEqual([
    ["FigureChart", "BarChart"], ["FigureTrend", "TimeSeries"], ["KeyFigure", "Kpi"], ["FactTable", "Table"],
  ]);
});
it("one capability per fact, bindable and classed", () => {
  const caps = capabilitiesOf([FIGURE, SERIES]);
  expect(caps.map((c) => c.handle)).toEqual(["fact-0", "fact-1"]);
  expect(caps.every((c) => c.kind === "docmind" && c.toolName === "visual.facts" && c.toolSchemaHash === "docmind:visual.facts@1" && c.sensitivity === "sensitive" && c.sampleOutput !== undefined)).toBe(true);
});
it("each family maps a fact to its kind's value contract", () => {
  const raw = [FIGURE, SERIES, DATED_SERIES, TABLE];
  expect(shape("visual-kpi-0", raw)).toEqual({ value: 1200, unit: "EUR", label: "Revenue" });
  expect(shape("visual-bar-1", raw)).toEqual({ bars: [{ label: "Q1", value: 1 }, { label: "Q2", value: 2 }] });
  expect(shape("visual-trend-2", raw)).toEqual({ series: [{ label: "Users", points: [{ timestamp: "2024-01-01", value: 3 }, { timestamp: "2024-02-01", value: 4 }] }] });
  expect(shape("visual-table-3", raw)).toEqual({ columns: ["Party", "Due"], rows: [["Acme", "2025-01-01"]] });
  expect(shape("visual-bar-2", raw)).toEqual({ bars: [{ label: "2024-01-01", value: 3 }, { label: "2024-02-01", value: 4 }] }); // dated series as bars is fine
});
it("a fact of the wrong kind or a missing fact fails (per-widget placeholder)", () => {
  const raw = [FIGURE, SERIES, DATED_SERIES, TABLE];
  expect(() => shape("visual-trend-1", raw)).toThrow();   // undated series cannot be a TimeSeries
  expect(() => shape("visual-kpi-1", raw)).toThrow();     // a series is not a figure
  expect(() => shape("visual-kpi-9", raw)).toThrow();     // no fact 9
});
it("a figure with compare carries deltaPct as a fraction", () => {
  expect(shape("visual-kpi-0", [{ ...FIGURE, compare: { label: "2023", value: 1000 } }])).toMatchObject({ deltaPct: 0.2 });
});
```

`FIGURE`, `SERIES`, `DATED_SERIES` and `TABLE` are small `VisualFactRaw` fixtures with ordinals 0 to 3, declared at the top of the test. In `PE/hydrate.test.ts`, add one case: two `fact-*` handles hydrate with **one** `readers.visualFacts` call, through the memo. In `S/ui/readers.test.ts`, add one case: `visualFacts` returns null for a document the identity does not own.

- [ ] **Step 2: Run them and check they fail**

Run: `pnpm --filter @docmind/experiences test`
Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Implement `PE/visuals.ts`**

```ts
import { type SemanticCatalog, defineSemanticCatalog, type ProviderSpec } from "@loom-ui/core";
import type { CapabilityRef } from "@loom-ui/planner";
import { KIND, PINS, provider } from "./providers";
import { SURFACES } from "./catalog";

export type VisualFactRaw =
  | { kind: "series"; label: string; unit?: string; points: { x: string; y: number }[]; chunkIds: string[]; ordinal: number }
  | { kind: "figure"; label: string; value: number; unit?: string; compare?: { label: string; value: number }; chunkIds: string[]; ordinal: number }
  | { kind: "factTable"; title: string; columns: string[]; rows: string[][]; chunkIds: string[]; ordinal: number };

const ENTRIES = [["FigureChart", "BarChart"], ["FigureTrend", "TimeSeries"], ["KeyFigure", "Kpi"], ["FactTable", "Table"]] as const;
const PROPS: Record<string, string[]> = { BarChart: ["unit", "format"], TimeSeries: ["unit", "format"], Kpi: ["unit", "format"], Table: [] };

export const VISUALS_CATALOG: SemanticCatalog = defineSemanticCatalog({
  id: "docmind.visuals.v1",
  entries: ENTRIES.map(([name, kind]) => ({
    name, version: "1.0.0", props: PROPS[kind], binding: "required" as const,
    surfaces: Object.fromEntries(SURFACES.map((s) => [s, { kind, props: PROPS[kind], binding: "required" as const }])),
  })),
});

export const MAX_VISUAL_FACTS = 16;
const TOOL = "visual.facts" as const;

export function capabilitiesOf(facts: readonly VisualFactRaw[]): CapabilityRef[] {
  return facts.map((f) => ({
    handle: `fact-${f.ordinal}`, kind: KIND, toolName: TOOL, toolVersion: "1.0.0", toolSchemaHash: PINS[TOOL],
    description: f.kind === "series" ? "a series of numbers from the document" : f.kind === "figure" ? "one headline figure" : "a table of facts",
    sampleOutput: f, sensitivity: "sensitive",
  }));
}

export type VisualEntry = "FigureChart" | "FigureTrend" | "KeyFigure" | "FactTable";
const FAMILY: Record<VisualEntry, string> = { FigureChart: "visual-bar", FigureTrend: "visual-trend", KeyFigure: "visual-kpi", FactTable: "visual-table" };

export const factProvider = (ordinal: number, documentId: string, entry: VisualEntry): ProviderSpec =>
  provider(`fact-${ordinal}`, { target: TOOL, args: { id: documentId }, reshaper: `${FAMILY[entry]}-${ordinal}` });

const isDate = (x: string) => /^\d{4}-\d{2}(-\d{2})?/.test(x);
const unitOf = (f: { unit?: string }) => (f.unit ? { unit: f.unit } : {});
const wrong = () => { throw new Error("visual fact does not fit this widget"); };

/** One value contract per family. A fact that does not fit throws, and loom-ui draws the per-widget placeholder. */
const TO: Record<string, (f: VisualFactRaw) => unknown> = {
  "visual-kpi": (f) => f.kind !== "figure" ? wrong() : {
    value: f.value, ...unitOf(f), label: f.label,
    ...(f.compare && f.compare.value !== 0 && { deltaPct: (f.value - f.compare.value) / Math.abs(f.compare.value) }),
  },
  "visual-bar": (f) => f.kind !== "series" ? wrong() : { ...unitOf(f), bars: f.points.map((p) => ({ label: p.x, value: p.y })) },
  "visual-trend": (f) => f.kind !== "series" || !f.points.every((p) => isDate(p.x)) ? wrong()
    : { series: [{ label: f.label, ...unitOf(f), points: f.points.map((p) => ({ timestamp: p.x, value: p.y })) }] },
  "visual-table": (f) => f.kind !== "factTable" ? wrong() : { columns: f.columns, rows: f.rows },
};

export const VISUAL_SHAPES: Record<string, (raw: never) => unknown> = Object.fromEntries(
  Object.entries(TO).flatMap(([family, to]) =>
    Array.from({ length: MAX_VISUAL_FACTS }, (_, n) => [`${family}-${n}`, (raw: VisualFactRaw[]) => {
      const f = raw.find((x) => x.ordinal === n);
      if (!f) throw new Error("visual fact missing");
      return to(f);
    }])),
);
```

The provider of a planner-bound node is generated from the entry the planner chose (Task 10, `detailWithVisuals`). So the reshaper always matches the widget's kind. A mismatch, such as the planner binding `FigureTrend` to an undated series, gives a per-widget placeholder, not a broken page.

`PE/invoker.ts`:

```ts
// UiReaders
visualFacts(a: { id: string }): Promise<VisualFactRaw[] | null>;
// ARGS
"visual.facts": z.object({ id: Uuid.transform((s) => s.toLowerCase()) }).strict(),
// plan()
case "visual.facts": { const a = ARGS["visual.facts"].safeParse(args); if (!a.success) return fail("invalidArgs");
  return { key: [target, a.data], exec: async () => (await readers.visualFacts({ id: a.data.id })) ?? fail("notFound") }; }
```

`S/ui/readers.ts`:

```ts
async visualFacts({ id }) {
  try { return await deps.visualFacts.list({ tenantId: identity.tenantId, userId: identity.userId, documentId: id }); }
  catch (err) { if (isDocumentGone(err)) return null; throw err; }
},
```

`UiReaderDeps` gains `visualFacts: VisualFactStore`. In `S/compose.ts` (around :352), pass `new PgVisualFacts(pool, fields)`.

- [ ] **Step 4: Run them and check they pass**

Run: `pnpm --filter @docmind/experiences test && pnpm --filter @docmind/server exec vitest run app/ui/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/experiences apps/server/app/ui apps/server/app/compose.ts pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat(visuals): visuals catalogue, fact capabilities, reshapers and the visual.facts read"
```

---

### Task 7: The load step and the planner decision, with conformance

**Files:**
- Create: `VD/plan.ts` (`loadEffect`, `planVisuals`, `VISUALS_INTENT`)
- Test: `VD/plan.test.ts`
- Modify: `S/sensitive.ts` (the `STEP_COMPLETED` output path of the load step, and the `DECISION_RECORDED` choice paths)
- Modify: `apps/server/package.json` (add `@loom-ui/planner` and `@loom-ui/core` links), and `pnpm-workspace.yaml` if it isn't already linked

**Interfaces:**
- Consumes: `VisualFactStore` (Task 4), and `capabilitiesOf` and `VISUALS_CATALOG` (Task 6).
- Produces:

```ts
export const LoadOutput = z.object({ outcome: z.enum(["done", "document_gone", "failed"]), facts: z.array(StoredFact).max(16) }).strict();
export function loadEffect(deps: { guard: StepGuard; facts: VisualFactStore } & StepSeams): Effect<VisualizeRef, LoadOutput>;
export const VISUALS_INTENT: Intent;   // { objective: <fixed text>, source: "application", sensitivity: "sensitive" }
export async function planVisuals(planner: Planner, facts: readonly Fact[], ctx: DecideContext): Promise<PlanResult>;
// planVisuals = planner.compose({ intent: VISUALS_INTENT, catalog: VISUALS_CATALOG, capabilities: capabilitiesOf(facts),
//                                 containers: [], surface: "web", contextClass: "sensitive" }, ctx)
```

- [ ] **Step 1: Write the failing tests**

```ts
it("planVisuals passes the conformance kit (a second compose replays with no model call)", async () => {
  const model = scriptedPlannerModel([PLAN_JSON]);   // returns a valid draft binding KeyFigure → fact-0
  const planner = new ReferencePlanner({ model, modelId: "test" });
  const findings = await checkPlannerConformance(planner, {
    intent: VISUALS_INTENT, catalog: VISUALS_CATALOG, capabilities: capabilitiesOf([FIGURE]),
    meta: { author: "test", createdAt: "2026-11-08T00:00:00Z", sourceKind: "test" },
    revision: { text: "make it smaller" }, ctx: recording(), modelCalls: () => model.calls,
  });
  expect(findings.filter((f) => f.severity === "error")).toEqual([]);
});
it("an empty draft is a valid plan with no ops", async () => {
  const plan = await planVisuals(new ReferencePlanner({ model: scriptedPlannerModel([EMPTY_JSON]), modelId: "t" }), [FIGURE], recording());
  expect(plan.ops).toEqual([]);
});
it("the load step output carries the facts, and its path is sealed", () => {
  expect(SENSITIVE_EVENT_PATHS.STEP_COMPLETED).toContain("output.facts");
  for (const p of ["choice.ops", "choice.summary", "choice.findings", "choice.report"]) expect(SENSITIVE_EVENT_PATHS.DECISION_RECORDED).toContain(p);
});
```

Take `recording()` and the scripted model from `loom-ui/docs/snippets/src/planner.test.ts`, where the planner guide's snippets live. Copy the two small helpers into `VD/testing.ts`; don't import from loom-ui's docs. `PLAN_JSON` is the draft contract: `{"nodes":[{"id":"revenue","type":"KeyFigure","label":"Revenue","span":4,"props":{},"binding":{"capability":"fact-0","arguments":{},"path":"","priority":"P0"}}]}`. Check the exact top-level key against `planner/src/contract.ts` and the snippet test before writing it.

- [ ] **Step 2: Run them and check they fail**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/visualize-document/plan.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**
  - `loadEffect` is `stepEffect("visualize-load", guard, …)`. It returns `{ facts }` through a widened result. If `stepEffect` is typed to `StepResult`, add a sibling `stepEffectOf<O>(…, outputSchema)` in Task 1's file rather than casting.
  - `VISUALS_INTENT.objective`: "Help a reader grasp this document at a glance. Show only what a visual makes clearer than prose. Prefer fewer widgets. Every widget binds one fact."
  - Sealed paths:
    - Add `"output.facts"` to `STEP_COMPLETED`.
    - Add `"choice.ops"`, `"choice.summary"`, `"choice.findings"` and `"choice.report"` to `DECISION_RECORDED`, keeping the existing four.
    - First confirm the planner's recorded choice shape. In `loom-ui/packages/planner/src/reference.ts` (around :342), `ctx.decide` returns what `this.plan(...)` resolves. If a draft or raw model text is also part of the choice, seal that path too.

- [ ] **Step 4: Run them and check they pass**

Run: `pnpm --filter @docmind/server exec vitest run app/flows/visualize-document/ app/sensitive.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/app/flows/visualize-document apps/server/app/sensitive.ts apps/server/package.json pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat(visuals): load step and the recorded planner decision (conformance-checked, sealed)"
```

---

### Task 8: Commit to lineage (gated on spec V8)

**Do not start this task** until the loom and loom-ui erasable-lineage change has merged, and its SHAs are pinned in DocMind's CI (`LOOM_REF`, and the loom-ui ref).

**Files:**
- Create: `VD/lineage.ts` (`visualsLineage(store, content, resolver)`, `experienceIdOf(ref)`, `commitPlan`)
- Create: `VD/commit.ts` (`commitEffect`)
- Test: `VD/lineage.test.ts`, `VD/lineage.erasure.pg.test.ts`
- Modify: `S/storage.ts` (register the lineage stream's subject resolver and sensitive paths with the encrypting store, using the API the V8 change delivers)
- Modify: `apps/server/package.json` and `pnpm-workspace.yaml` (link `@loom-ui/lineage`)

**Interfaces:**
- Produces:

```ts
export const experienceIdOf = (ref: VisualizeRef) => `visuals-${ref.userId}-${ref.documentId}`;
export async function commitPlan(lineage: Lineage, ref: VisualizeRef, plan: PlanResult, now: () => string): Promise<{ head: string }>;
// start(genesis) if no line, then compose({ expectedHead, ops: plan.ops.map(op => ({ op, by, at: now() })), by, summary, summaryClass })
// by = plannerProvenance(plan, { agentId: "docmind-visualizer" }); head-moved → retry once → throw
export function commitEffect(deps: { guard; lineage: Lineage; bus: ProgressBus; now }): Effect<CommitInput, StepResult>;
// CommitInput = VisualizeRef & { ops: Operation[]; summary?: string; summaryClass?: DataClass; report: PlanReport }   (sealed: STEP_STARTED input.ops/summary/report)
// after commit: bus.publish({ userId }, { documentId, status: "ready", step: "finalize", visuals: "ready" })
```

- [ ] **Step 1: Write the failing tests**
  - Unit, on `InMemoryLineageStore` and an in-memory content store:
    - The first commit creates the line, and the head's root children equal the replayed plan.
    - A second commit composes on top of the head.
    - When the head is moved concurrently, the commit retries once and then throws.
  - `lineage.erasure.pg.test.ts`, on the real `EncryptingEventStore` and a sealed content store:
    1. Commit a line for user U1.
    2. Destroy U1's key.
    3. Check that `lineage.resolveLatest` gives the typed refusal V8 delivers, that the raw events hold no plaintext label, and that the artifact blob can't be opened.
  - Add the new step input paths to `STEP_STARTED` in `sensitive.ts`. The raw-event proof must pass.

- [ ] **Step 2: Run them and check they fail.** Then implement against the V8 API. The loom session confirmed it on 2026-11-08: loom branch `feat/reserved-stream-subjects`, commit `23a71dcf`, and a loom-ui lineage change in progress. Pin the merged SHAs, not these.
  - **Events and blobs share one mapping.**
    - loom's `EncryptingEventStore` already calls the host's `subjectOf` with the stream id `__loom_ui_lineage__:<experienceId>`.
    - `EncryptingContentStore` calls it with the `ContentAccess` that `Lineage` now passes for each line. That access's `executionId` is the line's stream id.
    - In `S/storage.ts`, extend DocMind's `subjectOfExecution`: for `__loom_ui_lineage__:visuals-<userId>-<documentId>`, return the subject of `userId`. The user id is inside the experience id, so no lookup is needed.
    - Anything else under `__loom_ui_lineage__:` returns no subject. The store then refuses the write, which is the fail-closed behaviour we want.
  - **Content store.** Wrap DocMind's content store for lineage artifacts in `EncryptingContentStore` over the same `KeyStore` and `subjectOf`.
  - **Sensitive paths.** Call `registerLineageSensitivePaths(events)` from `@loom-ui/lineage` on the encrypting event store. It seals COMPOSED `ops`, `summary` and `by`, and the `by` of every other lineage event.
  - **Erasure.** DocMind's existing key destruction (`keys.destroy(subject)`) is the erasure, so the Eraser needs no change for lineage. A reserved stream is never tombstoned. `shredSubject(..., { executionIds: [] })` also works now.
  - **After erasure,** reads fail with the finding `line-erased` (`LineErasedError`). The commit step maps it to `document_gone`, and the detail route treats it as "no visuals".
  - **The erasure test** asserts `line-erased` on `resolveLatest`, `isKeyUnavailable` on the raw blob, and no plaintext label in the raw events.

  Run the tests and check they pass.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(visuals): commit the plan to lineage, erasable with the user (V8)"
```

---

### Task 9: The flow, its grants, the starter, cancel and recovery (after Task 8)

**Files:**
- Create: `VD/flow.ts`, `VD/start.ts`, `VD/deps.ts`
- Test: `VD/flow.test.ts`, `VD/start.test.ts`, `VD/recovery.test.ts`
- Modify: `S/security.ts:13` (add `"visualize-document": ["visualize-extract", "visualize-load", "visualize-commit"]`)
- Modify: `S/config.ts:104` (`FlowDeps.visualize?`, and register its effects)
- Modify: `S/compose.ts` (build the deps from `pgIngestDeps`' pool, fields and `wiring.llm.visuals`)
- Modify: `S/status/model.ts:38` (add `VISUALIZE_EXECUTION` and `isVisualizeExecution`, mirroring `INGEST_EXECUTION`)
- Modify: `S/status/ingestStatus.ts:90` (an `onReady?(ref, generation)` option, called after the fold drains when `derived.progress.status === "ready"`)
- Modify: `S/bootIngest.ts:141` (add `isVisualizeExecution` to `owns`; run the boot sweep after recovery starts; join the starter's `idle()` to `startsIdle`)
- Modify: `S/documents/routes.ts:396-460` (both cancel points also cancel visualize), `S/documents/restart.ts` (on retry, nothing extra, because the new ingest generation turns ready and starts a new visualize generation), `S/erasure/wire.ts:65` (`cancelVisualize`)
- Regenerate: `S/loom.gen.ts` with `pnpm --filter @docmind/server gen`

**Interfaces:**
- Produces:
  - `visualizeDocumentFlow: RegisteredFlow`, with id `visualize-document` and version `1.0.0`.
  - `visualizeExecutionId(userId, documentId, generation)`: `visualize-<doc>` for generation 1, and `visualize-<doc>.<gen>` otherwise.
  - `VisualsStarter { start, fire, idle, sweep }`, modelled on `loomTitleStarter`.
  - `VisualizeOutput`: `{ outcome: "done" | "empty" | "skipped" | "failed" | "document_gone", code? }`.

The runner:

```ts
export const runVisualize = (planner: () => Planner | undefined): FlowRunner<VisualizeRef, VisualizeOutput> => async (ctx, input) => {
  const extracted = await ctx.run(visualizeExtractStep, input);
  if (extracted.outcome !== "done") return { outcome: extracted.outcome, ...(extracted.code && { code: extracted.code }) };
  if (extracted.model === "none") return { outcome: "skipped" };
  if (extracted.count === 0) return { outcome: "empty" };
  const loaded = await ctx.run(visualizeLoadStep, input);
  if (loaded.outcome !== "done") return { outcome: loaded.outcome };
  const p = planner();
  if (!p) return { outcome: "skipped" };
  const plan = await planVisuals(p, loaded.facts, ctx);
  if (plan.findings.some((f) => f.severity === "error")) return { outcome: "failed", code: "visuals-plan-invalid" };
  if (plan.ops.length === 0) return { outcome: "empty" };
  const committed = await ctx.run(visualizeCommitStep, { ...input, ops: plan.ops, report: plan.report, ...(plan.summary && { summary: plan.summary, summaryClass: plan.summaryClass }) });
  return committed.outcome === "done" ? { outcome: "done" } : { outcome: committed.outcome };
};
```

Note: the extract step's `model: "none"` already covers a missing role. The `planner()` check is a second guard for a role that turned off between steps.

The tests to write first:
- `flow.test.ts`: pins the step ids, retry policies and version, using `fakeIngestDeps`-style in-memory fakes and an in-memory Loom app. Cover done, empty, skipped and failed, plus a raw-event content proof (`assertEventsAreContentFree`).
- `start.test.ts`:
  - `fire` is idempotent through `ExecutionAlreadyExistsError`.
  - `onReady` from `IngestStatus` starts exactly one execution per (document, generation).
  - `sweep` starts ready documents with no visualize execution and skips the others. It queries `documents` joined to `ingest_status`, plus Loom's execution existence check. Use `runtime.query` if available; otherwise rely on `ExecutionAlreadyExistsError`.
- `recovery.test.ts`: an interrupted visualize execution is resumed by `startRecovery` with the new `owns`.
- `documents/*.test.ts`: delete cancels visualize at both points. `erasure`: `cancelVisualize` is called once per document.

Run: `pnpm --filter @docmind/server test`
Expected: PASS. Commit: `feat(visuals): visualize-document flow, starter on ready + boot sweep, cancel and recovery`.

---

### Task 10: The per-document detail experience (pure; can land before the gate)

**Files:**
- Modify: `PE/views.ts` (factor `detailChildren()` and `detailProviders()` out of `detail()`; add `detailWithVisuals`)
- Modify: `PE/compose.ts` (if `ordered()` caps siblings at 26, nothing changes; the visuals panel is a single child)
- Test: `PE/views.test.ts`

**Interfaces:**
- Produces: `detailWithVisuals(visuals: Experience | null, documentId: string): Experience`. With `null`, it equals `EXPERIENCES.detail`. Otherwise the `tabs` container gets a fourth `panel("visuals", "Visuals", …)` holding the visuals root's children, plus `factProvider(n, documentId, node.type)` for each node bound to `fact-n`. The node's `type` is the visuals catalogue entry name. If two nodes bind the same fact with different entries, the second node's handle becomes `fact-n-b`, with its own provider. Node ids are prefixed `v-` so they can't collide with the static ids.

- [ ] **Step 1: Write the failing tests**

```ts
it("without visuals it is the static detail", () => {
  expect(detailWithVisuals(null, DOC).versionHash).toBe(EXPERIENCES.detail.versionHash);
});
it("adds a Visuals panel after Content with prefixed ids and one provider per bound fact", () => {
  const exp = detailWithVisuals(sampleVisuals(), DOC);    // sampleVisuals: genesis + replay of a KeyFigure bound to fact-0
  const tabs = findNode(exp, "tabs");
  expect(tabs.children.map((c) => c.id)).toEqual(["summary", "analysis", "content", "visuals"]);
  expect(findNode(exp, "visuals").children.every((c) => c.id.startsWith("v-"))).toBe(true);
  expect(Object.keys(exp.providers)).toContain("fact-0");
});
it("compiles for web and terminal with no findings", () => {
  for (const surface of ["web", "terminal"]) {
    const r = compile(detailWithVisuals(sampleVisuals(), DOC), { surface, catalog: mergedCatalog(), hydrationProjectionId: "p", hydrationProjectionVersion: "1", viewer: {}, placeholderKey: KEY });
    expect(r.findings).toEqual([]);
  }
});
```

`mergedCatalog()` is `defineSemanticCatalog({ id: "docmind.detail+visuals.v1", entries: [...DOCMIND_CATALOG.entries, ...VISUALS_CATALOG.entries] })`. Export it from `PE/visuals.ts`. The per-document compile uses it.

- [ ] **Step 2: Run them and check they fail.** Implement by building with the existing `build()`, `panel()` and `tabs()` helpers. Copy each visuals root child with `id: "v-" + id`, keeping its binding handle. Run the tests and check they pass.

Run: `pnpm --filter @docmind/experiences test`
Commit: `feat(visuals): detailWithVisuals builds the per-document detail experience`.

---

### Task 11: Serving the per-document detail, hydrate, SSE and the web (after Task 9)

**Files:**
- Modify: `packages/contracts/src/ui.ts` (`UiHydrateRequest` accepts `{ document: Uuid }` as an alternative to `view`), and `packages/contracts/src/documents.ts:117` (`DocumentProgressEvent.visuals?: "ready"`)
- Modify: `PE/views-api.ts` (`Views.documentPayload(documentId, visuals, surface)` and `Views.hydrateExperience(experience, requests, readers, principalId)`; `hydrate` delegates to the latter for static views)
- Modify: `PE/payload.ts` (`compileDetail(experience, surface)`, with an LRU of 256 entries keyed `${surface}:${versionHash}`)
- Modify: `S/ui/routes.ts` (`GET /api/ui/documents/:id/detail` reads the lineage head via `lineage.resolveLatest(experienceIdOf(ref))`, owner-checked, then `documentPayload`; `POST /api/ui/hydrate` with `document` rebuilds the same experience and hydrates against it)
- Modify: `WEB/api/client.ts` (`uiDocumentDetail(id, signal)`; `uiHydrate` accepts the document form), `WEB/ui/session.ts` (`ViewSession.open` takes a `ViewSource = { view: ViewName } | { document: string }`), `WEB/components/dm-doc-detail.ts` (open `{ document: route.id }`; on a progress event with `visuals === "ready"` for this document, call `session.reload()`), `WEB/testing/fakeServer.ts` (fake both new endpoints)
- Test: `S/ui/routes.test.ts`, `S/ui/ui.pg.test.ts`, `WEB/ui/session.test.ts`, `WEB/components/dm-doc-detail.test.ts`

**Tests to write first:**
- The route answers 404 for a document the user doesn't own, never 403, as the other document routes do.
- With no head, the payload equals the static detail's blueprint.
- Hydrating `fact-0` through `{ document }` makes one `visualFacts` read.
- The web detail page reloads (re-GETs) on `visuals: "ready"` and only invalidates on other progress events.

Run: `pnpm test`. Commit: `feat(visuals): serve and hydrate the per-document detail; reload on visuals ready`.

---

### Task 12: End to end and docs (after Task 11)

**Files:**
- Create: `S/documents/visuals.e2e.pg.test.ts` (uses `startDocumentServer` and `uploadAndAwaitTerminal` from `S/documents/testHarness.ts`, with a stub `visuals` model that returns one figure fact and a plan binding it)
- Modify: `README.org` (Status table, and a sentence under Architecture on the new flow), `docs/architecture.md` (the visualize flow after ingest), `docs/codebase-guide.md` (where `flows/visualize-document` sits)

**The e2e test checks:**
1. Upload a text document stating "Revenue was 1,200 in 2024".
2. The ingest status reaches `ready`, then the visualize execution ends `done`.
3. `GET /api/ui/documents/:id/detail` has a `visuals` panel.
4. Hydrating `fact-0` returns `{ value: 1200, … }`. Its citation resolves through `/api/documents/:id/source`.
5. `DELETE` the document. The detail returns 404, and the facts are gone.
6. A second user erases their account. Their lineage line is unreadable and their raw events hold no label.
7. With `DOCMIND_VISUALS_PROVIDER=off`, the flow ends `skipped` and no panel is served.

Run: `pnpm test && pnpm typecheck && pnpm typecheck:tests && pnpm lint`. Commit: `test(visuals): end to end; docs: document visuals`.

---

## Self-review notes

- **Spec coverage:**

  | Spec section | Task |
  |---|---|
  | §3 trigger | 9 |
  | §4 role | 2 |
  | §5 extraction and storage | 3, 4, 5 |
  | §6 catalogue, capabilities, decision, lineage | 6, 7, 8 |
  | §7 serving and SSE | 10, 11 |
  | §8 failure, erasure, tests | 4, 8, 9, 12 |

- **Spec change made here:** the spec's single `visualize-plan` step is implemented as the load step, a runner-level `ctx.decide` (the planner needs the flow's `ctx`), and a commit step. The spec's §3 step list is updated in Task 7's commit.
- **Open, owned by others:**
  - The V8 API shape, used by Task 8.
  - The planner's exact recorded choice paths, verified in Task 7, step 3.
