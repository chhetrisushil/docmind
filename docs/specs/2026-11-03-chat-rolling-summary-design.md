# Rolling conversation summary: design

Date: 2026-11-03. Status: implemented on feat/chat-rolling-summary (summarizer; DocMind-only sealing via an event-store
decorator). One deviation, see Implementation notes.
Loom: `252cf914` (`@loom/conversation` `budget.summarizerToolId`, `@loom/agent` `createSummarizerEffect`, ADR 0137).

## Problem

A chat's prompt holds as many of the newest turns as fit `DOCMIND_CHAT_CONTEXT_TOKENS` (default 150,000). The turns
that no longer fit are dropped from the prompt: they stay in the chat's history, but the model forgets them, so in a
long chat it loses what was asked and settled early on. `chats/agent.ts` says so: "No summarizer: turns that fall out
of the window leave the prompt but stay in history."

## Goal

Turns evicted from the window are folded into a rolling summary that the model keeps seeing, as Loom's conversation
budget already supports. Everything the summary holds is sealed under the owner's key and erased with them, like the
rest of the chat. Conversations already running when this ships keep running unchanged.

Not goals: summarizing inside one turn's tool loop (`agentLoop$` compaction, which `conversation$` does not expose);
silencing Loom's transcript-growth warning; a separate summarizer model setting.

## How Loom does it (what DocMind configures)

With `budget.summarizerToolId` set, when a turn's prompt cannot hold every carried turn, `conversation$`:

1. runs the effect as step `conv#o<ord>:summarize` with input `{ messages }` (the evicted turns plus the previous
   summary, user words wrapped `tainted`), expecting `{ summary }`;
2. trims the result to `maxSummaryTokens` with `ctx.decide("conv#o<ord>:summary-fit", …)`, which records the trimmed
   summary as a `DECISION_RECORDED` event whose `choice` is the summary **string**;
3. carries `summary` in the conversation's state (so in every snapshot, and in `EXECUTION_STARTED.input.summary` of
   the next generation after a rotation) and injects it into the prompt as a fenced user message
   (origin `conversation:summary`).

A summarizer failure fails that turn (the reply is recorded `failed` with an error id), not the conversation.

## Design

### 1. The effect

`chat-summarize` = `createSummarizerEffect(llm.provider, { maxTokens: 1024 })`, registered with the chat's effects in
`prepareChat` (`chats/wiring.ts`) when an LLM is configured, and added to `CHAT_EFFECT_IDS` (`chats/ids.ts`) so the
strict-mode effect allowlist (`security.ts`) admits it for both chat flows.

- It uses the BARE provider `llm.provider`, never `hub.wrapProvider(...)`: the hub streams model deltas to the chat's
  live view, and a summary must not appear there as if it were the answer.
- Same model, same request timeout (`CHAT_REQUEST_TIMEOUT_MS` in the provider) and same retry behaviour as the chat's
  model calls. No new variable.
- Loom's default instruction (`DEFAULT_SUMMARIZER_INSTRUCTION`) is used; the transcript reaches the model fenced as
  untrusted user content.

### 2. The budget

Both chat flows (strict and general knowledge) get `budget.summarizerToolId: "chat-summarize"` and
`budget.maxSummaryTokens: 1024` (Loom's default is a quarter of the window, ~37,500 tokens, far more than a 1,024-token
summary needs; an explicit cap keeps the reservation small). `reserveOutputTokens` is unchanged. The comment in
`chats/agent.ts` is replaced by one describing the summary.

### 3. Rollout: a new flow version, the old one kept

Loom's flow hash covers the flow id and version, not the conversation's configuration, so the same `doc-chat` 1.0.0
with a summarizer would re-run an in-flight conversation under a different body: a conversation whose current
generation already evicted turns would ask for a `summarize` step its log never recorded, and Loom's replay-divergence
detector (ADR 0113) would fail its next turn.

So the summarizer ships as version **1.1.0** of both flows (`doc-chat`, and the general-knowledge flow), and **1.0.0
stays registered unchanged** (no summarizer):

- Loom's pinned resumption (ADR 0023 K11.2) resumes an in-flight execution on the registered version whose hash
  matches the one recorded at its start, so every conversation started before the deploy keeps running on 1.0.0.
- New conversations start on 1.1.0 (the `active` flow `prepareChat` returns).
- A 1.0.0 conversation moves to 1.1.0, and so gets the summary, at its next rotation (every 50 turns): Loom's
  continue-as-new starts the successor generation as "a fresh execution on current code", recording the hash of the
  flow registered now (ADR 0109 D3), and its carry (turns, pending, no summary yet) is the same shape on both
  versions. The rollout test asserts that the successor of a 1.0.0 generation records the 1.1.0 hash; if Loom resolves
  "current" to the version the predecessor ran instead, the test fails and old chats simply keep 1.0.0 (safe), which
  the implementer reports for a ruling.
- 1.0.0 can be removed in a later change once no 1.0.0 execution is live (a census query in the plan).

### 4. Sealing the summary

The summary is user content (it restates the user's questions and the document passages), so every place it lands
must be sealed under the owner's key, as spec §4.4 requires for the whole chat. Where it lands:

| Where | Today | Change |
|---|---|---|
| `STEP_STARTED` of `summarize`: `input.messages` | sealed | none |
| `STEP_COMPLETED` of `summarize`: `output.summary` | **plaintext** | add `output.summary` to `SENSITIVE_EVENT_PATHS.STEP_COMPLETED` |
| `DECISION_RECORDED` `conv#o<ord>:summary-fit`: `choice` (a string) | **plaintext** | the decorator below |
| conversation state (snapshots) | sealed (whole state, `sealState`) | none |
| `EXECUTION_STARTED.input.summary` (after a rotation) | sealed | none |

`DECISION_RECORDED.choice` cannot simply be added as a sealed path: sealed paths are per event type, and every
conversation record is a `DECISION_RECORDED` whose `choice` carries `status`, `turn` and `ord`. The chat-activity read
model folds a masked copy of those records and needs `choice.status`, and Loom's read-model leak guard would refuse its
integer counts once the records' numbers became sealed. Loom's `ctx.decide` has no per-decision sealing option.

#### The summary-choice decorator

`SummaryChoiceEventStore` (new, `apps/server/app/chats/summaryChoice.ts`) wraps the sealing event store
(`EncryptingEventStore`) and is what `createDurableStorage` hands Loom as `storage.eventStore`:

- **On every write path** (`append`, `appendBatch`, `appendIfUnchanged`, `copyPrefix` if it carries envelopes), an
  envelope that is a `DECISION_RECORDED` with `decisionId` matching `^conv#o[1-9][0-9]{0,8}:summary-fit$` and a string
  `choice` is rewritten to `choice: { docmindSummary: 1, text: <the string> }` before it reaches the sealing store,
  which then seals `choice.text` (already a sealed path). Nothing else is touched.
- **On every read path** (`read`, `readRange`, `subscribe` deliveries, and any other method returning envelopes after
  decryption), the reverse: a `DECISION_RECORDED` whose `choice` is exactly `{ docmindSummary: 1, text: string }` gets
  `choice` back as the string. So Loom's runtime (replay, resume, folds) sees exactly what it recorded.
- `readAtRest` (envelopes as stored, never decrypted) passes through untouched: it is the at-rest view.
- Every optional method of the event store SPI is forwarded (Loom's `installOptional` / `OPTIONAL_EVENT_STORE_METHODS`),
  and so are the structural markers (`forwardStoreMarkers`) **and** the properties `defineConfig` reads by shape off
  `storage.eventStore` to seal the inbox archive and senders: `keys`, `subjectOf`, `senderSubjectOf`. Losing them would
  make Loom write the inbox archive in plaintext without an error, so a test asserts the archive is still sealed.
- The rewritten envelope is a new object; the caller's envelope is never mutated.

Why this is safe: Loom computes no digest over decision payloads in DocMind's configuration (the audit-chain plugin is
not used; the inbox hash chain covers inbox messages only), and every reader of the decision goes through the
decorator, so the round trip is invisible to Loom. The read models' live folds go through the same stack and see the string; their catch-up and rebuild read the
stored (object) form through the tolerant source (`foldSource` in `compose.ts`), which is not wrapped. Either way the
chat-activity fold ignores it: the summary decision is not a conversation record (`recordOf` filters on its source). Logs written before this change
hold no `summary-fit` decision, so there is nothing to migrate.

What stays where: `createDurableStorage` returns the decorator as `storage.eventStore` and `sealed.eventStore`;
`crypto.events` (Loom's principal sealing) and `raw` are unchanged.

## Testing

- **Unit, the decorator** (in-memory inner store): a `summary-fit` string choice is stored as
  `{ docmindSummary: 1, text }` and read back as the string on `read`, `readRange` and `subscribe`; any other decision
  (a conversation record, a `summary-fit` whose choice is not a string, another event type) passes through
  byte-identical both ways; the caller's envelope is not mutated; Loom's `runEventStoreDecoratorConformance` passes
  (every optional method and marker forwarded); `keys`/`subjectOf`/`senderSubjectOf` are visible on the decorator.
- **The raw-log proof** (`chats/eventLog.chat.test.ts`, extended): a chat long enough to evict turns (small
  `contextTokens` and `maxTokens` in the test stack) writes a `summarize` step and a `summary-fit` decision; the raw
  log holds neither the summary text nor any turn text in the clear (`assertNoPlaintext`), `STEP_COMPLETED:output.summary`
  and `DECISION_RECORDED:choice.text` of the `summary-fit` decision are sealed, and the only key used is the owner's
  (plus Loom's sender keys).
- **Postgres e2e** (`chats/summary.e2e.pg.test.ts`): on the production composition, a chat evicts a turn; the
  summarizer request reaches the fake model with the evicted question (and never through the live stream); the next
  turn's prompt carries the summary as a fenced user message; a server restart replays the conversation without a
  divergence error and the following turn still carries the summary; the inbox archive is still sealed; erasing the
  user leaves the summary unreadable (the erasure residue scan passes).
- **Rollout**: a conversation started on 1.0.0 (the old flow registered alone), then the server restarted with 1.0.0
  and 1.1.0, answers its next turn on 1.0.0 with no `summarize` step even when it evicts; a new chat starts on 1.1.0;
  and a rotation of the 1.0.0 conversation starts its successor on 1.1.0 (see §3).
- **Failure**: a summarizer error fails that turn (reply status `failed`, error logged by class), the next turn works.

## Implementation notes

- **Failure (supersedes the Failure bullet above)**: Loom's `conversation$` calls `summarize()` outside the turn's
  try/catch, so a summarizer error would end the whole conversation, not fail one turn. DocMind wraps the effect
  (`tolerantSummarizer`, `apps/server/app/chats/summarizer.ts`): a provider error yields no summary, Loom keeps the
  previous summary, and the turn completes with the turns evicted as on 1.0.0. The error is logged by class only;
  a cancel rethrows and a shutdown never settles (see below). A fix has been requested upstream in Loom; the wrapper can go once Loom handles it.
- **Retry and the cost of a failure**: Loom slices the evicted turns off BEFORE it calls `summarize`, so a failed fold
  is not retried by a later turn: the next fold gets only the turns evicted after it, plus the previous summary. The
  span evicted on the failing turn is therefore missing from the summary for good. To make that rare the wrapper
  retries retryable errors (`retryable !== false`, e.g. 429, 5xx, network) twice in memory, after 0.5 s and 2 s, with
  no durable event so replay is unchanged. Errors marked `retryable: false` (e.g. a refusal) give no summary at once; others, HTTP 4xx and auth included, are retried. A cancel or lost
  lease (the call's signal) rethrows; a shutdown cuts the request and never settles, leaving the step un-completed as
  after a crash (the `INTERRUPTED` pattern of `chats/model.ts`).
- **The summarizer has its own provider**: `createChatLlm` builds `summaryProvider` for the chat role and model
  without thinking, effort or observer (thinking tokens count against the 1,024 max_tokens and would truncate the
  summary). It is bare: never wrapped by the hub. This also keeps Loom's boot warning about reasoning without a
  reasoning store away from `chat-summarize`.
- **Registration order**: Loom treats the last-registered version of a flow id as current (`WorkflowRuntime`, used by
  `start()` and the rotation successor, ADR 0109 D3), so `prepareChat` registers 1.1.0 after 1.0.0 (a unit test
  asserts the order).
- **Do not roll back past this release**: a build without 1.1.0 registered throws `FlowCodeMismatchError` for every
  conversation that started or rotated onto 1.1.0, so those chats cannot be resumed. Roll forward instead.
- **One-time read-model rebuild**: adding `STEP_COMPLETED.output.summary` to the sensitive map changes its digest
  (`ReadModelService`), so the ingest-status and chat-activity read models rebuild at the first boot of this release.
  Expect a longer first start on a large log; it is automatic and runs once.
- **Census for removing 1.0.0**: a chat chain is on 1.0.0 while its newest, non-terminal execution started with the
  1.0.0 flow hash. Take the hashes from an execution of each version (`SELECT DISTINCT payload->>'flowHash'` per
  version, e.g. from the rollout test's fixtures) and count the live chain heads on the 1.0.0 hash:

  ```sql
  SELECT s.execution_id
  FROM loom.events s
  WHERE s.event_type = 'EXECUTION_STARTED'
    AND s.payload->>'flowHash' = ANY (:old_hashes)      -- the doc-chat and doc-chat-gk 1.0.0 hashes
    AND NOT EXISTS (SELECT 1 FROM loom.events t
                    WHERE t.execution_id = s.execution_id
                      AND t.event_type IN ('EXECUTION_COMPLETED', 'EXECUTION_FAILED',
                                           'EXECUTION_CANCELLED', 'EXECUTION_CONTINUED'));
  ```

  A rotation ends the predecessor with `EXECUTION_CONTINUED` (ADR 0109 D2) and starts the successor on 1.1.0, so
  only live generations remain. An idle
  1.0.0 chat never rotates, so "no live 1.0.0" can take a long time (possibly never for abandoned chats); decide a
  cut-off, or end the leftovers, before removing 1.0.0. Verify the column names against `loom.events` first.
- **Test seams**: `prepareChat({ legacyOnly, rotateEveryTurns })`, `ComposeOptions.chat`, and the ingest stack options
  `env`, `chatLegacyOnly`, `chatRotateEveryTurns` (tests only).

## Decided not to do

- Sealing `DECISION_RECORDED.choice` wholesale and reworking the chat-activity read model (numbers as `x + 0.5`, counts
  taken at the reply): visible change to when message counts update, a read-model rebuild, and leak-guard risk.
- A Loom change recording `summary-fit` as `{ text }`: would be the cleanest fix, but this design keeps the change in
  DocMind. If Loom later records it that way, the decorator's write path never matches and can be deleted.
