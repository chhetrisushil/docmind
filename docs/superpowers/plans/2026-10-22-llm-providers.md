# DocMind Pluggable LLM Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After this plan, every place DocMind calls a language model is configured per role (chat, title, summary, image reading, scanned-PDF reading) to run on **Ollama's `gemma4:31b-cloud`**, **Google Gemini** or **Anthropic**. By default everything runs on Ollama's gemma, and Gemini is used only for the one job gemma cannot do (reading scanned PDF pages). Anthropic keeps working as a per-role option; nothing of it is deleted.

This is the owner's binding instruction: "make the required code changes; pick the gemini api key from genUI; use gemini only in the places it is required and if ollama gemma cloud model is enough then use that."

**Architecture:** DocMind already talks to models through Loom's `LlmProvider` interface (`@loom/llm`); only the *construction* of providers is Anthropic-specific (`AnthropicMessagesProvider` from `packages/llm-anthropic`, built in four places). This plan adds one small module, `apps/server/app/llm/`, with three parts: a **role configuration** (`loadLlmRoles`: provider and model per role, validated at boot), a **provider factory** (`createRoleProvider`: Anthropic as today, or Loom's own `OpenAiProvider` pointed at Ollama, or Loom's own `GeminiProvider`) and a **bounding wrapper** (`bounded`: the timeout, the default `maxTokens` and the typed, content-free errors DocMind's retry logic already understands). **No new HTTP client is written**: Ollama and Gemini go through Loom's providers. Three small, generic gaps in those providers are fixed in Loom first (Tasks 201a to 201c, described without any DocMind wording): the OpenAI-compatible provider ignores the `reasoning` field Ollama returns and cannot request reasoning, no provider throws a typed HTTP error, and the Gemini provider cannot cap thinking tokens (they eat `maxOutputTokens`). Embeddings are untouched (Ollama `nomic-embed-text`, 768 dimensions).

**Tech Stack:** everything through M6, plus Loom's `OpenAiProvider` and `GeminiProvider` (already in `@loom/llm`), Ollama's OpenAI-compatible endpoint (`/v1/chat/completions`), Gemini `generateContent`. **No new third-party dependency.**

**Spec:** `/Users/such/workspace/docmind/docs/specs/2026-10-18-docmind-design.md`: §3.2 (reuse; the `LlmProvider` row), §5.2 (summarize, vision), §6.1 and §6.5 (chat, reasoning; this plan changes what produces the reasoning, not its contract), §8 (gates), §10 (risks). Task 210 records the as-built provider story there.

**Also read:**
- `docs/superpowers/plans/2026-10-21-m6-web-ui.md` (house style; its last task is 200) and `docs/superpowers/plans/2026-10-20-m4-chat-and-history.md` (the chat this plan re-points).
- DocMind call sites (all read for this plan, DocMind `main` `17f1414`): `apps/server/app/chats/llm.ts`, `chats/settings.ts`, `chats/wiring.ts`, `chats/model.ts`, `chats/observer.ts`, `chats/turnItems.ts`, `flows/chat-title/{llm,step,title}.ts`, `flows/ingest-document/{limits,vision,llmJson,errors,pgDeps}.ts`, `flows/ingest-document/summarize/summarize.ts`, `flows/ingest-document/steps/{parse,summarize}.ts`, `setup.ts`, `packages/llm-anthropic/src/{provider,errors,observer}.ts`.
- Loom (`~/workspace/loom`, `c81d521a`): `packages/llm/src/{types,capabilities,createLlmEffect}.ts`, `packages/llm/src/providers/{OpenAiProvider,GeminiProvider,AnthropicProvider}.ts`.

## Findings that shape this plan (verified 2026-10-22, DocMind `main` 17f1414, Loom c81d521a, Ollama 0.40.6)

Probes live in `/private/tmp/claude-502/-Users-such-workspace/2760bbed-302e-49dd-8fc8-8f5a0a6085ce/scratchpad/llm-probes/` (`ollama.mjs`, `ollama2.mjs`, `ollama3.mjs`, `loomprov.mjs`, `cite.mjs`, `gemini.mjs` and their `.out` files). Every probe prompt is content-free ("Reply with the single word: ok", "What is 17+25?", a generated image reading `PROBE 4821 ok`). The Gemini key was loaded into the probe process from the owner's genUI `.env` and never printed or written anywhere.

### What each DocMind call site needs

| Site | Streaming | Tools | Reasoning to the UI | JSON | Vision | Other |
|---|---|---|---|---|---|---|
| **Chat** (`chats/llm.ts`, built by `createChatLlm`) | yes (`createAgentModelEffect(..., { stream: true })`, `hub.wrapProvider`) | yes: five tools, parallel, up to 8 iterations | yes: Loom captures `LlmResponse.reasoning` into DocMind's sealed store and streams `reasoningDelta` (`capabilities.reasoning` must be true) | no | no | 180 s whole-stream timeout; `maxTokens` 16 000; Anthropic-only extras (effort, cache breakpoints, `refusal: "report"`, usage observer) |
| **Title** (`flows/chat-title/llm.ts`) | no (`complete`) | no | no | no (plain text, `cleanTitle`) | no | `maxTokens` 256; 30 s; errors classified in `step.ts` (`LlmRefusalError`/`LlmRequestError` skip, `LlmUnavailableError`/`LlmOutputError` retry, `LlmAbortedError` rethrown) |
| **Summary** (`summarize/summarize.ts`) | no | no | no | yes (prompt-only JSON, `temperature: 0`, `jsonAnswer` tolerates one ```json fence; `max_tokens` stop = `LlmOutputError`) | no | `maxTokens` 2 048; `DOCMIND_LLM_TIMEOUT_MS` 60 s; 4 concurrent map calls |
| **Vision, images** (`vision.ts` `readImage`) | no | no | no | yes (prompt-only, object) | yes: png/jpeg/webp as an `image` part | `maxTokens` 16 000; 180 s; 5 MiB base64 cap |
| **Vision, PDF pages** (`vision.ts` `readPdfPages`, up to 4 textless pages per request) | no | no | no | yes (array) | yes: the **whole PDF** as an `application/pdf` `file` part, pages named in the prompt | `VISION_PDF_MAX_BYTES` 22 MiB raw (Anthropic's 32 MB request cap); 180 s |

Error classes are DocMind's own, from `@docmind/llm-anthropic` (`LlmUnavailableError` = transient and retried, `LlmRequestError` = permanent, `LlmRefusalError`, `LlmAbortedError`, `LlmOutputError`, `LlmStreamError`); each carries at most an HTTP status. Prompt caching and token usage are Anthropic-only extras: usage is not metered anywhere today (the observer's `onUsage` is a no-op), and a refusal can only come from Claude.

### What Loom's providers give DocMind

| # | Fact (source) | Consequence |
|---|---|---|
| L1 | `OpenAiProvider` (`providers/OpenAiProvider.ts`): `complete` and `stream`, tools (`tool_calls`, streamed fragments assembled), usage (`include_usage`), images as `image_url` and PDFs as `file` parts, posts to `${baseUrl}/v1/chat/completions`. On a non-default `baseUrl` it declares **no** media (`capabilities: {}`) unless `capabilities` is passed. If `apiKey` is undefined it **falls back to `process.env.OPENAI_API_KEY`**. | Ollama works through it with `baseUrl: DOCMIND_OLLAMA_URL`, explicit `capabilities`, and **`apiKey: ""` always** (so an `OPENAI_API_KEY` in the environment is never sent to Ollama). |
| L2 | `OpenAiProvider` reads reasoning from `reasoning_content` only (complete: `choice.message.reasoning_content`; stream: `delta.reasoning_content`) and sends no `reasoning_effort`. | **Gap (Task 201a).** Ollama's field is `reasoning` (probe O5) and it emits it only when `reasoning_effort` is sent. Without 201a the chat would run without its Thinking row. |
| L3 | Every shipped provider fails with a plain `Error("<Provider> API error <status>: <response body>")`. | **Gap (Task 201b).** A body can carry a prompt or a document; DocMind's rule is "an LLM error carries at most the HTTP status". DocMind cannot classify transient versus permanent without parsing that string. |
| L4 | `GeminiProvider`: `complete` only (**no `stream`**), tools, images/PDF/audio as `inlineData` (declared for `gemini-1.5+`, `gemini-2+`, `*-latest`), thought summaries via `includeThoughts`. It sends no `thinkingBudget`. | The chat cannot run on it (it streams): a boot error says so. Probe G2: thinking tokens count against `maxOutputTokens` and a small cap ends with `finishReason: MAX_TOKENS` and no text. **Gap (Task 201c).** |
| L5 | No Loom provider has a timeout, a response byte cap or retries. They accept `request.signal`. | `bounded` adds the timeout through the signal and a default `maxTokens` (the Anthropic provider took both as options). The byte cap stays a documented residual (Ollama is the owner's machine, Gemini is `https://generativelanguage.googleapis.com`). |
| L6 | The Anthropic provider is DocMind's own (`packages/llm-anthropic`), not Loom's `AnthropicProvider`, because Loom's sends no thinking, no effort, puts the body in errors and maps refusals to `end_turn` (spec §6.5). | It stays exactly as is, behind the factory, for any role set to `anthropic`. |
| L7 | genUI (`~/workspace/genUI`) wraps Loom's Gemini provider in its own `GeminiJsonProvider` (retries, JSON mode, `thinkingBudget`, timeout) and defaults to `gemini-2.5-flash`. | That model id is **dead for this key** (probe G1). genUI's `GEMINI_API_KEY` variable name is the one reused. DocMind does not copy genUI's wrapper: it needs none of it except `thinkingBudget` (201c). |

### Probes: Ollama `gemma4:31b-cloud` (exact evidence)

`/api/show`: `capabilities: ["completion","thinking","tools","vision"]`, `gemma4.context_length: 262144`, `thinking.default: false`. `/api/tags` lists only `llama3:latest` locally: the cloud model is served through the signed-in daemon, not pulled. Embeddings stay on `nomic-embed-text` (out of scope).

| # | Probe (endpoint) | Result |
|---|---|---|
| O1 | Plain chat (`/v1/chat/completions`, `max_tokens: 50`) | 200 in 1 445 ms; `message.content: "ok"`, `finish_reason: "stop"`, `usage.prompt_tokens: 20`, `completion_tokens: 2`. |
| O2 | Streaming with `stream_options.include_usage` | 200; 16 chunks, delta keys `role, content`, `[DONE]` present, last chunk carries `usage` (35 total). |
| O3 | Tools: non-stream, round trip, stream, parallel | `finish_reason: "tool_calls"`, `tool_calls[0].function.arguments: "{\"key\":\"a\"}"`; feeding a `role: "tool"` message back gives a final answer (`finish: stop`); streamed, the whole call arrives in one delta (`toolDeltas` length 1); with `reasoning_effort: "medium"` + `stream` + two tools asked "in parallel" it returns **2 calls**, `finish: tool_calls`, usage present. |
| O4 | JSON | `response_format: {type: "json_object"}` and `json_schema (strict)` do **not** constrain: both return the object inside a ```json fence. Prompt-only ("Answer with one JSON object and nothing else", `temperature: 0`) returned bare JSON. `jsonAnswer` already tolerates one fence and rejects anything else, so DocMind keeps its prompt-only approach and sends no `response_format`. |
| O5 | Reasoning | `/api/chat` with `think: true` returns `message.thinking` (111 chars); `think: false` none. On `/v1`, **`reasoning_effort` `low`, `medium` and `high` all return `message.reasoning`** (163 chars at medium) and stream it as `delta.reasoning`; with no `reasoning_effort` there is no reasoning at all. The field is `reasoning`, never `reasoning_content`. |
| O6 | Vision | A generated PNG, JPEG and WEBP of the text `PROBE 4821 ok`, sent as `image_url` data URLs (and as native `images[]`), came back as `{"text": "PROBE 4821 ok", "description": ...}` inside a fence (813 ms). **PDF is refused**: `/v1` with a `file` part: 400 `invalid message format`; native with the PDF in `images[]`: 400 `invalid image ... expected image mime type, got "application/pdf"`. |
| O7 | Context | A 126 038-token prompt with a needle at the very start was answered correctly (`"7391"`) in 7.9 s. DocMind's default `DOCMIND_CHAT_CONTEXT_TOKENS` is 150 000: no change needed. |
| O8 | Errors | An unknown model: HTTP 404 `{"error":{"message":"model '...' not found","type":"not_found_error"}}`. |
| O9 | Loom's real `OpenAiProvider` (built `dist`) against Ollama (`baseUrl: "http://127.0.0.1:11434"`) | `complete` OK (`usage` 20/2), `stream` OK (terminal chunk, usage 22/11), streaming tools returned **two** calls with `stopReason: "tool_use"`, a WEBP image part answered `PROBE 4821 ok`. The error was `Error: OpenAI API error 404: {...body...}` with no `status` property (L3). |
| O10 | Citation discipline, the real `[[passageId]]` rules of `DOC_ASSISTANT_PROMPT` plus a tool result with two passages | **6 of 6** answers cited both ids exactly, with and without `reasoning_effort: "medium"`. (With a one-line system prompt and no rules: 0 of 1, so the prompt matters and stays as it is.) This is a smoke result, not an evaluation: Task 209 adds the opt-in suite that re-checks it. |

### Probes: Gemini (key from genUI `GEMINI_API_KEY`; values never printed)

| # | Probe | Result |
|---|---|---|
| G1 | `gemini-2.5-flash` (genUI's default) | **404** `This model models/gemini-2.5-flash is no longer available to new users`. The model list for this key includes `gemini-3.5-flash`, `gemini-3.8-flash`, `gemini-flash-latest`, `gemini-3.1-pro-preview` and others. |
| G2 | `gemini-3.5-flash`, a one-page PDF as an `inlineData` `application/pdf` part, ask for `[{"page", "text"}]` | 200, `[{"page": 1, "text": "PROBE 4821 ok"}]` in a fence; `promptTokenCount` 546 (516 of them IMAGE tokens); `thoughtsTokenCount` 134. **Thinking eats the output budget**: with `maxOutputTokens: 60` the call ends `finishReason: MAX_TOKENS` with 1 candidate token and 55 thought tokens; with `thinkingConfig: {thinkingBudget: 0}` the same request ends `STOP` with no thought tokens. |
| G3 | `gemini-3.5-flash` and `gemini-3.8-flash`, the image | Both read the image correctly (3.8 answered in full; 3.5 hit `MAX_TOKENS` at 400 because of thinking). `gemini-3.8-flash` and `gemini-flash-latest` returned **503 high demand** on some calls: a transient error the retry policy must absorb. |
| G4 | Quota | After roughly 25 requests in a few minutes the key answered **429 `RESOURCE_EXHAUSTED`** ("exceeded your current quota"). Tools, streaming and `includeThoughts` on Gemini could therefore not be probed; none of them is needed (Gemini serves one non-streaming role). The owner should expect rate limits on this key (Question 6). |

## Decisions

- **D1. Roles.** Five roles, each independently configurable: `chat`, `title`, `summary`, `vision` (images), `visionPdf` (textless PDF pages). Each has `DOCMIND_<ROLE>_PROVIDER` (`anthropic`, `ollama`, `gemini` or `off`) and `DOCMIND_<ROLE>_MODEL`. The prefixes are `DOCMIND_CHAT`, `DOCMIND_TITLE`, `DOCMIND_SUMMARY`, `DOCMIND_VISION` and `DOCMIND_VISION_PDF`. The existing `DOCMIND_CHAT_MODEL`, `DOCMIND_TITLE_MODEL`, `DOCMIND_SUMMARY_MODEL` and `DOCMIND_VISION_MODEL` keep their names. `DOCMIND_LLM_PROVIDER` sets the default provider of every role at once.
- **D2. The choice per call site (owner rule: gemma where it is enough, Gemini only where required).**

  | Role | Default provider / model | Why (probe) |
  |---|---|---|
  | chat | `ollama` / `gemma4:31b-cloud` | streaming, parallel tools, reasoning, 262 144 context, exact citations: O2, O3, O5, O7, O10. Gemini is not an option: Loom's `GeminiProvider` has no `stream` (L4). |
  | title | `ollama` / `gemma4:31b-cloud` | one short call: O1. |
  | summary | `ollama` / `gemma4:31b-cloud` | prompt-only JSON at `temperature: 0` (O4), long context (O7). |
  | vision (images) | `ollama` / `gemma4:31b-cloud` | PNG, JPEG and WEBP read exactly: O6. |
  | visionPdf | `gemini` / `gemini-3.5-flash` when `GEMINI_API_KEY` is set, else `off` | Ollama refuses PDF input (O6); Gemini reads a whole PDF natively (G2). Rasterising pages for gemma would add a native dependency; rejected. |

  Anthropic defaults stay as today when chosen: chat `claude-opus-5-5`, title and summary `claude-haiku-5-5`, vision and visionPdf `claude-sonnet-5-5`.
- **D3. Defaults are on, not opt-in.** Unset provider variables mean Ollama (and Gemini for PDF pages when its key exists). `ANTHROPIC_API_KEY` alone no longer switches anything on: to run on Claude set `DOCMIND_LLM_PROVIDER=anthropic` (or per role). A boot warning (fixed text) says when `ANTHROPIC_API_KEY` is set but no role uses it. This is a breaking default change for anyone running on Claude today; Question 1.
- **D4. Boot validation, fixed messages that name variables only.** A role set to a provider whose credential is missing refuses to start: `ANTHROPIC_API_KEY is not set (DOCMIND_CHAT_PROVIDER=anthropic)`, `GEMINI_API_KEY is not set (DOCMIND_VISION_PDF_PROVIDER=gemini)`. Impossible combinations refuse to start too: `DOCMIND_CHAT_PROVIDER cannot be gemini: ...` (no streaming), `DOCMIND_VISION_PDF_PROVIDER cannot be ollama: ...` (no PDF input). Ollama needs no key; its URL is `DOCMIND_OLLAMA_URL` (shared with embeddings, default `http://127.0.0.1:11434`). Ollama is not probed at boot (embeddings are not either); a down Ollama is a transient error at call time.
- **D5. Where the Gemini key comes from.** The owner copies the value of `GEMINI_API_KEY` from genUI's `.env` into **DocMind's own `.env`** (git-ignored). DocMind code never reads another repository's files, and this plan, its tests and its probes never contain the value. The factory reads `GEMINI_API_KEY` only (not `GOOGLE_API_KEY`, which Loom's provider would otherwise fall back to), and passes it explicitly.
- **D6. Loom first, generic.** The reasoning alias and `reasoningEffort` (OpenAI-compatible provider), `LlmHttpError` (all providers) and `thinkingBudget` (Gemini provider) are changed in Loom as three small PRs that never mention DocMind, then `LOOM_REF` moves (Task 202). DocMind adds no provider subclass.
- **D7. Errors.** `bounded` maps a Loom provider's failure to DocMind's existing typed errors by **status only**: `LlmHttpError` 408/409/429/5xx becomes `LlmUnavailableError(status)`, any other status `LlmRequestError(status)`, a timeout or a network failure `LlmUnavailableError`, a stream that breaks `LlmStreamError`, a caller abort `LlmAbortedError`, an unsupported modality or a malformed body `LlmRequestError`. The provider's message is dropped. The error classes stay in `@docmind/llm-anthropic` (no code moves; the module name is a historical oddity, noted in Task 210).
- **D8. Chat extras are provider-specific and optional.** Effort maps to Ollama's `reasoning_effort` (`low`, `medium`, `high`; `max` becomes `high`). Cache breakpoints, `refusal: "report"` and the usage observer apply to Anthropic only; with gemma a reply never ends in a refusal outcome and nothing meters usage (nothing does today either). The `Thinking` row shows the model's own reasoning text (Loom records it as kind `text`, not `summary`); the spec's "summarized thinking" wording is Claude's and Task 210 corrects it.
- **D9. Limits depend on the provider.** The textless-PDF size cap is the provider's request limit: Anthropic 22 MiB raw (as today); Gemini 14 MiB raw (inline data rides in a 20 MB request and base64 adds a third: **verify against the current Gemini docs when implementing Task 206**); Ollama none (it is refused at boot). The image cap (5 MiB of base64, 8000 px) stays for every provider as the conservative bound.
- **D10. Tests never call a real model.** Existing suites keep running on `FakeAnthropic` with their harness env now naming `anthropic` explicitly. New fakes (`FakeOpenAiCompat`, `FakeGemini`) cover the other providers. Real-model checks are opt-in suites (Task 209), never part of `pnpm test`.

## Open questions (defaults are what the tasks implement)

1. **Breaking default.** Unset means Ollama; `ANTHROPIC_API_KEY` alone enables nothing. Default: yes (matches the owner's instruction). Alternative: keep Anthropic as the default when its key is set.
2. **Gemini model for PDF pages.** Default `gemini-3.5-flash` (probed: PDF read correctly). `gemini-3.8-flash` is newer but returned 503s; `*-latest` aliases drift.
3. **Gemini for anything else.** Default: no. Gemini is configured only for `visionPdf`. Setting it on `title`, `summary` or `vision` is allowed (it works non-streaming), setting it on `chat` is refused.
4. **gemma quality on dense scans and long map-reduce summaries.** Probes prove the plumbing and a three-word image, not a dense page. Default: ship gemma as the default and let the owner flip a role (`DOCMIND_VISION_PROVIDER=gemini`) after trying real documents; Task 209 gives them the suite to try.
5. **Reasoning label.** gemma returns its own thinking text, not a summary. Default: keep the `Thinking` row as is and fix the spec wording (Task 210).
6. **Gemini quota.** The genUI key hit 429 within minutes of light probing. Default: accept (PDF reading is rare, errors are retried with backoff); the owner may use a billed key.
7. **Response byte caps and redirects.** Loom's providers cap neither the response size nor follow-up redirects. Default: accept for loopback Ollama and Google's fixed URL; revisit if a remote Ollama is used.

## Global Constraints

Everything in the M4, M5 and M6 plans' Global Constraints still binds. Restated, with this plan's additions:

- **PR size:** at most **200 changed lines and 10 files** per PR; about 300 lines and 13 files when the excess is tests or mechanical fallout, said in the PR body. `pnpm-lock.yaml` is listed, not counted. A task over the limit splits along the seam its close-out names.
- **PR rules:** every PR is a **draft** (`gh pr create --draft`; CI skips drafts) and is **rebase-merged** (`gh pr merge --rebase`), never squashed and never a merge commit. Executors never merge. Branch names `feat/llm-<thing>` (`docs/llm-<thing>` for docs). Each PR leaves `main` green with no half-built reachable path: a provider choice is reachable only when the factory builds it.
- **Commit trailer:** every commit ends with the `Co-Authored-By:` trailer of the model that executes the task; every PR description ends with the generated-with line.
- **The local gate is the merge gate**, with `DOCMIND_TEST_PG_URL` exported in the same shell command (the value is in the owner's shell setup; **never print it**): `pnpm lint:fix && pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm lint && pnpm test`. A task whose Postgres suite is skipped has not passed its gate. This plan names the variables `DATABASE_URL`, `LOOM_DATABASE_URL`, `DOCMIND_TEST_PG_URL`, `LOOM_TEST_POSTGRES_URL` and never a connection string.
- **Loom tasks (201a to 201c)** are executed in `~/workspace/loom` under its `AGENTS.md` (feature branch, never `main`; draft PR; gate `pnpm build && pnpm test && pnpm lint`). Their code, tests and PR descriptions are **generic**: no DocMind name, no document or chat-product wording; examples are an invoice, a ticket, a refund.
- **Loom changes stay generic.** DocMind-specific needs live in `apps/server/app/llm/`, never in Loom. Loom changes only through Tasks 201a to 201c.
- **Test hygiene:** every rejection assertion pins its error (`rejects.toBeInstanceOf(X)`, `toMatchObject({ name })`, `toThrow(/exact text/)`); no sleeps and no timing assertions (wait on a condition: an abort event, a fake's request count); test servers bind `127.0.0.1`; test files are typechecked (`typecheck:tests`). **No default test calls a real model**; the opt-in suites of Task 209 are skipped unless their variable is set.
- **Never log, print, return in an error, or put in a test name or snapshot:** connection strings, passwords, the KEK or any data key, emails, session tokens, filenames, titles, document text, chunk text, summaries, ids beside content, **any API key (Anthropic or Gemini)**, entity names, prompts, model responses, chat titles, questions, answers, thinking text, receipt tokens. **An LLM error carries at most an HTTP status**: provider response bodies and messages are dropped at the `bounded` boundary. Startup errors and warnings name a variable, never its value or a URL. Test fixtures use obviously fake sentinels (`sentinel-...`, `test-key-not-real`), and no assertion message embeds one. The Gemini key from genUI appears in no file of this repository, no log, no PR text.
- **No key leaks across providers:** the Ollama provider is built with `apiKey: ""` (never `OPENAI_API_KEY`), the Gemini provider with the explicit `GEMINI_API_KEY` (never `GOOGLE_API_KEY`), and a test per provider proves what header the fake server saw.
- **Tenancy rules on the server stay intact** (RLS, `withTenant`, owner scoping). This plan adds no table, no migration and no cross-tenant path.
- **Embeddings stay on Ollama** (`nomic-embed-text`, 768 dimensions, `DOCMIND_EMBED_*`); nothing in this plan touches them.
- **Dependencies:** none added. `apps/server` already depends on `@loom/llm` and `@docmind/llm-anthropic`.
- **Toolchain pins:** `pnpm@9.14.4`, `@biomejs/biome` `1.9.4` (exact), `typescript` `^5.6.3`, Node `>=22.13.0`.

## Interface catalogue (binding names; every task uses exactly these)

```ts
// Loom: packages/llm/src/errors.ts (Task 201b), exported from "@loom/llm"
export type LlmHttpProvider = "anthropic" | "openai" | "gemini"
export class LlmHttpError extends Error {
  readonly status: number; readonly provider: LlmHttpProvider
  constructor(provider: LlmHttpProvider, status: number, body: string)   // message: `${Anthropic|OpenAI|Gemini} API error ${status}: ${body}` (unchanged)
}
// Loom: OpenAiProviderConfig.reasoningEffort?: "low" | "medium" | "high"   (Task 201a)
// Loom: GeminiProviderConfig.thinkingBudget?: number                        (Task 201c; integer >= 0)

// apps/server/app/llm/roles.ts (Task 203)
export const LLM_ROLES: readonly ["chat","title","summary","vision","visionPdf"];  export type LlmRole
export const PROVIDERS: readonly ["anthropic","ollama","gemini"];  export type ProviderName;  export type RoleProvider = ProviderName | "off"
export interface RoleSetting { provider: RoleProvider; model: string }          // model "" when off
export interface LlmRoleSettings {
  roles: Record<LlmRole, RoleSetting>
  anthropicBaseUrl?: string; ollamaUrl: string; geminiBaseUrl?: string; geminiThinkingBudget: number
}
export function loadLlmRoles(env?: NodeJS.ProcessEnv): LlmRoleSettings          // validates; throws StartupConfigError
export function pdfMaxBytes(provider: ProviderName): number
export function llmWarnings(s: LlmRoleSettings, env?: NodeJS.ProcessEnv): string[]
export function insecureUrlWarning(varName: string, url: string | undefined, what?: string): string | undefined

// apps/server/app/llm/modelId.ts (Task 203): moved from flows/ingest-document/limits.ts, re-exported there
export const envModelId: (env: NodeJS.ProcessEnv, name: string, fallback: string) => string   // MODEL_ID now allows ":" "_" ("gemma4:31b-cloud")

// apps/server/app/llm/bounded.ts (Task 204)
export interface BoundedOptions { maxTokens: number; timeoutMs: number }
export function mapLlmError(err: unknown, caller?: AbortSignal): Error
export function bounded(inner: LlmProvider, o: BoundedOptions): LlmProvider

// apps/server/app/llm/testing/ (Task 205a)
export type CompatReply =
  | { kind: "text"; text: string; reasoning?: string; usage?: { prompt: number; completion: number }; finish?: "stop" | "length" }
  | { kind: "tools"; calls: { name: string; input: unknown }[]; reasoning?: string }
  | { kind: "error"; status: number }
export interface FakeOpenAiCompat { url: string; requests: { path: string; authorization?: string; body: any }[]; reply(f: (n: number, body: any) => CompatReply): void; close(): Promise<void> }
export function startFakeOpenAiCompat(): Promise<FakeOpenAiCompat>
export interface FakeGemini { url: string; requests: { path: string; keyHeader?: string; body: any }[]; reply(f: (n: number, body: any) => { text: string } | { status: number }): void; close(): Promise<void> }
export function startFakeGemini(): Promise<FakeGemini>

// apps/server/app/llm/factory.ts (Task 205b)
export interface RoleCallOptions {
  maxTokens: number; timeoutMs: number
  chat?: { effort: ChatEffort; observer: () => CallObserver | undefined }
}
export function createRoleProvider(role: LlmRole, s: LlmRoleSettings, env: NodeJS.ProcessEnv, o: RoleCallOptions): LlmProvider | undefined   // undefined when the role is off

// flows/ingest-document/limits.ts (Task 206)
IngestWiring.llm: { summary?: LlmProvider; vision?: LlmProvider; visionPdf?: LlmProvider; roles: LlmRoleSettings; config: LlmSettings }
// flows/ingest-document/vision.ts (Task 206)
new VisionReader({ image?: LlmProvider; pdf?: LlmProvider; pdfMaxBytes?: number })   // .canReadImages, .canReadPdf, .pdfMaxBytes

// chats/settings.ts (Task 207): ChatSettings gains `provider: RoleProvider` and `titleProvider: RoleProvider`
```

## Task index

| Task | What | Est. lines | PRs |
|---|---|---|---|
| 201a | **Loom repo.** `OpenAiProvider`: read the `reasoning` field as well as `reasoning_content`; `reasoningEffort` option sends `reasoning_effort` (generic) | 150 | loom `feat/openai-compat-reasoning` |
| 201b | **Loom repo.** `LlmHttpError` (status, provider) thrown by the Anthropic, OpenAI and Gemini providers; message unchanged (generic) | 130 | loom `feat/llm-http-error` |
| 201c | **Loom repo.** `GeminiProvider` `thinkingBudget` option (generic) | 90 | loom `feat/gemini-thinking-budget` |
| 202 | Bump `LOOM_REF` past 201a to 201c; a pin test | 70 | `feat/llm-loom-pin` |
| 203 | `app/llm/roles.ts`, `modelId.ts`: roles, providers, defaults, boot validation, warnings | 300 (half tests) | `feat/llm-roles` |
| 204 | `app/llm/bounded.ts`: timeout, default `maxTokens`, status-only typed errors | 260 (half tests) | `feat/llm-bounded` |
| 205a | `app/llm/testing`: `FakeOpenAiCompat` and `FakeGemini` | 230 | `test/llm-fakes` |
| 205b | `app/llm/factory.ts`: Anthropic, Ollama and Gemini providers per role, with key and URL handling | 290 (half tests) | `feat/llm-factory` |
| 206 | Ingest wiring: summary, image and PDF roles; `VisionReader` with two providers; provider-specific PDF cap | 290 (half tests) | `feat/llm-ingest` |
| 207 | Chat and title wiring, `ChatSettings` provider fields, envelope-key rule, boot warnings | 280 (half tests) | `feat/llm-chat` |
| 208a | Chat end to end on a fake Ollama (stream, tools, reasoning, retry, history) | 260 (tests) | `test/llm-chat-ollama` |
| 208b | Ingest end to end on fake Ollama and fake Gemini (summary, image, PDF page, 429 retry) | 250 (tests) | `test/llm-ingest-providers` |
| 209 | Opt-in real-model suites: Ollama (chat, tools, reasoning, image, citations) and Gemini (PDF page) | 200 | `test/llm-real-suites` |
| 210 | Docs: `.env.example`, `docs/operations/llm-providers.md`, README.org, spec as-built | 180 | `docs/llm-providers` |

14 tasks, 14 PRs (three in the Loom repo), numbered 201 to 210 (suffixes `a` to `c` are separate PRs). Tasks 203, 204, 205b, 206 and 207 exceed 200 lines only by tests; if review wants them smaller, split at: 203 (`roles.ts` versus `llmWarnings`), 205b (Anthropic and Ollama versus Gemini), 206 (summary versus vision).

**Preconditions:** run the full gate on `main` (`17f1414`) and record the counts in the ledger. `~/workspace/loom` checked out at `c81d521a` and built.

**Order:** 201a, 201b and 201c are independent Loom PRs and can run in parallel; **all three must merge before 202**. 202 before 205b (the factory uses `reasoningEffort`, `thinkingBudget` and `LlmHttpError`). 203 and 204 need only 202's pin for `LlmHttpError` (204) and are otherwise independent of each other; 205a is independent of everything (it is a fake). 205b needs 202, 203, 204. 206 and 207 need 205b and can run in parallel. 208a needs 207 and 205a; 208b needs 206 and 205a. 209 needs 205b. 210 is last.

---

## Phase A: Loom, three generic fixes (the Loom repo; nothing of DocMind)

### Task 201a (Loom repo): `OpenAiProvider` reads `reasoning` and can ask for reasoning

**Why.** OpenAI-compatible servers return the model's thinking as `reasoning` (Ollama, probe O5) or `reasoning_content` (others), and some return it only when asked with `reasoning_effort`. The provider reads only `reasoning_content` and cannot ask.

**Files:**
- Modify: `packages/llm/src/providers/OpenAiProvider.ts` (config, `buildBody`, the two response interfaces, `complete`, `stream`)
- Test: `packages/llm/src/providers/openAiReasoningCompat.test.ts` (new)

**Interfaces:**
- Consumes: the existing `compatReasoning(text)` helper in the same file (kind `text`, provider `openai-compat`).
- Produces: `OpenAiProviderConfig.reasoningEffort?: "low" | "medium" | "high"`; a request body with `reasoning_effort` only when it is set; reasoning read from `reasoning_content`, else `reasoning`, in both `complete` and `stream`.

- [ ] **Step 1: Write the failing test.** `openAiReasoningCompat.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiProvider } from "./OpenAiProvider";

afterEach(() => vi.unstubAllGlobals());

function stubJson(json: unknown): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => ({ ok: true, json: async () => json }) as unknown as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

function stubSse(events: unknown[]): void {
  const body = `${events.map((e) => `data: ${JSON.stringify(e)}\n`).join("")}data: [DONE]\n`;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        ({
          ok: true,
          body: {
            getReader() {
              let sent = false;
              return {
                read: async () =>
                  sent
                    ? { done: true, value: undefined }
                    : ((sent = true), { done: false, value: new TextEncoder().encode(body) }),
              };
            },
          },
        }) as unknown as Response,
    ),
  );
}

const ASK = { messages: [{ role: "user" as const, content: "Is the invoice paid?" }] };

describe("OpenAiProvider reasoning on OpenAI-compatible servers", () => {
  it("reads `reasoning` from a completed response", async () => {
    stubJson({
      choices: [{ message: { content: "yes", reasoning: "checked the ledger" }, finish_reason: "stop" }],
    });
    const res = await new OpenAiProvider({ apiKey: "k" }).complete(ASK);
    expect(res.reasoning).toEqual([{ kind: "text", text: "checked the ledger", provider: "openai-compat" }]);
  });

  it("still reads `reasoning_content`, which wins when both are present", async () => {
    stubJson({
      choices: [{ message: { content: "yes", reasoning_content: "a", reasoning: "b" }, finish_reason: "stop" }],
    });
    const res = await new OpenAiProvider({ apiKey: "k" }).complete(ASK);
    expect(res.reasoning?.[0]?.text).toBe("a");
  });

  it("streams `reasoning` deltas and reports the assembled reasoning on the terminal chunk", async () => {
    stubSse([
      { choices: [{ delta: { reasoning: "check " } }] },
      { choices: [{ delta: { reasoning: "ledger" } }] },
      { choices: [{ delta: { content: "yes" }, finish_reason: "stop" }] },
    ]);
    const chunks = [];
    for await (const c of new OpenAiProvider({ apiKey: "k" }).stream(ASK)) chunks.push(c);
    expect(chunks.filter((c) => c.reasoningDelta !== undefined).map((c) => c.reasoningDelta)).toEqual(["check ", "ledger"]);
    expect(chunks.at(-1)?.reasoning).toEqual([{ kind: "text", text: "check ledger", provider: "openai-compat" }]);
  });

  it("sends reasoning_effort only when configured", async () => {
    const withEffort = stubJson({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] });
    await new OpenAiProvider({ apiKey: "k", reasoningEffort: "low" }).complete(ASK);
    expect(JSON.parse((withEffort.mock.calls[0]?.[1] as { body: string }).body).reasoning_effort).toBe("low");
    const without = stubJson({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] });
    await new OpenAiProvider({ apiKey: "k" }).complete(ASK);
    expect(JSON.parse((without.mock.calls[0]?.[1] as { body: string }).body)).not.toHaveProperty("reasoning_effort");
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @loom/llm test -- openAiReasoningCompat` (Expected: FAIL: `res.reasoning` undefined for the `reasoning` field; `reasoning_effort` missing).
- [ ] **Step 3: Implement.** In `OpenAiProvider.ts`:

```ts
// config
  /** Sent as `reasoning_effort` when set; servers that support reasoning return it only when asked. */
  reasoningEffort?: "low" | "medium" | "high";
```

```ts
/** `reasoning_content` (DeepSeek-style servers) or `reasoning` (Ollama and others); the first non-empty wins. */
function reasoningText(x: { reasoning_content?: string | null; reasoning?: string | null }): string {
  return x.reasoning_content || x.reasoning || "";
}
```

Add `reasoning?: string | null;` next to `reasoning_content` in the `message` and `delta` shapes of `OpenAiChoice`; store `this.reasoningEffort = config.reasoningEffort;` in the constructor (a `private readonly reasoningEffort: OpenAiProviderConfig["reasoningEffort"]`); in `buildBody` after `temperature`: `if (this.reasoningEffort !== undefined) body.reasoning_effort = this.reasoningEffort;`; in `complete` use `compatReasoning(reasoningText(choice.message))`; in `stream` use `const reasoningDelta = reasoningText(choice?.delta ?? {});`.

- [ ] **Step 4: Run to verify it passes** (the new file and `reasoning.test.ts`, `contentParts.test.ts`: unchanged behavior).
- [ ] **Step 5: Gate and commit.** `pnpm build && pnpm test && pnpm lint`; `git commit -m "feat(llm): OpenAI-compatible provider reads reasoning and can request it"` (trailer). Draft PR, generic wording: "Servers such as Ollama return `reasoning` and only when `reasoning_effort` is sent."

### Task 201b (Loom repo): a typed HTTP error from every provider

**Why.** Callers that must not keep a response body (it can echo a prompt) cannot tell a 429 from a 401 without parsing the message. A typed error with the status lets them classify and drop the text.

**Files:**
- Create: `packages/llm/src/errors.ts`
- Modify: `packages/llm/src/providers/{AnthropicProvider,OpenAiProvider,GeminiProvider}.ts` (the five `throw new Error(\`... API error\`)` sites), `packages/llm/src/index.ts` (export)
- Test: `packages/llm/src/providers/httpError.test.ts` (new)

**Interfaces:**
- Produces: `LlmHttpError`, `LlmHttpProvider` (see the catalogue). The message is byte-for-byte what it was (`Anthropic API error 429: ...`, `OpenAI API error ...`, `Gemini API error ...`), so existing consumers and tests are unaffected.

- [ ] **Step 1: Write the failing test.** `httpError.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmHttpError } from "../errors";
import { AnthropicProvider } from "./AnthropicProvider";
import { GeminiProvider } from "./GeminiProvider";
import { OpenAiProvider } from "./OpenAiProvider";

afterEach(() => vi.unstubAllGlobals());

const failing = (status: number, body: string) =>
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status, text: async () => body }) as unknown as Response));
const ASK = { messages: [{ role: "user" as const, content: "Refund ticket 41?" }] };

describe("LlmHttpError", () => {
  it.each([
    ["anthropic", "Anthropic", () => new AnthropicProvider({ apiKey: "k" })],
    ["openai", "OpenAI", () => new OpenAiProvider({ apiKey: "k" })],
    ["gemini", "Gemini", () => new GeminiProvider({ apiKey: "k" })],
  ] as const)("%s throws it from complete with the status and the unchanged message", async (provider, label, make) => {
    failing(429, "slow down");
    const err = await make().complete(ASK).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmHttpError);
    expect(err).toMatchObject({ name: "LlmHttpError", status: 429, provider });
    expect((err as Error).message).toBe(`${label} API error 429: slow down`);
  });

  it("throws it from a streamed request too", async () => {
    failing(503, "busy");
    const it = new OpenAiProvider({ apiKey: "k" }).stream(ASK)[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toMatchObject({ name: "LlmHttpError", status: 503, provider: "openai" });
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @loom/llm test -- httpError` (Expected: FAIL: `../errors` missing).
- [ ] **Step 3: Implement.** `errors.ts`:

```ts
export type LlmHttpProvider = "anthropic" | "openai" | "gemini";

const LABEL: Record<LlmHttpProvider, string> = { anthropic: "Anthropic", openai: "OpenAI", gemini: "Gemini" };

/** A provider's HTTP API answered with a non-2xx status. `message` keeps the historical text (it includes the body); `status` is what a caller should branch on. */
export class LlmHttpError extends Error {
  readonly status: number;
  readonly provider: LlmHttpProvider;
  constructor(provider: LlmHttpProvider, status: number, body: string) {
    super(`${LABEL[provider]} API error ${status}: ${body}`);
    this.name = "LlmHttpError";
    this.status = status;
    this.provider = provider;
  }
}
```

Replace each `throw new Error(\`X API error ${resp.status}: ${await resp.text()}\`)` with `throw new LlmHttpError("x", resp.status, await resp.text())` (`"anthropic"` at the two Anthropic sites, `"openai"` at the two OpenAI sites, `"gemini"` at the one Gemini site); export `LlmHttpError` and `LlmHttpProvider` from `index.ts`.

- [ ] **Step 4: Run to verify it passes** (new file plus the whole `@loom/llm` suite).
- [ ] **Step 5: Gate and commit.** `git commit -m "feat(llm): providers throw a typed LlmHttpError carrying the status"` (trailer). Draft PR.

### Task 201c (Loom repo): `GeminiProvider` can cap thinking

**Why.** Gemini's thinking tokens count against `maxOutputTokens`; a transcription-sized request with a small cap ends in `MAX_TOKENS` with no text (probe G2). `generationConfig.thinkingConfig.thinkingBudget` caps or disables it.

**Files:**
- Modify: `packages/llm/src/providers/GeminiProvider.ts` (config, constructor validation, `buildBody`)
- Test: `packages/llm/src/providers/GeminiProvider.test.ts` (append)

**Interfaces:**
- Produces: `GeminiProviderConfig.thinkingBudget?: number` (a non-negative integer; `0` disables thinking on models that allow it). Sent as `generationConfig.thinkingConfig.thinkingBudget`, merged with `includeThoughts` when both are set. A negative or non-integer value throws `RangeError("thinkingBudget must be a non-negative integer")` at construction.

- [ ] **Step 1: Write the failing test.** Append inside the existing `describe` of `GeminiProvider.test.ts`:

```ts
  it("sends thinkingBudget, merged with includeThoughts, and nothing when unset", async () => {
    const fetchFn = stubFetch({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] });
    await new GeminiProvider({ apiKey: "k", thinkingBudget: 0, includeThoughts: true }).complete({
      messages: [{ role: "user", content: "hi" }],
    });
    const body = JSON.parse((fetchFn.mock.calls[0]![1] as { body: string }).body);
    expect(body.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingBudget: 0 });

    const plain = stubFetch({ candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }] });
    await new GeminiProvider({ apiKey: "k" }).complete({ messages: [{ role: "user", content: "hi" }] });
    expect(JSON.parse((plain.mock.calls[0]![1] as { body: string }).body)).not.toHaveProperty("generationConfig");
  });

  it("refuses a bad thinkingBudget at construction", () => {
    for (const bad of [-1, 1.5, Number.NaN])
      expect(() => new GeminiProvider({ apiKey: "k", thinkingBudget: bad })).toThrow(/^thinkingBudget must be a non-negative integer$/);
  });
```

- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @loom/llm test -- GeminiProvider` (Expected: FAIL).
- [ ] **Step 3: Implement.** Add the config field with its doc comment, `private readonly thinkingBudget: number | undefined;`, validation in the constructor (`if (config.thinkingBudget !== undefined && !(Number.isInteger(config.thinkingBudget) && config.thinkingBudget >= 0)) throw new RangeError("thinkingBudget must be a non-negative integer");`), and replace the `includeThoughts` block of `buildBody` with:

```ts
    const thinking: Record<string, unknown> = {};
    if (this.includeThoughts !== undefined) thinking.includeThoughts = this.includeThoughts;
    if (this.thinkingBudget !== undefined) thinking.thinkingBudget = this.thinkingBudget;
    if (Object.keys(thinking).length > 0) generationConfig.thinkingConfig = thinking;
```

- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Gate and commit.** `git commit -m "feat(llm): Gemini provider can cap or disable thinking"` (trailer). Draft PR.

---

## Phase B: the DocMind foundation

### Task 202: bump `LOOM_REF` past the three Loom changes

**Spec:** Global Constraints (Loom first). Precondition: Tasks 201a to 201c are merged in Loom and `~/workspace/loom` is at its new `main` with `pnpm build` done.

**Files:**
- Modify: `.github/workflows/ci.yml` (`LOOM_REF`)
- Create: `apps/server/app/llm/loomPin.test.ts`

**Interfaces:**
- Consumes: Loom at its new `main`.
- Produces: the pin every later task builds against; a test that fails if the checkout lacks `LlmHttpError`, the reasoning alias, `reasoningEffort` or `thinkingBudget`.

- [ ] **Step 1: Write the failing test.** `apps/server/app/llm/loomPin.test.ts`:

```ts
import { GeminiProvider, LlmHttpError, OpenAiProvider } from "@loom/llm";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

const ask = { messages: [{ role: "user" as const, content: "sentinel-question" }] };
const stub = (response: object) => {
  const fn = vi.fn(async () => response as unknown as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
};

describe("the Loom pin carries the generic additions the provider factory needs", () => {
  it("has LlmHttpError (201b)", async () => {
    stub({ ok: false, status: 429, text: async () => "sentinel-body" });
    await expect(new OpenAiProvider({ apiKey: "" }).complete(ask)).rejects.toMatchObject({ name: "LlmHttpError", status: 429 });
    expect(new LlmHttpError("gemini", 503, "x").status).toBe(503);
  });
  it("reads `reasoning` and sends reasoning_effort (201a)", async () => {
    const fn = stub({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "a", reasoning: "sentinel-thought" }, finish_reason: "stop" }] }),
    });
    const res = await new OpenAiProvider({ apiKey: "", reasoningEffort: "medium" }).complete(ask);
    expect(res.reasoning?.[0]?.text).toBe("sentinel-thought");
    expect(JSON.parse((fn.mock.calls[0] as unknown as [string, { body: string }])[1].body).reasoning_effort).toBe("medium");
  });
  it("sends thinkingBudget (201c)", async () => {
    const fn = stub({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: "a" }] }, finishReason: "STOP" }] }) });
    await new GeminiProvider({ apiKey: "k", thinkingBudget: 0 }).complete(ask);
    expect(JSON.parse((fn.mock.calls[0] as unknown as [string, { body: string }])[1].body).generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });
});
```

- [ ] **Step 2: Run to verify it fails** against the old pin: `pnpm --filter @docmind/server test -- loomPin` (Expected: FAIL: `LlmHttpError` is not exported).
- [ ] **Step 3: Bump the pin.** Set `LOOM_REF` in `.github/workflows/ci.yml` to the full SHA of Loom's `main` after 201c merges (copy it from `git -C ~/workspace/loom rev-parse HEAD`), and rebuild `~/workspace/loom` locally (`pnpm install && pnpm build`).
- [ ] **Step 4: Run the full gate.** Expected: PASS, counts equal to the precondition's plus 3.
- [ ] **Step 5: Commit** `git commit -m "ci: pin loom past the OpenAI-compatible reasoning, LlmHttpError and Gemini thinking-budget changes"`; draft PR `feat/llm-loom-pin`.

### Task 203: roles, providers and boot validation

**Spec:** Decisions D1 to D5, D9; Open questions 1 to 3.

**Files:**
- Create: `apps/server/app/llm/modelId.ts`, `apps/server/app/llm/roles.ts`
- Modify: `apps/server/app/flows/ingest-document/limits.ts` (re-export `envModelId`; `insecureBaseUrlWarning` delegates to `insecureUrlWarning`)
- Test: `apps/server/app/llm/roles.test.ts`; `apps/server/app/flows/ingest-document/limits.test.ts` unchanged (it must still pass)

**Interfaces:**
- Consumes: `StartupConfigError` (`../startupError`), `positiveInt` (`../documents/limits`).
- Produces: the catalogue's `roles.ts` and `modelId.ts` exports.

- [ ] **Step 1: Write the failing test.** `roles.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { StartupConfigError } from "../startupError";
import { envModelId } from "./modelId";
import { insecureUrlWarning, llmWarnings, loadLlmRoles, pdfMaxBytes } from "./roles";

const roles = (env: Record<string, string>) => loadLlmRoles(env).roles;

describe("loadLlmRoles defaults", () => {
  it("runs everything on gemma through Ollama and turns PDF reading off without a Gemini key", () => {
    expect(roles({})).toEqual({
      chat: { provider: "ollama", model: "gemma4:31b-cloud" },
      title: { provider: "ollama", model: "gemma4:31b-cloud" },
      summary: { provider: "ollama", model: "gemma4:31b-cloud" },
      vision: { provider: "ollama", model: "gemma4:31b-cloud" },
      visionPdf: { provider: "off", model: "" },
    });
  });
  it("uses Gemini for scanned PDF pages as soon as its key exists, and for nothing else", () => {
    const r = roles({ GEMINI_API_KEY: "test-key-not-real" });
    expect(r.visionPdf).toEqual({ provider: "gemini", model: "gemini-3.5-flash" });
    expect(r.chat.provider).toBe("ollama");
  });
  it("ignores an Anthropic key on its own", () => {
    expect(roles({ ANTHROPIC_API_KEY: "test-key-not-real" }).chat.provider).toBe("ollama");
  });
});

describe("loadLlmRoles configuration", () => {
  it("DOCMIND_LLM_PROVIDER=anthropic moves every role, with the Claude defaults", () => {
    expect(roles({ DOCMIND_LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "test-key-not-real" })).toEqual({
      chat: { provider: "anthropic", model: "claude-opus-5-5" },
      title: { provider: "anthropic", model: "claude-haiku-5-5" },
      summary: { provider: "anthropic", model: "claude-haiku-5-5" },
      vision: { provider: "anthropic", model: "claude-sonnet-5-5" },
      visionPdf: { provider: "anthropic", model: "claude-sonnet-5-5" },
    });
  });
  it("DOCMIND_LLM_PROVIDER=ollama cannot read PDFs: that role falls back like the default", () => {
    expect(roles({ DOCMIND_LLM_PROVIDER: "ollama" }).visionPdf.provider).toBe("off");
    expect(roles({ DOCMIND_LLM_PROVIDER: "ollama", GEMINI_API_KEY: "test-key-not-real" }).visionPdf.provider).toBe("gemini");
  });
  it("a per-role variable beats the shared one, and `off` switches a role off", () => {
    const r = roles({ DOCMIND_LLM_PROVIDER: "ollama", DOCMIND_TITLE_PROVIDER: "off", DOCMIND_SUMMARY_MODEL: "gemma4:31b-cloud" });
    expect(r.title).toEqual({ provider: "off", model: "" });
    expect(r.summary.provider).toBe("ollama");
  });
  it("the PDF role inherits DOCMIND_VISION_MODEL when it has the same provider (the pre-existing variable)", () => {
    const r = roles({ DOCMIND_LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "test-key-not-real", DOCMIND_VISION_MODEL: "claude-custom-1" });
    expect(r.vision.model).toBe("claude-custom-1");
    expect(r.visionPdf.model).toBe("claude-custom-1");
  });
  it("reads the URLs and the Gemini thinking budget", () => {
    const s = loadLlmRoles({ DOCMIND_OLLAMA_URL: "http://127.0.0.1:9", ANTHROPIC_BASE_URL: "https://gateway.example", GEMINI_BASE_URL: "http://127.0.0.1:8", DOCMIND_GEMINI_THINKING_BUDGET: "128" });
    expect(s).toMatchObject({ ollamaUrl: "http://127.0.0.1:9", anthropicBaseUrl: "https://gateway.example", geminiBaseUrl: "http://127.0.0.1:8", geminiThinkingBudget: 128 });
    expect(loadLlmRoles({}).ollamaUrl).toBe("http://127.0.0.1:11434");
    expect(loadLlmRoles({}).geminiThinkingBudget).toBe(0);
  });
});

describe("loadLlmRoles refuses to start, naming variables and never values", () => {
  const bad = (env: Record<string, string>, message: RegExp) =>
    expect(() => loadLlmRoles(env)).toThrow(message);
  it("a provider without its credential", () => {
    bad({ DOCMIND_CHAT_PROVIDER: "anthropic" }, /^ANTHROPIC_API_KEY is not set \(DOCMIND_CHAT_PROVIDER=anthropic\)$/);
    bad({ DOCMIND_VISION_PDF_PROVIDER: "gemini" }, /^GEMINI_API_KEY is not set \(DOCMIND_VISION_PDF_PROVIDER=gemini\)$/);
  });
  it("an impossible combination", () => {
    bad({ DOCMIND_CHAT_PROVIDER: "gemini", GEMINI_API_KEY: "test-key-not-real" }, /^DOCMIND_CHAT_PROVIDER cannot be gemini: the chat needs streaming$/);
    bad({ DOCMIND_VISION_PDF_PROVIDER: "ollama" }, /^DOCMIND_VISION_PDF_PROVIDER cannot be ollama: it takes no PDF input$/);
  });
  it("an unknown provider, a bad model id, a bad budget", () => {
    bad({ DOCMIND_SUMMARY_PROVIDER: "openai" }, /^DOCMIND_SUMMARY_PROVIDER must be one of anthropic, ollama, gemini, off$/);
    bad({ DOCMIND_CHAT_MODEL: "Not A Model!" }, /^DOCMIND_CHAT_MODEL must be a model id$/);
    bad({ DOCMIND_GEMINI_THINKING_BUDGET: "-1" }, /^DOCMIND_GEMINI_THINKING_BUDGET must be a whole number from 0 to 24576$/);
    expect(() => loadLlmRoles({ DOCMIND_CHAT_MODEL: "Not A Model!" })).toThrow(StartupConfigError);
  });
  it("accepts model ids with a colon (gemma4:31b-cloud)", () => {
    expect(envModelId({ X: "gemma4:31b-cloud" }, "X", "d")).toBe("gemma4:31b-cloud");
    expect(() => envModelId({ X: "bad id" }, "X", "d")).toThrow(/^X must be a model id$/);
  });
});

describe("limits and warnings", () => {
  it("PDF caps follow the provider", () => {
    expect(pdfMaxBytes("anthropic")).toBe(22 * 1024 * 1024);
    expect(pdfMaxBytes("gemini")).toBe(14 * 1024 * 1024);
    expect(pdfMaxBytes("ollama")).toBe(0);
  });
  it("warns, in fixed text, about an unused Anthropic key and a plain-http remote URL, and about roles that are off", () => {
    const env = { ANTHROPIC_API_KEY: "test-key-not-real", DOCMIND_OLLAMA_URL: "http://203.0.113.9:11434" };
    const w = llmWarnings(loadLlmRoles(env), env);
    expect(w).toContain("ANTHROPIC_API_KEY is set but no role uses the anthropic provider");
    expect(w).toContain("DOCMIND_OLLAMA_URL is plain http:// to a host that is not this machine: document text and questions travel unencrypted");
    expect(w).toContain("scanned PDF pages are not read: DOCMIND_VISION_PDF_PROVIDER is off");
    expect(w.join("\n")).not.toContain("203.0.113.9");
  });
  it("insecureUrlWarning is silent for https, loopback and non-URLs", () => {
    for (const u of ["https://x.example", "http://127.0.0.1:1", "http://localhost", "http://[::1]:1", "not a url", undefined])
      expect(insecureUrlWarning("V", u)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @docmind/server test -- llm/roles` (Expected: FAIL: modules missing).
- [ ] **Step 3: Implement `modelId.ts`.** Move `MODEL_ID` and `envModelId` out of `flows/ingest-document/limits.ts` (delete them there and add `export { envModelId } from "../../llm/modelId";`), with the regex widened:

```ts
import { StartupConfigError } from "../startupError";

/** Model ids: ollama tags ("gemma4:31b-cloud"), Claude and Gemini ids. Letters, digits and . _ : - only. */
const MODEL_ID = /^[a-z0-9][a-z0-9._:\-]{0,99}$/;

export const envModelId = (env: NodeJS.ProcessEnv, name: string, fallback: string): string => {
  const v = env[name]?.trim() || fallback;
  if (!MODEL_ID.test(v)) throw new StartupConfigError(`${name} must be a model id`);
  return v;
};
```

- [ ] **Step 4: Implement `roles.ts`.**

```ts
import { StartupConfigError } from "../startupError";
import { envModelId } from "./modelId";

export const LLM_ROLES = ["chat", "title", "summary", "vision", "visionPdf"] as const;
export type LlmRole = (typeof LLM_ROLES)[number];
export const PROVIDERS = ["anthropic", "ollama", "gemini"] as const;
export type ProviderName = (typeof PROVIDERS)[number];
export type RoleProvider = ProviderName | "off";

export interface RoleSetting {
  provider: RoleProvider;
  /** "" when the role is off. */
  model: string;
}

export interface LlmRoleSettings {
  roles: Record<LlmRole, RoleSetting>;
  anthropicBaseUrl?: string;
  ollamaUrl: string;
  geminiBaseUrl?: string;
  geminiThinkingBudget: number;
}

const PREFIX: Record<LlmRole, string> = {
  chat: "DOCMIND_CHAT",
  title: "DOCMIND_TITLE",
  summary: "DOCMIND_SUMMARY",
  vision: "DOCMIND_VISION",
  visionPdf: "DOCMIND_VISION_PDF",
};

const MIB = 1024 * 1024;
/** What each provider can do. `pdfMaxBytes` is the provider's request limit for one inline PDF (D9). */
const CAN: Record<ProviderName, { stream: boolean; pdfMaxBytes: number }> = {
  anthropic: { stream: true, pdfMaxBytes: 22 * MIB },
  ollama: { stream: true, pdfMaxBytes: 0 },
  gemini: { stream: false, pdfMaxBytes: 14 * MIB },
};
export const pdfMaxBytes = (provider: ProviderName): number => CAN[provider].pdfMaxBytes;

const DEFAULT_MODEL: Record<ProviderName, Record<LlmRole, string>> = {
  anthropic: {
    chat: "claude-opus-5-5",
    title: "claude-haiku-5-5",
    summary: "claude-haiku-5-5",
    vision: "claude-sonnet-5-5",
    visionPdf: "claude-sonnet-5-5",
  },
  ollama: Object.fromEntries(LLM_ROLES.map((r) => [r, "gemma4:31b-cloud"])) as Record<LlmRole, string>,
  gemini: Object.fromEntries(LLM_ROLES.map((r) => [r, "gemini-3.5-flash"])) as Record<LlmRole, string>,
};

const blank = (v: string | undefined) => (v?.trim() ? v.trim() : undefined);

function providerVar(env: NodeJS.ProcessEnv, name: string): RoleProvider | undefined {
  const v = blank(env[name])?.toLowerCase();
  if (v === undefined) return undefined;
  if (v === "off" || (PROVIDERS as readonly string[]).includes(v)) return v as RoleProvider;
  throw new StartupConfigError(`${name} must be one of ${PROVIDERS.join(", ")}, off`);
}

function budget(env: NodeJS.ProcessEnv): number {
  const raw = blank(env.DOCMIND_GEMINI_THINKING_BUDGET);
  if (raw === undefined) return 0;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n > 24_576)
    throw new StartupConfigError("DOCMIND_GEMINI_THINKING_BUDGET must be a whole number from 0 to 24576");
  return n;
}

/**
 * Provider and model per role from the environment (D1 to D4). Throws a StartupConfigError that names
 * variables and never values. Pure: safe to call from every composition step.
 */
export function loadLlmRoles(env: NodeJS.ProcessEnv = process.env): LlmRoleSettings {
  const shared = providerVar(env, "DOCMIND_LLM_PROVIDER");
  const geminiKey = blank(env.GEMINI_API_KEY) !== undefined;
  const anthropicKey = blank(env.ANTHROPIC_API_KEY) !== undefined;
  const roles = {} as Record<LlmRole, RoleSetting>;
  for (const role of LLM_ROLES) {
    const providerName = `${PREFIX[role]}_PROVIDER`;
    const modelName = `${PREFIX[role]}_MODEL`;
    let provider: RoleProvider | undefined = providerVar(env, providerName);
    if (provider === undefined) {
      if (role === "visionPdf") {
        // Only a provider that can read a PDF may be the default for it.
        provider =
          shared === "off" ? "off"
          : shared !== undefined && CAN[shared].pdfMaxBytes > 0 ? shared
          : geminiKey ? "gemini"
          : "off";
      } else provider = shared ?? "ollama";
    }
    if (provider === "off") {
      roles[role] = { provider, model: "" };
      continue;
    }
    if (role === "chat" && !CAN[provider].stream)
      throw new StartupConfigError(`${providerName} cannot be ${provider}: the chat needs streaming`);
    if (role === "visionPdf" && CAN[provider].pdfMaxBytes === 0)
      throw new StartupConfigError(`${providerName} cannot be ${provider}: it takes no PDF input`);
    if (provider === "anthropic" && !anthropicKey)
      throw new StartupConfigError(`ANTHROPIC_API_KEY is not set (${providerName}=anthropic)`);
    if (provider === "gemini" && !geminiKey)
      throw new StartupConfigError(`GEMINI_API_KEY is not set (${providerName}=gemini)`);
    // The PDF role inherits the image role's model variable when both use the same provider (it was one variable).
    const inherited =
      role === "visionPdf" && roles.vision.provider === provider ? blank(env.DOCMIND_VISION_MODEL) : undefined;
    roles[role] = { provider, model: envModelId(env, modelName, inherited ?? DEFAULT_MODEL[provider][role]) };
  }
  const anthropicBaseUrl = blank(env.ANTHROPIC_BASE_URL);
  const geminiBaseUrl = blank(env.GEMINI_BASE_URL);
  return {
    roles,
    ...(anthropicBaseUrl && { anthropicBaseUrl }),
    ollamaUrl: blank(env.DOCMIND_OLLAMA_URL) ?? "http://127.0.0.1:11434",
    ...(geminiBaseUrl && { geminiBaseUrl }),
    geminiThinkingBudget: budget(env),
  };
}

const LOOPBACK_HOST = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

/**
 * A fixed warning (names the variable, never the address) when `url` is plain http:// to a host other than
 * this machine. Silent for https, loopback and anything that is not a URL (the provider rejects that itself).
 */
export function insecureUrlWarning(varName: string, url: string | undefined, what = "the API key and document text"): string | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" || LOOPBACK_HOST.test(parsed.hostname)) return undefined;
  return `${varName} is plain http:// to a host that is not this machine: ${what} travel unencrypted`;
}

/** Boot warnings, fixed text, once per process. Only providers some role uses are checked for their URL. */
export function llmWarnings(s: LlmRoleSettings, env: NodeJS.ProcessEnv = process.env): string[] {
  const used = new Set(LLM_ROLES.map((r) => s.roles[r].provider));
  const out: string[] = [];
  if (blank(env.ANTHROPIC_API_KEY) !== undefined && !used.has("anthropic"))
    out.push("ANTHROPIC_API_KEY is set but no role uses the anthropic provider");
  const urls: [ProviderName, string, string | undefined, string?][] = [
    ["anthropic", "ANTHROPIC_BASE_URL", s.anthropicBaseUrl],
    ["ollama", "DOCMIND_OLLAMA_URL", s.ollamaUrl, "document text and questions"],
    ["gemini", "GEMINI_BASE_URL", s.geminiBaseUrl],
  ];
  for (const [p, name, url, what] of urls) {
    const w = used.has(p) ? insecureUrlWarning(name, url, what) : undefined;
    if (w) out.push(w);
  }
  const off: [LlmRole, string][] = [
    ["chat", "chat is off: DOCMIND_CHAT_PROVIDER is off"],
    ["title", "chat titles are off: DOCMIND_TITLE_PROVIDER is off"],
    ["summary", "summaries are off: DOCMIND_SUMMARY_PROVIDER is off"],
    ["vision", "image reading is off: DOCMIND_VISION_PROVIDER is off"],
    ["visionPdf", "scanned PDF pages are not read: DOCMIND_VISION_PDF_PROVIDER is off"],
  ];
  for (const [role, text] of off) if (s.roles[role].provider === "off") out.push(text);
  return out;
}
```

Then in `limits.ts` replace the body of `insecureBaseUrlWarning` with `return insecureUrlWarning("ANTHROPIC_BASE_URL", baseUrl);` (same text as before: its existing test must pass untouched) and import `insecureUrlWarning` from `../../llm/roles`.

- [ ] **Step 5: Run to verify it passes.** `pnpm --filter @docmind/server test -- llm/roles ingest-document/limits` (Expected: PASS, the existing `insecureBaseUrlWarning` suite unchanged).
- [ ] **Step 6: Gate and commit.** `git commit -m "feat(llm): per-role provider and model configuration with boot validation"` (trailer). Draft PR `feat/llm-roles`; the body says roles are parsed but nothing is wired yet.

### Task 204: the bounding wrapper

**Spec:** D7, Global Constraints (errors carry at most a status; never log).

**Files:**
- Create: `apps/server/app/llm/bounded.ts`
- Test: `apps/server/app/llm/bounded.test.ts`

**Interfaces:**
- Consumes: the typed errors of `@docmind/llm-anthropic`; `LlmHttpError`, `UnsupportedModalityError`, `LlmProvider`, `LlmRequest`, `LlmStreamChunk` of `@loom/llm`.
- Produces: `mapLlmError`, `bounded` (catalogue). `bounded` returns a provider that exposes `capabilities` of the inner one, has `stream` only when the inner has it, forwards `warm`, fills `maxTokens` when a request has none, and bounds the whole call (a stream included) by `timeoutMs` through the request signal.

- [ ] **Step 1: Write the failing test.** `bounded.test.ts`:

```ts
import {
  LlmAbortedError, LlmOutputError, LlmRequestError, LlmStreamError, LlmUnavailableError,
} from "@docmind/llm-anthropic";
import { type LlmProvider, type LlmRequest, type LlmResponse, type LlmStreamChunk, LlmHttpError, UnsupportedModalityError } from "@loom/llm";
import { describe, expect, it } from "vitest";
import { bounded, mapLlmError } from "./bounded";

const ASK: LlmRequest = { messages: [{ role: "user", content: "sentinel-question" }] };
const OK: LlmResponse = { content: "ok", stopReason: "end_turn" };
const o = { maxTokens: 321, timeoutMs: 60_000 };
const failWith = (e: unknown): LlmProvider => ({ complete: async () => { throw e; } });

describe("mapLlmError", () => {
  it.each([408, 409, 429, 500, 503, 529])("%i is transient and keeps only the status", (status) => {
    const e = mapLlmError(new LlmHttpError("openai", status, "sentinel-body"));
    expect(e).toBeInstanceOf(LlmUnavailableError);
    expect(e).toMatchObject({ status, message: `the language model is unavailable (HTTP ${status})` });
  });
  it.each([400, 401, 403, 404, 413])("%i is permanent and keeps only the status", (status) => {
    const e = mapLlmError(new LlmHttpError("gemini", status, "sentinel-body"));
    expect(e).toBeInstanceOf(LlmRequestError);
    expect(e).toMatchObject({ status });
    expect((e as Error).message).not.toContain("sentinel");
  });
  it("a caller abort is LlmAbortedError, whatever threw", () => {
    const ac = new AbortController();
    ac.abort();
    expect(mapLlmError(new DOMException("x", "AbortError"), ac.signal)).toBeInstanceOf(LlmAbortedError);
  });
  it("a timeout and a network failure are transient; an unsupported modality and a bad body are permanent", () => {
    expect(mapLlmError(new DOMException("sentinel", "TimeoutError"))).toBeInstanceOf(LlmUnavailableError);
    expect(mapLlmError(new TypeError("fetch failed: sentinel"))).toBeInstanceOf(LlmUnavailableError);
    expect(mapLlmError(new UnsupportedModalityError("file", "application/pdf", "sentinel"))).toBeInstanceOf(LlmRequestError);
    expect(mapLlmError(new SyntaxError("sentinel"))).toBeInstanceOf(LlmRequestError);
  });
  it("leaves an already typed error alone", () => {
    const e = new LlmOutputError();
    expect(mapLlmError(e)).toBe(e);
  });
});

describe("bounded", () => {
  it("fills maxTokens, keeps an explicit one, and sets a signal", async () => {
    const seen: LlmRequest[] = [];
    const inner: LlmProvider = { complete: async (r) => (seen.push(r), OK) };
    const p = bounded(inner, o);
    await p.complete(ASK);
    await p.complete({ ...ASK, maxTokens: 5 });
    expect(seen.map((r) => r.maxTokens)).toEqual([321, 5]);
    expect(seen.every((r) => r.signal instanceof AbortSignal)).toBe(true);
  });
  it("maps a failing complete without the message", async () => {
    await expect(bounded(failWith(new LlmHttpError("openai", 429, "sentinel-body")), o).complete(ASK)).rejects.toBeInstanceOf(LlmUnavailableError);
    await expect(bounded(failWith(new Error("sentinel-prompt")), o).complete(ASK)).rejects.toThrow(/^the language model rejected the request$/);
  });
  it("times out through the signal", async () => {
    const hang: LlmProvider = {
      complete: (r) => new Promise((_, reject) => r.signal?.addEventListener("abort", () => reject(r.signal?.reason))),
    };
    await expect(bounded(hang, { maxTokens: 1, timeoutMs: 1 }).complete(ASK)).rejects.toBeInstanceOf(LlmUnavailableError);
  });
  it("reports a caller abort as LlmAbortedError", async () => {
    const ac = new AbortController();
    const hang: LlmProvider = {
      complete: (r) => new Promise((_, reject) => r.signal?.addEventListener("abort", () => reject(r.signal?.reason))),
    };
    const pending = bounded(hang, o).complete({ ...ASK, signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toBeInstanceOf(LlmAbortedError);
  });
  it("forwards capabilities and warm, and has stream only when the inner has it", async () => {
    let warmed = false;
    const inner: LlmProvider = { capabilities: { image: ["image/png"], reasoning: true }, complete: async () => OK, warm: () => { warmed = true; } };
    const p = bounded(inner, o);
    expect(p.capabilities).toEqual({ image: ["image/png"], reasoning: true });
    expect(p.stream).toBeUndefined();
    await p.warm?.();
    expect(warmed).toBe(true);
  });
  it("streams the inner chunks, fills maxTokens, and maps a broken stream to LlmStreamError", async () => {
    const seen: LlmRequest[] = [];
    const chunks: LlmStreamChunk[] = [{ delta: "a", done: false }, { delta: "", done: true, stopReason: "end_turn" }];
    const good: LlmProvider = { complete: async () => OK, async *stream(r) { seen.push(r); yield* chunks; } };
    const out: LlmStreamChunk[] = [];
    for await (const c of bounded(good, o).stream!(ASK)) out.push(c);
    expect(out).toEqual(chunks);
    expect(seen[0]?.maxTokens).toBe(321);

    const broken: LlmProvider = { complete: async () => OK, async *stream() { yield chunks[0]!; throw new TypeError("terminated"); } };
    const it = bounded(broken, o).stream!(ASK)[Symbol.asyncIterator]();
    await it.next();
    await expect(it.next()).rejects.toBeInstanceOf(LlmStreamError);
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @docmind/server test -- llm/bounded` (Expected: FAIL: module missing).
- [ ] **Step 3: Implement `bounded.ts`.**

```ts
import {
  LlmAbortedError, LlmOutputError, LlmRefusalError, LlmRequestError, LlmStreamError, LlmUnavailableError,
} from "@docmind/llm-anthropic";
import {
  LlmHttpError, type LlmProvider, type LlmRequest, type LlmStreamChunk, UnsupportedModalityError,
} from "@loom/llm";

export interface BoundedOptions {
  maxTokens: number;
  timeoutMs: number;
}

const TRANSIENT_STATUS = new Set([408, 409, 429]);

/**
 * A Loom provider's failure as DocMind's typed, content-free error (D7). Only the HTTP status survives: the
 * provider's message can hold a prompt, a document or the key. An error that is already one of ours is returned as is.
 */
export function mapLlmError(err: unknown, caller?: AbortSignal): Error {
  if (
    err instanceof LlmUnavailableError || err instanceof LlmRequestError || err instanceof LlmRefusalError ||
    err instanceof LlmAbortedError || err instanceof LlmOutputError
  )
    return err;
  if (caller?.aborted) return new LlmAbortedError();
  if (err instanceof LlmHttpError)
    return err.status >= 500 || TRANSIENT_STATUS.has(err.status)
      ? new LlmUnavailableError(err.status)
      : new LlmRequestError(err.status);
  if (err instanceof UnsupportedModalityError) return new LlmRequestError();
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return new LlmUnavailableError();
  if (err instanceof TypeError) return new LlmUnavailableError(); // fetch failed, connection reset
  return new LlmRequestError(); // a body that is not JSON, or anything unforeseen: not retried
}

const bound = (signal: AbortSignal | undefined, ms: number): AbortSignal => {
  const timer = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timer]) : timer;
};

/** The whole call (a stream included) is bounded by `timeoutMs`; a request with no `maxTokens` gets the role's. */
export function bounded(inner: LlmProvider, o: BoundedOptions): LlmProvider {
  const prepare = (r: LlmRequest): LlmRequest => ({ ...r, maxTokens: r.maxTokens ?? o.maxTokens, signal: bound(r.signal, o.timeoutMs) });
  const innerStream = inner.stream?.bind(inner);
  const provider: LlmProvider = {
    ...(inner.capabilities !== undefined && { capabilities: inner.capabilities }),
    async complete(r) {
      try {
        return await inner.complete(prepare(r));
      } catch (e) {
        throw mapLlmError(e, r.signal);
      }
    },
    ...(innerStream && {
      async *stream(r: LlmRequest): AsyncIterable<LlmStreamChunk> {
        try {
          yield* innerStream(prepare(r));
        } catch (e) {
          const m = mapLlmError(e, r.signal);
          // A failure with no status after the stream began is a broken stream: transient, same fixed message.
          throw m instanceof LlmUnavailableError && m.status === undefined && !(m instanceof LlmStreamError) ? new LlmStreamError() : m;
        }
      },
    }),
    ...(inner.warm && { warm: () => inner.warm?.() }),
  };
  return provider;
}
```

- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Gate and commit.** `git commit -m "feat(llm): bounded wrapper with timeout, default maxTokens and status-only errors"` (trailer). Draft PR `feat/llm-bounded`.

### Task 205a: fake OpenAI-compatible and Gemini servers

**Spec:** D10.

**Files:**
- Create: `apps/server/app/llm/testing/fakeOpenAiCompat.ts`, `fakeGemini.ts`, `index.ts`
- Test: `apps/server/app/llm/testing/fakes.test.ts`

**Interfaces:**
- Produces: `startFakeOpenAiCompat`, `startFakeGemini`, `CompatReply` (catalogue). The OpenAI-compatible fake answers `POST /v1/chat/completions`, non-stream as one JSON body and `stream: true` as SSE in Ollama's shape (reasoning in `delta.reasoning`, tool calls whole in one delta, usage on a final chunk when `stream_options.include_usage`, then `data: [DONE]`). The Gemini fake answers `POST /v1beta/models/<model>:generateContent`. Both record each request (the OpenAI fake records the `authorization` header; the Gemini fake the `x-goog-api-key` header) and bind `127.0.0.1` on port 0.

- [ ] **Step 1: Write the failing test.** `fakes.test.ts` (talk to each fake with plain `fetch`):

```ts
import { afterEach, describe, expect, it } from "vitest";
import { startFakeGemini, startFakeOpenAiCompat } from "./index";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("FakeOpenAiCompat", () => {
  it("answers a JSON completion with content, reasoning and usage, and records the request", async () => {
    const f = await startFakeOpenAiCompat(); closers.push(f.close);
    f.reply(() => ({ kind: "text", text: "hello", reasoning: "thought", usage: { prompt: 3, completion: 2 } }));
    const res = await post(`${f.url}/v1/chat/completions`, { model: "m", messages: [] });
    const body = await res.json() as { choices: { message: { content: string; reasoning: string }; finish_reason: string }[]; usage: { prompt_tokens: number } };
    expect(body.choices[0]).toMatchObject({ message: { content: "hello", reasoning: "thought" }, finish_reason: "stop" });
    expect(body.usage.prompt_tokens).toBe(3);
    expect(f.requests[0]).toMatchObject({ path: "/v1/chat/completions", body: { model: "m" } });
  });
  it("streams reasoning, text and usage as SSE and ends with [DONE]", async () => {
    const f = await startFakeOpenAiCompat(); closers.push(f.close);
    f.reply(() => ({ kind: "text", text: "ab", reasoning: "xy" }));
    const text = await (await post(`${f.url}/v1/chat/completions`, { stream: true, stream_options: { include_usage: true }, messages: [] })).text();
    expect(text).toContain('"reasoning":"xy"');
    expect(text).toContain('"content":"ab"');
    expect(text).toContain('"usage"');
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);
  });
  it("answers tool calls whole, and a scripted error status", async () => {
    const f = await startFakeOpenAiCompat(); closers.push(f.close);
    f.reply((n) => (n === 0 ? { kind: "tools", calls: [{ name: "search_docs", input: { query: "q" } }] } : { kind: "error", status: 503 }));
    const first = await (await post(`${f.url}/v1/chat/completions`, { messages: [] })).json() as { choices: { message: { tool_calls: { function: { name: string; arguments: string } }[] }; finish_reason: string }[] };
    expect(first.choices[0]?.finish_reason).toBe("tool_calls");
    expect(first.choices[0]?.message.tool_calls[0]?.function).toEqual({ name: "search_docs", arguments: '{"query":"q"}' });
    expect((await post(`${f.url}/v1/chat/completions`, { messages: [] })).status).toBe(503);
  });
  it("records the authorization header it saw", async () => {
    const f = await startFakeOpenAiCompat(); closers.push(f.close);
    f.reply(() => ({ kind: "text", text: "x" }));
    await fetch(`${f.url}/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer " }, body: "{}" });
    expect(f.requests[0]?.authorization).toBe("Bearer ");
  });
});

describe("FakeGemini", () => {
  it("answers generateContent and records the key header and the body", async () => {
    const f = await startFakeGemini(); closers.push(f.close);
    f.reply(() => ({ text: "page one" }));
    const res = await fetch(`${f.url}/v1beta/models/gemini-x:generateContent`, { method: "POST", headers: { "x-goog-api-key": "test-key-not-real" }, body: JSON.stringify({ contents: [] }) });
    const body = await res.json() as { candidates: { content: { parts: { text: string }[] }; finishReason: string }[] };
    expect(body.candidates[0]).toMatchObject({ content: { parts: [{ text: "page one" }] }, finishReason: "STOP" });
    expect(f.requests[0]).toMatchObject({ path: "/v1beta/models/gemini-x:generateContent", keyHeader: "test-key-not-real" });
  });
  it("answers a scripted status", async () => {
    const f = await startFakeGemini(); closers.push(f.close);
    f.reply(() => ({ status: 429 }));
    expect((await post(`${f.url}/v1beta/models/m:generateContent`, {})).status).toBe(429);
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @docmind/server test -- llm/testing` (Expected: FAIL: module missing).
- [ ] **Step 3: Implement.** `fakeOpenAiCompat.ts`:

```ts
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export type CompatReply =
  | { kind: "text"; text: string; reasoning?: string; usage?: { prompt: number; completion: number }; finish?: "stop" | "length" }
  | { kind: "tools"; calls: { name: string; input: unknown }[]; reasoning?: string }
  | { kind: "error"; status: number };

export interface FakeOpenAiCompat {
  url: string;
  requests: { path: string; authorization?: string; body: any }[];
  reply(f: (n: number, body: any) => CompatReply): void;
  close(): Promise<void>;
}

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;

/** An OpenAI-compatible chat-completions server in Ollama's wire shape (reasoning in `reasoning`). 127.0.0.1, port 0. */
export async function startFakeOpenAiCompat(): Promise<FakeOpenAiCompat> {
  let script: (n: number, body: any) => CompatReply = () => ({ kind: "text", text: "ok" });
  const requests: FakeOpenAiCompat["requests"] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: any = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { /* a malformed body is recorded as {} */ }
      const n = requests.length;
      requests.push({ path: req.url ?? "", ...(req.headers.authorization !== undefined && { authorization: req.headers.authorization }), body });
      const r = script(n, body);
      if (r.kind === "error") {
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "sentinel-provider-message", type: "server_error" } }));
        return;
      }
      const calls = r.kind === "tools" ? r.calls.map((c, i) => ({ id: `call_${i}`, index: i, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } })) : [];
      const text = r.kind === "text" ? r.text : "";
      const finish = r.kind === "tools" ? "tool_calls" : (r.finish ?? "stop");
      const usage = r.kind === "text" && r.usage ? { prompt_tokens: r.usage.prompt, completion_tokens: r.usage.completion, total_tokens: r.usage.prompt + r.usage.completion } : { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      if (body.stream !== true) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: text, ...(r.reasoning !== undefined && { reasoning: r.reasoning }), ...(calls.length > 0 && { tool_calls: calls }) }, finish_reason: finish }], usage }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse({ choices: [{ index: 0, delta: { role: "assistant" } }] }));
      if (r.reasoning) res.write(sse({ choices: [{ index: 0, delta: { reasoning: r.reasoning } }] }));
      if (text) res.write(sse({ choices: [{ index: 0, delta: { content: text } }] }));
      if (calls.length > 0) res.write(sse({ choices: [{ index: 0, delta: { tool_calls: calls } }] }));
      res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: finish }] }));
      if (body.stream_options?.include_usage) res.write(sse({ choices: [], usage }));
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    reply: (f) => { script = f; },
    close: () => new Promise<void>((ok) => { server.close(() => ok()); server.closeAllConnections(); }),
  };
}
```

`fakeGemini.ts` is the same skeleton: record `{ path, keyHeader: req.headers["x-goog-api-key"], body }`; reply `{ status }` as that status with a JSON error body, or `{ text }` as `200 { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }`. `index.ts` re-exports both starters and the types.

- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Gate and commit.** `git commit -m "test(llm): fake OpenAI-compatible and Gemini servers"` (trailer). Draft PR `test/llm-fakes`.

### Task 205b: the provider factory

**Spec:** D2, D5, D7, D8, Global Constraints (no key leaks across providers).

**Files:**
- Create: `apps/server/app/llm/factory.ts`
- Test: `apps/server/app/llm/factory.test.ts`

**Interfaces:**
- Consumes: `loadLlmRoles` and `RoleCallOptions` (Task 203), `bounded` (204), the fakes (205a), `AnthropicMessagesProvider` and `CallObserver` (`@docmind/llm-anthropic`), `OpenAiProvider`, `GeminiProvider`, `GEMINI_CAPABILITIES` (`@loom/llm`), `ChatEffort` (`../chats/settings`).
- Produces: `createRoleProvider` (catalogue).

- [ ] **Step 1: Write the failing test.** `factory.test.ts` (each test starts the fake it needs; helper `env(extra)` builds `{ DOCMIND_OLLAMA_URL: fake.url, ... }`):

```ts
import { LlmRequestError, LlmUnavailableError } from "@docmind/llm-anthropic";
import { afterEach, describe, expect, it } from "vitest";
import { StartupConfigError } from "../startupError";
import { createRoleProvider } from "./factory";
import { loadLlmRoles } from "./roles";
import { startFakeGemini, startFakeOpenAiCompat } from "./testing";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });
const make = (role: Parameters<typeof createRoleProvider>[0], env: NodeJS.ProcessEnv, extra: Partial<Parameters<typeof createRoleProvider>[3]> = {}) =>
  createRoleProvider(role, loadLlmRoles(env), env, { maxTokens: 111, timeoutMs: 5_000, ...extra });
const ASK = { messages: [{ role: "user" as const, content: "sentinel-question" }] };

describe("createRoleProvider", () => {
  it("is undefined for a role that is off", () => {
    expect(make("title", { DOCMIND_TITLE_PROVIDER: "off" })).toBeUndefined();
  });

  describe("ollama", () => {
    it("completes against DOCMIND_OLLAMA_URL with the role's model, maxTokens and an EMPTY bearer, never OPENAI_API_KEY", async () => {
      const fake = await startFakeOpenAiCompat(); closers.push(fake.close);
      fake.reply(() => ({ kind: "text", text: "a title" }));
      process.env.OPENAI_API_KEY = "sentinel-openai-key";
      try {
        const p = make("title", { DOCMIND_OLLAMA_URL: fake.url });
        expect((await p?.complete(ASK))?.content).toBe("a title");
      } finally { delete process.env.OPENAI_API_KEY; }
      expect(fake.requests[0]).toMatchObject({ path: "/v1/chat/completions", authorization: "Bearer ", body: { model: "gemma4:31b-cloud", max_tokens: 111, stream: false } });
      expect(fake.requests[0]?.body).not.toHaveProperty("reasoning_effort");
    });
    it("the chat role streams, declares reasoning, and maps effort to reasoning_effort (max becomes high)", async () => {
      const fake = await startFakeOpenAiCompat(); closers.push(fake.close);
      fake.reply(() => ({ kind: "text", text: "answer", reasoning: "thought" }));
      const p = make("chat", { DOCMIND_OLLAMA_URL: fake.url }, { chat: { effort: "max", observer: () => undefined } });
      expect(p?.capabilities?.reasoning).toBe(true);
      const chunks = [];
      for await (const c of p?.stream?.(ASK) ?? []) chunks.push(c);
      expect(chunks.some((c) => c.reasoningDelta === "thought")).toBe(true);
      expect(chunks.at(-1)).toMatchObject({ done: true, stopReason: "end_turn" });
      expect(fake.requests[0]?.body.reasoning_effort).toBe("high");
    });
    it("the image role accepts png, jpeg and webp", async () => {
      const p = make("vision", {});
      expect(p?.capabilities?.image).toEqual(["image/png", "image/jpeg", "image/webp"]);
      expect(p?.capabilities?.file).toBeUndefined();
    });
    it("maps a 503 to a transient error with only the status, and a 404 to a permanent one", async () => {
      const fake = await startFakeOpenAiCompat(); closers.push(fake.close);
      const p = make("summary", { DOCMIND_OLLAMA_URL: fake.url });
      fake.reply(() => ({ kind: "error", status: 503 }));
      await expect(p?.complete(ASK)).rejects.toMatchObject({ name: "LlmUnavailableError", status: 503 });
      fake.reply(() => ({ kind: "error", status: 404 }));
      const err = await p?.complete(ASK).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LlmRequestError);
      expect(String((err as Error).message)).not.toContain("sentinel");
    });
    it("a refused connection is transient", async () => {
      const fake = await startFakeOpenAiCompat();
      const url = fake.url; await fake.close();
      await expect(make("title", { DOCMIND_OLLAMA_URL: url })?.complete(ASK)).rejects.toBeInstanceOf(LlmUnavailableError);
    });
  });

  describe("gemini", () => {
    const geminiEnv = (url: string): NodeJS.ProcessEnv => ({ GEMINI_API_KEY: "test-key-not-real", GEMINI_BASE_URL: url, GOOGLE_API_KEY: "sentinel-google-key" });
    it("reads a PDF with the explicit key header, the role's model and thinking disabled", async () => {
      const fake = await startFakeGemini(); closers.push(fake.close);
      fake.reply(() => ({ text: '[{"page":1,"text":"x"}]' }));
      const p = make("visionPdf", geminiEnv(fake.url));
      const res = await p?.complete({ messages: [{ role: "user", content: [{ type: "file", mediaType: "application/pdf", source: { kind: "data", data: "JVBERi0=" } }, { type: "text", text: "pages" }] }] });
      expect(res?.content).toBe('[{"page":1,"text":"x"}]');
      expect(fake.requests[0]).toMatchObject({ path: "/v1beta/models/gemini-3.5-flash:generateContent", keyHeader: "test-key-not-real" });
      expect(fake.requests[0]?.body.generationConfig).toMatchObject({ maxOutputTokens: 111, thinkingConfig: { thinkingBudget: 0 } });
    });
    it("a 429 is transient with only the status", async () => {
      const fake = await startFakeGemini(); closers.push(fake.close);
      fake.reply(() => ({ status: 429 }));
      await expect(make("visionPdf", geminiEnv(fake.url))?.complete(ASK)).rejects.toMatchObject({ name: "LlmUnavailableError", status: 429 });
    });
    it("refuses a key that is not header-safe, naming the variable", () => {
      expect(() => make("visionPdf", { GEMINI_API_KEY: "bad key\n" })).toThrow(new StartupConfigError("GEMINI_API_KEY must be a header-safe string"));
    });
  });

  describe("anthropic", () => {
    it("builds the Claude provider with the role's model, as before", () => {
      const p = make("summary", { DOCMIND_SUMMARY_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "test-key-not-real" });
      expect((p as { model?: string }).model).toBe("claude-haiku-5-5");
    });
    it("names the variable for a bad base URL or key", () => {
      expect(() => make("summary", { DOCMIND_SUMMARY_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "test-key-not-real", ANTHROPIC_BASE_URL: "ftp://x" })).toThrow(/^ANTHROPIC_BASE_URL must be an http\(s\) URL/);
      expect(() => make("summary", { DOCMIND_SUMMARY_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "bad key\n" })).toThrow(/^ANTHROPIC_API_KEY must be a header-safe string$/);
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @docmind/server test -- llm/factory` (Expected: FAIL: module missing).
- [ ] **Step 3: Implement `factory.ts`.**

```ts
import { AnthropicMessagesProvider, type CallObserver } from "@docmind/llm-anthropic";
import { GeminiProvider, type LlmCapabilities, type LlmProvider, OpenAiProvider } from "@loom/llm";
import type { ChatEffort } from "../chats/settings";
import { StartupConfigError } from "../startupError";
import { bounded } from "./bounded";
import { type LlmRole, type LlmRoleSettings } from "./roles";

export interface RoleCallOptions {
  maxTokens: number;
  timeoutMs: number;
  /** Chat only: what the Claude and gemma providers do with it differs (D8). */
  chat?: { effort: ChatEffort; observer: () => CallObserver | undefined };
}

const OLLAMA_EFFORT = { low: "low", medium: "medium", high: "high", max: "high" } as const;
const HEADER_SAFE = /^[\x21-\x7e]+$/;
const OLLAMA_IMAGES: LlmCapabilities = { image: ["image/png", "image/jpeg", "image/webp"] };
const GEMINI_MEDIA: LlmCapabilities = {
  image: ["image/png", "image/jpeg", "image/webp"],
  file: ["application/pdf"],
};

function anthropic(role: LlmRole, s: LlmRoleSettings, env: NodeJS.ProcessEnv, o: RoleCallOptions): LlmProvider {
  try {
    return new AnthropicMessagesProvider({
      apiKey: env.ANTHROPIC_API_KEY?.trim() as string, // loadLlmRoles proved it is set
      model: s.roles[role].model,
      maxTokens: o.maxTokens,
      timeoutMs: o.timeoutMs,
      ...(s.anthropicBaseUrl && { baseUrl: s.anthropicBaseUrl }),
      ...(o.chat && {
        thinking: true,
        effort: o.chat.effort,
        cache: true,
        refusal: "report" as const,
        observer: o.chat.observer,
      }),
    });
  } catch (err) {
    // The provider's messages name an option, never a value; say which variable it came from.
    if (err instanceof TypeError && /^baseUrl/.test(err.message))
      throw new StartupConfigError(err.message.replace(/^baseUrl/, "ANTHROPIC_BASE_URL"));
    if (err instanceof TypeError && /^apiKey/.test(err.message))
      throw new StartupConfigError("ANTHROPIC_API_KEY must be a header-safe string");
    throw err;
  }
}

function ollama(role: LlmRole, s: LlmRoleSettings, o: RoleCallOptions): LlmProvider {
  let url: URL;
  try {
    url = new URL(s.ollamaUrl);
  } catch {
    throw new StartupConfigError("DOCMIND_OLLAMA_URL must be an http(s) URL");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password)
    throw new StartupConfigError("DOCMIND_OLLAMA_URL must be an http(s) URL without credentials");
  return bounded(
    new OpenAiProvider({
      baseUrl: url.href.replace(/\/+$/, ""),
      model: s.roles[role].model,
      apiKey: "", // never fall back to OPENAI_API_KEY: nothing secret goes to Ollama
      capabilities: { ...OLLAMA_IMAGES, ...(o.chat && { reasoning: true }) },
      ...(o.chat && { reasoningEffort: OLLAMA_EFFORT[o.chat.effort] }),
    }),
    o,
  );
}

function gemini(role: LlmRole, s: LlmRoleSettings, env: NodeJS.ProcessEnv, o: RoleCallOptions): LlmProvider {
  const apiKey = env.GEMINI_API_KEY?.trim() as string; // loadLlmRoles proved it is set
  if (!HEADER_SAFE.test(apiKey)) throw new StartupConfigError("GEMINI_API_KEY must be a header-safe string");
  return bounded(
    new GeminiProvider({
      apiKey, // explicit: never GOOGLE_API_KEY
      model: s.roles[role].model,
      ...(s.geminiBaseUrl && { baseUrl: s.geminiBaseUrl }),
      capabilities: GEMINI_MEDIA,
      thinkingBudget: s.geminiThinkingBudget,
    }),
    o,
  );
}

/** The provider a role is configured for, or undefined when it is off. Startup errors name variables only. */
export function createRoleProvider(role: LlmRole, s: LlmRoleSettings, env: NodeJS.ProcessEnv, o: RoleCallOptions): LlmProvider | undefined {
  switch (s.roles[role].provider) {
    case "off": return undefined;
    case "anthropic": return anthropic(role, s, env, o);
    case "ollama": return ollama(role, s, o);
    case "gemini": return gemini(role, s, env, o);
  }
}
```

- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Gate and commit.** `git commit -m "feat(llm): provider factory for anthropic, ollama and gemini"` (trailer). Draft PR `feat/llm-factory`; nothing calls it yet.

---

## Phase C: wiring the call sites

### Task 206: ingest on the configured providers (summary, images, scanned PDF pages)

**Spec:** D2, D9; Findings table (summary, vision rows).

**Files:**
- Modify: `apps/server/app/flows/ingest-document/limits.ts` (`IngestWiring.llm`, `LlmSettings`, `loadLlmConfig`, `createLlm`)
- Modify: `apps/server/app/flows/ingest-document/vision.ts` (`VisionReader` takes `{ image?, pdf?, pdfMaxBytes? }`)
- Modify: `apps/server/app/flows/ingest-document/steps/parse.ts` (availability and cap per capability)
- Modify: `apps/server/app/flows/ingest-document/pgDeps.ts` (line 67)
- Modify: test harnesses `apps/server/app/documents/ingestStack.ts`, `documents/testHarness.ts` (env names `anthropic` explicitly)
- Test: `limits.test.ts`, `vision.test.ts`, `steps/parse.test.ts` (extend)

**Interfaces:**
- Consumes: `loadLlmRoles`, `pdfMaxBytes` (203), `createRoleProvider` (205b).
- Produces: `IngestWiring.llm` and `VisionReader` as in the catalogue. `VisionReader.canReadImages` and `canReadPdf` are true when its provider is set; `pdfMaxBytes` defaults to `VISION_PDF_MAX_BYTES` (22 MiB). In `parse.ts`: an image document with no `image` provider fails `vision_unavailable`; textless PDF pages with no `pdf` provider keep text pages or fail `vision_unavailable` (as today); a PDF larger than `vision.pdfMaxBytes` is `too_large` (as today, with the provider's cap).

- [ ] **Step 1: Write the failing tests.**
  - `limits.test.ts`: `createIngestWiring({})` builds `llm.summary` and `llm.vision` (Ollama) and no `llm.visionPdf`; `createIngestWiring({ GEMINI_API_KEY: "test-key-not-real" }).llm.visionPdf` exists; `DOCMIND_SUMMARY_PROVIDER=off` leaves `llm.summary` undefined; `llm.config.visionTimeoutMs` still 180 000; an Anthropic role without a key throws `StartupConfigError` `ANTHROPIC_API_KEY is not set (DOCMIND_SUMMARY_PROVIDER=anthropic)`.
  - `vision.test.ts`: a `VisionReader({ image: fakeProvider })` has `canReadImages === true`, `canReadPdf === false`; `readPdfPages` on a reader with no `pdf` provider rejects with `PermanentIngestError` code `vision_unavailable` (pin with `rejects.toMatchObject({ code: "vision_unavailable" })`); with `pdf` set, `readPdfPages` calls **the pdf provider**, not the image one (assert on which fake saw the request).
  - `steps/parse.test.ts`: an image with a vision object whose `canReadImages: false` fails `vision_unavailable`; a textless-only PDF with `canReadPdf: false` fails `vision_unavailable`; a PDF of 15 MiB passes with `pdfMaxBytes: 22 MiB` and fails `too_large` with `pdfMaxBytes: 14 MiB` (use `bytes.length` stubs the way the existing too-large test does).
- [ ] **Step 2: Run to verify they fail.** `pnpm --filter @docmind/server test -- ingest-document/limits ingest-document/vision ingest-document/steps/parse`.
- [ ] **Step 3: Implement `limits.ts`.** Replace `createLlm` and `LlmSettings`:

```ts
/** Timeouts and roles. It never holds a key (R10): keys live only inside the providers. */
export interface LlmSettings {
  timeoutMs: number;
  visionTimeoutMs: number;
}

export function loadLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmSettings {
  return {
    timeoutMs: positiveInt(env, "DOCMIND_LLM_TIMEOUT_MS", 60_000, MAX_LLM_TIMEOUT_MS),
    // A vision request reads up to VISION_PDF_PAGES_PER_REQUEST dense pages: far slower than a summary.
    visionTimeoutMs: positiveInt(env, "DOCMIND_VISION_TIMEOUT_MS", 180_000, MAX_VISION_TIMEOUT_MS),
  };
}

function createLlm(env: NodeJS.ProcessEnv): IngestWiring["llm"] {
  const config = loadLlmConfig(env);
  const roles = loadLlmRoles(env);
  const make = (role: LlmRole, maxTokens: number, timeoutMs: number) =>
    createRoleProvider(role, roles, env, { maxTokens, timeoutMs });
  const summary = make("summary", SUMMARY_MAX_TOKENS, config.timeoutMs);
  const vision = make("vision", VISION_MAX_TOKENS, config.visionTimeoutMs);
  const visionPdf = make("visionPdf", VISION_MAX_TOKENS, config.visionTimeoutMs);
  return { roles, config, ...(summary && { summary }), ...(vision && { vision }), ...(visionPdf && { visionPdf }) };
}
```

Update the `IngestWiring.llm` type to `{ summary?: LlmProvider; vision?: LlmProvider; visionPdf?: LlmProvider; roles: LlmRoleSettings; config: LlmSettings }` and fix its doc comment (providers are undefined when their role is off). Delete `AnthropicMessagesProvider`, `StartupConfigError`-wrapping and `envModelId` leftovers that are now unused; keep `export { envModelId }` (Task 203).

- [ ] **Step 4: Implement `vision.ts`.** Replace the constructor and add the capability fields:

```ts
export class VisionReader {
  private readonly image: LlmProvider | undefined;
  private readonly pdf: LlmProvider | undefined;
  readonly pdfMaxBytes: number;
  constructor(o: { image?: LlmProvider; pdf?: LlmProvider; pdfMaxBytes?: number }) {
    this.image = o.image;
    this.pdf = o.pdf;
    this.pdfMaxBytes = o.pdfMaxBytes ?? VISION_PDF_MAX_BYTES;
  }
  get canReadImages(): boolean { return this.image !== undefined; }
  get canReadPdf(): boolean { return this.pdf !== undefined; }
```

In `readImage` use `if (!this.image) throw new PermanentIngestError("vision_unavailable");` and `this.image.complete(...)`; in `readPdfPages` use `if (!this.pdf) throw new PermanentIngestError("vision_unavailable");`, `bytes.length > this.pdfMaxBytes` for the defense-in-depth check and `this.pdf.complete(...)`. The constant `VISION_PDF_MAX_BYTES` stays as the Anthropic default.

- [ ] **Step 5: Implement `parse.ts` and `pgDeps.ts`.** `ParseDeps.vision` becomes `Pick<VisionReader, "readImage" | "readPdfPages"> & Partial<Pick<VisionReader, "canReadImages" | "canReadPdf" | "pdfMaxBytes">>` (an absent flag means "yes" and an absent cap means `VISION_PDF_MAX_BYTES`, so existing fakes keep working). In `readImageDocument`: `if (!deps.vision || deps.vision.canReadImages === false) throw new PermanentIngestError("vision_unavailable");`. In `withScannedPages`:

```ts
  const vision = deps.vision;
  const canPdf = vision !== undefined && vision.canReadPdf !== false;
  const cap = vision?.pdfMaxBytes ?? VISION_PDF_MAX_BYTES;
  if (!canPdf || bytes.length > cap || totalPages > VISION_PDF_MAX_PAGES) {
    if (parsed.sections.length > 0) return { ...parsed, media: [] };
    throw new PermanentIngestError(canPdf ? "too_large" : "vision_unavailable");
  }
```

(then `vision.readPdfPages(...)` as before, with `vision` narrowed by `canPdf`; cast through `as NonNullable<typeof vision>` the way `readImageDocument` does). In `pgDeps.ts`:

```ts
    ...((wiring.llm.vision || wiring.llm.visionPdf) && {
      vision: new VisionReader({
        ...(wiring.llm.vision && { image: wiring.llm.vision }),
        ...(wiring.llm.visionPdf && { pdf: wiring.llm.visionPdf }),
        pdfMaxBytes: pdfMaxBytes(wiring.llm.roles.roles.visionPdf.provider as ProviderName),
      }),
    }),
```

(`visionPdf` is set only when its provider is not `off`, so the cast holds.)

- [ ] **Step 6: Harnesses.** In `documents/ingestStack.ts` and `documents/testHarness.ts` add `DOCMIND_LLM_PROVIDER: "anthropic"` next to their `ANTHROPIC_API_KEY` so every existing suite keeps running on `FakeAnthropic` unchanged. Fix any `llm.config.baseUrl`/`summaryModel` reference the typecheck finds.
- [ ] **Step 7: Run the gate.** Expected: PASS; no existing test changes meaning.
- [ ] **Step 8: Commit** `git commit -m "feat(llm): ingest reads summaries, images and scanned PDF pages through the configured providers"` (trailer). Draft PR `feat/llm-ingest`; body says the default provider is now Ollama (Question 1) and that `setup.ts` still reads `ingest.llm.summary` for its warning (Task 207 replaces it).

### Task 207: chat and titles on the configured providers

**Spec:** D2, D3, D8; Findings table (chat, title rows).

**Files:**
- Modify: `apps/server/app/chats/llm.ts` (`createChatLlm`)
- Modify: `apps/server/app/flows/chat-title/llm.ts` (`createTitleLlm`)
- Modify: `apps/server/app/chats/settings.ts` (`ChatSettings`, `loadChatSettings`, `envelopeKeys`)
- Modify: `apps/server/app/setup.ts` (the three `ANTHROPIC_API_KEY` warnings, the insecure-URL warning)
- Modify: harnesses `chats/testStack.ts`, `flows/chat-title/step.pg.test.ts`, `documents/ingestStack.ts` env, `chats/llm.test.ts`, `chats/settings.test.ts`
- Test: `chats/llm.test.ts`, `chats/settings.test.ts`, `flows/chat-title/llm.test.ts`

**Interfaces:**
- Consumes: `loadLlmRoles`, `llmWarnings`, `createRoleProvider`.
- Produces: `ChatSettings.provider` and `titleProvider`; `createChatLlm(env, settings): ChatLlm | undefined` unchanged in shape (`{ provider, observer }`), `createTitleLlm(env, settings): LlmProvider | undefined`.

- [ ] **Step 1: Write the failing tests.**
  - `chats/settings.test.ts`: `loadChatSettings({}).provider` is `"ollama"`, `.model` `"gemma4:31b-cloud"`, `.titleModel` the same; `loadChatSettings({ DOCMIND_CHAT_PROVIDER: "off" })` needs no envelope key and still gets a per-process one; with chat enabled and no `DOCMIND_CHAT_ENVELOPE_KEY` it throws `DOCMIND_CHAT_ENVELOPE_KEY is required when the chat provider is not off`; the existing rejection tests for key length and previous keys are unchanged; `DOCMIND_CHAT_EFFORT=max` is still accepted.
  - `chats/llm.test.ts`: (a) `createChatLlm({ DOCMIND_CHAT_PROVIDER: "off", ... })` is `undefined`; (b) the existing "sends the chat request shape" test now sets `DOCMIND_LLM_PROVIDER: "anthropic"` and passes unchanged; (c) new: with `startFakeOpenAiCompat`, `createChatLlm({ DOCMIND_OLLAMA_URL: fake.url, DOCMIND_CHAT_ENVELOPE_KEY: "e".repeat(32), DOCMIND_CHAT_EFFORT: "low" }, settings)` streams, the fake saw `model: "gemma4:31b-cloud"`, `reasoning_effort: "low"`, `max_tokens: 16000` and the provider declares `reasoning: true`; (d) the object has no own property holding a key (the existing "never carries the API key" test, run once per provider).
  - `flows/chat-title/llm.test.ts`: `createTitleLlm({}, loadChatSettings(...))` completes against the fake with `max_tokens: 256` and no `reasoning_effort`; `DOCMIND_TITLE_PROVIDER=off` is `undefined`.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement `settings.ts`.** `ChatSettings` gains `provider: RoleProvider; titleProvider: RoleProvider;`. In `loadChatSettings`: `const llm = loadLlmRoles(env);`, `model: llm.roles.chat.model`, `titleModel: llm.roles.title.model`, `provider: llm.roles.chat.provider`, `titleProvider: llm.roles.title.provider`, and `...envelopeKeys(env, llm.roles.chat.provider !== "off")`. In `envelopeKeys` replace the `apiKey` condition:

```ts
  if (current === undefined && chatEnabled)
    throw new StartupConfigError("DOCMIND_CHAT_ENVELOPE_KEY is required when the chat provider is not off");
```

and drop the `ANTHROPIC_API_KEY` read. Remove the now-unused `envModelId` import.

- [ ] **Step 4: Implement `chats/llm.ts` and `chat-title/llm.ts`.**

```ts
// chats/llm.ts
export function createChatLlm(env: NodeJS.ProcessEnv, settings: ChatSettings): ChatLlm | undefined {
  const observer: ChatLlm["observer"] = {};
  const provider = createRoleProvider("chat", loadLlmRoles(env), env, {
    maxTokens: settings.maxTokens,
    timeoutMs: CHAT_REQUEST_TIMEOUT_MS,
    chat: { effort: settings.effort, observer: () => observer.current?.() },
  });
  return provider && { provider, observer };
}
```

```ts
// flows/chat-title/llm.ts
export function createTitleLlm(env: NodeJS.ProcessEnv, _settings: ChatSettings): LlmProvider | undefined {
  return createRoleProvider("title", loadLlmRoles(env), env, { maxTokens: 256, timeoutMs: 30_000 });
}
```

(delete the `StartupConfigError` mapping that moved to the factory; `observer` is consulted only by the Anthropic provider, which the chat role may still select.)

- [ ] **Step 5: Implement `setup.ts`.** Replace the two `console.warn` lines and the insecure block with:

```ts
  const roles = ingest.llm.roles;               // already validated by createIngestWiring
  for (const w of llmWarnings(roles, process.env)) console.warn(w);
```

placed after `createIngestWiring()` (so a bad provider variable refuses to start before any connection opens, exactly where the Anthropic errors did); keep `loadChatSettings()`, `createChatLlm` and `createTitleLlm` calls, and delete the `insecureBaseUrlWarning` import and the `chat is off` warning (now in `llmWarnings`).

- [ ] **Step 6: Harnesses.** `chats/testStack.ts`, `documents/ingestStack.ts` and the chat title test env gain `DOCMIND_LLM_PROVIDER: "anthropic"` next to `ANTHROPIC_API_KEY` (their fake is `FakeAnthropic`).
- [ ] **Step 7: Run the gate.** Expected: PASS.
- [ ] **Step 8: Commit** `git commit -m "feat(llm): chat and titles run on the configured providers"` (trailer). Draft PR `feat/llm-chat`.

---

## Phase D: proof

### Task 208a: the chat end to end on a fake Ollama

**Spec:** Findings (chat row), D8.

**Files:**
- Modify: `apps/server/app/chats/testStack.ts` (extract `buildChatStack`; add `startOllamaChatStack`)
- Test: `apps/server/app/chats/ollama.chat.test.ts` (new; in-memory, no Postgres, like `reasoning.chat.test.ts`)

**Interfaces:**
- Consumes: `startFakeOpenAiCompat` (205a), `createChatLlm` (207).
- Produces: `startOllamaChatStack(o: { replies: ((n: number, body: any) => CompatReply)[] ... })`: the same `ChatStack` as `startChatStack` except `fake` is a `FakeOpenAiCompat` (type `ChatStack<F>`; `startChatStack` stays `ChatStack<FakeAnthropic>` so no existing test changes).

- [ ] **Step 1: Write the failing test.** `ollama.chat.test.ts` (names the scenarios; fixtures are sentinels; passages built like `reasoning.chat.test.ts`):

```ts
describe("the chat on Ollama (fake)", () => {
  it("runs a tool loop: a search call, then a cited answer with reasoning, over the real flow and sealing", async () => {
    // reply 0: { kind: "tools", calls: [{ name: "search_docs", input: { query: "sentinel-query" } }], reasoning: "sentinel-thought-1" }
    // reply 1: { kind: "text", text: `sentinel answer [[${PASSAGE_ID}]]`, reasoning: "sentinel-thought-2" }
    // expect: replies(conv, 1)[0] is { text: "sentinel answer [[...]]", status: "complete" };
    //         the fake saw 2 requests, the second contains a role "tool" message with the passage text,
    //         the request carries `stream: true`, `reasoning_effort: "medium"` and the tools.
    //         ChatReasoningStore holds both thoughts sealed (reasoningRows.size 2); items has one `tool` step.
  });
  it("a 503 on the first attempt is retried, the listeners are told to reset, and the answer completes", async () => {
    // reply 0: { kind: "error", status: 503 }; reply 1: text. expect a bus `reset` was published once
    // (stack.chat.bus subscribe) and the final text is the second reply's.
  });
  it("a 400 is permanent: the turn ends failed and the log, items and error text carry no provider message", async () => {
    // reply: { kind: "error", status: 400 }; expect status "failed"; JSON.stringify of raw events and of
    // the onError argument contain neither "sentinel-provider-message" nor the question.
  });
  it("max_tokens on the stream ends the reply with the max_tokens outcome item", async () => {
    // reply: { kind: "text", text: "sentinel cut", finish: "length" }; expect items outcome kind "max_tokens".
  });
});
```

Write each test body in full in the file (the comments above are the assertions to implement; use `stack.replies`, `stack.reasoningRows`, `stack.items`, `stack.raw` exactly as `reasoning.chat.test.ts` and `eventLog.chat.test.ts` do, and the pinned-error style of the Global Constraints).

- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @docmind/server test -- chats/ollama.chat` (Expected: FAIL: `startOllamaChatStack` missing).
- [ ] **Step 3: Refactor `testStack.ts`.** Move everything after the `env`/`settings`/`llm` lines into `async function buildChatStack<F>(fake: F, closeFake: () => Promise<void>, env: NodeJS.ProcessEnv, o: Omit<Options, "scripts">): Promise<ChatStack<F>>`; `startChatStack` becomes a thin caller (start `FakeAnthropic`, queue scripts, env with `DOCMIND_LLM_PROVIDER: "anthropic"`); `startOllamaChatStack` starts `startFakeOpenAiCompat`, sets `fake.reply` to walk `o.replies` in order, and uses `env = { DOCMIND_OLLAMA_URL: fake.url, DOCMIND_CHAT_ENVELOPE_KEY: "e".repeat(32) }`. `ChatStack` gains a type parameter with default `FakeAnthropic`.
- [ ] **Step 4: Run to verify it passes, then the whole chat suite** (existing chat tests must be untouched by the refactor).
- [ ] **Step 5: Gate and commit.** `git commit -m "test(llm): the chat end to end on a fake Ollama"` (trailer). Draft PR `test/llm-chat-ollama`.

### Task 208b: ingest end to end on fake Ollama and fake Gemini

**Spec:** Findings (summary, vision rows), D9.

**Files:**
- Modify: `apps/server/app/documents/ingestStack.ts` (an option `providers: "anthropic" | "ollama"`; when `ollama`, start `FakeOpenAiCompat` and `FakeGemini` and put their URLs in the env instead of `FakeAnthropic`)
- Test: `apps/server/app/flows/ingest-document/providers.pg.test.ts` (new; Postgres like `eventLog.pg.test.ts`, skips without `DOCMIND_TEST_PG_URL`)

**Interfaces:**
- Consumes: `startFakeOpenAiCompat`, `startFakeGemini`, the ingest stack.
- Produces: proof of the three ingest routes.

- [ ] **Step 1: Write the failing tests** (one `describe`, same stack, scenarios):
  1. **Summary on gemma.** A text document: the fake Ollama receives the map and reduce requests with `temperature: 0`, `max_tokens: 2048`, a user message containing the document's untrusted fence, and no `response_format`; the fake answers a fenced ```json object; the document reaches `ready` with the summary stored. The fake **Gemini saw no request**.
  2. **Image on gemma.** A tiny PNG: the Ollama fake receives an `image_url` data URL part with `data:image/png;base64,`; the document is `ready`; sections are "Text in the image" and "Description".
  3. **Scanned PDF page on Gemini.** A PDF with one textless page (reuse the fixture the existing `vision.test`/`parse` suites use): the Gemini fake receives `inlineData.mimeType: "application/pdf"`, `generationConfig.thinkingConfig.thinkingBudget: 0` and the key header `test-key-not-real`; the **Ollama fake saw no PDF request**; the page text is stored.
  4. **A 429 from Gemini is retried** (reply 429 then success): the step succeeds on attempt 2 (the stack's `sleep` is a no-op) and no log row, error text or failure reason contains `sentinel-provider-message`.
  5. **PDF without a Gemini key.** `DOCMIND_VISION_PDF_PROVIDER` off (no key): a textless-only PDF fails with failure code `vision_unavailable`, a PDF with text pages is `ready` with its text pages.
- [ ] **Step 2: Run to verify it fails.** `DOCMIND_TEST_PG_URL=… pnpm --filter @docmind/server test -- providers.pg` (Expected: FAIL).
- [ ] **Step 3: Implement** the `providers` option in `ingestStack.ts` (the existing default stays `anthropic`) and the scenarios.
- [ ] **Step 4: Run to verify it passes**, then the whole ingest suite.
- [ ] **Step 5: Gate and commit.** `git commit -m "test(llm): ingest end to end on fake Ollama and fake Gemini"` (trailer). Draft PR `test/llm-ingest-providers`.

### Task 209: opt-in real-model suites

**Spec:** D10; Question 4. These are the owner's way to judge gemma and Gemini on real documents; they are never part of the gate.

**Files:**
- Create: `apps/server/app/llm/realOllama.test.ts`, `apps/server/app/llm/realGemini.test.ts`
- Modify: `apps/server/vitest.config.ts` only if the existing config does not already exclude nothing for `*.test.ts` (both files skip themselves)

**Interfaces:**
- Consumes: `createRoleProvider`, `loadLlmRoles`, `DOC_ASSISTANT_PROMPT` (`chats/agent.ts`).
- Produces: two suites, skipped unless `DOCMIND_REAL_OLLAMA=1` or `DOCMIND_REAL_GEMINI=1` is exported (the second also needs `GEMINI_API_KEY` in the shell; the suite never prints it, never puts it in a test name or an assertion message).

- [ ] **Step 1: Write the suites** (`describe.skipIf(process.env.DOCMIND_REAL_OLLAMA !== "1")`):
  - `realOllama.test.ts`, content-free prompts and a generated 400x120 PNG (a fixed base64 constant of the text `PROBE 4821 ok` checked in as a string, 3 KB): (1) title role answers a short plain text; (2) chat role streams and ends with `stopReason: "end_turn"` and at least one `reasoningDelta` (effort `medium`); (3) a two-tool request ends `tool_use` with two calls; (4) the real `DOC_ASSISTANT_PROMPT` with a two-passage tool result cites both ids as `[[id]]` in at least 5 of 6 runs; (5) the image role returns text containing `4821` through `VisionReader.readImage`; (6) a PDF `file` part is refused with `LlmRequestError` status 400 (documents the boundary that makes Gemini necessary).
  - `realGemini.test.ts`: one-page PDF fixture (constant base64) through `VisionReader.readPdfPages(bytes, [1])` returns a map with page 1 containing `4821`; a request with `thinkingBudget` 0 and `maxTokens` 200 ends `end_turn`. Expect a possible 429 or 503 (G3, G4): the test retries up to 3 times on `LlmUnavailableError` with a condition-based loop (no sleep: a fresh call each time) and then reports skipped via `ctx.skip()`.
- [ ] **Step 2: Run them locally once.** `DOCMIND_REAL_OLLAMA=1 pnpm --filter @docmind/server test -- realOllama` (Expected: PASS against the owner's signed-in Ollama); `DOCMIND_REAL_GEMINI=1 GEMINI_API_KEY=… pnpm … realGemini` (the owner exports the key in the shell; never in a file).
- [ ] **Step 3: Run the default gate**: both files report skipped.
- [ ] **Step 4: Commit** `git commit -m "test(llm): opt-in real-model suites for Ollama and Gemini"` (trailer). Draft PR `test/llm-real-suites`.

### Task 210: docs

**Files:**
- Modify: `.env.example` (the Claude block becomes the providers block)
- Create: `docs/operations/llm-providers.md`
- Modify: `README.org` (the configuration section's LLM lines), `docs/specs/2026-10-18-docmind-design.md` (§3.2 `LlmProvider` row, §5.2 vision rows, §6.5 "What is shown" and "Provider": as built)

**Interfaces:** none (text).

- [ ] **Step 1: `.env.example`.** Replace the "Claude (optional)" and "Chat (needs ANTHROPIC_API_KEY above)" comments with (values empty or commented; never a real key):

```sh
# Language models. Every role runs on Ollama's gemma4:31b-cloud unless set otherwise; embeddings are separate (below).
# Providers: anthropic, ollama, gemini, off. DOCMIND_LLM_PROVIDER sets the default of every role.
# DOCMIND_LLM_PROVIDER=ollama
# Per role (chat, title, summary, vision = images, vision_pdf = scanned PDF pages): DOCMIND_<ROLE>_PROVIDER and _MODEL.
# DOCMIND_CHAT_PROVIDER=ollama
# DOCMIND_CHAT_MODEL=gemma4:31b-cloud
# DOCMIND_TITLE_PROVIDER=ollama
# DOCMIND_SUMMARY_PROVIDER=ollama
# DOCMIND_VISION_PROVIDER=ollama
# Scanned PDF pages need a provider that reads PDFs (gemma through Ollama cannot): gemini when GEMINI_API_KEY is set, else off.
# DOCMIND_VISION_PDF_PROVIDER=gemini
# DOCMIND_VISION_PDF_MODEL=gemini-3.5-flash
# Ollama is the DOCMIND_OLLAMA_URL of the embeddings, signed in for cloud models (`ollama signin`).
# Gemini: copy the GEMINI_API_KEY value from the genUI project's .env into THIS file. DocMind never reads another repository's files.
GEMINI_API_KEY=
# DOCMIND_GEMINI_THINKING_BUDGET=0
# GEMINI_BASE_URL=
# Claude, only when a role is set to anthropic (DOCMIND_LLM_PROVIDER=anthropic or per role). An Anthropic key alone enables nothing.
ANTHROPIC_API_KEY=
# ANTHROPIC_BASE_URL=
# DOCMIND_LLM_TIMEOUT_MS=60000
# DOCMIND_VISION_TIMEOUT_MS=180000
```

keeping the unchanged chat variables (`DOCMIND_CHAT_EFFORT`, `_MAX_TOKENS`, `_CONTEXT_TOKENS`, the envelope key lines with "Required whenever the chat provider is not off", `DOCMIND_CHAT_GENERAL_KNOWLEDGE`, `DOCMIND_RETRIEVAL_HOPS`).

- [ ] **Step 2: `docs/operations/llm-providers.md`.** A runbook with: the role table of D2 and the probe evidence in two lines each (O1 to O10, G1 to G4 as a short table without the probe prompts); how to switch a role; how to run everything on Claude (`DOCMIND_LLM_PROVIDER=anthropic`); how to give DocMind the Gemini key (copy from genUI's `.env`, never commit, never paste in a PR); `ollama signin` and the cloud model; the boot errors and what each means (the exact messages of Task 203); the failure modes (Ollama down is a transient error, a Gemini 429 or 503 is retried, a PDF over 14 MiB on Gemini is `too_large`); the residuals (Question 7, no usage metering, no refusal outcome on gemma, thinking is the model's own text); a pointer to the opt-in suites of Task 209.
- [ ] **Step 3: README.org and the spec.** README: replace the "set ANTHROPIC_API_KEY for summaries and chat" lines with a pointer to `docs/operations/llm-providers.md`. Spec: §3.2 row "`LlmProvider`": "providers: `packages/llm-anthropic` (Claude), Loom's `OpenAiProvider` (Ollama) and `GeminiProvider`, built per role by `apps/server/app/llm`"; §5.2 image and PDF rows: "read by the role's provider (default gemma through Ollama for images, Gemini for scanned PDF pages)"; §6.5: add a short "As built with other providers" paragraph (reasoning is the model's own text, kind `text`, shown under the same Thinking row; no refusal outcome; effort maps to `reasoning_effort`); note once that the error classes live in `@docmind/llm-anthropic` for historical reasons.
- [ ] **Step 4: Verify.** `pnpm lint && pnpm test` (docs only; the `.env.example` is covered by the existing env-example test if any: run it); `git grep -nE "AIza|sk-ant" -- .` finds nothing.
- [ ] **Step 5: Commit** `git commit -m "docs: pluggable LLM providers, the .env.example block and the runbook"` (trailer). Draft PR `docs/llm-providers`.

---

## Self-review

**Spec and instruction coverage.** "Make DocMind run on Gemini and on Ollama gemma instead of Anthropic": Tasks 203 to 207. "Gemma where capable, Gemini only where required": the per-role defaults of D2, each with a probe (O1 to O10, G2); Gemini is used for scanned PDF pages only, because gemma refuses PDFs (O6) and the chat cannot use Gemini (no `stream`, L4). "Keep Anthropic working": the factory's `anthropic` branch is the old construction moved, the existing suites run on `FakeAnthropic` with an explicit provider (Tasks 206 and 207 harness steps). "Pick the Gemini key from genUI": D5, Task 210; the key name `GEMINI_API_KEY` is genUI's, the value is copied by the owner, no DocMind code reads genUI. "Loom changes generic": 201a to 201c, each described without DocMind wording. "Embeddings out of scope": untouched. Boot-time validation: Task 203 tests every message. Security rules: error mapping drops bodies (Task 204 pins `not.toContain("sentinel")`), keys never fall back to `OPENAI_API_KEY` or `GOOGLE_API_KEY` (Task 205b tests), warnings never print URLs (Task 203 test).

**Gaps found and closed in the plan.** (1) `envModelId` rejected `gemma4:31b-cloud` (no colon): widened in Task 203 with a test. (2) The Gemini PDF request limit is smaller than Anthropic's: provider-specific cap (D9, Task 206), flagged to verify against the current Gemini docs. (3) Thinking tokens eat Gemini's `maxOutputTokens` (G2): `thinkingBudget` (201c) set to 0 by default. (4) The envelope key was required only with `ANTHROPIC_API_KEY`: now required whenever chat is on (Task 207). (5) Ollama's `reasoning` field is ignored by Loom (L2): 201a.

**Placeholders.** None intended: the two test descriptions in Task 208a and the scenario list of 208b state their assertions and the exact helper to copy from; the executor writes the bodies from them with the existing `reasoning.chat.test.ts` and `eventLog.pg.test.ts` as the pattern. If a reviewer wants them inlined, do it in the PR, not by guessing.

**Type consistency.** `RoleProvider`/`ProviderName` (203) are used by `ChatSettings` (207), `pdfMaxBytes` (206) and the factory (205b); `RoleCallOptions` (205b) is what 206 and 207 pass; `IngestWiring.llm.roles` (206) is what `setup.ts` reads in 207; `ChatStack<F>` (208a) keeps `ChatStack` as its default so no existing import changes.

**Known risks.** gemma's quality on dense scans, long summaries and citation discipline beyond the probes (Question 4, Task 209); the Gemini key's quota (G4); Loom's providers cap neither response size nor redirects (Question 7); a breaking default for Claude users (Question 1).
