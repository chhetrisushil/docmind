# Rendered document content (Markdown and Org)

Date: 2026-10-24. Status: approved design, not yet planned.

## Problem

The detail page's Content tab draws each passage as plain text through an A2UI `Text` node. For Markdown
and Org uploads the passages hold the source syntax, so the reader sees literal `#`, `**`, `|---|`,
`#+BEGIN_SRC`. Passages are also the wrong unit to read a document by: the chunker overlaps neighbours
by ~15% (`chunker.ts` `DEFAULT_OVERLAP`) and moves heading lines out of the text into `headingPath`.

## Goal

Markdown (`.md`) and Org (`.org`) documents read as one continuous, formatted document; `.txt` reads as
preformatted text. A cited passage scrolls into view and is marked. Every other format (PDF, DOCX, ...)
keeps today's passage list unchanged. Existing documents work without re-ingest or migration.

Out of scope: editing, rendering formats other than md/org/txt, images, raw HTML.

## Approach

Render the stored original, not the passages. Every upload's bytes are already kept, encrypted per
user, in the blob store; for md/org/txt a passage's `chars` locator is an offset into exactly the
`decodeText` of those bytes. Rejected: stitching passages back together (overlap and headings make it
fragile; a chunk edge can split a fence or table) and persisting parser sections at ingest (needs every
existing document re-ingested).

## 1. Server (DocMind)

`GET /api/documents/:id/source[?passage=<id>]`, and the UI read target `document.source` over the same
reader. A UI reader's failure never reaches a reshaper, so on the UI plane a non-renderable document is
the value `{ applicable: false }`, not an error; only the REST route answers 415.

- Owner only: the same tenant and erasure checks as `document.content`; another user's document is 404.
- Only documents whose parser is `md`, `org` or `txt`; anything else is `415 not_renderable`. The parser
  is not stored, so the reader asks the parser registry with the document's stored `mime`, exactly as
  ingest's parse step does (`registry.select(mime)`, no extension).
- Opens the original from the blob store (`documents.content_address`) and decodes it with ingest's
  `decodeText`, newly exported from `@docmind/parsers`.
- Response: `{ format: "md" | "org" | "txt", text, truncated, focus? }`. `text` is capped at 1 MB
  (ingest's `SCAN_CHARS`); past the cap `truncated: true`.
- `passage`: when it names a chunk of this document with a `chars` locator, `focus` is
  `{ from, to }` from that locator. Otherwise `focus` is omitted (not an error).
- `Cache-Control: no-store`; the text is never logged.

## 2. loom-ui

**A. `parseMarkdownDocument(text)` (core).** The document profile of the chat parser: the same closed
subset, block and inline parsers, link rule (`safeLinkHref`) and `MdDoc` AST, so `drawMarkdown` draws it
unchanged. Differences: text up to 1 MB and ~100k nodes (then `truncated`); unsafe characters are
stripped per line but blank runs are not folded; each top-level block carries its source range
`{ from, to }` in the input. `parseChatMarkdown` is unchanged.

**B. `parseOrgDocument(text)` (core).** Hand-written (not `orga`: not hardened for untrusted input in
the browser, and a new core dependency), same bounds and source ranges, emits the same `MdDoc`:

| Org | AST |
|---|---|
| `*`...`******` headlines | heading 1-6; TODO keyword, priority and tags dropped |
| `#+TITLE:` | heading 1; other `#+KEYWORD:` lines and `# ` comments dropped |
| `*b*` `/i/` `=v=` `~c~` | strong, em, code, code; `_u_` and `+s+` stay text |
| `[[url][label]]`, `[[url]]` | link under `safeLinkHref` (http, https, mailto); else the label as text |
| `-` `+` `1.` `1)` items | list |
| `#+BEGIN_SRC lang` / `#+BEGIN_EXAMPLE` | code (with `lang` for SRC) |
| `#+BEGIN_QUOTE` | quote |
| `\| a \| b \|` rows, `\|---+---\|` rule | table; the row above the rule is the head |
| `-----` (5+ dashes) | rule |
| `:PROPERTIES:`...`:END:` drawers, `SCHEDULED:` / `DEADLINE:` / `CLOSED:` lines | dropped |

**C. `Prose` kind.** A bound kind (DocMind feeds it from a provider). Value, declared once in core's
`kindValueContracts`: `{ format: "markdown" | "org" | "plain", text, truncated?, focus?: { from, to },
note? }`. `drawMarkdown` stops silently at 4000 drawn nodes, so `Prose` draws each top-level block with
its own call, in its own wrapper (which is also what focus scrolls to).
- Lit: draws the first ~300 top-level blocks and a "Show more" button. With `focus`, draws up to the
  block overlapping it, scrolls it into view and marks it. `plain` is preformatted text.
- Terminal: headings, lists and code laid out as text.
- No `innerHTML` / `unsafeHTML` / `style` / event attributes, held by the existing source scan.

## 3. DocMind Content tab

- Experiences: a `DocumentProse` entry (kind `Prose`) with provider `document.source`
  (args `id`, `passage`; overridable) and reshaper `detail-source` -> the `Prose` value plus
  `applicable`. A truncated source notes "Showing the first part of this document".
- The Content panel holds `DocumentProse` and the existing `DocumentContent`. `dm-doc-detail` shows
  exactly one, by `hidden` on the `[data-widget-id]` host inside `dm-view` (as `selectContentTab`
  already reaches in): `DocumentProse` when `session.valueOf("doc-source").applicable`, else the passage
  list (unchanged for PDF, DOCX, ...). Experiences have no conditional widgets.
- `?passage=` keeps opening the Content tab; `Prose` scrolls to and marks the focus, replacing the
  "Cited passage" header for md/org. Paging is inside `Prose` (the source arrives whole); the
  passage list keeps its server paging.
- Headings, code, tables and quotes reuse the chat markdown styles with document spacing.

## Testing

- loom-ui: both parsers under the adversarial bound tests of `chatMarkdown.test.ts`; source ranges on
  fixtures; each Org row of the table above; `Prose` paging, focus and the forbidden-sink scan.
- DocMind: `detail-source` reshaper cases (md, org, txt, not applicable, truncated, focus);
  `dm-doc-detail` on the fake server (md renders headings and a table, a cited passage is marked and
  scrolled to, a PDF still lists passages); PG tests for `source` incl. another user's passage ignored.
- Manual: with the test account, upload a `.md` and an `.org`, open each from a chat citation.

## Delivery

Draft PRs of at most 200 lines / 10 files each, rebase-merged:
loom-ui A -> B -> C; DocMind server endpoint + intent; DocMind `LOOM_UI_REF` bump + experience + page.
