# Multi-Document Chat Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a chat search any chosen set of documents: a new loom-ui `MultiSelectInput` kind, drawn as chips + search on the web and a checklist on the terminal, replaces DocMind's "Search in" select.

**Architecture:** loom-ui core gains the kind (a bound `{ options, selected, note? }` value with one shared checker), a `SELECT_MANY { values, key }` action and its host acceptance (checked against an `optionsOf` hook). Both renderers draw it. DocMind's chat page lists the user's documents, publishes them as the picker's value, resolves `SELECT_MANY` against the ids it published, and saves through the existing `PATCH /api/chats/:id`. The server is unchanged.

**Tech Stack:** TypeScript, Lit 3, Vitest (jsdom for renderer-lit and apps/web), zod (DocMind contracts, loom-ui `values.ts`), pnpm workspaces, Biome.

**Spec:** `docmind/docs/specs/2026-10-22-multi-document-chat-scope-design.md`

## Global Constraints

- Two repos, siblings under `~/workspace`: `loom-ui` (tasks 1–6) and `docmind` (tasks 7–10). DocMind consumes loom-ui through a linked checkout pinned by `LOOM_UI_REF` in `docmind/.github/workflows/ci.yml`.
- Kind name `MultiSelectInput`; action `SELECT_MANY`; payload `{ values: string[], key }`; submission kind `"select-many"`.
- Value limits: at most 500 options; option value 1–128 chars, no control characters; label 1–200 chars; `hint` 1–40 chars; `note` 1–200 chars; `selected` unique, every one an option, at most `maxSelected`.
- `maxSelected` is an integer 1–100 (default 100). DocMind's scope maximum is 100 (`ChatScope`, `packages/contracts/src/chats.ts`).
- `CHAT_TYPE_VERSION` stays `"1.1.0"`. Adding a kind changes no existing kind's props or value contract.
- Each PR is a **draft**, at most 200 changed lines and 10 files (tests included where possible; if a PR goes over, split it at a task boundary), merged with `gh pr merge --rebase`. Never squash.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`; PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Use `command ls`, never bare `ls` (it is `eza` here and can hang).
- DocMind UI copy: "Search in", "All documents", "Add a document…", "Removed document", "processing", "failed", "Showing the 200 most recent documents", "Could not change where this chat searches.".
- Gates per repo before each PR: `pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`.

## PR map

| PR | Repo | Branch | Tasks |
|---|---|---|---|
| 1 | loom-ui | `feat/multi-select-input-core` | 1, 2, 3 |
| 2 | loom-ui | `feat/multi-select-input-web` | 4 |
| 3 | loom-ui | `feat/multi-select-input-terminal` | 5, 6 |
| 4 | docmind | `feat/scope-picker-data` | 7, 8 |
| 5 | docmind | `feat/multi-document-scope` | 9, 10 |

PR 4 is additive (nothing uses it yet). PR 5 changes the intent, the experience and the page together, because any one of them alone breaks the other two.

---

### Task 1: The value contract (loom-ui core)

**Files:**
- Modify: `loom-ui/packages/core/src/chatValue.ts` (kind constants near line 29; new checker at the end)
- Modify: `loom-ui/packages/core/src/kindValues.ts:440-480` (contract table)
- Modify: `loom-ui/packages/core/src/values.ts:198-207` (zod table)
- Modify: `loom-ui/packages/core/src/kindValues.fuzz.test.ts:263` (generator)
- Test: `loom-ui/packages/core/src/chatValue.test.ts`

**Interfaces:**
- Produces (exported from `@loom-ui/core`, `@loom-ui/core/browser` via `kindValues`, and `@loom-ui/core/chat-ui`, which re-exports `chatValue` wholesale):
  - `MULTI_SELECT_INPUT_KIND = "MultiSelectInput"`, now the 4th entry of `CHAT_INPUT_KINDS`
  - `MAX_MULTI_OPTIONS = 500`, `MAX_MULTI_SELECTED = 100`
  - `interface MultiSelectOption { readonly value: string; readonly label: string; readonly hint?: string }`
  - `interface MultiSelectValue { readonly options: readonly MultiSelectOption[]; readonly selected: readonly string[]; readonly note?: string }`
  - `multiSelectValueIssues(value: unknown): ChatIssue[]` (empty = valid; messages are value-free)

- [ ] **Step 1: Write the failing tests** (append to `chatValue.test.ts`)

```ts
import { MAX_MULTI_OPTIONS, multiSelectValueIssues } from "./chatValue";

describe("multiSelectValueIssues", () => {
  const ok = {
    options: [
      { value: "a", label: "Alpha" },
      { value: "b", label: "Beta", hint: "processing" },
    ],
    selected: ["b"],
  };
  it("accepts a value whose selection is among its options", () => {
    expect(multiSelectValueIssues(ok)).toEqual([]);
    expect(multiSelectValueIssues({ ...ok, selected: [], note: "Showing some" })).toEqual([]);
  });
  it("refuses a non-object, a stray field, and missing lists", () => {
    expect(multiSelectValueIssues("a")).toEqual([{ path: [], message: "Expected a multi-select value" }]);
    expect(multiSelectValueIssues({ ...ok, html: "<b>" })).toContainEqual({ path: [], message: "unexpected field" });
    expect(multiSelectValueIssues({ selected: [] })).toContainEqual({ path: ["options"], message: "options is required" });
    expect(multiSelectValueIssues({ options: [] })).toContainEqual({ path: ["selected"], message: "selected is required" });
  });
  it("refuses bad options: duplicates, control characters, empty or long labels, long hints, extra fields", () => {
    const bad = (o: unknown) => multiSelectValueIssues({ options: [o], selected: [] });
    expect(multiSelectValueIssues({ options: [ok.options[0], ok.options[0]], selected: [] })).toContainEqual({ path: ["options", 1, "value"], message: "option values are unique" });
    expect(bad({ value: "a\u0007", label: "x" })).toContainEqual({ path: ["options", 0, "value"], message: "an option value is short text without control characters" });
    expect(bad({ value: "a", label: "" })).toContainEqual({ path: ["options", 0, "label"], message: "an option label is short text" });
    expect(bad({ value: "a", label: "x", hint: "h".repeat(41) })).toContainEqual({ path: ["options", 0, "hint"], message: "a hint is short text" });
    expect(bad({ value: "a", label: "x", href: "y" })).toContainEqual({ path: ["options", 0], message: "unexpected field" });
  });
  it("refuses a selection outside the options, a repeat, and more than the limits", () => {
    expect(multiSelectValueIssues({ ...ok, selected: ["z"] })).toContainEqual({ path: ["selected", 0], message: "a selected value is one of the options" });
    expect(multiSelectValueIssues({ ...ok, selected: ["a", "a"] })).toContainEqual({ path: ["selected", 1], message: "selected values are unique" });
    const many = Array.from({ length: MAX_MULTI_OPTIONS + 1 }, (_, i) => ({ value: `v${i}`, label: "x" }));
    expect(multiSelectValueIssues({ options: many, selected: [] })).toContainEqual({ path: ["options"], message: "at most 500 options" });
    const hundred = many.slice(0, 101);
    expect(multiSelectValueIssues({ options: hundred, selected: hundred.map((o) => o.value) })).toContainEqual({ path: ["selected"], message: "at most 100 selected" });
    expect(multiSelectValueIssues({ ...ok, note: "" })).toContainEqual({ path: ["note"], message: "note is short text" });
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd ~/workspace/loom-ui/packages/core && pnpm vitest run src/chatValue.test.ts`
Expected: FAIL, `multiSelectValueIssues` is not exported.

- [ ] **Step 3: Implement the checker** (`chatValue.ts`)

Replace the kind block (lines 29–34) with:

```ts
/** The kinds that COLLECT input: static (props only), except that `SelectInput` may bind its current choice and `MultiSelectInput` must bind its options and choice. File upload is the existing `MediaInput`. */
export const TEXT_INPUT_KIND = "TextInput";
export const FORM_INPUT_KIND = "FormInput";
export const SELECT_INPUT_KIND = "SelectInput";
export const MULTI_SELECT_INPUT_KIND = "MultiSelectInput";
export const CHAT_INPUT_KINDS = [
  TEXT_INPUT_KIND,
  FORM_INPUT_KIND,
  SELECT_INPUT_KIND,
  MULTI_SELECT_INPUT_KIND,
] as const;
```

Append at the end of the file:

```ts
// ── MultiSelectInput: the bound value (options and the current choice) ──────────────────────────
//
// Unlike SelectInput's static `options` prop, a MultiSelectInput's options are DATA (a document list
// changes as a user uploads), so the host binds them with the choice. Strict and bounded like the
// transcript; messages are value-free. The host still re-checks every SELECT_MANY against what it
// published (`acceptChatSubmit`'s `optionsOf`): this contract only keeps a malformed value out of a store.

export const MAX_MULTI_OPTIONS = 500;
export const MAX_MULTI_SELECTED = 100;
const MAX_MULTI_VALUE = 128;
const MAX_MULTI_LABEL = 200;
const MAX_MULTI_HINT = 40;
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface MultiSelectOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}
export interface MultiSelectValue {
  readonly options: readonly MultiSelectOption[];
  readonly selected: readonly string[];
  readonly note?: string;
}

const MULTI_KEYS: ReadonlySet<string> = new Set(["options", "selected", "note"]);
const OPTION_KEYS: ReadonlySet<string> = new Set(["value", "label", "hint"]);
const shortText = (v: unknown, max: number): boolean =>
  typeof v === "string" && v.length >= 1 && v.length <= max;

export function multiSelectValueIssues(value: unknown): ChatIssue[] {
  if (!isRecord(value)) return [{ path: [], message: "Expected a multi-select value" }];
  const out: ChatIssue[] = [];
  if (extraKey(value, MULTI_KEYS)) out.push({ path: [], message: "unexpected field" });
  const values = new Set<string>();
  const options = own(value, "options");
  if (!Array.isArray(options)) out.push({ path: ["options"], message: "options is required" });
  else if (options.length > MAX_MULTI_OPTIONS)
    out.push({ path: ["options"], message: `at most ${MAX_MULTI_OPTIONS} options` });
  else
    options.forEach((o: unknown, i: number) => {
      if (!isRecord(o)) return void out.push({ path: ["options", i], message: "an option is { value, label }" });
      if (extraKey(o, OPTION_KEYS)) out.push({ path: ["options", i], message: "unexpected field" });
      const v = own(o, "value");
      if (!shortText(v, MAX_MULTI_VALUE) || CONTROL.test(v as string))
        out.push({ path: ["options", i, "value"], message: "an option value is short text without control characters" });
      else if (values.has(v as string))
        out.push({ path: ["options", i, "value"], message: "option values are unique" });
      else values.add(v as string);
      if (!shortText(own(o, "label"), MAX_MULTI_LABEL))
        out.push({ path: ["options", i, "label"], message: "an option label is short text" });
      const hint = own(o, "hint");
      if (hint !== undefined && !shortText(hint, MAX_MULTI_HINT))
        out.push({ path: ["options", i, "hint"], message: "a hint is short text" });
    });
  const selected = own(value, "selected");
  if (!Array.isArray(selected)) out.push({ path: ["selected"], message: "selected is required" });
  else if (selected.length > MAX_MULTI_SELECTED)
    out.push({ path: ["selected"], message: `at most ${MAX_MULTI_SELECTED} selected` });
  else {
    const seen = new Set<string>();
    selected.forEach((s: unknown, i: number) => {
      if (typeof s !== "string" || !values.has(s))
        out.push({ path: ["selected", i], message: "a selected value is one of the options" });
      else if (seen.has(s)) out.push({ path: ["selected", i], message: "selected values are unique" });
      else seen.add(s);
    });
  }
  const note = own(value, "note");
  if (note !== undefined && !shortText(note, MAX_MULTI_LABEL))
    out.push({ path: ["note"], message: "note is short text" });
  return out;
}
```

- [ ] **Step 4: Wire the contract into both tables and the fuzz generator**

`kindValues.ts`, after `chatContract` (line 449), and in `CONTRACTS` after `SelectInput: optionalString,`:

```ts
/** The MultiSelectValue contract: the shared issue list, recorded in order, like the transcript. */
const multiSelectContract = (v: unknown, p: Path, out: Out): Status => {
  const issues = multiSelectValueIssues(v);
  if (issues.length === 0) return "valid";
  for (const i of issues) {
    for (const seg of i.path) p.push(seg);
    fail(out, p, i.message);
    p.length -= i.path.length;
  }
  return "dirty";
};
```
```ts
  MultiSelectInput: multiSelectContract,
```
Import `multiSelectValueIssues` next to `chatValueIssues`. Extend the U8 comment above `Chat:` with "and MultiSelectInput, which must bind its options and choice".

`values.ts`, after `SelectInput: z.string().optional(),` (import `multiSelectValueIssues` next to `chatValueIssues`):

```ts
  // The options and the current choice, both data (the shared checker, like the transcript).
  MultiSelectInput: z.unknown().superRefine((v, ctx) => {
    for (const i of multiSelectValueIssues(v))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [...i.path], message: i.message });
  }),
```

`kindValues.fuzz.test.ts`, in `GENERATORS` after `SelectInput`:

```ts
  MultiSelectInput: (r) => {
    const o: Record<string, unknown> = {
      options: arr(r, () => ({ value: pick(r, ["a", "b", "c", ""]), label: pick(r, strs) }), 3),
      selected: arr(r, () => pick(r, ["a", "b", "z"]), 2),
    };
    withOptional(r, o, "note", () => pick(r, strs));
    return o;
  },
```

- [ ] **Step 5: Run the core suite**

Run: `cd ~/workspace/loom-ui/packages/core && pnpm vitest run`
Expected: the new tests PASS. Any test that enumerates every kind (for example `genericity.test.ts`, `openVocabularies.test.ts`, `chat.test.ts`'s catalogue count) and now fails because of the 4th input kind belongs to Task 2: leave it red only if Task 2 is next in the same branch, otherwise fix it here.

- [ ] **Step 6: Commit**

```bash
cd ~/workspace/loom-ui && git switch -c feat/multi-select-input-core
git add packages/core/src/chatValue.ts packages/core/src/chatValue.test.ts packages/core/src/kindValues.ts packages/core/src/values.ts packages/core/src/kindValues.fuzz.test.ts
git commit -m "feat(core): MultiSelectInput value contract (options and the current choice, bound)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The catalogue entry, props guard and input spec (loom-ui core)

**Files:**
- Modify: `loom-ui/packages/core/src/chat.ts:24-38` (allow-lists), `:59-106` (`chatPropFindings`), `:116-138` (`chatCatalogEntries`)
- Modify: `loom-ui/packages/core/src/chatSpecs.ts:36-67` (`inputSpecFromProps`)
- Modify: `loom-ui/packages/core/src/chatHost.ts:52-56` (`InputSpec`)
- Test: `loom-ui/packages/core/src/chat.test.ts`, `loom-ui/packages/core/src/chatHost.test.ts` (or wherever `inputSpecFromProps` is tested now: `grep -rn inputSpecFromProps packages/core/src/*.test.ts`)

**Interfaces:**
- Consumes: `MULTI_SELECT_INPUT_KIND`, `MAX_MULTI_SELECTED` (Task 1).
- Produces:
  - `CHAT_ALLOWED_PROPS.MultiSelectInput = ["label", "emptyLabel", "placeholder", "maxSelected"]`
  - `CHAT_TEXT_PROPS.MultiSelectInput = ["label", "emptyLabel", "placeholder"]`
  - `chatCatalogEntries()` has a `MultiSelectInput@1.1.0` entry with `binding: "required"`
  - `InputSpec` gains `{ readonly kind: "MultiSelectInput"; readonly maxSelected: number }`

- [ ] **Step 1: Write the failing tests**

In `chat.test.ts`:

```ts
describe("MultiSelectInput in the catalogue", () => {
  it("is a chat-family entry that must bind its value", () => {
    const e = chatCatalogEntries().find((x) => x.name === "MultiSelectInput");
    expect(e).toMatchObject({
      version: CHAT_TYPE_VERSION,
      binding: "required",
      props: ["label", "emptyLabel", "placeholder", "maxSelected"],
      textProps: ["label", "emptyLabel", "placeholder"],
    });
    expect(isChatFamilyKind("MultiSelectInput")).toBe(true);
  });
  it("refuses an authored value or options, and a maxSelected outside 1..100", () => {
    const codes = (props: Record<string, unknown>) =>
      chatPropFindings("MultiSelectInput", "n", props).map((f) => f.code);
    expect(codes({ label: "Search in", maxSelected: 100 })).toEqual([]);
    expect(codes({ selected: ["a"] })).toEqual(["chat-prop-forbidden"]);
    expect(codes({ options: [] })).toEqual(["chat-prop-forbidden"]);
    expect(codes({ maxSelected: 0 })).toEqual(["chat-prop-shape"]);
    expect(codes({ maxSelected: 101 })).toEqual(["chat-prop-shape"]);
    expect(codes({ maxSelected: 2.5 })).toEqual(["chat-prop-shape"]);
  });
});
```

Next to the existing `inputSpecFromProps` tests:

```ts
it("a MultiSelectInput's spec carries its maxSelected (100 when absent or invalid)", () => {
  expect(inputSpecFromProps("MultiSelectInput", { maxSelected: 3 })).toEqual({ kind: "MultiSelectInput", maxSelected: 3 });
  expect(inputSpecFromProps("MultiSelectInput", {})).toEqual({ kind: "MultiSelectInput", maxSelected: 100 });
  expect(inputSpecFromProps("MultiSelectInput", { maxSelected: 500 })).toEqual({ kind: "MultiSelectInput", maxSelected: 100 });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd ~/workspace/loom-ui/packages/core && pnpm vitest run src/chat.test.ts src/chatHost.test.ts`
Expected: FAIL (no entry; `inputSpecFromProps` returns undefined).

- [ ] **Step 3: Implement**

`chat.ts`: import `MAX_MULTI_SELECTED, MULTI_SELECT_INPUT_KIND` from `./chatValue`. Add to `CHAT_ALLOWED_PROPS`:

```ts
  [MULTI_SELECT_INPUT_KIND]: ["label", "emptyLabel", "placeholder", "maxSelected"],
```
and to `CHAT_TEXT_PROPS`:
```ts
  [MULTI_SELECT_INPUT_KIND]: ["label", "emptyLabel", "placeholder"],
```
In `chatPropFindings`, add a branch before `} else if (key === "fields") {`:
```ts
    } else if (key === "maxSelected") {
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > MAX_MULTI_SELECTED
      )
        err("chat-prop-shape", `"${nodeId}": maxSelected is an integer from 1 to ${MAX_MULTI_SELECTED}`);
```
In `chatCatalogEntries`, replace the inputs line and update the doc comment ("`MultiSelectInput` requires one: its options and choice"):
```ts
    ...CHAT_INPUT_KINDS.map((k) =>
      entry(
        k,
        k === SELECT_INPUT_KIND ? "optional" : k === MULTI_SELECT_INPUT_KIND ? "required" : "none"
      )
    ),
```

`chatHost.ts` `InputSpec`, add:
```ts
  | { readonly kind: "MultiSelectInput"; readonly maxSelected: number }
```

`chatSpecs.ts`: import `MAX_MULTI_SELECTED, MULTI_SELECT_INPUT_KIND` from `./chatValue`; add before `case CHAT_KIND:`:
```ts
    case MULTI_SELECT_INPUT_KIND: {
      const m = props.maxSelected;
      return {
        kind: MULTI_SELECT_INPUT_KIND,
        maxSelected:
          typeof m === "number" && Number.isInteger(m) && m >= 1 && m <= MAX_MULTI_SELECTED
            ? m
            : MAX_MULTI_SELECTED,
      };
    }
```
Update the file's doc comment ("every Chat / TextInput / FormInput / SelectInput / MultiSelectInput node").

- [ ] **Step 4: Run the core suite and typecheck**

Run: `cd ~/workspace/loom-ui/packages/core && pnpm vitest run && pnpm typecheck`
Expected: PASS. `acceptChatSubmit`'s `switch (spec.kind)` no longer covers every kind; TypeScript accepts that until Task 3 because the switch has no exhaustiveness check. Fix any kind-enumerating test that now counts 5 chat kinds instead of 4 by adding `MultiSelectInput` to its expected list.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/chat.ts packages/core/src/chatSpecs.ts packages/core/src/chatHost.ts packages/core/src/*.test.ts
git commit -m "feat(core): MultiSelectInput catalogue entry (binding required), props guard and input spec

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `SELECT_MANY` and host acceptance (loom-ui core)

**Files:**
- Modify: `loom-ui/packages/core/src/chatActions.ts` (vocabulary comment + constant)
- Modify: `loom-ui/packages/core/src/chatForm.ts` (new validator after `validateSelectValue`, line 242)
- Modify: `loom-ui/packages/core/src/chatHost.ts` (vocabulary comment, `Submission`, `AcceptChatOptions`, `TYPE_TO_KIND`, the `switch`, `resumeTarget`)
- Modify: `loom-ui/packages/core/README.md` (action table at line ~573, kinds section at ~443 and ~668)
- Test: `loom-ui/packages/core/src/chatHost.test.ts`

**Interfaces:**
- Consumes: `InputSpec` `MultiSelectInput` (Task 2).
- Produces:
  - `SELECT_MANY_ACTION = "SELECT_MANY"`
  - `validateSelectManyValues(allowed: ReadonlySet<string>, raw: unknown, max: number): { ok: true; values: readonly string[] } | { ok: false; error: "type" | "option" | "range" }`
  - `AcceptChatOptions.optionsOf?: (widgetId: string, principal: string) => ReadonlySet<string> | undefined`
  - `Submission` `{ kind: "select-many"; widgetId; key; values: readonly string[] }`
  - `resumeTarget` passes `{ values }` for `select-many`

- [ ] **Step 1: Write the failing tests** (`chatHost.test.ts`; reuse the file's existing helpers for `current`, a ledger and a stamped action — the shape below is what they build)

```ts
describe("SELECT_MANY", () => {
  const spec = { kind: "MultiSelectInput", maxSelected: 2 } as const;
  const published = new Set(["a", "b", "c"]);
  const accept = (payload: unknown, over: Partial<AcceptChatOptions> = {}) =>
    acceptChatSubmit(
      { type: SELECT_MANY_ACTION, widgetId: "scope", payload, viewedVersion: VIEWED },
      {
        specOf: (id) => (id === "scope" ? spec : undefined),
        principal: "t/u",
        current: CURRENT,
        ledger: new SubmitLedger(),
        optionsOf: (id) => (id === "scope" ? published : undefined),
        ...over,
      }
    );
  const KEY = "k".repeat(16);

  it("accepts a set of published values, and the empty set", () => {
    const r = accept({ values: ["b", "a"], key: KEY });
    expect(r.ok && r.submission).toEqual({ kind: "select-many", widgetId: "scope", key: KEY, values: ["b", "a"] });
    expect(accept({ values: [], key: KEY }).ok).toBe(true);
  });
  it("refuses a value the host did not publish, a repeat, too many, and a non-list", () => {
    expect(accept({ values: ["z"], key: KEY })).toEqual({ ok: false, reason: "invalid", errors: { values: "option" } });
    expect(accept({ values: ["a", "a"], key: KEY })).toEqual({ ok: false, reason: "invalid", errors: { values: "option" } });
    expect(accept({ values: ["a", "b", "c"], key: KEY })).toEqual({ ok: false, reason: "invalid", errors: { values: "range" } });
    expect(accept({ values: "a", key: KEY })).toEqual({ ok: false, reason: "invalid", errors: { values: "type" } });
  });
  it("refuses everything when the host serves no options (absent, undefined, or throwing)", () => {
    expect(accept({ values: [], key: KEY }, { optionsOf: undefined }).ok).toBe(false);
    expect(accept({ values: [], key: KEY }, { optionsOf: () => undefined }).ok).toBe(false);
    expect(accept({ values: [], key: KEY }, { optionsOf: () => { throw new Error("x"); } }).ok).toBe(false);
  });
  it("refuses a bad key, the wrong kind, and never burns a key on a refusal", () => {
    expect(accept({ values: ["a"], key: "short" })).toEqual({ ok: false, reason: "bad-key" });
    expect(accept({ values: ["a"], key: KEY }, { specOf: () => ({ kind: "SelectInput", options: [] }) })).toEqual({ ok: false, reason: "wrong-input" });
    const ledger = new SubmitLedger();
    expect(accept({ values: ["z"], key: KEY }, { ledger }).ok).toBe(false);
    expect(accept({ values: ["a"], key: KEY }, { ledger }).ok).toBe(true);
  });
  it("resumeTarget hands a gate { values }", async () => {
    const resume = vi.fn();
    await resumeTarget(resume)({ kind: "select-many", widgetId: "w", key: KEY, values: ["a"] });
    expect(resume).toHaveBeenCalledWith({ values: ["a"] }, { idempotencyKey: KEY });
  });
});
```

Use the file's own names for the viewed version and current head where it differs from `VIEWED` / `CURRENT`. Add a `stale` case the way the file's SELECT tests do it.

- [ ] **Step 2: Run them and see them fail**

Run: `cd ~/workspace/loom-ui/packages/core && pnpm vitest run src/chatHost.test.ts`
Expected: FAIL, `SELECT_MANY_ACTION` is not exported.

- [ ] **Step 3: Implement**

`chatActions.ts`: add to the vocabulary comment `//   SELECT_MANY   { values, key }          a MultiSelectInput: the whole new choice, not a toggle` and:
```ts
export const SELECT_MANY_ACTION = "SELECT_MANY";
```

`chatForm.ts`, after `validateSelectValue`:
```ts
export type SelectManyValidation =
  | { readonly ok: true; readonly values: readonly string[] }
  | { readonly ok: false; readonly error: "type" | "option" | "range" };

/** A whole new choice for a MultiSelectInput: a list of distinct values the HOST published, at most `max`. */
export function validateSelectManyValues(
  allowed: ReadonlySet<string>,
  raw: unknown,
  max: number
): SelectManyValidation {
  if (!Array.isArray(raw)) return { ok: false, error: "type" };
  if (raw.length > max) return { ok: false, error: "range" };
  const seen = new Set<string>();
  for (const v of raw as readonly unknown[]) {
    if (typeof v !== "string") return { ok: false, error: "type" };
    if (!allowed.has(v) || seen.has(v)) return { ok: false, error: "option" };
    seen.add(v);
  }
  return { ok: true, values: [...seen] };
}
```

`chatHost.ts`:
- Vocabulary comment: add the `SELECT_MANY` line; import `SELECT_MANY_ACTION` and `validateSelectManyValues`.
- `Submission`: add
```ts
  | {
      readonly kind: "select-many";
      readonly widgetId: string;
      readonly key: string;
      readonly values: readonly string[];
    }
```
- `AcceptChatOptions`, after `hasRef`:
```ts
  /**
   * The values the host PUBLISHED as this MultiSelectInput's options (for this principal). Required for
   * `SELECT_MANY`: absent, or answering undefined, every choice is refused. A MultiSelectInput's options are
   * data, not props, so they are matched against what the host served, never against the action.
   */
  readonly optionsOf?: (widgetId: string, principal: string) => ReadonlySet<string> | undefined;
```
- `TYPE_TO_KIND`: `[SELECT_MANY_ACTION]: "MultiSelectInput",`
- Doc comment step 4: "...a select value must be one of the declared options, a multi-select value one of the published ones, ..."
- `switch (spec.kind)`, after `case "SelectInput"`:
```ts
      case "MultiSelectInput": {
        let allowed: ReadonlySet<string> | undefined;
        try {
          allowed = options.optionsOf?.(widgetId, options.principal);
        } catch {
          allowed = undefined;
        }
        if (!(allowed instanceof Set)) return refuse("invalid", { values: "option" });
        const v = validateSelectManyValues(allowed, own(payload, "values"), spec.maxSelected);
        if (!v.ok) return refuse("invalid", { values: v.error });
        submission = { kind: "select-many", widgetId, key, values: v.values };
        break;
      }
```
- `resumeTarget`: add `case "select-many": return resume({ values: s.values }, { idempotencyKey: s.key });` and change its TypeError text to "a resume target takes a form, a selection, a set of choices or text". Leave `paramsTarget` refusing it (a params value is a scalar).

README (`packages/core/README.md`): add a `| MultiSelectInput | \`SELECT_MANY\` | \`{ values, key }\` |` row to the action table; in the inputs section describe the kind (bound `{ options, selected, note? }`, the limits from Global Constraints, `maxSelected`, `emptyLabel`) and the `optionsOf` hook next to `hasRef`; add `MultiSelectInput` `label`, `emptyLabel`, `placeholder`, `maxSelected` to the props list near line 668.

- [ ] **Step 4: Run all loom-ui gates**

Run: `cd ~/workspace/loom-ui && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`
Expected: PASS. If `packages/hydration/src/chatSource.ts` switches on `Submission.kind` exhaustively, add a `select-many` branch that refuses the same way it refuses `select` today.

- [ ] **Step 5: Commit, push, open draft PR 1**

```bash
git add packages/core
git commit -m "feat(core): SELECT_MANY, checked against the options the host published (optionsOf)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push -u origin feat/multi-select-input-core
gh pr create --draft --title "feat(core): MultiSelectInput kind and SELECT_MANY" --body "$(printf 'A chat-family input whose options and choice are bound data, and the action that sets a whole new choice. Spec: docmind/docs/specs/2026-10-22-multi-document-chat-scope-design.md.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)')"
```

---

### Task 4: The web widget `lu-multi-select-input` (loom-ui renderer-lit)

Branch `feat/multi-select-input-web` from `main` after PR 1 merges.

**Files:**
- Create: `loom-ui/packages/renderer-lit/src/widgets/lu-multi-select.ts`
- Create: `loom-ui/packages/renderer-lit/src/widgets/multiSelect.test.ts`
- Modify: `loom-ui/packages/renderer-lit/src/define/lu-inputs.ts`, `src/elements/lu-inputs.ts` (comment), `src/chat.ts` (export, `chatKindContracts`, `TAGS`), `src/dom/litRegistry.ts:181` (placeholder), `README.md:519,564`
- Modify: `loom-ui/packages/core/src/messages.ts:184` (strings)

**Interfaces:**
- Consumes: `MultiSelectValue`, `MultiSelectOption`, `multiSelectValueIssues`, `MAX_MULTI_SELECTED`, `SELECT_MANY_ACTION`, `newSubmitKey`, `oneLineChatText` from `@loom-ui/core/chat-ui`; `dispatch`, `failureText`, `inputStyles`, `DispatchResult` from `./chatShared`; `LuWidget` from `./base`.
- Produces: `<lu-multi-select-input>`, class `LuMultiSelectInput`; DOM hooks for tests and hosts: `[data-multi-select][data-phase]`, `[data-chip="<value>"]` with a `button`, `[data-empty]`, `[data-add]`, `input[data-search]`, `[data-option="<value>"]`, `[data-note]`, `#status`.

- [ ] **Step 1: Add the strings** (`core/src/messages.ts`, after `"lu.input.chooseEllipsis"`)

```ts
  "lu.input.none": "None",
  "lu.input.add": "Add…",
  "lu.input.remove": "Remove",
  "lu.input.noMatches": "No matches",
  "lu.input.search": "Search",
```
and in the terminal block after `"lu.terminal.selectInput"`:
```ts
  "lu.terminal.multiSelectInput": "[choices — answer on an interactive surface]",
  "lu.terminal.moreOptions": "more options",
```
If an i18n fitness test requires every key in every locale, add them wherever that test points.

- [ ] **Step 2: Write the failing tests** (`multiSelect.test.ts`)

```ts
import { SELECT_MANY_ACTION, isSubmitKey } from "@loom-ui/core/chat-ui";
import { customWidget$ } from "@loom/blueprint-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../elements/lu-inputs";

type Mounted = HTMLElement & { updateComplete: Promise<unknown>; value: unknown; widget: unknown };
type Act = { type: string; widgetId: string; payload: { values: string[]; key: string } };
const settle = async (el: Mounted) => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    await el.updateComplete;
  }
};
const value = (selected: string[] = [], note?: string) => ({
  options: [
    { value: "a", label: "Q3 report" },
    { value: "b", label: "Contract v2" },
    { value: "c", label: "Invoice March", hint: "processing" },
  ],
  selected,
  ...(note && { note }),
});
const mount = async (v: unknown, onAction?: (a: Act) => unknown, props: Record<string, unknown> = {}) => {
  const el = document.createElement("lu-multi-select-input") as Mounted;
  Object.assign(el, {
    widget: customWidget$({ kind: "MultiSelectInput", id: "scope", title: "Scope", props: { label: "Search in", emptyLabel: "All documents", placeholder: "Add a document…", ...props } }),
    value: v,
    ...(onAction && { onAction }),
  });
  document.body.appendChild(el);
  await settle(el);
  return el;
};
const q = <T extends Element>(el: HTMLElement, sel: string) => el.shadowRoot?.querySelector(sel) as T | null;
const qa = (el: HTMLElement, sel: string) => Array.from(el.shadowRoot?.querySelectorAll(sel) ?? []);
const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

beforeEach(() => vi.stubGlobal("IntersectionObserver", undefined));
afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("lu-multi-select-input", () => {
  it("draws the bound choice as chips with labelled remove buttons, and the empty label when none", async () => {
    const el = await mount(value(["b"]));
    expect(qa(el, "[data-chip]").map((c) => c.getAttribute("data-chip"))).toEqual(["b"]);
    expect(q(el, '[data-chip="b"] button')?.getAttribute("aria-label")).toBe("Remove Contract v2");
    const none = await mount(value([]));
    expect(q(none, "[data-empty]")?.textContent).toBe("All documents");
  });
  it("adds by mouse: the search lists unchosen options filtered by label, and one SELECT_MANY carries the whole new set", async () => {
    const acts: Act[] = [];
    const el = await mount(value(["b"]), (a) => void acts.push(a));
    q<HTMLButtonElement>(el, "[data-add]")?.click();
    await settle(el);
    // Every unchosen option is offered; a hint never hides one (the host decides what to offer).
    expect(qa(el, "[data-option]").map((o) => o.getAttribute("data-option"))).toEqual(["a", "c"]);
    const search = q<HTMLInputElement>(el, "input[data-search]") as HTMLInputElement;
    search.value = "q3";
    search.dispatchEvent(new Event("input"));
    await settle(el);
    expect(qa(el, "[data-option]").map((o) => o.getAttribute("data-option"))).toEqual(["a"]);
    q(el, '[data-option="a"]')?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await settle(el);
    expect(acts).toHaveLength(1);
    expect(acts[0]?.type).toBe(SELECT_MANY_ACTION);
    expect(acts[0]?.widgetId).toBe("scope");
    expect(acts[0]?.payload.values).toEqual(["b", "a"]);
    expect(isSubmitKey(acts[0]?.payload.key)).toBe(true);
  });
```

The rest of the tests in the same `describe`:

```ts
  it("adds by keyboard (arrows + Enter), Escape closes, Backspace in an empty search removes the last chip", async () => {
    const acts: Act[] = [];
    const el = await mount(value(["a", "b"]), (a) => void acts.push(a));
    q<HTMLButtonElement>(el, "[data-add]")?.click();
    await settle(el);
    const search = q<HTMLInputElement>(el, "input[data-search]") as HTMLInputElement;
    expect(search.getAttribute("role")).toBe("combobox");
    key(search, "Backspace");
    await settle(el);
    expect(acts.at(-1)?.payload.values).toEqual(["a"]);
    key(search, "ArrowDown");
    key(search, "Enter");
    await settle(el);
    expect(acts.at(-1)?.payload.values).toEqual(["a", "b", "c"]);
    key(search, "Escape");
    await settle(el);
    expect(q(el, "input[data-search]")).toBeNull();
  });
  it("removing a chip sends the set without it; removing the last sends the empty set", async () => {
    const acts: Act[] = [];
    const el = await mount(value(["a"]), (a) => void acts.push(a));
    q<HTMLButtonElement>(el, '[data-chip="a"] button')?.click();
    await settle(el);
    expect(acts[0]?.payload.values).toEqual([]);
  });
  it("is busy while a choice is in flight (one send at a time), then shows the bound value; a refusal says so and keeps the bound value", async () => {
    let release: (v: unknown) => void = () => {};
    const el = await mount(value(["a"]), () => new Promise((r) => { release = r; }));
    q<HTMLButtonElement>(el, '[data-chip="a"] button')?.click();
    await settle(el);
    expect(q(el, "[data-multi-select]")?.getAttribute("data-phase")).toBe("sending");
    expect(q<HTMLButtonElement>(el, "[data-add]")?.disabled).toBe(true);
    release({ ok: false, reason: "refused" });
    await settle(el);
    expect(q(el, "[data-multi-select]")?.getAttribute("data-phase")).toBe("failed");
    expect(qa(el, "[data-chip]").map((c) => c.getAttribute("data-chip"))).toEqual(["a"]);
    expect(q(el, "#status")?.getAttribute("role")).toBe("alert");
  });
  it("disables Add at maxSelected", async () => {
    const el = await mount(value(["a", "b"]), undefined, { maxSelected: 2 });
    expect(q<HTMLButtonElement>(el, "[data-add]")?.disabled).toBe(true);
  });
  it("shows the hint after a label and the note under the control, both as one-line text", async () => {
    const el = await mount(value(["c"], "Showing the 200 most recent documents"));
    expect(q(el, '[data-chip="c"]')?.textContent).toContain("Invoice March (processing)");
    expect(q(el, "[data-note]")?.textContent).toBe("Showing the 200 most recent documents");
  });
  it("a malformed bound value draws the contract's error state, never chips; no value yet draws loading", async () => {
    const bad = await mount({ options: [], selected: ["x"] });
    expect(qa(bad, "[data-chip]")).toHaveLength(0);
    const loading = await mount(undefined);
    expect(qa(loading, "[data-chip]")).toHaveLength(0);
  });
  it("no handler: Add still opens, a choice says chat is unavailable instead of pretending", async () => {
    const el = await mount(value([]));
    q<HTMLButtonElement>(el, "[data-add]")?.click();
    await settle(el);
    q(el, '[data-option="a"]')?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    await settle(el);
    expect(q(el, "[data-multi-select]")?.getAttribute("data-phase")).toBe("unavailable");
  });
});
```

For the error/loading test, look at how `inputs.test.ts` asserts the select's error state (`data-state` on the wrapper, around line 410) and assert the same attribute here.

- [ ] **Step 3: Run them and see them fail**

Run: `cd ~/workspace/loom-ui/packages/renderer-lit && pnpm vitest run src/widgets/multiSelect.test.ts`
Expected: FAIL (`lu-multi-select-input` is not defined; no chips).

- [ ] **Step 4: Implement the widget** (`widgets/lu-multi-select.ts`)

```ts
import {
  MAX_MULTI_SELECTED,
  type MultiSelectOption,
  type MultiSelectValue,
  SELECT_MANY_ACTION,
  multiSelectValueIssues,
  newSubmitKey,
  oneLineChatText,
} from "@loom-ui/core/chat-ui";
import { type TemplateResult, css, html, nothing } from "lit";
import { state } from "lit/decorators.js";

import { say } from "../say";
import { titleText } from "../title";
import { LuWidget } from "./base";
import { type DispatchResult, dispatch, failureText, inputStyles } from "./chatShared";

// ── MultiSelectInput (U8): a set of choices, bound ────────────────────────────────────────────────
//
// The options and the current choice are the BOUND value (`MultiSelectValue`), checked by the kind
// contract before this widget sees them, so the base class draws loading / error / stale as for any
// data widget. Each change emits ONE `SELECT_MANY { values, key }` carrying the WHOLE new choice and a
// fresh key; the host re-checks every value against what it published (`optionsOf`). Nothing is shown
// optimistically: the chips are always the bound value, and the control is busy until the host
// answers. Labels, hints and the note are untrusted text, drawn as one line.

type Phase = "idle" | "sending" | "sent" | DispatchResult;

const MAX_SHOWN = 50;

export class LuMultiSelectInput extends LuWidget {
  static styles = [
    inputStyles,
    css`
      .chips { display: flex; flex-wrap: wrap; gap: 4px; list-style: none; margin: 0; padding: 0; align-items: center; }
      [data-chip] { display: inline-flex; align-items: center; gap: 2px; border: 1px solid currentColor; border-radius: 999px; padding: 0 2px 0 8px; }
      [data-chip] button { border: 0; background: none; cursor: pointer; padding: 0 6px; font: inherit; }
      [data-empty] { opacity: 0.8; }
      [role="listbox"] { list-style: none; margin: 4px 0 0; padding: 0; max-height: 240px; overflow: auto; border: 1px solid currentColor; }
      [role="option"] { padding: 4px 8px; cursor: pointer; }
      [role="option"][aria-selected="true"] { outline: 2px solid currentColor; outline-offset: -2px; }
      [data-note] { margin: 4px 0 0; font-size: 0.9em; opacity: 0.8; }
    `,
  ];
  readonly kind = "MultiSelectInput";
  @state() private phase: Phase = "idle";
  @state() private open = false;
  @state() private query = "";
  @state() private active = 0;

  private get model(): MultiSelectValue | undefined {
    return multiSelectValueIssues(this.value).length === 0 ? (this.value as MultiSelectValue) : undefined;
  }
  private get max(): number {
    const m = (this.widget.props as { maxSelected?: unknown }).maxSelected;
    return typeof m === "number" && Number.isInteger(m) && m >= 1 && m <= MAX_MULTI_SELECTED ? m : MAX_MULTI_SELECTED;
  }
  private text(name: string, fallback: string): string {
    return titleText((this.widget.props as Record<string, unknown>)[name]) ?? fallback;
  }
  private static optionText(o: MultiSelectOption): string {
    const label = oneLineChatText(o.label, 200);
    return o.hint === undefined ? label : `${label} (${oneLineChatText(o.hint, 40)})`;
  }
  /** Unchosen options whose label contains the query (case-insensitive), at most MAX_SHOWN. */
  private get matches(): readonly MultiSelectOption[] {
    const m = this.model;
    if (m === undefined) return [];
    const chosen = new Set(m.selected);
    const q = this.query.trim().toLowerCase();
    return m.options
      .filter((o) => !chosen.has(o.value) && (q === "" || o.label.toLowerCase().includes(q)))
      .slice(0, MAX_SHOWN);
  }

  private async send(values: readonly string[]): Promise<void> {
    if (this.phase === "sending") return;
    this.phase = "sending";
    const result = await dispatch(this.onAction, {
      type: SELECT_MANY_ACTION,
      widgetId: this.widget.id,
      payload: { values: [...values], key: newSubmitKey() },
    });
    this.phase = result === "ok" ? "sent" : result;
  }
  private add(value: string): void {
    const m = this.model;
    if (m === undefined || m.selected.includes(value) || m.selected.length >= this.max) return;
    this.query = "";
    this.active = 0;
    void this.send([...m.selected, value]);
  }
  private remove(value: string): void {
    const m = this.model;
    if (m !== undefined) void this.send(m.selected.filter((v) => v !== value));
  }
  private toggle = async (): Promise<void> => {
    this.open = !this.open;
    this.query = "";
    this.active = 0;
    if (!this.open) return;
    await this.updateComplete;
    this.shadowRoot?.querySelector<HTMLInputElement>("input[data-search]")?.focus();
  };
  private onInput = (e: Event): void => {
    this.query = (e.target as HTMLInputElement).value;
    this.active = 0;
  };
  private onKey = (e: KeyboardEvent): void => {
    const list = this.matches;
    if (e.key === "ArrowDown") this.active = Math.min(list.length - 1, this.active + 1);
    else if (e.key === "ArrowUp") this.active = Math.max(0, this.active - 1);
    else if (e.key === "Enter") {
      const o = list[this.active];
      if (o !== undefined) this.add(o.value);
    } else if (e.key === "Escape") {
      this.open = false;
      this.shadowRoot?.querySelector<HTMLButtonElement>("[data-add]")?.focus();
    } else if (e.key === "Backspace" && this.query === "") {
      const last = this.model?.selected.at(-1);
      if (last !== undefined) this.remove(last);
    } else return;
    e.preventDefault();
  };

  protected renderReady(): TemplateResult | typeof nothing {
    const m = this.model;
    if (m === undefined) return nothing;
    const byValue = new Map(m.options.map((o) => [o.value, o]));
    const busy = this.phase === "sending";
    const failed = this.phase === "failed" || this.phase === "stale" || this.phase === "unavailable";
    const list = this.open ? this.matches : [];
    const status = busy ? say("lu.chat.sending") : failed ? failureText(this.phase as DispatchResult) : "";
    const activeId = list[this.active] === undefined ? nothing : `opt-${this.active}`;
    return html`<div data-multi-select data-phase=${this.phase} role="group" aria-labelledby="name" aria-describedby="status">
      <span id="name">${this.text("label", say("lu.input.choose"))}</span>
      <ul class="chips" part="chips">
        ${
          m.selected.length === 0
            ? html`<li data-empty>${this.text("emptyLabel", say("lu.input.none"))}</li>`
            : m.selected.map((v) => {
                const t = LuMultiSelectInput.optionText(byValue.get(v) as MultiSelectOption);
                return html`<li data-chip=${v}><span>${t}</span><button type="button" aria-label=${`${say("lu.input.remove")} ${t}`} ?disabled=${busy} @click=${() => this.remove(v)}>×</button></li>`;
              })
        }
        <li><button type="button" class="btn" data-add aria-expanded=${String(this.open)} ?disabled=${busy || m.selected.length >= this.max} @click=${this.toggle}>${say("lu.input.add")}</button></li>
      </ul>
      ${
        this.open
          ? html`<input data-search role="combobox" aria-label=${say("lu.input.search")} aria-expanded="true" aria-controls="list" aria-autocomplete="list" aria-activedescendant=${activeId} placeholder=${this.text("placeholder", say("lu.input.chooseEllipsis"))} .value=${this.query} ?readonly=${busy} @input=${this.onInput} @keydown=${this.onKey} />
            <ul id="list" role="listbox">${
              list.length === 0
                ? html`<li role="option" aria-disabled="true">${say("lu.input.noMatches")}</li>`
                : list.map(
                    (o, i) => html`<li id=${`opt-${i}`} role="option" aria-selected=${String(i === this.active)} data-option=${o.value} @mousedown=${(e: Event) => {
                      e.preventDefault(); // keep focus in the search
                      this.add(o.value);
                    }}>${LuMultiSelectInput.optionText(o)}</li>`
                  )
            }</ul>`
          : nothing
      }
      ${m.note === undefined ? nothing : html`<p data-note>${oneLineChatText(m.note, 200)}</p>`}
      <div class="status" id="status" role=${failed ? "alert" : "status"} aria-live=${failed ? "assertive" : "polite"} ?data-error=${failed}>${status}</div>
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "lu-multi-select-input": LuMultiSelectInput;
  }
}
```

If `inputStyles` has no `.btn` rule, drop the `class="btn"`; match whatever `lu-inputs.ts` uses for its buttons.

- [ ] **Step 5: Register it**

`define/lu-inputs.ts`:
```ts
import { defineElement } from "../define";
import { LuFormInput, LuSelectInput, LuTextInput } from "../widgets/lu-inputs";
import { LuMultiSelectInput } from "../widgets/lu-multi-select";

/** Register `<lu-text-input>`, `<lu-form-input>`, `<lu-select-input>`, `<lu-multi-select-input>`. Idempotent. */
export function defineInputs(): void {
  defineElement("lu-text-input", LuTextInput);
  defineElement("lu-form-input", LuFormInput);
  defineElement("lu-select-input", LuSelectInput);
  defineElement("lu-multi-select-input", LuMultiSelectInput);
}
```
`elements/lu-inputs.ts`: add `<lu-multi-select-input>` to the comment.
`chat.ts`: `export { LuMultiSelectInput } from "./widgets/lu-multi-select";`; add to `chatKindContracts`:
```ts
  {
    kind: "MultiSelectInput",
    props: ["label", "emptyLabel", "placeholder", "maxSelected"],
    binding: "required",
  },
```
and to `TAGS`: `MultiSelectInput: "lu-multi-select-input",`. Update the top comment's element list.
`dom/litRegistry.ts`: after the `SelectInput` placeholder line add `.register("MultiSelectInput", el("lu-chat-missing"))`.
`README.md`: line 519 list the kind; after line 564 add one paragraph: bound `{ options, selected, note? }`, chips + search, one `SELECT_MANY` per change, busy until answered, the DOM hooks listed in Interfaces.

- [ ] **Step 6: Run the renderer suite and all gates**

Run: `cd ~/workspace/loom-ui && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`
Expected: PASS, including any registry test that checks every chat kind has a tag.

- [ ] **Step 7: Commit, push, draft PR 2**

```bash
git add packages/renderer-lit packages/core/src/messages.ts
git commit -m "feat(renderer-lit): lu-multi-select-input, chips and a search, one SELECT_MANY per change

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push -u origin feat/multi-select-input-web
gh pr create --draft --title "feat(renderer-lit): MultiSelectInput on the web" --body "$(printf 'Chips + search for the MultiSelectInput kind.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)')"
```

---

### Task 5: The terminal prompt (loom-ui renderer-terminal, non-interactive)

Branch `feat/multi-select-input-terminal` from `main` after PR 2 merges.

**Files:**
- Modify: `loom-ui/packages/renderer-terminal/src/registry.ts:461-501`
- Test: `loom-ui/packages/renderer-terminal/src/chat.test.ts:137-180`

**Interfaces:**
- Consumes: `MultiSelectValue`, `multiSelectValueIssues`, `oneLineChatText`; strings `lu.terminal.multiSelectInput`, `lu.terminal.current`, `lu.terminal.moreOptions` (Task 4).
- Produces: `MultiSelectInput` registered on `createLoomUiTerminalRegistry`.

- [ ] **Step 1: Write the failing test** (in `describe("terminal inputs are prompts")`, using the file's `draw(kind, value, props)`)

```ts
  it("a MultiSelectInput lists its chosen options, marked, and counts the rest", () => {
    const v = {
      options: [
        { value: "a", label: "Q3 report" },
        { value: "b", label: "Contract v2", hint: "processing" },
        { value: "c", label: "Invoice" },
      ],
      selected: ["b"],
    };
    expect(draw("MultiSelectInput", v, { label: "Search in", emptyLabel: "All documents" })).toBe(
      "Support: > Search in [choices — answer on an interactive surface]\n      1) Contract v2 (processing) (current)\n      + 2 more options"
    );
    expect(draw("MultiSelectInput", { ...v, selected: [] }, { label: "Search in", emptyLabel: "All documents" })).toBe(
      "Support: > Search in [choices — answer on an interactive surface]\n      All documents\n      + 3 more options"
    );
  });
```

- [ ] **Step 2: Run it and see it fail**

Run: `cd ~/workspace/loom-ui/packages/renderer-terminal && pnpm vitest run src/chat.test.ts`
Expected: FAIL (the kind draws as unknown).

- [ ] **Step 3: Implement** (after `selectPrompt`)

```ts
const multiPrompt =
  (host: boolean, x: Env): TerminalWidgetRenderer =>
  (w, v) => {
    const label = propText(w.props.label) || x.say("lu.input.choose");
    const m = multiSelectValueIssues(v).length === 0 ? (v as MultiSelectValue) : undefined;
    const byValue = new Map((m?.options ?? []).map((o) => [o.value, o]));
    const chosen = (m?.selected ?? []).map((s) => byValue.get(s)).filter((o) => o !== undefined);
    const text = (o: { label: string; hint?: string }) =>
      `${oneLineChatText(o.label, 60)}${o.hint === undefined ? "" : ` (${oneLineChatText(o.hint, 40)})`}`;
    const rows =
      chosen.length === 0
        ? [`${hang(host)}  ${propText(w.props.emptyLabel) || x.say("lu.input.none")}`]
        : chosen.map((o, i) => `${hang(host)}  ${i + 1}) ${text(o)} ${x.say("lu.terminal.current")}`);
    const rest = (m?.options.length ?? 0) - chosen.length;
    if (rest > 0) rows.push(`${hang(host)}  + ${rest} ${x.say("lu.terminal.moreOptions")}`);
    if (m?.note !== undefined) rows.push(`${hang(host)}  ${oneLineChatText(m.note, 200)}`);
    const head = `> ${label} ${x.say("lu.terminal.multiSelectInput")}`;
    return [host ? head : `${title(w)}: ${head}`, ...rows].join("\n");
  };
```
Register: `.register("MultiSelectInput", multiPrompt(host, x))` after `SelectInput`. Import the two names from `@loom-ui/core/chat-ui` next to `optionsProblem`.

- [ ] **Step 4: Run the suite**

Run: `cd ~/workspace/loom-ui/packages/renderer-terminal && pnpm vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/renderer-terminal/src/registry.ts packages/renderer-terminal/src/chat.test.ts
git commit -m "feat(renderer-terminal): MultiSelectInput prompt (chosen options marked, the rest counted)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The terminal checklist (loom-ui renderer-terminal, interactive)

Digits only reach 9 and DocMind can offer 200 documents, so the checklist uses the select's own keys: arrows move, **Space** toggles, Enter sends, Escape backs out (the spec says the same).

**Files:**
- Modify: `loom-ui/packages/renderer-terminal/src/interactive.ts:344` (`ControlKind`), `:366-369` (`Mode`), `:466-490` (`controlsNow`), `:494-531` (`build`), `:602-717` (`handle`)
- Modify: `loom-ui/packages/renderer-terminal/README.md:270-272`
- Test: `loom-ui/packages/renderer-terminal/src/interactive.test.ts`

**Interfaces:**
- Consumes: `SELECT_MANY_ACTION`, `MAX_MULTI_SELECTED`, `multiSelectValueIssues`, `MultiSelectValue`.
- Produces: `ControlKind` `"multi"`.

- [ ] **Step 1: Write the failing tests** (follow how `interactive.test.ts` builds a terminal over a blueprint with a bound `SelectInput`; the store value here is the `MultiSelectValue`)

```ts
describe("a MultiSelectInput checklist", () => {
  const v = {
    options: [
      { value: "a", label: "Q3 report" },
      { value: "b", label: "Contract v2" },
      { value: "c", label: "Invoice" },
    ],
    selected: ["b"],
  };
  it("Enter opens it with the bound choice ticked; Space toggles; Enter sends the whole set once", async () => {
    const acts: unknown[] = [];
    const t = terminalWith("MultiSelectInput", { label: "Search in", maxSelected: 100 }, v, (a) => void acts.push(a));
    expect(t.controls()).toEqual([{ id: "scope", kind: "multi", label: "Search in" }]);
    await t.press({ name: "enter" });
    expect(t.frame()).toContain("› [ ] Q3 report");
    expect(t.frame()).toContain("  [x] Contract v2");
    await t.press({ name: "char", char: " " });
    await t.press({ name: "enter" });
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ type: "SELECT_MANY", widgetId: "scope", payload: { values: ["b", "a"] } });
  });
  it("Escape backs out without sending; Space at maxSelected does not tick another", async () => {
    const acts: unknown[] = [];
    const t = terminalWith("MultiSelectInput", { label: "Search in", maxSelected: 1 }, v, (a) => void acts.push(a));
    await t.press({ name: "enter" });
    await t.press({ name: "char", char: " " });
    expect(t.frame()).toContain("› [ ] Q3 report");
    await t.press({ name: "escape" });
    expect(acts).toHaveLength(0);
  });
  it("shows at most 10 options around the cursor", async () => {
    const many = { options: Array.from({ length: 30 }, (_, i) => ({ value: `v${i}`, label: `Doc ${i}` })), selected: [] };
    const t = terminalWith("MultiSelectInput", { label: "Search in" }, many, () => {});
    await t.press({ name: "enter" });
    expect(t.frame().split("\n").filter((l) => /\[[ x]\] Doc/.test(l))).toHaveLength(10);
  });
});
```

`terminalWith` stands for the file's existing setup helper (or a 6-line local one built from it: a blueprint with one widget `scope` of `kind`, the store holding `value` under its handle, `onAction`). Use the real name.

- [ ] **Step 2: Run them and see them fail**

Run: `cd ~/workspace/loom-ui/packages/renderer-terminal && pnpm vitest run src/interactive.test.ts`
Expected: FAIL (no control for the kind).

- [ ] **Step 3: Implement**

```ts
export type ControlKind = "approval" | "select" | "multi" | "text";
```
```ts
type Mode =
  | { readonly kind: "nav" }
  | { readonly kind: "text"; readonly draft: string }
  | { readonly kind: "pick"; readonly index: number }
  | { readonly kind: "multi"; readonly index: number; readonly picks: readonly string[] };
```
In `controlsNow`, after the `SelectInput` branch:
```ts
      } else if (w.kind === "MultiSelectInput") {
        if (multiSelectValueIssues(boundValue(w)).length === 0)
          out.push({ id: w.id, kind: "multi", label: label || say("lu.input.choose"), widget: w });
```
Helpers next to `optionsOf`:
```ts
  const multiOf = (w: Widget): MultiSelectValue | undefined => {
    const v = boundValue(w);
    return multiSelectValueIssues(v).length === 0 ? (v as MultiSelectValue) : undefined;
  };
  const maxOf = (w: Widget): number => {
    const m = w.props.maxSelected;
    return typeof m === "number" && Number.isInteger(m) && m >= 1 && m <= MAX_MULTI_SELECTED ? m : MAX_MULTI_SELECTED;
  };
```
In `build`, the `else` branch that draws a select: before it, add
```ts
      } else if (c.kind === "multi") {
        lines.push(`${mark} ${c.label}`);
        const m = multiOf(c.widget);
        if (focused && mode.kind === "multi" && m !== undefined) {
          const at = mode.index;
          const from = Math.max(0, Math.min(at - 4, m.options.length - 10));
          const picks = new Set(mode.picks);
          m.options.slice(from, from + 10).forEach((o, k) => {
            const i = from + k;
            lines.push(`   ${i === at ? "›" : " "} [${picks.has(o.value) ? "x" : " "}] ${oneLineChatText(o.label, 60)}`);
          });
        }
```
In `handle`, after the `if (mode.kind === "pick") { … }` block:
```ts
    if (mode.kind === "multi") {
      const m = multiOf(c.widget);
      if (m === undefined) {
        mode = { kind: "nav" };
        return undefined;
      }
      const last = m.options.length - 1;
      if (key.name === "escape") mode = { kind: "nav" };
      else if (key.name === "up") mode = { ...mode, index: Math.max(0, mode.index - 1) };
      else if (key.name === "down") mode = { ...mode, index: Math.min(last, mode.index + 1) };
      else if (key.name === "char" && key.char === " ") {
        const o = m.options[mode.index];
        if (o !== undefined) {
          const has = mode.picks.includes(o.value);
          if (has) mode = { ...mode, picks: mode.picks.filter((p) => p !== o.value) };
          else if (mode.picks.length < maxOf(c.widget)) mode = { ...mode, picks: [...mode.picks, o.value] };
        }
      } else if (key.name === "enter") {
        if (!consent(sole, snap)) return "stop";
        const ok = await dispatch(
          { type: SELECT_MANY_ACTION, widgetId: c.id, payload: { values: [...mode.picks], key: newSubmitKey() } },
          c.widget,
          snap
        );
        if (ok) mode = { kind: "nav" };
        return "stop";
      }
      return undefined;
    }
```
In the navigation `enter` branch:
```ts
      else if (c.kind === "multi") mode = { kind: "multi", index: 0, picks: [...(multiOf(c.widget)?.selected ?? [])] };
```
Update the `hint` text if it lists keys per control kind (search `hint =` in the file) so a focused checklist names Space.

README line 270–272: add "`MultiSelectInput` opens a checklist (Enter): arrows move, Space ticks or unticks (never past `maxSelected`), Enter sends the whole set, Escape backs out. It starts with the bound choice ticked and shows 10 options around the cursor."

- [ ] **Step 4: Run all loom-ui gates**

Run: `cd ~/workspace/loom-ui && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`
Expected: PASS, including `interactive.hostile.test.ts`.

- [ ] **Step 5: Commit, push, draft PR 3**

```bash
cd ~/workspace/loom-ui
git add packages/renderer-terminal
git commit -m "feat(renderer-terminal): MultiSelectInput checklist (Space ticks, Enter sends the set)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push -u origin feat/multi-select-input-terminal
gh pr create --draft --title "feat(renderer-terminal): MultiSelectInput on the terminal" --body "$(printf 'Prompt and interactive checklist for the MultiSelectInput kind.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)')"
```

---

### Task 7: Document lookups in the web API client (docmind)

Branch `feat/scope-picker-data` from docmind `main` (rebase the spec branch `docs/multi-document-chat-scope` in first, or merge its PR).

**Files:**
- Modify: `docmind/apps/web/src/api/client.ts` (interface at lines 34–58, implementation)
- Test: `docmind/apps/web/src/api/client.test.ts`

**Interfaces:**
- Produces on `Api`:
  - `listDocuments(cursor?: string): Promise<ListDocumentsResponse>` — `GET /api/documents?limit=100[&cursor=…]`, most recent first
  - `getDocument(id: string): Promise<DocumentDto>` — `GET /api/documents/:id`; a missing document rejects with `ApiError` status 404

- [ ] **Step 1: Write the failing tests** (follow `client.test.ts`'s fake `http`; the shape below assumes a `request` spy)

```ts
describe("documents for the scope picker", () => {
  it("lists a page of documents, 100 at a time, with the cursor when given", async () => {
    const { api, http } = setup(); // the file's own helper
    await api.listDocuments();
    expect(http.request).toHaveBeenLastCalledWith("GET", "/api/documents?limit=100", expect.objectContaining({ schema: ListDocumentsResponse }));
    await api.listDocuments("abc");
    expect(http.request).toHaveBeenLastCalledWith("GET", "/api/documents?cursor=abc&limit=100", expect.anything());
  });
  it("reads one document by id, escaped", async () => {
    const { api, http } = setup();
    await api.getDocument("a/b");
    expect(http.request).toHaveBeenLastCalledWith("GET", "/api/documents/a%2Fb", expect.objectContaining({ schema: DocumentDto }));
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd ~/workspace/docmind/apps/web && pnpm vitest run src/api/client.test.ts`
Expected: FAIL (`listDocuments` is not a function).

- [ ] **Step 3: Implement**

Imports: change `type DocumentDto` to `DocumentDto` (it is now used as a schema) and add `ListDocumentsResponse`. Interface, after `retryDocument`:
```ts
  listDocuments(cursor?: string): Promise<ListDocumentsResponse>;
  getDocument(id: string): Promise<DocumentDto>;
```
Implementation, after `retryDocument`:
```ts
    listDocuments: (cursor) =>
      http.request("GET", `/api/documents${qs({ cursor, limit: 100 })}`, {
        schema: ListDocumentsResponse,
      }),
    getDocument: (id) =>
      http.request("GET", `/api/documents/${seg(id)}`, { schema: DocumentDto }),
```
Add the two methods (as `vi.fn`) to any shared fake `Api` the type checker now flags (`apps/web/src/testing/`).

- [ ] **Step 4: Run tests and typecheck**

Run: `cd ~/workspace/docmind && pnpm typecheck && pnpm typecheck:tests && pnpm --filter @docmind/web test`
Expected: PASS. (Use the web package's real name from `apps/web/package.json` for `--filter`.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api apps/web/src/testing
git commit -m "feat(web): list and read documents from the API client (for the chat's scope picker)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: The scope picker's model (docmind, pure functions)

**Files:**
- Create: `docmind/apps/web/src/chat/scopePicker.ts`
- Create: `docmind/apps/web/src/chat/scopePicker.test.ts`

**Interfaces:**
- Consumes: `Api.listDocuments`, `Api.getDocument` (Task 7); `ChatScope`, `DocumentDto` from `@docmind/contracts`; `ApiError` from `../api/http`.
- Produces:
  - `PICKER_CAP = 200`
  - `interface ScopeDoc { readonly id: string; readonly title: string; readonly status: DocumentStatus }`
  - `interface PickerValue { options: { value: string; label: string; hint?: string }[]; selected: string[]; note?: string }` (a `MultiSelectValue`)
  - `listRecent(api: Pick<Api, "listDocuments">, cap?: number): Promise<{ docs: ScopeDoc[]; capped: boolean }>`
  - `lookUp(api: Pick<Api, "getDocument">, ids: readonly string[]): Promise<{ found: Map<string, ScopeDoc>; removed: Set<string> }>` (keys lower-cased)
  - `pickerValue(listed: readonly ScopeDoc[], scope: ChatScope, found: ReadonlyMap<string, ScopeDoc>, capped: boolean): PickerValue`
  - `scopeFor(values: readonly string[], removed: ReadonlySet<string>): ChatScope`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/http";
import { PICKER_CAP, listRecent, lookUp, pickerValue, scopeFor } from "./scopePicker";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";
const D = "00000000-0000-4000-8000-00000000000d";
const doc = (id: string, title: string, status = "ready") => ({ id, title, status }) as const;

describe("pickerValue", () => {
  const listed = [doc(A, "Q3 report"), doc(B, "Contract v2"), doc(C, "Invoice", "embedding")];
  it("offers the ready documents; a chat searching everything has no chips", () => {
    expect(pickerValue(listed, "all", new Map(), false)).toEqual({
      options: [{ value: A, label: "Q3 report" }, { value: B, label: "Contract v2" }],
      selected: [],
    });
  });
  it("puts the chat's documents first, in scope order, with a hint for one not ready", () => {
    expect(pickerValue(listed, { documentIds: [C, B] }, new Map(), false)).toEqual({
      options: [
        { value: C, label: "Invoice", hint: "processing" },
        { value: B, label: "Contract v2" },
        { value: A, label: "Q3 report" },
      ],
      selected: [C, B],
    });
  });
  it("labels a scoped document from its own lookup, or as removed when it is gone", () => {
    const found = new Map([[D, doc(D, "Old memo", "failed")]]);
    const gone = "00000000-0000-4000-8000-0000000000ee";
    const v = pickerValue(listed, { documentIds: [D, gone] }, found, false);
    expect(v.options.slice(0, 2)).toEqual([
      { value: D, label: "Old memo", hint: "failed" },
      { value: gone, label: "Removed document" },
    ]);
  });
  it("says when the list is capped; an untitled document falls back to a fixed label", () => {
    expect(pickerValue([doc(A, "")], "all", new Map(), true)).toEqual({
      options: [{ value: A, label: "Untitled document" }],
      selected: [],
      note: `Showing the ${PICKER_CAP} most recent documents`,
    });
  });
});

describe("scopeFor", () => {
  it("drops removed documents, and an empty set searches everything", () => {
    expect(scopeFor([A, B], new Set([B]))).toEqual({ documentIds: [A] });
    expect(scopeFor([B], new Set([B]))).toBe("all");
    expect(scopeFor([], new Set())).toBe("all");
  });
});

describe("listRecent", () => {
  it("pages until the cap and says whether more exist", async () => {
    const page = (n: number, next: string | null) => ({ items: Array.from({ length: n }, (_, i) => ({ ...doc(`${i}`, `T${i}`) })), nextCursor: next });
    const api = { listDocuments: vi.fn().mockResolvedValueOnce(page(100, "c1")).mockResolvedValueOnce(page(100, "c2")) };
    const out = await listRecent(api as never);
    expect(api.listDocuments).toHaveBeenCalledTimes(2);
    expect(api.listDocuments).toHaveBeenLastCalledWith("c1");
    expect(out.docs).toHaveLength(200);
    expect(out.capped).toBe(true);
    const one = { listDocuments: vi.fn().mockResolvedValueOnce(page(3, null)) };
    expect((await listRecent(one as never)).capped).toBe(false);
  });
});

describe("lookUp", () => {
  it("finds each id; a 404 is removed; any other failure is neither (never dropped from a scope on a network error)", async () => {
    const api = {
      getDocument: vi.fn(async (id: string) => {
        if (id === A) return doc(A, "Q3 report");
        if (id === B) throw new ApiError(404, "not_found");
        throw new ApiError(500, "boom");
      }),
    };
    const out = await lookUp(api as never, [A, B, C]);
    expect([...out.found.keys()]).toEqual([A]);
    expect([...out.removed]).toEqual([B]);
  });
});
```

Check `ApiError`'s constructor in `apps/web/src/api/http.ts` and use its real arguments.

- [ ] **Step 2: Run them and see them fail**

Run: `cd ~/workspace/docmind/apps/web && pnpm vitest run src/chat/scopePicker.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** (`scopePicker.ts`)

```ts
import type { ChatScope, DocumentStatus } from "@docmind/contracts";
import type { Api } from "../api/client";
import { ApiError } from "../api/http";

// The chat's "Search in" picker as data: which documents it offers, which are chosen, and what a new
// choice saves as. Pure, apart from the two list/lookup calls. The page publishes `pickerValue` as the
// MultiSelectInput's bound value and keeps its option ids, which are all a SELECT_MANY may name.

/** At most this many recent documents are offered (the library's own cap). */
export const PICKER_CAP = 200;
const REMOVED = "Removed document";
const UNTITLED = "Untitled document";

export interface ScopeDoc {
  readonly id: string;
  readonly title: string;
  readonly status: DocumentStatus;
}
export interface PickerValue {
  options: { value: string; label: string; hint?: string }[];
  selected: string[];
  note?: string;
}

const key = (id: string): string => id.toLowerCase();
const labelOf = (d: ScopeDoc): string => d.title.trim().slice(0, 200) || UNTITLED;
const hintOf = (d: ScopeDoc): string | undefined =>
  d.status === "ready" ? undefined : d.status === "failed" ? "failed" : "processing";
const option = (d: ScopeDoc) => {
  const hint = hintOf(d);
  return { value: d.id, label: labelOf(d), ...(hint !== undefined && { hint }) };
};

/** The most recent documents, a page of 100 at a time, up to `cap`; `capped` when more exist. */
export async function listRecent(
  api: Pick<Api, "listDocuments">,
  cap = PICKER_CAP,
): Promise<{ docs: ScopeDoc[]; capped: boolean }> {
  const docs: ScopeDoc[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.listDocuments(cursor);
    docs.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined && docs.length < cap);
  return { docs: docs.slice(0, cap), capped: cursor !== undefined || docs.length > cap };
}

/** Each id read on its own: found, or removed on a 404. Another failure is neither, so a flaky network never drops a document from a scope. */
export async function lookUp(
  api: Pick<Api, "getDocument">,
  ids: readonly string[],
): Promise<{ found: Map<string, ScopeDoc>; removed: Set<string> }> {
  const found = new Map<string, ScopeDoc>();
  const removed = new Set<string>();
  await Promise.all(
    ids.map(async (id) => {
      try {
        found.set(key(id), await api.getDocument(id));
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) removed.add(key(id));
      }
    }),
  );
  return { found, removed };
}

/** The picker's bound value: the chat's documents first (in scope order), then every other ready one. */
export function pickerValue(
  listed: readonly ScopeDoc[],
  scope: ChatScope,
  found: ReadonlyMap<string, ScopeDoc>,
  capped: boolean,
): PickerValue {
  const selected = scope === "all" ? [] : [...scope.documentIds];
  const byId = new Map(listed.map((d) => [key(d.id), d]));
  const chosen = new Set(selected.map(key));
  const options: PickerValue["options"] = selected.map((id) => {
    const d = byId.get(key(id)) ?? found.get(key(id));
    return d === undefined ? { value: id, label: REMOVED } : { ...option(d), value: id };
  });
  for (const d of listed) if (d.status === "ready" && !chosen.has(key(d.id))) options.push(option(d));
  return { options, selected, ...(capped && { note: `Showing the ${PICKER_CAP} most recent documents` }) };
}

/** What a chosen set saves as: removed documents dropped (the server refuses them), none left is "all". */
export function scopeFor(values: readonly string[], removed: ReadonlySet<string>): ChatScope {
  const keep = values.filter((v) => !removed.has(key(v)));
  return keep.length === 0 ? "all" : { documentIds: keep };
}
```

The test for an unlooked-up, unlisted id (neither found nor removed, e.g. after a 500) labels it "Removed document" in `pickerValue` but `scopeFor` keeps it because it is not in `removed`. That is intended: the chip is honest that it cannot be shown, and saving never drops it by mistake. Add one test line asserting `scopeFor([C], new Set())` is `{ documentIds: [C] }`.

- [ ] **Step 4: Run tests, lint, typecheck**

Run: `cd ~/workspace/docmind && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm --filter @docmind/web test`
Expected: PASS.

- [ ] **Step 5: Commit, push, draft PR 4**

```bash
git add apps/web/src/chat/scopePicker.ts apps/web/src/chat/scopePicker.test.ts
git commit -m "feat(web): the chat scope picker's model (offered documents, chips, what a choice saves as)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push -u origin feat/scope-picker-data
gh pr create --draft --title "feat(web): data for the chat's document picker" --body "$(printf 'API client document lookups and the pure model behind the multi-document scope picker. Nothing uses it yet. Spec: docs/specs/2026-10-22-multi-document-chat-scope-design.md.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)')"
```

---

### Task 9: The intent and the experience (docmind)

Branch `feat/multi-document-scope` from docmind `main` after PR 4 merges **and** after loom-ui PRs 1–3 merge.

**Files:**
- Modify: `docmind/.github/workflows/ci.yml:31` (`LOOM_UI_REF` → loom-ui `main` SHA after PR 3; also move the local linked checkout to it, as the memory file `loom-repo-topology.md` describes)
- Modify: `docmind/packages/contracts/src/intents.ts:18` (type), `:120-123` (resolver)
- Modify: `docmind/packages/experiences/src/catalog.ts:13-48`
- Modify: `docmind/packages/experiences/src/views.ts:200-213`
- Test: `docmind/packages/contracts/src/intents.test.ts:111-118`, `docmind/packages/experiences/src/views.test.ts:138-180`, `docmind/packages/experiences/src/terminal.test.ts:135-146`

**Interfaces:**
- Consumes: loom-ui `MultiSelectInput` entry (`binding: "required"`, props `label`, `emptyLabel`, `placeholder`, `maxSelected`).
- Produces: `Intent` `{ type: "chat.scope"; scope: "all" | { documentIds: string[] } }`; the chat view resolves `SELECT_MANY` against `held.list`; `ScopeSelect` is a `MultiSelectInput`.

- [ ] **Step 1: Write the failing tests**

`intents.test.ts`, replace the SELECT assertions in "switches the scope, cites a source, and loads older turns" with:

```ts
    const A = "00000000-0000-4000-8000-00000000000a";
    const B = "00000000-0000-4000-8000-00000000000b";
    const held = { list: [A, B] };
    const many = (values: unknown) => intentOf("chat", { type: "SELECT_MANY", payload: { values, key: "k" } }, held);
    expect(many([B.toUpperCase(), A, B])).toEqual({ type: "chat.scope", scope: { documentIds: [B, A] } });
    expect(many([])).toEqual({ type: "chat.scope", scope: "all" });
    expect(many(["00000000-0000-4000-8000-0000000000ff"])).toBeUndefined();
    expect(many("a")).toBeUndefined();
    expect(many([1])).toBeUndefined();
    expect(many(Array.from({ length: 101 }, () => A))).toBeUndefined();
    expect(intentOf("chat", { type: "SELECT_MANY", payload: { values: [A], key: "k" } })).toBeUndefined();
    expect(intentOf("chat", { type: "SELECT", payload: { value: "started", key: "k" } })).toBeUndefined();
```

`views.test.ts`, in `describe("the chat's scope control")` replace the first test with:

```ts
    it("is a multi-select bound to the chatScope handle, offering documents as data, never as props", () => {
      expect(scope().type).toBe("ScopeSelect");
      expect(scope().binding).toEqual({ handle: "chatScope", priority: "P2" });
      expect(scope().props).toEqual({
        label: "Search in",
        emptyLabel: "All documents",
        placeholder: "Add a document…",
        maxSelected: 100,
      });
      expect(Object.keys(EXPERIENCES.chat.providers).sort()).toEqual(["chatScope", "transcript"]);
      const entry = DOCMIND_CATALOG.entries.find((e) => e.name === "ScopeSelect");
      expect((entry?.surfaces?.web as { kind: string }).kind).toBe("MultiSelectInput");
    });
```

`terminal.test.ts`, replace "draws the chat's scope with the current choice marked":

```ts
  it("draws the chat's chosen documents, marked, from the published scope", async () => {
    const h = open("chat");
    await settled(h);
    const value = {
      options: [
        { value: "00000000-0000-4000-8000-00000000000a", label: "Contract 1" },
        { value: "00000000-0000-4000-8000-00000000000b", label: "Contract 2" },
      ],
      selected: ["00000000-0000-4000-8000-00000000000b"],
    };
    expect(h.split.publishValue("chatScope", value, { kind: "MultiSelectInput" })).toEqual({ ok: true });
    const out = draw(h);
    expect(out).toContain("Contract 2 (current)");
    expect(out).toContain("+ 1 more options");
  });
```

- [ ] **Step 2: Run them and see them fail**

Run: `cd ~/workspace/docmind && pnpm --filter @docmind/contracts test && pnpm --filter @docmind/experiences test`
Expected: FAIL on the new assertions.

- [ ] **Step 3: Implement**

`intents.ts`, type:
```ts
  | { type: "chat.scope"; scope: "all" | { documentIds: string[] } }
```
Above `resolve`, add:
```ts
/** The most documents one chat may search (the server's `ChatScope` bound). */
const MAX_SCOPE = 100;
/** A whole new choice of documents: each value one the surface published (held spelling), repeats folded. */
const heldIds = (raw: unknown, held: Held): string[] | undefined => {
  if (!Array.isArray(raw) || raw.length > MAX_SCOPE || !Array.isArray(held.list)) return undefined;
  const list = held.list as readonly unknown[];
  const out: string[] = [];
  for (const v of raw as readonly unknown[]) {
    if (typeof v !== "string") return undefined;
    const want = v.toLowerCase();
    const found = list.find((k) => typeof k === "string" && k.toLowerCase() === want);
    if (!isUuid(found)) return undefined;
    if (!out.includes(found)) out.push(found);
  }
  return out;
};
```
In `case "chat"`, replace the `if (type === "SELECT") { … }` block with:
```ts
      if (type === "SELECT_MANY") {
        const ids = heldIds(own(p, "values"), held);
        return ids === undefined
          ? undefined
          : { type: "chat.scope", scope: ids.length === 0 ? "all" : { documentIds: ids } };
      }
```
Update `Held.list`'s doc comment: "the list it published (a view's rows or suggestions; the chat's offered document ids)".

`catalog.ts`, `KINDS`, after `SelectInput`:
```ts
  MultiSelectInput: {
    kind: "MultiSelectInput",
    props: ["label", "emptyLabel", "placeholder", "maxSelected"],
    binding: "required",
  },
```
`ENTRY_KINDS`: `ScopeSelect: "MultiSelectInput",`.

`views.ts`, the `scope` widget:
```ts
      widget({
        id: "scope",
        type: "ScopeSelect",
        handle: "chatScope",
        priority: "P2",
        props: {
          label: "Search in",
          emptyLabel: "All documents",
          placeholder: "Add a document…",
          maxSelected: 100,
        },
      }),
```

`ci.yml:31`: set `LOOM_UI_REF` to `git -C ~/workspace/loom-ui rev-parse origin/main` (after PR 3 merged), and check out that SHA in the local linked loom-ui so local and CI agree.

- [ ] **Step 4: Run the package suites**

Run: `cd ~/workspace/docmind && pnpm --filter @docmind/contracts test && pnpm --filter @docmind/experiences test`
Expected: PASS. `apps/web` does not typecheck yet (`dm-chat-page.ts` still passes `"started"`): Task 10 fixes it in the same PR. Do not push between Tasks 9 and 10.

- [ ] **Step 5: Commit (local only)**

```bash
git add .github/workflows/ci.yml packages/contracts/src/intents.ts packages/contracts/src/intents.test.ts packages/experiences/src
git commit -m "feat(chat): the scope is a set of documents (SELECT_MANY on a MultiSelectInput), loom-ui moved

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: The chat page publishes the picker and saves the choice (docmind)

**Files:**
- Modify: `docmind/apps/web/src/components/dm-chat-page.ts` (fields 74–79, `bind` 202–232, `readMeta` 234–244, `publishScope` 283–288, `send` 386–407, `scope` 412–433, `act` 435–449, `connectedCallback`/`disconnectedCallback`)
- Test: `docmind/apps/web/src/components/dm-chat-page.test.ts` (setup at 55–113; the scope tests at 324–410)

**Interfaces:**
- Consumes: `listRecent`, `lookUp`, `pickerValue`, `scopeFor`, `ScopeDoc` (Task 8); `Api.listDocuments`, `Api.getDocument` (Task 7); `Intent` `chat.scope` with `"all" | { documentIds }` (Task 9).
- Produces: the `chatScope` handle published as a `MultiSelectInput` value; `held.list` for the chat view is the published option ids.

- [ ] **Step 1: Write the failing tests**

In `setup`, add to the fake `api`:
```ts
    listDocuments: vi.fn(async () => ({
      items: [
        { id: DOC, title: "Contract", status: "ready" },
        { id: DOC2, title: "Invoice", status: "ready" },
      ],
      nextCursor: null,
    })),
    getDocument: vi.fn(async () => {
      throw new ApiError(404, "not_found");
    }),
```
with `const DOC2 = "00000000-0000-4000-8000-0000000000d2";` next to `DOC`. Replace `selectOf` with helpers:
```ts
const picker = (p: Element) =>
  viewOf(p)?.shadowRoot?.querySelector("lu-multi-select-input")?.shadowRoot ?? null;
const chips = (p: Element) =>
  Array.from(picker(p)?.querySelectorAll("[data-chip]") ?? []).map((c) => c.getAttribute("data-chip"));
const addDoc = async (p: Element, id: string) => {
  (picker(p)?.querySelector("[data-add]") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(picker(p)?.querySelector(`[data-option="${id}"]`)).not.toBeNull());
  picker(p)?.querySelector(`[data-option="${id}"]`)?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
};
const removeDoc = (p: Element, id: string) =>
  (picker(p)?.querySelector(`[data-chip="${id}"] button`) as HTMLButtonElement).click();
```
Replace the four scope tests (324–410) with:

```ts
  it("shows the chat's documents as chips, and adds one: the PATCH carries the whole set", async () => {
    const t = setup();
    const page = await t.mount();
    await vi.waitFor(() => expect(chips(page)).toEqual([DOC]));
    await addDoc(page, DOC2);
    await vi.waitFor(() =>
      expect(t.api.patchChat).toHaveBeenCalledWith(CHAT, { scope: { documentIds: [DOC, DOC2] } }),
    );
    await vi.waitFor(() => expect(chips(page)).toEqual([DOC, DOC2]));
  });

  it("removing the last chip searches every document again, and never patches by itself", async () => {
    const t = setup();
    const page = await t.mount();
    await vi.waitFor(() => expect(chips(page)).toEqual([DOC]));
    expect(t.api.patchChat).not.toHaveBeenCalled();
    removeDoc(page, DOC);
    await vi.waitFor(() => expect(t.api.patchChat).toHaveBeenCalledWith(CHAT, { scope: "all" }));
    await vi.waitFor(() => expect(picker(page)?.querySelector("[data-empty]")?.textContent).toBe("All documents"));
  });

  it("a deleted document stays as a 'Removed document' chip and is dropped on the next save", async () => {
    const GONE = "00000000-0000-4000-8000-0000000000ee";
    const t = setup(`/chats/${CHAT}`, {
      getChat: vi.fn(async () => ({ id: CHAT, title: null, scope: { documentIds: [GONE, DOC] }, createdAt: "2026-10-21T10:00:00.000Z", lastMessageAt: null, messageCount: 2 })),
    });
    const page = await t.mount();
    await vi.waitFor(() => expect(picker(page)?.querySelector(`[data-chip="${GONE}"]`)?.textContent).toContain("Removed document"));
    await addDoc(page, DOC2);
    await vi.waitFor(() =>
      expect(t.api.patchChat).toHaveBeenCalledWith(CHAT, { scope: { documentIds: [DOC, DOC2] } }),
    );
  });

  it("a refused save keeps the chips and says so", async () => {
    const t = setup(`/chats/${CHAT}`, {
      patchChat: vi.fn(async () => {
        throw new ApiError(500, "boom");
      }),
    });
    const page = await t.mount();
    await vi.waitFor(() => expect(chips(page)).toEqual([DOC]));
    await addDoc(page, DOC2);
    await vi.waitFor(() => expect(toastTexts(t)).toContain("Could not change where this chat searches."));
    expect(chips(page)).toEqual([DOC]);
  });

  it("a new chat holds the choice itself and is created with it on the first send", async () => {
    const t = setup("/chats");
    const page = await t.mount();
    await vi.waitFor(() => expect(picker(page)?.querySelector("[data-empty]")).not.toBeNull());
    await addDoc(page, DOC2);
    await vi.waitFor(() => expect(chips(page)).toEqual([DOC2]));
    expect(t.api.patchChat).not.toHaveBeenCalled();
    typeAndSend(page, "first question");
    await vi.waitFor(() =>
      expect(t.api.createChat).toHaveBeenCalledWith({ scope: { documentIds: [DOC2] } }),
    );
  });
```

`toastTexts(t)` stands for however the file already reads toasts (search the file for `toasts`); use that. `"/chats"` stands for the new-chat route the file's existing first-send tests use (`grep -n 'setup("/' dm-chat-page.test.ts`). Keep the "keeps the choice across turns" check by adding, to the first test, a `typeAndSend` after the PATCH and asserting the chips are unchanged once `phase(page)` is `"sent"`.

- [ ] **Step 2: Run them and see them fail**

Run: `cd ~/workspace/docmind/apps/web && pnpm vitest run src/components/dm-chat-page.test.ts`
Expected: FAIL (no `lu-multi-select-input` value is published; `"started"` code paths).

- [ ] **Step 3: Implement**

Imports: add `import { type ScopeDoc, listRecent, lookUp, pickerValue, scopeFor } from "../chat/scopePicker";`.

Fields — replace `startedIds` and `scopeValue` (lines 77–79) with:
```ts
  /** The scope this chat searches: the server's for an existing chat, the page's own for a new one (sent with its first message). */
  private scopeNow: ChatScope = "all";
  /** What the picker offers, once loaded; nothing is published before it (a chip would be mislabelled). */
  private offer: { docs: ScopeDoc[]; capped: boolean; found: Map<string, ScopeDoc>; removed: Set<string> } | undefined;
  /** The option ids last published: all a SELECT_MANY may name. */
  private offered: string[] = [];
  /** Bumped on every bind and reload: an older load's answer is dropped. */
  private loads = 0;
```

`bind`: replace `this.startedIds = undefined; this.scopeValue = undefined;` with `this.scopeNow = "all"; this.offer = undefined; this.offered = [];`, and before the `if (id === undefined) return void this.requestUpdate();` line add `void this.loadOffer();` so a new chat loads its picker too.

`readMeta`: replace the two scope lines with:
```ts
        this.scopeNow = c.scope;
        void this.loadOffer();
```

Add after `readMeta`:
```ts
  /** The recent documents, plus a lookup for any of the scope's that the list does not hold. */
  private async loadOffer(): Promise<void> {
    const api = this.ctx.services?.api;
    if (!api) return;
    const n = ++this.loads;
    try {
      const { docs, capped } = await listRecent(api);
      const listed = new Set(docs.map((d) => d.id.toLowerCase()));
      const missing = this.scopeNow === "all" ? [] : this.scopeNow.documentIds.filter((id) => !listed.has(id.toLowerCase()));
      const { found, removed } = await lookUp(api, missing);
      if (n !== this.loads) return;
      this.offer = { docs, capped, found, removed };
      this.publishScope();
    } catch {
      if (n === this.loads) this.toast("Could not load your documents.");
    }
  }
  private onFocus = () => void this.loadOffer();
```
Register `window.addEventListener("focus", this.onFocus)` in `connectedCallback` and remove it in `disconnectedCallback`, next to the existing listeners.

`publishScope`:
```ts
  /** The picker's bound value: what is offered and what this chat searches. Nothing until the offer is loaded. */
  private publishScope(): void {
    if (this.offer === undefined) return;
    const v = pickerValue(this.offer.docs, this.scopeNow, this.offer.found, this.offer.capped);
    this.offered = v.options.map((o) => o.value);
    this.session?.publish("chatScope", v, "MultiSelectInput");
  }
```

`send`: `const chat = await svc.api.createChat({ scope: this.scopeNow });`

`scope` — replace the method:
```ts
  private async scope(next: ChatScope) {
    const svc = this.ctx.services;
    if (!svc) return { ok: false };
    const scope = next === "all" ? "all" : scopeFor(next.documentIds, this.offer?.removed ?? new Set());
    const id = this.chatId;
    if (id === undefined) {
      this.scopeNow = scope; // a new chat: sent with its first message
      this.publishScope();
      return { ok: true };
    }
    try {
      await svc.api.patchChat(id, { scope });
      this.scopeNow = scope;
      this.publishScope();
      return { ok: true };
    } catch {
      this.toast("Could not change where this chat searches.");
      return { ok: false };
    }
  }
```

`act`: `const intent = intentOf("chat", a, { refs: this.controller?.heldRefs() ?? new Map(), list: this.offered });`

Delete the `scopeValue` doc comment and any remaining `startedIds` / `"started"` references (`grep -n 'started' apps/web/src` must find none in the chat page).

- [ ] **Step 4: Run every DocMind gate**

Run: `cd ~/workspace/docmind && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`
Expected: PASS.

- [ ] **Step 5: Check it in the running app**

Run: `cd ~/workspace/docmind && pnpm serve` (test Postgres on port 55432 per `docmind-m1-carry-forwards.md`). In the browser: open a chat from a document's "Ask" (one chip); add a second document; ask a question; check every citation in Sources is from those two; remove both chips ("All documents"); start a new chat, pick one document before sending, and confirm the created chat searches only it.

- [ ] **Step 6: Commit, push, draft PR 5**

```bash
git add apps/web/src/components/dm-chat-page.ts apps/web/src/components/dm-chat-page.test.ts
git commit -m "feat(web): choose the documents a chat searches (chips + search, saved on every change)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push -u origin feat/multi-document-scope
gh pr create --draft --title "feat(chat): choose several documents for a chat" --body "$(printf '\"Search in\" becomes a multi-document picker (loom-ui MultiSelectInput). Existing chats save through PATCH /api/chats/:id; a new chat is created with the chosen set. Deleted documents stay as \"Removed document\" chips and are dropped on the next save. Spec: docs/specs/2026-10-22-multi-document-chat-scope-design.md.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)')"
```

---

## Spec updates made with this plan

Writing the plan against the code changed four details; the spec was edited to match in the same commit as this plan:

1. **`note` is part of the bound value, not a prop.** A prop is fixed when the experience is compiled, so the page could not show "Showing the 200 most recent documents" only when the list is capped. `MultiSelectValue` carries `note?`; the props are `label`, `emptyLabel`, `placeholder`, `maxSelected`.
2. **Terminal keys.** Space ticks and Enter sends, instead of typing numbers (Task 6).
3. **How documents are offered.** There is no documents-changed signal in the web app: the page loads the picker when a chat binds and again when the window regains focus. It lists the 200 most recent documents (any status, `GET /api/documents`, 100 per page) and offers the ready ones. A scoped document the list does not hold is read on its own (`GET /api/documents/:id`): found, it is a chip with its title; a 404 is "Removed document"; any other failure is also shown as "Removed document" but is never dropped on save.
4. **Untitled documents** show as "Untitled document".
