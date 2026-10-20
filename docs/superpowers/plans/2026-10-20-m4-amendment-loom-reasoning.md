# DocMind M4 Amendment: model reasoning through Loom ADR 0133

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax. This amendment is read WITH `docs/superpowers/plans/2026-10-20-m4-chat-and-history.md` (the "M4 plan"): everything there stands except what this file replaces. Where the two disagree, this file wins.

**Goal:** M4 shows and stores the model's reasoning through Loom's ADR 0133 pipeline (provider reasoning parts, a sidecar `ReasoningStore`, the `LLM_REASONING_CAPTURED` audit event, the hub's live reasoning channel, `Conversations.reasoningTarget`), instead of DocMind's app-side design (provider observer blocks, `chat_reasoning_blocks`, `thinking` turn items, `ChatBus` thinking). DocMind keeps its own provider package as the transport and supplies the one thing Loom leaves to the app: a `ReasoningStore` that seals reasoning text under the owner's key.

**Why (owner decision 2026-10-20):** Loom main `58fb2f5c` (28 commits, all ADR 0133 plus an unrelated `headers` option; `KERNEL_ABI` and `EVENT_SCHEMA` unchanged, so recorded M4 events stay replayable) now does what DocMind hand-built: continuation of signed thinking blocks across the tool loop, a drop rule that is a pure function of the transcript, a live reasoning channel, durable audit capture and an owner-only read. loom-ui (`b072bba`, `f396de7`, `4f53516`) renders it (`ChatFeed({ reasoning })`, `GET .../reasoning?cursor=`). M4's HTTP routes (Task 149 on) are not built, so nothing public depends on the app-side shapes yet. Research: `m4-research/loom-reasoning-0133.md` in the session scratchpad.

**What stays app-side** (Loom has none of it): the provider (typed content-free errors, byte caps, `output_config.effort`, cache breakpoints, injectable `fetch`, refusal and usage reporting), the encrypting `ReasoningStore`, refusal and `max_tokens` outcomes, usage, the tool-step bus, the `chatScope` ALS, shutdown handling.

**Architecture after the amendment:**

| Need | Mechanism |
|---|---|
| Ask for thinking | `AnthropicMessagesProvider({ thinking: true })` still sends `thinking: {type: "adaptive", display: "summarized"}`, `output_config.effort`, cache breakpoints, never `temperature`. |
| Provider to Loom | `LlmResponse.reasoning` (`kind`, `text`, `signature`, `provider: "anthropic"`), `LlmResponse.layout` (vendor block order, only when not canonical), `LlmStreamChunk.reasoningDelta`, `capabilities.reasoning`. Same on `stream()` and `complete()`. |
| Loom to provider | An assistant `reasoning` part is mapped back to `thinking` / `redacted_thinking`, in message order, unchanged. |
| Capture | `createAgentModelEffect(..., { reasoning: { store, live: true, onDelta: hub.reasoningSink(), model } })`: text to the store, signatures inline in `STEP_COMPLETED.output.reasoning`, audit event `LLM_REASONING_CAPTURED`. |
| Store | `ChatReasoningStore` (this amendment) over table `chat_reasoning_texts`: each text sealed with `FieldCrypto` under the owner's key. |
| Live | `ConversationHub.reasoningSink()` events (`type: "reasoning"`) and `reasoningPartialOf` for late joiners. |
| History | Per history page, one memoized log read per generation, then bounded reads per reply; `ChatMessageDto.reasoning`. |
| Durable endpoint | `GET /api/chats/:id/reasoning?cursor=` mirroring Loom's endpoint, owner-checked twice (the chat row, then `reasoningTarget`). |
| Refusal, usage | `CallObserver` shrinks to `onRefusal` and `onUsage`. |

**Tech stack:** unchanged. Loom pin moves to `58fb2f5c4de9ac1dac85dbd7412b44cd81fdd03d`. No new dependency: `@loom/llm`, `@loom/conversation`, `@loom/classify` are already in `apps/server`.

---

## Decisions (binding; A1 to A14)

- **A1. Loom pin.**
  - `.github/workflows/ci.yml` `LOOM_REF` becomes `58fb2f5c4de9ac1dac85dbd7412b44cd81fdd03d`.
  - The M4 plan header sentence "Loom stays pinned at `006dfdaf…`; nothing here needs a Loom change" is replaced by: "Loom is pinned at `58fb2f5c…` (ADR 0133); nothing here needs a Loom change." Nothing else in the repo names the old sha (verified: only `ci.yml` and the plan); spec §10's CI row says "pinned `LOOM_REF`" without a sha and stays as it is.
  - The local `../loom` checkout is already at `58fb2f5c` with `dist` built; Task 158 verifies it and does not rebuild unless the probe fails.
- **A2. The provider speaks the 0133 contract** (Tasks 159a to 159c).
  - **Responses.** Both `complete()` and `stream()` build one ordered list of validated blocks and hand it to ONE function, `outcomeOf(blocks)`, which returns `{content, toolCalls, reasoning?, layout?}`. So the two paths cannot drift. The mapping rule is Loom's own (ADR D2):
    - `thinking` with non-empty text is `kind: "summary"` with `text`;
    - `thinking` with empty text is `kind: "text"` with `text: ""`;
    - `redacted_thinking` is `kind: "redacted"` with `signature: <data>` and no text;
    - every part has `provider: "anthropic"` and `signature` when the block had one.
  - **Layout.** `layoutOf(entries)` from `@loom/llm`, entries `"reasoning"`, `{call: id}`, `{text: length}`; absent unless there is reasoning and the order is not canonical.
  - **Streaming.** `reasoningDelta` chunks (`{delta: "", done: false, reasoningDelta}`) carry thinking text; `thinking` text never enters `delta`. The terminal chunk carries `reasoning` and `layout`.
  - **Requests.** An assistant `reasoning` part of provider `"anthropic"` becomes its block, in the order it sits in the message (Loom's `assistantMessageOf` already puts it in vendor order). Rules: parts of another provider are omitted; all reasoning parts are omitted when `thinking` is off; a reasoning part with no signature is dropped together with every later reasoning part of that message (a signature binds what is before it); a reasoning part in a non-assistant message is `LlmRequestError`.
  - **Capabilities.** `capabilities.reasoning` is `true` only when the provider was built with `thinking: true`. Ingest providers have thinking off, so Loom's boot warning (one per reasoning-capable effect without a store) never names them.
  - **Kept as is:** `effort`, cache breakpoints (never on a thinking block), byte caps, typed content-free errors, `fetch` injection, never `temperature`, `refusal: "throw" | "report"`.
  - **Refusal.** Unchanged in meaning: no tool calls, no reasoning and no layout on a refused response; the partial text stays. Hence no reasoning of a refused response is ever stored.
  - **`CallObserver`** becomes `{ onRefusal(details): Promise<void>; onUsage(usage): void }`. `ReasoningBlock`, `isReasoningBlock` and `coversToolUses` leave the package's public surface; the internal open block type is `ContentBlock` (`mapping.ts`).
  - **Conformance.** The existing `runLlmProviderConformance` run with `thinking: true` already includes Loom's reasoning parity rule (ADR D2); Task 159c adds a test that proves the run is not vacuous (the thinking configuration really reports reasoning) and a DocMind parity test that also covers `layout`.
- **A3. `ChatReasoningStore`** (Tasks 161a, 161b). Implements Loom's `ReasoningStore` (`put(bytes)`, `get(ref)`), and adds `readerFor(ref)`.
  - **What is stored.** Loom hands `put` the bytes `sealReasoningText(text, executionId)`: the JSON `{"e":"<executionId>","t":"<text>"}`. The store seals that whole string with `FieldCrypto.forUser(userId).seal(bind, string)`; `get` opens it and returns the same bytes, so Loom's own digest and execution-seal checks keep working unchanged.
  - **Who owns it (the `put` has no context argument).** `put` and the model-path `get` read the owner from the `chatScope` ALS (`chatScope.current()`, set by `chatModelEffect` around the whole inner effect, including request-time resolution). Exactly: `{tenantId, userId, chatId}` of the scope. `put` also parses the envelope's `e` with `chatIdOfConversation` and requires `{userId, chatId}` to equal the scope's, so a mismatching execution cannot write under another chat.
  - **Outside a chat scope** both throw `ReasoningScopeError` (fixed message `"no chat scope for this reasoning access"`): `put` fails the step (Loom is fail-closed), `get` fails the call (a throwing resolver is an outage in Loom, never a silent degradation).
  - **Routes** do not use the ALS: they call `store.readerFor({tenantId, userId, chatId})`, a `ReasoningReader` fixed to one chat of one owner.
  - **Address.** A random 128-bit hex string (`randomBytes(16)`), NOT a content hash: a hash of the sealed envelope (execution id plus text) would let someone with the table confirm a guessed summary. Cost: a crash-retry stores a second row for the same text (Loom's content-addressed idempotency is not used); orphans cascade with the chat and the user. A `get` of anything that is not 32 lower-case hex digits is `null` ("not yours").
  - **Binding and erasure.** Bind `chatreasoning:<chatId>:<address>`; the AAD also binds the user. Rows cascade with `chat_sessions` and so with the user. Crypto-shredding the owner's key makes `get` return `null` (`FieldKeyUnavailableError` is mapped), which Loom reports as `erased` and treats as a hole in continuation (the part and every later reasoning part are dropped). Any other failure (key store outage, tampered envelope) is rethrown.
  - **Limits.** At most `MAX_REASONING_BYTES = 512 KiB` per text (`RangeError`); a summary is a few KiB.
  - **Tenancy.** `chat_reasoning_texts` has RLS (`tenant_isolation`), every statement runs in `withTenant` and is owner-scoped (`user_id` and `chat_id` in the `WHERE`), and the composite foreign key makes a row of a chat that is not the writer's impossible.
- **A4. Sensitive event paths and the proof** (Task 162). `SENSITIVE_EVENT_PATHS` gains, verified against Loom `58fb2f5c` (`createLlmEffect.ts:246-262`, `reasoning.ts:119-185`, the model frame's `STEP_COMPLETED.output` is the `LlmCapturedResponse`):
  - `STEP_COMPLETED`: `output.reasoning` (the whole array: signature, `textRef` with its `size`, `digest`), `output.layout` (text lengths), `output.toolCalls[].signature` (Gemini only; absent for Anthropic, skipped when missing);
  - `LLM_REASONING_CAPTURED`: `parts` (the whole array: `ref`, `digest`, `size`; the digest of a short summary would let a reader of the log guess it);
  - `STEP_STARTED.input.messages` already seals the assistant reasoning parts that later requests re-send.
  - The proof (`eventLog.chat.test.ts`) asserts reasoning text and signatures are not in the raw log, that `STEP_COMPLETED:output.reasoning`, `STEP_COMPLETED:output.layout` and `LLM_REASONING_CAPTURED:parts` are sealed envelopes, that only the owner's key was requested, and that the text really sits sealed in the store (so the scan is not vacuous).
  - `stepId`, `attempt`, `provider` and `model` of `LLM_REASONING_CAPTURED` stay plaintext: ids and a model name, no content.
- **A5. Wiring and removals** (Tasks 160a, 160b, 162).
  - **Removed:** observer `onThinking`, `onBlocks`, `blocksFor`; `PgReasoningBlocks`, `chatBlocksBind`, `chat_reasoning_blocks`; the `thinking` turn item kind; `ChatBus` thinking events, partials, `maxThinkingChars`, `maxChats`, `partial()` and `end()`; `FakeBlocks`.
  - **Kept:** tool steps (`ChatBus` `tool` and `reset`), `passages` and `outcome` items, shutdown handling, `chatModelEffect` and the `chatScope` ALS (still needed for the store's `put`, the refusal observer and the `max_tokens` outcome), `chatObserver` (smaller).
  - **Config:** `createAgentModelEffect(hub.wrapProvider(provider), { stream: true, onDelta: hub.deltaSink(), reasoning: { store, live: true, onDelta: hub.reasoningSink(), model: settings.model } })`. The effect's own options win, so DocMind does NOT set `observability.reasoning` (a global `false` would silence the boot warning for effects DocMind may add later). Tests prove the chat effect's reasoning posture is `keeps` and that the ingest provider is not reasoning-capable, so Loom's boot warning has nobody to name.
  - **Order of tasks.** 158 pin and contracts; 159 provider; 160 remove app thinking (safe: after 159 the provider never calls the removed hooks); 161 the store; 162 wiring, sensitive paths and proof; 163 the reading side. Between 160 and 162 the chat effect has no store: reasoning parts come back flagged `omitted` and Loom drops them from continuation, which is valid (stripping is always valid). Every task leaves `main` green and no chat route exists until Task 149.
- **A6. Stream, history and the endpoint** (Tasks 158, 163; Changes to Tasks 151, 152).
  - **Stream kinds** (Task 152): `reasoning` `{turn, text}` (hub `reasoning` events), `reasoning-partial` `{turn, text}` (`hub.reasoningPartialOf` for a late joiner), exactly loom-ui's shape. `thinking` is gone. The hub's `reset` `{turn}` stays `reset`; the bus-originated reset (tool steps) is renamed `tool-reset` `{turnKey}`, so `reset` is exactly what `ChatFeed` accepts. `tool` and `answer` stay (DocMind kinds; `ChatFeed` reports unknown kinds as findings, M5 maps them).
  - **`ChatMessageDto`:** `thinking: string | null` becomes `reasoning: ChatReasoningDto | null` (`{text, kind: "text" | "summary" | "redacted", status?: "erased" | "digest-mismatch", truncated?: true}`, the same fold loom-ui's `chatReasoningFromDurable` does), and the DTO gains `cursor: string` (Loom's `<generation>.<sequence>`, the SSE `id:` of the `message` frame), which is what `/reasoning?cursor=` takes.
  - **History** fills `reasoning` per page: `replyReasoning.forReplies` memoizes the log read per execution (one `eventStore.read` per generation per request) and then runs `readReasoningBounded` per reply with `stepPrefix: "conv#o<turnKey>#"`, limits 64 parts and 256 KiB per reply. History is display: a failed reasoning read yields `reasoning: null` for that reply and logs the error class only.
  - **Endpoint** `GET /api/chats/:id/reasoning?cursor=`: the chat row (404), then `Conversations.reasoningTarget` (owner mode: the owner only; `ConversationNotFoundError` is 404, `InvalidCursorError` is 400), then `readReasoningBounded` with 256 parts and 1 MiB; the text is unwrapped at this edge. Body shape: Loom's (`{steps: [{stepId, recordedAttempt?, attempts: [{attempt, provider, model?, recorded, parts: [{kind, status, text?}]}]}], truncated?}`).
- **A7. Migration.** Migration `0023` is unmerged (PRs open at the end of the stack), so it is edited IN PLACE: drop `chat_reasoning_blocks`, remove `'thinking'` from the kind check, add `chat_reasoning_texts`. Consequence: a dev database that already applied the old `0023` fails the boot checksum (`MigrationChecksumError`); recreate it (test databases are fresh per run). Contingency: if `git branch -r --contains <the 0023 commit>` shows it already on `main`, add `0024_chat_reasoning_texts.sql` instead (the SQL is in Task 161b) and have it `DROP TABLE chat_reasoning_blocks` and replace the kind check.
- **A8. Refusal, stop, shutdown.** A refused response carries no reasoning, so none is stored; a stopped (barge-in) reply has no durable reasoning (Loom captures only a completed response); reasoning streamed live before a refusal was known stays visible until the durable `message` arrives (the hub has no public reset without the accepted-turn number). All three are accepted, recorded costs.
- **A9. Sizes and failure policy.**
  - Store `put` failures fail the step (Loom's fail-closed rule). `get` failures during continuation fail the call. History and the endpoint use bounded reads (A6).
  - Event log growth: Loom re-sends every earlier signature in each model frame's `STEP_STARTED.input.messages`, so a tool loop of 8 iterations writes roughly 36 part copies; sealed and small next to document text. Accepted.
  - `DOCMIND_CHAT_*` settings and the display `"summarized"` are unchanged.
- **A10. Replay and recovery.** Replay serves recorded step values and reads no blob. A recovered (crash or shutdown) model call is a live call: it resolves reasoning text from the store through the owner's key, so a restart in the middle of a tool loop keeps its signed thinking blocks (Task 155b proves it).
- **A11. Unverified by reading (probe steps below).** Loom's Anthropic mapping and DocMind's FakeAnthropic rest on recorded wire shapes, not on a live API (ADR 0133 lines 398-407). The opt-in real-API smoke (Task 132, `DOCMIND_TEST_ANTHROPIC_KEY`) gets one added check in Task 159c. If the live API rejects a tool-loop request whose thinking blocks were dropped by the drop rule, the fallback is to send no `thinking` field for that request (Task 159c, Step 9).
- **A12. Naming.** `ReasoningScopeError` (`chats/reasoningStore.ts`), `ChatReasoningStore`, `ReasoningRows`, `PgReasoningRows` (`chats/pgReasoningRows.ts`), `MemoryReasoningRows` (`chats/testing.ts`), `replyReasoning`, `reasoningBody`, `foldReasoning` (`chats/reasoningRead.ts`).
- **A13. Constraints that move.** Global constraints of the M4 plan are unchanged except: Loom pin (A1); the Encryption bullet now lists `chat_reasoning_texts.text_enc` (`chatreasoning:<chatId>:<address>`) instead of `chat_reasoning_blocks.blocks_enc`; the "Migrations" bullet says `0023` holds `chat_turn_items` and `chat_reasoning_texts`; the "Never log" bullet's "thinking text" now also means reasoning text and signatures; "Never print env vars, keys or connection strings" still applies.
- **A14. PR rules.** Same as the M4 plan: stacked drafts, at most about 300 lines and 13 files when the excess is tests (said in the PR body), rebase-merge by the owner, every commit and PR with the attribution trailers of the executing model. Branches `feat/m4-t158` ... `feat/m4-t163` (with `-a` / `-b` where split), the first cut from `feat/m4-t148`; **Task 149's branch is cut from the last amendment branch.**

### What this amendment supersedes in the M4 plan

| M4 plan text | Replaced by |
|---|---|
| Header table row "Thinking, preserved thinking blocks, refusals" and the `thinking` / `tool` / `answer` row | A2, A5, A6 |
| H3 (the provider's observer receives thinking, blocks and refusals) | A2 |
| D3 (`blocksFor`, `onThinking`, `onBlocks`; P1) | A2; only `onRefusal` and `onUsage` remain |
| D4 "The observer given to the chat provider" | `chatObserver` is `onRefusal` and `onUsage` only |
| D5 `thinking` kind, `chat_reasoning_blocks` | A3, A7 |
| D7 stream table (`thinking`), "Two turn numbers", "Late joiners" | A6: `reasoning` uses the hub's `turn`; only `tool` and `tool-reset` carry `turnKey` |
| Interface catalogue: `ReasoningBlock`, `CallObserver`, `PgReasoningBlocks`, `LiveChatEvent`, `ChatBus.partial/end`, `ChatMessageDto.thinking`, `ChatStreamEvent`, `chatObserver` | the Produces of Tasks 158 to 163 |
| Ruling P1 (full ordered blocks echoed verbatim) | Loom's recorded parts plus layout (A2); ordering preserved by the layout |
| Ruling P4 "On the stream, `thinking`/`tool` carry `turnKey`" | `reasoning` carries `turn`; `tool` carries `turnKey` |
| Global constraints: Loom pin, Encryption, Migrations bullets | A13 |

---

## Task index

| Task | Branch | What | Size |
|---|---|---|---|
| 158 | `feat/m4-t158` | Loom pin; contracts: `ChatReasoningDto`, `ChatMessageDto.reasoning` and `.cursor`, reasoning stream kinds, `ReasoningResponse` | ~150 |
| 159a | `feat/m4-t159-a` | provider request side: reasoning parts back to blocks; `onThinking` / `onBlocks` become optional | ~300 |
| 159b | `feat/m4-t159-b` | app: `chatObserver` reports refusals and usage only | ~200 |
| 159c | `feat/m4-t159-c` | provider response side: reasoning, layout, `reasoningDelta`, `capabilities.reasoning`, smaller `CallObserver` | ~300 code, ~350 tests (rule R6, said in the PR body: splitting complete from stream would leave Loom's parity rule red between the two PRs) |
| 160a | `feat/m4-t160-a` | app: `chatObserver`, `ChatBus`, `chatModelEffect`, wiring stop using thinking and blocks | ~250 |
| 160b | `feat/m4-t160-b` | app: drop `PgReasoningBlocks`, `chat_reasoning_blocks` and the `thinking` kind | ~200 (deletions) |
| 161a | `feat/m4-t161-a` | `ChatReasoningStore` and `MemoryReasoningRows` | ~300 |
| 161b | `feat/m4-t161-b` | `chat_reasoning_texts` (migration `0023`) and `PgReasoningRows` | ~250 |
| 162 | `feat/m4-t162` | wiring `reasoning:`, sensitive paths, proof, restart continuation | ~300 |
| 163 | `feat/m4-t163` | `replyReasoning`, `reasoningBody`, `foldReasoning` | ~300 |

Each task leaves the gate green. Run the gate exactly as in the M4 plan's Global Constraints (with `DOCMIND_TEST_PG_URL` exported in the same command; never print it).

---

### Task 158: Loom pin and the reasoning contracts

**Files:**
- Modify: `.github/workflows/ci.yml` (`LOOM_REF`)
- Modify: `packages/contracts/src/chats.ts`, `packages/contracts/src/chats.test.ts`
- Modify: every fixture that builds a `ChatMessageDto` (found by the grep in Step 3)

**Interfaces:**
- Consumes: Task 133 contracts.
- Produces (in `@docmind/contracts`):
  - `ChatReasoningKind`, `ChatReasoningDto { text; kind: "text" | "summary" | "redacted"; status?: "erased" | "digest-mismatch"; truncated?: true }`;
  - `ChatMessageDto` with `reasoning: ChatReasoningDto | null` (replaces `thinking`) and `cursor: string` (Loom's `<generation>.<sequence>`);
  - `ReasoningQuery { cursor }`, `ReasoningResponse` (Loom's `/reasoning` body: `steps`, `truncated?`);
  - `ChatStreamEvent`: `thinking` removed; `reasoning {turn, text}`, `reasoning-partial {turn, text}` and `tool-reset {turnKey}` added; `reset` is `{turn}` only.

- [ ] **Step 1: Probe the Loom checkout (no commit).** The tree must be at the pin and built with the reasoning exports.

```bash
git -C ../loom rev-parse HEAD
grep -c "LLM_REASONING_CAPTURED" ../loom/packages/llm/dist/index.js
grep -c "reasoningSink" ../loom/packages/conversation/dist/index.js
```

Expected: `58fb2f5c4de9ac1dac85dbd7412b44cd81fdd03d`, then two numbers of at least 1. **If the first differs**, check out the pin in `../loom` (read-only for this plan: `git -C ../loom checkout 58fb2f5c`, then `pnpm install --frozen-lockfile && pnpm build` there). **If a count is 0**, `dist` is stale: run `pnpm build` in `../loom`. Never edit Loom.

- [ ] **Step 2: Bump `LOOM_REF`.** In `.github/workflows/ci.yml` replace the line `LOOM_REF: 006dfdaf63319fa61594c42e2d5b2c8b87add2ca` with `LOOM_REF: 58fb2f5c4de9ac1dac85dbd7412b44cd81fdd03d`. Leave the comment above it as is.

```bash
grep -rn "006dfdaf" .github docs README.org apps packages infra --include='*' 2>/dev/null | grep -v "/plans/" | grep -v node_modules
```

Expected: no output (the plans keep their history).

- [ ] **Step 3: Write the failing contract tests.** In `packages/contracts/src/chats.test.ts`:

1. In the `message` fixture replace `thinking: "Looking for the Q3 figures.",` with
   ```ts
    cursor: "0.12",
    reasoning: { text: "Looking for the Q3 figures.", kind: "summary" },
   ```
2. Replace the test "describes a message with its turn, status, thinking, steps and outcome" with:
   ```ts
  it("describes a message with its turn, status, reasoning, steps, outcome and cursor", () => {
    expect(ChatMessageDto.parse(message)).toEqual(message);
    expect(
      ChatMessageDto.parse({ ...message, outcome: "max_iterations", reasoning: null }).outcome,
    ).toBe("max_iterations");
    for (const reasoning of [
      { text: "", kind: "redacted" },
      { text: "", kind: "text", status: "erased" },
      { text: "", kind: "text", status: "digest-mismatch", truncated: true },
    ]) {
      expect(ChatMessageDto.parse({ ...message, reasoning }).reasoning).toEqual(reasoning);
    }
  });

  it("refuses a reasoning kind or status it does not know, a missing cursor and the old thinking field's shape", () => {
    for (const bad of [
      { reasoning: { text: "x", kind: "thought" } },
      { reasoning: { text: "x", kind: "summary", status: "lost" } },
      { reasoning: { text: "x", kind: "summary", truncated: false } },
      { reasoning: "plain string" },
      { cursor: "" },
    ]) {
      expect(ChatMessageDto.safeParse({ ...message, ...bad }).success).toBe(false);
    }
    const { cursor: _cursor, ...noCursor } = message;
    expect(ChatMessageDto.safeParse(noCursor).success).toBe(false);
  });

  it("parses Loom's durable reasoning body and refuses an unknown part status", () => {
    const body = {
      steps: [
        {
          stepId: "conv#o1#turn:0",
          recordedAttempt: 1,
          attempts: [
            {
              attempt: 1,
              provider: "anthropic",
              model: "claude-opus-5-5",
              recorded: true,
              parts: [
                { kind: "summary", status: "ok", text: "Looking." },
                { kind: "redacted", status: "redacted" },
              ],
            },
          ],
        },
      ],
      truncated: true,
    };
    expect(ReasoningResponse.parse(body)).toEqual(body);
    expect(ReasoningResponse.parse({ steps: [] })).toEqual({ steps: [] });
    const bad = {
      steps: [
        {
          stepId: "conv#o1#turn:0",
          attempts: [
            { attempt: 1, provider: "anthropic", recorded: true, parts: [{ kind: "summary", status: "lost" }] },
          ],
        },
      ],
    };
    expect(ReasoningResponse.safeParse(bad).success).toBe(false);
    expect(ReasoningQuery.parse({ cursor: "0.12" })).toEqual({ cursor: "0.12" });
    expect(ReasoningQuery.safeParse({}).success).toBe(false);
  });
   ```
3. In "parses every stream event kind and refuses an unknown one": in `events` replace the `thinking` and the two `reset` lines with
   ```ts
      { kind: "reasoning", turn: 3, text: "..." },
      { kind: "reasoning-partial", turn: 3, text: "so far" },
      { kind: "tool", turnKey: 3, step: message.steps[0] },
      { kind: "tool-reset", turnKey: 5 },
      { kind: "answer", turn: 3, text: "The" },
      { kind: "reset", turn: 3 },
   ```
   (delete the duplicate `tool` and `answer` lines that were there), and replace the last assertion with
   ```ts
    expect(ChatStreamEvent.safeParse({ kind: "thinking", turnKey: 3, text: "x" }).success).toBe(false);
    expect(ChatStreamEvent.safeParse({ kind: "reasoning", turnKey: 3, text: "x" }).success).toBe(false);
    expect(ChatStreamEvent.safeParse({ kind: "reasoning", turn: 0, text: "x" }).success).toBe(false);
    expect(ChatStreamEvent.safeParse({ kind: "reset", turnKey: 5 }).success).toBe(false);
   ```
4. Add `ChatReasoningDto, ReasoningQuery, ReasoningResponse` to the test file's import from `./chats`.

- [ ] **Step 4: Run, see them fail.**

```bash
pnpm --filter @docmind/contracts exec vitest run src/chats.test.ts
```

Expected: FAIL (`ReasoningResponse` is not exported; the `message` fixture has no `thinking`).

- [ ] **Step 5: Implement.** In `packages/contracts/src/chats.ts`:

Replace the `ChatMessageDto` block's `thinking` and add `cursor`:

```ts
/** What kind of reasoning this is: a `summary` is never presented as the full chain of thought; `redacted` carries no text (loom-ui `ChatReasoningKind`). */
export const ChatReasoningKind = z.enum(["text", "summary", "redacted"]);
export type ChatReasoningKind = z.infer<typeof ChatReasoningKind>;

/**
 * A reply's reasoning as history shows it: the recorded attempts' texts folded into one (Loom ADR 0133, loom-ui
 * `chatReasoningFromDurable`). Absent `status` means the text was read and its digest checked. Model output derived
 * from untrusted input: text only.
 */
export const ChatReasoningDto = z.object({
  text: z.string().max(40_000),
  kind: ChatReasoningKind,
  status: z.enum(["erased", "digest-mismatch"]).optional(),
  truncated: z.literal(true).optional(),
});
export type ChatReasoningDto = z.infer<typeof ChatReasoningDto>;
```

and inside `ChatMessageDto`, replace

```ts
  /** The summarized thinking of an assistant turn, or `null`. */
  thinking: z.string().nullable(),
```

with

```ts
  /** Loom's history cursor of this record, `<generation>.<sequence>`: the SSE `id:` of its `message` frame and what `GET /api/chats/:id/reasoning?cursor=` takes. */
  cursor: Cursor,
  /** The model's reasoning for an assistant turn, or `null` (none kept, or a user message). */
  reasoning: ChatReasoningDto.nullable(),
```

After `ListMessagesResponse` add:

```ts
/** `GET /api/chats/:id/reasoning?cursor=<a reply's cursor>`. */
export const ReasoningQuery = z.object({ cursor: Cursor });
export type ReasoningQuery = z.infer<typeof ReasoningQuery>;

const ReasoningPartDto = z.object({
  kind: ChatReasoningKind,
  /** `redacted`: the vendor withheld it; `erased`: removed on purpose; `digest-mismatch`: the stored text no longer matches its record. */
  status: z.enum(["ok", "redacted", "erased", "digest-mismatch"]),
  text: z.string().optional(),
});
const ReasoningAttemptDto = z.object({
  attempt: z.number().int().nonnegative(),
  provider: z.string(),
  model: z.string().optional(),
  recorded: z.boolean(),
  parts: z.array(ReasoningPartDto),
});

/** Loom's `/reasoning` body, unchanged: loom-ui folds it. Superseded attempts are kept; `recorded` marks the one the step used. */
export const ReasoningResponse = z.object({
  steps: z.array(
    z.object({
      stepId: z.string(),
      recordedAttempt: z.number().int().nonnegative().optional(),
      attempts: z.array(ReasoningAttemptDto),
    }),
  ),
  truncated: z.literal(true).optional(),
});
export type ReasoningResponse = z.infer<typeof ReasoningResponse>;
```

Replace the `ChatStreamEvent` doc comment and union (keep `Count`):

```ts
/**
 * What `GET /api/chats/:id/stream` sends, for the web client. On the wire the SSE `event:` is `kind` and `data:` is
 * the rest of the object as JSON. `message` is durable (its SSE id is the message's `cursor`); the others are live
 * and carry no id.
 *
 * `reasoning`, `reasoning-partial` and `reset` are loom-ui's `ChatFeed` events exactly (`{turn, text}`, `{turn}`):
 * `turn` is the hub's accepted-turn number, the same one as `answer` and `ChatMessageDto.turn`. `tool` and
 * `tool-reset` come from DocMind's `ChatBus`, which numbers by the turn key (`turnKey`, what the side table uses);
 * the two numbers are not convertible from a live event, so each frame keeps the name of the one it carries.
 */
export const ChatStreamEvent = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("status"),
    state: z.string().min(1),
    running: z.boolean(),
    turns: Count,
  }),
  z.object({ kind: z.literal("message"), message: ChatMessageDto }),
  z.object({ kind: z.literal("reasoning"), turn: z.number().int().min(1), text: z.string() }),
  z.object({ kind: z.literal("reasoning-partial"), turn: z.number().int().min(1), text: z.string() }),
  z.object({ kind: z.literal("tool"), turnKey: Count, step: ChatToolStep }),
  z.object({ kind: z.literal("tool-reset"), turnKey: Count }),
  z.object({ kind: z.literal("answer"), turn: Count, text: z.string() }),
  z.object({ kind: z.literal("reset"), turn: Count }),
  z.object({ kind: z.literal("closed") }),
  z.object({
    kind: z.literal("error"),
    code: z.enum(["invalid_cursor", "not_found", "too_many_streams", "internal"]),
  }),
]);
export type ChatStreamEvent = z.infer<typeof ChatStreamEvent>;
```

Check that `packages/contracts/src/index.ts` re-exports `./chats` with `export *` (it does for the existing names); if it lists names, add the new ones.

- [ ] **Step 6: Fix every other producer and consumer of the old field.**

```bash
grep -rn --include='*.ts' -E "thinking|ChatMessageDto|ChatStreamEvent" apps packages --exclude-dir=node_modules --exclude-dir=dist | grep -v "packages/llm-anthropic" | grep -v "app/chats/\(observer\|bus\|turnItems\|model\|wiring\)" | cut -c1-140
```

At this commit the only matches outside the files Tasks 160 to 163 change are the contract and its test. Any other fixture that builds a `ChatMessageDto` gets `cursor` and `reasoning: null`.

- [ ] **Step 7: Run the gate. Commit** with `feat(contracts): reasoning DTOs and loom-ui stream kinds; pin Loom at 58fb2f5c` (and the trailer). Open the draft PR (base: the Task 148 branch).

---

### Task 159: the provider speaks the ADR 0133 contract

Three stacked PRs. **159a** is the request side (Loom's reasoning parts go back to Anthropic blocks, `blocksFor` is gone, `onThinking` and `onBlocks` become optional); **159b** is the app's observer (it stops implementing the hooks that are going away); **159c** is the response side (reasoning, layout and `reasoningDelta` come out; `onThinking` and `onBlocks` are removed; capabilities and conformance). The order keeps every PR green: after 159a the provider still calls the two optional hooks, after 159b nothing implements them, and 159c removes them. Nothing in the app reads a reasoning part before Task 162.

Read first (Loom, read-only): `packages/llm/src/types.ts` (`LlmResponse.reasoning`, `layout`, `LlmStreamChunk.reasoningDelta`), `packages/llm/src/parts.ts` (`LlmReasoningPart`, `assistantMessageOf`, `layoutOf`), `packages/llm/src/providers/AnthropicProvider.ts:111-160, 320-460` (the reference mapping; copy the logic, do not import the provider), `packages/conformance/src/reasoningParity.ts`.

#### Task 159a: reasoning parts in requests

**Files:**
- Create: `packages/llm-anthropic/src/reasoning.ts`
- Modify: `packages/llm-anthropic/src/request.ts`, `packages/llm-anthropic/src/provider.ts`, `packages/llm-anthropic/src/observer.ts`, `packages/llm-anthropic/src/index.ts`, `packages/llm-anthropic/src/__helpers__/observer.ts`
- Test: `packages/llm-anthropic/src/request.test.ts`, `packages/llm-anthropic/src/provider.test.ts`

**Interfaces:**
- Consumes: `@loom/llm` `LlmContentPart`, `LlmReasoningPart`, `LlmRequest`, `fenceUntrustedMedia`.
- Produces:
  - `reasoning.ts`: `PROVIDER_ID = "anthropic"`; `ThinkingBlock`, `RedactedBlock`; `wireBlockOf(part): ThinkingBlock | RedactedBlock`; `usableReasoning(parts, thinking): LlmContentPart[]`.
  - `request.ts`: `Block` includes both block types; `BodyOptions` is `{thinking?, effort?, cache?, stream?}` (the `reasoning` map is gone); `toolUseGroups` is gone.
  - `CallObserver` loses `blocksFor`; `onThinking` and `onBlocks` become optional (`onThinking?(text)`, `onBlocks?(ids, blocks)`), called with `?.`; `coversToolUses` and its export are gone.

- [ ] **Step 1: Write the failing request tests.** In `request.test.ts`:

1. Delete these five cases of `describe("toMessagesBody options")`: "replaces the assistant message's content with the stored blocks, verbatim and in stored order", "round-trips an interleaved thinking, tool_use, thinking, tool_use response in order", "never marks a thinking block as a cache breakpoint, and refuses an entry that is not a content block", "lists the tool_use ids of each assistant message by its index in request.messages", "does not mutate a stored reasoning block when marking the cache breakpoint". Remove `toolUseGroups` and `ReasoningBlock` from the imports and the `THINKING` constant if now unused.
2. Add `LlmContentPart` and `LlmReasoningPart` to the `@loom/llm` type import, and append:

```ts
describe("toMessagesBody: reasoning parts (ADR 0133 D5)", () => {
  const part = (over: Partial<LlmReasoningPart> = {}): LlmReasoningPart => ({
    type: "reasoning",
    kind: "summary",
    provider: "anthropic",
    signature: "SIG",
    text: "hm",
    ...over,
  });
  const loop = (assistant: LlmContentPart[]): LlmRequest => ({
    messages: [
      { role: "user", content: "find it" },
      { role: "assistant", content: assistant },
      { role: "user", content: [{ type: "tool_result", toolUseId: "toolu_1", content: "r" }] },
    ],
  });
  const call = (id: string) => ({ type: "tool_use" as const, id, name: "search_docs", input: {} });
  const on = { thinking: true } as const;

  it("maps parts back to thinking and redacted_thinking blocks, unchanged and in the recorded order", () => {
    const body = toMessagesBody(
      loop([
        part({ text: "a", signature: "S1" }),
        { type: "text", text: "looking" },
        call("toolu_1"),
        part({ text: "b", signature: "S2" }),
        part({ kind: "redacted", signature: "ENC", text: undefined }),
        call("toolu_2"),
      ]),
      "m",
      10,
      on,
    );
    expect(body.messages[1]?.content).toEqual([
      { type: "thinking", thinking: "a", signature: "S1" },
      { type: "text", text: "looking" },
      { type: "tool_use", id: "toolu_1", name: "search_docs", input: {} },
      { type: "thinking", thinking: "b", signature: "S2" },
      { type: "redacted_thinking", data: "ENC" },
      { type: "tool_use", id: "toolu_2", name: "search_docs", input: {} },
    ]);
  });

  it("sends an omitted-display part as an empty thinking block that keeps its signature", () => {
    const body = toMessagesBody(
      loop([part({ kind: "text", text: "", signature: "S0" }), call("toolu_1")]),
      "m",
      10,
      on,
    );
    expect(body.messages[1]?.content[0]).toEqual({ type: "thinking", thinking: "", signature: "S0" });
  });

  it("omits another provider's part, and every reasoning part when thinking is off", () => {
    const parts = [part({ provider: "gemini" }), part(), call("toolu_1")];
    expect(toMessagesBody(loop(parts), "m", 10, on).messages[1]?.content.map((b) => b.type)).toEqual([
      "thinking",
      "tool_use",
    ]);
    expect(toMessagesBody(loop(parts), "m", 10).messages[1]?.content.map((b) => b.type)).toEqual([
      "tool_use",
    ]);
  });

  it("drops a part with no signature and every later reasoning part of that message, keeping text and calls", () => {
    const body = toMessagesBody(
      loop([
        part({ text: "ok", signature: "S1" }),
        part({ text: "unsigned", signature: undefined }),
        part({ text: "after", signature: "S3" }),
        { type: "text", text: "t" },
        call("toolu_1"),
      ]),
      "m",
      10,
      on,
    );
    expect(body.messages[1]?.content).toEqual([
      { type: "thinking", thinking: "ok", signature: "S1" },
      { type: "text", text: "t" },
      { type: "tool_use", id: "toolu_1", name: "search_docs", input: {} },
    ]);
  });

  it("refuses a reasoning part outside an assistant message with a fixed LlmRequestError", () => {
    const bad: LlmRequest = { messages: [{ role: "user", content: [part()] }] };
    expect(() => toMessagesBody(bad, "m", 10, on)).toThrow(LlmRequestError);
  });

  it("never marks a thinking block as a cache breakpoint", () => {
    const last: LlmRequest = {
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: [{ type: "text", text: "x" }, part()] },
      ],
    };
    const body = toMessagesBody(last, "m", 10, { thinking: true, cache: true });
    expect(JSON.stringify(body.messages)).not.toContain("cache_control");
  });
});
```

(`LlmRequestError` is already imported by this test file from `./errors`; add the import if it is not.)

3. In `provider.test.ts`, `describe("request options and the observer")`: delete the `stored` constant and the three cases that use it ("asks the observer for the blocks...", "sends the message as Loom built it when the stored blocks do not cover...", "does not ask the observer, and sends no reasoning blocks, when thinking is off"), remove the `ReasoningBlock` import, and add:

```ts
  const withReasoning: LlmRequest = {
    system: "sys",
    messages: [
      { role: "user", content: "find it" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", kind: "summary", provider: "anthropic", signature: "S", text: "t" },
          { type: "tool_use", id: "toolu_1", name: "search_docs", input: {} },
        ],
      },
      { role: "user", content: [{ type: "tool_result", toolUseId: "toolu_1", content: "r" }] },
    ],
  };

  it("sends a recorded reasoning part as its block in place, with thinking, effort and cache, and never calls the observer for it", async () => {
    const rec = recordingObserver();
    await provider({ thinking: true, effort: "low", cache: true, observer: () => rec.observer }).complete(
      withReasoning,
    );
    const body = fake.requests.at(-1)?.body;
    expect(body?.messages[1]?.content[0]).toEqual({ type: "thinking", thinking: "t", signature: "S" });
    expect(body?.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(body?.output_config).toEqual({ effort: "low" });
    expect(body?.system).toEqual([{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }]);
    expect(JSON.stringify(body).match(/cache_control/g)).toHaveLength(2);
    expect(rec.log).toEqual([]);
  });

  it("sends no reasoning block when thinking is off", async () => {
    await provider().complete(withReasoning);
    expect(JSON.stringify(fake.requests.at(-1)?.body)).not.toContain('"thinking"');
  });
```

4. Replace `__helpers__/observer.ts` (its `blocks` and `thinking` members are removed in 159c; for now only `blocksFor` and `asked` go):

```ts
import type { CallObserver, LlmUsageDetail, ReasoningBlock, RefusalDetails } from "../observer";

/** A CallObserver that records every call (the response-side hooks; the request side has none). */
export function recordingObserver() {
  const log: string[] = [];
  const thinking: string[] = [];
  const blocks: { ids: readonly string[]; blocks: readonly ReasoningBlock[] }[] = [];
  const refusals: RefusalDetails[] = [];
  const usage: LlmUsageDetail[] = [];
  const observer: CallObserver = {
    onThinking(text) {
      thinking.push(text);
      log.push("thinking");
    },
    async onBlocks(ids, b) {
      blocks.push({ ids, blocks: b });
      log.push("blocks");
    },
    async onRefusal(details) {
      refusals.push(details);
      log.push("refusal");
    },
    onUsage(u) {
      usage.push(u);
      log.push("usage");
    },
  };
  return { observer, log, thinking, blocks, refusals, usage };
}
```

   Every call `recordingObserver(stored)` in `provider.test.ts`, `provider.stream.test.ts`, `conformance.test.ts` becomes `recordingObserver()` (their `stored` argument and `rec.asked` assertions go with the deleted cases; run `grep -n "recordingObserver(\|\.asked\|stored" packages/llm-anthropic/src/*.test.ts`).

- [ ] **Step 2: Run, see them fail.**

```bash
pnpm --filter @docmind/llm-anthropic exec vitest run src/request.test.ts src/provider.test.ts
```

Expected: FAIL (`reasoning` parts throw `LlmRequestError` from `block()`).

- [ ] **Step 3: Implement `reasoning.ts`.**

```ts
import type { LlmContentPart, LlmReasoningPart } from "@loom/llm";

/** The provider id on every reasoning part: a part is only sent back to the provider that produced it (ADR 0133 D2). */
export const PROVIDER_ID = "anthropic";

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}
export interface RedactedBlock {
  type: "redacted_thinking";
  data: string;
}

/**
 * An assistant `reasoning` part back to the vendor block, UNCHANGED (ADR 0133 D5): a `thinking` block with its
 * text (resolved by Loom from the sidecar; "" for an omitted-display block) and signature, or a
 * `redacted_thinking` block whose `data` is the recorded signature.
 */
export function wireBlockOf(p: LlmReasoningPart): ThinkingBlock | RedactedBlock {
  if (p.kind === "redacted") return { type: "redacted_thinking", data: p.signature ?? "" };
  return {
    type: "thinking",
    thinking: p.text ?? "",
    ...(p.signature !== undefined && { signature: p.signature }),
  };
}

/**
 * The parts of one assistant message that may be sent. Stripping reasoning is always valid, so anything
 * doubtful is stripped, never repaired: another provider's parts (their signatures mean nothing here); every
 * reasoning part when thinking is off; and, because a signature binds the blocks before it, a part with no
 * signature together with every LATER reasoning part of the message.
 */
export function usableReasoning(
  parts: readonly LlmContentPart[],
  thinking: boolean,
): LlmContentPart[] {
  let cut = false;
  return parts.filter((p) => {
    if (p.type !== "reasoning") return true;
    if (!thinking || p.provider !== PROVIDER_ID || cut) return false;
    if (p.signature === undefined || p.signature === "") {
      cut = true;
      return false;
    }
    return true;
  });
}
```

- [ ] **Step 4: Implement `request.ts`.** Replace the file with:

```ts
import {
  type LlmContentPart,
  type LlmRequest,
  type LlmResultPart,
  fenceUntrustedMedia,
} from "@loom/llm";
import { LlmRequestError } from "./errors";
import { type RedactedBlock, type ThinkingBlock, usableReasoning, wireBlockOf } from "./reasoning";

export const EFFORTS = ["low", "medium", "high", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface CacheControl {
  type: "ephemeral";
}
const EPHEMERAL: CacheControl = { type: "ephemeral" };
type Cacheable = { cache_control?: CacheControl };

type TextBlock = { type: "text"; text: string } & Cacheable;
type MediaBlock = {
  type: "image" | "document";
  source: { type: "base64"; media_type: string; data: string };
} & Cacheable;
type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown } & Cacheable;
type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | (TextBlock | MediaBlock)[];
  is_error?: true;
} & Cacheable;
export type Block =
  | TextBlock
  | MediaBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | RedactedBlock;

export interface AnthropicBody {
  model: string;
  max_tokens: number;
  stream?: true;
  system?: string | TextBlock[];
  thinking?: { type: "adaptive"; display: "summarized" };
  output_config?: { effort: Effort };
  tools?: { name: string; description: string; input_schema: Record<string, unknown> }[];
  messages: { role: "user" | "assistant"; content: Block[] }[];
}

export interface BodyOptions {
  /** Adaptive summarized thinking in the request; also the condition for sending reasoning parts back. */
  thinking?: boolean;
  effort?: Effort;
  cache?: boolean;
  stream?: boolean;
}

const leaf = (part: LlmContentPart | LlmResultPart): TextBlock | MediaBlock => {
  if (part.type === "text") return { type: "text", text: part.text };
  if ((part.type === "image" || part.type === "file") && part.source.kind === "data") {
    if (part.type === "file" && part.mediaType.toLowerCase() !== "application/pdf") {
      throw new LlmRequestError();
    }
    return {
      type: part.type === "image" ? "image" : "document",
      source: { type: "base64", media_type: part.mediaType, data: part.source.data },
    };
  }
  throw new LlmRequestError(); // refs and audio: not supported by this provider
};

const block = (part: LlmContentPart): Block => {
  if (part.type === "reasoning") return wireBlockOf(part);
  if (part.type === "tool_use") {
    return { type: "tool_use", id: part.id, name: part.name, input: part.input };
  }
  if (part.type === "tool_result") {
    const content =
      typeof part.content === "string" ? part.content : fenceUntrustedMedia(part.content).map(leaf);
    return {
      type: "tool_result",
      tool_use_id: part.toolUseId,
      content,
      ...(part.isError === true && { is_error: true as const }),
    };
  }
  return leaf(part);
};

/** Loom's request to the Messages API body. System messages join the top-level system text. */
export function toMessagesBody(
  request: LlmRequest,
  model: string,
  maxTokens: number,
  options: BodyOptions = {},
): AnthropicBody {
  const system: string[] = request.system ? [request.system] : [];
  const messages: AnthropicBody["messages"] = [];
  for (const m of request.messages) {
    const parts =
      typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
    if (m.role === "system") {
      for (const p of parts) {
        if (p.type !== "text") throw new LlmRequestError();
        system.push(p.text);
      }
      continue;
    }
    for (const p of parts) {
      if (p.type === "tool_use" && m.role !== "assistant") throw new LlmRequestError();
      if (p.type === "tool_result" && m.role !== "user") throw new LlmRequestError();
      if (p.type === "reasoning" && m.role !== "assistant") throw new LlmRequestError();
    }
    const sendable = m.role === "assistant" ? usableReasoning(parts, options.thinking === true) : parts;
    const content: Block[] = fenceUntrustedMedia(sendable)
      .map(block)
      .filter((b) => !(m.role === "assistant" && b.type === "text" && b.text === ""));
    // An assistant message with no content left (only empty text) is dropped: the API rejects
    // empty content, and consecutive same-role turns are merged by the API.
    if (content.length === 0) continue;
    messages.push({ role: m.role, content });
  }
  if (options.cache === true) {
    const turn = messages.at(-1);
    const last = turn?.content.at(-1);
    // A thinking block takes no cache_control. Copy, never mutate: blocks may be shared with the request.
    if (turn && last !== undefined && last.type !== "thinking" && last.type !== "redacted_thinking") {
      turn.content = [...turn.content.slice(0, -1), { ...last, cache_control: EPHEMERAL }];
    }
  }
  const tools = request.tools?.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: { type: "object", ...t.inputSchema },
  }));
  const text = system.join("\n\n");
  return {
    model,
    max_tokens: maxTokens,
    ...(options.stream === true && { stream: true as const }),
    ...(text !== "" && {
      system:
        options.cache === true ? [{ type: "text" as const, text, cache_control: EPHEMERAL }] : text,
    }),
    // `request.temperature` is accepted and ignored: current Claude models reject a non-default value.
    ...(options.thinking === true && {
      thinking: { type: "adaptive" as const, display: "summarized" as const },
    }),
    ...(options.effort !== undefined && { output_config: { effort: options.effort } }),
    ...(tools && tools.length > 0 && { tools }),
    messages,
  };
}
```

(The one behavioural change besides reasoning is that `toMessagesBody` no longer takes the stored-block map. The empty-content, cache-copy and system rules are the ones Task 128's fix round made.)

- [ ] **Step 5: `provider.ts` and `observer.ts`.** In `provider.ts`:

1. Imports: drop `type ReasoningBlock, coversToolUses` from `./observer` (keep `type CallObserver`), and `toolUseGroups` from `./request`.
2. Replace `#body` with a synchronous one:

```ts
  /** The request body as JSON. Reasoning parts of the request go back as blocks when thinking is on (ADR 0133). */
  #body(request: LlmRequest, stream: boolean): string {
    return JSON.stringify(
      toMessagesBody(request, this.model, this.o.maxTokens, {
        thinking: this.o.thinking === true,
        ...(this.o.effort !== undefined && { effort: this.o.effort }),
        cache: this.o.cache === true,
        stream,
      }),
    );
  }
```

3. In `complete()` and `stream()` change `const body = await this.#body(request, observer, false);` to `const body = this.#body(request, false);` and `... true`.

In `observer.ts` delete `blocksFor` from `CallObserver` and delete `coversToolUses` (the whole function). In `observer.ts` also make `onThinking` and `onBlocks` optional by writing them as `onThinking?(text: string): void;` and `onBlocks?(toolUseIds: readonly string[], blocks: readonly ReasoningBlock[]): Promise<void>;`, and change their call sites in `provider.ts` to `observer?.onThinking?.(t)` (in `complete()`), `await observer.onBlocks?.(ids, blocks)` (both paths) and the `StreamState` constructor argument to `(text) => observer?.onThinking?.(text)`. In `index.ts` delete `export { coversToolUses } from "./observer";`.

- [ ] **Step 6: Run.** `pnpm --filter @docmind/llm-anthropic exec vitest run`, then `pnpm --filter @docmind/llm-anthropic typecheck && pnpm --filter @docmind/llm-anthropic typecheck:tests`. Expected: green. Then `pnpm build && pnpm typecheck && pnpm typecheck:tests` at the root: `apps/server/app/chats/observer.ts` returns an object literal with a `blocksFor` member, which is now an excess property. Delete that one member, and the lines of `observer.test.ts` that call `o.blocksFor` or read `blocks` for it; the whole file is rewritten in Task 159b. Expected: green.

- [ ] **Step 7: Run the gate. Commit** with `feat(llm-anthropic): send recorded reasoning parts back as thinking blocks (Loom ADR 0133)`. Open the draft PR.

#### Task 159b: the app's observer reports refusals and usage only

After 159a the app's `chatObserver` no longer has `blocksFor` (its literal would not compile with it); this task removes the other two members it implements, which are optional from 159a on, and rewrites its tests. It is the only code outside the package that implements `CallObserver`.

**Files:**
- Modify: `apps/server/app/chats/observer.ts`, `apps/server/app/chats/wiring.ts` (one line), `apps/server/app/chats/observer.test.ts` (replaced)

**Interfaces:**
- Consumes: Task 159a `CallObserver` (`onThinking` and `onBlocks` optional).
- Produces: `chatObserver(deps: { items: Pick<PgTurnItems, "put"> }): () => CallObserver | undefined`, returning `{ onRefusal, onUsage }` only. `ChatObserverDeps` loses `blocks` and `bus`.

- [ ] **Step 1: Write the failing tests.** Replace `apps/server/app/chats/observer.test.ts` with the file below, and replace `apps/server/app/chats/observer.ts` and the `wiring.ts` line as in Step 3. The tests below construct `chatObserver({ items })`, so they fail to typecheck until Step 3.

```ts
import { AnthropicMessagesProvider, type CallObserver } from "@docmind/llm-anthropic";
import { type FakeAnthropic, startFakeAnthropic } from "@docmind/llm-anthropic/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chatObserver } from "./observer";
import { type ChatCallScope, chatScope } from "./scope";
import { C, FakeItems, T, U } from "./testing";
import type { ChatRef, TurnItem } from "./turnItems";

const SCOPE: ChatCallScope = {
  tenantId: T,
  userId: U,
  chatId: C,
  turnKey: 3,
  stepKey: "conv#o3#turn:0",
  attempt: 1,
};

let items: FakeItems;
let observe: () => CallObserver | undefined;
beforeEach(() => {
  items = new FakeItems();
  observe = chatObserver({ items });
});

describe("chatObserver", () => {
  it("is absent outside a chat scope", () => {
    expect(observe()).toBeUndefined();
  });

  it("stores a refusal as an outcome item with its details", async () => {
    const o = (await chatScope.run(SCOPE, async () => observe())) as CallObserver;
    await o.onRefusal({ category: "policy", explanation: "I cannot help with that." });
    expect(items.puts).toEqual([
      {
        turnKey: 3,
        stepKey: "conv#o3#turn:0",
        item: {
          kind: "outcome",
          body: {
            kind: "refusal",
            details: { category: "policy", explanation: "I cannot help with that." },
          },
        },
      },
    ]);
  });

  it("stores nothing for usage", async () => {
    const o = (await chatScope.run(SCOPE, async () => observe())) as CallObserver;
    o.onUsage({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(items.puts).toEqual([]);
  });

  it("keeps two concurrent observers of different chats apart", async () => {
    const C2 = "c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c4c4";
    const U2 = "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2";
    const seen: { ref: ChatRef; turnKey: number; item: TurnItem }[] = [];
    const recording = chatObserver({
      items: {
        async put(ref, turnKey, _step, item) {
          await Promise.resolve();
          seen.push({ ref: { tenantId: ref.tenantId, userId: ref.userId, chatId: ref.chatId }, turnKey, item });
        },
      },
    });
    const other: ChatCallScope = { ...SCOPE, userId: U2, chatId: C2, turnKey: 9 };
    await Promise.all([
      chatScope.run(SCOPE, async () => (recording() as CallObserver).onRefusal({ category: "a" })),
      chatScope.run(other, async () => (recording() as CallObserver).onRefusal({ category: "b" })),
    ]);
    expect(seen.map((s) => [s.ref.chatId, s.ref.userId, s.turnKey]).sort()).toEqual(
      [
        [C, U, 3],
        [C2, U2, 9],
      ].sort(),
    );
  });
});

describe("chatObserver with the real provider and FakeAnthropic", () => {
  let fake: FakeAnthropic;
  const provider = () =>
    new AnthropicMessagesProvider({
      apiKey: "test-key",
      model: "claude-opus-5-5",
      maxTokens: 1_000,
      timeoutMs: 5_000,
      baseUrl: fake.url,
      thinking: true,
      effort: "medium",
      cache: true,
      refusal: "report",
      observer: observe,
    });
  const drain = (messages: Parameters<AnthropicMessagesProvider["stream"]>[0]["messages"]) =>
    chatScope.run(SCOPE, async () => {
      const chunks = [];
      for await (const c of provider().stream({ messages })) chunks.push(c);
      return chunks;
    });
  beforeEach(async () => {
    fake = await startFakeAnthropic();
  });
  afterEach(async () => {
    await fake.close();
  });

  it("a refusal: stored as an outcome item, and the stream ends normally with the text it had", async () => {
    fake.reply(() => ({
      stream: { steps: [{ text: "I can" }, { stop: "refusal", details: { category: "policy" } }] },
    }));
    const chunks = await drain([{ role: "user", content: "q" }]);
    expect(chunks.map((c) => c.delta).join("")).toBe("I can");
    expect(chunks.at(-1)).toMatchObject({ done: true, stopReason: "end_turn" });
    expect(items.puts.map((p) => p.item)).toEqual([
      { kind: "outcome", body: { kind: "refusal", details: { category: "policy" } } },
    ]);
  });
});
```

- [ ] **Step 2: Run, see it fail.** `pnpm --filter @docmind/server exec vitest run app/chats/observer.test.ts`. Expected: FAIL (the old `chatObserver` needs `blocks` and `bus`, and still publishes thinking).

- [ ] **Step 3: Implement.** Replace `apps/server/app/chats/observer.ts`:

```ts
import type { CallObserver } from "@docmind/llm-anthropic";
import { chatScope } from "./scope";
import type { PgTurnItems } from "./turnItems";

export interface ChatObserverDeps {
  items: Pick<PgTurnItems, "put">;
}

/**
 * What the chat provider calls while a model request runs (M4 D3, after the ADR 0133 amendment). Reasoning is
 * not here: it comes back in the response and Loom captures it. What is left is what Loom's response type cannot
 * carry: a refusal becomes an outcome item (sealed with the other items), usage is not metered in M4 (ruling P3).
 * Absent outside a chat scope, so the ingest providers and any call that is not a chat's are untouched.
 */
export function chatObserver(deps: ChatObserverDeps): () => CallObserver | undefined {
  return () => {
    const scope = chatScope.current();
    if (!scope) return undefined;
    return {
      async onRefusal(details) {
        await deps.items.put(scope, scope.turnKey, scope.stepKey, {
          kind: "outcome",
          body: { kind: "refusal", details },
        });
      },
      onUsage() {
        // Usage is metered only through this hook (ruling P3); M4 meters nothing.
      },
    };
  };
}
```

In `apps/server/app/chats/wiring.ts` change `o.llm.observer.current = chatObserver({ items: c.items, blocks: c.blocks, bus });` to `o.llm.observer.current = chatObserver({ items: c.items });`.

- [ ] **Step 4: Run** `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm --filter @docmind/server exec vitest run app/chats`. Expected: green (`wiring.test.ts` still passes `blocks` in its collaborators until Task 160a, which is fine: the collaborator type still has it).

- [ ] **Step 5: Run the gate. Commit** with `refactor(chats): the chat observer reports refusals and usage only`. Open the stacked draft PR.

#### Task 159c: reasoning, layout and `reasoningDelta` in responses

**Files:**
- Modify: `packages/llm-anthropic/src/reasoning.ts`, `mapping.ts`, `response.ts`, `streamState.ts`, `observer.ts`, `provider.ts`, `index.ts`, `__helpers__/observer.ts`
- Test (modify, one case): `apps/server/app/chats/observer.test.ts`
- Test (create): `packages/llm-anthropic/src/provider.reasoning.test.ts`
- Test (modify): `provider.test.ts`, `provider.stream.test.ts`, `conformance.test.ts`, `realApi.test.ts`

**Interfaces:**
- Consumes: Task 159a `PROVIDER_ID`; `@loom/llm` `layoutOf`, `LlmLayoutEntry`, `LlmReasoning`, `LlmToolCall`, `LlmCapabilities`, `assembleStream`.
- Produces:
  - `reasoning.ts`: `reasoningOf(block): LlmReasoning | undefined`; `Outcome { content; toolCalls; reasoning?; layout? }`; `outcomeOf(blocks): Outcome`; `refusedOutcomeOf(blocks): Outcome` (text only).
  - `mapping.ts`: `ContentBlock` (the open validated block; replaces `ReasoningBlock`), `toContentBlock(...): ContentBlock | undefined`.
  - `CallObserver { onRefusal(details): Promise<void>; onUsage(usage: LlmUsageDetail): void }`.
  - `AnthropicMessagesProvider.capabilities: LlmCapabilities` with `reasoning: true` iff `thinking: true`.
  - `LlmResponse.reasoning` / `.layout` from `complete()`; `reasoningDelta` chunks and a terminal chunk with `reasoning` / `layout` from `stream()`.
  - The package root no longer exports `ReasoningBlock`, `isReasoningBlock`, `coversToolUses`.

- [ ] **Step 1: Write the failing tests.** Create `packages/llm-anthropic/src/provider.reasoning.test.ts`:

```ts
import { type LlmRequest, type LlmStreamChunk, assembleStream } from "@loom/llm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allReleased, sseFetch } from "./__helpers__/bodyOf";
import * as f from "./__helpers__/frames";
import { recordingObserver } from "./__helpers__/observer";
import { AnthropicMessagesProvider, type AnthropicOptions } from "./provider";
import { type FakeAnthropic, startFakeAnthropic } from "./testing/fakeAnthropic";

const HI: LlmRequest = { messages: [{ role: "user", content: "hi" }] };
const A = "anthropic";
const make = (over: Partial<AnthropicOptions> = {}) =>
  new AnthropicMessagesProvider({
    apiKey: "test-key-not-real",
    model: "claude-haiku-5-5",
    maxTokens: 256,
    timeoutMs: 5_000,
    thinking: true,
    ...over,
  });
async function collect(it: AsyncIterable<LlmStreamChunk>): Promise<LlmStreamChunk[]> {
  const out: LlmStreamChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe("complete(): reasoning and layout (ADR 0133 D2, D5)", () => {
  let fake: FakeAnthropic;
  beforeAll(async () => {
    fake = await startFakeAnthropic();
  });
  afterAll(async () => {
    await fake?.close();
  });
  const message = (content: unknown[], over: Record<string, unknown> = {}) =>
    JSON.stringify({
      id: "msg_t",
      type: "message",
      role: "assistant",
      content,
      stop_reason: "end_turn",
      stop_details: null,
      usage: { input_tokens: 5, output_tokens: 7 },
      ...over,
    });
  const run = (content: unknown[], over: Record<string, unknown> = {}, opts: Partial<AnthropicOptions> = {}) => {
    fake.reply(() => ({ status: 200, rawBody: message(content, over) }));
    return make({ baseUrl: fake.url, ...opts }).complete(HI);
  };

  it("maps thinking to a summary, redacted_thinking to a redacted part, in order, and records no layout for the canonical order", async () => {
    const res = await run(
      [
        { type: "thinking", thinking: "Let me think", signature: "SIG==" },
        { type: "redacted_thinking", data: "ENC" },
        { type: "text", text: "answer" },
        { type: "tool_use", id: "toolu_1", name: "search_docs", input: {} },
      ],
      { stop_reason: "tool_use" },
    );
    expect(res.content).toBe("answer");
    expect(res.reasoning).toEqual([
      { kind: "summary", text: "Let me think", signature: "SIG==", provider: A },
      { kind: "redacted", signature: "ENC", provider: A },
    ]);
    expect(res.layout).toBeUndefined();
    expect(res.toolCalls).toEqual([{ id: "toolu_1", name: "search_docs", input: {} }]);
  });

  it("maps an omitted-display thinking block (empty text) to kind text with an empty string and its signature", async () => {
    const res = await run([
      { type: "thinking", thinking: "", signature: "S0" },
      { type: "text", text: "a" },
    ]);
    expect(res.reasoning).toEqual([{ kind: "text", text: "", signature: "S0", provider: A }]);
  });

  it("records the vendor's order when it is not canonical: thinking, tool_use, thinking, tool_use", async () => {
    const res = await run(
      [
        { type: "thinking", thinking: "a", signature: "S1" },
        { type: "tool_use", id: "toolu_1", name: "search_docs", input: {} },
        { type: "thinking", thinking: "b", signature: "S2" },
        { type: "tool_use", id: "toolu_2", name: "related", input: {} },
      ],
      { stop_reason: "tool_use" },
    );
    expect(res.reasoning?.map((r) => r.text)).toEqual(["a", "b"]);
    expect(res.layout).toEqual(["reasoning", { call: "toolu_1" }, "reasoning", { call: "toolu_2" }]);
  });

  it("records text lengths in the layout when a text block follows a tool call, and drops an empty text block", async () => {
    const res = await run(
      [
        { type: "thinking", thinking: "a", signature: "S1" },
        { type: "text", text: "ab" },
        { type: "text", text: "" },
        { type: "tool_use", id: "toolu_1", name: "search_docs", input: {} },
        { type: "text", text: "c" },
      ],
      { stop_reason: "tool_use" },
    );
    expect(res.content).toBe("abc");
    expect(res.layout).toEqual(["reasoning", { text: 2 }, { call: "toolu_1" }, { text: 1 }]);
  });

  it("adds no reasoning or layout key to a response without thinking, whatever the option", async () => {
    const res = await run([{ type: "text", text: "plain" }]);
    expect(Object.keys(res).sort()).toEqual(["content", "stopReason", "usage"]);
  });

  it("returns no reasoning, layout or tool calls for a refused response in report mode, and keeps the text", async () => {
    const rec = recordingObserver();
    const res = await run(
      [
        { type: "thinking", thinking: "t", signature: "S" },
        { type: "text", text: "I can't help" },
        { type: "tool_use", id: "toolu_1", name: "search_docs", input: {} },
      ],
      { stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber" } },
      { refusal: "report", observer: () => rec.observer },
    );
    expect(res).toEqual({ content: "I can't help", stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 7 } });
    expect(rec.refusals).toEqual([{ category: "cyber" }]);
  });

  it("gives the observer usage detail, with null cache fields as 0", async () => {
    const rec = recordingObserver();
    await run(
      [{ type: "text", text: "a" }],
      { usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 100, cache_creation_input_tokens: null } },
      { observer: () => rec.observer },
    );
    expect(rec.usage).toEqual([{ inputTokens: 5, outputTokens: 7, cacheReadTokens: 100, cacheWriteTokens: 0 }]);
    expect(rec.log).toEqual(["usage"]);
  });
});

describe("stream(): reasoningDelta and the terminal reasoning", () => {
  it("streams thinking text as reasoningDelta, never into delta, and reports reasoning on the terminal chunk", async () => {
    const t = sseFetch([
      f.start(),
      ...f.thinking(0, ["Let me ", "think"], "SIG=="),
      ...f.text(1, "answer"),
      f.end("end_turn"),
      f.stop(),
    ]);
    const chunks = await collect(make({ fetch: t.fetch }).stream(HI));
    expect(chunks.map((c) => c.delta)).toEqual(["answer", ""]);
    expect(chunks.flatMap((c) => (c.reasoningDelta === undefined ? [] : [c.reasoningDelta]))).toEqual(["Let me ", "think"]);
    const last = chunks.at(-1);
    expect(last?.reasoning).toEqual([{ kind: "summary", text: "Let me think", signature: "SIG==", provider: A }]);
    expect(last?.layout).toBeUndefined();
    expect(allReleased(t)).toBe(true);
  });

  it("streams text that arrives with the block start, and sends nothing for an empty thinking block", async () => {
    const t = sseFetch([
      f.start(),
      f.open(0, { type: "thinking", thinking: "first " }),
      f.delta(0, { type: "thinking_delta", thinking: "second" }),
      f.delta(0, { type: "signature_delta", signature: "S1" }),
      f.close(0),
      f.open(1, { type: "thinking", thinking: "" }),
      f.delta(1, { type: "signature_delta", signature: "S2" }),
      f.close(1),
      ...f.text(2, "a"),
      f.end("end_turn"),
      f.stop(),
    ]);
    const chunks = await collect(make({ fetch: t.fetch }).stream(HI));
    expect(chunks.flatMap((c) => (c.reasoningDelta === undefined ? [] : [c.reasoningDelta]))).toEqual(["first ", "second"]);
    expect(chunks.at(-1)?.reasoning).toEqual([
      { kind: "summary", text: "first second", signature: "S1", provider: A },
      { kind: "text", text: "", signature: "S2", provider: A },
    ]);
  });

  it("reports a redacted block with no delta and its data as the signature", async () => {
    const t = sseFetch([
      f.start(),
      f.open(0, { type: "redacted_thinking", data: "ENC" }),
      f.close(0),
      ...f.text(1, "a"),
      f.end("end_turn"),
      f.stop(),
    ]);
    const chunks = await collect(make({ fetch: t.fetch }).stream(HI));
    expect(chunks.some((c) => c.reasoningDelta !== undefined)).toBe(false);
    expect(chunks.at(-1)?.reasoning).toEqual([{ kind: "redacted", signature: "ENC", provider: A }]);
  });

  it("gives the observer usage detail before the terminal chunk", async () => {
    const rec = recordingObserver();
    const t = sseFetch([
      f.start({ input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }),
      ...f.text(0, "a"),
      f.end("end_turn"),
      f.stop(),
    ]);
    let seen = -1;
    for await (const c of make({ fetch: t.fetch, observer: () => rec.observer }).stream(HI)) {
      if (c.done) seen = rec.log.length;
    }
    expect(rec.usage).toEqual([{ inputTokens: 5, outputTokens: 7, cacheReadTokens: 100, cacheWriteTokens: 20 }]);
    expect(seen).toBe(1);
  });
});

describe("complete() and stream() report the same reasoning and layout (parity, ADR 0133 D2)", () => {
  let fake: FakeAnthropic;
  beforeAll(async () => {
    fake = await startFakeAnthropic();
  });
  afterAll(async () => {
    await fake?.close();
  });
  const SCRIPTS = {
    canonical: [
      { thinking: "Considering." },
      { signature: "S1" },
      { text: "ok" },
      { stop: "end_turn" as const },
    ],
    interleaved: [
      { thinking: "a" },
      { signature: "S1" },
      { toolUse: { id: "toolu_1", name: "search_docs", input: { query: "x" } } },
      { thinking: "b" },
      { signature: "S2" },
      { toolUse: { id: "toolu_2", name: "related", input: {} } },
      { stop: "tool_use" as const },
    ],
    textAfterCall: [
      { thinking: "a" },
      { signature: "S1" },
      { text: "ab" },
      { toolUse: { id: "toolu_1", name: "search_docs", input: {} } },
      { text: "c" },
      { stop: "tool_use" as const },
    ],
  };
  for (const [name, steps] of Object.entries(SCRIPTS)) {
    it(`${name}: the streamed result equals the completed one, and the deltas equal the readable text`, async () => {
      fake.reply(() => ({ stream: { steps } }));
      const p = make({ baseUrl: fake.url });
      const completed = await p.complete(HI);
      const chunks = await collect(p.stream(HI));
      expect(assembleStream(chunks)).toEqual(completed);
      expect(completed.reasoning?.length).toBeGreaterThan(0);
      const readable = (completed.reasoning ?? []).map((r) => r.text ?? "").join("");
      expect(chunks.map((c) => c.reasoningDelta ?? "").join("")).toBe(readable);
    });
  }
});

describe("capabilities", () => {
  it("declares reasoning only when thinking is on, and keeps the media types", () => {
    expect(make().capabilities.reasoning).toBe(true);
    expect(make({ thinking: false }).capabilities.reasoning).toBeUndefined();
    expect(make().capabilities.file).toEqual(["application/pdf"]);
    expect(make().capabilities.image).toContain("image/png");
  });
});
```

Then edit the existing tests:

1. `provider.test.ts`, `describe("complete(): tool calls, reasoning blocks, usage detail and refusal")`: delete the three cases "gives the observer thinking, usage detail ... and the blocks, in that order...", "hands the full ordered blocks to onBlocks...", "keeps an interleaved thinking, tool_use, thinking, tool_use response in order" (the new file covers them); in "reports a refusal to the observer in report mode ..." delete the line `expect(rec.blocks).toEqual([]);` and rename the case "...no tool calls". Remove now-unused imports.
2. `provider.stream.test.ts`: delete the four cases of `describe("stream(): thinking, reasoning blocks and usage detail")` and the describe; in the refusal case "in report mode gives the observer the details..." replace `expect(rec.blocks).toEqual([]);` with
   ```ts
    // thinking streamed before the refusal was known stays streamed; the terminal chunk carries none of it
    expect(chunks.some((c) => c.reasoningDelta === "S" || c.reasoningDelta === "t")).toBe(true);
   ```
   (the frame in that test is `f.thinking(1, ["t"], "S")`, so only `"t"` can match; keep the `||` out if lint complains: use `c.reasoningDelta === "t"`).
3. `conformance.test.ts`: in the last `describe`, replace the third case ("reports the same usage detail, thinking text and reasoning blocks from both") with:
   ```ts
  it("reports the same usage detail, reasoning and layout from both", async () => {
    own.reply(() => ({
      stream: {
        steps: [
          { thinking: "hm" },
          { signature: "S1" },
          { text: "t" },
          { toolUse: CALL },
          { stop: "tool_use" },
        ],
        usage: { cacheReadTokens: 40, cacheWriteTokens: 8 },
      },
    }));
    const a = recordingObserver();
    const b = recordingObserver();
    const opts = { thinking: true } as const;
    const completed = await make({ ...opts, observer: () => a.observer }, own.url).complete(HI);
    const streamed = assembleStream(
      await chunksOf(make({ ...opts, observer: () => b.observer }, own.url).stream(HI)),
    );
    expect(streamed).toEqual(completed);
    expect(completed.toolCalls).toEqual([CALL]);
    expect(completed.reasoning).toEqual([
      { kind: "summary", text: "hm", signature: "S1", provider: "anthropic" },
    ]);
    expect(completed.layout).toBeUndefined(); // thinking, text, tool_use is the canonical order
    expect(a.usage).toEqual([{ inputTokens: 3, outputTokens: 1, cacheReadTokens: 40, cacheWriteTokens: 8 }]);
    expect(b.usage).toEqual(a.usage);
  });
   ```
   and add, after the two `runLlmProviderConformance(...)` calls at the top level:
   ```ts
// Loom's reasoning parity rule (ADR 0133 D2) runs inside the thinking configuration above only if that
// configuration really reports reasoning: prove the run is not vacuous.
describe("the thinking configuration reports reasoning, so the parity rule has something to check", () => {
  it("returns the summary with its signature and no layout", async () => {
    const done = await make({ thinking: true }).complete({ messages: [{ role: "user", content: "hi" }] });
    expect(done.reasoning).toEqual([
      { kind: "summary", text: "Considering.", signature: "fake-signature", provider: "anthropic" },
    ]);
    expect(done.layout).toBeUndefined();
  });
});
   ```
4. `realApi.test.ts`: replace the tool-loop test (the one with `recordingObserver`, whose `rec.asked` no longer exists) with the version in Step 9.

5. `apps/server/app/chats/observer.test.ts` (rewritten in 159b): inside `describe("chatObserver with the real provider and FakeAnthropic")` add

```ts
  it("a thinking answer stores no item: reasoning is Loom's, not the observer's", async () => {
    fake.reply(() => ({
      stream: { steps: [{ thinking: "Weighing it." }, { signature: "sig-1" }, { text: "Done." }, { stop: "end_turn" }] },
    }));
    const chunks = await drain([{ role: "user", content: "q" }]);
    expect(chunks.map((c) => c.delta).join("")).toBe("Done.");
    expect(chunks.at(-1)?.reasoning).toEqual([
      { kind: "summary", text: "Weighing it.", signature: "sig-1", provider: "anthropic" },
    ]);
    expect(items.puts).toEqual([]);
  });
```

- [ ] **Step 2: Run, see them fail.** `pnpm --filter @docmind/llm-anthropic exec vitest run`. Expected: FAIL (no `reasoning` on responses, no `reasoningDelta`, `capabilities.reasoning` undefined).

- [ ] **Step 3: Implement `mapping.ts`.** Replace its import line and the block type, and return `ContentBlock`:

```ts
import { LlmRequestError } from "./errors";
import type { LlmUsageDetail, RefusalDetails } from "./observer";

/** A validated content block of a response (text, tool_use, thinking or redacted_thinking), as the API sent it. */
export interface ContentBlock {
  type: string;
  [k: string]: unknown;
}
```

and in `toContentBlock` change the signature to `(b: Record<string, unknown>): ContentBlock | undefined` (the body is unchanged). Delete the `import type { ..., ReasoningBlock, ... }` use.

- [ ] **Step 4: Implement `response.ts`.** Replace the file:

```ts
import { LlmRequestError } from "./errors";
import {
  type ContentBlock,
  type UsageFields,
  isCount,
  obj,
  toContentBlock,
  usageFieldsOf,
} from "./mapping";

export interface Parsed {
  /** The response's content blocks (thinking, redacted_thinking, non-empty text, tool_use), verbatim, in the order the API returned them. */
  blocks: ContentBlock[];
  stopReason: string;
  stopDetails: unknown;
  usage?: UsageFields;
}

const optionalCount = (v: unknown): boolean => v === undefined || v === null || isCount(v);

/** Validates the response by hand. Never puts the text in an error. */
export function parseResponse(raw: string): Parsed {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new LlmRequestError();
  }
  const o = obj(json);
  if (!o) throw new LlmRequestError();
  const { content, stop_reason: stop, stop_details: stopDetails, usage } = o;
  if (!Array.isArray(content) || typeof stop !== "string") throw new LlmRequestError();
  const out: Parsed = { blocks: [], stopReason: stop, stopDetails };
  for (const item of content) {
    const b = obj(item);
    if (!b || typeof b.type !== "string") throw new LlmRequestError();
    const block = toContentBlock(b);
    if (block) out.blocks.push(block); // an empty text block or an unknown type (server tools) is ignored
  }
  if (usage !== undefined) {
    const u = obj(usage);
    if (
      !u ||
      !isCount(u.input_tokens) ||
      !isCount(u.output_tokens) ||
      !optionalCount(u.cache_read_input_tokens) ||
      !optionalCount(u.cache_creation_input_tokens)
    ) {
      throw new LlmRequestError();
    }
    out.usage = usageFieldsOf(u);
  }
  return out;
}
```

- [ ] **Step 5: Implement the response half of `reasoning.ts`.** Add to the file (keep the 159a exports; extend the import to `import type { LlmContentPart, LlmLayoutEntry, LlmReasoning, LlmReasoningPart, LlmToolCall } from "@loom/llm"; import { layoutOf } from "@loom/llm"; import type { ContentBlock } from "./mapping";`):

```ts
/**
 * ADR 0133 D2, ONE rule shared by complete() and stream(): a non-empty `thinking` text is a `summary` (current
 * models return only summaries), an empty one is `text` with `text: ""` (an omitted-display block: the signature
 * carries it), and `redacted_thinking` is `redacted` with its `data` as the signature.
 */
export function reasoningOf(block: ContentBlock): LlmReasoning | undefined {
  if (block.type === "redacted_thinking") {
    return {
      kind: "redacted",
      ...(typeof block.data === "string" && { signature: block.data }),
      provider: PROVIDER_ID,
    };
  }
  if (block.type !== "thinking") return undefined;
  const text = typeof block.thinking === "string" ? block.thinking : "";
  return {
    kind: text === "" ? "text" : "summary",
    text,
    ...(typeof block.signature === "string" && { signature: block.signature }),
    provider: PROVIDER_ID,
  };
}

export interface Outcome {
  content: string;
  toolCalls: LlmToolCall[];
  reasoning?: LlmReasoning[];
  layout?: LlmLayoutEntry[];
}

/**
 * The text, tool calls, reasoning and block order of a response's validated blocks, in the order the API sent
 * them. `layout` is present only when there is reasoning and the order is not canonical (`layoutOf`), so a
 * response without thinking has exactly today's shape (Loom G2).
 */
export function outcomeOf(blocks: readonly ContentBlock[]): Outcome {
  let content = "";
  const toolCalls: LlmToolCall[] = [];
  const reasoning: LlmReasoning[] = [];
  const entries: LlmLayoutEntry[] = [];
  for (const b of blocks) {
    if (b.type === "text") {
      const text = b.text as string;
      content += text;
      entries.push({ text: text.length });
    } else if (b.type === "tool_use") {
      const id = b.id as string;
      toolCalls.push({ id, name: b.name as string, input: b.input });
      entries.push({ call: id });
    } else {
      const r = reasoningOf(b);
      if (r !== undefined) {
        reasoning.push(r);
        entries.push("reasoning");
      }
    }
  }
  const layout = layoutOf(entries);
  return {
    content,
    toolCalls,
    ...(reasoning.length > 0 && { reasoning }),
    ...(layout !== undefined && { layout }),
  };
}

/** A refused response ends the turn with its text only: no tool calls, no reasoning, no layout. */
export function refusedOutcomeOf(blocks: readonly ContentBlock[]): Outcome {
  return {
    content: blocks.map((b) => (b.type === "text" ? (b.text as string) : "")).join(""),
    toolCalls: [],
  };
}
```

(`LlmContentPart` and `LlmReasoningPart` stay imported for `wireBlockOf` and `usableReasoning`.)

- [ ] **Step 6: `streamState.ts`.** Replace the file:

```ts
import type { LlmStreamChunk } from "@loom/llm";
import { LlmRequestError, LlmStreamError } from "./errors";
import {
  type ContentBlock,
  type StopReason,
  type UsageFields,
  mapStopReason,
  obj,
  refusalDetailsOf,
  toContentBlock,
  usageDetail,
  usageFieldsOf,
} from "./mapping";
import type { LlmUsageDetail, RefusalDetails } from "./observer";

type Open =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; json: string }
  | { kind: "thinking"; thinking: string; signature: string }
  | { kind: "redacted"; data: string }
  | { kind: "ignored" };

export interface StreamEnd {
  stopReason: StopReason;
  /** Set when the API stopped with `refusal`: the caller then ignores `blocks` except their text. */
  refused?: RefusalDetails;
  /** The response's content blocks (thinking, redacted_thinking, text, tool_use) in the order the API produced them. */
  blocks: ContentBlock[];
  usage?: { inputTokens: number; outputTokens: number };
  detail: LlmUsageDetail;
}

/** `error` event types that blame the request: permanent. Everything else is transient. */
const PERMANENT = new Set([
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "not_found_error",
  "request_too_large",
]);

function parseInput(json: string): unknown {
  if (json === "") return {}; // an empty argument object streams as no deltas at all
  try {
    return JSON.parse(json);
  } catch {
    return { __unparsedArguments: json }; // keep it: the agent loop must see why the call failed
  }
}

/**
 * The stream's state machine. `feed` takes one SSE event and returns the chunks it produces (text deltas,
 * tool deltas and `reasoningDelta`s, ADR 0133 D6); `end` is valid once `stopped` (a `message_stop` arrived). It
 * throws only typed errors with fixed messages: nothing of an event's text reaches an error.
 */
export class StreamState {
  readonly #open = new Map<number, Open>();
  readonly #blocks = new Map<number, ContentBlock>();
  readonly #seen = new Set<number>();
  #usage: UsageFields = {};
  #stop: unknown;
  #details: unknown;
  stopped = false;

  /** Stores a finished block after the shared validation (same rules as complete()). */
  #keep(index: number, raw: Record<string, unknown>): void {
    const block = toContentBlock(raw);
    if (block) this.#blocks.set(index, block);
  }

  feed(event: string, data: string): LlmStreamChunk[] {
    if (event === "ping") return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new LlmRequestError();
    }
    const o = obj(parsed);
    if (!o) throw new LlmRequestError();
    const type = typeof o.type === "string" ? o.type : event;
    const index = Number.isInteger(o.index) ? (o.index as number) : -1;
    switch (type) {
      case "message_start":
        this.#usage = { ...this.#usage, ...usageFieldsOf(obj(o.message)?.usage) };
        return [];
      case "content_block_start": {
        const b = obj(o.content_block);
        if (!b || index < 0 || this.#seen.has(index)) throw new LlmRequestError();
        this.#seen.add(index);
        if (b.type === "text") {
          const first = typeof b.text === "string" ? b.text : "";
          this.#open.set(index, { kind: "text", text: first });
          return first !== "" ? [{ delta: first, done: false }] : [];
        }
        if (b.type === "tool_use") {
          if (typeof b.id !== "string" || typeof b.name !== "string") throw new LlmRequestError();
          this.#open.set(index, { kind: "tool", id: b.id, name: b.name, json: "" });
          return [
            { delta: "", done: false, toolDelta: { id: b.id, name: b.name, inputDelta: "" } },
          ];
        }
        if (b.type === "thinking") {
          const thinking = typeof b.thinking === "string" ? b.thinking : "";
          const signature = typeof b.signature === "string" ? b.signature : "";
          this.#open.set(index, { kind: "thinking", thinking, signature });
          return thinking !== "" ? [{ delta: "", done: false, reasoningDelta: thinking }] : [];
        }
        if (b.type === "redacted_thinking") {
          if (typeof b.data !== "string") throw new LlmRequestError();
          this.#open.set(index, { kind: "redacted", data: b.data });
          return [];
        }
        this.#open.set(index, { kind: "ignored" });
        return [];
      }
      case "content_block_delta": {
        const open = this.#open.get(index);
        const d = obj(o.delta);
        if (!open || !d) return [];
        if (open.kind === "text" && d.type === "text_delta" && typeof d.text === "string") {
          open.text += d.text;
          return d.text === "" ? [] : [{ delta: d.text, done: false }];
        }
        if (
          open.kind === "tool" &&
          d.type === "input_json_delta" &&
          typeof d.partial_json === "string"
        ) {
          if (d.partial_json === "") return [];
          open.json += d.partial_json;
          return [
            { delta: "", done: false, toolDelta: { id: open.id, inputDelta: d.partial_json } },
          ];
        }
        if (
          open.kind === "thinking" &&
          d.type === "thinking_delta" &&
          typeof d.thinking === "string"
        ) {
          open.thinking += d.thinking;
          return d.thinking === "" ? [] : [{ delta: "", done: false, reasoningDelta: d.thinking }];
        }
        if (
          open.kind === "thinking" &&
          d.type === "signature_delta" &&
          typeof d.signature === "string"
        ) {
          open.signature += d.signature;
          return [];
        }
        return [];
      }
      case "content_block_stop": {
        const open = this.#open.get(index);
        this.#open.delete(index);
        if (open?.kind === "text" && open.text !== "") {
          this.#keep(index, { type: "text", text: open.text });
        }
        if (open?.kind === "tool") {
          this.#keep(index, {
            type: "tool_use",
            id: open.id,
            name: open.name,
            input: parseInput(open.json),
          });
        }
        if (open?.kind === "redacted") {
          this.#keep(index, { type: "redacted_thinking", data: open.data });
        }
        if (open?.kind === "thinking") {
          this.#keep(index, {
            type: "thinking",
            thinking: open.thinking,
            signature: open.signature,
          });
        }
        return [];
      }
      case "message_delta": {
        const d = obj(o.delta);
        if (typeof d?.stop_reason === "string") {
          this.#stop = d.stop_reason;
          this.#details = d.stop_details;
        }
        this.#usage = { ...this.#usage, ...usageFieldsOf(o.usage) };
        return [];
      }
      case "message_stop":
        this.stopped = true;
        return [];
      case "error":
        // The event's message is the model's or the platform's text: never read into an error.
        throw PERMANENT.has(String(obj(o.error)?.type))
          ? new LlmRequestError()
          : new LlmStreamError();
      default:
        return []; // unknown events are ignored: the API adds them over time
    }
  }

  /** A stream that ended without `message_stop` and a stop reason is truncated: transient. */
  end(): StreamEnd {
    if (!this.stopped || typeof this.#stop !== "string") throw new LlmStreamError();
    if (this.#open.size > 0) throw new LlmRequestError(); // a block never stopped
    const blocks = [...this.#blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
    const refused = this.#stop === "refusal" ? refusalDetailsOf(this.#details) : undefined;
    const u = this.#usage;
    return {
      stopReason: mapStopReason(this.#stop),
      ...(refused !== undefined && { refused }),
      blocks,
      ...(u.input !== undefined &&
        u.output !== undefined && { usage: { inputTokens: u.input, outputTokens: u.output } }),
      detail: usageDetail(u),
    };
  }
}
```

- [ ] **Step 7: `observer.ts`, `index.ts`, `provider.ts`.** Replace `observer.ts` with:

```ts
export interface LlmUsageDetail {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** From the API's `stop_details`. The model's own words: the app seals them, nothing logs them. */
export interface RefusalDetails {
  category?: string;
  explanation?: string;
}

/**
 * Per-request hooks (M4 D3, after the ADR 0133 amendment). The app builds one per model call from its call
 * scope; the provider never stores one. Reasoning is NOT here any more: it travels in `LlmResponse.reasoning`,
 * `layout` and `reasoningDelta`, and Loom captures it. What remains is what Loom's response type cannot carry:
 * a refusal (`stopReason` has no `refusal`) and token usage with cache detail.
 */
export interface CallObserver {
  onRefusal(details: RefusalDetails): Promise<void>;
  onUsage(usage: LlmUsageDetail): void;
}
```

`index.ts`: delete the lines exporting `isReasoningBlock` and `ReasoningBlock`; the observer export line becomes `export type { CallObserver, LlmUsageDetail, RefusalDetails } from "./observer";`. Keep `toMessagesBody`, `AnthropicBody`, `BodyOptions`, `Effort`, `EFFORTS`, `readSse`.

In `provider.ts`:

1. Imports:
```ts
import type { LlmCapabilities, LlmProvider, LlmRequest, LlmResponse, LlmStreamChunk } from "@loom/llm";
...
import type { CallObserver } from "./observer";
import { outcomeOf, refusedOutcomeOf } from "./reasoning";
```
(remove the `ReasoningBlock` import if still present.)
2. Replace the `capabilities` field and set it in the constructor:

```ts
  /** `reasoning` only when thinking is on: ingest providers have it off, so Loom's boot warning never names them. */
  readonly capabilities: LlmCapabilities;
```
and, in the constructor after `this.o = o;`:
```ts
    this.capabilities = {
      image: ["image/jpeg", "image/png", "image/gif", "image/webp"],
      file: ["application/pdf"],
      ...(o.thinking === true && { reasoning: true }),
    };
```
3. Replace `complete()` and `stream()`:

```ts
  async complete(request: LlmRequest): Promise<LlmResponse> {
    const observer = this.o.observer?.();
    const body = this.#body(request, false);
    const { res, timeout } = await this.#open(request, body);
    try {
      const text = await readCapped(res, this.o.maxResponseBytes ?? DEFAULT_MAX_RESPONSE);
      const parsed = parseResponse(text);
      const refused = parsed.stopReason === "refusal";
      if (parsed.usage) observer?.onUsage(usageDetail(parsed.usage));
      if (refused) {
        if (this.o.refusal !== "report" || !observer) throw new LlmRefusalError();
        await observer.onRefusal(refusalDetailsOf(parsed.stopDetails));
      }
      const out = refused ? refusedOutcomeOf(parsed.blocks) : outcomeOf(parsed.blocks);
      return {
        content: out.content,
        ...(out.toolCalls.length > 0 && { toolCalls: out.toolCalls }),
        stopReason: mapStopReason(parsed.stopReason),
        ...(parsed.usage && {
          usage: { inputTokens: parsed.usage.input ?? 0, outputTokens: parsed.usage.output ?? 0 },
        }),
        ...(out.reasoning && { reasoning: out.reasoning }),
        ...(out.layout && { layout: out.layout }),
      };
    } catch (err) {
      if (request.signal?.aborted) throw new LlmAbortedError();
      if (timeout.aborted) throw new LlmUnavailableError();
      throw err;
    } finally {
      await res.body?.cancel().catch(() => {}); // release the socket on every path
    }
  }

  async *stream(request: LlmRequest): AsyncIterable<LlmStreamChunk> {
    const observer = this.o.observer?.();
    const body = this.#body(request, true);
    const { res, signal, timeout } = await this.#open(request, body);
    const state = new StreamState();
    const max = this.o.maxStreamBytes ?? DEFAULT_MAX_STREAM;
    try {
      if (!res.body) throw new LlmRequestError();
      const caps = { maxEventBytes: Math.min(max, MAX_EVENT), maxTotalBytes: max };
      for await (const ev of readSse(res.body, caps, signal)) {
        for (const chunk of state.feed(ev.event, ev.data)) yield chunk;
        if (state.stopped) break;
      }
      const end = state.end();
      if (end.usage !== undefined) observer?.onUsage(end.detail);
      if (end.refused !== undefined) {
        if (this.o.refusal !== "report" || !observer) throw new LlmRefusalError();
        await observer.onRefusal(end.refused);
      }
      // Reasoning deltas streamed before a refusal was known stay streamed; the terminal chunk carries none.
      const out = end.refused !== undefined ? refusedOutcomeOf(end.blocks) : outcomeOf(end.blocks);
      yield {
        delta: "",
        done: true,
        ...(out.toolCalls.length > 0 && { toolCalls: out.toolCalls }),
        stopReason: end.stopReason,
        ...(end.usage && { usage: end.usage }),
        ...(out.reasoning && { reasoning: out.reasoning }),
        ...(out.layout && { layout: out.layout }),
      };
    } catch (err) {
      if (request.signal?.aborted) throw new LlmAbortedError();
      if (timeout.aborted) throw new LlmStreamError();
      throw err;
    } finally {
      await res.body?.cancel().catch(() => {}); // a locked body rejects: readSse already cancelled it
    }
  }
```

In `provider.ts` the doc comment of `AnthropicOptions.observer` becomes "Called once per request: refusal and usage. Ingest passes none." and of `thinking`: "Adaptive thinking with summarized display; Loom captures it (ADR 0133). Never sends `temperature`. Default false."

Replace `__helpers__/observer.ts` with:

```ts
import type { CallObserver, LlmUsageDetail, RefusalDetails } from "../observer";

/** A CallObserver that records every call, in order. */
export function recordingObserver() {
  const log: string[] = [];
  const refusals: RefusalDetails[] = [];
  const usage: LlmUsageDetail[] = [];
  const observer: CallObserver = {
    async onRefusal(details) {
      refusals.push(details);
      log.push("refusal");
    },
    onUsage(u) {
      usage.push(u);
      log.push("usage");
    },
  };
  return { observer, log, refusals, usage };
}
```

- [ ] **Step 8: Run.**

```bash
pnpm --filter @docmind/llm-anthropic exec vitest run
pnpm --filter @docmind/llm-anthropic build && pnpm --filter @docmind/llm-anthropic typecheck && pnpm --filter @docmind/llm-anthropic typecheck:tests
```

Expected: green; Loom's reasoning parity rule runs inside the thinking conformance and passes. Then `pnpm build && pnpm typecheck && pnpm typecheck:tests` at the root and `pnpm --filter @docmind/server exec vitest run app/chats/observer.test.ts` (the new thinking case there).

- [ ] **Step 9: Opt-in real-API check, and the fallback probe.** Replace the tool-loop test in `realApi.test.ts` (add `assistantMessageOf` and `LlmReasoningPart` to the `@loom/llm` imports):

```ts
  it("runs a tool loop with adaptive thinking, effort and caching: the API accepts the reasoning parts sent back", async () => {
    const rec = recordingObserver();
    const p = make({ thinking: true, effort: "low", cache: true, observer: () => rec.observer });
    const first: LlmRequest = {
      system: "Use the get_weather tool when asked about the weather.",
      messages: [{ role: "user", content: "What is the weather in Paris? Use the tool." }],
      tools: [
        {
          name: "get_weather",
          description: "Current weather for a city",
          inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      ],
    };
    const firstChunks = await collect(p.stream(first));
    const end = firstChunks.at(-1);
    const calls = end?.toolCalls ?? [];
    expect(end?.stopReason).toBe("tool_use");
    expect(calls.length).toBeGreaterThan(0);
    // What Loom's loop records and sends back: the reasoning as parts (text resolved from the store), in vendor order.
    const recorded: LlmReasoningPart[] = (end?.reasoning ?? []).map((r) => ({
      type: "reasoning",
      kind: r.kind,
      provider: r.provider,
      ...(r.signature !== undefined && { signature: r.signature }),
      ...(r.text !== undefined && r.text !== "" && { text: r.text }),
    }));
    const assistant = assistantMessageOf({
      content: firstChunks.map((c) => c.delta).join(""),
      toolCalls: calls,
      reasoning: recorded,
      ...(end?.layout && { layout: end.layout }),
    });
    const toolResults = {
      role: "user" as const,
      content: calls.map((c) => ({ type: "tool_result" as const, toolUseId: c.id, content: "18 C and sunny" })),
    };
    const second: LlmRequest = { ...first, messages: [...first.messages, assistant, toolResults] };
    const secondChunks = await collect(p.stream(second));
    expect(secondChunks.at(-1)?.stopReason).toBe("end_turn");
    expect(secondChunks.map((c) => c.delta).join("").length).toBeGreaterThan(0);
    expect(rec.usage.length).toBe(2);
  });

  it("FALLBACK PROBE: a tool-loop continuation with the thinking blocks dropped (what Loom's drop rule sends) is accepted", async () => {
    const p = make({ thinking: true, effort: "low" });
    const first: LlmRequest = {
      messages: [{ role: "user", content: "What is the weather in Paris? Use the tool." }],
      tools: [
        {
          name: "get_weather",
          description: "Current weather for a city",
          inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      ],
    };
    const calls = (await collect(p.stream(first))).at(-1)?.toolCalls ?? [];
    expect(calls.length).toBeGreaterThan(0);
    const second: LlmRequest = {
      ...first,
      messages: [
        ...first.messages,
        { role: "assistant", content: calls.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.input })) },
        { role: "user", content: calls.map((c) => ({ type: "tool_result" as const, toolUseId: c.id, content: "18 C" })) },
      ],
    };
    expect((await collect(p.stream(second))).at(-1)?.done).toBe(true);
  });
```

Probe (owner or an executor with a key; the key is never printed): `DOCMIND_TEST_ANTHROPIC_KEY=<key> pnpm --filter @docmind/llm-anthropic exec vitest run src/realApi.test.ts`. Expected: both pass. **If the fallback probe fails with a 400 (`LlmRequestError(400)`)**, a continuation that lost its thinking blocks is refused by the live API on this model, and Loom's drop rule (an unresolvable part, a tool-set change, compaction) would then fail the turn. Fallback, in `toMessagesBody`: when `options.thinking === true` and the LAST assistant message that has a `tool_use` has no thinking block after `usableReasoning`, omit the request's `thinking` and `output_config` fields (a request without thinking may carry any history). Add that rule with a test in `request.test.ts` ("omits thinking when the last tool-use turn lost its thinking block") and note it in the PR. Without a key this stays an open risk (A11), recorded in the PR body.

- [ ] **Step 10: Run the gate. Commit** with `feat(llm-anthropic): return reasoning, layout and reasoningDelta; shrink CallObserver (Loom ADR 0133)`. Open the stacked draft PR (about 350 lines, mostly tests: say so in the PR body).

---

### Task 160: remove the app-side thinking

After Task 159 the provider never calls `onThinking`, `onBlocks` or `blocksFor`, and `chatObserver` is already `onRefusal` and `onUsage` only (159b). What is left to remove is dead code and its storage. Split seam: **160a** removes the consumers (bus partials, `blocks` collaborator, the retried-attempt cleanup that named `thinking`); **160b** removes the class, the table and the item kind.

**Consumers to remove (the grep that drives both parts, run it before and after):**

```bash
grep -rn --include='*.ts' -E "FakeBlocks|PgReasoningBlocks|chatBlocksBind|MAX_TOOL_USE_IDS|\.blocks\b|blocks:|kind: \"thinking\"|bus\.(end|partial)|maxThinkingChars|maxChats|chat_reasoning_blocks" apps packages --exclude-dir=node_modules --exclude-dir=dist
```

Expected after 160b: no match outside `docs/` and `.superpowers/`.

#### Task 160a: bus, model effect, collaborators

**Files:**
- Modify: `apps/server/app/chats/bus.ts`, `bus.test.ts` (replaced), `model.ts`, `model.test.ts`, `wiring.ts`, `wiring.test.ts`, `testing.ts`, `testStack.ts`, `pgCollaborators.ts`, `llm.ts` (a comment), `eventLog.chat.test.ts` (one assertion)

**Interfaces:**
- Produces: `LiveChatEvent = { kind: "tool"; turnKey; step } | { kind: "reset"; turnKey }`; `ChatBus { publish; subscribe }` with `ChatBusOptions { maxSubscribersPerChat? }` (no `partial`, no `end`); `ChatCollaborators` without `blocks`; `chatModelEffect` unchanged in signature (its stale-row cleanup now removes the step's `outcome` item).

- [ ] **Step 1: Replace `bus.test.ts`** (the cases about thinking partials go; the rest stay):

```ts
import { describe, expect, it } from "vitest";
import { ChatBus, ChatBusLimitError, type LiveChatEvent } from "./bus";

const step = { name: "search_docs", label: "Searched documents", count: 2 } as const;
const collect = (bus: ChatBus, chat: string) => {
  const got: LiveChatEvent[] = [];
  const off = bus.subscribe(chat, (e) => got.push(e));
  return { got, off };
};

describe("ChatBus", () => {
  it("delivers a chat's events to its subscribers only, in order, until they unsubscribe", () => {
    const bus = new ChatBus();
    const a = collect(bus, "a");
    const b = collect(bus, "b");
    bus.publish("a", { kind: "tool", turnKey: 1, step });
    bus.publish("a", { kind: "reset", turnKey: 1 });
    a.off();
    bus.publish("a", { kind: "tool", turnKey: 2, step });
    expect(a.got.map((e) => e.kind)).toEqual(["tool", "reset"]);
    expect(b.got).toEqual([]);
  });

  it("isolates a throwing listener", () => {
    const bus = new ChatBus();
    bus.subscribe("a", () => {
      throw new RangeError("boom");
    });
    const ok = collect(bus, "a");
    expect(() => bus.publish("a", { kind: "reset", turnKey: 1 })).not.toThrow();
    expect(ok.got).toHaveLength(1);
  });

  it("keeps no history: a subscriber sees only what is published after it subscribed", () => {
    const bus = new ChatBus();
    bus.publish("a", { kind: "tool", turnKey: 1, step });
    const late = collect(bus, "a");
    expect(late.got).toEqual([]);
  });

  it("refuses a subscriber beyond the per-chat limit with a typed error", () => {
    const bus = new ChatBus({ maxSubscribersPerChat: 1 });
    const first = bus.subscribe("a", () => {});
    expect(() => bus.subscribe("a", () => {})).toThrow(ChatBusLimitError);
    first();
    expect(() => bus.subscribe("a", () => {})).not.toThrow();
  });
});
```

- [ ] **Step 2: (a deletion task has no red step) Run** `pnpm --filter @docmind/server exec vitest run app/chats/bus.test.ts`. It passes against the old bus too; the check that matters is Step 6, where every consumer of the removed API must still compile.

- [ ] **Step 3: Replace `bus.ts`:**

```ts
import type { ChatToolStep } from "@docmind/contracts";

export type LiveChatEvent =
  | { kind: "tool"; turnKey: number; step: ChatToolStep }
  | { kind: "reset"; turnKey: number };

export class ChatBusLimitError extends Error {
  constructor() {
    super("too many listeners for this chat");
    this.name = "ChatBusLimitError";
  }
}

export interface ChatBusOptions {
  /** Listeners per chat. Default 16. */
  maxSubscribersPerChat?: number;
}

/**
 * The in-process side channel for what Loom's hub does not carry: tool steps (D7). Reasoning is not here any
 * more: it travels on the hub's `reasoning` events (ADR 0133 D6). Live only and lossy by design: anything a late
 * or slow listener misses is in the durable turn items. Memory only: a crash loses it, and the recovered turn
 * sends `reset` (D16).
 */
export class ChatBus {
  private readonly subs = new Map<string, Set<(e: LiveChatEvent) => void>>();
  private readonly maxSubs: number;

  constructor(options: ChatBusOptions = {}) {
    this.maxSubs = options.maxSubscribersPerChat ?? 16;
  }

  publish(chatId: string, e: LiveChatEvent): void {
    for (const fn of [...(this.subs.get(chatId) ?? [])]) {
      try {
        fn(e);
      } catch {
        // a listener cannot hurt the turn
      }
    }
  }

  subscribe(chatId: string, fn: (e: LiveChatEvent) => void): () => void {
    let set = this.subs.get(chatId);
    if (!set) {
      set = new Set();
      this.subs.set(chatId, set);
    }
    if (set.size >= this.maxSubs) throw new ChatBusLimitError();
    set.add(fn);
    return () => {
      const cur = this.subs.get(chatId);
      cur?.delete(fn);
      if (cur?.size === 0) this.subs.delete(chatId);
    };
  }
}
```

- [ ] **Step 4: `model.ts`.** In `chatModelEffect`, replace the stale-row cleanup (the retried attempt's response replaces the earlier one):

```ts
        // The retried attempt's response replaces the earlier one: drop its stale outcome row (a refusal or a
        // max_tokens of the attempt before). Reasoning needs no cleanup: Loom keeps every attempt and marks the
        // recorded one.
        if (ctx.attempt > 1)
          await deps.items.remove(scope, scope.turnKey, scope.stepKey, "outcome");
```

In `model.test.ts` replace the case "a retried attempt drops the earlier attempt's thinking row, and keeps other frames' rows" with:

```ts
  it("a retried attempt drops the earlier attempt's outcome row of its own step, and keeps other frames' rows", async () => {
    const s = setup();
    await s.items.put({} as never, 3, "conv#o3#turn:1", { kind: "outcome", body: { kind: "max_tokens" } });
    await s.items.put({} as never, 3, "conv#o3#turn:0", { kind: "outcome", body: { kind: "max_tokens" } });
    await s.runtime.execute("chat-model", CALL, modelCtx({ attempt: 2 }));
    expect(s.items.puts.map((p) => p.stepKey)).toEqual(["conv#o3#turn:0"]);
  });
```

(`modelCtx()` is step `conv#o3#turn:1`, so that is the row that goes.) In the same file, `setup()` builds `new ChatBus()` and subscribes with `bus.subscribe(...)`: unchanged; the `ChatBus` import list stays.

- [ ] **Step 5: `wiring.ts`, `pgCollaborators.ts`, `testing.ts`, `testStack.ts`, `wiring.test.ts`.**
  - `wiring.ts`: delete `blocks: Pick<PgReasoningBlocks, "put" | "get">;` from `ChatCollaborators`, and change the turn-items import to `import type { PgTurnItems } from "./turnItems";`.
  - `pgCollaborators.ts`: delete `blocks: new PgReasoningBlocks(o.pool, o.fields),` and import only `PgTurnItems`.
  - `testing.ts`: delete the `FakeBlocks` class and the imports `ReasoningBlock` (from `@docmind/llm-anthropic`) and `PgReasoningBlocks`.
  - `testStack.ts`: delete `blocks: FakeBlocks;` from `ChatStack`, `const blocks = new FakeBlocks();`, `blocks,` in the collaborators and in the returned object, and the `FakeBlocks` import.
  - `wiring.test.ts`: delete `blocks: new FakeBlocks(),` and the `FakeBlocks` import.
  - `llm.ts`: the `ChatLlm.observer` comment becomes `/** Filled by prepareChat once the item store exists; read once per request. */`.
  - `eventLog.chat.test.ts`: replace the line `expect(JSON.stringify(stack.blocks.puts)).toContain(THINKING);` and its comment with `// The reasoning store and its assertions come back in Task 162 (the store does not exist yet).`; the `THINKING` constants stay (they are scanned for in the raw log).

- [ ] **Step 6: Run** `pnpm build && pnpm typecheck && pnpm typecheck:tests && pnpm --filter @docmind/server exec vitest run app/chats`. Expected: green except `turnItems.pg.test.ts`/`reasoningBlocks.pg.test.ts`, which still pass (the class exists until 160b).

- [ ] **Step 7: Run the gate. Commit** with `refactor(chats): reasoning is Loom's; the bus carries tool steps only`. Open the stacked draft PR.

#### Task 160b: the blocks store, its table and the thinking item kind

**Files:**
- Modify: `apps/server/app/chats/turnItems.ts`, `apps/server/app/chats/turnItems.pg.test.ts`, `infra/migrations/0023_chat_turn_items.sql`
- Delete: `apps/server/app/chats/reasoningBlocks.pg.test.ts`

**Interfaces:**
- Produces: `TurnItem` has kinds `tool`, `passages`, `outcome`; `PgTurnItems.put` refuses an unknown kind with `RangeError("turn item: unknown kind")`; no `PgReasoningBlocks`, `chatBlocksBind`, `MAX_TOOL_USE_IDS`.

- [ ] **Step 1: Edit `turnItems.pg.test.ts`.** The tests use `thinking(text)` as a carrier of a text body. An `outcome` item with `details.explanation` is the same carrier (a free string, same seal, same size caps). Replace the helper on line 47 and rename mechanically:

```ts
  const note = (text: string): TurnItem => ({
    kind: "outcome",
    body: { kind: "refusal", details: { explanation: text } },
  });
```

```bash
f=apps/server/app/chats/turnItems.pg.test.ts
sed -i '' -e 's/thinking(/note(/g' -e 's/"thinking"/"outcome"/g' "$f"
grep -n "thinking" "$f"
```

Expected: the `grep` prints nothing (the macOS `sed -i ''` form; on GNU sed use `-i`). Then add, inside `describe("PgTurnItems")`:

```ts
    it("refuses a kind it does not know, before it touches the table", async () => {
      await expect(
        items.put(chat, 1, "k", { kind: "thinking", body: { text: "x" } } as never),
      ).rejects.toThrow(/^turn item: unknown kind$/);
    });
```

Delete `reasoningBlocks.pg.test.ts` (`git rm`).

- [ ] **Step 2: Run, see them fail.** `pnpm --filter @docmind/server exec vitest run app/chats/turnItems.pg.test.ts` (with `DOCMIND_TEST_PG_URL` exported in the same command, never printed). Expected: the new "unknown kind" case FAILS (the old code still accepts `thinking` and throws a different error), the renamed cases pass.

- [ ] **Step 3: Implement `turnItems.ts`.**
  1. Delete the `thinking` variant from `TurnItem` and `thinking: z.object(...)` from `BODIES`.
  2. Delete everything from `/** A response's content blocks, opaque ...` to the end of the file (`BLOCKS`, `chatBlocksBind`, `MAX_TOOL_USE_IDS`, `validToolUseId`, `PgReasoningBlocks`).
  3. The import `import type { ReasoningBlock, RefusalDetails } from "@docmind/llm-anthropic";` becomes `import type { RefusalDetails } from "@docmind/llm-anthropic";`.
  4. At the top of `put`, before the turn-key check:

```ts
    if (!Object.hasOwn(BODIES, item.kind)) throw new RangeError("turn item: unknown kind");
```

  5. In the class doc comment replace "thinking, tool steps, retrieved passages and outcomes" with "tool steps, retrieved passages and outcomes".

- [ ] **Step 4: Edit `infra/migrations/0023_chat_turn_items.sql` in place (A7).** Replace the whole file with (the reasoning-texts table is added to this file in Task 161b):

```sql
-- What the conversation record cannot carry (M4 D5): tool steps, retrieved passages and outcomes of each turn,
-- keyed by the chat and the turn key (`ord` holds the turn key: the <o> of the step ids conv#o<o>#turn:<i>, not
-- MessageRecord.ord). Append-only and sealed (bind chatitem:<id>). `id` is derived from the natural key
-- (chatItemId in apps/server), so a retried attempt rewrites its own row under the same bind; `seq` keeps the
-- order rows were first written in. The model's reasoning is NOT here: Loom captures it (ADR 0133) into
-- chat_reasoning_texts below.
CREATE TABLE chat_turn_items (
  id uuid PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  chat_id uuid NOT NULL,
  ord integer NOT NULL CHECK (ord >= 0),
  kind text NOT NULL CONSTRAINT chat_turn_items_kind_check CHECK (kind IN ('tool', 'passages', 'outcome')),
  step_key text NOT NULL CONSTRAINT chat_turn_items_step_key_check CHECK (char_length(step_key) BETWEEN 1 AND 200),
  body_enc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_turn_items_chat_fkey FOREIGN KEY (tenant_id, user_id, chat_id)
    REFERENCES chat_sessions (tenant_id, user_id, id) ON DELETE CASCADE,
  CONSTRAINT chat_turn_items_natural_key UNIQUE (tenant_id, user_id, chat_id, ord, kind, step_key)
);
ALTER TABLE chat_turn_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chat_turn_items USING (tenant_id = app_tenant_id());
```

The file name stays `0023_chat_turn_items.sql` (renaming an applied-name migration would also fail the checksum check, and the name is still accurate). A database that applied the old file fails boot with `MigrationChecksumError`: recreate it (A7).

- [ ] **Step 5: Run the grep gate** at the top of Task 160 (expect no match), then `pnpm build && pnpm typecheck && pnpm typecheck:tests`, then the PG suite for the chats and the migration tests with `DOCMIND_TEST_PG_URL` exported in the same command (`pnpm --filter @docmind/server exec vitest run app/chats app/db`). Expected: green, including `db/tenancy.test.ts` ("row-level security on every table").

- [ ] **Step 6: Run the gate. Commit** with `refactor(chats): drop the reasoning-blocks store, its table and the thinking item kind`. Open the stacked draft PR.

---

### Task 161: the encrypting `ReasoningStore`

Loom's sealing of a reasoning blob (`{e: executionId, t: text}`) binds it to the capturing execution; it is not encryption, and a stock content store would keep reasoning in the clear. This task is DocMind's store: A3. Split seam: **161a** is the class over a rows port, with an in-memory port for tests; **161b** is the Postgres port and the table.

#### Task 161a: `ChatReasoningStore`

**Files:**
- Create: `apps/server/app/chats/reasoningStore.ts`
- Modify: `apps/server/app/chats/testing.ts` (`MemoryReasoningRows`)
- Test: `apps/server/app/chats/reasoningStore.test.ts`

**Interfaces:**
- Consumes: `FieldCrypto`, `FieldKeyUnavailableError` (`crypto/fields.ts`); `chatScope` (`scope.ts`); `chatIdOfConversation` (`ids.ts`); `ChatRef` (`turnItems.ts`); `@loom/llm` `ReasoningStore`, `ReasoningReader`.
- Produces:
  - `ReasoningScopeError` (fixed message `"no chat scope for this reasoning access"`), `MAX_REASONING_BYTES = 512 * 1024`, `chatReasoningBind(chatId, address)`.
  - `ReasoningRows { put(ref: ChatRef, address: string, sealed: unknown): Promise<void>; get(ref: ChatRef, address: string): Promise<unknown | null> }`.
  - `class ChatReasoningStore implements ReasoningStore { constructor(rows: ReasoningRows, fields: FieldCrypto, scope?: () => ChatRef | undefined /* default: chatScope.current */); put(bytes): Promise<{ __loomContent: string }>; get(ref): Promise<Uint8Array | null>; readerFor(ref: ChatRef): ReasoningReader }`.
  - `testing.ts`: `class MemoryReasoningRows implements ReasoningRows { readonly rows: Map<string, { ref: ChatRef; address: string; sealed: unknown }> }`.

- [ ] **Step 1: Write the failing tests** (`reasoningStore.test.ts`):

```ts
import { unwrapTainted } from "@loom/classify";
import {
  LLM_REASONING_CAPTURED,
  captureReasoning,
  readReasoningBounded,
  reasoningStoreResolver,
  sealReasoningText,
} from "@loom/llm";
import { InMemoryKeyStore, type KeyStore } from "@loom/plugin-crypto";
import { describe, expect, it } from "vitest";
import { FieldCrypto } from "../crypto/fields";
import { chatConversationId } from "./ids";
import { ChatReasoningStore, MAX_REASONING_BYTES, ReasoningScopeError } from "./reasoningStore";
import { type ChatCallScope, chatScope } from "./scope";
import { C, MemoryReasoningRows, T, U, modelCtx } from "./testing";

const C2 = "c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c4c4";
const U2 = "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2";
const EXEC = chatConversationId(U, C);
const SCOPE: ChatCallScope = {
  tenantId: T,
  userId: U,
  chatId: C,
  turnKey: 3,
  stepKey: "conv#o3#turn:1",
  attempt: 1,
};
const REF = { tenantId: T, userId: U, chatId: C };
const TEXT = "Weighing the Nocturne revenue forecast against the memo.";

function setup() {
  const keys = new InMemoryKeyStore();
  const asked = new Set<string>();
  const recording: KeyStore = {
    getOrCreate: (id) => {
      asked.add(id);
      return keys.getOrCreate(id);
    },
    get: (id) => {
      asked.add(id);
      return keys.get(id);
    },
    destroy: (id) => keys.destroy(id),
  };
  const rows = new MemoryReasoningRows();
  const store = new ChatReasoningStore(rows, new FieldCrypto(recording));
  const inScope = <T2>(fn: () => Promise<T2>, scope: ChatCallScope = SCOPE) => chatScope.run(scope, fn);
  return { keys, asked, rows, store, inScope };
}

describe("ChatReasoningStore", () => {
  it("seals the text under the owner's key, returns a random address, and gives the same bytes back", async () => {
    const s = setup();
    const bytes = sealReasoningText(TEXT, EXEC);
    const ref = await s.inScope(() => s.store.put(bytes));
    expect(ref.__loomContent).toMatch(/^[0-9a-f]{32}$/);
    const [row] = [...s.rows.rows.values()];
    expect((row?.sealed as { __loomEnc?: string }).__loomEnc).toBe("loom/aes-256-gcm");
    expect(JSON.stringify(row)).not.toContain("Nocturne"); // TEXT is longer than 12 characters
    expect(JSON.stringify(row)).not.toContain(EXEC);
    expect([...s.asked]).toEqual([U]);
    expect(await s.inScope(() => s.store.get(ref))).toEqual(bytes);
    expect(await s.store.readerFor(REF).get(ref)).toEqual(bytes); // a route needs no ALS
  });

  it("is not content-addressed: the same bytes stored twice get two addresses", async () => {
    const s = setup();
    const bytes = sealReasoningText(TEXT, EXEC);
    const a = await s.inScope(() => s.store.put(bytes));
    const b = await s.inScope(() => s.store.put(bytes));
    expect(a.__loomContent).not.toBe(b.__loomContent);
    expect(s.rows.rows.size).toBe(2);
  });

  it("refuses put and get outside a chat scope, with a fixed message", async () => {
    const s = setup();
    const bytes = sealReasoningText(TEXT, EXEC);
    await expect(s.store.put(bytes)).rejects.toBeInstanceOf(ReasoningScopeError);
    await expect(s.store.put(bytes)).rejects.toThrow(/^no chat scope for this reasoning access$/);
    await expect(s.store.get({ __loomContent: "a".repeat(32) })).rejects.toBeInstanceOf(
      ReasoningScopeError,
    );
    expect(s.rows.rows.size).toBe(0);
  });

  it("refuses bytes that are not the sealed envelope of THIS chat's execution", async () => {
    const s = setup();
    const enc = new TextEncoder();
    for (const bytes of [
      sealReasoningText(TEXT, chatConversationId(U, C2)), // another chat of the same owner
      sealReasoningText(TEXT, chatConversationId(U2, C)), // another owner
      sealReasoningText(TEXT, "u_a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1:ingest-x.1"), // not a conversation
      enc.encode("plain text, not an envelope"),
      enc.encode(JSON.stringify({ e: EXEC })),
    ]) {
      await expect(s.inScope(() => s.store.put(bytes))).rejects.toBeInstanceOf(ReasoningScopeError);
    }
    expect(s.rows.rows.size).toBe(0);
  });

  it("accepts a later generation of its own conversation", async () => {
    const s = setup();
    const ref = await s.inScope(() => s.store.put(sealReasoningText(TEXT, `${EXEC}~2`)));
    expect(ref.__loomContent).toMatch(/^[0-9a-f]{32}$/);
  });

  it("refuses a text over the cap and bytes that are not UTF-8", async () => {
    const s = setup();
    await expect(
      s.inScope(() => s.store.put(sealReasoningText("x".repeat(MAX_REASONING_BYTES), EXEC))),
    ).rejects.toThrow(/^reasoning text is too large$/);
    await expect(s.inScope(() => s.store.put(Uint8Array.of(0xff, 0xfe)))).rejects.toThrow(
      /^reasoning text is not valid UTF-8$/,
    );
  });

  it("reads null for an address that is malformed, unknown, or another chat's", async () => {
    const s = setup();
    const ref = await s.inScope(() => s.store.put(sealReasoningText(TEXT, EXEC)));
    expect(await s.inScope(() => s.store.get({ __loomContent: "../../etc/passwd" }))).toBeNull();
    expect(await s.inScope(() => s.store.get({ __loomContent: "0".repeat(32) }))).toBeNull();
    expect(await s.store.readerFor({ ...REF, chatId: C2 }).get(ref)).toBeNull();
    expect(await s.store.readerFor({ ...REF, userId: U2 }).get(ref)).toBeNull();
  });

  it("reads null once the owner's key is destroyed (erased), and rethrows any other failure", async () => {
    const s = setup();
    const ref = await s.inScope(() => s.store.put(sealReasoningText(TEXT, EXEC)));
    await s.keys.destroy(U);
    expect(await s.inScope(() => s.store.get(ref))).toBeNull();

    const boom = new RangeError("the table is down");
    const failing = new ChatReasoningStore(
      { put: async () => {}, get: async () => Promise.reject(boom) },
      new FieldCrypto(new InMemoryKeyStore()),
    );
    await expect(failing.readerFor(REF).get({ __loomContent: "a".repeat(32) })).rejects.toBe(boom);
  });
});

describe("ChatReasoningStore with Loom's capture, resolver and audit reader", () => {
  it("captures a summary, resolves it for continuation inside the call's scope, and reads it back as the owner", async () => {
    const s = setup();
    const log: { eventType: string; payload: unknown }[] = [];
    const ctx = modelCtx({ emit: (eventType, payload) => log.push({ eventType, payload }) });
    const parts = await s.inScope(() =>
      captureReasoning(
        [{ kind: "summary", text: TEXT, signature: "SIG-0123456789", provider: "anthropic" }],
        { store: s.store, model: "claude-opus-5-5" },
        ctx,
      ),
    );
    const part = parts[0];
    if (!part?.textRef) throw new Error("expected a stored text");
    expect(part.signature).toBe("SIG-0123456789");
    expect(log.map((e) => e.eventType)).toEqual([LLM_REASONING_CAPTURED]);
    expect(JSON.stringify(log)).not.toContain("Nocturne"); // the event names references, never text

    // continuation: Loom's default resolver, called while the call's scope is active
    const resolved = await s.inScope(() =>
      reasoningStoreResolver(s.store)(part.textRef as { address: string }, {
        executionId: ctx.executionId,
        stepId: ctx.stepId,
        origin: "reasoning",
        maxBytes: 1024 * 1024,
      }),
    );
    expect(new TextDecoder().decode(resolved ?? new Uint8Array())).toBe(TEXT);
    // a resolver call from another execution is "not yours"
    const foreign = await s.inScope(() =>
      reasoningStoreResolver(s.store)(part.textRef as { address: string }, {
        executionId: chatConversationId(U, C2),
        origin: "reasoning",
        maxBytes: 1024 * 1024,
      }),
    );
    expect(foreign).toBeNull();

    // the audit read (a route's): no ALS, a reader fixed to the owner's chat
    log.push({ eventType: "STEP_COMPLETED", payload: { stepId: ctx.stepId } });
    const read = await readReasoningBounded(
      { read: async () => log },
      s.store.readerFor(REF),
      { executionId: ctx.executionId, stepPrefix: "conv#o3#" },
    );
    const only = read.steps[0]?.attempts[0]?.parts[0];
    expect(only?.status).toBe("ok");
    expect(only?.text === undefined ? undefined : unwrapTainted(only.text)).toBe(TEXT);
    expect(read.steps[0]?.recordedAttempt).toBe(1);
  });
});
```

- [ ] **Step 2: Run, see it fail.** `pnpm --filter @docmind/server exec vitest run app/chats/reasoningStore.test.ts`. Expected: FAIL (module `./reasoningStore` and `MemoryReasoningRows` do not exist).

- [ ] **Step 3: `MemoryReasoningRows`.** Append to `testing.ts` (add `import type { ReasoningRows } from "./reasoningStore";`):

```ts
/** The reasoning rows port in memory: keyed like the table (tenant, owner, chat, address). */
export class MemoryReasoningRows implements ReasoningRows {
  readonly rows = new Map<string, { ref: ChatRef; address: string; sealed: unknown }>();
  private key(ref: ChatRef, address: string): string {
    return [ref.tenantId, ref.userId, ref.chatId, address].join("|");
  }
  async put(ref: ChatRef, address: string, sealed: unknown): Promise<void> {
    this.rows.set(this.key(ref, address), { ref: { ...ref }, address, sealed });
  }
  async get(ref: ChatRef, address: string): Promise<unknown | null> {
    return this.rows.get(this.key(ref, address))?.sealed ?? null;
  }
}
```

- [ ] **Step 4: Implement `reasoningStore.ts`:**

```ts
import { randomBytes } from "node:crypto";
import type { ReasoningReader, ReasoningStore } from "@loom/llm";
import { type FieldCrypto, FieldKeyUnavailableError } from "../crypto/fields";
import { chatIdOfConversation } from "./ids";
import { chatScope } from "./scope";
import type { ChatRef } from "./turnItems";

/** `put` or a model-path `get` outside a chat call, or a text that does not belong to the call's chat. Names nothing. */
export class ReasoningScopeError extends Error {
  constructor() {
    super("no chat scope for this reasoning access");
    this.name = "ReasoningScopeError";
  }
}

/** One captured text (a summary is a few KiB). A larger one is refused: it fails the step, which Loom retries. */
export const MAX_REASONING_BYTES = 512 * 1024;

const ADDRESS = /^[0-9a-f]{32}$/;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

/** The seal binds row and column (spec 4.4); the cipher adds the owner. */
export const chatReasoningBind = (chatId: string, address: string) =>
  `chatreasoning:${chatId}:${address}`;

/** Where the sealed envelopes live: Postgres in production (`PgReasoningRows`), a map in tests. Owner-scoped by `ref`. */
export interface ReasoningRows {
  put(ref: ChatRef, address: string, sealed: unknown): Promise<void>;
  get(ref: ChatRef, address: string): Promise<unknown | null>;
}

/** The chat and owner a sealed Loom blob names (`{"e": executionId, "t": text}`), or null. */
function ownerOfEnvelope(text: string): { userId: string; chatId: string } | null {
  try {
    const v = JSON.parse(text) as { e?: unknown; t?: unknown } | null;
    if (v === null || typeof v !== "object" || typeof v.e !== "string" || typeof v.t !== "string")
      return null;
    return chatIdOfConversation(v.e);
  } catch {
    return null;
  }
}

/**
 * Loom's reasoning sidecar store (ADR 0133 D3), sealed under the owning user's key (A3).
 *
 * Loom calls `put(bytes)` with no context. The owner is taken from the `chatScope` ALS, which
 * `chatModelEffect` holds around the whole model call (so also around Loom's request-time resolution of
 * earlier reasoning), and is cross-checked against the execution id inside the bytes. Outside a chat call both
 * methods refuse. A route reads through `readerFor(ref)`, which is fixed to one owner's chat and needs no ALS.
 *
 * The address is random, never a hash: a hash of the sealed envelope (execution id plus text) would let someone
 * holding the table confirm a guessed summary. Erasure: rows cascade with the chat and the user; destroying the
 * owner's key makes `get` answer `null`, which Loom reports as `erased` and treats as a hole in continuation.
 */
export class ChatReasoningStore implements ReasoningStore {
  constructor(
    private readonly rows: ReasoningRows,
    private readonly fields: FieldCrypto,
    private readonly scope: () => ChatRef | undefined = () => chatScope.current(),
  ) {}

  async put(bytes: Uint8Array): Promise<{ readonly __loomContent: string }> {
    const ref = this.requireScope();
    if (bytes.byteLength > MAX_REASONING_BYTES) throw new RangeError("reasoning text is too large");
    let text: string;
    try {
      text = utf8.decode(bytes);
    } catch {
      throw new TypeError("reasoning text is not valid UTF-8");
    }
    const owner = ownerOfEnvelope(text);
    if (owner === null || owner.userId !== ref.userId || owner.chatId !== ref.chatId)
      throw new ReasoningScopeError();
    const address = randomBytes(16).toString("hex");
    const sealed = await this.fields
      .forUser(ref.userId)
      .seal(chatReasoningBind(ref.chatId, address), text);
    await this.rows.put(ref, address, sealed);
    return { __loomContent: address };
  }

  async get(ref: { readonly __loomContent: string }): Promise<Uint8Array | null> {
    return this.read(this.requireScope(), ref.__loomContent);
  }

  /** A reader fixed to one owner's chat, for routes (no ALS). */
  readerFor(ref: ChatRef): ReasoningReader {
    const fixed: ChatRef = { tenantId: ref.tenantId, userId: ref.userId, chatId: ref.chatId };
    return { get: async (r) => this.read(fixed, r.__loomContent) };
  }

  private requireScope(): ChatRef {
    const s = this.scope();
    if (!s) throw new ReasoningScopeError();
    return { tenantId: s.tenantId, userId: s.userId, chatId: s.chatId };
  }

  private async read(ref: ChatRef, address: string): Promise<Uint8Array | null> {
    if (!ADDRESS.test(address)) return null; // a forged or foreign ref is "not yours"
    const sealed = await this.rows.get(ref, address);
    if (sealed === null) return null;
    try {
      const text = await this.fields
        .forUser(ref.userId)
        .openText(chatReasoningBind(ref.chatId, address), sealed);
      return encoder.encode(text);
    } catch (err) {
      if (err instanceof FieldKeyUnavailableError) return null; // the owner's key is gone: erased
      throw err; // a key store outage or a tampered envelope is not "erased"
    }
  }
}
```

- [ ] **Step 5: Run.** `pnpm --filter @docmind/server exec vitest run app/chats/reasoningStore.test.ts` then `pnpm build && pnpm typecheck && pnpm typecheck:tests`. Expected: green. If the capture test fails at `part.textRef` being undefined, check that `captureReasoning` was given a `store` (it is) and that `captureOn` is true (capture defaults on with a store).

- [ ] **Step 6: Run the gate. Commit** with `feat(chats): ChatReasoningStore, Loom's reasoning sidecar sealed under the owner's key`. Open the stacked draft PR.

#### Task 161b: the table and the Postgres rows

**Files:**
- Modify: `infra/migrations/0023_chat_turn_items.sql` (append the table), create `apps/server/app/chats/pgReasoningRows.ts`
- Test: `apps/server/app/chats/pgReasoningRows.pg.test.ts`

**Interfaces:**
- Consumes: `ReasoningRows` (161a); `withTenant`; `insertChat` (`sessions.ts`); the PG fixture (`startPgFixture`).
- Produces: `class PgReasoningRows implements ReasoningRows { constructor(pool: Pool) }`; table `chat_reasoning_texts (tenant_id, user_id, chat_id, address, text_enc, created_at)`, PK `(tenant_id, user_id, chat_id, address)`, composite FK to `chat_sessions (tenant_id, user_id, id) ON DELETE CASCADE`, RLS `tenant_isolation`, `address ~ '^[0-9a-f]{32}$'`.

- [ ] **Step 1: Write the failing test** (`pgReasoningRows.pg.test.ts`):

```ts
import { randomUUID } from "node:crypto";
import { sealReasoningText } from "@loom/llm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../db/tenant";
import { PG_URL } from "../db/testSupport";
import { T1, T2, U1, U1B, U2 } from "../documents/testHarness";
import { type PgFixture, startPgFixture } from "../flows/ingest-document/pgFixture";
import { PgReasoningRows } from "./pgReasoningRows";
import { chatConversationId } from "./ids";
import { ChatReasoningStore } from "./reasoningStore";
import { type ChatCallScope, chatScope } from "./scope";
import { insertChat } from "./sessions";
import type { ChatRef } from "./turnItems";

const TEXT = "Weighing the Nocturne revenue forecast against the memo.";

describe.skipIf(!PG_URL)("chat reasoning texts (needs DOCMIND_TEST_PG_URL)", () => {
  let fx: PgFixture;
  let store: ChatReasoningStore;
  let chat: ChatRef; // U1's chat
  let theirs: ChatRef; // U1B's chat, same tenant
  let foreign: ChatRef; // U2's chat, another tenant
  const scopeOf = (ref: ChatRef): ChatCallScope => ({
    ...ref,
    turnKey: 1,
    stepKey: "conv#o1#turn:0",
    attempt: 1,
  });
  const put = (ref: ChatRef, text = TEXT) =>
    chatScope.run(scopeOf(ref), () =>
      store.put(sealReasoningText(text, chatConversationId(ref.userId, ref.chatId))),
    );
  const raw = async (sql: string, values: unknown[] = []) =>
    (await fx.db.owner.query(sql, values)).rows;

  beforeAll(async () => {
    fx = await startPgFixture();
    store = new ChatReasoningStore(new PgReasoningRows(fx.app), fx.fields);
    const make = async (tenantId: string, userId: string): Promise<ChatRef> => {
      const row = await withTenant(fx.app, tenantId, (tx) =>
        insertChat(tx, tenantId, userId, randomUUID(), "all"),
      );
      return { tenantId, userId, chatId: row.id };
    };
    chat = await make(T1, U1);
    theirs = await make(T1, U1B);
    foreign = await make(T2, U2);
  });
  afterAll(async () => {
    await fx?.close();
  });

  it("stores a sealed envelope and reads the same bytes back as the owner", async () => {
    const ref = await put(chat);
    const rows = await raw("SELECT text_enc FROM chat_reasoning_texts WHERE address = $1", [
      ref.__loomContent,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].text_enc.__loomEnc).toBe("loom/aes-256-gcm");
    expect(JSON.stringify(rows[0].text_enc)).not.toContain("Nocturne");
    const bytes = await store.readerFor(chat).get(ref);
    expect(new TextDecoder().decode(bytes ?? new Uint8Array())).toContain(TEXT);
  });

  it("is owner-scoped: another user of the tenant, and another tenant, read null", async () => {
    const ref = await put(chat);
    expect(await store.readerFor(theirs).get(ref)).toBeNull();
    expect(await store.readerFor({ ...chat, userId: U1B }).get(ref)).toBeNull();
    expect(await store.readerFor({ ...foreign }).get(ref)).toBeNull();
    expect(await store.readerFor({ ...chat, tenantId: T2 }).get(ref)).toBeNull();
  });

  it("hides every row from another tenant under row-level security", async () => {
    await put(chat);
    const seen = await withTenant(fx.app, T2, (tx) =>
      tx.query("SELECT count(*)::int AS n FROM chat_reasoning_texts"),
    );
    expect(seen.rows[0].n).toBe(0);
  });

  it("cannot write a row for a chat that is not the writer's own", async () => {
    // the composite foreign key (tenant, user, chat) has no such chat
    await expect(
      chatScope.run(scopeOf({ ...theirs, userId: U1 }), () =>
        store.put(sealReasoningText(TEXT, chatConversationId(U1, theirs.chatId))),
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("refuses an address that is not 32 lower-case hex digits", async () => {
    await expect(
      fx.db.owner.query(
        "INSERT INTO chat_reasoning_texts (tenant_id, user_id, chat_id, address, text_enc) VALUES ($1, $2, $3, 'NOT-HEX', '{}'::jsonb)",
        [chat.tenantId, chat.userId, chat.chatId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("goes with the chat: deleting the chat row deletes its texts", async () => {
    const mine = (await insertOwn()).ref;
    await put(mine);
    await fx.db.owner.query("DELETE FROM chat_sessions WHERE id = $1", [mine.chatId]);
    const left = await raw("SELECT count(*)::int AS n FROM chat_reasoning_texts WHERE chat_id = $1", [
      mine.chatId,
    ]);
    expect(left[0].n).toBe(0);
  });

  async function insertOwn() {
    const row = await withTenant(fx.app, T1, (tx) => insertChat(tx, T1, U1, randomUUID(), "all"));
    return { ref: { tenantId: T1, userId: U1, chatId: row.id } as ChatRef };
  }
});
```

- [ ] **Step 2: Run, see it fail.** With `DOCMIND_TEST_PG_URL` exported in the same command (never printed): `pnpm --filter @docmind/server exec vitest run app/chats/pgReasoningRows.pg.test.ts`. Expected: FAIL (no module, no table).

- [ ] **Step 3: Append to `0023_chat_turn_items.sql`:**

```sql

-- The model's reasoning text (M4 amendment, Loom ADR 0133): one row per captured text, sealed under the
-- owner's data key (bind chatreasoning:<chat>:<address>). Loom's ReasoningStore has no tenancy of its own; this
-- one is owner-scoped. `address` is random (32 hex digits), never a hash of the text. Rows cascade with the chat,
-- and so with the user; destroying the owner's key makes them unreadable (Loom reports the part `erased`).
CREATE TABLE chat_reasoning_texts (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  chat_id uuid NOT NULL,
  address text NOT NULL CONSTRAINT chat_reasoning_texts_address_check CHECK (address ~ '^[0-9a-f]{32}$'),
  text_enc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, chat_id, address),
  CONSTRAINT chat_reasoning_texts_chat_fkey FOREIGN KEY (tenant_id, user_id, chat_id)
    REFERENCES chat_sessions (tenant_id, user_id, id) ON DELETE CASCADE
);
ALTER TABLE chat_reasoning_texts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chat_reasoning_texts USING (tenant_id = app_tenant_id());
```

**Contingency (A7):** if `0023` is already on `main`, leave it and create `infra/migrations/0024_chat_reasoning_texts.sql` holding, in this order: `DELETE FROM chat_turn_items WHERE kind = 'thinking';`, `ALTER TABLE chat_turn_items DROP CONSTRAINT chat_turn_items_kind_check, ADD CONSTRAINT chat_turn_items_kind_check CHECK (kind IN ('tool', 'passages', 'outcome'));`, `DROP TABLE chat_reasoning_blocks;`, then the `CREATE TABLE chat_reasoning_texts ...` block above.

- [ ] **Step 4: Implement `pgReasoningRows.ts`:**

```ts
import type { Pool } from "pg";
import { withTenant } from "../db/tenant";
import type { ReasoningRows } from "./reasoningStore";
import type { ChatRef } from "./turnItems";

/**
 * `chat_reasoning_texts` rows: every statement runs in `withTenant` and names the owner and the chat, and the
 * composite foreign key makes a row of a chat that is not the writer's own impossible.
 */
export class PgReasoningRows implements ReasoningRows {
  constructor(private readonly pool: Pool) {}

  async put(ref: ChatRef, address: string, sealed: unknown): Promise<void> {
    await withTenant(this.pool, ref.tenantId, (tx) =>
      tx.query(
        `INSERT INTO chat_reasoning_texts (tenant_id, user_id, chat_id, address, text_enc)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [ref.tenantId, ref.userId, ref.chatId, address, JSON.stringify(sealed)],
      ),
    );
  }

  async get(ref: ChatRef, address: string): Promise<unknown | null> {
    const rows = await withTenant(this.pool, ref.tenantId, async (tx) => {
      const res = await tx.query<{ text_enc: unknown }>(
        `SELECT text_enc FROM chat_reasoning_texts
          WHERE chat_id = $1 AND user_id = $2 AND address = $3`,
        [ref.chatId, ref.userId, address],
      );
      return res.rows;
    });
    return rows[0]?.text_enc ?? null;
  }
}
```

- [ ] **Step 5: Run** the new PG test, then `pnpm --filter @docmind/server exec vitest run app/db` (the tenancy test must still say every table has RLS). Expected: green.

- [ ] **Step 6: Run the gate. Commit** with `feat(chats): chat_reasoning_texts, the owner-scoped table behind the reasoning store`. Open the stacked draft PR.

---

### Task 162: wire the store into the chat, seal the new event paths, extend the proof

**Files:**
- Modify: `apps/server/app/chats/wiring.ts`, `pgCollaborators.ts`, `testStack.ts`, `wiring.test.ts`
- Modify: `apps/server/app/sensitive.ts`, `apps/server/app/sensitive.test.ts`, `apps/server/app/flows/ingest-document/flow.test.ts`
- Modify: `apps/server/app/chats/eventLog.chat.test.ts`, `apps/server/app/chats/activity.test.ts`
- Create: `apps/server/app/chats/reasoning.chat.test.ts`

**Interfaces:**
- Consumes: Task 161 `ChatReasoningStore`, `PgReasoningRows`, `MemoryReasoningRows`; Task 159 provider; Loom `createAgentModelEffect(..., { reasoning })`, `ConversationHub.reasoningSink()`.
- Produces:
  - `ChatCollaborators.reasoning: Pick<ChatReasoningStore, "put" | "get" | "readerFor">`; `ChatWiring.reasoning: Pick<ChatReasoningStore, "readerFor">`.
  - The chat model effect captures reasoning (`store`, `live: true`, `onDelta: hub.reasoningSink()`, `model`).
  - `SENSITIVE_EVENT_PATHS` additions (A4). The flow test's key list gains `LLM_REASONING_CAPTURED`.
  - `ChatStack` gains `events` (the decrypting view), `reasoning`, `reasoningRows`.

- [ ] **Step 1: Write the failing tests.**

1. `sensitive.test.ts`, inside `describe("SENSITIVE_EVENT_PATHS for conversations")`:

```ts
  it("seals the reasoning parts and layout of a model frame and the references of the capture event, and the store opens them again", async () => {
    const reasoning = [
      {
        type: "reasoning",
        kind: "summary",
        provider: "anthropic",
        signature: "SIG-secret-bytes-0123456789",
        textRef: { address: "0123456789abcdef0123456789abcdef", size: 41 },
        digest: "d".repeat(64),
      },
    ];
    const layout = ["reasoning", { call: "toolu_1" }, "reasoning", { call: "toolu_2" }];
    const captured = {
      stepId: "conv#o1#turn:0",
      attempt: 1,
      provider: "anthropic",
      model: "claude-opus-5-5",
      parts: [{ kind: "summary", ref: "0123456789abcdef0123456789abcdef", digest: "d".repeat(64), size: 41 }],
    };
    const { raw, plain } = await roundTrip(EXEC, [
      {
        eventType: "STEP_COMPLETED",
        payload: {
          stepId: "conv#o1#turn:0",
          output: {
            content: "a",
            toolCalls: [{ id: "toolu_1", name: "search_docs", input: { query: "q" } }],
            stopReason: "tool_use",
            reasoning,
            layout,
          },
        },
      },
      { eventType: "LLM_REASONING_CAPTURED", payload: captured },
    ]);
    const out = (raw[0]?.payload as { output: Record<string, unknown> }).output;
    expect([isSealed(out.reasoning), isSealed(out.layout), out.stopReason]).toEqual([true, true, "tool_use"]);
    const cap = raw[1]?.payload as Record<string, unknown>;
    expect(isSealed(cap.parts)).toBe(true);
    // ids and a model name stay readable: no content
    expect([cap.stepId, cap.attempt, cap.provider, cap.model]).toEqual([
      "conv#o1#turn:0",
      1,
      "anthropic",
      "claude-opus-5-5",
    ]);
    const back = (plain[0]?.payload as { output: { reasoning: unknown; layout: unknown } }).output;
    expect([back.reasoning, back.layout]).toEqual([reasoning, layout]);
    expect((plain[1]?.payload as { parts: unknown }).parts).toEqual(captured.parts);
  });
```

2. `flow.test.ts` line 415: the expected key list becomes `["DECISION_RECORDED", "EXECUTION_FAILED", "EXECUTION_STARTED", "LLM_REASONING_CAPTURED", "STEP_COMPLETED", "STEP_FAILED", "STEP_STARTED"]`, and the test title "ingest marks nothing; the map holds only the conversation event types" stays true.

3. `activity.test.ts`, in `describe("ChatActivity")`:

```ts
  it("ignores the model reasoning events of ADR 0133: a capture event and a step value that carries reasoning change nothing", async () => {
    const { feed, activity, rows, errors } = await setup();
    feed(
      record(CONV, 0, 1, "user"),
      evt(CONV, 1, "LLM_REASONING_CAPTURED", {
        stepId: "conv#o1#turn:0",
        attempt: 1,
        provider: "anthropic",
        parts: [{ kind: "summary", ref: "0".repeat(32), digest: "d".repeat(64), size: 12 }],
      }),
      evt(CONV, 2, "STEP_COMPLETED", {
        stepId: "conv#o1#turn:0",
        output: {
          content: "a",
          stopReason: "end_turn",
          reasoning: [{ type: "reasoning", kind: "summary", provider: "anthropic", signature: "S" }],
        },
      }),
      record(CONV, 3, 1, "reply"),
    );
    await activity.drain();
    expect((await rows())[0]?.state).toMatchObject({ messages: 2, lastOrd: 1 });
    expect(errors).toEqual([]);
  });
```

4. `wiring.test.ts`: in `collaborators()` add `reasoning: new ChatReasoningStore(new MemoryReasoningRows(), new FieldCrypto(new InMemoryKeyStore())),` (imports: `FieldCrypto` from `../crypto/fields`, `InMemoryKeyStore` from `@loom/plugin-crypto`, `ChatReasoningStore` from `./reasoningStore`, `MemoryReasoningRows` from `./testing`, `CHAT_MODEL_TOOL_ID` from `./ids`), and add to `describe("prepareChat")`:

```ts
  it("gives the chat model effect the reasoning store and the hub's live sink, so Loom's boot warning has nobody to name", () => {
    const effect = prepare().prepared.deps.effects[CHAT_MODEL_TOOL_ID] as unknown as {
      reasoning?: { capable: boolean; posture(): string };
    };
    expect(effect.reasoning?.capable).toBe(true);
    expect(effect.reasoning?.posture()).toBe("keeps"); // not "unconfigured": the boot warning needs that
  });
```

5. `testStack.ts`: it must first expose the new members (Step 3), so the proof tests below fail to compile now. In `eventLog.chat.test.ts`:
   - constants: add
     ```ts
const SIG1 = "sigA-Zq8Lm2Vx9Rt4Ns6Hd1Wk3Pf7";
const SIG2 = "sigB-Hd1Wk3Pf7Zq8Lm2Vx9Rt4Ns6";
const THINK2 = "Checking the figure against the passage.";
     ```
     replace `"Checking the figure against the passage."` (in `SECRETS` and in the second script step) with `THINK2`, `"sig-1"` with `SIG1`, `"sig-2"` with `SIG2`, and add `SIG1`, `SIG2` to `SECRETS`.
   - imports: add `C, T, U` use is already there; add nothing else.
   - in the first test, add the three paths to the `arrayContaining` list: `"LLM_REASONING_CAPTURED:parts"` and `"STEP_COMPLETED:output.reasoning"`, and replace the comment line left by Task 160a (`// The reasoning store and its assertions come back in Task 162 ...`) with:
     ```ts
    // The reasoning really reached the store, sealed under the owner's key (so the scan above is not vacuous for it).
    const sealedRows = [...stack.reasoningRows.rows.values()];
    expect(sealedRows).toHaveLength(2); // one summary per model frame of the first turn
    for (const r of sealedRows)
      expect((r.sealed as { __loomEnc?: string }).__loomEnc).toBe("loom/aes-256-gcm");
    expect(JSON.stringify(sealedRows)).not.toContain("Nocturne");
    const reader = stack.reasoning.readerFor({ tenantId: T, userId: U, chatId: C });
    const texts = await Promise.all(
      sealedRows.map(async (r) =>
        new TextDecoder().decode((await reader.get({ __loomContent: r.address })) ?? new Uint8Array()),
      ),
    );
    expect(texts.some((t) => t.includes(THINKING))).toBe(true);
     ```
   - add two cases at the end of the `describe`:

```ts
  it("an interleaved thinking, tool call, thinking, tool call turn seals its layout, and the model gets the blocks back in that order", async () => {
    const FIRST = "First, which memo covers the Nocturne cost forecast?";
    const SECOND_THOUGHT = "Second, is the hiring figure in the same Nocturne memo?";
    stack = await startChatStack({
      passages: [PASSAGE],
      scripts: [
        {
          steps: [
            { thinking: FIRST },
            { signature: SIG1 },
            { toolUse: { id: "toolu_1", name: "search_docs", input: { query: QUERY } } },
            { thinking: SECOND_THOUGHT },
            { signature: SIG2 },
            { toolUse: { id: "toolu_2", name: "search_docs", input: { query: `${QUERY} hiring` } } },
            { stop: "tool_use" },
          ],
        },
        { steps: [{ text: `${ANSWER} [[${PASSAGE.passageId}]].` }, { stop: "end_turn" }] },
      ],
    });
    const id = await stack.start();
    await stack.send(id, QUESTION);
    await stack.replies(id, 1);
    const raw = await rawLog(stack);
    assertNoPlaintext(raw, [FIRST, SECOND_THOUGHT, SIG1, SIG2, QUESTION]);
    expect([...sealedPaths(raw)]).toEqual(
      expect.arrayContaining([
        "STEP_COMPLETED:output.layout",
        "STEP_COMPLETED:output.reasoning",
        "LLM_REASONING_CAPTURED:parts",
      ]),
    );
    // the second request carried the blocks back in the order they were made, with text and signature
    const assistant = stack.fake.requests[1]?.body.messages.find((m) => m.role === "assistant");
    expect(assistant?.content.map((b) => b.type)).toEqual(["thinking", "tool_use", "thinking", "tool_use"]);
    expect(assistant?.content[0]).toMatchObject({ type: "thinking", thinking: FIRST, signature: SIG1 });
    expect(assistant?.content[2]).toMatchObject({ type: "thinking", thinking: SECOND_THOUGHT, signature: SIG2 });
  });

  it("a refused response keeps no reasoning: nothing is stored and no capture event is written", async () => {
    stack = await startChatStack({
      scripts: [
        {
          steps: [
            { thinking: THINKING },
            { signature: SIG1 },
            { text: "I can" },
            { stop: "refusal", details: { category: "policy" } },
          ],
        },
      ],
    });
    const id = await stack.start();
    await stack.send(id, QUESTION);
    await stack.replies(id, 1);
    expect(stack.reasoningRows.rows.size).toBe(0);
    const raw = await rawLog(stack);
    expect(raw.some((e) => e.eventType === "LLM_REASONING_CAPTURED")).toBe(false);
    assertNoPlaintext(raw, [THINKING, SIG1]);
  });
```

6. Create `reasoning.chat.test.ts` (the live channel, the continuation and the audit read, over the real flow):

```ts
import { unwrapTainted } from "@loom/classify";
import { readReasoningBounded } from "@loom/llm";
import { afterEach, describe, expect, it } from "vitest";
import { chatConversationId } from "./ids";
import { type ChatStack, startChatStack } from "./testStack";
import { C, T, U } from "./testing";
import { passage } from "./tools/testing";

const CONV = chatConversationId(U, C);
const QUESTION = "What is the Nocturne revenue forecast for next quarter?";
const FIRST = "Weighing which Nocturne memo covers the revenue forecast.";
const SECOND = "Checking the figure against the passage.";
const SIG1 = "sigA-Zq8Lm2Vx9Rt4Ns6Hd1Wk3Pf7";
const SIG2 = "sigB-Hd1Wk3Pf7Zq8Lm2Vx9Rt4Ns6";
const PASSAGE = passage({ text: "Nocturne quarterly revenue forecast: seventeen thousand dollars.", docTitle: "Memo" });

let stack: ChatStack | undefined;
afterEach(async () => {
  await stack?.close();
  stack = undefined;
});

describe("model reasoning in a chat (ADR 0133 over the real flow)", () => {
  it("streams reasoning on the hub, records it, and reads it back through the decrypting log as the owner", async () => {
    stack = await startChatStack({
      passages: [PASSAGE],
      scripts: [
        {
          steps: [
            { thinking: FIRST },
            { signature: SIG1 },
            { toolUse: { id: "toolu_1", name: "search_docs", input: { query: "Nocturne forecast" } } },
            { stop: "tool_use" },
          ],
        },
        {
          steps: [
            { thinking: SECOND },
            { signature: SIG2 },
            { text: `Seventeen thousand [[${PASSAGE.passageId}]].` },
            { stop: "end_turn" },
          ],
        },
      ],
    });
    const id = await stack.start();
    const live: { turn: number; text: string }[] = [];
    const off = stack.chat.hub.subscribe(id, (ev) => {
      if (ev.type === "reasoning") live.push({ turn: ev.turn, text: ev.text });
    });
    await stack.send(id, QUESTION);
    await stack.replies(id, 1);
    off();

    // live: both model frames' reasoning, in order, under the accepted-turn number of the answer's deltas
    expect(live.map((l) => l.text).join("")).toBe(FIRST + SECOND);
    expect([...new Set(live.map((l) => l.turn))]).toEqual([1]);

    // durable: one captured step per model frame, each the recorded attempt, text read back as the owner
    const read = await readReasoningBounded(
      stack.events,
      stack.reasoning.readerFor({ tenantId: T, userId: U, chatId: C }),
      { executionId: CONV, stepPrefix: "conv#o1#" },
    );
    expect(read.steps.map((s) => s.stepId)).toEqual(["conv#o1#turn:0", "conv#o1#turn:1"]);
    expect(read.steps.map((s) => s.recordedAttempt)).toEqual([1, 1]);
    const parts = read.steps.flatMap((s) => s.attempts.flatMap((a) => a.parts));
    expect(parts.map((p) => [p.kind, p.status, p.text === undefined ? undefined : unwrapTainted(p.text)])).toEqual([
      ["summary", "ok", FIRST],
      ["summary", "ok", SECOND],
    ]);
    expect(read.truncated).toBe(false);

    // continuation: the second request carried the first block back, text and signature, ahead of the tool call
    const assistant = stack.fake.requests[1]?.body.messages.find((m) => m.role === "assistant");
    expect(assistant?.content[0]).toMatchObject({ type: "thinking", thinking: FIRST, signature: SIG1 });
    expect(assistant?.content.some((b) => b.type === "tool_use")).toBe(true);
  });
});
```

- [ ] **Step 2: Run, see them fail.** `pnpm --filter @docmind/server exec vitest run app/sensitive.test.ts app/chats/wiring.test.ts app/chats/eventLog.chat.test.ts app/chats/reasoning.chat.test.ts app/chats/activity.test.ts app/flows/ingest-document/flow.test.ts`. Expected: FAIL (new paths unsealed, `posture()` is `"unconfigured"`/no hook, `ChatStack` has no `reasoning`).

- [ ] **Step 3: Implement.**

`sensitive.ts`: replace the `STEP_COMPLETED` entry, add `LLM_REASONING_CAPTURED`, and update the two comments that say "thinking-free model frames":

```ts
  // M4: a chat conversation (flow doc-chat) writes user text, replies, model reasoning and tool results into the
  // log. Loom already seals the principal, and (inbox on) INBOX_MESSAGE.payload and MESSAGE_CONSUMED.payload.
  // These are the rest. They name content fields only, so ingest events (ids, counts, codes) are untouched and a
  // fold can still read `choice.role|turn|ord|status`. The tool schemas are strict, so a tool frame's `input`
  // holds only the declared keys, and the text ones are here.
  STEP_STARTED: ["input.messages", "input.query", "input.titleContains"],
  STEP_COMPLETED: [
    "output.content",
    "output.toolCalls[].input",
    "output.value",
    // ADR 0133: the reasoning parts of a model frame (signature, textRef with its size, digest) and the vendor's
    // block order (text lengths). A signature carries the model's encrypted reasoning; the digest of a short
    // summary would let a reader of the log guess it. `STEP_STARTED.input.messages` above already seals the
    // assistant reasoning parts that later requests send back. toolCalls[].signature is Gemini's (absent for Claude).
    "output.reasoning",
    "output.layout",
    "output.toolCalls[].signature",
  ],
  DECISION_RECORDED: ["choice.text", "choice.partial", "choice.failed", "choice.error"],
  // Loom writes String(err) here; a tool's collaborator error could carry a query or passage text.
  STEP_FAILED: ["error"],
  EXECUTION_FAILED: ["error"],
  // ADR 0133: the audit event of a captured reasoning text: references, digests and sizes (stepId, attempt, provider
  // and model stay readable: ids and a model name).
  LLM_REASONING_CAPTURED: ["parts"],
```

(keep `EXECUTION_STARTED` as is). Also change the sentence "M4 registers the conversation paths below (flow doc-chat), and Task 147b's raw event-log proof fails if a path is missing." to end with "...and the ADR 0133 reasoning paths (Task 162); the raw event-log proof fails if a path is missing."

`wiring.ts`:
  1. import `type { ChatReasoningStore } from "./reasoningStore";`.
  2. `ChatCollaborators`: add `reasoning: Pick<ChatReasoningStore, "put" | "get" | "readerFor">;`.
  3. In `prepareChat`, replace the model effect creation:

```ts
    effects[CHAT_MODEL_TOOL_ID] = chatModelEffect(
      createAgentModelEffect(hub.wrapProvider(o.llm.provider), {
        stream: true,
        onDelta: hub.deltaSink(),
        // ADR 0133: Loom captures the model's reasoning into OUR store (sealed under the owner's key), streams it
        // live on the hub, and sends it back within a tool loop. The effect's own options win over
        // `observability.reasoning`, which DocMind does not set.
        reasoning: {
          store: c.reasoning,
          live: true,
          onDelta: hub.reasoningSink(),
          model: settings.model,
        },
      }),
      { items: c.items, bus, shutdown: shutdown.signal },
    );
```

  4. `ChatWiring`: add `reasoning: Pick<ChatReasoningStore, "readerFor">;` and in `connectChat`'s return `reasoning: p.collaborators.reasoning,`.

`pgCollaborators.ts`: import `ChatReasoningStore` and `PgReasoningRows`; add `reasoning: new ChatReasoningStore(new PgReasoningRows(o.pool), o.fields),` to the returned collaborators.

`testStack.ts`: import `FieldCrypto` (`../crypto/fields`), `ChatReasoningStore` (`./reasoningStore`), `MemoryReasoningRows` (`./testing`); add to `ChatStack`:

```ts
  /** The decrypting view of the log (what a route reads reasoning through). */
  events: EncryptingEventStore;
  reasoning: ChatReasoningStore;
  /** The sealed rows the reasoning store wrote. */
  reasoningRows: MemoryReasoningRows;
```

and in `startChatStack`, after `const items = new FakeItems();`:

```ts
  const reasoningRows = new MemoryReasoningRows();
  const reasoning = new ChatReasoningStore(reasoningRows, new FieldCrypto(recording));
```

pass `reasoning` in the collaborators and add `events, reasoning, reasoningRows,` to the returned object.

- [ ] **Step 4: Run** the same command as Step 2, then `pnpm build && pnpm typecheck && pnpm typecheck:tests`. Expected: green.

  **Probes (record the result in the PR body).**
  1. **Layout is really emitted and sealed.** Temporarily log `Object.keys((await rawLog(stack)).find((e) => e.eventType === "STEP_COMPLETED")?.payload.output)` in the interleaved test: expected to include `reasoning` and `layout`. If `layout` is absent, Loom's `layoutOf` considered the order canonical: the provider's entries are wrong (159b `outcomeOf`); fix there, not in the test.
  2. **The hub's reasoning `turn` is the accepted-turn number.** `reasoning.chat.test.ts` asserts `[1]`. If it reports a different number, read `hub.ts` `reasoningSink` and `scope.getStore()` (it uses the same scope as `deltaSink`); do not renumber in DocMind.
  3. **`reasoning.live` reaches the hub under the real runtime** (the governed per-call sink forwards to the effect's `reasoningSink`, which the `chatModelEffect` wrapper must copy). If `live` is empty, check `model.test.ts`'s key-parity case ("forwards every key of the inner effect except execute") covers `reasoningSink`; if it does not, add `reasoningSink` and `reasoning` to its list.
  4. **`LLM_REASONING_CAPTURED` is accepted by the activity fold and the read-model sensitive guard** (the activity test above). If `errors` is not empty, the read model's sensitive map needs `parts` too: it is computed from the same map, so check `statusSensitive` in `status/wire.ts`.

- [ ] **Step 5: Run the gate. Commit** with `feat(chats): Loom captures the model's reasoning into the owner-sealed store; seal the ADR 0133 paths`. Open the stacked draft PR (about 300 lines, mostly tests).

---

### Task 163: reading reasoning back: history grouping, the fold and the endpoint body

The pure and testable half of A6. The routes that use it are Tasks 151 (history) and 152c (endpoint), below.

**Files:**
- Create: `apps/server/app/chats/reasoningRead.ts`
- Test: `apps/server/app/chats/reasoningRead.test.ts`
- Modify: `apps/server/app/chats/testing.ts` (`FakeReplyReasoning`)

**Interfaces:**
- Consumes: Task 161 `ChatReasoningStore.readerFor`; Task 158 `ChatReasoningDto`, `ReasoningResponse`; Loom `readReasoningBounded`, `ReasoningLogReader`, `ReasoningStepRead` (`@loom/llm`), `generationId`, `parseCursor`, `Conversations.reasoningTarget` (`@loom/conversation`), `unwrapTainted` (`@loom/classify`).
- Produces:
  - `REPLY_LIMITS = { maxParts: 64, maxBytes: 256 KiB }`, `ENDPOINT_LIMITS = { maxParts: 256, maxBytes: 1 MiB }`, `MAX_REASONING_CHARS = 32_000`.
  - `memoLog(log): ReasoningLogReader` (one `read` per execution id, per request).
  - `foldReasoning(steps, truncated): ChatReasoningDto | null`.
  - `interface ReplyRef { cursor: string; turnKey: number }`, `interface ReplyReasoning { forReplies(ref: ChatRef, conversationId: string, replies: readonly ReplyRef[]): Promise<Map<string, ChatReasoningDto | null>> }` (keyed by the reply's cursor), `replyReasoning(deps): ReplyReasoning`, `logReasoningError(err)`.
  - `reasoningBody(deps, ref, conversationId, cursor, options): Promise<ReasoningResponse>`.
  - `testing.ts`: `class FakeReplyReasoning implements ReplyReasoning { set(cursor, dto): void; calls: ReplyRef[][] }`.

- [ ] **Step 1: Write the failing tests** (`reasoningRead.test.ts`):

```ts
import { ReasoningResponse } from "@docmind/contracts";
import { tainted } from "@loom/classify";
import { ConversationNotFoundError } from "@loom/conversation";
import { type LlmReasoning, type ReasoningStepRead, captureReasoning } from "@loom/llm";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { describe, expect, it } from "vitest";
import { FieldCrypto } from "../crypto/fields";
import { chatConversationId } from "./ids";
import { ChatReasoningStore } from "./reasoningStore";
import {
  MAX_REASONING_CHARS,
  REPLY_LIMITS,
  foldReasoning,
  memoLog,
  replyReasoning,
  reasoningBody,
} from "./reasoningRead";
import { type ChatCallScope, chatScope } from "./scope";
import { C, MemoryReasoningRows, T, U, modelCtx } from "./testing";

const CONV = chatConversationId(U, C);
const REF = { tenantId: T, userId: U, chatId: C };
const part = (kind: "text" | "summary" | "redacted", status: string, text?: string) => ({
  kind,
  provider: "anthropic",
  status,
  ...(text !== undefined && { text: tainted(text, "llm-reasoning:s") }),
});
const step = (
  stepId: string,
  attempts: { attempt: number; recorded: boolean; parts: ReturnType<typeof part>[] }[],
  recordedAttempt?: number,
): ReasoningStepRead =>
  ({
    stepId,
    attempts: attempts.map((a) => ({ provider: "anthropic", ...a })),
    ...(recordedAttempt !== undefined && { recordedAttempt }),
  }) as unknown as ReasoningStepRead;

describe("foldReasoning", () => {
  it("joins the recorded attempts' texts with a blank line, and is a summary when any part is one", () => {
    const got = foldReasoning(
      [
        step("conv#o1#turn:0", [{ attempt: 1, recorded: true, parts: [part("text", "ok", "first ")] }], 1),
        step("conv#o1#turn:1", [{ attempt: 1, recorded: true, parts: [part("summary", "ok", "second")] }], 1),
      ],
      false,
    );
    expect(got).toEqual({ text: "first\n\nsecond", kind: "summary" });
  });

  it("ignores a superseded attempt", () => {
    const got = foldReasoning(
      [
        step(
          "conv#o1#turn:0",
          [
            { attempt: 1, recorded: false, parts: [part("summary", "ok", "retried away")] },
            { attempt: 2, recorded: true, parts: [part("summary", "ok", "kept")] },
          ],
          2,
        ),
      ],
      false,
    );
    expect(got).toEqual({ text: "kept", kind: "summary" });
  });

  it("reads hidden, erased and mismatching parts as markers, text winning over them", () => {
    const only = (...parts: ReturnType<typeof part>[]) =>
      foldReasoning([step("s", [{ attempt: 1, recorded: true, parts }], 1)], false);
    expect(only(part("redacted", "redacted"))).toEqual({ text: "", kind: "redacted" });
    expect(only(part("text", "ok", "   "))).toEqual({ text: "", kind: "redacted" }); // an omitted-display block
    expect(only(part("summary", "erased"))).toEqual({ text: "", kind: "text", status: "erased" });
    expect(only(part("summary", "digest-mismatch"))).toEqual({
      text: "",
      kind: "text",
      status: "digest-mismatch",
    });
    expect(only(part("summary", "erased"), part("summary", "ok", "left"))).toEqual({
      text: "left",
      kind: "summary",
    });
    expect(only()).toBeNull();
  });

  it("caps the text and says so, and passes the reader's truncation on", () => {
    const long = "x".repeat(MAX_REASONING_CHARS + 500);
    const got = foldReasoning(
      [step("s", [{ attempt: 1, recorded: true, parts: [part("summary", "ok", long)] }], 1)],
      false,
    );
    expect(got?.text).toHaveLength(MAX_REASONING_CHARS);
    expect(got?.truncated).toBe(true);
    expect(foldReasoning([step("s", [{ attempt: 1, recorded: true, parts: [part("summary", "ok", "a")] }], 1)], true)?.truncated).toBe(true);
  });
});

/** A log and a store that Loom's own `captureReasoning` writes to, as the model effect does. */
function world() {
  const log: { executionId: string; eventType: string; payload: unknown }[] = [];
  const reads: string[] = [];
  const store = new ChatReasoningStore(
    new MemoryReasoningRows(),
    new FieldCrypto(new InMemoryKeyStore()),
  );
  const scope = (stepKey: string): ChatCallScope => ({ ...REF, turnKey: 1, stepKey, attempt: 1 });
  const record = async (
    executionId: string,
    stepId: string,
    reasoning: LlmReasoning[],
    o: { attempt?: number; complete?: boolean } = {},
  ) => {
    const ctx = modelCtx({
      executionId,
      stepId,
      attempt: o.attempt ?? 1,
      emit: (eventType, payload) => log.push({ executionId, eventType, payload }),
    });
    await chatScope.run(scope(stepId), () => captureReasoning(reasoning, { store, model: "m" }, ctx));
    if (o.complete !== false) log.push({ executionId, eventType: "STEP_COMPLETED", payload: { stepId } });
  };
  const reader = {
    read: async (id: string) => {
      reads.push(id);
      if (id.endsWith("~9")) throw new RangeError("the log is down");
      return log.filter((e) => e.executionId === id);
    },
  };
  return { record, reader, reads, store };
}
const summary = (text: string): LlmReasoning => ({ kind: "summary", text, signature: "S", provider: "anthropic" });

describe("replyReasoning", () => {
  it("reads each execution's log once per request, gives each reply its own turn's reasoning, and null for none", async () => {
    const w = world();
    await w.record(CONV, "conv#o1#turn:0", [summary("turn one, frame one")]);
    await w.record(CONV, "conv#o1#turn:1", [summary("turn one, frame two")]);
    await w.record(CONV, "conv#o2#turn:0", [summary("turn two")]);
    await w.record(`${CONV}~1`, "conv#o3#turn:0", [summary("turn three, next generation")]);
    const reasoning = replyReasoning({ log: w.reader, store: w.store });
    const got = await reasoning.forReplies(REF, CONV, [
      { cursor: "0.2", turnKey: 1 },
      { cursor: "0.4", turnKey: 2 },
      { cursor: "0.6", turnKey: 5 }, // no reasoning recorded for this one
      { cursor: "1.2", turnKey: 3 },
    ]);
    expect([...got.entries()]).toEqual([
      ["0.2", { text: "turn one, frame one\n\nturn one, frame two", kind: "summary" }],
      ["0.4", { text: "turn two", kind: "summary" }],
      ["0.6", null],
      ["1.2", { text: "turn three, next generation", kind: "summary" }],
    ]);
    expect([...w.reads].sort()).toEqual([CONV, `${CONV}~1`].sort()); // one read per generation, not per reply
  });

  it("does not mix a reply up with a later turn whose key starts with the same digits", async () => {
    const w = world();
    await w.record(CONV, "conv#o1#turn:0", [summary("one")]);
    await w.record(CONV, "conv#o10#turn:0", [summary("ten")]);
    const got = await replyReasoning({ log: w.reader, store: w.store }).forReplies(REF, CONV, [
      { cursor: "0.2", turnKey: 1 },
    ]);
    expect(got.get("0.2")).toEqual({ text: "one", kind: "summary" });
  });

  it("gives null for a bad cursor, and for a reply whose generation cannot be read, without failing the others", async () => {
    const w = world();
    await w.record(CONV, "conv#o1#turn:0", [summary("fine")]);
    const errors: unknown[] = [];
    const got = await replyReasoning({
      log: w.reader,
      store: w.store,
      onError: (e) => errors.push(e),
    }).forReplies(REF, CONV, [
      { cursor: "0.2", turnKey: 1 },
      { cursor: "nonsense", turnKey: 1 },
      { cursor: "9.2", turnKey: 4 }, // generation 9: the log read fails
    ]);
    expect([got.get("0.2"), got.get("nonsense"), got.get("9.2")]).toEqual([
      { text: "fine", kind: "summary" },
      null,
      null,
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(RangeError);
  });

  it("bounds the parts read for one reply and says the text is truncated", async () => {
    const w = world();
    for (let i = 0; i < REPLY_LIMITS.maxParts + 1; i++)
      await w.record(CONV, `conv#o1#turn:${i}`, [summary(`p${i}`)]);
    const got = await replyReasoning({ log: w.reader, store: w.store }).forReplies(REF, CONV, [
      { cursor: "0.2", turnKey: 1 },
    ]);
    expect(got.get("0.2")?.truncated).toBe(true);
    expect(got.get("0.2")?.text.startsWith("p0\n\np1")).toBe(true);
    expect(got.get("0.2")?.text).not.toContain(`p${REPLY_LIMITS.maxParts}`);
  });
});

describe("memoLog", () => {
  it("reads an execution once however often it is asked", async () => {
    let n = 0;
    const log = memoLog({ read: async () => (n++, []) });
    await Promise.all([log.read("a"), log.read("a"), log.read("b")]);
    await log.read("a");
    expect(n).toBe(2);
  });
});

describe("reasoningBody", () => {
  const options = { principal: { tenant: T, actor: U } };

  it("returns Loom's body shape for the reply the conversation names, text unwrapped, every attempt kept", async () => {
    const w = world();
    await w.record(CONV, "conv#o1#turn:0", [summary("superseded")], { attempt: 1, complete: false });
    await w.record(CONV, "conv#o1#turn:0", [summary("recorded"), { kind: "redacted", signature: "ENC", provider: "anthropic" }], { attempt: 2 });
    await w.record(CONV, "conv#o2#turn:0", [summary("another turn")]);
    const calls: unknown[] = [];
    const body = await reasoningBody(
      {
        conversations: {
          reasoningTarget: async (id, cursor) => {
            calls.push([id, cursor]);
            return { executionId: CONV, stepPrefix: "conv#o1#" };
          },
        },
        log: w.reader,
        store: w.store,
      },
      REF,
      CONV,
      "0.2",
      options,
    );
    expect(calls).toEqual([[CONV, "0.2"]]);
    expect(ReasoningResponse.parse(body)).toEqual({
      steps: [
        {
          stepId: "conv#o1#turn:0",
          recordedAttempt: 2,
          attempts: [
            { attempt: 1, provider: "anthropic", model: "m", recorded: false, parts: [{ kind: "summary", status: "ok", text: "superseded" }] },
            {
              attempt: 2,
              provider: "anthropic",
              model: "m",
              recorded: true,
              parts: [
                { kind: "summary", status: "ok", text: "recorded" },
                { kind: "redacted", status: "redacted" },
              ],
            },
          ],
        },
      ],
    });
  });

  it("lets the conversation's refusal through: another reader, an unknown cursor and a user message are all not found", async () => {
    const w = world();
    const refusing = {
      reasoningTarget: async (id: string) => {
        throw new ConversationNotFoundError(id);
      },
    };
    await expect(
      reasoningBody({ conversations: refusing, log: w.reader, store: w.store }, REF, CONV, "0.1", options),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);
    expect(w.reads).toEqual([]); // nothing was read before the audience decision
  });
});
```

- [ ] **Step 2: Run, see it fail.** `pnpm --filter @docmind/server exec vitest run app/chats/reasoningRead.test.ts`. Expected: FAIL (no module).

- [ ] **Step 3: Implement `reasoningRead.ts`:**

```ts
import type { ChatReasoningDto, ReasoningResponse } from "@docmind/contracts";
import { unwrapTainted } from "@loom/classify";
import { type Conversations, generationId, parseCursor } from "@loom/conversation";
import { type ReasoningLogReader, type ReasoningStepRead, readReasoningBounded } from "@loom/llm";
import type { ChatReasoningStore } from "./reasoningStore";
import type { ChatRef } from "./turnItems";

/** What reading ONE reply's reasoning may cost: its own steps (a few parts, a few KiB each). */
export const REPLY_LIMITS = { maxParts: 64, maxBytes: 256 * 1024 } as const;
/** What the endpoint may cost: Loom's own bounds for its `/reasoning` route (256 parts, 1 MiB). */
export const ENDPOINT_LIMITS = { maxParts: 256, maxBytes: 1024 * 1024 } as const;
/** The folded text of one reply is cut here (the contract allows 40,000). */
export const MAX_REASONING_CHARS = 32_000;

/** One `read` of each execution's log per request, however many replies ask (Loom's reader reads the whole generation). */
export function memoLog(log: ReasoningLogReader): ReasoningLogReader {
  const seen = new Map<string, ReturnType<ReasoningLogReader["read"]>>();
  return {
    read: (executionId) => {
      let p = seen.get(executionId);
      if (p === undefined) {
        p = log.read(executionId);
        seen.set(executionId, p);
      }
      return p;
    },
  };
}

/**
 * The recorded attempts' texts folded into one `ChatReasoningDto`, as loom-ui's `chatReasoningFromDurable` does:
 * only the attempt a step recorded counts; texts are trimmed and joined by a blank line; any `summary` makes the
 * whole a `summary` (never upgraded to `text`); a part with no text is hidden reasoning (`redacted`); an erased
 * part or one that fails its digest never contributes text and shows only when nothing else does. `null` when
 * nothing was recorded.
 */
export function foldReasoning(
  steps: readonly ReasoningStepRead[],
  truncated: boolean,
): ChatReasoningDto | null {
  const texts: string[] = [];
  let used = 0;
  let summary = false;
  let hidden = false;
  let mismatch = false;
  let erased = false;
  let cut = truncated;
  for (const s of steps) {
    for (const a of s.attempts) {
      const recorded =
        a.recorded && (s.recordedAttempt === undefined || a.attempt === s.recordedAttempt);
      if (!recorded) continue;
      for (const p of a.parts) {
        if (p.status === "erased") erased = true;
        else if (p.status === "redacted") hidden = true;
        else if (p.status !== "ok") mismatch = true;
        else {
          const clean = (p.text === undefined ? "" : unwrapTainted(p.text)).trim();
          if (clean === "") {
            hidden = true;
            continue;
          }
          const room = MAX_REASONING_CHARS - used;
          if (room <= 0) {
            cut = true;
            continue;
          }
          texts.push(clean.length > room ? clean.slice(0, room) : clean);
          if (clean.length > room) cut = true;
          used += Math.min(clean.length, room) + 2;
          if (p.kind === "summary") summary = true;
        }
      }
    }
  }
  const flag = cut ? { truncated: true as const } : {};
  if (texts.length > 0)
    return { text: texts.join("\n\n"), kind: summary ? "summary" : "text", ...flag };
  if (hidden) return { text: "", kind: "redacted", ...flag };
  if (mismatch) return { text: "", kind: "text", status: "digest-mismatch", ...flag };
  if (erased) return { text: "", kind: "text", status: "erased", ...flag };
  return null;
}

export interface ReplyRef {
  /** Loom's history cursor of the reply, `<generation>.<sequence>`. */
  cursor: string;
  /** The turn key `<o>` of the reply's step ids (`turnKeyOf(entry)`). */
  turnKey: number;
}

/** History's view of reasoning: one call per page, keyed by each reply's cursor. */
export interface ReplyReasoning {
  forReplies(
    ref: ChatRef,
    conversationId: string,
    replies: readonly ReplyRef[],
  ): Promise<Map<string, ChatReasoningDto | null>>;
}

export interface ReplyReasoningDeps {
  /** The DECRYPTING event store (capture events are sealed). */
  log: ReasoningLogReader;
  store: Pick<ChatReasoningStore, "readerFor">;
  /** Called with the error of a failed read; callers log the class only (default `logReasoningError`). */
  onError?: (err: unknown) => void;
}

/** The class only: a read error could carry a store or key message. */
export const logReasoningError = (err: unknown): void =>
  console.error("chat reasoning read failed", err instanceof Error ? err.constructor.name : typeof err);

/**
 * Reasoning for the replies of one history page. One memoized read of each generation's log, then a bounded read
 * per reply selected by `stepPrefix: "conv#o<turnKey>#"` BEFORE any blob is fetched. The caller has already
 * established that the chat is the caller's (the chat row, `user_id = identity`), and the store reader is fixed
 * to that owner's chat. History is display: a failed read gives `null` for that reply, never an error.
 */
export function replyReasoning(deps: ReplyReasoningDeps): ReplyReasoning {
  const report = deps.onError ?? logReasoningError;
  return {
    async forReplies(ref, conversationId, replies) {
      const out = new Map<string, ChatReasoningDto | null>();
      if (replies.length === 0) return out;
      const log = memoLog(deps.log);
      const reader = deps.store.readerFor(ref);
      for (const r of replies) {
        const pos = parseCursor(r.cursor);
        if (pos === undefined) {
          out.set(r.cursor, null);
          continue;
        }
        try {
          const read = await readReasoningBounded(
            log,
            reader,
            { executionId: generationId(conversationId, pos.g), stepPrefix: `conv#o${r.turnKey}#` },
            REPLY_LIMITS,
          );
          out.set(r.cursor, foldReasoning(read.steps, read.truncated));
        } catch (err) {
          report(err);
          out.set(r.cursor, null);
        }
      }
      return out;
    },
  };
}

export interface ReasoningBodyDeps {
  conversations: Pick<Conversations, "reasoningTarget">;
  log: ReasoningLogReader;
  store: Pick<ChatReasoningStore, "readerFor">;
}

/**
 * The body of `GET /api/chats/:id/reasoning?cursor=`: Loom's own shape (`conversation-sse`'s route), with the text
 * unwrapped at this edge. The audience decision is Loom's (`reasoningTarget`: in owner mode the owner only; an
 * unknown cursor, a user message and anyone else are `ConversationNotFoundError`; a malformed cursor is
 * `InvalidCursorError`), and it runs BEFORE any read. The route has already checked the chat row.
 */
export async function reasoningBody(
  deps: ReasoningBodyDeps,
  ref: ChatRef,
  conversationId: string,
  cursor: string,
  options: Parameters<Conversations["reasoningTarget"]>[2],
): Promise<ReasoningResponse> {
  const target = await deps.conversations.reasoningTarget(conversationId, cursor, options);
  const { steps, truncated } = await readReasoningBounded(
    deps.log,
    deps.store.readerFor(ref),
    {
      executionId: target.executionId,
      ...(target.stepPrefix !== undefined && { stepPrefix: target.stepPrefix }),
    },
    ENDPOINT_LIMITS,
  );
  return {
    steps: steps.map((s) => ({
      stepId: s.stepId,
      ...(s.recordedAttempt !== undefined && { recordedAttempt: s.recordedAttempt }),
      attempts: s.attempts.map((a) => ({
        attempt: a.attempt,
        provider: a.provider,
        ...(a.model !== undefined && { model: a.model }),
        recorded: a.recorded,
        parts: a.parts.map((p) => ({
          kind: p.kind,
          status: p.status,
          // The transport edge: the one place the untrusted wrapper comes off.
          ...(p.text !== undefined && { text: unwrapTainted(p.text) }),
        })),
      })),
    })),
    ...(truncated && { truncated: true as const }),
  };
}
```

`FakeReplyReasoning` (append to `testing.ts`; add `import type { ChatReasoningDto } from "@docmind/contracts";` and `import type { ReplyReasoning, ReplyRef } from "./reasoningRead";`):

```ts
/** A `ReplyReasoning` for route tests: `set(cursor, dto)` decides what a reply gets; every call is recorded. */
export class FakeReplyReasoning implements ReplyReasoning {
  readonly calls: ReplyRef[][] = [];
  private readonly byCursor = new Map<string, ChatReasoningDto | null>();
  set(cursor: string, dto: ChatReasoningDto | null): void {
    this.byCursor.set(cursor, dto);
  }
  async forReplies(
    _ref: ChatRef,
    _conversationId: string,
    replies: readonly ReplyRef[],
  ): Promise<Map<string, ChatReasoningDto | null>> {
    this.calls.push([...replies]);
    return new Map(replies.map((r) => [r.cursor, this.byCursor.get(r.cursor) ?? null]));
  }
}
```

- [ ] **Step 4: Run.** `pnpm --filter @docmind/server exec vitest run app/chats/reasoningRead.test.ts`, then `pnpm build && pnpm typecheck && pnpm typecheck:tests`. Expected: green. If `parseCursor` is not exported from `@loom/conversation` in this Loom build, import it from `@loom/conversation/dist/...`: it is exported at `packages/conversation/src/index.ts:56`; verify with `grep -n parseCursor ../loom/packages/conversation/src/index.ts`.

- [ ] **Step 5: Run the gate. Commit** with `feat(chats): fold, group and serve the model's reasoning for history and the reasoning endpoint`. Open the stacked draft PR. **Task 149's branch is cut from this one.**

---

## Changes to planned tasks

Tasks 149, 150, 153, 154 and 156 are unchanged except the fixtures below. Tasks 151, 152, 155 and 157 change as follows; apply each to the M4 plan's brief for that task. Also add rows 158 to 163 to the M4 plan's Task index, before 149, and update its self-review table: "§6.5 thinking, tool steps and answer as separate ordered kinds" now cites 152b, 155a; "§6.5 stored thinking and steps shown in history" becomes "stored reasoning and steps shown in history | 151a, 163, 155a"; "§6.5 preserved thinking blocks" becomes "Loom's recorded reasoning parts and layout, continued inside the tool loop | 159, 162, 155a (the second request carries the block; a restart in the middle of a loop keeps it)".

### Task 149 (fixtures only)

- `ChatRouteDeps` gains `reasoning: ReplyReasoning` (Task 163). `compose.ts` builds it: `replyReasoning({ log: <the decrypting event store routes already get>, store: chat.reasoning })`. `MessageDeps` becomes `Pick<ChatRouteDeps, "pool" | "fields" | "chat" | "reasoning">`.
- `startChatServer` (Task 149a's harness) exposes `reasoning: FakeReplyReasoning` as `h.reasoning` and passes it as `deps.reasoning`; its `ChatWiring` has `reasoning: new ChatReasoningStore(new PgReasoningRows(pool), fields)` (a real store: the endpoint tests below write through Loom's own `captureReasoning`).
- Every fixture that builds a `ChatMessageDto` has `cursor` and `reasoning: null` (never `thinking`).
- The route-level "no API key" cases are unchanged: reading history and reasoning works without a key.

### Task 151 (history): `thinking` becomes `reasoning`, plus `cursor`

**Interfaces.** Consumes adds Task 163 `ReplyReasoning`; drops "`TurnItem` kind `thinking`". `toMessageDtos(deps: MessageDeps, identity, chatId, entries)` is unchanged in signature and returns DTOs with `cursor` (the entry's Loom cursor) and `reasoning`.

**Joining.** Tool steps, passages and outcomes still join by turn key from `chat_turn_items`. Reasoning joins by turn key too, but through the log and the sealed store: `deps.reasoning.forReplies(ref, conversationId, replies)` with one `{cursor, turnKey}` per reply of the page, a single call per page.

**Step 1 test changes (`history.pg.test.ts`).**
- In "returns the user's question and the answer with its citations, thinking and tool steps merged from the side table": rename to "...citations, reasoning and tool steps...", delete the two `items.put(..., { kind: "thinking", ... })` lines, and replace the `thinking` assertion block. Where the old test did `const { body } = await history(h, "alice", chatId);` use:

```ts
    const first = await history(h, "alice", chatId);
    const replyCursor = first.body.items[1]?.cursor as string;
    expect(first.body.items[1]?.reasoning).toBeNull(); // nothing recorded yet
    h.reasoning.set(replyCursor, { text: "Looking at the contract\n\nFound it", kind: "summary" });
    const { body } = await history(h, "alice", chatId);
```

   and replace `expect(user).toMatchObject({ ..., thinking: null, ... })` with `reasoning: null`, `expect(assistant?.thinking).toBe("Looking at the contract\n\nFound it");` with:

```ts
    expect(assistant?.reasoning).toEqual({ text: "Looking at the contract\n\nFound it", kind: "summary" });
    expect([user?.cursor, assistant?.cursor]).toEqual([expect.stringMatching(/^0\.\d+$/), replyCursor]);
    // reasoning is asked for replies only, with their turn keys, in one call per page
    expect(h.reasoning.calls.at(-1)).toEqual([{ cursor: replyCursor, turnKey: 1 }]);
```

- In "joins each reply to its own turn's items by turn key, across several turns": the loop that put `thinking` items becomes a loop that puts one `tool` item per turn, and the final expectation becomes:

```ts
    for (const n of [1, 2, 3])
      await h.wiring.items.put(ref(chatId), n, `conv#o${n}#turn:0:tool:0`, {
        kind: "tool",
        body: { name: "search_docs", label: `step ${n}`, count: n },
      });
    const { body: three } = await history(h, "alice", chatId);
    const replies = three.items.filter((m) => m.role === "assistant");
    expect(replies.map((m) => m.steps.map((s) => s.label))).toEqual([["step 1"], ["step 2"], ["step 3"]]);
    expect(h.reasoning.calls.at(-1)?.map((r) => r.turnKey)).toEqual([1, 2, 3]);
```

   (keep whatever the test did to fetch `replies`; only the put loop and the last expectation change).
- Add:

```ts
  it("asks for no reasoning on a page of user messages, and shows what the store gives as it is", async () => {
    const chatId = await seedChat(h, ALICE);
    h.fake.addTurn(convOf(chatId), { question: "q", answer: "a" });
    const before = h.reasoning.calls.length;
    const { body } = await history(h, "alice", chatId);
    const reply = body.items[1];
    h.reasoning.set(reply?.cursor as string, { text: "", kind: "redacted" });
    const again = await history(h, "alice", chatId);
    expect(again.body.items[1]?.reasoning).toEqual({ text: "", kind: "redacted" });
    expect(h.reasoning.calls.length).toBeGreaterThan(before);
    expect(h.reasoning.calls.flat().every((r) => r.cursor !== body.items[0]?.cursor)).toBe(true);
  });
```

**Step 3 implementation: replace `toMessageDtos`** (the helper functions around it stay):

```ts
export async function toMessageDtos(
  deps: MessageDeps,
  identity: Identity,
  chatId: string,
  entries: readonly HistoryEntry[],
): Promise<ChatMessageDto[]> {
  // A rejected record has turn 0 and no turn of its own: it has no items.
  const keyOf = (e: HistoryEntry) => (e.role === "assistant" && e.turn >= 1 ? turnKeyOf(e) : undefined);
  const ref = { tenantId: identity.tenantId, userId: identity.userId, chatId };
  const keys = [...new Set(entries.flatMap((e) => keyOf(e) ?? []))];
  const items = keys.length > 0 ? await deps.chat.items.forTurns(ref, keys) : new Map<number, TurnItem[]>();
  // Reasoning is Loom's (ADR 0133): one grouped read per page, keyed by the reply's cursor. Display only: a read
  // that fails gives null for that reply (replyReasoning logs the class).
  const replies = entries.flatMap((e) => {
    const turnKey = keyOf(e);
    return turnKey === undefined ? [] : [{ cursor: e.cursor, turnKey }];
  });
  const reasoning = await deps.reasoning.forReplies(ref, chatConversationId(identity.userId, chatId), replies);
  const documentIds = new Set<string>();
  for (const list of items.values())
    for (const item of list)
      if (item.kind === "passages") for (const p of item.body.passages) documentIds.add(p.documentId);
  const titles = await documentTitles(deps.pool, deps.fields, identity, [...documentIds]);

  return entries.map((e): ChatMessageDto => {
    const base = {
      id: String(e.ord ?? e.cursor),
      cursor: e.cursor,
      turn: e.turn,
      role: e.role,
      status: statusOf(e.status),
      createdAt: new Date(e.at ?? 0).toISOString(),
    };
    if (e.role === "user") {
      return { ...base, text: e.text, citations: [], reasoning: null, steps: [], outcome: null };
    }
    const turnItems = items.get(keyOf(e) ?? -1) ?? [];
    const retrieved: StoredPassage[] = [];
    const steps: ChatMessageDto["steps"] = [];
    let outcome: ChatMessageDto["outcome"] = null;
    for (const item of turnItems) {
      if (item.kind === "passages") retrieved.push(...item.body.passages);
      else if (item.kind === "tool") steps.push(item.body);
      else outcome = item.body.kind;
    }
    const cited = citeReply(e.text, retrieved, titles);
    // A complete, empty reply with no recorded outcome is a loop that ran out of iterations (H11).
    if (outcome === null && e.status === "complete" && e.text.trim() === "") outcome = "max_iterations";
    return {
      ...base,
      text: cited.text,
      citations: cited.citations,
      reasoning: reasoning.get(e.cursor) ?? null,
      steps,
      outcome,
    };
  });
}
```

Import `chatConversationId` from `./ids` in `messages.ts` and `ReplyReasoning` into `MessageDeps` (`MessageDeps = Pick<ChatRouteDeps, "pool" | "fields" | "chat" | "reasoning">`). Commit message of 151a: `feat(chats): GET /api/chats/:id/messages with citations, reasoning and steps`. Task 151b (send) is unchanged.

### Task 152 (stream): `reasoning` kinds, hub-fed; the endpoint becomes 152c

**Header and split.** "live `thinking` and `tool` from the `ChatBus`" becomes "live `reasoning` from the hub and `tool` from the `ChatBus`". The split is 152a (durable half), 152b (live kinds), **152c (`GET /api/chats/:id/reasoning`)**, stacked in that order.

**Interfaces.** Consumes drops `ChatBus.partial`; adds `ConversationHub.reasoningPartialOf`, `LiveEvent` `type: "reasoning"`, Task 163 `reasoningBody`, `ChatWiring.reasoning`. The "Two turn numbers" paragraph is replaced by: "`reasoning`, `reasoning-partial`, `answer` and `reset` carry the hub's accepted-turn number (`turn`, the `turn` of a `ChatMessageDto`). Only `tool` and `tool-reset` carry the bus's turn key (`turnKey`, what the side table uses). `reasoning` and `reset` are loom-ui `ChatFeed` events exactly."

**The wire table** is replaced by:

| Event | `id:` | `data:` |
|---|---|---|
| `status` | none | `{ state, running, turns }` |
| `message` | the history cursor `<generation>.<sequence>` (also `ChatMessageDto.cursor`) | a `ChatMessageDto` |
| `reasoning` | none | `{ turn, text }`: a delta of the model's reasoning |
| `reasoning-partial` | none | `{ turn, text }`: what the running turn has produced so far, once, for a late joiner |
| `tool` | none | `{ turnKey, step }` |
| `tool-reset` | none | `{ turnKey }`: a retried model call; drop that turn's tool steps |
| `answer` | none | `{ turn, text }` |
| `reset` | none | `{ turn }`: from the hub; idempotent for the client; clears the turn's answer AND reasoning |
| `closed` | none | `{}` |
| `error` | none | `{ code }` with `invalid_cursor`, `not_found`, `too_many_streams` or `internal` |

**152a.** In `stream.ts`'s durable loop delete the three lines that ended the bus partial (`// The reply is durable: a later joiner must not be shown its thinking again.`, `const key = ...`, `if (key !== undefined) deps.chat.bus.end(chatId, key);`), and the `turnKeyOf` import if nothing else uses it. The hub forgets a finished turn's partial itself.

**152b: replace Step 6's first three cases and delete the fourth** ("does not show a finished turn's thinking to a joiner..."; nothing in DocMind holds that state any more). Add `import { tainted } from "@loom/classify";` and use:

```ts
  const step = { name: "search_docs", label: 'Searched documents: "x"', count: 3 } as const;

  it("carries reasoning, tool and answer events live, in the order they were published, as their own kinds", async () => {
    const chatId = await seedChat(h, ALICE);
    const s = await open("alice", chatId);
    await s.next();
    await s.next();
    h.wiring.hub.publish(convOf(chatId), { type: "reasoning", conversationId: convOf(chatId), turn: 1, text: "Looking" });
    h.wiring.bus.publish(chatId, { kind: "tool", turnKey: 1, step });
    h.wiring.hub.publish(convOf(chatId), { type: "delta", conversationId: convOf(chatId), turn: 1, text: "Hel" });
    expect(await s.next()).toBe('event: reasoning\ndata: {"turn":1,"text":"Looking"}');
    expect(await s.next()).toBe('event: tool\ndata: {"turnKey":1,"step":{"name":"search_docs","label":"Searched documents: \\"x\\"","count":3}}');
    expect(await s.next()).toBe('event: answer\ndata: {"turn":1,"text":"Hel"}');
    s.close();
  });

  it("tells a late joiner what the running turn has reasoned and answered so far, once, before anything new", async () => {
    const chatId = await seedChat(h, ALICE);
    // The hub keeps the in-progress reasoning and reply of a running turn; produce them the way the model effect does.
    await withTurnScope(convOf(chatId), 2, new AbortController().signal, async () => {
      h.wiring.hub.deltaSink()("Part of the answer");
      h.wiring.hub.reasoningSink()(tainted("So far", "llm-reasoning:s"));
    });
    const s = await open("alice", chatId);
    await s.next();
    await s.next();
    expect(await s.next()).toBe('event: reasoning-partial\ndata: {"turn":2,"text":"So far"}');
    expect(await s.next()).toBe('event: answer\ndata: {"turn":2,"text":"Part of the answer"}');
    s.close();
  });

  it("sends reset and tool-reset when a re-run restarts a turn, and delivers nothing of another chat", async () => {
    const [mine, theirs] = [await seedChat(h, ALICE), await seedChat(h, ALICE)];
    const s = await open("alice", mine);
    await s.next();
    await s.next();
    h.wiring.bus.publish(theirs, { kind: "tool", turnKey: 1, step });
    h.wiring.hub.publish(convOf(theirs), { type: "reasoning", conversationId: convOf(theirs), turn: 1, text: "NOT FOR THIS STREAM" });
    h.wiring.hub.publish(convOf(mine), { type: "reset", conversationId: convOf(mine), turn: 3 });
    h.wiring.bus.publish(mine, { kind: "reset", turnKey: 5 });
    h.wiring.hub.publish(convOf(mine), { type: "reasoning", conversationId: convOf(mine), turn: 3, text: "again" });
    expect(await s.next()).toBe('event: reset\ndata: {"turn":3}');
    expect(await s.next()).toBe('event: tool-reset\ndata: {"turnKey":5}');
    expect(await s.next()).toBe('event: reasoning\ndata: {"turn":3,"text":"again"}');
    s.close();
  });
```

**152b Step 7: replace `attachLive`** (imports `LiveEvent`, `SubscriberLimitError`, `ChatBusLimitError`, `LiveChatEvent` as before):

```ts
/**
 * Subscribes to the hub (answer and reasoning deltas, resets) and the bus (tool steps, tool resets), then sends what
 * a turn that is already running has produced. The subscriptions come first, so nothing published in between is
 * lost, and the whole function is synchronous: it runs in the same tick as the status frame.
 */
function attachLive(deps: ChatStreamDeps, c: StreamCall, sink: SseSink, cleanups: (() => void)[]): void {
  const answer = (turn: number, text: string) => frame("answer", { turn, text });
  const reasoning = (turn: number, text: string) => frame("reasoning", { turn, text });
  const onHub = (e: LiveEvent) => {
    if (e.type === "reset") return void sink.send(frame("reset", { turn: e.turn }));
    // Reasoning is its own coalescing channel, so a burst of it never delays or merges into the answer's frames.
    if (e.type === "reasoning") return void sink.delta(e.turn, e.text, reasoning, "reasoning");
    sink.delta(e.turn, e.text, answer);
  };
  // Bus events carry the turn key; hub events the accepted-turn number (see the wire table). Each keeps its own name.
  const onBus = (e: LiveChatEvent) => {
    if (e.kind === "reset") return void sink.send(frame("tool-reset", { turnKey: e.turnKey }));
    sink.send(frame("tool", { turnKey: e.turnKey, step: e.step }));
  };
  try {
    cleanups.push(deps.chat.hub.subscribe(c.conversationId, onHub));
    cleanups.push(deps.chat.bus.subscribe(c.chatId, onBus));
  } catch (err) {
    if (!(err instanceof SubscriberLimitError || err instanceof ChatBusLimitError)) throw err;
    sink.send(frame("error", { code: "too_many_streams" }));
    return;
  }
  // The stream is the chat owner's alone (the route loaded the chat row with user_id = identity), which is the
  // audience Loom's own SSE gives reasoning in owner mode.
  const thought = deps.chat.hub.reasoningPartialOf(c.conversationId);
  if (thought) sink.send(frame("reasoning-partial", { turn: thought.turn, text: thought.text }));
  const text = deps.chat.hub.partialOf(c.conversationId);
  if (text) sink.send(frame("answer", { turn: text.turn, text: text.text }));
  cleanups.push(c.schedule(() => sink.send(": ping\n\n"), deps.heartbeatMs ?? 15_000));
}
```

Step 8's commit message becomes `feat(chats): live reasoning, tool and answer events on the chat stream`.

#### Task 152c: `GET /api/chats/:id/reasoning?cursor=`

**Files:**
- Create: `apps/server/app/chats/reasoningRoutes.ts`
- Modify: `apps/server/app/chats/routes.ts` (spread `chatReasoningRoutes`), `apps/server/app/chats/testHarness.ts` (helper)
- Test: `apps/server/app/chats/reasoning.pg.test.ts`

**Interfaces:**
- Consumes: Task 163 `reasoningBody`; Task 133/158 `ReasoningQuery`, `ReasoningResponse`; Task 149 `loadChat`, `principalOf`, `notFound`, `ChatRouteDeps`; `ChatWiring.conversations`, `.reasoning`; `InvalidCursorError`, `ConversationNotFoundError`.
- Produces: `REASONING_ROUTE = "GET /api/chats/:id/reasoning"`; `chatReasoningRoutes(deps): Record<string, Handler>`: 200 `ReasoningResponse`; 400 `invalid_request` (no cursor) / `invalid_cursor`; 404 `not_found` (not the owner's chat, an unknown cursor, a user message, a deleted chat). The route is a plain JSON GET: not a streaming route, no `streamingRoutes` entry.

- [ ] **Step 1: Harness additions** (read `testHarness.ts` first; names below are the contract, adapt the plumbing). The harness's fake `Conversations` gets `reasoningTarget(conversationId, cursor, options)`: for a cursor of a known assistant reply of a chat owned by `options.principal.actor` it returns `{ executionId: conversationId, stepPrefix: "conv#o<turnKey>#" }` (the turn key of that reply), for a user message, an unknown or foreign cursor it throws `new ConversationNotFoundError(conversationId)`, for a malformed cursor `new InvalidCursorError()`. The harness exposes the array-backed log its `deps.eventStore` reads from as `h.log: { executionId: string; eventType: string; payload: unknown }[]` (`eventStore.read = async (id) => h.log.filter((e) => e.executionId === id)`), and:

```ts
/** Records `text` as the reasoning of the reply of turn `turnKey`, the way the model effect does (Loom's own capture), and returns the reply's cursor. */
export async function seedReasoning(h: ChatHarness, who: Who, chatId: string, turnKey: number, text: string): Promise<string>;
```

   implemented with `captureReasoning([{ kind: "summary", text, signature: "S", provider: "anthropic" }], { store: h.wiring.reasoning, model: "m" }, ctx)` inside `chatScope.run({ tenantId: who.tenantId, userId: who.userId, chatId, turnKey, stepKey, attempt: 1 }, ...)` with `ctx` from `modelCtx({ executionId: chatConversationId(who.userId, chatId), stepId: "conv#o<turnKey>#turn:0", emit })` pushing to `h.log`, then a `STEP_COMPLETED` event for that step, after seeding the reply itself with `h.fake.addTurn(...)`; it returns that reply's history cursor (the `cursor` of the second item of `GET .../messages`).

- [ ] **Step 2: Write the failing tests** (`reasoning.pg.test.ts`):

```ts
import { ReasoningResponse } from "@docmind/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_URL } from "../db/testSupport";
import { ALICE } from "../documents/testHarness";
import { chatConversationId } from "./ids";
import { type ChatHarness, seedChat, seedReasoning, startChatServer } from "./testHarness";

describe.skipIf(!PG_URL)("GET /api/chats/:id/reasoning (needs DOCMIND_TEST_PG_URL)", () => {
  let h: ChatHarness;
  beforeAll(async () => {
    h = await startChatServer();
  });
  afterAll(async () => {
    await h.close();
  });
  const get = (user: string, chatId: string, query: string) => h.req(user, "GET", `/api/chats/${chatId}/reasoning${query}`);

  it("returns Loom's body for a reply: steps, attempts, parts, text unwrapped", async () => {
    const chatId = await seedChat(h, ALICE);
    const cursor = await seedReasoning(h, ALICE, chatId, 1, "Weighing the payment terms.");
    const res = await get("alice", chatId, `?cursor=${cursor}`);
    expect(res.status).toBe(200);
    expect(ReasoningResponse.parse(await res.json())).toEqual({
      steps: [
        {
          stepId: "conv#o1#turn:0",
          recordedAttempt: 1,
          attempts: [
            { attempt: 1, provider: "anthropic", model: "m", recorded: true, parts: [{ kind: "summary", status: "ok", text: "Weighing the payment terms." }] },
          ],
        },
      ],
    });
  });

  it("is the owner's alone: another user and a missing chat are 404, and learn nothing about the cursor", async () => {
    const chatId = await seedChat(h, ALICE);
    const cursor = await seedReasoning(h, ALICE, chatId, 1, "Private reasoning about the contract.");
    for (const [user, id] of [["alice2", chatId], ["alice", "00000000-0000-4000-8000-000000000000"]] as const) {
      const res = await get(user, id, `?cursor=${cursor}`);
      expect([res.status, (await res.json()).error.code]).toEqual([404, "not_found"]);
    }
    expect(await (await get("alice2", chatId, "?cursor=0.2")).text()).not.toContain("Private");
  });

  it("is 404 for a user message, an unknown cursor and a cursor of another turn without reasoning, and 400 for a missing or malformed cursor", async () => {
    const chatId = await seedChat(h, ALICE);
    const cursor = await seedReasoning(h, ALICE, chatId, 1, "Some reasoning for the first reply.");
    const history = await (await h.req("alice", "GET", `/api/chats/${chatId}/messages`)).json();
    const userCursor = history.items[0].cursor as string; // the question: a user record has no reasoning
    expect((await get("alice", chatId, `?cursor=${userCursor}`)).status).toBe(404);
    expect((await get("alice", chatId, "?cursor=0.999")).status).toBe(404);
    const none = await get("alice", chatId, "");
    expect([none.status, (await none.json()).error.code]).toEqual([400, "invalid_request"]);
    const bad = await get("alice", chatId, "?cursor=banana");
    expect([bad.status, (await bad.json()).error.code]).toEqual([400, "invalid_cursor"]);
  });

  it("answers an empty step list for a reply that kept no reasoning, and works without a Claude key", async () => {
    const noKey = await startChatServer({ available: false });
    const chatId = await seedChat(noKey, ALICE);
    noKey.fake.addTurn(chatConversationId(ALICE.userId, chatId), { question: "q", answer: "a" });
    const history = await (await noKey.req("alice", "GET", `/api/chats/${chatId}/messages`)).json();
    const res = await noKey.req("alice", "GET", `/api/chats/${chatId}/reasoning?cursor=${history.items[1].cursor}`);
    expect([res.status, await res.json()]).toEqual([200, { steps: [] }]);
    await noKey.close();
  });
});
```

- [ ] **Step 3: Run, see them fail** (`DOCMIND_TEST_PG_URL` exported in the same command). Expected: FAIL (404 for every route: it is not mounted).

- [ ] **Step 4: Implement `reasoningRoutes.ts`** and mount it (in `routes.ts` add `...chatReasoningRoutes(deps)` after `...chatMessageRoutes(deps)`, same pattern as Task 151a):

```ts
import { ReasoningQuery } from "@docmind/contracts";
import { ConversationNotFoundError, InvalidCursorError } from "@loom/conversation";
import { requireAuth } from "../http/requireAuth";
import { type Handler, json, sendError } from "../http/respond";
import { loadChat, notFound, principalOf } from "./access";
import { chatConversationId } from "./ids";
import { reasoningBody } from "./reasoningRead";
import type { ChatRouteDeps } from "./routes";

export const REASONING_ROUTE = "GET /api/chats/:id/reasoning";

/**
 * The model's reasoning of one reply, durable (ADR 0133 D6; the shape of Loom's own endpoint, so loom-ui's
 * `ChatFeed({ reasoning: { durable: true } })` can fetch it). Two owner checks: the chat row (`user_id = identity`,
 * not deleted) and Loom's `reasoningTarget`, which in owner mode serves the owner alone and answers every other
 * case (unknown cursor, a user message, someone else) with the same not-found.
 */
export function chatReasoningRoutes(deps: ChatRouteDeps): Record<string, Handler> {
  return {
    [REASONING_ROUTE]: requireAuth(deps.authenticator, async (req, res, identity, ctx) => {
      const chat = await loadChat(deps, identity, ctx);
      if (!chat) return notFound(res);
      const url = new URL(req.url ?? "/", "http://localhost");
      const query = ReasoningQuery.safeParse(Object.fromEntries(url.searchParams));
      if (!query.success) return sendError(res, 400, "invalid_request", "a cursor is required");
      try {
        const body = await reasoningBody(
          { conversations: deps.chat.conversations, log: deps.eventStore, store: deps.chat.reasoning },
          { tenantId: identity.tenantId, userId: identity.userId, chatId: chat.id },
          chatConversationId(identity.userId, chat.id),
          query.data.cursor,
          { principal: principalOf(identity) },
        );
        json(res, 200, body);
      } catch (err) {
        if (err instanceof InvalidCursorError) return sendError(res, 400, "invalid_cursor", "cursor is not valid");
        if (err instanceof ConversationNotFoundError) return notFound(res);
        throw err;
      }
    }),
  };
}
```

- [ ] **Step 5: Run the tests, then the gate. Commit** with `feat(chats): GET /api/chats/:id/reasoning, the durable reasoning of a reply`. Open the stacked draft PR.

### Task 155 (acceptance): reasoning, the proof and a restart in the middle of a tool loop

**`e2eSupport.ts`.** `searchTurn` uses a signature long enough for the proof's 12-character scan: add `export const SIG = "sigA-Zq8Lm2Vx9Rt4Ns6Hd1Wk3Pf7";` and replace `{ signature: "sig-1" }` with `{ signature: SIG }`.

**155a golden test changes (`golden.e2e.pg.test.ts`).**
- Title: "streams reasoning, a tool step and the answer, ...". Import `SIG` from `./e2eSupport`.
- Step 4: `expect(kinds).toEqual(["status", "message", "reasoning", "tool", "answer", "message"]);`; `live("thinking")` becomes `live("reasoning")`: `expect(live("reasoning").map((d) => d.text).join("")).toBe("I should look for the payment terms."); expect(live("reasoning")[0]?.turn).toBe(1);`.
- Step 5: the reply expectation's `thinking: "..."` becomes `reasoning: { text: "I should look for the payment terms.", kind: "summary" }`; add `cursor: expect.stringMatching(/^0\.\d+$/)`.
- Step 6 becomes: "the second model request carried the first one's thinking block, with its text and signature, ahead of the tool call":

```ts
      const second = claude.requests.filter((r) => r.body.model !== "title-model")[1];
      const assistantTurn = second?.body.messages.find((m) => m.role === "assistant");
      expect(assistantTurn?.content[0]).toMatchObject({ type: "thinking", thinking: "I should look for the payment terms.", signature: SIG });
      expect(assistantTurn?.content.some((b) => b.type === "tool_use")).toBe(true);
```

- New step 7b, after the reload (7): the durable endpoint returns the same reasoning, and nobody else gets it.

```ts
      const durable = await st.chatReq(ada.cookie, "GET", `/api/chats/${chat.id}/reasoning?cursor=${reply.cursor}`);
      expect(durable.status).toBe(200);
      const body = ReasoningResponse.parse(await durable.json());
      expect(body.steps.flatMap((s) => s.attempts.flatMap((a) => a.parts.map((p) => [p.kind, p.status, p.text])))).toEqual([
        ["summary", "ok", "I should look for the payment terms."],
      ]);
      const bob = await st.signUpAndLogIn("bob@example.com");
      expect((await st.chatReq(bob.cookie, "GET", `/api/chats/${chat.id}/reasoning?cursor=${reply.cursor}`)).status).toBe(404);
      const userCursor = ChatMessageDto.parse(userFrame?.data).cursor; // a user message has no reasoning
      expect((await st.chatReq(ada.cookie, "GET", `/api/chats/${chat.id}/reasoning?cursor=${userCursor}`)).status).toBe(404);
```

  (add `ReasoningResponse` to the contracts import).
- Step 9 (the proof over the whole stack): the `assertNoPlaintext` list adds `SIG`; the `arrayContaining` list adds `"STEP_COMPLETED:output.reasoning"` and `"LLM_REASONING_CAPTURED:parts"`; the `chat_turn_items` block becomes `expect(items.rowCount).toBeGreaterThanOrEqual(2); // tool, passages` (the comment "thinking, tool, passages" goes), and after it:

```ts
      const texts = await st.db.owner.query("SELECT text_enc FROM chat_reasoning_texts WHERE chat_id = $1", [chat.id]);
      expect(texts.rowCount).toBeGreaterThanOrEqual(1); // the first model frame's summary
      for (const { text_enc } of texts.rows) {
        expect(text_enc.__loomEnc).toBeDefined();
        expect(JSON.stringify(text_enc)).not.toContain("payment terms");
      }
      expect(raw.some((e) => e.eventType === "LLM_REASONING_CAPTURED")).toBe(true);
```

**155b: add a restart test** to the restart file (same `describe`), the proof that A10 holds with Postgres and the real recovery:

```ts
  it(
    "a restart in the middle of a tool loop keeps the thinking block: the recovered model call sends it back with its text and signature",
    async () => {
      const first = await startIngestStack({ chat: true });
      stacks.push(first);
      const claude1 = first.claude;
      if (!claude1) throw new Error("no fake Claude");
      const ada = await first.signUpAndLogIn("ada@example.com");
      const events = await first.events(ada.cookie);
      const up = await first.upload(ada.cookie, "terms.txt", Buffer.from(DOC));
      const documentId = ((await up.json()) as UploadDocumentResponse).document.id;
      await first.until(events, documentId, (s) => s === "ready" || s === "failed");
      events.close();
      // the first request thinks and searches; the second parks mid-answer, so the server stops with the tool loop unfinished
      scriptChat(claude1, () => ({ stream: { steps: [{ text: "Due " }, { hold: true }, { text: "in 30 days." }, { stop: "end_turn" }] } }));
      const chat = ChatSessionDto.parse(await (await first.chatReq(ada.cookie, "POST", "/api/chats", {})).json());
      await first.chatReq(ada.cookie, "POST", `/api/chats/${chat.id}/messages`, { text: "When is payment due?" });
      const gate = await claude1.streamHold(); // the second model call is under way
      expect(gate).toBeDefined();
      await first.close({ keepDb: true });
      stacks.pop();

      const second = await startIngestStack({ chat: true, resume: { db: first.db, kek: first.kek, root: first.root } });
      stacks.push(second);
      const claude2 = second.claude;
      if (!claude2) throw new Error("no fake Claude");
      scriptChat(claude2, () => ({ stream: { steps: [{ text: "Due in 30 days." }, { stop: "end_turn" }] } }));
      const stream2 = await second.openChat(ada.cookie, chat.id);
      const reply = ChatMessageDto.parse((await collectUntil(stream2, isReply)).at(-1)?.data);
      stream2.close();
      expect(reply).toMatchObject({ status: "complete", text: "Due in 30 days." });
      // the recovered call is a live call: Loom resolved the first block's text from OUR store through the owner's key
      const resumed = claude2.requests.filter((r) => r.body.model !== "title-model")[0];
      const assistantTurn = resumed?.body.messages.find((m) => m.role === "assistant");
      expect(assistantTurn?.content[0]).toMatchObject({ type: "thinking", thinking: "I should look for the payment terms.", signature: SIG });
      expect(resumed?.body.messages.some((m) => m.content.some((b) => b.type === "tool_result"))).toBe(true);
    },
    120_000,
  );
```

  (imports: `SIG` from `./e2eSupport`.) **Probe and fallback:** this test depends on Task 147c's recovery re-driving a model step that shutdown left un-completed. If the recovered turn does not complete within the test timeout, recovery is the cause, not reasoning. Then replace the last block of assertions by a store-level check that proves the same property (the text survives a restart): after `first.close`, build a fresh `ChatReasoningStore(new PgReasoningRows(pool), fields)` on `second`'s pool and `readReasoningBounded(second's decrypting log, store.readerFor(ref), { executionId, stepPrefix: "conv#o1#" })` returns `status: "ok"` with the text; record in the PR body that recovery of an interrupted step is covered by Task 147c's own tests.

### Task 157 (spec, README): what changes

Apply these replacements to Step 1 and Step 2 of the M4 plan's Task 157; every other bullet stands.

- **§3.1, `LlmProvider` row:** "`packages/llm-anthropic` on `fetch` with its own byte-capped SSE reader (no `@anthropic-ai/sdk`; open question 7); streaming, effort, cache breakpoints and, from the M4 amendment, Loom's ADR 0133 reasoning contract (reasoning parts, layout, live reasoning deltas, `capabilities.reasoning`). Loom's own `AnthropicProvider` is not used: it sends no effort or cache breakpoints, reports no refusal or cache usage, and puts the response body in its errors."
- **§3.2:** add a row "`@loom/llm` model reasoning (ADR 0133): `createAgentModelEffect(..., { reasoning })` captures, `ConversationHub.reasoningSink` streams, `Conversations.reasoningTarget` plus `readReasoningBounded` read it back. DocMind supplies the `ReasoningStore`, sealed under the owner's key." The `@loom/plugin-conversation-sse` row stays ("`frame` and `SseSink` only").
- **§4.1,** the chat row: "Chat messages: Loom event log. Citations and tool steps: sealed `chat_turn_items`, merged on read. Model reasoning: Loom's ADR 0133 capture; the readable text is a sealed `chat_reasoning_texts` row, the signatures are sealed in the log."
- **§4.2:** replace "Add `chat_turn_items` and `chat_reasoning_blocks` with their columns and the unique key (D5)" with: "Add `chat_turn_items` (kinds `tool`, `passages`, `outcome`; columns and the unique key as D5) and `chat_reasoning_texts (tenant_id, user_id, chat_id, address, text_enc, created_at)`: `address` is 32 random hex digits, the composite foreign key to `chat_sessions` cascades, RLS `tenant_isolation`."
- **§4.4:** the sealed list becomes `chat_sessions.title_enc` (`chat:<id>:title`), `chat_turn_items.body_enc` (`chatitem:<id>`), `chat_reasoning_texts.text_enc` (`chatreasoning:<chatId>:<address>`), and every conversation event path that can hold content, including `STEP_COMPLETED` `output.reasoning` and `output.layout` and `LLM_REASONING_CAPTURED` `parts` (signatures, text references, digests, sizes). Trade-offs: `ord`, `kind` and `step_key` of a turn item and the capture event's `stepId`, `attempt`, `provider` and `model` are plaintext; the live reasoning, partial answer and stop registry live in process memory only (D16); crypto-shredding the owner's key leaves the references in the log dangling, which Loom reports as erased and treats as a hole in continuation.
- **§6.1:** the stream list becomes "`status`, `message`, `reasoning`, `reasoning-partial`, `tool`, `tool-reset`, `answer`, `reset`, `closed`, `error`"; `reasoning`, `reasoning-partial` and `reset` are loom-ui's `ChatFeed` events. Add the ninth route: `GET /api/chats/:id/reasoning?cursor=<a reply's cursor>`: the reply's durable reasoning in Loom's `/reasoning` body shape (`steps`, `attempts`, `parts`, `truncated`), owner only (404 otherwise), at most 256 parts and 1 MiB. `ChatMessageDto` carries `reasoning` (folded, bounded) and `cursor`.
- **§6.5:** replace the bullets about thinking with: "Reasoning follows Loom's ADR 0133: the provider returns the model's summarized thinking and the order of its blocks; Loom records the signatures in the log, keeps the readable text in a sidecar store (DocMind's, sealed under the owner's key), sends the signed blocks back unchanged within one tool loop and drops them on any edit; a restart in the middle of a loop keeps them because both live in durable storage. What the API returns with `display: "summarized"` is a summary, never the raw chain of thought, and is shown as such. Across turns the history is text only, which the API accepts. A refused or stopped reply keeps no durable reasoning. The stream and history show reasoning as `reasoning` kinds and `ChatMessageDto.reasoning`."
- **§9:** item 28 also cites 152c; add "(M4 amendment, Tasks 158 to 163)" to item 31.
- **§10:** add two rows: "Loom's Anthropic reasoning mapping and DocMind's FakeAnthropic rest on recorded wire shapes, not on a live API (ADR 0133); the opt-in real-API suite is the check | run it before relying on continuation in production" and "Event log growth: Loom re-sends every earlier signature in each model frame's `STEP_STARTED.input.messages` (about 36 part copies for a loop of 8 iterations), sealed | accepted". The existing "thinking is not carried across turns" row stays.
- **README.org:** the status paragraph gains "...with the model's reasoning shown and stored through Loom's ADR 0133 capture (sealed per user)." No new configuration variable. The design note `docs/design/linked-retrieval.md` is unchanged.
- **Plan header edit (once, here):** in the M4 plan's header, "Loom stays pinned at `006dfdaf…`" becomes "Loom is pinned at `58fb2f5c…` (ADR 0133)"; its table row "Thinking, preserved thinking blocks, refusals" and the `thinking` / `tool` / `answer` row are annotated "superseded by the M4 amendment".

---

## Self-review

### Every removed or changed export, its consumers, and where each is handled

| Removed or changed | Consumers (grep at `23e19a9`) | Handled in |
|---|---|---|
| `CallObserver.blocksFor` | `provider.ts` (`#body`); `chats/observer.ts`; `__helpers__/observer.ts`; `provider.test.ts`, `observer.test.ts` | 159a (provider, helper, tests; the app literal's member) |
| `CallObserver.onThinking`, `onBlocks` | `provider.ts` (`complete`, `stream`); `chats/observer.ts`; `__helpers__/observer.ts`; `provider.test.ts`, `provider.stream.test.ts`, `conformance.test.ts`, `observer.test.ts` | 159b (app), 159c (package) |
| `ReasoningBlock`, `isReasoningBlock`, `coversToolUses` (package root) | `request.ts`, `mapping.ts`, `response.ts`, `streamState.ts`, `provider.ts`, `index.ts`; app: `turnItems.ts`, `testing.ts` | 159a/159c (package); `testing.ts` 160a; `turnItems.ts` 160b |
| `BodyOptions.reasoning`, `toolUseGroups` | `provider.ts`; `request.test.ts` | 159a |
| `StreamState` constructor callback; `StreamEnd.{toolCalls, sawThinking}`; `Parsed.{text, toolCalls, thinking, sawThinking}` | `provider.ts` only (no direct test of `StreamState` or `parseResponse`) | 159c |
| `AnthropicMessagesProvider.capabilities` (now computed) | ingest providers (summarize, vision) read `.image` / `.file`; unchanged values. `reasoning` is absent unless `thinking: true`, so Loom's boot warning does not name them | 159c (capability test) |
| `PgReasoningBlocks`, `chatBlocksBind`, `MAX_TOOL_USE_IDS`, `chat_reasoning_blocks` | `pgCollaborators.ts`, `wiring.ts` (`blocks` collaborator), `testing.ts` (`FakeBlocks`), `testStack.ts`, `wiring.test.ts`, `observer.test.ts`, `eventLog.chat.test.ts` (`stack.blocks`), `reasoningBlocks.pg.test.ts`, `turnItems.ts` | 159b (observer), 160a (collaborators, fakes, stack, one assertion), 160b (class, table, test) |
| `TurnItem` kind `thinking` | `observer.ts`, `model.ts` (stale-row cleanup), `turnItems.pg.test.ts`, `model.test.ts`, `observer.test.ts`; planned: Task 151 history | 159b, 160a, 160b; 151 (this file) |
| `ChatBus` thinking events, `partial()`, `end()`, `maxThinkingChars`, `maxChats` | `observer.ts`, `bus.test.ts`; planned: Task 152 (`attachLive`, durable loop) | 159b, 160a; 152 (this file) |
| `LiveChatEvent` `thinking` | same as above; `tools/` publish only `tool` and `reset` | 160a |
| `ChatMessageDto.thinking` | contracts test; planned Tasks 151, 152, 155 | 158; 151, 155 (this file) |
| `ChatStreamEvent` `thinking`, `reset.turnKey` | contracts test; planned Task 152 | 158; 152 (this file) |
| `chatObserver({ items, blocks, bus })` | `wiring.ts` | 159b |
| `ChatCollaborators.blocks` | `wiring.ts`, `pgCollaborators.ts`, `wiring.test.ts`, `testStack.ts` | 160a |
| Loom pin `006dfdaf` | `ci.yml`; the M4 plan header | 158; 157 (this file) |

Added exports and their first consumers: `ChatReasoningStore` (162 wiring; 163 readers; 152c), `ReasoningRows` / `PgReasoningRows` / `MemoryReasoningRows` (161, 162), `replyReasoning` / `ReplyReasoning` / `FakeReplyReasoning` (151, 163), `reasoningBody` (152c), `foldReasoning` / `memoLog` (163), `ChatReasoningDto` / `ReasoningResponse` / `ReasoningQuery` (158; 151, 152c).

### Type consistency with the code on the branch (read at `23e19a9`)

- `chatScope.current(): ChatCallScope | undefined` and `ChatCallScope extends ChatRef`, so `ChatReasoningStore`'s default `scope: () => ChatRef | undefined` accepts it, and `requireScope` copies the three fields (the scope's `turnKey` and `stepKey` never reach the rows).
- `chatModelEffect` already runs `inner.execute` inside `chatScope.run(scope, ...)` (`model.ts`), and `createLlmEffect` resolves request-time reasoning inside that execute, so the store's model-path `get` sees the scope. It already forwards every key of the inner effect (`reasoning`, `reasoningSink`) bound to it (`model.test.ts`, "forwards every key"), which the hub's live sink and Loom's boot posture need.
- `FieldCrypto.forUser(id).seal(bind, value)` takes any JSON value (the store seals a string), `openText` returns that string; `FieldKeyUnavailableError` is what `get` of a destroyed key throws, mapped to `null`.
- `PgTurnItems.put` and `remove` keep their signatures; `TurnItem["kind"]` loses one member, so `remove(..., "thinking")` stops compiling, which is the intended break (found by the grep gate).
- `LlmCapabilities` (from `@loom/llm`) has `reasoning?: boolean`; `hub.wrapProvider` copies `capabilities`, so the effect's hook is `capable: true` for the chat provider and `false` for ingest.
- `ConversationHub.reasoningSink()` returns `(delta: TaintedValue<string>) => void`, assignable to `LlmReasoningOptions.onDelta?: (delta, ctx) => void`.
- `HistoryEntry.cursor` is the string the plan already uses for the SSE id (`frame("message", message, item.entry.cursor)`), hence `ChatMessageDto.cursor`.
- `tsconfig.base.json` has `noUncheckedIndexedAccess` and no `exactOptionalPropertyTypes`: the new code spreads optional fields conditionally (the repo's idiom) and avoids `!`.
- `@loom/llm` exports `layoutOf`, `LlmLayoutEntry`, `LlmReasoningPart`, `captureReasoning`, `readReasoningBounded`, `reasoningStoreResolver`, `sealReasoningText`, `assistantMessageOf`, `LlmCapabilities` (verified in `packages/llm/src/index.ts` at `58fb2f5c`); `@loom/conversation` exports `generationId`, `parseCursor`, `ConversationNotFoundError`, `InvalidCursorError`, `withTurnScope`.

### Open risks and probes (each has a step above)

1. **Live-API acceptance** of Loom's reasoning mapping and of a tool-loop continuation whose thinking blocks were dropped (A11; Task 159c Step 9 with the fallback rule).
2. **Recovery re-drives an interrupted model step** (Task 155b's new test; fallback is a store-level check).
3. **Hub reasoning `turn` equals the accepted-turn number** (Task 162 probe 2).
4. **The activity fold and the read-model sensitive guard accept the new event types** (Task 162 probe 4).
5. **Migration edited in place** breaks a dev database that applied the old `0023` (A7).
6. **A refused or stopped reply keeps no durable reasoning, and live reasoning shown before a refusal stays until the durable message arrives** (A8).
7. **No cross-attempt dedupe in the store**: a crash-retry leaves an orphan row (A3), bounded by the chat's lifetime.
