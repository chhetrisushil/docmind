# DocMind — design spec

- **Date:** 2026-10-18
- **Status:** draft, awaiting review
- **Scope:** v1 of a multi-user, RAG-based document assistant built on Loom, loom-ui and the loom CLI.

## 1. Goals

DocMind lets a signed-in user:

1. Upload documents — **txt, md, org, doc, docx, pdf, png/jpg/webp**.
2. Get an automatic **summary** and **analysis** of each document.
3. **Search and ask questions** across their documents in a chat, with every answer citing the
   passages it used.
4. Return to **past chat sessions** (sidebar list) with full **chat history**.
5. **Erase** their account, with crypto-shredding making the erasure final even in append-only stores.

### Constraints

- **AetherOS app from day one:** multi-user, tenant-isolated, quota-bounded. It runs standalone
  until AetherOS provides platform identity.
- **Auth lives in this app** (email + password), behind an `Authenticator` interface that AetherOS
  identity can replace later.
- **Local-first:** runs on a laptop with docker-compose (Postgres + pgvector, Ollama). Embeddings are
  local by default; chat, summaries and vision use Claude.
- **Reuse Loom, never duplicate.** New code is written only for capabilities Loom lacks.
- **Small PRs:** ≤200 changed lines and ≤10 files each, opened as **drafts**, merged only after the
  owner's review.

### Non-goals (v1)

Google Docs import, shared workspaces (the schema allows them; no UI), lexical/hybrid search (see §4.3),
a websocket transport, a cloud deployment target.

## 2. Approach

A **Loom-native modular monolith**:

- **Ingestion** is a durable Loom flow.
- **Chat** is a Loom `agentLoop$` agent with retrieval tools, streamed over conversation-sse.
- **Storage** is Postgres for everything (event log, pgvector, relational tables).
- **Extension points** are small interfaces wired only in `loom.config.ts`.

Rejected alternatives:

- **Plain job queue for ingestion.** It loses durability and replay where failures are most common,
  and it duplicates Loom.
- **Microservices from day one.** Premature; each PR's line budget would go into wiring instead of
  features. The monolith's seams allow splitting later (for example, a separate ingestion worker).

## 3. Repo layout

The repo is a pnpm workspace using Turborepo, Biome and Vitest. It gets Loom via `link:../loom`
until `@loom/*` is published to a registry.

```
apps/
  server/      loom.config.ts (defineConfig = composition root), HTTP API, SSE
    app/flows/ingest-document/        durable ingestion flow
    app/agents/doc-assistant.ts       agentLoop$ + retrieval tools
    app/projections/chat-sessions.ts  past-sessions read model
  web/         Vite + loom-ui Lit renderer + app-local dm-* components
packages/
  contracts/   zod schemas + types for the HTTP API (server ⇄ web)
  auth/        Authenticator interface + password/session implementation
  keystore-pg/ PostgresKeyStore (implements @loom/plugin-crypto KeyStore)
  parsers/     DocumentParser registry, one file per format
  embeddings/  EmbeddingProvider implementations (Ollama default)
  llm-anthropic/ loom `llm` provider on @anthropic-ai/sdk (thinking, refusals)
  vector-pg/   pgvector ChunkVectorStore (port, in-memory twin, shared conformance suite)
  blob-store/  encrypted filesystem ContentStore
infra/         docker-compose, SQL migrations
```

Dependency rules:

- Packages never import from apps.
- Only `loom.config.ts` chooses which implementation backs each interface.

### 3.1 Extension interfaces

| Interface | Owner | Shape | v1 implementation |
|---|---|---|---|
| `Authenticator` | packages/auth | `authenticate(req) → {tenantId, userId} \| null` | email+password, HTTP-only session cookie |
| `DocumentParser` | packages/parsers | `accepts(mime, ext)`, `parse(bytes) → ParsedDocument` | one per format (§5.3) |
| `EmbeddingProvider` | `@loom/memory` | `modelId`, `dimensions`, `embed(texts)` | Ollama `nomic-embed-text` |
| `ChunkVectorStore` | packages/vector-pg | `upsert`, `missing`, `search` over the `chunks` rows (Loom's `VectorIndex` cannot add a vector for an id that has no row, and has no document scope) | pgvector |
| `ContentStore` | `@loom/plugin-content` | put/get by content address | encrypted filesystem |
| `KeyStore` | `@loom/plugin-crypto` | `getOrCreate / get / destroy` | Postgres, DEKs wrapped by a KEK |
| `LlmProvider` | `@loom/llm` (`llm` seam) | `complete` / `stream` | `packages/llm-anthropic` (§6.5); non-streaming from M3 (summaries, vision), M4 completes it |
| `ChatSessionStore` | apps/server | `list`, `rename`, `delete` | Loom projection → Postgres |

Each interface has **one shared conformance test suite** that every implementation must pass.

### 3.2 Reused from Loom

| Need | Loom package |
|---|---|
| Composition root, compliance/erasure | `@loom/app` `defineConfig`, `app.eraseSubject` |
| Durable flows, steps, logged non-determinism | `@loom/core` |
| ReAct agent loop, delta chunking | `@loom/agent` |
| LLM effects, provider interface, untrusted-input guard | `@loom/llm` (its Anthropic provider is replaced by `packages/llm-anthropic`, §6.5) |
| Idempotent sync, grounding, `checkCitations` (chunking is app-local: `@loom/knowledge` has no overlap, offsets or token budget) | `@loom/knowledge` |
| Embedding/vector-index interfaces, `recallRelevant` | `@loom/memory` |
| Multi-turn conversations, history reader, barge-in, token-window rotation | `@loom/conversation` |
| Authenticated, resumable SSE | `@loom/plugin-conversation-sse` |
| Event store | `@loom/plugin-postgres` |
| Blob seam, GC of unpinned content | `@loom/plugin-content` |
| Encrypting event and snapshot stores, `shredSubject` | `@loom/plugin-crypto` |
| Sandboxed execution of parsers | none: `@docmind/parsers` `ParseRunner` (child process, §5.2) |
| Per-tenant fair scheduling | `@loom/fair-scheduler` |
| Test harness, evals | `@loom/testing`, `loom eval` |
| Chat transcript state, Lit widgets | loom-ui `ChatFeed`, `chatSource`, `lu-chat`, `lu-inputs`, `lu-media`, `lu-data-table`, `lu-note` |

## 4. Data model, tenancy and erasure

### 4.1 Where data lives

| Data | Store |
|---|---|
| Chat messages and citations | Loom event log (`@loom/conversation`). Never copied elsewhere. |
| Ingestion progress | Loom event log (ingest flow). A document's status is the `ingest-status` folded read model's state (a document with no row is `uploaded`); there is no `documents.status` column. |
| Original files | `ContentStore`, path `<tenant>/<user>/<sha256>`, encrypted |
| Everything else | Postgres tables (§4.2) |

### 4.2 Tables

Every table carries `tenant_id`, except the two folded-state tables of the ingest status model (`read_model_state`, `read_model_folds`, Loom's layout): their row-level security maps `scope` (a user id) to the tenant through `users`.

- **`tenants`** `(id, name, created_at)`. Sign-up creates a personal tenant.
- **`users`** `(id, tenant_id, email UNIQUE, password_hash, created_at)`. Passwords are hashed with
  argon2id.
- **`auth_sessions`** `(token_hash, tenant_id, user_id, expires_at)`. Only a hash of the cookie token is stored.
- **`documents`** `(id, tenant_id, owner_id, title_enc, filename_enc, mime, size_bytes,
  content_address, fingerprint, stats_enc, summary_enc, ingest_generation, created_at, updated_at)`
  - Status (`uploaded | parsing | embedding | ready | failed`) is the `ingest-status` model's, not a column; the failure message is derived from its code at read time.
  - `UNIQUE(tenant_id, owner_id, fingerprint)`: re-uploading identical bytes returns the existing
    document.
  - `ingest_generation` (integer, from 2): a retry increments it and starts a new flow execution; every step is bound to the generation it was started with.
- **`chunks`** `(id, tenant_id, document_id → ON DELETE CASCADE, ordinal, section_ordinal, text_enc, locator jsonb,
  token_count, embedding vector(N), embedding_model)`
  - `locator` holds numbers and a kind only; the heading path is content and is sealed inside `text_enc` as `{text, headingPath}`. `section_ordinal` is the chunker's section index (Decision D3).
  - Indexes: HNSW (cosine) on `embedding`; B-tree on `(tenant_id, document_id)`.
- **`entities`** `(id, tenant_id, owner_id, kind, name_enc, name_key, created_at)`. `kind` is `person | organization | product | project | place | other`. `name_enc` is sealed; `name_key` is an HMAC of the normalised name under a key derived from the owner's DEK, `UNIQUE(tenant_id, owner_id, name_key)`. Entities are per owner, never shared across users, and cascade with the user.
- **`chunk_entities`** `(tenant_id, chunk_id → chunks ON DELETE CASCADE, entity_id → entities ON DELETE CASCADE)`, primary key on all three.
- **`chunk_links`** `(tenant_id, src_chunk_id, dst_chunk_id, kind, weight, created_at)`, stored in both directions, primary key `(tenant_id, src_chunk_id, dst_chunk_id, kind)`; both chunk FKs cascade. `kind` is `structure | reference | entity | similar`; `weight` is in (0, 1]. Each chunk keeps its top 24 links by weight.
- **`chat_sessions`** `(id = Loom conversationId, tenant_id, user_id, title_enc, scope jsonb,
  created_at, last_message_at, message_count, deleted_at)`
  - Maintained by the `chat-sessions` projection.
  - `scope` is `"all"` or `{documentIds: [...]}`.
- **`data_keys`** `(subject_id, wrapped_dek, kek_id, created_at)`. Owned by `PostgresKeyStore`.

The `_enc` suffix marks a column encrypted at the app level with the owning user's data key (§4.4).

`N`, the embedding dimension, is fixed per deployment by migration. Changing the embedding model runs a
resumable re-embed flow, driven by `chunks.embedding_model`.

### 4.3 Tenancy enforcement (defense in depth)

1. **Identity.** The `Authenticator` produces `{tenantId, userId}` on every request. Nothing
   downstream accepts a tenant ID from the client.
2. **Row-level security.** Postgres RLS on every table checks
   `tenant_id = app_tenant_id()` (a wrapper over `current_setting('app.tenant_id')`), set per
   transaction by `withTenant(pool, tenantId, fn)`, which opens the transaction itself. The app connects
   as `docmind_app`: owns no tables, no `BYPASSRLS`, so RLS always applies to it. Lookups that happen
   before a tenant is known (login by email, session by token hash) go through narrow
   `SECURITY DEFINER` functions owned by the migration role.
3. **Event log.** Loom streams are tenant-scoped (Loom tenancy). conversation-sse returns 404 across
   tenants.
4. **Blobs.** Paths are tenant- and user-prefixed, and the resolver authorizes the tenant (Loom
   media-gallery pattern).

**Quotas** (per tenant, configurable):

- 50 MB per file, a total storage cap and a document-count cap, all enforced at upload.
- LLM token budgets, enforced by middleware.

### 4.4 Crypto-shredding (v1 requirement)

- **Subject.** A user is the unit of erasure. Each user has their own data key (DEK). Erasing a
  tenant erases all of its users.
- **Key store.** `PostgresKeyStore` stores each DEK wrapped by a master key-encryption key (KEK). In
  v1 the KEK comes from an env var or file, identified by `kek_id`; a cloud KMS can replace it later.
  `destroy(subject)` deletes the row, which is irreversible.
- **What is encrypted under the user's DEK:**

| Store | Mechanism | After erasure |
|---|---|---|
| Loom event log | `EncryptingEventStore` | Reads yield `{ $shredded }` |
| Loom snapshots | `EncryptingSnapshotStore` with `sealState: true`, same KeyStore | Unreadable |
| Blobs | Envelope-encrypted before writing to `ContentStore` | Ciphertext only |
| `*_enc` columns | App-level AEAD with the user's DEK | Rows also hard-deleted |
| `chunks.embedding` | **Plaintext** (pgvector must compare raw vectors) | Hard-deleted |
| `chunk_links`, `entities.name_key`, `chunk_entities` | **Plaintext** metadata (link existence and weight; an HMAC; ids) | Hard-deleted with their rows |

- **Erasure flow.** `DELETE /api/me` runs these steps in order:
  1. `app.eraseSubject(userId)`. This is liveness-gated: shredding is deferred while any of the
     user's executions is still live.
  2. Hard-delete the user's rows.
  3. Delete the user's blobs.
  4. `KeyStore.destroy(userId)`.

  Each step is idempotent, so a failed erasure can be re-run.
- **Known trade-offs:**
  1. Embeddings in Postgres backups survive until those backups expire. Backups must be kept for a
     limited time (default 30 days), and this is documented in the operations runbook.
  2. Chunk text is encrypted, so there is no Postgres full-text index. v1 search is vector-only.
  3. Blob deduplication applies only within a single user.
  4. `chunk_links` (which chunks link, and how strongly), `entities.name_key` and `chunk_entities` are
     plaintext metadata, like embeddings: they let retrieval walk links without opening every chunk. Entity
     names themselves (`name_enc`) are sealed. The parsed text of a failed document stays sealed in
     `parsed_documents` until a retry or a delete.
  5. Copies retained by the LLM provider are outside the app's control. Requests carry only the
     content they need.

## 5. Ingestion

### 5.1 Upload — `POST /api/documents` (streamed multipart)

1. Enforce quota and size limits while the file streams in.
2. Sniff the type from **magic bytes**; the extension is only a hint.
3. Compute the sha256 fingerprint. A duplicate returns the existing document.
4. Encrypt and write the blob, insert the `documents` row (`uploaded`), and start `ingest-document`
   with idempotency key `documentId`.

### 5.2 `ingest-document` flow

Each step is a durable `step$`. A crash resumes at the step that was running. A user retry restarts
from the step that failed (it cancels only generations g-1 and g; older ones are terminal), and each step
skips work an earlier generation already finished. A fresh parse clears the document's chunks and summary in
the same transaction, so chunks always derive from the current parsed row. A superseded generation stops as
`document_gone`.

| Step | Behavior |
|---|---|
| **parse** | Select a parser by sniffed type and produce `ParsedDocument {text, sections[{headingPath, text, locator}], media[]}`. Runs in a child process under Node's permission model (no filesystem beyond the parser code, no child processes, empty environment, V8 heap cap, wall clock, 2 concurrent) with decompression caps (docx zip bombs: the zip directory must end exactly at the end-of-central-directory record, and every deflated entry is inflated under a hard cap first). Library parsers run only inside this sandbox. The permission model does not restrict network, and the heap cap does not bound external (Buffer) memory: the deployment must cap host memory (container/cgroup). |
| **chunk** | App-local section-bounded chunker (`chunker.ts`). Chunks respect section boundaries: ~600 tokens with ~15% overlap. Each chunk carries its `locator`. |
| **embed** | Batches of 64 → `EmbeddingProvider` → `ChunkVectorStore.upsert` (onto the existing chunk rows), idempotent by `chunkId`. The event log records `{count, model}`, never the vectors. |
| **analyze** | Deterministic and local: word and page counts, reading time (230 words/min), language (stop-word vote over 8 languages, else null), outline (depth ≤ 2, ≤ 50 entries), notable dates and numbers (≤ 20 each). Stored sealed in `documents.stats_enc`. Word segmentation (`Intl.Segmenter`) is synchronous. |
| **summarize** | Map-reduce. Consecutive sections are packed into groups of ≤ 24,000 characters, one request each (4 at a time), then one reduce request returns structured JSON: `tldr, keyPoints[], entities[], topics[], suggestedQuestions[]`. At most `DOCMIND_SUMMARY_MAX_CHARS` (default 400,000) of text is summarized. Entities are stored per owner. Document text is passed as **untrusted** input through `@loom/llm` `guardRequest` and `fenceUntrustedMedia`. Without `ANTHROPIC_API_KEY`, summaries are skipped. |
| **link** | Writes `chunk_links`: `structure` (next chunk within a section 0.9; other chunks of a section of at most 8 chunks 0.6), `similar` (5 nearest chunks of the owner's other documents, score ≥ 0.80; exact vector scans until M4), `entity` (shared entity, weight 1/(1+ln n)) and `reference` (another document's title, ≥ 8 characters, as a whole phrase: 0.7). Owner-scoped, top 24 links per chunk. The LLM fallback for ambiguous references is M4. |
| **finalize** | Set `status=ready`. |

**Progress.** Every step emits a progress event, streamed to the browser over
`GET /api/documents/events` (SSE).

**Failures:**

- **Transient** failures (LLM or embedder 429/5xx, timeouts, Ollama down) retry with exponential
  backoff.
- **Permanent** failures (corrupt file, password-protected PDF, unsupported content) set
  `status=failed` with a human-readable error (a document that needs Claude vision without a key fails as `vision_unavailable`). `POST /api/documents/:id/retry` re-runs the flow.
- Deleting a document cancels its flow. A delete cancels every generation first.
- Entity writes take a per-owner shared advisory lock, and a delete's orphan-entity purge the exclusive one; link writes take a per-owner exclusive advisory lock. Both link foreign keys are transient failures (never `document_gone`).

**Scaling.** `@loom/fair-scheduler` caps ingestion concurrency per tenant. In v1 the server and its flow
engine run as ONE process per database. Recovery of interrupted ingests assumes it: the boot pass has no
grace period, and an execution whose flow definition changed is given up (failed) by whichever node finds
it. Running several nodes or a separate worker is therefore not a configuration change: it first needs
fencing between them (version-aware recovery, so only the newest code gives up on a mismatch, and a
lease-only periodic scan).

### 5.3 Parsers

| Format | Library | Locator |
|---|---|---|
| txt | built-in (BOM / UTF-16 detection) | character range |
| md | `marked` (lexer; remark measured ~600 bytes of heap per source byte) | heading path |
| org | `orga` | heading path |
| docx | `mammoth` → HTML → section tree (zip budget checked first) | heading path |
| doc | `word-extractor` | paragraph range |
| pdf | `unpdf` (pdf.js), page by page; pages without text go to Claude, at most 20 per document; PDFs ≤ 100 pages / 22 MiB raw for vision (the Messages API caps a request at 32 MB and base64 adds a third) | page number |
| image | Claude vision: transcribe text and describe the image; ≤ 5 MiB of base64 (≈ 3.75 MiB raw), ≤ 8000 px a side; an answer truncated by `max_tokens` is `too_large` | image region |

Scanned PDF pages with no text layer are routed through the image path. Known limit: CJK PDFs that need predefined CMaps extract as empty text and so go to vision.

## 6. Agent, retrieval and chat sessions

### 6.1 HTTP API

| Endpoint | Behavior |
|---|---|
| `POST /api/chats {scope?}` | Create a Loom conversation. The projection creates the session row. |
| `GET /api/chats?cursor&q` | List sessions, newest first, 50 per page. `q` filters by title after decryption. |
| `GET /api/chats/:id/messages?cursor` | Paged history via `ConversationReader.read()`, including stored citations. |
| `POST /api/chats/:id/messages` | Send a turn. |
| `GET /api/chats/:id/stream` | conversation-sse: reply deltas, tool activity, citations. Resumable via `Last-Event-ID`. |
| `POST /api/chats/:id/stop` | Stop generating (barge-in). |
| `PATCH /api/chats/:id` | Rename or change scope. |
| `DELETE /api/chats/:id` | Soft-delete (`deleted_at`). |

**Chat lifecycle:**

- Opening an old session loads its history and continues the same conversation.
- Long sessions use Loom's token-window rotation.
- A short LLM call titles the session after its first reply, recorded as an event the projection
  folds. The user can rename it.

### 6.2 `doc-assistant` agent

- **Loop.** Loom `agentLoop$`. The model defaults to `claude-opus-5-5`; model and effort are
  configurable per route.
- **Tools.** Read-only, zod-validated. Tenant, user and chat scope are injected from the execution
  context, **never taken from model arguments**.

| Tool | Behavior |
|---|---|
| `search_docs(query, k≤12)` | Embed the query, run pgvector top-k within the scope, re-rank with MMR. Returns `{passageId, docTitle, locator, text}` with the text marked untrusted. |
| `read_section(documentId, locator)` | Return neighbouring chunks or the whole section. |
| `get_summary(documentId)` | Return the precomputed summary and analysis. |
| `list_documents(filter?)` | Return titles, types and status. |

### 6.3 Grounding and citations

- **Citation requirement.** The system prompt requires claims to cite `[[passageId]]` and to answer
  "not found in your documents" when retrieval is weak. Falling back to general knowledge is a config
  flag, off by default.
- **Validation.** Each answer passes through `@loom/knowledge` `checkCitations`. Citations to passages
  that were not retrieved are stripped.
- **Rendering.** Valid citations become numbered markers with source cards (document, page or heading,
  snippet) and are stored in the message metadata.

### 6.4 Safety, determinism and cost

- **Untrusted input.** Document text is untrusted, the tools have no side effects, and Loom's
  capability ring grants the agent only these tools. A prompt injection in a document can skew an
  answer but cannot leak data or act.
- **Determinism.** LLM calls go through `@loom/llm` effects, and retrieval runs inside `ctx.decide` /
  `recallRelevant`, so `loom debug --at` replays a conversation exactly.
- **Cost.** The system prompt and tool definitions come first, followed by a prompt-cache breakpoint;
  per-turn content comes after it. Usage is charged against the tenant's token budget.
- **Errors:**
  - An LLM error or timeout puts an error event on the stream, and the UI offers "Regenerate".
  - `stop_reason: refusal` is shown as an explicit message.
  - An embedder outage returns "search unavailable", never an answer without sources.

### 6.5 Thinking

The chat shows the model's thinking.

- **What is shown.** Claude's *summarized* thinking: requests use
  `thinking: {type: "adaptive", display: "summarized"}`. The raw chain of thought is never exposed by
  the API on any model.
- **Provider.** Loom's `AnthropicProvider` sends no `thinking` setting, drops thinking deltas, does not
  preserve thinking blocks across turns, and maps `stop_reason: "refusal"` to `end_turn`. DocMind adds
  `packages/llm-anthropic`, which implements Loom's `llm` interface on the official
  `@anthropic-ai/sdk`. It:
  - streams thinking-summary deltas as their own chunk kind, separate from answer text;
  - keeps every thinking block (with its signature) in the assistant turn and passes it back unchanged
    on later requests, as Claude Opus 5.5 requires (preserved thinking). History is append-only; turns
    are never edited;
  - reports `refusal` with its `stop_details`;
  - sets `output_config.effort` from route config (Opus 5.5 defaults to `medium`).
  It is a candidate for upstreaming into `@loom/llm` later.
- **Stream.** conversation-sse carries three ordered event kinds per turn: `thinking` deltas,
  `tool` activity (for example "Searched documents: 'Q3 revenue' → 8 passages"), and `answer` deltas.
- **Storage.** Thinking summaries and tool-activity steps are stored in the assistant message metadata,
  encrypted under the user's key like all event-log content, so past chats show them.
- **UI.** `dm-thinking` is the mocks' tool-step list above each answer, always visible. Its first row,
  "Thinking", expands to the streamed summary, opens by default while thinking streams, and collapses
  automatically when the answer starts. It stays expandable in history. Tool-step rows follow in order
  (see `docs/design/ui-mocks.md` §5).

## 7. Web UI (`apps/web`)

**Stack.** Vite, Lit and the loom-ui Lit renderer. `@loom/*` and `@loom-ui/*` are aliased to their
TypeScript sources (Loom ships CJS only; this follows the AetherOS console precedent), and only
browser-safe entry points are imported.

```
apps/web/src/
  main.ts  router.ts  api/  state/  components/  styles/tokens.css
```

| Need | Source |
|---|---|
| Transcript state, resumable stream fold | loom-ui `ChatFeed`, `chatSource` |
| Message list | `lu-chat`, wrapped by `dm-chat-view` |
| Composer | `lu-inputs` / `chatForm`, plus an attach button |
| Image preview | `lu-media` |
| Document table | `lu-data-table`, wrapped by `dm-doc-table` |
| Empty states | `lu-note` |
| App shell, session sidebar | `dm-app-shell`, `dm-session-list` |
| Upload | `dm-upload-zone` |
| Document detail (Summary / Analysis / Content tabs) | `dm-doc-detail` |
| Citations and sources panel | `dm-citation`, `dm-source-panel` |
| Thinking and tool-activity block (§6.5) | `dm-thinking` |
| Scope picker, auth forms | `dm-scope-picker`, `dm-auth-form` |

**State.** Small reactive stores (Lit `ReactiveController`s plus `@lit/context`), one per concern:
auth, sessions, chat, documents. Stores never touch the DOM.

**Security and accessibility:**

- Every `POST`, `PUT`, `PATCH` and `DELETE` is refused with 403 `cross_origin_request` unless `Sec-Fetch-Site` is
  `same-origin` or `none`, or, when that header is absent, `Origin` equals the server's own origin (or is
  absent). This guard sits in the HTTP router, in front of every route, as SameSite=Lax does not stop
  same-site, cross-origin pages. Behind a reverse proxy, forward `Host` unchanged (nginx:
  `proxy_set_header Host $host`), or browser writes without Fetch Metadata are refused with 403.
- Assistant answers and extracted document text are untrusted. Markdown is rendered, then sanitized
  with DOMPurify.
- The streaming answer region is `aria-live="polite"`.
- Every view is keyboard-navigable with visible focus.
- Colors meet WCAG AA in light and dark themes.

**Design.** UI mocks come from Claude Design using the brief in Appendix A
(https://claude.ai/artifact/CRd6Vj9zdoiBvATp1nszam). `docs/design/ui-mocks.md` is the implementation
reference: screens, tokens ("Nocturne" design system, Inter, Phosphor icons, dark base theme) and
components. Its tokens feed `styles/tokens.css`. The mocks don't draw account settings or confirmation
dialogs; those follow the component sheet's existing styles.

**Risk.** It is unverified whether `lu-chat` can render custom inline citation markers. PR 35 is a
throwaway spike that settles this before UI work. If it can't, `dm-chat-view` renders assistant
bodies itself and still uses `ChatFeed` for state.

## 8. Testing and quality gates

| Layer | Tool | Covers |
|---|---|---|
| Unit | Vitest | Parsers (fixtures), chunking, key store, citation mapping, contracts, stores |
| Conformance | Vitest, one suite per interface | Every implementation of the §3.1 interfaces |
| Flow / agent | `@loom/testing` with scripted LLM and embedder fakes | Crash-resume at each step, retries, failure states, tool sequences, citations |
| Integration | Vitest + Postgres/pgvector (runs when `DOCMIND_TEST_PG_URL` is set) | RLS isolation (including raw SQL as the app role), vector search, projections, erasure leaves nothing decryptable |
| Component | Vitest + happy-dom | `dm-*` component states from the mocks |
| E2E | Playwright | Sign up → upload → ready → ask → cited answer → reload → history intact |
| Retrieval eval | `loom eval` (manual or nightly, not a merge gate) | Retrieval hit rate and citation validity on a fixture corpus |

**Test hygiene** follows Loom's AGENTS.md:

- No sleeps; wait on conditions.
- Test servers bind to `127.0.0.1`.
- No timing assertions in `*.test.ts`.
- Test files are typechecked.

**PR gate:**
`pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`, plus integration
tests when Postgres is available.

**CI:**

- Triggers: `pull_request: [opened, synchronize, reopened, ready_for_review]` and pushes to `main`.
- **Every PR job is gated on `github.event.pull_request.draft == false`.** Drafts use no Actions
  minutes.

**PR rules:**

- ≤200 changed lines and ≤10 files. Lockfiles, the generated `loom.gen.ts` and binary fixtures don't
  count toward the limit but are listed in the PR description.
- Each PR leaves `main` green and has no half-built reachable paths.
- Tests go in the same PR as the code they cover.
- Branch names: `feat/<area>-<thing>`. Commits follow Conventional Commits.
- Every PR is opened as a **draft**, gets an independent code review before reaching the owner, and
  is merged only with the owner's approval.

## 9. PR roadmap

Each milestone ends with something runnable.

**M0 — Foundations**

1. Repo scaffold: workspace, Turborepo, Biome, tsconfig, `create-loom-app` server, `/healthz` and its
   test.
2. CI workflow (skips drafts), docker-compose (Postgres + pgvector, Ollama), `.env.example`.
3. `packages/contracts`: zod schemas for auth, documents and chats.
4. Migration runner, `tenants` / `users` / `auth_sessions`, RLS, and `withTenant(tx)` with an
   isolation test.

**M1 — Identity and keys**

5. `Authenticator` interface, conformance suite, request middleware.
6. Password auth (argon2id, session cookie) with sign-up, login and logout.
7. `packages/keystore-pg`: `PostgresKeyStore` passing the Loom KeyStore contract.
8. Postgres event store wrapped by `EncryptingEventStore` and `EncryptingSnapshotStore` in
   `loom.config.ts`.

**M2 — Document storage** (runnable: upload and list via the API)

9. `packages/blob-store`: encrypted filesystem `ContentStore`.
10. `documents` table, RLS, upload endpoint (magic-byte sniffing, quotas, dedup).
11. List, get and delete document endpoints.

**M3 — Ingestion** (runnable: documents reach `ready` with summaries)

12. `DocumentParser` interface, registry, conformance suite, txt parser.
13. Sandboxed parse runner.
14. `ingest-document` flow skeleton, status projection, progress SSE.
15. md parser. *(done, M3 part 2)*
16. org parser. *(done, M3 part 2)*
17. docx parser. *(done, M3 part 2)*
18. doc parser. *(done, M3 part 2)*
19. pdf parser. *(done, M3 part 2)*
20. image parser (vision). *(done, M3 part 2)*
21. Chunk step and `chunks` table.
22. Ollama `EmbeddingProvider` and conformance suite.
23. `packages/vector-pg` and the embed step.
24. Analyze step. *(done, M3 part 2)*
25. Summarize step. *(done, M3 part 2)*
26. Fair scheduling, retry policy, failed state, retry endpoint. *(done, M3 part 2)*

**M4 — Chat and history** (runnable: cited chat over the API)

27. Chat create, `chat-sessions` projection, list endpoint.
28. History endpoint, send route, conversation-sse stream.
29. `search_docs` (with MMR) and `list_documents` tools.
30. `read_section` and `get_summary` tools.
31. `packages/llm-anthropic`: Loom `llm` interface on `@anthropic-ai/sdk` with summarized thinking, preserved thinking blocks and refusal handling. *(Split: the non-streaming half is done in M3 part 2; streaming, thinking and refusals stay in M4.)*
32. `doc-assistant` agent: system prompt, prompt caching, citation checking and metadata.
33. Auto titles, rename, delete, scope change, stop.

**M5 — Erasure**

34. `DELETE /api/me` with an end-to-end non-recoverability integration test.

**M6 — Web UI** (runnable: the full app in a browser)

35. Spike (throwaway): citation markers in `lu-chat`.
36. Web scaffold: aliases, router, tokens, API client, SSE helper.
37. Sign-in, sign-up and account settings (including "Delete my account"). Split if over the limit.
38. App shell and session sidebar.
39. Chat view, history paging, streaming, and the `dm-thinking` block.
40. Citation markers and sources panel.
41. Composer, scope picker, stop and regenerate.
42. Upload zone.
43. Document library table.
44. Document detail tabs.

**M7 — Hardening**

45. Playwright end-to-end golden path.
46. Retrieval eval set.
47. Token-budget middleware and quota reporting.
48. README, architecture doc, operations runbook (keys, backups, erasure).

**Ordering:**

- After PR 3, M6 can proceed in parallel with M3–M5 against a mocked API.
- A PR that exceeds the size limit is split rather than stretched.

## 10. Open risks

| Risk | Mitigation |
|---|---|
| `lu-chat` may lack an inline-citation hook | PR 35 spike; fallback is a custom renderer over `ChatFeed` |
| Loom is consumed via `link:../loom` (breaks in standalone CI) | CI checks out the private `chhetrisushil/loom` at a pinned `LOOM_REF` using a read-only `LOOM_TOKEN` secret (as loom-ui does). Publishing `@loom/*` is tracked as platform work. |
| conversation-sse runs its own HTTP server (no mountable handler) | From M4, the app router proxies `/api/chats/:id/stream` to it on an internal `127.0.0.1` port, keeping one origin for the session cookie |
| Loom is CJS-only in the browser | Vite source aliases (AetherOS precedent) |
| Embedding residue in backups | Bounded backup retention, documented in the runbook |
| Parsing untrusted files | Sandbox, magic-byte sniffing, size and decompression caps |
| Prompt injection via documents | Untrusted tagging, read-only tools, capability ring, citation validation |

## Appendix A — Claude Design brief

The structured prompt for generating UI mocks lives in
[`docs/design/claude-design-brief.md`](../design/claude-design-brief.md). It covers the screens
(auth, app shell with session sidebar, chat with streaming and citations, document library with upload,
document detail, account settings with account deletion), their states, the visual direction and the
component sheet.
