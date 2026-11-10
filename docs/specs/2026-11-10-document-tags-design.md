# Document tags (design)

Date: 2026-11-10. Status: accepted; as built (see the As built section).

## 1. Goal

Let a user group their documents with tags and filter the document listing by them.
- Tags are added by hand.
- Tags are also suggested by the model: during ingest, and on demand for existing documents.
- The listing filters by one or more tags. The match mode is **Any** (a document with at least one selected tag) or **All** (a document with every selected tag).

## 2. Decisions

| Id | Decision |
|---|---|
| T1 | Tags are per user, are named by the user, and have no hierarchy and no colours. |
| T2 | Tag names are sealed under the owner's key, like document titles. Uniqueness is enforced on a keyed lookup hash of the normalised name (the `entityNameBind` pattern), so the database never compares plaintext. |
| T3 | **Suggestions, approach A.** The ingest summary call also returns `suggestedTags`. The user's existing tag names are listed in its prompt, so it prefers them. Existing documents get an on-demand "Suggest tags" call that reads only the document's stored summary. |
| T4 | Suggestions are never applied automatically. The user accepts or dismisses each one. |
| T5 | The listing filter works by tag id, with `match=any` (the default) or `match=all`. It is applied in SQL before the existing cursor page cut. |
| T6 | One additive migration (the next free number; 0036 if #495 lands first). No existing rows change. |

Rejected:
- A separate suggestion call at ingest: its cost is one call per upload.
- Suggestions derived from stored topics only: they can't map synonyms onto existing tags.
- A one-off backfill for existing documents: suggestions there are on demand.

## 3. Data model

**`tags`**
- Columns: `id uuid PK`, `tenant_id`, `owner_id`, `name_enc jsonb` (sealed), `name_bind bytea`, `created_at`.
- `UNIQUE (owner_id, name_bind)`.
- Normalisation, for the lookup hash only: NFKC, trim, collapse inner whitespace to one space, then case-fold.
- The display name is kept as typed, trimmed. It is 1–40 characters, with no control characters.

**`document_tags`**
- Columns: `document_id` (FK `ON DELETE CASCADE`), `tag_id` (FK `ON DELETE CASCADE`), `tenant_id`, `owner_id`, `created_at`.
- PK `(document_id, tag_id)`, plus an index on `(owner_id, tag_id, document_id)`.
- Composite foreign keys `(tenant_id, owner_id, document_id)` and `(tenant_id, owner_id, tag_id)` guarantee that the document and the tag share the owner (as built; see the As built section).

**`document_tag_suggestions`**
- Columns: `document_id PK` (FK `ON DELETE CASCADE`), `tenant_id`, `owner_id`, `names_enc jsonb` (sealed list of up to 5 names), `updated_at`.
- Each ingest or "Suggest tags" run replaces the row. Accept or dismiss removes the name from it.

**Rules common to all three tables**
- Row-level security on each table, with the same tenant-only policy as `documents`; every query also names the owner explicitly.
- Erasing a user deletes their rows. The names are sealed under the user's key, so crypto-shredding also covers them.
- Limits: 20 tags per document, 200 tags per user, 10 tags per filter.
- Adding a name whose normalised form already exists reuses that tag.
- A tag with no documents remains until the user deletes it.
- Renaming a tag to a normalised name that belongs to another of the user's tags answers 409.

## 4. Suggestions

**Prompt and answer**
- The summary step loads the owner's tag names: it reads them, decrypts them in memory and caps the list at 200, ordered by use count, then by name.
- It adds one line to the prompt of the call that produces the final summary. This covers both the single-pass path and the reduce step.
  - The line lists the existing tags.
  - It asks for `suggestedTags`: up to 5 names, reusing an existing name wherever one fits, and at most 3 new names.
- `ReduceAnswer` gains an optional `suggestedTags` field. It is parsed leniently: a missing or malformed field becomes `[]`, and never fails the summary.

**Normalising a suggestion**
- The shared function `normaliseSuggestions(raw, existingTags)` does this:
  - Clip each name to 40 characters and drop empty or control-character names.
  - Map a name onto an existing tag when the normalised forms are equal, keeping the existing display name.
  - Dedupe.
  - Cap at 5, with at most 3 new names.
  - Drop names already linked to the document.

**Storage and use**
- The result is written to `document_tag_suggestions`.
- `DocumentSummary` (in contracts) is unchanged, because suggestions do not live in the summary.

**On demand**
- A small Loom flow, `suggest-tags`, keyed per document with a per-key lock (the `rerunTracker` pattern). It is recovery-owned (like the chat-title flow): boot recovery re-drives an interrupted run, and erasure cancels a user's runs from Loom's durable state.
- It reads the stored summary (tldr, topics, keyPoints) and the tag names.
- It makes one model call with the same answer schema and normalisation, writes the suggestions row, and emits a document event so the detail page updates.
- It never reads passages.
- If the document has no stored summary, the button is disabled with the reason given.

**Ingest flow version**
- The summary step's prompt and inputs change, but its step list does not.
- The plan verifies whether Loom's flow hash changes. If it does, ingest moves to the next version and keeps the old version registered for runs in flight. That is the visualize-document treatment, and needs a rollback note in `cloud-deploy.md`. As built, the hash does not change (see the As built section).

**Failures**
- A suggestion problem never fails ingest. The summary is stored as today, and suggestions are empty.
- An on-demand failure shows "Couldn't suggest tags" with Retry.
- A key-store outage fails the step, as elsewhere.

## 5. API

All routes are owner-scoped, need the session and CSRF as existing routes do, and validate their bodies with zod.

| Route | Effect |
|---|---|
| `GET /api/tags` | `{tags: [{id, name, documents}]}`, sorted by name (locale-aware) |
| `POST /api/tags` `{name}` | Create, or return the existing tag with the same normalised name (200 vs 201) |
| `PATCH /api/tags/:id` `{name}` | Rename; 409 `tag_exists` on collision |
| `DELETE /api/tags/:id` | Delete the tag and its links |
| `PUT /api/documents/:id/tags` `{tagIds}` | Set a document's tags (≤ 20; foreign or unknown ids answer 400) |
| `POST /api/documents/:id/tags` `{name}` | Add one tag by name, creating it if needed |
| `DELETE /api/documents/:id/tags/:tagId` | Remove one tag |
| `POST /api/documents/:id/tag-suggestions/accept` `{name}` | Create or reuse the tag, link it, remove it from suggestions |
| `POST /api/documents/:id/tag-suggestions/dismiss` `{name}` | Remove it from suggestions |
| `POST /api/documents/:id/tag-suggestions/refresh` | Start `suggest-tags`; 202 |

**Responses that change**
- `GET /api/documents` rows gain `tags: [{id, name}]`.
- The document detail gains `tags` and `suggestedTags: string[]`.

**Listing filter**
- Syntax: `GET /api/documents?tags=<id>,<id>&match=any|all`.
- `any` gives `EXISTS (SELECT 1 FROM document_tags dt WHERE dt.document_id = d.id AND dt.owner_id = $owner AND dt.tag_id = ANY($ids))`.
- `all` gives `d.id IN (SELECT dt.document_id FROM document_tags dt WHERE … AND dt.tag_id = ANY($ids) GROUP BY dt.document_id HAVING count(*) = cardinality($ids))`, a set-based form (as built).
- Ordering and the cursor are unchanged, and the filter is part of the cursor's validity: a cursor used with a different filter answers 400.
- The query carries explicit owner and tenant predicates.
- With zero tags, the listing is unfiltered and `match` is ignored.

## 6. Web

**Documents page**
- A tag bar above the list:
  - one toggle chip per tag, with its count and `aria-pressed`;
  - an **Any / All** two-option radio group, enabled when 2 or more tags are selected;
  - **Clear**.
- The selection and mode live in the URL (`?tags=…&match=all`), so back, forward and bookmarks work. Any is the default and is omitted from the URL.
- Each row shows its tags as small chips. Clicking one filters by that tag alone.
- An empty filtered list shows "No documents match these tags" with Clear.
- The result count is announced politely.
- A **Manage tags** panel offers rename (inline) and delete (with confirmation naming how many documents use the tag).

**Document detail**
- A Tags row: chips with ×, and an input with autocomplete from the user's tags. Enter adds the typed name, creating the tag if needed.
- A Suggested line: chips with ✓ (accept) and × (dismiss), plus a **Suggest tags** button showing a busy state while the flow runs.

## 7. Privacy and cost

- Tag names and suggestions are sealed per user. They never appear in logs, the event log, lineage or error messages.
- The user's tag names are sent to their configured model provider inside the summary and suggestion prompts. This is the same trust boundary as the document text already sent.
- Cost: no extra call at ingest; one small call per "Suggest tags" press, whose input is the summary, not the document.

## 8. Testing

- **Unit:**
  - normalisation and the lookup hash (case, whitespace, NFKC);
  - `normaliseSuggestions` (mapping to existing tags, caps, the 3-new limit, dropping linked tags);
  - lenient parsing of `suggestedTags`;
  - the prompt line, with tags and without tags.
- **Postgres:**
  - uniqueness by `name_bind`;
  - the same-owner guarantee;
  - row-level security across users;
  - cascade on document and tag delete, and erasure;
  - both filter modes with paging (no duplicates, no gaps, a cursor reused with a changed filter rejected);
  - an `EXPLAIN` showing the filter uses the index on a seeded library;
  - limits.
- **Routes:** every route, including the 400, 404 and 409 cases and a foreign tag id.
- **Flow:**
  - the ingest summary stores suggestions;
  - an invalid answer still stores the summary;
  - `suggest-tags` reads only the summary;
  - a double click runs once;
  - the legacy ingest version, if the hash changes.
- **End to end:**
  - upload, then suggestions appear, then accept one;
  - filter with Any and with All across three documents;
  - rename and delete a tag;
  - the event log contains no tag name.
- **Web:** the tag bar (toggle, mode, URL sync, Clear), row chips, the detail Tags row and suggestions, the manage panel, and accessibility attributes.

## 9. Out of scope

- Tag colours, nesting and sharing.
- Tags on chats.
- Filtering chat retrieval by tag ("ask only within tag X"); a natural follow-up.
- Automatic tagging without review.
- A bulk-tag action on several selected documents.

## 10. As built

- **Owner guarantee.** Migration 0036 uses composite foreign keys instead of a CHECK or trigger: `documents` gains `UNIQUE (tenant_id, owner_id, id)`, `tags` carries the same key, and `document_tags` and `document_tag_suggestions` reference them, so a link can never join a document and a tag of different owners. All three tables cascade from the document, the tag and the user.
- **Row-level security** is tenant-only, like `documents`; the owner predicate is explicit in every statement (including `readSuggestions` and the listing).
- **Filter.** `all` is set-based (`IN (… GROUP BY document_id HAVING count(*) = cardinality(ids))`), not a correlated count. A tag id in the filter that belongs to another user, or does not exist, answers 200 with an empty list, identical to an unknown id (nothing leaks). A repeated `tags` or `match` key answers 400; ids are deduplicated before the cap of 10.
- **Recovery.** `suggest-tags` is recovery-owned, and erasure cancels its runs durably by walking r1..rK in Loom. The walk stops at the first missing run number, so a start that failed after taking a number can leave a gap; recovery ownership still re-drives or ends such a run at boot (accepted). A recovered in-flight run is not treated as running by `start()`: one extra suggestion call can follow a restart, and the later result replaces the earlier (accepted).
- **Ingest version.** The summarize prompt is not part of the Loom flow hash (it covers flow id, version, steps and retry), so `ingest-document` stays at 3.0.0 and the "legacy ingest version" test is not applicable. A test pins the hash.
- **`tags` event.** The document event for a suggestions refresh borrows `status: "ready"`, `step: "finalize"` to satisfy the event shape. A refresh needs only a stored summary, so it can fire before the document is fully ingested; consumers act on the `tags` field and must not read `status` from it.
- **Names and limits.** The input clips a name at 40 code points (the server's unit), the autocomplete hides tags by the normalised name, and the web takes the limits from `@docmind/contracts`.
- **Library page.** The result count is announced by the page when nothing matches ("No documents match these tags"), and the tag bar stays silent at 0. Manage tags closes when the last tag is deleted.
- **Erasure and tag writes.** A tag write already in flight when the erasure's `rows` step deletes the user can deadlock with the cascade (a `KEY SHARE` on the document against the tag row). Postgres aborts one side (40P01); the erasure step is idempotent and retries, and the request answers 500. Accepted: it needs a request already past authentication after the sessions are deleted.
- **Rows.** Row chips use loom-ui's token-list table cell (pin fc34435).
