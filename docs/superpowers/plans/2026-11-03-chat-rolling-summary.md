# Rolling Chat Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold chat turns evicted from the context window into a rolling summary the model keeps seeing, sealed under the owner's key everywhere it lands, without disturbing conversations already running.

**Architecture:** Loom's `conversation$` already summarizes when `budget.summarizerToolId` is set; DocMind registers `createSummarizerEffect` on the bare chat provider and ships the summarizer as flow version 1.1.0 beside the unchanged 1.0.0 (Loom resumes each execution on the version it started on). The one place the summary would land in plaintext, the `…:summary-fit` decision's string `choice`, is handled by a DocMind event-store decorator that stores it as `{ docmindSummary: 1, text }` (so the existing `choice.text` seal applies) and restores the string on every read.

**Tech Stack:** TypeScript (ESM), Node >= 22.13, vitest 2, Loom (`@loom/conversation`, `@loom/agent`, `@loom/event-runtime`, `@loom/plugin-crypto`, `@loom/conformance`), node-postgres, pnpm + turbo, biome.

**Spec:** `docs/specs/2026-11-03-chat-rolling-summary-design.md`

## Global Constraints

- Summarizer effect id: `chat-summarize`; `createSummarizerEffect(llm.provider, { maxTokens: 1024 })` on the BARE provider (`ChatLlm.provider`), never `hub.wrapProvider(...)`.
- Budget on the 1.1.0 flows: `summarizerToolId: "chat-summarize"`, `maxSummaryTokens: 1024`; `contextWindow` and `reserveOutputTokens` unchanged.
- Flow versions: `doc-chat` and `doc-chat-gk` each registered at **1.0.0 (no summarizer, exactly today's config)** and **1.1.0 (summarizer)**; new chats start on 1.1.0.
- Decision rewritten: `eventType === "DECISION_RECORDED"`, `decisionId` matching `/^conv#o[1-9][0-9]{0,8}:summary-fit$/`, `typeof choice === "string"` → stored `choice: { docmindSummary: 1, text: <string> }`; read back only from exactly `{ docmindSummary: 1, text: string }` (two keys) to the string. Nothing else is touched in either direction; the caller's envelope is never mutated.
- New sealed path: `STEP_COMPLETED: "output.summary"` in `SENSITIVE_EVENT_PATHS`. `DECISION_RECORDED.choice` is NOT added wholesale.
- The decorator forwards every optional EventStore method (`DecoratorPlan<EventStore, OptionalEventStoreMethod>` + `installOptional`) and the properties `keys`, `subjectOf`, `senderSubjectOf` of the sealing store.
- `crypto.events` (Loom principal sealing) and `DurableStorage.raw` stay the undecorated stores.
- Every commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Postgres suites need `DOCMIND_TEST_PG_URL` (`set -a; . ./.env; set +a`); a skipped suite is not a pass.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/server/app/chats/summaryChoice.ts` (new) | `SummaryChoiceEventStore` and the two pure functions `sealableSummaryChoice` / `restoredSummaryChoice`. |
| `apps/server/app/chats/summaryChoice.test.ts` (new) | Unit + Loom decorator conformance. |
| `apps/server/app/storage.ts` (modify) | Wrap the sealing event store; expose it as `storage.eventStore` and `sealed.eventStore`. |
| `apps/server/app/sensitive.ts` (modify) | `output.summary`. |
| `apps/server/app/chats/ids.ts` (modify) | `CHAT_SUMMARIZER_TOOL_ID`, added to `CHAT_EFFECT_IDS`. |
| `apps/server/app/chats/agent.ts` (modify) | `chatFlow` builds 1.0.0 or 1.1.0 (with the summarizer budget). |
| `apps/server/app/chats/wiring.ts` (modify) | Registers the four flows and the summarizer effect; a `legacyOnly` test seam. |
| `apps/server/app/chats/testStack.ts` (modify) | The decorator like production; an `env` override for small windows. |
| `apps/server/app/chats/eventLog.chat.test.ts` (modify) | The raw-log proof with an evicting chat. |
| `apps/server/app/chats/summary.e2e.pg.test.ts` (new) | Postgres acceptance incl. rollout. |
| docs (modify) | `docs/architecture.md`, `docs/codebase-guide.md`, the spec's status line. |

---

### Task 1: The summary-choice decorator

**Files:**
- Create: `apps/server/app/chats/summaryChoice.ts`
- Test: `apps/server/app/chats/summaryChoice.test.ts`

**Interfaces:**
- Produces (from `apps/server/app/chats/summaryChoice.ts`):
  - `export const SUMMARY_FIT_DECISION: RegExp` (= `/^conv#o[1-9][0-9]{0,8}:summary-fit$/`)
  - `export function sealableSummaryChoice(e: EventEnvelope): EventEnvelope` — the write-side rewrite (returns `e` itself when nothing applies)
  - `export function restoredSummaryChoice(e: EventEnvelope): EventEnvelope` — the read-side reverse (returns `e` itself when nothing applies)
  - `export class SummaryChoiceEventStore implements EventStore` — `constructor(inner: EventStore)`; readonly `keys`, `subjectOf`, `senderSubjectOf` copied from `inner` when present.

- [ ] **Step 1: Write the failing tests**

Create `apps/server/app/chats/summaryChoice.test.ts`:

```ts
import { runEventStoreDecoratorConformance } from "@loom/conformance";
import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import {
  SummaryChoiceEventStore,
  restoredSummaryChoice,
  sealableSummaryChoice,
} from "./summaryChoice";

const env = (over: Partial<EventEnvelope> & { payload?: unknown }): EventEnvelope =>
  ({
    id: "e1",
    workflowId: "doc-chat",
    executionId: "u_x.c-y",
    eventType: "DECISION_RECORDED",
    sequence: 3,
    timestamp: 1,
    payload: {},
    ...over,
  }) as EventEnvelope;

const fit = (choice: unknown, decisionId = "conv#o7:summary-fit") =>
  env({ payload: { decisionId, choice, source: "conversation-budget" } });

describe("sealableSummaryChoice / restoredSummaryChoice", () => {
  it("stores a summary-fit string choice as { docmindSummary: 1, text } and restores it", () => {
    const original = fit("the user asked about payment terms");
    const stored = sealableSummaryChoice(original);
    expect((stored.payload as { choice: unknown }).choice).toEqual({
      docmindSummary: 1,
      text: "the user asked about payment terms",
    });
    expect(restoredSummaryChoice(stored)).toEqual(original);
    // the caller's envelope is untouched
    expect((original.payload as { choice: unknown }).choice).toBe("the user asked about payment terms");
  });

  it.each([
    ["a conversation record", env({ payload: { decisionId: "conv#o7:user", choice: { text: "hi", status: "complete" } } })],
    ["a summary-fit whose choice is not a string", fit({ text: "x" })],
    ["a look-alike decision id", fit("s", "conv#o7:summary-fit-2")],
    ["ord 0", fit("s", "conv#o0:summary-fit")],
    ["another event type", env({ eventType: "STEP_COMPLETED", payload: { decisionId: "conv#o7:summary-fit", choice: "s" } })],
    ["a null payload", env({ payload: null })],
  ])("leaves %s alone on write", (_label, e) => {
    expect(sealableSummaryChoice(e)).toBe(e);
  });

  it.each([
    ["a choice with an extra key", fit({ docmindSummary: 1, text: "s", other: 1 })],
    ["a choice whose marker is not 1", fit({ docmindSummary: 2, text: "s" })],
    ["a choice whose text is not a string", fit({ docmindSummary: 1, text: 5 })],
    ["a record decision shaped like ours", env({ payload: { decisionId: "conv#o7:user", choice: { docmindSummary: 1, text: "s" } } })],
  ])("leaves %s alone on read", (_label, e) => {
    expect(restoredSummaryChoice(e)).toBe(e);
  });
});

describe("SummaryChoiceEventStore", () => {
  it("round-trips through append/read, appendBatch/readRange, readFrom and subscribe; the inner store holds the object form", async () => {
    const inner = new InMemoryAsyncEventStore();
    const store = new SummaryChoiceEventStore(inner);
    const seen: EventEnvelope[] = [];
    const off = await store.subscribe("u_x.c-y", (e) => seen.push(e));
    const a = fit("first summary");
    const b = { ...fit("second summary", "conv#o8:summary-fit"), id: "e2", sequence: 4 };
    await store.append(a);
    await store.appendBatch?.([b]);
    expect((await inner.read("u_x.c-y")).map((e) => (e.payload as { choice: unknown }).choice)).toEqual([
      { docmindSummary: 1, text: "first summary" },
      { docmindSummary: 1, text: "second summary" },
    ]);
    expect(await store.read("u_x.c-y")).toEqual([a, b]);
    expect(await store.readFrom("u_x.c-y", 4)).toEqual([b]);
    expect(await store.readRange?.("u_x.c-y", 3, 3)).toEqual([a]);
    await expect.poll(() => seen.length).toBe(2);
    expect(seen).toEqual([a, b]);
    off();
    await store.close();
  });

  it("carries the sealing store's keys, subjectOf and senderSubjectOf", () => {
    const keys = { getOrCreate: async () => Buffer.alloc(32) };
    const subjectOf = () => "s";
    const senderSubjectOf = async () => "t";
    const inner = Object.assign(new InMemoryAsyncEventStore(), { keys, subjectOf, senderSubjectOf });
    const store = new SummaryChoiceEventStore(inner) as unknown as Record<string, unknown>;
    expect(store.keys).toBe(keys);
    expect(store.subjectOf).toBe(subjectOf);
    expect(store.senderSubjectOf).toBe(senderSubjectOf);
  });
});

runEventStoreDecoratorConformance("SummaryChoiceEventStore", (inner) => new SummaryChoiceEventStore(inner));
```

Before running: check `InMemoryAsyncEventStore` is exported from `@loom/event-runtime` (grep `../loom/packages/event-runtime/src/index.ts`; `config.test.ts` imports it) and that `@loom/conformance` is a devDependency of `apps/server` (`apps/server/package.json`). If not, add `"@loom/conformance": "*"` to `devDependencies` (it is linked by `pnpm-workspace.yaml`'s overrides) and run `pnpm install` from the repo root. Check `readFrom`'s semantics in `../loom/packages/event-runtime/src/types.ts` (inclusive `fromSequence`?) and adjust the `readFrom` expectation to it.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd apps/server && pnpm exec vitest run app/chats/summaryChoice.test.ts`
Expected: FAIL, `Failed to resolve import "./summaryChoice"`.

- [ ] **Step 3: Implement `summaryChoice.ts`**

Create `apps/server/app/chats/summaryChoice.ts`, modelled on Loom's `TenantScopedEventStore` (`../loom/packages/event-runtime/src/TenantScopedEventStore.ts`, its plan at lines ~126-173):

```ts
import type { EventEnvelope } from "@loom/core";
import {
  type DecoratorPlan,
  type EventStore,
  type OptionalEventStoreMethod,
  installOptional,
} from "@loom/event-runtime";

/**
 * The decision under which Loom's conversation records the trimmed rolling summary (`conv#o<ord>:summary-fit`,
 * `@loom/conversation`). Its `choice` is the summary STRING, which no sealed path can reach without also sealing
 * every conversation record's `choice` (spec: docs/specs/2026-11-03-chat-rolling-summary-design.md §4).
 */
export const SUMMARY_FIT_DECISION = /^conv#o[1-9][0-9]{0,8}:summary-fit$/;
const MARK = "docmindSummary";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function summaryFitPayload(e: EventEnvelope): Record<string, unknown> | undefined {
  if (e.eventType !== "DECISION_RECORDED" || !isRecord(e.payload)) return undefined;
  const id = e.payload.decisionId;
  return typeof id === "string" && SUMMARY_FIT_DECISION.test(id) ? e.payload : undefined;
}

/** Write side: a summary-fit string choice becomes `{ docmindSummary: 1, text }`, so `choice.text` is sealed. */
export function sealableSummaryChoice(e: EventEnvelope): EventEnvelope {
  const p = summaryFitPayload(e);
  if (p === undefined || typeof p.choice !== "string") return e;
  return { ...e, payload: { ...p, choice: { [MARK]: 1, text: p.choice } } };
}

/** Read side: exactly `{ docmindSummary: 1, text: string }` on a summary-fit decision becomes the string again. */
export function restoredSummaryChoice(e: EventEnvelope): EventEnvelope {
  const p = summaryFitPayload(e);
  if (p === undefined || !isRecord(p.choice)) return e;
  const c = p.choice;
  const keys = Object.keys(c);
  if (keys.length !== 2 || c[MARK] !== 1 || typeof c.text !== "string") return e;
  return { ...e, payload: { ...p, choice: c.text } };
}

const restoreAll = (events: EventEnvelope[]): EventEnvelope[] => events.map(restoredSummaryChoice);

/**
 * Sits above the sealing event store (`EncryptingEventStore`) and hands Loom the summary-fit decision as Loom wrote it,
 * while the store below seals its text. Every optional SPI method is decided here (a new one is a compile error), and the
 * properties `defineConfig` reads by shape off `storage.eventStore` to seal the inbox archive and senders are carried
 * up: without them the archive would be written in plaintext, silently.
 */
export class SummaryChoiceEventStore implements EventStore {
  readonly appendBatch?: NonNullable<EventStore["appendBatch"]>;
  readonly head?: NonNullable<EventStore["head"]>;
  readonly readRange?: NonNullable<EventStore["readRange"]>;
  readonly acquireFence?: NonNullable<EventStore["acquireFence"]>;
  readonly acquireFenceIf?: NonNullable<EventStore["acquireFenceIf"]>;
  readonly appendIfUnchanged?: NonNullable<EventStore["appendIfUnchanged"]>;
  readonly storeNow?: NonNullable<EventStore["storeNow"]>;
  readonly sealingCapability?: NonNullable<EventStore["sealingCapability"]>;
  readonly readAtRest?: NonNullable<EventStore["readAtRest"]>;
  readonly copyPrefix?: NonNullable<EventStore["copyPrefix"]>;
  readonly deleteExecution?: NonNullable<EventStore["deleteExecution"]>;
  readonly deleteThrough?: NonNullable<EventStore["deleteThrough"]>;
  readonly truncatePrefix?: NonNullable<EventStore["truncatePrefix"]>;
  readonly truncatePrefixKeeping?: NonNullable<EventStore["truncatePrefixKeeping"]>;
  readonly listExecutions?: NonNullable<EventStore["listExecutions"]>;
  readonly listExecutionsPage?: NonNullable<EventStore["listExecutionsPage"]>;
  /** `EncryptingEventStore`'s, carried up (read by shape by `defineConfig`'s archive and sender sealing). */
  readonly subjectOf?: unknown;
  readonly senderSubjectOf?: unknown;

  constructor(private readonly inner: EventStore) {
    const plan = {
      appendBatch: (envs) => inner.appendBatch!(envs.map(sealableSummaryChoice)),
      head: "forward",
      readRange: async (id, from, to) => restoreAll(await inner.readRange!(id, from, to)),
      acquireFence: "forward",
      acquireFenceIf: "forward",
      appendIfUnchanged: (id, event, expect) =>
        inner.appendIfUnchanged!(id, event === null ? null : sealableSummaryChoice(event), expect),
      storeNow: "forward",
      sealingCapability: "forward",
      // The at-rest view is the envelopes AS STORED, never decrypted: it shows the object form, on purpose.
      readAtRest: "forward",
      // A fork copies stored rows inside the inner store: the object form travels with them and is restored on read.
      copyPrefix: "forward",
      deleteExecution: "forward",
      deleteThrough: "forward",
      truncatePrefix: "forward",
      truncatePrefixKeeping: "forward",
      listExecutions: "forward",
      listExecutionsPage: "forward",
    } satisfies DecoratorPlan<EventStore, OptionalEventStoreMethod>;
    installOptional<EventStore, OptionalEventStoreMethod>(this, inner, plan);
    const shape = inner as { subjectOf?: unknown; senderSubjectOf?: unknown };
    if (shape.subjectOf !== undefined) this.subjectOf = shape.subjectOf;
    if (shape.senderSubjectOf !== undefined) this.senderSubjectOf = shape.senderSubjectOf;
  }

  append(envelope: EventEnvelope): Promise<void> {
    return this.inner.append(sealableSummaryChoice(envelope));
  }

  async read(executionId: string): Promise<EventEnvelope[]> {
    return restoreAll(await this.inner.read(executionId));
  }

  async readFrom(executionId: string, fromSequence: number): Promise<EventEnvelope[]> {
    return restoreAll(await this.inner.readFrom(executionId, fromSequence));
  }

  subscribe(executionId: string, handler: (event: EventEnvelope) => void): Promise<() => void> {
    return this.inner.subscribe(executionId, (e) => handler(restoredSummaryChoice(e)));
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
```

Notes for the implementer:
- `installOptional` already copies `keys` (and the other structural markers) via `forwardStoreMarkers`; `subjectOf` / `senderSubjectOf` are not markers, hence the two explicit copies. Assigning to `readonly` fields in the constructor is fine in TypeScript.
- Check the real import locations: `EventEnvelope` may live in `@loom/core` or `@loom/event-runtime`; `DecoratorPlan`, `OptionalEventStoreMethod`, `installOptional` must be exported from `@loom/event-runtime`'s index (grep it). Use whatever the existing code in `apps/server/app` imports (`erasure/compliance.ts` imports `EventStore` from `@loom/event-runtime`).
- If the EventStore interface has other REQUIRED methods than `append`, `read`, `readFrom`, `subscribe`, `close` (check `../loom/packages/event-runtime/src/types.ts` around lines 400-670), implement each: write paths rewrite, read paths restore, everything else forwards. Report any you add.
- If the conformance kit reports a forwarding problem for `readAtRest`/`copyPrefix` as "forward", follow the kit; a refusal must carry a reason and be justified in the report.

- [ ] **Step 4: Run the tests**

Run: `cd apps/server && pnpm exec vitest run app/chats/summaryChoice.test.ts && pnpm typecheck && pnpm typecheck:tests`
Expected: PASS (the unit tests and every case of the Loom decorator conformance suite).

- [ ] **Step 5: Lint and commit**

```bash
pnpm exec biome check --write apps/server/app/chats/summaryChoice.ts apps/server/app/chats/summaryChoice.test.ts
git add apps/server/app/chats/summaryChoice.ts apps/server/app/chats/summaryChoice.test.ts apps/server/package.json pnpm-lock.yaml
git commit -m "feat(server): an event-store decorator that lets the summary-fit choice be sealed

Loom records a conversation's trimmed rolling summary as a DECISION_RECORDED
whose choice is a bare string, which no sealed path can reach without also
sealing every conversation record's choice. SummaryChoiceEventStore stores
that one decision's choice as { docmindSummary: 1, text } (so choice.text is
sealed below it) and restores the string on every read path; everything
else passes through, every optional SPI method is forwarded, and the
sealing store's keys, subjectOf and senderSubjectOf are carried up.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Only add `apps/server/package.json` / `pnpm-lock.yaml` if Step 1 changed them.)

---

### Task 2: Use the decorator in production and seal the summary step's output

**Files:**
- Modify: `apps/server/app/storage.ts` (`createDurableStorage`, ~lines 68-100)
- Modify: `apps/server/app/sensitive.ts` (`STEP_COMPLETED` list)
- Modify: `apps/server/app/chats/testStack.ts` (~lines 116-145)
- Test: `apps/server/app/config.test.ts` (the "composes under strict mode, with encrypting stores…" test)

**Interfaces:**
- Consumes: `SummaryChoiceEventStore` (Task 1).
- Produces: `createDurableStorage(...).storage.eventStore` and `.sealed.eventStore` are a `SummaryChoiceEventStore` over the `EncryptingEventStore`; `.crypto.events` stays the `EncryptingEventStore`; `.raw` unchanged. `ChatStack` (testStack) gains option `env?: Record<string, string>` merged over its env, and its `events` is the decorated store.

- [ ] **Step 1: Extend the composition test (failing)**

In `apps/server/app/config.test.ts`, inside the test "composes under strict mode, with encrypting stores that Loom accepts as sealing", after `const { storage, crypto } = durable;`, add:

```ts
    // The rolling summary's decision is sealable only through this decorator; Loom must still see a sealing store.
    expect(storage.eventStore).toBeInstanceOf(SummaryChoiceEventStore);
    expect(durable.sealed.eventStore).toBe(storage.eventStore);
    expect(crypto.events).toBeInstanceOf(EncryptingEventStore);
    const shape = storage.eventStore as unknown as Record<string, unknown>;
    const sealing = crypto.events as unknown as Record<string, unknown>;
    expect(shape.keys).toBe(sealing.keys);
    expect(shape.subjectOf).toBe(sealing.subjectOf);
    expect(shape.senderSubjectOf).toBe(sealing.senderSubjectOf);
```

with imports `import { SummaryChoiceEventStore } from "./chats/summaryChoice";` and `import { EncryptingEventStore } from "@loom/plugin-crypto";` (if not already imported). Keep the existing `expect(app.stores.eventStore).toBe(storage.eventStore)`.

The new `output.summary` sealed path needs no test here: Task 3's raw-log proof asserts it on a real evicting chat.

- [ ] **Step 2: Run it to verify it fails**

Run: `set -a; . ./.env; set +a; cd apps/server && pnpm exec vitest run app/config.test.ts`
Expected: FAIL on `toBeInstanceOf(SummaryChoiceEventStore)`.

- [ ] **Step 3: Wrap the sealing store in `createDurableStorage`**

In `apps/server/app/storage.ts`, after `const events = new EncryptingEventStore(...)`:

```ts
  // The rolling summary's `summary-fit` decision carries the summary as a bare string choice; the decorator stores it
  // as `choice.text` (sealed) and gives Loom the string back (chats/summaryChoice.ts). Loom's principal sealing
  // (`crypto.events`) and erasure (`raw`) keep the undecorated stores.
  const decorated = new SummaryChoiceEventStore(events);
```

and use `decorated` for `storage.eventStore` and `sealed.eventStore`; leave `crypto: { events, snapshots }` and `raw` as they are. Update the `DurableStorage` doc comments that describe `sealed` to say it is the decorated store.

In `apps/server/app/sensitive.ts`, add `"output.summary",` to `STEP_COMPLETED` with the comment:

```ts
    // The rolling summary of evicted turns (`conv#o<ord>:summarize`, `createSummarizerEffect` → `{ summary }`).
    "output.summary",
```

- [ ] **Step 4: The chat test stack composes like production**

In `apps/server/app/chats/testStack.ts`:
- add `env?: Record<string, string>;` to `StackOptions` with the doc comment `/** Merged over the stack's env (e.g. a small DOCMIND_CHAT_CONTEXT_TOKENS so turns are evicted). */`, and in `startChatStack` / `startOllamaChatStack` spread `...o.env` last into `env`;
- in `buildChatStack`, keep `const events = new EncryptingEventStore(...)` as the sealing store and add `const store = new SummaryChoiceEventStore(events);`; pass `store` (not `events`) to `prepareChat({ eventStore })`, to `buildApp({ kind: "custom", eventStore: store }, { events }, …)` (the second argument, `crypto`, keeps `events`), to `connectChat(prepared, app.runtime, store)`, to `followConversation({ reader: chat.reader, eventStore: store }, …)`, and return `events: store` in the stack (every reader in the tests goes through it, like production). Keep `raw` as is.

- [ ] **Step 5: Run the affected suites**

Run: `set -a; . ./.env; set +a; cd apps/server && pnpm exec vitest run app/config.test.ts app/chats app/erasure && pnpm typecheck && pnpm typecheck:tests`
Expected: PASS. In particular the erasure suites' residue scan still passes: their `loom.archive_segments` rule requires each archived segment to be one sealed box, which fails if the decorator hid `keys`/`subjectOf`/`senderSubjectOf` from `defineConfig`.

- [ ] **Step 6: Lint and commit**

```bash
pnpm exec biome check --write apps/server/app/storage.ts apps/server/app/sensitive.ts apps/server/app/chats/testStack.ts apps/server/app/config.test.ts
git add apps/server/app/storage.ts apps/server/app/sensitive.ts apps/server/app/chats/testStack.ts apps/server/app/config.test.ts
git commit -m "feat(server): Loom's event store goes through the summary-choice decorator; seal the summary output

createDurableStorage and the chat test stack hand Loom the decorated sealing
store (principal sealing and erasure keep the undecorated ones), and
STEP_COMPLETED output.summary is a sealed path.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The summarizer and the two flow versions

**Files:**
- Modify: `apps/server/app/chats/ids.ts` (~line 14-23)
- Modify: `apps/server/app/chats/agent.ts` (`ChatFlowConfig`, `chatFlow`, the "No summarizer" comment)
- Modify: `apps/server/app/chats/wiring.ts` (`PrepareChatOptions`, `prepareChat`, ~lines 72-130)
- Modify: `apps/server/app/chats/eventLog.chat.test.ts` (one new test)
- Test: `apps/server/app/chats/agent.test.ts` (or the wiring's existing unit test file; `ls apps/server/app/chats/*.test.ts`)

**Interfaces:**
- Consumes: Task 2's `ChatStack` `env` option and decorated `events`.
- Produces: `export const CHAT_SUMMARIZER_TOOL_ID = "chat-summarize";` in `chats/ids.ts`, included in `CHAT_EFFECT_IDS`; `ChatFlowConfig.summarizerToolId?: string` — when set, `chatFlow` returns version `"1.1.0"` with `budget.summarizerToolId` and `budget.maxSummaryTokens: 1024`, otherwise version `"1.0.0"` with exactly today's config; `export const SUMMARY_MAX_TOKENS = 1024;` in `chats/agent.ts` (imported by `wiring.ts`); `PrepareChatOptions.legacyOnly?: boolean` (test seam: register and start only the 1.0.0 flows); `PreparedChat.deps.flows` holds four flows (`doc-chat` and `doc-chat-gk` at 1.0.0 and 1.1.0), or only the two 1.0.0 flows with `legacyOnly`.

- [ ] **Step 1: Unit tests for the flows (failing)**

Add to the chat agent/wiring unit tests (choose the file that already tests `chatFlow`/`prepareChat`; create `apps/server/app/chats/flows.test.ts` if none fits):

```ts
import { describe, expect, it } from "vitest";
import { chatFlow } from "./agent";
import { CHAT_EFFECT_IDS, CHAT_FLOW_ID, CHAT_GK_FLOW_ID, CHAT_SUMMARIZER_TOOL_ID } from "./ids";

describe("the chat flows' versions", () => {
  const base = {
    key: "k".repeat(32),
    contextTokens: 150_000,
    maxTokens: 16_000,
    generalKnowledge: false,
    hub: {} as never,
    bargeIn: {} as never,
  };

  it("1.0.0 is today's flow: no summarizer", () => {
    const f = chatFlow(base);
    expect(f.definition.version).toBe("1.0.0");
    expect(f.config.budget?.summarizerToolId).toBeUndefined();
  });

  it("1.1.0 summarizes evicted turns into a 1,024-token summary", () => {
    const f = chatFlow({ ...base, summarizerToolId: CHAT_SUMMARIZER_TOOL_ID });
    expect(f.definition.version).toBe("1.1.0");
    expect(f.config.budget).toMatchObject({
      summarizerToolId: "chat-summarize",
      maxSummaryTokens: 1024,
      contextWindow: 150_000,
    });
    expect(chatFlow({ ...base, generalKnowledge: true, summarizerToolId: "chat-summarize" }).definition.id).toBe(
      CHAT_GK_FLOW_ID,
    );
    expect(f.definition.id).toBe(CHAT_FLOW_ID);
  });

  it("strict mode admits the summarizer effect for both chat flows", () => {
    expect(CHAT_EFFECT_IDS).toContain("chat-summarize");
  });
});
```

Check the real `ConversationFlow` shape (`f.definition.version`, `f.config.budget`) in `../loom/packages/conversation/src/conversation.ts` (`conversation$`, ~line 912) and adapt the property paths. Also add a `prepareChat` assertion in whichever test already builds it (grep `prepareChat(` in `apps/server/app/chats/*.test.ts`): `deps.flows` has the four (id, version) pairs `doc-chat@1.0.0`, `doc-chat@1.1.0`, `doc-chat-gk@1.0.0`, `doc-chat-gk@1.1.0`; `active.definition.version === "1.1.0"`; `deps.effects["chat-summarize"]` is defined when an LLM is given and absent without one; with `legacyOnly: true`, only the two 1.0.0 flows and `active` is 1.0.0.

- [ ] **Step 2: The raw-log proof with an evicting chat (failing)**

Append to `apps/server/app/chats/eventLog.chat.test.ts` (inside its `describe`):

```ts
  it("a chat long enough to evict turns: the rolling summary is sealed wherever it lands", async () => {
    const SUMMARY = "Rolling-summary-sentinel: the user asked about Nocturne payment terms.";
    stack = await startChatStack({
      scripts: [],
      // A window that holds about two turns, so the third evicts the first (adjust; the assertions below prove it).
      env: { DOCMIND_CHAT_CONTEXT_TOKENS: "4000", DOCMIND_CHAT_MAX_TOKENS: "1000" },
    });
    const summarizerCalls: unknown[] = [];
    stack.fake.reply((body) => {
      if (JSON.stringify(body.system ?? "").includes("You compress an earlier part")) {
        summarizerCalls.push(body);
        return { stream: { steps: [{ text: SUMMARY }, { stop: "end_turn" }] } };
      }
      return { stream: { steps: [{ text: "Noted." }, { stop: "end_turn" }] } };
    });
    const id = await stack.start();
    const long = (n: number) => `${QUESTION} ${"detail ".repeat(400)} (${n})`;
    for (let i = 1; i <= 4; i++) {
      await stack.send(id, long(i));
      await stack.replies(id, i);
    }
    expect(summarizerCalls.length).toBeGreaterThan(0); // a turn really was evicted

    const raw = await rawLog(stack);
    assertNoPlaintext(raw, [...SECRETS, SUMMARY, "Rolling-summary-sentinel"]);
    const paths = sealedPaths(raw);
    expect([...paths]).toEqual(expect.arrayContaining(["STEP_COMPLETED:output.summary", "DECISION_RECORDED:choice.text"]));
    // the summary-fit decision itself is stored in the sealable form
    const fits = raw.filter(
      (e) => e.eventType === "DECISION_RECORDED" && /:summary-fit$/.test(String((e.payload as { decisionId?: unknown }).decisionId)),
    );
    expect(fits.length).toBeGreaterThan(0);
    for (const e of fits) {
      const choice = (e.payload as { choice: { docmindSummary?: unknown; text?: { __loomEnc?: unknown } } }).choice;
      expect(choice.docmindSummary).toBe(1);
      expect(choice.text?.__loomEnc).toBe("loom/aes-256-gcm");
    }
    // and Loom reads it back as the string: the next prompt carries the summary
    const lastChatRequest = JSON.stringify(stack.fake.requests.at(-1)?.body);
    expect(lastChatRequest).toContain("Rolling-summary-sentinel");
  });
```

Adapt to the real helpers in this file (`QUESTION`, `SECRETS`, `rawLog`, `sealedPaths`, `assertNoPlaintext`'s signature, `stack.fake.reply`'s body type, and how `StreamScript` text steps look). The window numbers are a starting point: pick values for which `summarizerCalls.length > 0` holds and every turn still gets a `complete` reply (`loadChatSettings` requires `contextTokens >= 2 * maxTokens`; the DocMind system prompt and tool definitions also take room). Keep the test asserting that eviction happened.

- [ ] **Step 3: Run them to verify they fail**

Run: `cd apps/server && pnpm exec vitest run app/chats/flows.test.ts app/chats/eventLog.chat.test.ts` (and the prepareChat test file)
Expected: FAIL (`CHAT_SUMMARIZER_TOOL_ID` missing; no summarizer call).

- [ ] **Step 4: Implement**

`apps/server/app/chats/ids.ts`:

```ts
/** The rolling summary of evicted turns (`@loom/conversation` `budget.summarizerToolId`, Loom's `createSummarizerEffect`). */
export const CHAT_SUMMARIZER_TOOL_ID = "chat-summarize";
export const CHAT_EFFECT_IDS: readonly string[] = [CHAT_MODEL_TOOL_ID, CHAT_SUMMARIZER_TOOL_ID, ...CHAT_TOOL_IDS];
```

`apps/server/app/chats/agent.ts`:
- `ChatFlowConfig` gains:

```ts
  /**
   * The summarizer effect: set, the flow is version 1.1.0 and folds turns evicted from the window into a sealed rolling
   * summary the model keeps seeing; unset, it is 1.0.0, exactly the flow conversations started on before the summary
   * existed (kept registered so Loom resumes them on it; spec 2026-11-03-chat-rolling-summary §3).
   */
  summarizerToolId?: string;
```

- in `chatFlow`, replace the `// No summarizer: …` comment and the `budget` object with:

```ts
      // 1.0.0: turns that fall out of the window leave the prompt but stay in history. 1.1.0: they are folded into a
      // rolling summary (at most 1,024 tokens) that the prompt keeps; the summary is sealed (sensitive.ts, summaryChoice.ts).
      budget: {
        contextWindow: config.contextTokens,
        reserveOutputTokens: Math.min(config.maxTokens, Math.floor(config.contextTokens / 4)),
        ...(config.summarizerToolId !== undefined && {
          summarizerToolId: config.summarizerToolId,
          maxSummaryTokens: SUMMARY_MAX_TOKENS,
        }),
      },
```

  with `export const SUMMARY_MAX_TOKENS = 1024;` near the top, and in the options object pass `version: config.summarizerToolId !== undefined ? "1.1.0" : "1.0.0",` beside `id`/`name`.

`apps/server/app/chats/wiring.ts`:
- `PrepareChatOptions` gains `/** Test seam: register and start only the 1.0.0 flows (a server from before the summary). */ legacyOnly?: boolean;`
- in `prepareChat`, build:

```ts
  const legacy = chatFlow(flowConfig);
  const legacyGk = chatFlow({ ...flowConfig, generalKnowledge: true });
  const withSummary = { ...flowConfig, summarizerToolId: CHAT_SUMMARIZER_TOOL_ID };
  const strict = o.legacyOnly ? legacy : chatFlow(withSummary);
  const gk = o.legacyOnly ? legacyGk : chatFlow({ ...withSummary, generalKnowledge: true });
  // 1.0.0 stays registered: Loom resumes each conversation on the version it started on (ADR 0023), so a chat begun
  // before the summary keeps its code until its next rotation starts the successor on 1.1.0 (ADR 0109 D3).
  const flows = o.legacyOnly ? [legacy, legacyGk] : [legacy, legacyGk, strict, gk];
```

  and use `flows` in `deps.flows` (same `as unknown as RegisteredFlow[]` cast); `active` stays `settings.generalKnowledge ? gk : strict`.
- inside `if (o.llm) { … }`, after the model effect:

```ts
    // The BARE provider: the hub would stream the summary into the chat's live view as if it were the answer.
    effects[CHAT_SUMMARIZER_TOOL_ID] = createSummarizerEffect(o.llm.provider, { maxTokens: SUMMARY_MAX_TOKENS });
```

  with `import { createSummarizerEffect } from "@loom/agent";`, `import { CHAT_SUMMARIZER_TOOL_ID } from "./ids";` (beside the existing `CHAT_MODEL_TOOL_ID` import) and `SUMMARY_MAX_TOKENS` added to the existing `./agent` import.

If Loom refuses two registered versions of one flow id at `defineConfig`/`registerFlow`, STOP and report BLOCKED with the error: the rollout design depends on it.

- [ ] **Step 5: Run the tests**

Run: `cd apps/server && pnpm exec vitest run app/chats && pnpm typecheck && pnpm typecheck:tests`
Expected: PASS, including the existing raw-log proof (unchanged behaviour on 1.1.0 when nothing is evicted).

- [ ] **Step 6: Lint and commit**

```bash
pnpm exec biome check --write apps/server/app/chats
git add apps/server/app/chats
git commit -m "feat(chat): fold evicted turns into a sealed rolling summary (flow 1.1.0)

Both chat flows gain version 1.1.0 with budget.summarizerToolId =
chat-summarize (Loom's createSummarizerEffect on the bare provider, 1,024
tokens) and maxSummaryTokens 1,024. 1.0.0 stays registered unchanged so
conversations started before this resume on their own code; new chats start
on 1.1.0. The raw-log proof covers an evicting chat.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Acceptance on Postgres, including the rollout

**Files:**
- Create: `apps/server/app/chats/summary.e2e.pg.test.ts`
- Modify: `apps/server/app/documents/ingestStack.ts` (options `env?: Record<string, string>` and `chatLegacyOnly?: boolean`, passed to the chat settings env and to `prepareChat({ legacyOnly })`)

**Interfaces:**
- Consumes: Tasks 1-3. The acceptance stack (`startIngestStack`), `scriptChat`, `collectUntil`, `isReply` (`chats/e2eSupport.ts`), `eraseMe`, `waitErased`, `scanTables`, `unexpected`, `needlesOf` (`erasure/e2eSupport.ts`); see `chats/restart.e2e.pg.test.ts` and `snapshots/prune.e2e.pg.test.ts` for restart and chat-turn patterns.

- [ ] **Step 1: Thread the two options through the acceptance stack**

In `apps/server/app/documents/ingestStack.ts`, add to `IngestStackOptions`:

```ts
  /** Merged over the stack's env (e.g. a small DOCMIND_CHAT_CONTEXT_TOKENS so chat turns are evicted). */
  env?: Record<string, string>;
  /** Compose the chat as a server from before the rolling summary did: only the 1.0.0 flows (rollout test). */
  chatLegacyOnly?: boolean;
```

Find where the stack builds its env for chat settings and `prepareChat` (grep `prepareChat\|loadChatSettings\|composeServer\|buildServer` in `ingestStack.ts` and `compose.ts`) and thread both through. If the chat is prepared inside `compose.ts`'s `buildServer`, add a matching optional field to its options (default off) rather than reaching around it; report the path you took.

- [ ] **Step 2: Write the acceptance tests (failing until wired)**

Create `apps/server/app/chats/summary.e2e.pg.test.ts` with `describe.skipIf(!PG_URL)(…)` and the teardown pattern of `snapshots/prune.e2e.pg.test.ts` (track stacks, dbs, roots; 40 s per-test timeouts). Tests (each asserts that eviction really happened by counting summarizer requests on the fake, identified by `DEFAULT_SUMMARIZER_INSTRUCTION` from `@loom/agent` in the request's `system`):

1. **Evicts, summarizes, carries the summary, survives a restart.** Stack with `chat: true, env: { DOCMIND_CHAT_CONTEXT_TOKENS, DOCMIND_CHAT_MAX_TOKENS }` (the values Task 3 settled on), a user, a ready document, a chat of enough long turns to evict. The fake answers summarizer requests with a sentinel summary and chat requests with normal replies. Assert: at least one summarizer request; its transcript contains an evicted turn's question; the sentinel never appears in any chat stream frame (`collectUntil` frames) — the summary is not streamed; the next chat request's messages contain the sentinel; `loom.events` (read via `st.db.owner`) contains no row whose payload text includes the sentinel. Then `close({ keepDb: true })`, restart with `resume`, send one more turn: it answers (no `FlowDivergenceError` in the reply status or logs) and its request still contains the sentinel.
2. **The inbox archive stays sealed through the decorator.** After test 1's chat (or a fresh one with a rotation: `rotateEveryTurns` is a `prepareChat` seam; if the ingest stack cannot set it, assert on whatever archive rows the chat produced), every `loom.archive_segments` row for the user has `body.envelopes = []` and a sealed `body.sealed.box` (`__loomEnc === "loom/aes-256-gcm"`). If the chat produced no archive rows, say so in the report and assert instead that `durable.storage.eventStore` exposes the sealing store's `keys`/`subjectOf`/`senderSubjectOf` (Task 2 already asserts this; then this case is covered there).
3. **Erasure.** Erase the user (`eraseMe` + `waitErased`): the existing erasure residue scan helpers (`scanTables`, `unexpected`, `needlesOf`) report nothing unexpected, and the sentinel is in no table.
4. **A summarizer failure fails only that turn.** The fake answers the summarizer request with an HTTP 500 (`failNext` only for that request, or a reply function returning an error status for summarizer bodies): that turn's reply is `failed`; the next turn (with the summarizer answering) completes.
5. **Rollout.** Start a stack with `chatLegacyOnly: true` and the small window; run turns until a turn evicts — on 1.0.0 no summarizer request is made. Close (`keepDb`), restart WITHOUT `chatLegacyOnly` (both versions registered) over the same db: the same chat's next evicting turn completes with NO summarizer request (it resumed on 1.0.0), and `loom.events`' `EXECUTION_STARTED` of that execution still records the 1.0.0 flow (read `payload.flowHash` or the version Loom records — check `EXECUTION_STARTED`'s payload in `../loom/packages/workflow-runtime`); a NEW chat started on the restarted server summarizes (1.1.0). Then rotate the old chat (enough turns for `rotateEveryTurns` = 50 is too many: if the stack cannot lower it, cover the rotation in an in-memory test with `startChatStack({ rotateEveryTurns: 2 })` composed `legacyOnly` then re-prepared, or report that the rotation case could not be covered for a ruling) and assert the successor generation (`<conversation>~1`) records the 1.1.0 hash.

- [ ] **Step 3: Run until green**

Run: `set -a; . ./.env; set +a; cd apps/server && pnpm exec vitest run app/chats/summary.e2e.pg.test.ts`
Expected: all cases PASS and none skipped. A failing rollout assertion is a finding to report, not to weaken: if the successor of a 1.0.0 generation does not start on 1.1.0, report DONE_WITH_CONCERNS with what Loom recorded.

- [ ] **Step 4: Lint, typecheck, commit**

```bash
pnpm exec biome check --write apps/server/app
(cd apps/server && pnpm typecheck && pnpm typecheck:tests)
git add apps/server/app
git commit -m "test(chat): the rolling summary end to end on Postgres, including the rollout

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Docs and the whole gate

**Files:**
- Modify: `docs/architecture.md` (the chat section; `grep -n -i "chat\|window\|summar" docs/architecture.md`)
- Modify: `docs/codebase-guide.md` (the table of mechanisms, if it lists the chat's context window)
- Modify: `docs/specs/2026-11-03-chat-rolling-summary-design.md` (status line: implemented; any deviation the tasks reported)

- [ ] **Step 1: Architecture**

Add, where the chat's prompt/context window is described (or as a new bullet in the chat section):

`- **Rolling summary.** A chat's prompt holds the newest turns that fit \`DOCMIND_CHAT_CONTEXT_TOKENS\`; turns that no longer fit are folded into a rolling summary (Loom's conversation budget, at most 1,024 tokens, written by the chat model) that the prompt keeps. The summary is sealed under the owner's key wherever it lands; its \`summary-fit\` decision goes through \`SummaryChoiceEventStore\` (chats/summaryChoice.ts), which stores the bare string Loom records as \`choice.text\`. Chats started before the summary existed run on flow 1.0.0 until their next rotation.`

- [ ] **Step 2: Codebase guide**

If `docs/codebase-guide.md` has a row about the chat's context or the event store stack, add `chats/summaryChoice.ts` and one line on why it exists. If it has none, add nothing.

- [ ] **Step 3: Spec status**

Change the spec's `Status:` line to `implemented on feat/chat-rolling-summary` and add any deviation the implementation reported (with the reason) at the end of §3 or §4.

- [ ] **Step 4: Run the whole gate**

```bash
set -a; . ./.env; set +a
pnpm build && pnpm lint && pnpm typecheck && pnpm typecheck:tests && pnpm test
```

Expected: every step exits 0; `@docmind/server` reports 0 failed and no "Unhandled Errors" block.

- [ ] **Step 5: Commit**

```bash
git add docs
git commit -m "docs: the rolling chat summary and the summary-choice decorator

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
