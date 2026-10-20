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
          seen.push({
            ref: { tenantId: ref.tenantId, userId: ref.userId, chatId: ref.chatId },
            turnKey,
            item,
          });
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

  it("a thinking answer stores no item: reasoning is Loom's, not the observer's", async () => {
    fake.reply(() => ({
      stream: {
        steps: [
          { thinking: "Weighing it." },
          { signature: "sig-1" },
          { text: "Done." },
          { stop: "end_turn" },
        ],
      },
    }));
    const chunks = await drain([{ role: "user", content: "q" }]);
    expect(chunks.map((c) => c.delta).join("")).toBe("Done.");
    expect(chunks.at(-1)?.reasoning).toEqual([
      { kind: "summary", text: "Weighing it.", signature: "sig-1", provider: "anthropic" },
    ]);
    expect(items.puts).toEqual([]);
  });
});
