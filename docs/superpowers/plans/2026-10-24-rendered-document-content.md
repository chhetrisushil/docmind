# Rendered Document Content Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Markdown and Org uploads read as one continuous, formatted document on the Content tab (plain `.txt` as preformatted text), a cited passage scrolls into view and is marked, and every other format keeps today's passage list.

**Architecture:** loom-ui gains a document profile of its hardened chat markdown parser (with per-block source ranges), a hand-written Org parser that emits the same AST, and a bound `Prose` kind (lit + terminal) that draws it block by block. DocMind serves a document's stored original through a new owner-scoped reader (`GET /api/documents/:id/source`, UI target `document.source`), and the detail page shows `Prose` for md/org/txt or the passage list otherwise.

**Tech Stack:** TypeScript, Lit 3, vitest (happy-dom in renderer-lit), zod, Postgres (RLS + `withTenant`), pnpm workspaces (DocMind pnpm 12, loom-ui pnpm 9), turbo, biome.

**Spec:** `docs/specs/2026-10-24-rendered-document-content-design.md` (read it first).

## Global Constraints

- Two repos: `/Users/such/workspace/loom-ui` (Tasks 1-4) then `/Users/such/workspace/docmind` (Tasks 5-9). DocMind links the sibling loom-ui checkout via `pnpm-workspace.yaml` overrides; CI pins it with `LOOM_UI_REF` in `.github/workflows/ci.yml`.
- One branch and one **draft** PR per task, at most ~200 changed lines / 10 files (Task 4 is the stated exception: loom-ui's AGENTS.md requires a kind to land in core, lit and terminal in one change). Merge with `gh pr merge --rebase` only. Actions is blocked by billing, so the local gate is the gate.
- loom-ui gate: `pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test && pnpm build` (needs `../loom` built). DocMind gate: `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`; PG suites need `DOCMIND_TEST_PG_URL` (local PG on port 55432, `pnpm db:start`).
- loom-ui rules (AGENTS.md): core stays pure (no DOM, no Node, no dependency for markdown); every fixed user-visible English string is an `LU_MESSAGES` key (`say()` in lit, `x.say` in terminal) listed in the renderer READMEs; no `innerHTML`/`unsafeHTML`/`style=`; never name a consumer (no "DocMind", "docmind") anywhere in loom-ui; never `workspace:*`.
- DocMind rules (docs/codebase-guide.md): every read owner-scoped (`withTenant` + owner check + erasure check); errors and logs carry class names, never content; `cache-control: no-store` on anything returning document text; packages never import from apps.
- Bounds: document source text at most `1_000_000` UTF-16 units server-side; loom-ui document parsers at most `1_048_576` characters and `100_000` nodes, then `truncated: true`.
- Links stay http/https/mailto only (`safeLinkHref`), everywhere.
- Commits end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`; PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Shell: bare `ls` is eza and can hang; use `command ls`.

## File Map

loom-ui (`packages/`):
- `core/src/chatMdTypes.ts` (modify): `MdState` gains optional `maxNodes`, `maxTableRows`, `spans`; `take` honours `maxNodes`.
- `core/src/chatMdBlock.ts` (modify): `parseBlocks` honours `maxTableRows` and records top-level line spans.
- `core/src/mdDocument.ts` (create): `parseMarkdownDocument`, `MdDocument`, `MdRange`, document bounds, shared line/offset helpers.
- `core/src/orgDocument.ts` (create): `parseOrgDocument` (blocks). `core/src/orgInline.ts` (create): Org inline parser.
- `core/src/chatUi.ts` (modify): export the new API.
- `core/src/kindValues.ts`, `core/src/values.ts`, `core/src/browser.ts`, `core/src/messages.ts` (modify): `Prose` contract, value type, message keys.
- `renderer-lit/src/widgets/chatMarkdown.ts` (modify): exports `markdownStyles` (moved from lu-chat). `renderer-lit/src/widgets/lu-chat.ts` (modify): uses it.
- `renderer-lit/src/widgets/lu-prose.ts`, `define/lu-prose.ts`, `elements/lu-prose.ts` (create); `defineAll.ts`, `widgets/index.ts`, `index.ts`, `dom/litRegistry.ts` (modify).
- `renderer-terminal/src/registry.ts` (modify): `Prose` renderer.

DocMind:
- `packages/parsers/src/index.ts` (modify): export `decodeText`.
- `packages/contracts/src/documents.ts` (modify): `DocumentSourceResponse`.
- `apps/server/app/documents/source.ts` (create): `readSource`. `apps/server/app/documents/routes.ts` (modify): `GET /api/documents/:id/source`.
- `packages/experiences/src/invoker.ts`, `providers.ts` (modify): target `document.source`. `apps/server/app/ui/readers.ts`, `apps/server/app/compose.ts`, `apps/server/app/documents/testHarness.ts` (modify): reader wiring.
- `packages/experiences/src/catalog.ts`, `views.ts`, `reshapers.ts` (modify): `Prose` kind, `DocumentProse` entry, `doc-source` provider, `detail-source` reshaper.
- `apps/web/src/ui/elements.ts`, `apps/web/src/components/dm-doc-detail.ts`, `apps/web/src/testing/fakeUi.ts`, `apps/web/src/testing/fakeServer.ts` (modify).
- `.github/workflows/ci.yml` (modify): `LOOM_UI_REF`.

---

### Task 1: loom-ui core: `parseMarkdownDocument` (document profile with source ranges)

Repo `loom-ui`, branch `feat/core-markdown-document`.

**Files:**
- Modify: `packages/core/src/chatMdTypes.ts:55-79` (`MdState`, `take`)
- Modify: `packages/core/src/chatMdBlock.ts:134-280` (`parseBlocks`)
- Create: `packages/core/src/mdDocument.ts`
- Modify: `packages/core/src/chatUi.ts` (exports)
- Test: `packages/core/src/mdDocument.test.ts`

**Interfaces:**
- Produces (exported from `@loom-ui/core/chat-ui`, `@loom-ui/core/chat` and the root):
  - `interface MdRange { readonly from: number; readonly to: number }` (UTF-16 offsets into the input, `to` exclusive)
  - `interface MdDocument extends MdDoc { readonly ranges: readonly MdRange[] }` (`ranges[i]` is the source range of `blocks[i]`)
  - `parseMarkdownDocument(text: unknown): MdDocument`
  - `MD_DOC_MAX_TEXT = 1_048_576`, `MD_DOC_MAX_NODES = 100_000`, `MD_DOC_MAX_TABLE_ROWS = 1_000`
- Produces (core-internal, used by Task 2): `documentLines(text: string): { lines: string[]; starts: number[]; raw: string[]; truncated: boolean }` and `spansToRanges(spans, starts, raw): MdRange[]` from `mdDocument.ts`; `MdState.spans?: { line: number; end: number }[]`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/core/src/mdDocument.test.ts
import { describe, expect, it } from "vitest";
import { parseChatMarkdown } from "./chatMarkdown";
import { MD_DOC_MAX_NODES, MD_DOC_MAX_TEXT, parseMarkdownDocument } from "./mdDocument";

const slice = (text: string, i: number) => {
  const d = parseMarkdownDocument(text);
  const r = d.ranges[i];
  if (!r) throw new Error(`no range ${i}`);
  return text.slice(r.from, r.to);
};

describe("parseMarkdownDocument", () => {
  it("draws the same AST as chat for small input", () => {
    const text = "# Title\n\nSome *em* and `code`.\n\n- a\n- b\n";
    expect(parseMarkdownDocument(text).blocks).toEqual(parseChatMarkdown(text).blocks);
  });

  it("gives every top-level block its exact source range", () => {
    const text = "# Title\n\npara one\nstill one\n\n```js\nx()\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quote\n";
    const d = parseMarkdownDocument(text);
    expect(d.blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "code", "table", "quote"]);
    expect(d.ranges).toHaveLength(d.blocks.length);
    expect(slice(text, 0)).toBe("# Title");
    expect(slice(text, 1)).toBe("para one\nstill one");
    expect(slice(text, 2)).toBe("```js\nx()\n```");
    expect(slice(text, 3)).toBe("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(slice(text, 4)).toBe("> quote");
  });

  it("keeps offsets exact across CRLF, tabs and unsafe characters", () => {
    const text = "a‮b\r\n\r\n\tcode-ish para\r\n";
    const d = parseMarkdownDocument(text);
    expect(d.ranges[0]).toEqual({ from: 0, to: 3 });
    expect(text.slice(d.ranges[1]?.from, d.ranges[1]?.to)).toBe("\tcode-ish para");
  });

  it("does not fold blank runs (unlike chat)", () => {
    const text = "one\n\n\n\n\ntwo";
    const d = parseMarkdownDocument(text);
    expect(d.ranges.map((r) => text.slice(r.from, r.to))).toEqual(["one", "two"]);
  });

  it("is not cut at the chat limits", () => {
    const text = Array.from({ length: 5000 }, (_, i) => `para ${i}`).join("\n\n");
    const d = parseMarkdownDocument(text);
    expect(d.blocks).toHaveLength(5000);
    expect(d.truncated).toBe(false);
  });

  it("is cut at the document node budget", () => {
    const text = "x\n\n".repeat(MD_DOC_MAX_NODES);
    const d = parseMarkdownDocument(text);
    expect(d.truncated).toBe(true);
    expect(d.ranges).toHaveLength(d.blocks.length);
  });

  it("is cut at the document text bound, on a line boundary", () => {
    const text = `${"y".repeat(10)}\n\n${"z".repeat(MD_DOC_MAX_TEXT)}`;
    const d = parseMarkdownDocument(text);
    expect(d.truncated).toBe(true);
    expect(d.blocks).toHaveLength(1);
  });

  it("is total on non-strings", () => {
    expect(parseMarkdownDocument(42)).toEqual({ blocks: [], ranges: [], truncated: false });
  });

  it("leaves parseChatMarkdown's bounds alone", () => {
    const text = "x\n\n".repeat(3000);
    expect(parseChatMarkdown(text).truncated).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && pnpm vitest run src/mdDocument.test.ts`
Expected: FAIL, `Cannot find module './mdDocument'`.

- [ ] **Step 3: Extend `MdState` and `take` (`chatMdTypes.ts`)**

```ts
export interface MdState {
  nodes: number;
  truncated: boolean;
  readonly markers: boolean;
  readonly streaming: boolean;
  /** Node budget; absent = {@link MD_MAX_NODES} (chat). The document profile raises it. */
  readonly maxNodes?: number;
  /** Rows per table; absent = {@link MD_MAX_TABLE_ROWS} (chat). */
  readonly maxTableRows?: number;
  /** When present, `parseBlocks` records each TOP-LEVEL block's line span here, parallel to its result. */
  readonly spans?: { line: number; end: number }[];
  /** Test-only work counter: bumped once per scanned character or delimiter step. Absent in production. */
  readonly meter?: { steps: number };
}
```

and in `take`, replace `if (st.nodes >= MD_MAX_NODES) {` with `if (st.nodes >= (st.maxNodes ?? MD_MAX_NODES)) {`.

- [ ] **Step 4: Record spans and honour `maxTableRows` in `parseBlocks` (`chatMdBlock.ts`)**

At the top of `parseBlocks`, after `let i = 0;`:

```ts
  // Top-level only: nested calls get re-sliced line arrays, so only depth 0 maps to source lines.
  const spans = depth === 0 ? st.spans : undefined;
  let open: { line: number; count: number } | undefined;
  // Every branch pushes at most one block and leaves `i` past its last line, so the span of the block a
  // branch pushed is [open.line, i). A branch that pushed nothing (a table cut by the node budget) records nothing.
  const flush = (): void => {
    if (spans && open && out.length > open.count) spans.push({ line: open.line, end: i });
    open = undefined;
  };
```

Make the first statement of the `while (i < n) {` body `flush();`, and right after `if (!take(st)) break;` add `if (spans) open = { line: i, count: out.length };`. After the loop, before `return out;`, add `flush();`. Replace `if (rows.length >= MD_MAX_TABLE_ROWS) {` with `if (rows.length >= (st.maxTableRows ?? MD_MAX_TABLE_ROWS)) {`.

Note the paragraph and list branches end with `i` on the following blank line (exclusive end) and the blank-line skip at the top of the loop runs after `flush()`, so trailing blank lines never enter a span.

- [ ] **Step 5: Create `mdDocument.ts`**

```ts
// ── Markdown documents ──────────────────────────────────────────────────────────────────────────────
//
// The document profile of `parseChatMarkdown`: the SAME closed subset, block and inline parsers, link rule and
// AST (so `drawMarkdown` draws it unchanged), for a whole stored document rather than a chat reply. It differs in
// three ways: larger bounds ({@link MD_DOC_MAX_TEXT} characters, {@link MD_DOC_MAX_NODES} nodes, then `truncated`);
// unsafe characters are stripped per line but blank runs are NOT folded and nothing is cut mid-line, so line
// offsets stay exact; and every top-level block carries its source range, so a caller can find the block that
// holds a given character offset (a cited passage). Total, linear, never throws.

import { parseBlocks } from "./chatMdBlock";
import type { MdDoc, MdState } from "./chatMdTypes";
import { stripUnsafeChars } from "./chatText";

export const MD_DOC_MAX_TEXT = 1_048_576;
export const MD_DOC_MAX_NODES = 100_000;
export const MD_DOC_MAX_TABLE_ROWS = 1_000;

/** A range of UTF-16 offsets into the parsed input; `to` is exclusive. */
export interface MdRange {
  readonly from: number;
  readonly to: number;
}

/** An {@link MdDoc} whose `ranges[i]` is the source range of `blocks[i]`. */
export interface MdDocument extends MdDoc {
  readonly ranges: readonly MdRange[];
}

/**
 * The input as lines for a block parser: `lines` cleaned (unsafe characters stripped, a trailing `\r` dropped,
 * tabs as four spaces), `raw` and `starts` as they were in the input, so a line index maps back to offsets.
 * Over {@link MD_DOC_MAX_TEXT} the text is cut at the last line break before the bound.
 */
export function documentLines(text: string): {
  lines: string[];
  starts: number[];
  raw: string[];
  truncated: boolean;
} {
  let body = text;
  let truncated = false;
  if (body.length > MD_DOC_MAX_TEXT) {
    const cut = body.lastIndexOf("\n", MD_DOC_MAX_TEXT);
    body = body.slice(0, cut > 0 ? cut : MD_DOC_MAX_TEXT);
    truncated = true;
  }
  const raw = body.split("\n");
  const starts: number[] = [];
  let at = 0;
  for (const r of raw) {
    starts.push(at);
    at += r.length + 1;
  }
  const lines = raw.map((r) =>
    stripUnsafeChars(r.endsWith("\r") ? r.slice(0, -1) : r).replace(/\t/g, "    "),
  );
  return { lines, starts, raw, truncated };
}

/** Line spans to source ranges; a range never includes a line's trailing `\r`. */
export function spansToRanges(
  spans: readonly { line: number; end: number }[],
  starts: readonly number[],
  raw: readonly string[],
): MdRange[] {
  return spans.map(({ line, end }) => {
    const last = raw[end - 1] ?? "";
    const trim = last.endsWith("\r") ? 1 : 0;
    return { from: starts[line] ?? 0, to: (starts[end - 1] ?? 0) + last.length - trim };
  });
}

/** Parse untrusted `text` as a whole markdown document (see the header). Non-strings are an empty document. */
export function parseMarkdownDocument(text: unknown): MdDocument {
  return parseMarkdownDocumentWith(text, undefined);
}

/** {@link parseMarkdownDocument} with a work meter; for the bounds tests only. */
export function parseMarkdownDocumentWith(
  text: unknown,
  meter: { steps: number } | undefined,
): MdDocument {
  if (typeof text !== "string") return { blocks: [], ranges: [], truncated: false };
  const { lines, starts, raw, truncated } = documentLines(text);
  const spans: { line: number; end: number }[] = [];
  const st: MdState = {
    nodes: 0,
    truncated,
    markers: false,
    streaming: false,
    maxNodes: MD_DOC_MAX_NODES,
    maxTableRows: MD_DOC_MAX_TABLE_ROWS,
    spans,
    ...(meter && { meter }),
  };
  const blocks = parseBlocks(lines, 0, st);
  return { blocks, ranges: spansToRanges(spans, starts, raw), truncated: st.truncated };
}
```

- [ ] **Step 6: Export from `chatUi.ts`**

Add next to the `./chatMarkdown` re-exports:

```ts
export {
  MD_DOC_MAX_NODES,
  MD_DOC_MAX_TABLE_ROWS,
  MD_DOC_MAX_TEXT,
  parseMarkdownDocument,
  type MdDocument,
  type MdRange,
} from "./mdDocument";
```

(`parseMarkdownDocumentWith`, `documentLines` and `spansToRanges` stay internal.)

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd packages/core && pnpm vitest run src/mdDocument.test.ts`
Expected: PASS (9 tests). If "keeps offsets exact" fails on the first range, check that `spansToRanges` trims the `\r` and that the `‮` was stripped only from `lines`, not `raw`.

- [ ] **Step 8: Add the linear-work test**

Append to `mdDocument.test.ts`:

```ts
import { parseMarkdownDocumentWith } from "./mdDocument";

describe("parseMarkdownDocument work is linear", () => {
  const gens: Record<string, (k: number) => string> = {
    paragraphs: (k) => "p\n\n".repeat(k),
    "quote chain": (k) => "> ".repeat(k),
    "list chain": (k) => "- ".repeat(k),
    fences: (k) => "```\n".repeat(k),
    "table rows": (k) => `| a | b |\n|---|---|\n${"| 1 | 2 |\n".repeat(k)}`,
    emphasis: (k) => "*a ".repeat(k),
  };
  for (const [name, mk] of Object.entries(gens)) {
    it(name, () => {
      const run = (t: string) => {
        const meter = { steps: 0 };
        parseMarkdownDocumentWith(t, meter);
        return meter.steps;
      };
      const a = run(mk(4000));
      const b = run(mk(8000));
      expect(b).toBeLessThanOrEqual(1000 * mk(8000).length);
      expect(b).toBeLessThanOrEqual(2.5 * Math.max(a, 1));
    });
  }
});
```

Run: `cd packages/core && pnpm vitest run src/mdDocument.test.ts` — Expected: PASS.

- [ ] **Step 9: Full core gate, then commit**

Run: `cd /Users/such/workspace/loom-ui && pnpm --filter @loom-ui/core test && pnpm typecheck && pnpm typecheck:tests && pnpm lint`
Expected: all pass (the chat markdown suites are unchanged because every new `MdState` field is optional).

```bash
git add packages/core/src/chatMdTypes.ts packages/core/src/chatMdBlock.ts packages/core/src/mdDocument.ts packages/core/src/mdDocument.test.ts packages/core/src/chatUi.ts
git commit -m "feat(core): parseMarkdownDocument, the document profile with source ranges

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Push, open a draft PR, rebase-merge after review.

---

### Task 2: loom-ui core: `parseOrgDocument`

Repo `loom-ui`, branch `feat/core-org-document` (from main after Task 1).

**Files:**
- Create: `packages/core/src/orgInline.ts`, `packages/core/src/orgDocument.ts`
- Modify: `packages/core/src/chatUi.ts`
- Test: `packages/core/src/orgDocument.test.ts`

**Interfaces:**
- Consumes: `documentLines`, `spansToRanges`, `MdDocument`, `MD_DOC_MAX_NODES`, `MD_DOC_MAX_TABLE_ROWS` (Task 1); `take`, `work`, `safeLinkHref`, `MD_MAX_INLINE_DEPTH`, `MD_MAX_TABLE_COLS`, `MdBlock`, `MdInline`, `MdState` (`chatMdTypes.ts`).
- Produces: `parseOrgDocument(text: unknown): MdDocument` and `parseOrgDocumentWith(text, meter)` (internal), exported `parseOrgDocument` from `@loom-ui/core/chat-ui`.

- [ ] **Step 1: Write the failing tests (one per spec table row, plus ranges and bounds)**

```ts
// packages/core/src/orgDocument.test.ts
import { describe, expect, it } from "vitest";
import { parseOrgDocument, parseOrgDocumentWith } from "./orgDocument";

const blocks = (t: string) => parseOrgDocument(t).blocks;
const t = (text: string) => ({ type: "text", text });

describe("parseOrgDocument blocks", () => {
  it("headlines become headings 1-6, dropping TODO, priority and tags", () => {
    expect(blocks("* TODO [#A] Plan the week :work:urgent:\n******* deep")).toEqual([
      { type: "heading", level: 1, inlines: [t("Plan the week")] },
      { type: "heading", level: 6, inlines: [t("deep")] },
    ]);
  });
  it("#+TITLE is a level-1 heading; other keywords and comments are dropped", () => {
    expect(blocks("#+TITLE: Notes\n#+AUTHOR: me\n# a comment\nbody")).toEqual([
      { type: "heading", level: 1, inlines: [t("Notes")] },
      { type: "paragraph", inlines: [t("body")] },
    ]);
  });
  it("emphasis: bold, italic, verbatim, code; underline and strike stay text", () => {
    expect(blocks("*b* /i/ =v= ~c~ _u_ +s+")).toEqual([
      {
        type: "paragraph",
        inlines: [
          { type: "strong", children: [t("b")] },
          t(" "),
          { type: "em", children: [t("i")] },
          t(" "),
          { type: "code", text: "v" },
          t(" "),
          { type: "code", text: "c" },
          t(" _u_ +s+"),
        ],
      },
    ]);
  });
  it("a marker inside a word is text", () => {
    expect(blocks("a*b*c 2/3/4")).toEqual([{ type: "paragraph", inlines: [t("a*b*c 2/3/4")] }]);
  });
  it("links: [[url][label]] and [[url]]; unsafe schemes keep only their label", () => {
    expect(blocks("[[https://a.example/x][the site]] [[mailto:me@a.example]] [[javascript:alert(1)][bad]]")).toEqual([
      {
        type: "paragraph",
        inlines: [
          { type: "link", href: "https://a.example/x", children: [t("the site")] },
          t(" "),
          { type: "link", href: "mailto:me@a.example", children: [t("mailto:me@a.example")] },
          t(" bad"),
        ],
      },
    ]);
  });
  it("lists: - + bullets and 1. 1) ordered", () => {
    expect(blocks("- a\n+ b\n\n3. x\n4) y")).toEqual([
      { type: "list", ordered: false, start: 1, items: [[{ type: "paragraph", inlines: [t("a")] }], [{ type: "paragraph", inlines: [t("b")] }]] },
      { type: "list", ordered: true, start: 3, items: [[{ type: "paragraph", inlines: [t("x")] }], [{ type: "paragraph", inlines: [t("y")] }]] },
    ]);
  });
  it("SRC and EXAMPLE blocks are code; QUOTE is a quote", () => {
    expect(blocks("#+BEGIN_SRC python\nprint(1)\n#+END_SRC\n#+begin_example\nraw *x*\n#+end_example\n#+BEGIN_QUOTE\nsaid /so/\n#+END_QUOTE")).toEqual([
      { type: "code", lang: "python", text: "print(1)" },
      { type: "code", text: "raw *x*" },
      { type: "quote", blocks: [{ type: "paragraph", inlines: [t("said "), { type: "em", children: [t("so")] }] }] },
    ]);
  });
  it("tables: the row above |---+---| is the head", () => {
    expect(blocks("| a | b |\n|---+---|\n| 1 | 2 |")).toEqual([
      { type: "table", align: [null, null], head: [[t("a")], [t("b")]], rows: [[[t("1")], [t("2")]]] },
    ]);
  });
  it("a table without a rule has no head row: every row is a body row under an empty head", () => {
    expect(blocks("| 1 | 2 |")).toEqual([
      { type: "table", align: [null, null], head: [[], []], rows: [[[t("1")], [t("2")]]] },
    ]);
  });
  it("five or more dashes are a rule", () => {
    expect(blocks("-----")).toEqual([{ type: "rule" }]);
  });
  it("drawers and planning lines are dropped", () => {
    expect(blocks("* H\nSCHEDULED: <2026-10-24>\n:PROPERTIES:\n:ID: x\n:END:\nbody")).toEqual([
      { type: "heading", level: 1, inlines: [t("H")] },
      { type: "paragraph", inlines: [t("body")] },
    ]);
  });
  it("an unclosed block runs to the end", () => {
    expect(blocks("#+BEGIN_SRC\nx")).toEqual([{ type: "code", text: "x" }]);
  });
});

describe("parseOrgDocument ranges and bounds", () => {
  it("every top-level block has its source range", () => {
    const text = "* H\n\npara\nmore\n\n#+BEGIN_SRC\nx\n#+END_SRC";
    const d = parseOrgDocument(text);
    expect(d.ranges.map((r) => text.slice(r.from, r.to))).toEqual(["* H", "para\nmore", "#+BEGIN_SRC\nx\n#+END_SRC"]);
  });
  it("is total on non-strings", () => {
    expect(parseOrgDocument(null)).toEqual({ blocks: [], ranges: [], truncated: false });
  });
  const gens: Record<string, (k: number) => string> = {
    "open bold": (k) => "*a ".repeat(k),
    "open links": (k) => "[[".repeat(k),
    paragraphs: (k) => "p\n\n".repeat(k),
    "nested emphasis": (k) => "*/".repeat(k),
    "table rows": (k) => `| a |\n|---|\n${"| 1 |\n".repeat(k)}`,
  };
  for (const [name, mk] of Object.entries(gens)) {
    it(`work stays near-linear: ${name}`, () => {
      const run = (s: string) => {
        const meter = { steps: 0 };
        parseOrgDocumentWith(s, meter);
        return meter.steps;
      };
      const a = run(mk(4000));
      const b = run(mk(8000));
      expect(b).toBeLessThanOrEqual(2.5 * Math.max(a, 1));
    });
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && pnpm vitest run src/orgDocument.test.ts` — Expected: FAIL, module not found.

- [ ] **Step 3: Write `orgInline.ts`**

```ts
// ── Org inline markup ────────────────────────────────────────────────────────────────────────────────
//
// A closed subset, emitted as the markdown AST: *bold* -> strong, /italic/ -> em (both nest), =verbatim= and
// ~code~ -> code; [[url][label]] and [[url]] -> link when `safeLinkHref` accepts the url, else the label as text.
// _underline_ and +strike+ stay text. A marker opens only at the start or after whitespace or one of -({'" and
// closes only before the end, whitespace or punctuation; its content may not start or end with whitespace.
// Closers are pre-indexed per marker (one forward pointer each), so the scan is linear in the input.

import { MD_MAX_INLINE_DEPTH, type MdInline, type MdState, safeLinkHref, take, work } from "./chatMdTypes";

const MARKERS = "*/=~";
const PRE = /[\s\-({'"]/;
const POST = /[\s\-.,:!?;'")}\[]/;

function closersOf(s: string): Map<string, number[]> {
  const at = new Map<string, number[]>(Array.from(MARKERS, (m) => [m, []]));
  for (let i = 1; i < s.length; i++) {
    const c = s[i] as string;
    const list = at.get(c);
    if (list && !/\s/.test(s[i - 1] as string) && (i + 1 === s.length || POST.test(s[i + 1] as string)))
      list.push(i);
  }
  return at;
}

export function parseOrgInlines(source: string, st: MdState): MdInline[] {
  const closers = closersOf(source);
  const ends: number[] = [];
  for (let at = source.indexOf("]]"); at !== -1; at = source.indexOf("]]", at + 1)) ends.push(at);
  let endK = 0;
  /** The first `]]` at or after `from` and before `limit`, or -1. The pointer only moves forward. */
  const linkEnd = (from: number, limit: number): number => {
    while (endK < ends.length && (ends[endK] as number) < from) {
      work(st);
      endK++;
    }
    const e = ends[endK];
    return e !== undefined && e < limit ? e : -1;
  };
  const next = new Map<string, number>(Array.from(MARKERS, (m) => [m, 0]));
  /** The first closer of `m` after `from` and before `limit`, or -1. Pointers only move forward. */
  const closer = (m: string, from: number, limit: number): number => {
    const list = closers.get(m) as number[];
    let k = next.get(m) as number;
    while (k < list.length && (list[k] as number) <= from) {
      work(st);
      k++;
    }
    next.set(m, k);
    const c = list[k];
    return c !== undefined && c < limit ? c : -1;
  };
  const run = (from: number, to: number, depth: number): MdInline[] => {
    const out: MdInline[] = [];
    let text = "";
    const flush = () => {
      if (text !== "" && take(st)) out.push({ type: "text", text });
      text = "";
    };
    let i = from;
    while (i < to) {
      work(st);
      const c = source[i] as string;
      if (c === "[" && source.startsWith("[[", i)) {
        const end = linkEnd(i + 2, to);
        if (end !== -1) {
          const inner = source.slice(i + 2, end);
          const split = inner.indexOf("][");
          const url = split === -1 ? inner : inner.slice(0, split);
          const label = split === -1 ? inner : inner.slice(split + 2);
          const href = safeLinkHref(url);
          flush();
          if (href && take(st)) out.push({ type: "link", href, children: [{ type: "text", text: label }] });
          else text += label;
          work(st, end + 2 - i);
          i = end + 2;
          continue;
        }
      }
      const opens =
        MARKERS.includes(c) &&
        (i === 0 || PRE.test(source[i - 1] as string)) &&
        i + 1 < to &&
        !/\s/.test(source[i + 1] as string);
      const close = opens ? closer(c, i + 1, to) : -1;
      if (close !== -1) {
        flush();
        if (!take(st)) return out;
        if (c === "=" || c === "~") out.push({ type: "code", text: source.slice(i + 1, close) });
        else {
          const children = depth < MD_MAX_INLINE_DEPTH ? run(i + 1, close, depth + 1) : [{ type: "text" as const, text: source.slice(i + 1, close) }];
          out.push({ type: c === "*" ? "strong" : "em", children });
        }
        i = close + 1;
        continue;
      }
      text += c;
      i++;
    }
    flush();
    return out;
  };
  return run(0, source.length, 0);
}
```

Note: `]]` positions are pre-indexed with one forward pointer, so a run of unclosed `[[` stays linear (the "open links" bound test holds this). Nested `run` calls only ever ask for positions to the right of the outer scan, so the shared pointers stay valid.

- [ ] **Step 4: Write `orgDocument.ts`**

```ts
// ── Org documents ────────────────────────────────────────────────────────────────────────────────────
//
// A hand-written parser for a CLOSED subset of Org, emitted as the markdown AST so the hardened markdown renderers draw
// it unchanged, with the same document bounds and per-block source ranges as `parseMarkdownDocument`. Not `orga`:
// that is not hardened for untrusted input and would be a dependency of core. The subset (anything else is a paragraph):
// headlines (1-6; TODO keyword, [#P] priority and :tags: dropped), #+TITLE (level 1), other #+KEYWORD lines and
// "# " comments (dropped), :DRAWER: ... :END: and SCHEDULED/DEADLINE/CLOSED lines (dropped), - + 1. 1) lists,
// #+BEGIN_SRC/EXAMPLE (code), #+BEGIN_QUOTE (quote), | tables with a |---+---| head rule, and 5+ dashes (rule).
// Total, linear, never throws.

import { MD_MAX_DEPTH, MD_MAX_TABLE_COLS, type MdBlock, type MdInline, type MdState, take, work } from "./chatMdTypes";
import { MD_DOC_MAX_NODES, MD_DOC_MAX_TABLE_ROWS, type MdDocument, documentLines, spansToRanges } from "./mdDocument";
import { parseOrgInlines } from "./orgInline";

const HEADLINE = /^(\*+)\s+(.*)$/;
const TODO = /^(?:TODO|DONE|NEXT|WAITING|HOLD|CANCELLED|CANCELED)\s+/;
const PRIORITY = /^\[#[A-Za-z0-9]\]\s*/;
const TAGS = /\s+:[\w@#%:]+:\s*$/;
const KEYWORD = /^\s*#\+(\w+):\s*(.*)$/;
const BEGIN = /^\s*#\+begin_(\w+)(?:\s+(\S+))?/i;
const DRAWER = /^\s*:[\w-]+:\s*$/;
const PLANNING = /^\s*(?:SCHEDULED|DEADLINE|CLOSED):/;
const ITEM = /^(\s*)(?:([-+])|(\d{1,9})[.)])\s+(.*)$/;
const RULE = /^\s*-{5,}\s*$/;
const TABLE = /^\s*\|/;
const TABLE_RULE = /^\s*\|-[-+|]*\s*$/;

const blank = (l: string) => l.trim() === "";
const startsBlock = (l: string) =>
  HEADLINE.test(l) || KEYWORD.test(l) || BEGIN.test(l) || ITEM.test(l) || RULE.test(l) || TABLE.test(l) || DRAWER.test(l) || /^\s*# /.test(l);
const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

function parseOrgBlocks(lines: readonly string[], depth: number, st: MdState): MdBlock[] {
  const out: MdBlock[] = [];
  const spans = depth === 0 ? st.spans : undefined;
  const inl = (s: string): MdInline[] => parseOrgInlines(s, st);
  const n = lines.length;
  let i = 0;
  let open: { line: number; count: number } | undefined;
  const flush = (): void => {
    if (spans && open && out.length > open.count) spans.push({ line: open.line, end: i });
    open = undefined;
  };
  while (i < n) {
    flush();
    work(st);
    const l = lines[i] as string;
    if (blank(l) || /^\s*# /.test(l) || l.trim() === "#" || PLANNING.test(l)) {
      i++;
      continue;
    }
    if (DRAWER.test(l) && !/^\s*:END:\s*$/i.test(l)) {
      let j = i + 1;
      while (j < n && !/^\s*:END:\s*$/i.test(lines[j] as string)) {
        work(st);
        j++;
      }
      i = j < n ? j + 1 : i + 1; // an unclosed drawer is just a line
      continue;
    }
    if (!take(st)) break;
    if (spans) open = { line: i, count: out.length };
    const h = HEADLINE.exec(l);
    if (h) {
      const title = (h[2] as string).replace(TODO, "").replace(PRIORITY, "").replace(TAGS, "");
      out.push({ type: "heading", level: Math.min((h[1] as string).length, 6) as 1 | 2 | 3 | 4 | 5 | 6, inlines: inl(title) });
      i++;
      continue;
    }
    const b = BEGIN.exec(l);
    if (b) {
      const kind = (b[1] as string).toLowerCase();
      const end = new RegExp(`^\\s*#\\+end_${kind}\\b`, "i");
      const body: string[] = [];
      for (i++; i < n && !end.test(lines[i] as string); i++) {
        work(st);
        body.push(lines[i] as string);
      }
      if (i < n) i++; // past #+END_ (an unclosed block runs to the end)
      if (kind === "quote" && depth < MD_MAX_DEPTH) out.push({ type: "quote", blocks: parseOrgBlocks(body, depth + 1, st) });
      else {
        const lang = kind === "src" && b[2] && /^[A-Za-z0-9_+#.-]{1,24}$/.test(b[2]) ? b[2] : undefined;
        out.push({ type: "code", ...(lang && { lang }), text: body.join("\n") });
      }
      continue;
    }
    const k = KEYWORD.exec(l);
    if (k) {
      if ((k[1] as string).toLowerCase() === "title") out.push({ type: "heading", level: 1, inlines: inl(k[2] as string) });
      i++;
      continue;
    }
    if (RULE.test(l)) {
      out.push({ type: "rule" });
      i++;
      continue;
    }
    if (TABLE.test(l)) {
      const rowsRaw: string[] = [];
      let ruleAt = -1;
      for (; i < n && TABLE.test(lines[i] as string); i++) {
        work(st);
        if (TABLE_RULE.test(lines[i] as string)) {
          if (ruleAt === -1) ruleAt = rowsRaw.length;
        } else rowsRaw.push(lines[i] as string);
      }
      const width = Math.min(Math.max(...rowsRaw.map((r) => cells(r).length), 1), MD_MAX_TABLE_COLS);
      const row = (r: string) => Array.from({ length: width }, (_, c) => (take(st) ? inl(cells(r)[c] ?? "") : []));
      const headed = ruleAt === 1;
      const head = headed ? row(rowsRaw[0] as string) : Array.from({ length: width }, () => [] as MdInline[]);
      const body = (headed ? rowsRaw.slice(1) : rowsRaw).slice(0, st.maxTableRows ?? MD_DOC_MAX_TABLE_ROWS);
      if (body.length < (headed ? rowsRaw.length - 1 : rowsRaw.length)) st.truncated = true;
      out.push({ type: "table", align: Array.from({ length: width }, () => null), head, rows: body.map(row) });
      continue;
    }
    const it = ITEM.exec(l);
    if (it && depth < MD_MAX_DEPTH) {
      const ordered = it[3] !== undefined;
      const start = ordered ? Number(it[3]) : 1;
      const indent = (it[1] as string).length;
      const items: MdBlock[][] = [];
      while (i < n) {
        const m = ITEM.exec(lines[i] as string);
        if (!m || (m[1] as string).length !== indent || (m[3] !== undefined) !== ordered) break;
        const body: string[] = [m[4] as string];
        for (i++; i < n; i++) {
          work(st);
          const c = lines[i] as string;
          if (blank(c)) break;
          const ind = c.length - c.trimStart().length;
          if (ind <= indent) break;
          body.push(c.slice(Math.min(ind, indent + 2)));
        }
        if (!take(st)) break;
        items.push(parseOrgBlocks(body, depth + 1, st));
        // blank lines between items stay in the list only when the next item continues it
        let j = i;
        while (j < n && blank(lines[j] as string)) j++;
        const nx = j > i && j < n ? ITEM.exec(lines[j] as string) : null;
        if (nx && (nx[1] as string).length === indent && (nx[3] !== undefined) === ordered) i = j;
      }
      out.push({ type: "list", ordered, start, items });
      continue;
    }
    const para: string[] = [l.trimStart()];
    for (i++; i < n && !blank(lines[i] as string) && !startsBlock(lines[i] as string); i++) para.push((lines[i] as string).trimStart());
    out.push({ type: "paragraph", inlines: inl(para.join("\n")) });
  }
  flush();
  return out;
}

export function parseOrgDocument(text: unknown): MdDocument {
  return parseOrgDocumentWith(text, undefined);
}

/** {@link parseOrgDocument} with a work meter; for the bounds tests only. */
export function parseOrgDocumentWith(text: unknown, meter: { steps: number } | undefined): MdDocument {
  if (typeof text !== "string") return { blocks: [], ranges: [], truncated: false };
  const { lines, starts, raw, truncated } = documentLines(text);
  const spans: { line: number; end: number }[] = [];
  const st: MdState = {
    nodes: 0,
    truncated,
    markers: false,
    streaming: false,
    maxNodes: MD_DOC_MAX_NODES,
    maxTableRows: MD_DOC_MAX_TABLE_ROWS,
    spans,
    ...(meter && { meter }),
  };
  const blocks = parseOrgBlocks(lines, 0, st);
  return { blocks, ranges: spansToRanges(spans, starts, raw), truncated: st.truncated };
}
```

Notes for the implementer:
- `Math.max(...rowsRaw.map(...))` spreads up to `MD_DOC_MAX_TABLE_ROWS`-ish rows but a hostile document can have more; replace it with a loop if the bounds test or a 100k-row fixture throws `RangeError`.
- A drawer that is skipped happens before `take`, so it never gets a span (it emits no block).

- [ ] **Step 5: Export and run**

Add `export { parseOrgDocument } from "./orgDocument";` to `chatUi.ts`.
Run: `cd packages/core && pnpm vitest run src/orgDocument.test.ts`
Expected: PASS. Fix the parser (not the test) until every row passes; the expectations are the spec's table.

- [ ] **Step 6: Gate and commit**

Run: `cd /Users/such/workspace/loom-ui && pnpm --filter @loom-ui/core test && pnpm typecheck && pnpm typecheck:tests && pnpm lint`

```bash
git add packages/core/src/orgInline.ts packages/core/src/orgDocument.ts packages/core/src/orgDocument.test.ts packages/core/src/chatUi.ts
git commit -m "feat(core): parseOrgDocument, a closed Org subset as the markdown AST

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Draft PR, review, rebase-merge.

---

### Task 3: loom-ui renderer-lit: share the markdown styles

Repo `loom-ui`, branch `refactor/lit-markdown-styles`. A pure move so Task 4 can reuse the chat markdown CSS.

**Files:**
- Modify: `packages/renderer-lit/src/widgets/chatMarkdown.ts` (add `markdownStyles`)
- Modify: `packages/renderer-lit/src/widgets/lu-chat.ts:246-266` (remove the `.md ...` rules, use `markdownStyles`)

**Interfaces:**
- Produces: `export const markdownStyles: CSSResult` from `widgets/chatMarkdown.ts`, every rule scoped under a `.md` ancestor (unchanged selectors).

- [ ] **Step 1: Move the rules**

In `chatMarkdown.ts` add `import { css } from "lit";` (it already imports from lit) and:

```ts
/** The markdown block styles, scoped under a `.md` ancestor; shared by every widget that draws markdown. */
export const markdownStyles = css`
  /* the .md rules moved verbatim from lu-chat.ts static styles */
`;
```

Cut every rule whose selector starts with `.md` from `lu-chat.ts`'s `static styles` (lines ~246-266: `.md`, `.md .sr-only`, `.md > :first-child`, `.md p`, `.md .h`, `.md .h1, .md .h2`, `.md .h3`, `.md ul`, `.md ol`, `.md blockquote`, `.md code`, `.md pre`, `.md pre code`, `.md .table`, `.md table`, `.md th, .md td`, `.md [data-align=...]`, `.md a`, `.md hr`) and paste them inside the template above, byte for byte. In `lu-chat.ts` change `static styles = css\`...\`` to `static styles = [markdownStyles, css\`...\`]` and import `markdownStyles` from `./chatMarkdown`.

- [ ] **Step 2: Verify nothing changed**

Run: `cd /Users/such/workspace/loom-ui && pnpm --filter @loom-ui/renderer-lit test && pnpm typecheck && pnpm lint && pnpm build`
Expected: PASS, including `treeShaking.test.ts` (lu-chat already may import `chatMarkdown`).

- [ ] **Step 3: Commit**

```bash
git add packages/renderer-lit/src/widgets/chatMarkdown.ts packages/renderer-lit/src/widgets/lu-chat.ts
git commit -m "refactor(renderer-lit): markdown styles live beside drawMarkdown

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Draft PR, rebase-merge.

---

### Task 4: loom-ui: the `Prose` kind (core contract, lit element, terminal renderer)

Repo `loom-ui`, branch `feat/prose-kind`. AGENTS.md:166 requires all of these in one change; the parity tests fail otherwise. Say so in the PR body (it exceeds the 10-file guideline).

**Files:**
- Modify: `packages/core/src/kindValues.ts` (`FRAMEWORK_KINDS` :26, `CONTRACTS` :463), `packages/core/src/values.ts` (`ProseValue`, `kindValueContracts`), `packages/core/src/browser.ts` (export `ProseValue` type), `packages/core/src/messages.ts` (keys), `packages/core/src/values.test.ts` (kind lists)
- Create: `packages/renderer-lit/src/widgets/lu-prose.ts`, `packages/renderer-lit/src/define/lu-prose.ts`, `packages/renderer-lit/src/elements/lu-prose.ts`, `packages/renderer-lit/src/widgets/lu-prose.test.ts`
- Modify: `packages/renderer-lit/src/defineAll.ts`, `widgets/index.ts`, `src/index.ts`, `dom/litRegistry.ts` (`frameworkKindContracts` :92, `.register`), `dom/litRegistry.test.ts:44-55`, `define.test.ts` (`DEFAULT_TAGS`), `treeShaking.test.ts:56-65`, `widgets/chatMarkdown.test.ts:394-405` (scan list), `README.md` (message keys)
- Modify: `packages/renderer-terminal/src/registry.ts` (renderer + `.register`), `packages/renderer-terminal/README.md`, `packages/renderer-terminal/src/registry.test.ts` (if it lists kinds)

**Interfaces:**
- Consumes: `parseMarkdownDocument`, `parseOrgDocument`, `MdDocument` (Tasks 1-2); `drawMarkdown`, `markdownStyles` (Task 3); `chatMarkdownLines`, `MD_MAX_LINES` (core `chatMdText.ts`).
- Produces: kind `"Prose"`, bound (`binding: "required"`), no props. Value:

```ts
export const ProseValue = z.object({
  format: z.enum(["markdown", "org", "plain"]),
  text: z.string(),
  truncated: z.boolean().optional(),
  focus: z.object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative() }).optional(),
  note: z.string().optional(),
});
export type ProseValue = z.infer<typeof ProseValue>;
```

  Message keys: `"lu.prose.more": "Show more"`, `"lu.prose.cut": "(document cut short)"`, `"lu.prose.empty": "(no text)"`.
  Element `lu-prose`; registry entry `{ kind: "Prose", props: [], binding: "required" }`.

- [ ] **Step 1: Core contract (failing first)**

In `values.test.ts`, add `"Prose"` to the expected `FRAMEWORK_KINDS` array (after `"Note"`, matching where you add it) and to the sorted kind list; add to `kindValues.test.ts`'s sample table:

```ts
Prose: { format: "markdown", text: "# hi", focus: { from: 0, to: 4 } },
```

and these cases to the differential fuzz inputs if it takes a per-kind list: `{ format: "html", text: "" }` (invalid), `{ format: "plain" }` (invalid), `{ format: "org", text: "", focus: { from: -1, to: 0 } }` (invalid).

Run: `cd packages/core && pnpm vitest run src/values.test.ts src/kindValues.test.ts` — Expected: FAIL.

- [ ] **Step 2: Implement the core contract**

`values.ts`: add `ProseValue` (above) next to `StatusCardValue`, and `Prose: ProseValue,` in `kindValueContracts` next to `Note`.
`kindValues.ts`: add `"Prose"` to `FRAMEWORK_KINDS` after `"Note"`, and the zod-free twin:

```ts
const FORMATS = enumOf(["markdown", "org", "plain"]);
const offset = (v: unknown, p: Path, out: Out): Status => {
  if (type("number", v, p, out) === "aborted") return "aborted";
  if (!Number.isInteger(v)) {
    fail(out, p, "Expected integer, received float");
    return "invalid";
  }
  if ((v as number) < 0) {
    fail(out, p, "Number must be greater than or equal to 0");
    return "invalid";
  }
  return "valid";
};
const prose = (v: unknown, p: Path, out: Out): Status =>
  object(v, p, out, [
    ["format", FORMATS],
    ["text", string],
    ["truncated", optionalBoolean],
    ["focus", (x, xp, xo) => opt(x, xp, xo, { optional: true }, (y, yp, yo) => object(y, yp, yo, [["from", offset], ["to", offset]]))],
    ["note", optionalString],
  ]);
```

and `Prose: prose,` in `CONTRACTS`. The messages must equal zod's exactly (the differential fuzz enforces it): check the two messages against what zod 3 emits for `.int()` and `.nonnegative()` (`fractionDigits` at kindValues.ts:243 is the precedent for integer checks).
`browser.ts`: export `type ProseValue` beside `StatusCardValue`.
`messages.ts`: add the three keys after the `lu.chat.*` group.

Run: `cd packages/core && pnpm test` — Expected: PASS.

- [ ] **Step 3: Lit element test (failing first)**

```ts
// packages/renderer-lit/src/widgets/lu-prose.test.ts
import { customWidget$ } from "@loom/blueprint-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../register";

const b = { projectionId: "hydration", path: "values.p" };
const mount = async (value: unknown) => {
  const el = document.createElement("lu-prose") as HTMLElement & { updateComplete: Promise<boolean> };
  Object.assign(el, { widget: customWidget$({ kind: "Prose", id: "p", title: "Doc", binding: b }), value });
  document.body.appendChild(el);
  for (let i = 0; i < 3; i++) await el.updateComplete;
  return el;
};
const root = (el: HTMLElement) => el.shadowRoot as ShadowRoot;

describe("lu-prose", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.stubGlobal("IntersectionObserver", undefined);
  });

  it("draws markdown blocks, one wrapper per top-level block", async () => {
    const el = await mount({ format: "markdown", text: "# Title\n\nSome **bold**.\n\n| a |\n|---|\n| 1 |" });
    expect(root(el).querySelectorAll("[data-block]")).toHaveLength(3);
    expect(root(el).querySelector(".md .h1")?.textContent).toContain("Title");
    expect(root(el).querySelector(".md strong")?.textContent).toBe("bold");
    expect(root(el).querySelector(".md table")).not.toBeNull();
  });

  it("draws org through the same renderer", async () => {
    const el = await mount({ format: "org", text: "* Head\n/it/" });
    expect(root(el).querySelector(".md .h1")?.textContent).toContain("Head");
    expect(root(el).querySelector(".md em")?.textContent).toBe("it");
  });

  it("draws plain text preformatted", async () => {
    const el = await mount({ format: "plain", text: "a\n  b" });
    expect(root(el).querySelector("pre.plain")?.textContent).toBe("a\n  b");
  });

  it("pages long documents with a Show more button", async () => {
    const text = Array.from({ length: 450 }, (_, i) => `p${i}`).join("\n\n");
    const el = await mount({ format: "markdown", text });
    expect(root(el).querySelectorAll("[data-block]")).toHaveLength(300);
    (root(el).querySelector("button.more") as HTMLButtonElement).click();
    await (el as unknown as { updateComplete: Promise<boolean> }).updateComplete;
    expect(root(el).querySelectorAll("[data-block]")).toHaveLength(450);
  });

  it("draws up to the focused block, marks it and scrolls to it", async () => {
    const paras = Array.from({ length: 400 }, (_, i) => `p${i}`);
    const text = paras.join("\n\n");
    const from = text.indexOf("p350");
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    const el = await mount({ format: "markdown", text, focus: { from, to: from + 4 } });
    const marked = root(el).querySelectorAll("[data-block].focus");
    expect(marked).toHaveLength(1);
    expect(marked[0]?.textContent).toContain("p350");
    expect(scrolled).toHaveBeenCalledTimes(1);
  });

  it("shows the note and the cut line", async () => {
    const el = await mount({ format: "markdown", text: "x", truncated: true, note: "First part only" });
    expect(root(el).textContent).toContain("First part only");
    expect(root(el).textContent).toContain("(document cut short)");
  });

  it("renders the contract error state for a bad value", async () => {
    const el = await mount({ format: "html", text: "<b>x</b>" });
    expect(root(el).querySelector("[data-state=error]")).not.toBeNull();
  });
});
```

Run: `cd packages/renderer-lit && pnpm vitest run src/widgets/lu-prose.test.ts` — Expected: FAIL (no element).

- [ ] **Step 4: Implement `lu-prose.ts`**

```ts
import type { ProseValue } from "@loom-ui/core/browser";
import { type MdDocument, parseMarkdownDocument, parseOrgDocument } from "@loom-ui/core/chat-ui";
import { type PropertyValues, type TemplateResult, css, html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { say } from "../say";
import { LuWidget } from "./base";
import { drawMarkdown, markdownStyles } from "./chatMarkdown";

// Long formatted text (a whole document): markdown and org are parsed by core's document parsers and drawn by the
// same hardened `drawMarkdown` as chat, one call per top-level block (drawMarkdown caps the nodes of ONE call), each
// in its own wrapper. The first PAGE blocks are drawn, then a Show more button. A `focus` range draws up to the block
// that overlaps it, marks that block and scrolls it into view once per distinct focus.
const PAGE = 300;
const noRef = (): TemplateResult => html``;

export class LuProse extends LuWidget {
  readonly kind = "Prose";

  static styles = [
    markdownStyles,
    css`
      :host {
        display: block;
      }
      .doc {
        max-width: 72ch;
        line-height: 1.6;
      }
      [data-block] {
        scroll-margin-top: 16px;
      }
      [data-block].focus {
        outline: 2px solid var(--lu-accent, #58a6ff);
        outline-offset: 4px;
        border-radius: var(--lu-radius, 6px);
      }
      pre.plain {
        white-space: pre-wrap;
        font-family: var(--lu-mono, ui-monospace, monospace);
        margin: 0;
      }
      .note,
      .cut {
        color: var(--lu-text-dim, #8b949e);
        font-size: 12px;
      }
    `,
  ];

  @state() private shown = PAGE;
  private parsed: { key: string; text: string; doc: MdDocument } | undefined;
  private scrolledFor = "";

  private doc(v: ProseValue): MdDocument {
    const key = v.format;
    if (this.parsed?.key === key && this.parsed.text === v.text) return this.parsed.doc;
    const doc = v.format === "org" ? parseOrgDocument(v.text) : parseMarkdownDocument(v.text);
    this.parsed = { key, text: v.text, doc };
    return doc;
  }

  private focusIndex(v: ProseValue, doc: MdDocument): number {
    if (!v.focus) return -1;
    const { from, to } = v.focus;
    return doc.ranges.findIndex((r) => r.from < Math.max(to, from + 1) && r.to > from);
  }

  protected override willUpdate(changed: PropertyValues): void {
    super.willUpdate(changed);
    const v = this.value as ProseValue | undefined;
    if (changed.has("value") && v && this.state().state === "ready" && v.format !== "plain") {
      const f = this.focusIndex(v, this.doc(v));
      if (f >= this.shown) this.shown = Math.ceil((f + 1) / PAGE) * PAGE;
    }
  }

  protected override updated(changed: PropertyValues): void {
    super.updated?.(changed);
    const v = this.value as ProseValue | undefined;
    if (!v?.focus) return;
    const key = `${v.focus.from}:${v.focus.to}:${v.text.length}`;
    if (key === this.scrolledFor) return;
    const el = this.renderRoot.querySelector("[data-block].focus");
    if (el) {
      this.scrolledFor = key;
      el.scrollIntoView?.({ block: "start" });
    }
  }

  protected renderReady(): TemplateResult | typeof nothing {
    const v = this.value as ProseValue;
    const note = v.note ? html`<p class="note">${v.note}</p>` : nothing;
    const cut = v.truncated ? html`<p class="cut">${say("lu.prose.cut")}</p>` : nothing;
    if (v.text === "") return html`${note}<p class="note">${say("lu.prose.empty")}</p>`;
    if (v.format === "plain") return html`${note}<pre class="plain">${v.text}</pre>${cut}`;
    const doc = this.doc(v);
    const focus = this.focusIndex(v, doc);
    const blocks = doc.blocks.slice(0, this.shown);
    return html`${note}
      <div class="doc md">
        ${blocks.map(
          (block, i) =>
            html`<div data-block=${i} class=${i === focus ? "focus" : ""}>${drawMarkdown({ blocks: [block], truncated: false }, { ref: noRef })}</div>`,
        )}
      </div>
      ${doc.blocks.length > this.shown
        ? html`<button class="more" @click=${() => {
            this.shown += PAGE;
          }}>${say("lu.prose.more")}</button>`
        : nothing}
      ${doc.truncated ? html`<p class="cut">${say("lu.prose.cut")}</p>` : cut}`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lu-prose": LuProse;
  }
}
```

If the package does not use `lit/decorators.js` with this tsconfig (lu-chat does, at :362), keep it; otherwise use `static properties = { shown: { state: true } }`. Check the `ref` type of `MarkdownDraw` (`(id, n) => TemplateResult`) — `noRef` returns an empty template because the document profile never emits `ref` nodes (`markers: false`).

`define/lu-prose.ts`:

```ts
import { defineElement } from "../define";
import { LuProse } from "../widgets/lu-prose";
export function defineProse(): void {
  defineElement("lu-prose", LuProse);
}
```

`elements/lu-prose.ts`: copy `elements/lu-note.ts` and swap `defineNote` for `defineProse`. Add `defineProse()` (alphabetical) to `defineAll.ts`, `export { LuProse } from "./lu-prose";` to `widgets/index.ts`, `export { LuProse } from "./widgets/lu-prose";` to `src/index.ts`. In `dom/litRegistry.ts` add `{ kind: "Prose", props: [], binding: "required" }` to `frameworkKindContracts` and `.register("Prose", el("lu-prose"))`.

- [ ] **Step 5: Update the pinned lists**

- `dom/litRegistry.test.ts:44-55`: expected `LIT_ONLY_KINDS` gains `"Prose"`; the binding expectation stays `c.kind === "Note" ? "none" : "required"` (Prose is required, so it already passes).
- `define.test.ts`: `DEFAULT_TAGS` gains `"lu-prose"`.
- `treeShaking.test.ts:56-65`: allow `chatMarkdown` for `lu-prose` exactly as it is allowed for `lu-chat`.
- `widgets/chatMarkdown.test.ts:394-405`: the scanned list becomes `["chatMarkdown.ts", "lu-chat.ts", "lu-prose.ts"]`.
- `README.md`: add the three `lu.prose.*` keys to the message-key table (i18nFitness requires it).
- Check `a11y.ts` `describeValue`: its `default:` branch must give a sensible description for `Prose`; if it stringifies the value, add `case "Prose": return title;` (a document is not summarised for screen readers; its text is in the DOM).
- `renderer-conformance`: if `fixtures.ts` must list every kind, add a `Prose` fixture `{ kind: "Prose", title: "Doc", value: { format: "markdown", text: "# Heading\n\nbody" }, needles: ["Heading", "body"] }` and list `Prose` in both conformance adapters.

- [ ] **Step 6: Terminal renderer**

In `renderer-terminal/src/registry.ts`, beside `statusCard`:

```ts
// A document laid out as text: markdown and org through core's document parsers and `chatMarkdownLines` (which
// cleans every line and caps the total), plain text as its first lines. Hung under the title like Chat.
const prose = (host: boolean, x: Env) =>
  guarded(host, "Prose", (w, v) => {
    const p = v as ProseValue;
    const body =
      p.text === ""
        ? [x.say("lu.prose.empty")]
        : p.format === "plain"
          ? p.text.split("\n").slice(0, MD_MAX_LINES).map((l) => oneLineChatText(l, 200))
          : chatMarkdownLines(p.format === "org" ? parseOrgDocument(p.text) : parseMarkdownDocument(p.text));
    const out = [...(p.note ? [oneLineChatText(p.note)] : []), ...body, ...(p.truncated ? [x.say("lu.prose.cut")] : [])];
    const indent = hang(host);
    return [...(host ? [] : [`${title(w)}:`]), ...out.map((l) => `${indent}${l}`)].join("\n");
  });
```

Register `.register("Prose", prose(host, x))` next to `StatusCard` (:512). Import `ProseValue`, `parseMarkdownDocument`, `parseOrgDocument`, `chatMarkdownLines`, `MD_MAX_LINES`, `oneLineChatText` from the core entry points the file already uses for chat. Add the keys to `renderer-terminal/README.md`. Add a test beside the Chat ones in `registry.test.ts`:

```ts
it("Prose lays a markdown document out as text", () => {
  const r = createLoomUiTerminalRegistry();
  const out = r.render(customWidget$({ kind: "Prose", id: "p", title: "Doc", binding: b }), { format: "markdown", text: "# Head\n\n- one\n- two" });
  expect(out).toContain("Head");
  expect(out).toContain("one");
});
```

(adapt `r.render` to the file's existing call style for Chat).

- [ ] **Step 7: Full gate**

Run: `cd /Users/such/workspace/loom-ui && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test && pnpm build`
Expected: all pass, including `treeShaking.test.ts`, `i18nFitness.test.ts`, `genericity.test.ts`, `noInlineStyle.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add -A packages
git commit -m "feat: Prose kind, long markdown/org/plain text drawn block by block

Core contract and messages, lu-prose (lit) and the terminal renderer land
together, as AGENTS.md requires for a framework kind.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Draft PR (state the file-count exception), review (Opus first review: it is a security boundary for untrusted text), rebase-merge. Record the merge SHA: DocMind Task 7 pins it.

---

### Task 5: DocMind server: `readSource` and `GET /api/documents/:id/source`

Repo `docmind`, branch `feat/document-source`. Independent of Tasks 1-4.

**Files:**
- Modify: `packages/parsers/src/index.ts` (export `decodeText`)
- Modify: `packages/contracts/src/documents.ts` (`DocumentSourceResponse`)
- Create: `apps/server/app/documents/source.ts`
- Modify: `apps/server/app/documents/routes.ts` (deps + route), `apps/server/app/compose.ts` (~l.292 pass `registry`), `apps/server/app/documents/testHarness.ts` (pass `registry`)
- Test: `apps/server/app/documents/source.pg.test.ts`

**Interfaces:**
- Produces:

```ts
// packages/contracts/src/documents.ts
export const SourceFormat = z.enum(["md", "org", "txt"]);
export const DocumentSourceResponse = z.object({
  format: SourceFormat,
  text: z.string(),
  truncated: z.boolean(),
  focus: z.object({ from: Count, to: Count }).strict().optional(),
}).strict();
export type DocumentSourceResponse = z.infer<typeof DocumentSourceResponse>;

// apps/server/app/documents/source.ts
export const SOURCE_MAX_CHARS = 1_000_000;
export type SourceResult = { applicable: false } | ({ applicable: true } & DocumentSourceResponse);
export interface SourceDeps {
  pool: Pool;
  blobs: (identity: Identity) => EncryptedFsContentStore;
  registry: ParserRegistry;
}
export async function readSource(deps: SourceDeps, identity: Identity, documentId: string, passageId?: string): Promise<SourceResult | null>;
```

`null` = not found / not yours / erasing.

- [ ] **Step 1: Export `decodeText`**

In `packages/parsers/src/index.ts` add `export { decodeText } from "./text";`. Run `pnpm --filter @docmind/parsers build`.

- [ ] **Step 2: Add the contract**

Add `SourceFormat` and `DocumentSourceResponse` (above) to `packages/contracts/src/documents.ts` after `DocumentContentResponse`. Add a contracts test case in `documents.test.ts`:

```ts
it("DocumentSourceResponse is strict and bounds focus", () => {
  expect(DocumentSourceResponse.safeParse({ format: "md", text: "x", truncated: false }).success).toBe(true);
  expect(DocumentSourceResponse.safeParse({ format: "pdf", text: "x", truncated: false }).success).toBe(false);
  expect(DocumentSourceResponse.safeParse({ format: "md", text: "x", truncated: false, focus: { from: -1, to: 0 } }).success).toBe(false);
});
```

Run: `pnpm --filter @docmind/contracts test` — Expected: PASS after adding the schema.

- [ ] **Step 3: Write the failing PG test**

```ts
// apps/server/app/documents/source.pg.test.ts
import { EncryptedFsContentStore } from "@docmind/blob-store";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../db/tenant";
import { PG_URL } from "../db/testSupport";
import { FieldCrypto } from "../crypto/fieldCrypto"; // use the same import content.pg.test.ts uses
import { PgChunkStore } from "../flows/ingest-document/pgChunks";
import { insertDocument } from "./repo";
import { ALICE, BOB, type DocumentHarness, newDocument, startDocumentServer } from "./testHarness";

describe.skipIf(!PG_URL)("document source (needs DOCMIND_TEST_PG_URL)", () => {
  let h: DocumentHarness;
  let fields: FieldCrypto;
  const get = (path: string, user = "alice") => fetch(`${h.base}${path}`, { headers: { "x-test-user": user } });

  const upload = async (who: typeof ALICE, mime: string, text: string, fp: string) => {
    const store = new EncryptedFsContentStore({ root: h.root, tenantId: who.tenantId, userId: who.userId, keys: h.keys, maxBytes: 4 << 20 });
    const bytes = new TextEncoder().encode(text);
    const ref = await store.put(bytes);
    const doc = await newDocument(fields, who.tenantId, who.userId, fp.repeat(64), { contentAddress: ref.__loomContent, mime, sizeBytes: bytes.length });
    await withTenant(h.app, who.tenantId, (tx) => insertDocument(tx, doc));
    return doc.id;
  };

  beforeAll(async () => {
    h = await startDocumentServer();
    fields = new FieldCrypto(h.keys);
  });
  afterAll(() => h?.close());

  it("returns an owner's markdown source, no-store", async () => {
    const id = await upload(ALICE, "text/markdown", "# Title\n\nbody", "a");
    const res = await get(`/api/documents/${id}/source`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ format: "md", text: "# Title\n\nbody", truncated: false });
  });

  it("maps org and txt", async () => {
    const org = await upload(ALICE, "text/x-org", "* H", "b");
    const txt = await upload(ALICE, "text/plain", "plain", "c");
    expect((await (await get(`/api/documents/${org}/source`)).json()).format).toBe("org");
    expect((await (await get(`/api/documents/${txt}/source`)).json()).format).toBe("txt");
  });

  it("answers 415 for a format it does not render", async () => {
    const id = await upload(ALICE, "application/pdf", "%PDF-1.7", "d");
    const res = await get(`/api/documents/${id}/source`);
    expect(res.status).toBe(415);
    expect((await res.json()).error.code).toBe("not_renderable");
  });

  it("is 404 for a missing, malformed or someone else's document", async () => {
    const bobs = await upload(BOB, "text/markdown", "secret", "e");
    for (const id of [randomUUID(), "not-a-uuid", bobs]) {
      const res = await get(`/api/documents/${id}/source`);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("is 401 without a session", async () => {
    const res = await fetch(`${h.base}/api/documents/${randomUUID()}/source`);
    expect(res.status).toBe(401);
  });

  it("cuts over SOURCE_MAX_CHARS on a line break", async () => {
    const id = await upload(ALICE, "text/plain", `${"a".repeat(999_990)}\n${"b".repeat(100)}`, "f");
    const body = await (await get(`/api/documents/${id}/source`)).json();
    expect(body.truncated).toBe(true);
    expect(body.text).toBe("a".repeat(999_990));
  });

  it("returns focus for a passage of this document, and ignores another's", async () => {
    const id = await upload(ALICE, "text/markdown", "# T\n\nalpha beta", "g");
    await new PgChunkStore(h.app, fields).replace({ tenantId: ALICE.tenantId, userId: ALICE.userId, documentId: id }, [
      { ordinal: 0, sectionOrdinal: 0, headingPath: ["T"], text: "alpha beta", tokenCount: 2, locator: { kind: "chars", start: 5, end: 15 } },
    ]);
    const { chunkIdFor } = await import("../flows/ingest-document/chunker");
    const mine = chunkIdFor(id, 0);
    expect((await (await get(`/api/documents/${id}/source?passage=${mine}`)).json()).focus).toEqual({ from: 5, to: 15 });
    const other = await upload(ALICE, "text/markdown", "x", "h");
    const body = await (await get(`/api/documents/${other}/source?passage=${mine}`)).json();
    expect(body.focus).toBeUndefined();
  });
});
```

Copy the `FieldCrypto`, `PgChunkStore` and `ALICE`/`BOB` import paths from `content.pg.test.ts` and `ingest.e2e.pg.test.ts`; the names above are from the research, the paths must match the files.

Run (with PG up): `cd apps/server && DOCMIND_TEST_PG_URL=postgres://...:55432/... pnpm vitest run app/documents/source.pg.test.ts`
Expected: FAIL (404 on every route: not registered).

- [ ] **Step 4: Implement `source.ts`**

```ts
import type { EncryptedFsContentStore } from "@docmind/blob-store";
import { type DocumentSourceResponse, Locator } from "@docmind/contracts";
import { type ParserRegistry, decodeText } from "@docmind/parsers";
import type { Pool } from "pg";
import type { Identity } from "../auth/identity"; // the Identity import content.ts uses
import { withTenant } from "../db/tenant";

/** The most source text served: ingest's analysis window, and within the client parsers' bound. */
export const SOURCE_MAX_CHARS = 1_000_000;
const FORMATS = { md: "md", org: "org", txt: "txt" } as const;

export type SourceResult = { applicable: false } | ({ applicable: true } & DocumentSourceResponse);
export interface SourceDeps {
  pool: Pool;
  blobs: (identity: Identity) => EncryptedFsContentStore;
  registry: ParserRegistry;
}

/**
 * A document's stored original, decoded exactly as ingest decoded it (so passage `chars` locators are offsets into
 * it), for the formats the page renders (md, org, txt). `null`: not found, not the caller's, or the caller is being
 * erased. `{ applicable: false }`: any other format, or bytes that no longer decode. `focus`: the locator of
 * `passageId` when it is a chunk of THIS document with a `chars` locator.
 */
export async function readSource(
  deps: SourceDeps,
  identity: Identity,
  documentId: string,
  passageId?: string,
): Promise<SourceResult | null> {
  const row = await withTenant(deps.pool, identity.tenantId, async (tx) => {
    const alive = await tx.query("SELECT 1 FROM users WHERE id = $1 AND erasing_at IS NULL", [identity.userId]);
    if (alive.rowCount === 0) return null;
    const doc = await tx.query<{ mime: string; content_address: string }>(
      "SELECT mime, content_address FROM documents WHERE id = $1 AND owner_id = $2",
      [documentId, identity.userId],
    );
    const d = doc.rows[0];
    if (!d) return null;
    let locator: unknown;
    if (passageId) {
      const c = await tx.query<{ locator: unknown }>(
        "SELECT locator FROM chunks WHERE id = $1 AND document_id = $2",
        [passageId, documentId],
      );
      locator = c.rows[0]?.locator;
    }
    return { mime: d.mime, address: d.content_address, locator };
  });
  if (row === null) return null;
  const id = deps.registry.select(row.mime)?.id;
  const format = id === "md" || id === "org" || id === "txt" ? FORMATS[id] : undefined;
  if (!format) return { applicable: false };
  const bytes = await deps.blobs(identity).get({ __loomContent: row.address });
  if (bytes === null) throw new Error("the document's stored content is missing");
  let full: string;
  try {
    full = decodeText(bytes);
  } catch {
    return { applicable: false };
  }
  let text = full;
  let truncated = false;
  if (full.length > SOURCE_MAX_CHARS) {
    const cut = full.lastIndexOf("\n", SOURCE_MAX_CHARS);
    text = full.slice(0, cut > 0 ? cut : SOURCE_MAX_CHARS);
    truncated = true;
  }
  const loc = Locator.safeParse(row.locator);
  const focus =
    loc.success && loc.data.kind === "chars" && loc.data.start < text.length
      ? { from: loc.data.start, to: Math.min(loc.data.end, text.length) }
      : undefined;
  return { applicable: true, format, text, truncated, ...(focus && { focus }) };
}
```

Ingest selects with the mime only (`parse.ts:58-66`: `registry.select(mime)`), so this does too.

- [ ] **Step 5: Register the route**

In `routes.ts`: add `registry: ParserRegistry` to `DocumentRoutesDeps`; then beside `"GET /api/documents/:id/content"`:

```ts
    "GET /api/documents/:id/source": requireAuth(deps.authenticator, async (req, res, identity, ctx) => {
      // The original text: nothing may cache it, on any answer.
      res.setHeader("cache-control", "no-store");
      const parsed = Uuid.safeParse(ctx.params.id);
      const raw = new URL(req.url ?? "/", "http://localhost").searchParams.get("passage");
      const passage = raw && Uuid.safeParse(raw).success ? raw.toLowerCase() : undefined;
      const result = parsed.success
        ? await readSource(deps, identity, parsed.data.toLowerCase(), passage)
        : null;
      if (!result) return sendError(res, 404, "not_found", "document not found");
      if (!result.applicable) return sendError(res, 415, "not_renderable", "this document's format is not rendered");
      const { applicable: _, ...body } = result;
      json(res, 200, body satisfies DocumentSourceResponse);
    }),
```

(`readSource(deps, ...)` works because `DocumentRoutesDeps` has `pool`, `blobs` and now `registry`.) In `compose.ts` pass `registry: options.ingest.registry` to `documentRoutes({...})`; in `testHarness.ts` pass `registry: wiring.registry` (the harness already builds `IngestWiring`).

- [ ] **Step 6: Run the tests**

Run: `cd apps/server && pnpm vitest run app/documents/source.pg.test.ts` (PG up) — Expected: PASS (7 tests).
Run: `cd /Users/such/workspace/docmind && pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test` — Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/parsers/src/index.ts packages/contracts/src/documents.ts packages/contracts/src/documents.test.ts apps/server/app/documents/source.ts apps/server/app/documents/source.pg.test.ts apps/server/app/documents/routes.ts apps/server/app/compose.ts apps/server/app/documents/testHarness.ts
git commit -m "feat(server): GET /api/documents/:id/source, the stored original of md/org/txt

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Draft PR; Opus first review (owner-scoped read of document content), rebase-merge.

---

### Task 6: DocMind UI plane: read target `document.source`

Branch `feat/ui-document-source` (after Task 5).

**Files:**
- Modify: `packages/experiences/src/providers.ts` (`PINS`), `packages/experiences/src/invoker.ts` (`UiReaders`, `ARGS`, switch)
- Modify: `apps/server/app/ui/readers.ts` (`UiReaderDeps`, `source`), `apps/server/app/compose.ts` (l.305), `apps/server/app/documents/testHarness.ts` (~l.430)
- Modify: `apps/web/src/testing/fakeUi.ts` (`emptyReaders`), `apps/web/src/testing/fakeServer.ts` (`readers()`), and any test building a `UiReaders` literal (`grep -rn "content: " apps/web/src --include=*.test.ts` to find them)
- Test: `packages/experiences/src/invoker.test.ts` (or the file that tests `createInvoker`), `apps/server/app/ui/readers.test.ts`

**Interfaces:**
- Consumes: `readSource`, `SourceResult` (Task 5).
- Produces: `UiReaders.source(args: { id: string; passage: string }): Promise<SourceResult | null>`; target `"document.source"` pinned `"docmind:document.source@1"`; `ARGS["document.source"] = z.object({ id: Id, passage: Id.or(z.literal("")).default("") }).strict()`. `SourceResult` moves to (or is re-declared in) `packages/experiences/src/invoker.ts` as a plain type so the package does not import from apps:

```ts
export type SourceResult =
  | { applicable: false }
  | { applicable: true; format: "md" | "org" | "txt"; text: string; truncated: boolean; focus?: { from: number; to: number } };
```

(`apps/server/app/documents/source.ts` then imports this type from `@docmind/experiences` instead of declaring its own.)

- [ ] **Step 1: Failing invoker test**

```ts
it("document.source reads through the source reader and maps null to notFound", async () => {
  const source = vi.fn(async () => ({ applicable: true as const, format: "md" as const, text: "# x", truncated: false }));
  const inv = createInvoker({ ...emptyReaders(), source });
  await expect(call(inv, "document.source", { id: ID, passage: "" })).resolves.toEqual({ applicable: true, format: "md", text: "# x", truncated: false });
  expect(source).toHaveBeenCalledWith({ id: ID, passage: "" });
  const none = createInvoker({ ...emptyReaders(), source: async () => null });
  await expect(call(none, "document.source", { id: ID, passage: "" })).rejects.toMatchObject({ code: "notFound" });
});
```

Use the helpers the existing `document.content` invoker test uses for `call`, `ID` and `emptyReaders` (copy their imports). Run: `pnpm --filter @docmind/experiences test` — Expected: FAIL.

- [ ] **Step 2: Implement**

`providers.ts`: add `"document.source": "docmind:document.source@1",` to `PINS`.
`invoker.ts`: add `SourceResult`, `source(args: { id: string; passage: string }): Promise<SourceResult | null>;` to `UiReaders`, the `ARGS` entry, and in the switch:

```ts
      case "document.source": {
        const out = await readers.source(args as { id: string; passage: string });
        if (out === null) fail("notFound");
        return out;
      }
```

(mirror the exact shape of the `document.content` case.)
`apps/server/app/ui/readers.ts`: `UiReaderDeps` gains `blobs` and `registry`; `readersFor` gains

```ts
    source: ({ id, passage }) => readSource(deps, identity, id, passage === "" ? undefined : passage),
```

`compose.ts:305`: `readers: { pool, fields, status, blobs, registry: options.ingest.registry }`. `testHarness.ts`: the same with `wiring.registry`.
Web fakes: `emptyReaders()` gains `source: async () => null`; `FakeServer.readers()` gains a `source` reader backed by a new `sources = new Map<string, SourceResult>()` field (return `this.docs.some((d) => d.id === id) ? (this.sources.get(id) ?? { applicable: false }) : null`).

- [ ] **Step 3: Gate and commit**

Run: `cd /Users/such/workspace/docmind && pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test` — Expected: PASS.

```bash
git add -A packages/experiences apps/server/app/ui apps/server/app/compose.ts apps/server/app/documents apps/web/src/testing
git commit -m "feat: document.source read target on the UI plane

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Draft PR, Sonnet review, rebase-merge.

---

### Task 7: DocMind: pin loom-ui, `DocumentProse` entry, `doc-source` provider, `detail-source` reshaper

Branch `feat/detail-prose` (after Tasks 4 and 6).

**Files:**
- Modify: `.github/workflows/ci.yml` (`LOOM_UI_REF` → the Task 4 merge SHA, full 40 chars)
- Modify: `packages/experiences/src/catalog.ts` (`KINDS.Prose`, `ENTRY_KINDS.DocumentProse`), `packages/experiences/src/views.ts` (content panel + provider), `packages/experiences/src/reshapers.ts` (`detail-source`)
- Modify: `apps/web/src/ui/elements.ts` (import `lu-prose`)
- Test: `packages/experiences/src/reshapers.test.ts`, `packages/experiences/src/views.test.ts` / `catalog.test.ts` (whatever pins the entry list), `packages/experiences/src/terminal.test.ts` (if it lists kinds)

**Interfaces:**
- Consumes: kind `Prose` + `ProseValue` (Task 4), `SourceResult` (Task 6).
- Produces: widget id `content-prose` with handle `doc-source` (Task 8 hides/shows it by `data-widget-id="content-prose"`), reshaper output `ProseValue & { applicable: boolean }`.

- [ ] **Step 1: Pull loom-ui and rebuild**

```bash
cd /Users/such/workspace/loom-ui && git switch main && git pull --rebase && pnpm install && pnpm --filter @loom-ui/core --filter @loom-ui/hydration --filter @loom-ui/renderer-lit --filter @loom-ui/renderer-terminal build
cd /Users/such/workspace/docmind && git -C ../loom-ui rev-parse HEAD   # put this in LOOM_UI_REF
```

- [ ] **Step 2: Failing reshaper tests**

```ts
describe("detail-source", () => {
  it("maps md/org/txt to Prose formats", () => {
    expect(shape("detail-source", { applicable: true, format: "md", text: "# a", truncated: false })).toEqual({ applicable: true, format: "markdown", text: "# a" });
    expect(shape("detail-source", { applicable: true, format: "org", text: "* a", truncated: false })).toMatchObject({ format: "org" });
    expect(shape("detail-source", { applicable: true, format: "txt", text: "a", truncated: false })).toMatchObject({ format: "plain" });
  });
  it("notes a truncated source and passes focus", () => {
    expect(shape("detail-source", { applicable: true, format: "md", text: "x", truncated: true, focus: { from: 0, to: 1 } })).toEqual({
      applicable: true, format: "markdown", text: "x", truncated: true, focus: { from: 0, to: 1 }, note: "Showing the first part of this document.",
    });
  });
  it("is an empty plain value when the format is not rendered", () => {
    expect(shape("detail-source", { applicable: false })).toEqual({ applicable: false, format: "plain", text: "" });
  });
});
```

Run: `pnpm --filter @docmind/experiences test` — Expected: FAIL (`SHAPES["detail-source"]` missing).

- [ ] **Step 3: Implement**

`reshapers.ts`, beside `detail-content`:

```ts
  "detail-source": (raw: SourceResult) => {
    if (!raw.applicable) return { applicable: false, format: "plain", text: "" };
    const format = raw.format === "md" ? "markdown" : raw.format === "org" ? "org" : "plain";
    return {
      applicable: true,
      format,
      text: raw.text,
      ...(raw.truncated && { truncated: true, note: "Showing the first part of this document." }),
      ...(raw.focus && { focus: raw.focus }),
    };
  },
```

(`Prose`'s contract is a non-strict object, so the extra `applicable` key passes.)
`catalog.ts`: `KINDS` gains `Prose: { kind: "Prose", props: [], binding: "required" },`; `ENTRY_KINDS` gains `DocumentProse: "Prose",` before `DocumentContent`.
`views.ts`: the content panel becomes

```ts
        panel("content", "Content", [
          widget({ id: "content-prose", type: "DocumentProse", handle: "doc-source", priority: "P1" }),
          widget({
            id: "content-view",
            type: "DocumentContent",
            handle: "doc-content",
            priority: "P1",
            props: { view: CONTENT_VIEW },
          }),
        ]),
```

and `providers` gains

```ts
      "doc-source": provider("doc-source", {
        target: "document.source",
        args: { id: "", passage: "" },
        overridable: ["id", "passage"],
        reshaper: "detail-source",
      }),
```

`apps/web/src/ui/elements.ts`: add `import "@loom-ui/renderer-lit/elements/lu-prose";`.
`.github/workflows/ci.yml`: `LOOM_UI_REF:` → the SHA from Step 1.

The page sends `{ id, upto, passage }` to every provider. If hydrate rejects `upto` for `doc-source` (a test in Step 4 will show a `invalidArgs`/override finding), add `"upto"` handling by scoping: in Task 8, call `session.setParams(params, "doc-content")` for `upto` and `session.setParams({ id, passage }, "doc-source")`, or add `upto` to neither `args` nor `overridable` and confirm the runtime ignores unknown keys — pick whichever the loom-ui hydration code (`serveHandles`) does; check it before choosing.

- [ ] **Step 4: Update pinned lists and run**

Update whatever test pins the catalog entries / detail widgets (`catalog.test.ts`, `views.test.ts`, `terminal.test.ts`; `grep -rn "DocumentContent" packages/experiences/src/*.test.ts`). Add a hydrate test in `hydrate.test.ts` beside the `document.content` one: hydrating `detail` with `doc-source` and a fake `source` reader returning `{ applicable: true, format: "md", text: "# a", truncated: false }` yields a ready `doc-source` value `{ applicable: true, format: "markdown", text: "# a" }`.

Run: `cd /Users/such/workspace/docmind && pnpm install && pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml packages/experiences apps/web/src/ui/elements.ts
git commit -m "feat(experiences): DocumentProse on the Content tab, fed by document.source

Pins LOOM_UI_REF to the Prose kind.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Draft PR, Sonnet review, rebase-merge.

---

### Task 8: DocMind web: show `Prose` or the passage list

Branch `feat/detail-prose-page` (after Task 7).

**Files:**
- Modify: `apps/web/src/components/dm-doc-detail.ts` (`onReady` check, new `syncContent()`)
- Modify: `apps/web/src/testing/fakeServer.ts` (seed `sources`)
- Test: `apps/web/src/components/dm-doc-detail.test.ts`

**Interfaces:**
- Consumes: widget ids `content-prose` / `content-view`, handle `doc-source` (Task 7); `ViewSession.statusOf/valueOf` (`apps/web/src/ui/session.ts`).

- [ ] **Step 1: Failing tests**

Add to `dm-doc-detail.test.ts` (reuse its `setup`, `deepAll`, `deepText`, `id()` helpers; give `setup`'s `fakeUi` readers a `source` mock):

```ts
describe("dm-doc-detail: rendered content", () => {
  const host = (page: HTMLElement, wid: string) =>
    page.shadowRoot?.querySelector("dm-view")?.shadowRoot?.querySelector(`[data-widget-id="${wid}"]`) as HTMLElement | null;

  it("shows Prose and hides the passage list for a markdown document", async () => {
    const t = setup({ name: "document", id: id(1) }, undefined, {
      source: async () => ({ applicable: true, format: "md", text: "# Heading\n\n| a |\n|---|\n| 1 |", truncated: false }),
    });
    const page = await t.mount();
    await vi.waitFor(() => expect(host(page, "content-prose")?.hidden).toBe(false));
    expect(host(page, "content-view")?.hidden).toBe(true);
    expect(deepText(page)).toContain("Heading");
  });

  it("keeps the passage list for a format it does not render", async () => {
    const t = setup({ name: "document", id: id(1) }, undefined, { source: async () => ({ applicable: false }) });
    const page = await t.mount();
    await vi.waitFor(() => expect(host(page, "content-view")?.hidden).toBe(false));
    expect(host(page, "content-prose")?.hidden).toBe(true);
  });

  it("passes the cited passage to the source reader", async () => {
    const source = vi.fn(async () => ({ applicable: true as const, format: "md" as const, text: "# a\n\nb", truncated: false, focus: { from: 5, to: 6 } }));
    const t = setup({ name: "document", id: id(1), passage: id(130) }, undefined, { source });
    await t.mount();
    await vi.waitFor(() => expect(source).toHaveBeenCalledWith(expect.objectContaining({ passage: id(130) })));
  });
});
```

Extend `setup`'s signature with an optional third `readers: Partial<UiReaders>` merged into the readers it builds (keep existing callers working). Run: `pnpm --filter @docmind/web vitest run src/components/dm-doc-detail.test.ts` — Expected: FAIL (both widgets visible).

- [ ] **Step 2: Implement**

In `dm-doc-detail.ts`, inside the existing `check` callback that `onReady` subscribes with (`session.store.runtimeSubscribe(check)`), call `this.syncContent(session)`, and add:

```ts
  /**
   * The Content tab holds Prose (md/org/txt, rendered) and the passage list (every other format); experiences have
   * no conditional widgets, so the page shows exactly one. Until `doc-source` settles, neither shows; a failed source
   * read falls back to the passage list.
   */
  private syncContent(session: ViewSession): void {
    const root = this.renderRoot.querySelector("dm-view")?.shadowRoot;
    const prose = root?.querySelector<HTMLElement>('[data-widget-id="content-prose"]');
    const list = root?.querySelector<HTMLElement>('[data-widget-id="content-view"]');
    if (!prose || !list) return;
    const status = session.statusOf("doc-source");
    const applicable = (session.valueOf("doc-source") as { applicable?: boolean } | undefined)?.applicable === true;
    const settled = status === "ready" || status === "error";
    prose.hidden = !(settled && applicable);
    list.hidden = !(settled && !applicable);
  }
```

`check` runs on every store change, and the widget hosts may mount after the first call, so the early return is safe. In `fakeServer.ts`, seed `sources` for the markdown fixture document(s) used by the acceptance tests so they keep passing.

- [ ] **Step 3: Run, gate, commit**

Run: `cd /Users/such/workspace/docmind && pnpm --filter @docmind/web test && pnpm typecheck && pnpm typecheck:tests && pnpm lint` — Expected: PASS (the first existing test still sees tabs `["Summary","Analysis","Content"]`).

```bash
git add apps/web/src/components/dm-doc-detail.ts apps/web/src/components/dm-doc-detail.test.ts apps/web/src/testing/fakeServer.ts
git commit -m "feat(web): the Content tab renders md/org/txt documents, passages otherwise

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

Draft PR, Sonnet review, rebase-merge.

---

### Task 9: Real-app check and carry-forward

No code unless the check finds a bug (a bug gets its own branch and PR).

- [ ] **Step 1: Run the real app**

```bash
cd /Users/such/workspace/docmind && pnpm db:start && pnpm build && pnpm start
```

(the server must be restarted after the build: it loads `@docmind/experiences` from `dist/`).

- [ ] **Step 2: Check in the browser with the test account** (`docmind/.env` `DOCMIND_TEST_*`)

1. Upload a `.md` with headings, a table, a fenced code block and a link; open it, Content tab: formatted, one continuous document, link shows its host and opens in a new tab.
2. Upload an `.org` with a headline carrying TODO and tags, a `#+BEGIN_SRC` block, a table with a `|---+---|` rule, a `:PROPERTIES:` drawer: formatted, drawer and TODO/tags absent.
3. Upload a `.txt`: preformatted, line breaks kept.
4. Open an existing PDF: the passage list, unchanged.
5. In a chat, cite a passage from the `.md` and click the citation: the Content tab opens, scrolled to the marked block.

- [ ] **Step 3: Record**

Update the DocMind carry-forward memory with the merged SHAs, the new `LOOM_UI_REF`, and anything learned.
