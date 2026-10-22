# Multi-document chat scope

**Date:** 2026-10-22 · **Status:** design approved, awaiting spec review · **Repos:** loom-ui, docmind

## Problem

A chat searches either every document (`"all"`) or the documents it was started from. The "Ask" row
action and "Ask a question" on a document start a chat over that one document; the chat's "Search in"
select only switches between `"all"` and `"started"`. There is no way to choose several documents.

The server already supports it: `ChatScope` is `"all" | { documentIds }` (1–100,
`packages/contracts/src/chats.ts`), `PATCH /api/chats/:id` changes a chat's scope, and retrieval limits
seeds and hop targets to `documentIds`. The gap is the interface, and loom-ui has no multi-select
input to build it from.

## Decisions

- Documents are chosen **in the chat**, in place of "Search in". The library table is unchanged.
- The scope can be changed **at any time**. Later turns use the new set; earlier turns keep their citations.
- The picker is **chips plus search**: the chosen documents show as removable chips, "+ Add…" opens a
  search over the offered documents.
- It is a new loom-ui kind, `MultiSelectInput`, rendered on the web and terminal surfaces. Extending
  `SelectInput` was rejected: it would change a kind other apps depend on (chat-family kinds match their
  version exactly), and its options are static props that cannot follow a changing document list. A
  DocMind-only web component was rejected: DocMind's UI is loom-ui-native and surface-agnostic.

## 1. loom-ui: `MultiSelectInput`

### Kind

A chat-family kind at `CHAT_TYPE_VERSION`. Static props:

| Prop | Type | Meaning |
|---|---|---|
| `label` | string | the control's label |
| `emptyLabel` | string | what an empty selection reads as |
| `placeholder` | string | the search box's placeholder |
| `maxSelected` | integer 1–100 | the most values that can be chosen |
| `note` | string, optional | a line under the control (e.g. that the options are capped) |

It must bind its value. The bound value:

```ts
{ options: { value: string; label: string; hint?: string }[]; selected: string[] }
```

The shared checker (`kindValues.ts`, `values.ts`, alongside the other chat-family kinds) accepts it when
every label and hint is a string, the option values are unique, every `selected` value is one of the
options and appears once, `options` has at most 500 entries and `selected` at most `maxSelected`. A
value that fails is refused like any malformed binding. `hint` is shown after the label (DocMind uses
it for "processing", "failed").

`inputSpecFromProps` returns `{ kind: "MultiSelectInput", maxSelected }` when the props are valid.

### Action

`SELECT_MANY { values, key }` (`chatActions.ts`): the whole new selection, not a toggle, so a replay is
the same change. `values` is an array of strings; an empty array is the empty state.

### Host acceptance

`acceptChatSubmit` maps `SELECT_MANY` to `MultiSelectInput`. The client sends only values, so the host
never trusts them: `AcceptChatOptions` gains

```ts
readonly optionsOf?: (widgetId: string, principal: string) => ReadonlySet<string> | undefined;
```

shaped like `hasRef`, returning the values the host itself published for that widget. The action is
refused as `invalid` when `optionsOf` is absent or returns undefined, a value is not a string or not in
the set, a value repeats, or there are more than `maxSelected`. The usual order holds: kind match,
freshness, value checks, then the key is claimed last. The submission is
`{ kind: "select-many", widgetId, key, values }`.

### Renderers

- **Web** (`renderer-lit`, `lu-inputs.ts`). Chips for the selection, each with a remove button labelled
  "Remove <label>". "+ Add…" opens a combobox (ARIA combobox/listbox) filtering the unselected options by
  a case-insensitive substring of the label. Keys: arrows move, Enter adds, Esc closes, Backspace in an
  empty search removes the last chip. With nothing selected the control reads `emptyLabel`. Each change
  dispatches one `SELECT_MANY` with a fresh key; the control is disabled until the bound value changes
  or the action is refused, and on a refusal it shows the bound value again. At `maxSelected` "+ Add…"
  is disabled.
- **Terminal** (`renderer-terminal`, `interactive.ts`). A numbered list with `[x]` marks; typing numbers
  (space- or comma-separated) toggles them, Enter dispatches `SELECT_MANY`.

Both renderer READMEs and the core README document the kind and the action.

## 2. DocMind wiring

### Contracts (`packages/contracts/src/intents.ts`)

- `chat.scope` becomes `{ type: "chat.scope"; scope: "all" | { documentIds: string[] } }`.
- The chat view resolves `SELECT_MANY` (and no longer `SELECT`). Each value must match, ignoring case,
  an id in `held.list`, the document ids the page published; the resolved ids are the held spellings,
  deduplicated. An empty list resolves to `"all"`. More than 100 ids resolves to nothing.
- `"started"` goes away: the chips show exactly which documents a chat started with.

### Experience (`packages/experiences/src/catalog.ts`, `views.ts`)

`ScopeSelect` becomes a `MultiSelectInput` with label "Search in", `emptyLabel` "All documents",
placeholder "Add a document…", `maxSelected` 100, still bound to the `chatScope` handle. The page sets
`note` when the options are capped (see Edge cases).

### Chat page (`apps/web/src/components/dm-chat-page.ts`)

- **Options.** On bind the page lists ready documents with the library's list call and `LIST_CAP`
  (200), most recent first, and lists them again when documents change (the existing documents-changed
  signal if there is one, otherwise when the page regains focus). It publishes `chatScope` as
  `{ options, selected }` and keeps the option ids as `held.list` for the resolver.
- **Existing chat.** `selected` is the chat's served scope (`[]` for `"all"`). A `chat.scope` intent sends
  `PATCH /api/chats/:id { scope }` and republishes after it succeeds. This replaces `startedIds`,
  `scopeValue` and the `"started"` branch of `scope()`.
- **New chat.** No chat exists until the first send, so the page holds the selection itself and
  republishes it; the first send creates the chat with it instead of `createChat({ scope: "all" })`.
- **From a document.** "Ask" (`document.ask`) and "Ask a question" (`document.ask-question`) already
  create `{ documentIds: [id] }`; the chat opens with that one chip.

### Server

No change. `ChatScope`, `normalizeScope`, `scopeIsOwned`, `PATCH` and retrieval already support it.

## 3. Edge cases

`PATCH` refuses a scope unless every id is an existing document the user owns (`scopeIsOwned`,
`apps/server/app/chats/access.ts`). The page accounts for it:

| Case | Behaviour |
|---|---|
| A document in the scope was deleted | The options are the listed documents plus every id in the scope. An id the list cannot return becomes an option labelled "Removed document", so the chip stays and can be removed. On the next change the page drops those ids from the `PATCH`; if none remain, the scope is `"all"`. Retrieval already finds nothing for them. |
| A document in the scope is processing or failed | Shown as a chip with its title and hint "processing" / "failed". Not offered by "+ Add…" until ready. |
| More than 200 ready documents | Options are the 200 most recent ready documents plus every document in the scope; `note` reads "Showing the 200 most recent documents". Server-side search is out of scope. |
| The save fails (network, 4xx) | The bound value is not changed, so the control shows it again; toast "Could not change where this chat searches." A retry uses a fresh key. |
| A 101st document | "+ Add…" is disabled at 100; the host and the resolver refuse more. |
| The last chip is removed | The scope becomes `"all"`; the control reads "All documents". |
| The scope changes while a reply streams | Allowed. The running reply keeps its scope; the next send uses the new one. |

## 4. Testing

TDD in each repo's existing test style.

- **loom-ui core.** The value checker: duplicates, a selection not among the options, the 500 and
  `maxSelected` limits, bad labels. `acceptChatSubmit` for `SELECT_MANY`: accepted; a value not
  published; `optionsOf` absent; a repeat; over `maxSelected`; the wrong kind; a bad key; stale; the key
  is not burned by a refusal.
- **loom-ui renderers.** Web: add by keyboard and mouse, remove a chip, Backspace, filtering, the
  `emptyLabel` state, disabled while in flight, the bound value shown again after a refusal, "+ Add…"
  disabled at the limit. Terminal: toggle and send.
- **DocMind.** `intents.test.ts`: `SELECT_MANY` resolves only held ids, to held spellings, an empty list
  to `"all"`, and over 100 to nothing. `views.test.ts`, `terminal.test.ts`: `ScopeSelect` is a
  `MultiSelectInput` with its props. `dm-chat-page.test.ts`: a new chat is created with the chosen scope;
  an existing chat PATCHes and republishes; removed documents are offered and dropped on save; a failed
  save leaves the published value; "Ask" opens with one chip.
- **End to end.** Start a chat, add two documents, ask a question, and check every citation is from
  those two.

## 5. Delivery

Draft PRs, each at most 200 lines and 10 files, rebase-merged.

1. loom-ui core: the kind, the value checker, `SELECT_MANY` and host acceptance.
2. loom-ui web renderer.
3. loom-ui terminal renderer.
4. DocMind: the intent contract, the experience and the resolver; `LOOM_UI_REF` moves to the merged loom-ui.
5. DocMind: the chat page.

## Out of scope

Choosing documents in the library table; searching documents on the server from the picker; grouping
documents (folders, tags).
