import type { Identity } from "@docmind/auth";
import type { HistoryEntry } from "@loom/conversation";
import { type LlmReasoning, captureReasoning } from "@loom/llm";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FieldCrypto } from "../crypto/fields";
import { legacyChatConversationId } from "./ids";
import { type MessageDeps, toMessageDtos, turnKeyOf } from "./messages";
import { replyReasoning } from "./reasoningRead";
import { ChatReasoningStore } from "./reasoningStore";
import { type ChatCallScope, chatScope } from "./scope";
import { C, FakeItems, MemoryReasoningRows, T, U, modelCtx } from "./testing";

vi.mock("./citations", async (orig) => ({
  ...(await orig<typeof import("./citations")>()),
  documentTitles: async () => new Map([["7f6d1b8e-3b0a-4a56-8f2f-0a8e0f7c4d11", "Q3 report"]]),
}));

const CONV = legacyChatConversationId(U, C);
const CHAT = { id: C, conversationId: CONV };
const REF = { tenantId: T, userId: U, chatId: C };
const IDENTITY = { tenantId: T, userId: U } as unknown as Identity;
const secret = "SECRET-REASONING-TEXT";

function world() {
  const log: { executionId: string; eventType: string; payload: unknown }[] = [];
  const store = new ChatReasoningStore(
    new MemoryReasoningRows(),
    new FieldCrypto(new InMemoryKeyStore()),
  );
  const record = async (stepId: string, reasoning: LlmReasoning[]) => {
    const ctx = modelCtx({
      executionId: CONV,
      stepId,
      emit: (eventType, payload) => log.push({ executionId: CONV, eventType, payload }),
    });
    const scope: ChatCallScope = { ...REF, turnKey: 1, stepKey: stepId, attempt: 1 };
    await chatScope.run(scope, () => captureReasoning(reasoning, { store, model: "m" }, ctx));
    log.push({ executionId: CONV, eventType: "STEP_COMPLETED", payload: { stepId } });
  };
  return { log, store, record };
}

const entry = (over: Partial<HistoryEntry>): HistoryEntry => ({
  turn: 1,
  ord: 2,
  role: "assistant",
  text: "",
  status: "complete",
  cursor: "0.2",
  executionId: CONV,
  at: 1_700_000_000_000,
  ...over,
});

const depsOf = (items: FakeItems, reasoning: MessageDeps["reasoning"]): MessageDeps =>
  ({
    pool: {} as Pool,
    fields: {} as FieldCrypto,
    chat: { items } as unknown as MessageDeps["chat"],
    reasoning,
  }) as MessageDeps;

afterEach(() => vi.restoreAllMocks());

describe("toMessageDtos reasoning", () => {
  it("shows an earlier tool-loop frame's reasoning on a reply that was then refused", async () => {
    const w = world();
    await w.record("conv#o1#turn:0", [
      { kind: "summary", text: "weighing the tool result", signature: "S", provider: "anthropic" },
    ]);
    // the second frame was refused: nothing was captured for it
    const items = new FakeItems();
    await items.put(REF, 1, "conv#o1#turn:1", { kind: "outcome", body: { kind: "refusal" } });
    const deps = depsOf(
      items,
      replyReasoning({ log: { read: async () => w.log }, store: w.store }),
    );
    const [reply] = await toMessageDtos(deps, IDENTITY, CHAT, [entry({})]);
    expect(reply).toMatchObject({
      outcome: "refusal",
      reasoning: { text: "weighing the tool result", kind: "summary" },
    });
  });

  it("gives reasoning null when the read fails, and logs the error class only", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = replyReasoning({
      log: {
        read: async () => {
          throw new RangeError(secret);
        },
      },
      store: new ChatReasoningStore(
        new MemoryReasoningRows(),
        new FieldCrypto(new InMemoryKeyStore()),
      ),
    });
    const [reply] = await toMessageDtos(depsOf(new FakeItems(), failing), IDENTITY, CHAT, [
      entry({ text: "an answer" }),
    ]);
    expect(reply).toMatchObject({ text: "an answer", reasoning: null });
    expect(spy.mock.calls).toEqual([["chat reasoning read failed", "RangeError"]]);
  });

  it("skips an entry without a record ordinal instead of deriving an id from its cursor", async () => {
    const deps = depsOf(new FakeItems(), { forReplies: async () => new Map() });
    const { ord: _ord, ...noOrd } = entry({ role: "user", text: "q" });
    const got = await toMessageDtos(deps, IDENTITY, CHAT, [
      noOrd as HistoryEntry,
      entry({ ord: 4, turn: 2, cursor: "0.4" }),
    ]);
    expect(got.map((m) => m.id)).toEqual(["4"]);
    expect(turnKeyOf(noOrd as HistoryEntry)).toBeUndefined();
  });
});

describe("toMessageDtos failureReason", () => {
  const dto = async (over: Partial<HistoryEntry>) => {
    const deps = depsOf(new FakeItems(), { forReplies: async () => new Map() });
    const [m] = await toMessageDtos(deps, IDENTITY, CHAT, [entry(over)]);
    return m;
  };
  it.each([
    "rate-limited",
    "quota",
    "tool-error",
    "denied",
    "model-error",
    "turn-failed",
    "cancelled",
  ])("passes Loom's %s through on a failed reply", async (reason) => {
    expect((await dto({ status: "failed", reason }))?.failureReason).toBe(reason);
  });
  it.each([undefined, "too-long", "provider said: 429 secret-detail"])(
    "maps a missing or unknown reason (%s) to model-error without echoing it",
    async (reason) => {
      const m = await dto({ status: "failed", ...(reason !== undefined && { reason }) });
      expect(m?.failureReason).toBe("model-error");
      expect(JSON.stringify(m)).not.toContain("secret-detail");
    },
  );
  it("sets none on a reply that did not fail, a rejected message or a user message", async () => {
    expect(await dto({ status: "complete", reason: "quota" })).not.toHaveProperty("failureReason");
    expect(await dto({ status: "interrupted", reason: "quota" })).not.toHaveProperty(
      "failureReason",
    );
    expect(await dto({ role: "user", status: "rejected", reason: "denied" })).not.toHaveProperty(
      "failureReason",
    );
    expect(await dto({ role: "user", status: "failed", reason: "denied" })).not.toHaveProperty(
      "failureReason",
    );
  });
});

describe("toMessageDtos hasVisuals", () => {
  const DOC = "7f6d1b8e-3b0a-4a56-8f2f-0a8e0f7c4d11";
  const P1 = "c0ffee00-0000-4000-8000-000000000001";
  const passage = {
    passageId: P1,
    documentId: DOC,
    locator: { kind: "section" as const, index: 1 },
    headingPath: [],
    snippet: "x",
  };
  // the turn key of a reply is its ord minus its turn (turnKeyOf)
  const history = [
    entry({ ord: 1, turn: 1, role: "user", text: "q1" }),
    entry({ ord: 2, turn: 1, text: `Cited and visualised [[${P1}]].` }), // key 1, has a head
    entry({ ord: 3, turn: 2, role: "user", text: "q2" }),
    entry({ ord: 4, turn: 2, text: `Cited, no head [[${P1}]].` }), // key 2
    entry({ ord: 5, turn: 3, role: "user", text: "q3" }),
    entry({ ord: 6, turn: 3, text: "Not in the documents." }), // key 3: no passages, uncited
    entry({ ord: 7, turn: 4, role: "user", text: "q4" }),
    entry({ ord: 8, turn: 4, status: "interrupted", text: `Cut short [[${P1}]].` }), // key 4: cited but not complete
  ];
  const items = async () => {
    const fake = new FakeItems();
    for (const key of [1, 2, 4])
      await fake.put(REF, key, `conv#o${key}#turn:0#p`, {
        kind: "passages",
        body: { passages: [passage] },
      });
    return fake;
  };
  const noReasoning = { forReplies: async () => new Map() };

  it("marks each complete, cited reply from one batched lookup, and every other message false", async () => {
    const has = vi.fn(
      async (_ref: unknown, ords: readonly number[]) => new Set(ords.filter((o) => o === 2)),
    );
    const deps = { ...depsOf(await items(), noReasoning), heads: { has } } as MessageDeps;
    const out = await toMessageDtos(deps, IDENTITY, CHAT, history);
    expect(out.map((m) => [m.id, m.hasVisuals])).toEqual([
      ["1", false],
      ["2", true],
      ["3", false],
      ["4", false],
      ["5", false],
      ["6", false],
      ["7", false],
      ["8", false],
    ]);
    expect(has).toHaveBeenCalledTimes(1);
    expect(has).toHaveBeenCalledWith(REF, [2, 4]); // only complete, cited replies
  });
  it("marks visualizable only for a complete, cited reply while the visuals role is on", async () => {
    const on = await toMessageDtos(
      { ...depsOf(await items(), noReasoning), visualsOn: true } as MessageDeps,
      IDENTITY,
      CHAT,
      history,
    );
    expect(on.map((m) => [m.id, m.visualizable])).toEqual([
      ["1", false],
      ["2", true],
      ["3", false],
      ["4", true],
      ["5", false],
      ["6", false],
      ["7", false],
      ["8", false],
    ]);
    const off = await toMessageDtos(depsOf(await items(), noReasoning), IDENTITY, CHAT, history);
    expect(off.every((m) => m.visualizable === false)).toBe(true);
  });
  it("makes no lookup when no reply qualifies, and says false everywhere when the server has no heads", async () => {
    const has = vi.fn(async () => new Set<number>());
    const uncited = await toMessageDtos(
      { ...depsOf(new FakeItems(), noReasoning), heads: { has } } as MessageDeps,
      IDENTITY,
      CHAT,
      history,
    );
    expect(has).not.toHaveBeenCalled();
    expect(uncited.every((m) => m.hasVisuals === false)).toBe(true);
    const none = await toMessageDtos(depsOf(await items(), noReasoning), IDENTITY, CHAT, history);
    expect(none.every((m) => m.hasVisuals === false)).toBe(true);
  });
});
