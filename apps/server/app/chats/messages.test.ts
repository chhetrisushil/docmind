import type { Identity } from "@docmind/auth";
import type { HistoryEntry } from "@loom/conversation";
import { type LlmReasoning, captureReasoning } from "@loom/llm";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FieldCrypto } from "../crypto/fields";
import { chatConversationId } from "./ids";
import { type MessageDeps, toMessageDtos, turnKeyOf } from "./messages";
import { replyReasoning } from "./reasoningRead";
import { ChatReasoningStore } from "./reasoningStore";
import { type ChatCallScope, chatScope } from "./scope";
import { C, FakeItems, MemoryReasoningRows, T, U, modelCtx } from "./testing";

const CONV = chatConversationId(U, C);
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
    const [reply] = await toMessageDtos(deps, IDENTITY, C, [entry({})]);
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
    const [reply] = await toMessageDtos(depsOf(new FakeItems(), failing), IDENTITY, C, [
      entry({ text: "an answer" }),
    ]);
    expect(reply).toMatchObject({ text: "an answer", reasoning: null });
    expect(spy.mock.calls).toEqual([["chat reasoning read failed", "RangeError"]]);
  });

  it("skips an entry without a record ordinal instead of deriving an id from its cursor", async () => {
    const deps = depsOf(new FakeItems(), { forReplies: async () => new Map() });
    const { ord: _ord, ...noOrd } = entry({ role: "user", text: "q" });
    const got = await toMessageDtos(deps, IDENTITY, C, [
      noOrd as HistoryEntry,
      entry({ ord: 4, turn: 2, cursor: "0.4" }),
    ]);
    expect(got.map((m) => m.id)).toEqual(["4"]);
    expect(turnKeyOf(noOrd as HistoryEntry)).toBeUndefined();
  });
});
