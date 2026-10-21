# M6: the web UI is loom-ui native (spec §7, spec §9 item 35)

Checked 2026-10-21 against loom-ui `4f535168` and Loom `c81d521a` with throwaway probes (not merged).

## 1. Where experiences are composed

| Question | Answer (what the probe or the source showed) |
|---|---|
| Can the browser compose and compile? | No. `compile` lives on `@loom-ui/core`'s main entry, which imports `node:crypto` (`src/alias.ts`); `seal` is on `/log` (Node only); `genesis`, `apply` and `defineSemanticCatalog` carry zod. `/browser` is the zod-free renderer slice: formats, `checkKindValue`, the action freshness helpers, container roles, no compile. |
| Can the server compose, seal, compile and answer handle loads? | Yes. `genesis` + a sealed experience + `compile(..., { surface: "web" })` gave no findings; `handleInventory(exp, { revisionOf })` listed handle, priority, overridable param names and a keyed revision; `serveHandles` with a registered data-provider kind (`docmind`), a Named reshaper and a request-scoped invoker answered `{state:"ready", value}`, with the principal threaded to the invoker. |
| Does the browser half work? | Yes, under happy-dom: `SplitHydrationController` + `HydrationStore` + `renderBlueprintDom` with `createChatLitRegistry()` and `referenceContainers()` drew tabs, `Table`, `Note`, `StatusCard`, `A2UIView`, `Chat`, `TextInput`, `SelectInput`; actions arrived stamped and `actionFreshness` said `fresh`. |

**Decision (D10).** DocMind's UI is loom-ui-native and surface-agnostic: experiences are composed once, in the shared, surface-neutral `@docmind/experiences` package, and run by the DocMind server, which seals and compiles them per surface (web first, terminal later). Composition is once per view and surface, content-free; the catalogue resolves every entry on the `web` and `terminal` surfaces and the action vocabulary (`intentOf`) is shared. Serve the blueprint and inventory per view; hydrate through `POST /api/ui/hydrate` into the browser's `SplitHydrationController`. The browser imports only `@loom-ui/hydration/client`, `@loom-ui/core/browser` and `@loom-ui/renderer-lit`. The session's identity is closed over per request on the server; no handle parameter names a tenant or a user.

**Decision (D11).** Gaps in loom-ui are closed generically in loom-ui first (section 3), never with DocMind concepts in loom-ui. Answers render markdown through an opt-in, generic loom-ui feature (Tasks 176c to 176k). Table row actions (176a) and Chat inline reference markers (176b) are generic loom-ui changes.

### The lu-chat probe (U1, U16 b)

Facts re-checked first: `src/alias.ts` line 1 imports `createHmac, randomBytes` from `node:crypto`; `seal` is exported from `src/log.ts`; `compile` occurs 0 times in `src/browser.ts`; `lu-table.ts` has 0 `onAction`. The probe rendered an assistant entry with text `Due in **30 days** [[<uuid>]]. <b>x</b>`, one tool and a summary reasoning block. Result: the text is one `<p class="text" data-text="">` with the marker, the markdown and the raw HTML all literal (`&lt;b&gt;x&lt;/b&gt;`); the tool is a single list line (`<name>: done`); reasoning is a closed disclosure button `Reasoning summary` (`aria-expanded="false"`); `buttons: ['Reasoning summary']`, `bold: 0`. Conclusion: there is no inline marker and no markdown today, so the generic requests below are needed. The probe file was deleted; loom-ui `git status --short` is empty.

## 2. Kinds used

| View | Kinds |
|---|---|
| library | `Kpi` x2, `StatusCard`, `SelectInput`, `Table` (row actions, loom-ui first) |
| library-empty | `Note` |
| detail | `tabs` container (`referenceContainers()`): Summary `A2UIView`, Analysis `Kpi` x3 + `Table`, Content `A2UIView`; `StatusCard` above |
| sessions | `TextInput`, `Table` (row actions) |
| chat | `Chat` (reference markers and markdown, loom-ui first), `SelectInput`, `TextInput` |
| sources | `A2UIView` |

## 3. Gaps in loom-ui, and the verdicts

| Gap | Generic? | Verdict |
|---|---|---|
| `Table` rows cannot emit an action (`lu-table.ts` has no `onAction`) | Yes: any admin table needs "open this row" | loom-ui first (Task 176a) |
| `Chat` draws `[[id]]` as literal text; no inline marker | Yes: any retrieval or footnoted transcript | loom-ui first (Task 176b) |
| Markdown in chat text | Yes: every assistant transcript; loom-ui refuses it today by design | loom-ui first, as an opt-in closed subset (Tasks 176c to 176k, open question 4) |
| `MediaInput` is one file with no drop target or progress | Generic but not needed | app-specific `dm-upload-zone` |
| `FormInput` has no `password`/`email` field | Generic follow-up | app-specific `dm-auth-form` for M6 |
| `Table` paging, selection, grouping | Generic follow-ups | not built (open questions 13, 15) |

## 4. The generic requests

The text of the loom-ui pull requests is the "PR body" of Tasks 176a to 176k of the M6 plan. They name no DocMind concept.
