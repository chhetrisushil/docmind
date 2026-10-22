# Language-model providers

DocMind runs five language-model roles. Each can use Ollama, Gemini or Claude (Anthropic), or be switched
off. Embeddings are separate and always go through Ollama (see "Embeddings").

## Read this first: what leaves the machine

- A model whose name ends in `-cloud` (the default, `gemma4:31b-cloud`) runs on **Ollama's cloud**. The
  document text, prompts, questions and images of every role set to it are sent there. Only a local model
  (one you pulled with `ollama pull`) keeps everything on the machine.
- `gemini` sends the PDF pages it reads (and any role you point at it) to Google. `anthropic` sends the
  roles you point at it to Anthropic.
- Embeddings go to the Ollama at `DOCMIND_OLLAMA_URL`, which is local unless you changed it.

## Roles and defaults

Unset variables mean Ollama. An `ANTHROPIC_API_KEY` alone enables nothing: to use Claude, name it.

| Role | What it does | Provider variable | Model variable | Default provider and model |
|---|---|---|---|---|
| `chat` | Streamed, cited answers with tools and reasoning | `DOCMIND_CHAT_PROVIDER` | `DOCMIND_CHAT_MODEL` | `ollama`, `gemma4:31b-cloud` |
| `title` | The name of a chat | `DOCMIND_TITLE_PROVIDER` | `DOCMIND_TITLE_MODEL` | `ollama`, `gemma4:31b-cloud` |
| `summary` | Document summaries | `DOCMIND_SUMMARY_PROVIDER` | `DOCMIND_SUMMARY_MODEL` | `ollama`, `gemma4:31b-cloud` |
| `vision` | Text and description of images | `DOCMIND_VISION_PROVIDER` | `DOCMIND_VISION_MODEL` | `ollama`, `gemma4:31b-cloud` |
| `vision_pdf` | Scanned PDF pages (no text layer) | `DOCMIND_VISION_PDF_PROVIDER` | `DOCMIND_VISION_PDF_MODEL` | `gemini`, `gemini-3.5-flash` when `GEMINI_API_KEY` is set, else `off` |

`DOCMIND_LLM_PROVIDER` sets the default provider of every role at once. A role's own variable wins.
`vision_pdf` takes the shared value only if that provider reads PDFs (`anthropic`, `gemini`, or `off`).

When a role uses Claude the model defaults are `claude-opus-5-5` (chat), `claude-haiku-5-5` (title,
summary) and `claude-sonnet-5-5` (vision, vision_pdf). Gemini defaults to `gemini-3.5-flash`. When
`vision_pdf` and `vision` use the same provider, `vision_pdf` inherits `DOCMIND_VISION_MODEL` if
`DOCMIND_VISION_PDF_MODEL` is unset.

Model ids must match `^[a-z0-9][a-z0-9._:\-]{0,99}$`: lowercase letters, digits and `. _ : -`, at most
100 characters. A `/` or a capital letter is refused at boot (`<VARIABLE> must be a model id`).

Other variables: `DOCMIND_OLLAMA_URL` (default `http://127.0.0.1:11434`), `GEMINI_API_KEY`,
`GEMINI_BASE_URL`, `DOCMIND_GEMINI_THINKING_BUDGET` (0 to 24576, default 0), `ANTHROPIC_API_KEY`,
`ANTHROPIC_BASE_URL`, `DOCMIND_LLM_TIMEOUT_MS` (summaries, default 60000), `DOCMIND_VISION_TIMEOUT_MS`
(default 180000, at most 600000). Chat requests have a fixed 180 s timeout per attempt. Base URLs must be
http or https, with no credentials, query or fragment.

## Switching a role

Set its provider (and, if the default does not fit, its model) in `.env`, then restart. For example, to
read images with Gemini: `DOCMIND_VISION_PROVIDER=gemini` and `GEMINI_API_KEY=...`. To turn summaries off:
`DOCMIND_SUMMARY_PROVIDER=off`.

Constraints, enforced at boot:

- `chat` cannot be `gemini`: the chat streams, and Loom's Gemini provider does not.
- `vision_pdf` cannot be `ollama`: gemma refuses PDF input.

## Running everything on Claude

```sh
DOCMIND_LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=...   # in .env only
```

`vision_pdf` follows (Claude reads PDFs). Add `DOCMIND_VISION_PDF_PROVIDER=gemini` if you prefer Gemini
for scanned pages. Claude keeps its extras on the chat: effort, cache breakpoints, summarized thinking and
the refusal outcome.

## Giving DocMind the Gemini key

Copy the value of `GEMINI_API_KEY` from the genUI project's `.env` into **DocMind's own `.env`** (which is
git-ignored). DocMind never reads another repository's files. Never commit the key and never paste it in a
pull request, issue or log. DocMind reads `GEMINI_API_KEY` only: not `GOOGLE_API_KEY`, and `OPENAI_API_KEY`
is never sent to Ollama.

## Ollama and the cloud model

1. Install Ollama and start it (the compose file runs one on port 11434).
2. Sign in once so the daemon can serve cloud models: `ollama signin`.
3. Nothing needs pulling for `gemma4:31b-cloud`; the signed-in daemon serves it.
4. Ollama is not probed at boot. If it is down, calls fail at run time as transient errors; if it is signed
   out, it answers 401, a configuration error (see "When something fails").

## Upgrading from a Claude-only .env

Earlier versions used Claude for everything. Unset provider variables now mean Ollama, so an old `.env`
that sets `DOCMIND_SUMMARY_MODEL=claude-haiku-5-5` (or any `claude-` model id) without a provider would
send that id to Ollama, which rejects it for every request. DocMind therefore refuses to start with
`<VAR> names a Claude model but ... is ollama`. Either set `DOCMIND_LLM_PROVIDER=anthropic` (and keep
`ANTHROPIC_API_KEY`) to stay on Claude, or delete the `claude-` model variables to use the new defaults.

## Embeddings

Embeddings are not a role. They use `nomic-embed-text` (768 dimensions) through Ollama and must be pulled
locally: `ollama pull nomic-embed-text`. The gemma cloud model has no embeddings. Settings:
`DOCMIND_EMBED_MODEL`, `DOCMIND_EMBED_DIMENSIONS` (must match the `vector(768)` column),
`DOCMIND_EMBED_TIMEOUT_MS`.

## Boot errors and warnings

A bad setting stops the server and names the variable, never its value.

| Message | Meaning |
|---|---|
| `<VAR> must be one of anthropic, ollama, gemini, off` | A provider variable has another value. |
| `ANTHROPIC_API_KEY is not set (<VAR>=anthropic)` | A role uses Claude and there is no key. |
| `GEMINI_API_KEY is not set (<VAR>=gemini)` | A role uses Gemini and there is no key. |
| `GEMINI_API_KEY must be a plain ASCII header value` | The key has spaces, quotes or non-ASCII characters. |
| `<VAR> cannot be gemini: the chat needs streaming` | Chat cannot run on Gemini. `<VAR>` is the variable that chose it. |
| `DOCMIND_VISION_PDF_PROVIDER cannot be ollama: it takes no PDF input` | gemma cannot read PDFs. |
| `<VAR> names a Claude model but <VAR2> is ollama` (or gemini) | A model variable holds a `claude-` id while its role's provider is not anthropic. `<VAR>` is the model variable, `<VAR2>` the variable that chose the provider. |
| `<VAR> must be a model id` | The id does not match the pattern above. |
| `<VAR> must be an http or https URL without credentials, query or fragment` | A base URL is malformed. |
| `DOCMIND_GEMINI_THINKING_BUDGET must be a whole number from 0 to 24576` | Out of range. |
| `DOCMIND_CHAT_CONTEXT_TOKENS must be at least twice DOCMIND_CHAT_MAX_TOKENS` | Chat sizing. |
| `DOCMIND_CHAT_ENVELOPE_KEY must be 32 to 512 characters` (and the `_PREVIOUS` variants) | Envelope key shape. |

Warnings (fixed text, once per process, never an address or a key):

- Role off: `chat is off: DOCMIND_CHAT_PROVIDER is off`; `chat titles are off: ...`; `summaries are off: ...`;
  `image reading is off: ...`; `scanned PDF pages are not read: DOCMIND_VISION_PDF_PROVIDER is off`.
- `ANTHROPIC_API_KEY is set but no role uses the anthropic provider`.
- `<VAR> is plain http:// to a host that is not this machine: ... travel unencrypted`, for a remote
  `DOCMIND_OLLAMA_URL` (always: embeddings use it even when no role does), or a remote `GEMINI_BASE_URL` or
  `ANTHROPIC_BASE_URL` of a provider some role uses. Loopback addresses and https are silent.
- `DOCMIND_CHAT_ENVELOPE_KEY is not set: chat envelopes do not survive a restart`. With chat on and the key
  unset, DocMind boots with a random per-process key. **Chats written under it cannot be read after a
  restart.** Set the key (`openssl rand -base64 32`) for any real use. To rotate it, see the README.

## What users see

User-facing texts are provider-neutral.

- Chat off (provider `off`): creating a chat or sending a message answers 503 `chat_unavailable`,
  "Chat is not available on this server."
- A document that needs a role which is off or cannot read it (an image with `vision` off, a scanned PDF
  with `vision_pdf` off) fails as `vision_unavailable`: "Reading this kind of document is not available on
  this server."
- A failed chat reply carries one of seven fixed reasons, each with its own sentence from loom-ui (the reason
  never carries a provider message or status; anything else shows as `model-error`):
  - `model-error`: "The assistant ran into a problem."
  - `rate-limited`: "The assistant is busy right now. Try again in a moment."
  - `quota`: "The assistant's usage limit has been reached."
  - `tool-error`: "A tool the assistant used failed."
  - `denied`: "That was not permitted."
  - `turn-failed`: "The turn could not be completed."
  - `cancelled`: "The turn was cancelled."

## When something fails

- **Ollama down**: a transient error. Ingest steps retry with backoff; a chat reply fails
  with a fixed reason and the user can send again.
- **Ollama signed out (HTTP 401, for example a cloud model)** is a configuration error, not a transient one:
  documents fail without retry. Run `ollama signin`, then reprocess them (`POST /api/documents/:id/retry`).
- **Gemini 429 or 503** (the free key hits 429 within minutes of heavy use): transient, retried.
- **A rejected key (HTTP 401 or 403 from Ollama or Anthropic; Gemini answers an invalid key with HTTP 400
  and a machine-readable `API_KEY_INVALID` reason, which is recognised the same way)** is a configuration
  error, never a damaged document: the document fails (a PDF with text pages fails too, its scanned pages
  are not dropped) and nothing is retried. Fix the key, restart, and reprocess the documents that failed
  (`POST /api/documents/:id/retry`). Any other Gemini 400 is still a request the provider refuses. Nothing
  in a log or error carries the key.
- **A scanned-PDF page the provider answers with nothing** (a safety or recitation stop) is not retried: a PDF
  with text pages keeps them and drops those pages; a PDF with no text fails as `unsupported_content`.
- **A scanned PDF over 14 MiB on Gemini** is `too_large` (Anthropic: 22 MiB). The 14 MiB cap is
  deliberately conservative: Google accepts larger PDFs. A PDF that also has text pages keeps its text and
  drops the scanned pages instead of failing. Images are capped at 5 MiB of base64 and 8000 px a side.
- Errors carry at most an HTTP status number; logs carry the error class, method and path only.

## Limits and residuals

- **Provider responses are bounded** (Loom b0cb9461): providers do not follow redirects, and cap a
  response at 8 MiB, a stream at 128 MiB and a line at 1 MiB.
- **Single process.** v1 runs one server per database. Several things are held per process: the ingest
  gate, chat stop state, the random envelope key when none is set, and handle-revision keys. Do not run two
  servers on one database.
- **No usage metering**: nothing counts tokens or cost, with any provider.
- **No refusal outcome on gemma**: only Claude reports a refusal; with gemma a refused reply is just text.
- **Thinking is the model's own text.** With gemma the chat's Thinking row shows its own reasoning (kind
  `text`), not a summary; Claude shows summarized thinking. Chat effort maps to Ollama's
  `reasoning_effort` (`low`, `medium`, `high`; `max` becomes `high`).
- **The error classes** still live in `@docmind/llm-anthropic` for historical reasons; they are shared by
  every provider.
- Quality of gemma on dense scans and long summaries is only smoke-tested; flip a role (for example
  `DOCMIND_VISION_PROVIDER=gemini`) if real documents read badly.

## Probe evidence

Checked 2026-10-22 against Ollama 0.40.6 and Gemini (no prompts recorded).

| # | Finding |
|---|---|
| O1 | `gemma4:31b-cloud` answers a plain chat call in about 1.4 s with usage. |
| O2 | Streaming works, with usage in the last chunk. |
| O3 | Tools work: round trip, streamed, and two parallel calls in one reply. |
| O4 | `response_format` does not constrain the output; DocMind asks for JSON in the prompt and tolerates one code fence. |
| O5 | Reasoning arrives as `reasoning` (not `reasoning_content`) only when `reasoning_effort` is sent. |
| O6 | PNG, JPEG and WEBP are read exactly; PDF input is refused (400). |
| O7 | A 126k-token prompt with the answer at its very start was answered correctly (context 262144). |
| O8 | An unknown model is a 404. |
| O9 | Loom's `OpenAiProvider` works against Ollama for complete, stream, tools and images. |
| O10 | The citation rules in the chat prompt gave exact citations in 6 of 6 answers. A smoke result, not an evaluation. |
| G1 | `gemini-2.5-flash` is a 404 for this key; `gemini-3.5-flash` works. |
| G2 | `gemini-3.5-flash` reads a PDF sent inline. Thinking tokens eat the output budget, hence `thinkingBudget` 0. |
| G3 | Images are read; `gemini-3.8-flash` and `*-latest` returned 503 on some calls. |
| G4 | The shared key hit 429 after about 25 requests in minutes. Expect rate limits, or use a billed key. |

## Opt-in suites against real models

Never part of `pnpm test`. Prompts and answers are never printed.

```sh
# Ollama (default model gemma4:31b-cloud; DOCMIND_REAL_OLLAMA_MODEL and DOCMIND_OLLAMA_URL override).
# Observed: 6 of 6 on gemma4:31b-cloud.
DOCMIND_REAL_OLLAMA=1 pnpm --filter @docmind/server test llm/realOllama

# Gemini: export the key in the shell only, never in a file you commit.
DOCMIND_REAL_GEMINI=1 GEMINI_API_KEY=... pnpm --filter @docmind/server test llm/realGemini
```
