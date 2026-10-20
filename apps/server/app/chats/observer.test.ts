import { AnthropicMessagesProvider, type CallObserver } from "@docmind/llm-anthropic";
import { type FakeAnthropic, startFakeAnthropic } from "@docmind/llm-anthropic/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatBus, type LiveChatEvent } from "./bus";
import { chatObserver } from "./observer";
import { type ChatCallScope, chatScope } from "./scope";
import { C, FakeBlocks, FakeItems, T, U } from "./testing";

const SCOPE: ChatCallScope = {
  tenantId: T,
  userId: U,
  chatId: C,
  turnKey: 3,
  stepKey: "conv#o3#turn:0",
  attempt: 1,
};
const REF = { tenantId: T, userId: U, chatId: C };
const THINKING = "Weighing the Nocturne forecast question carefully.";

let items: FakeItems;
let blocks: FakeBlocks;
let events: LiveChatEvent[];
let observe: () => CallObserver | undefined;

beforeEach(() => {
  items = new FakeItems();
  blocks = new FakeBlocks();
  events = [];
  const bus = new ChatBus();
  bus.subscribe(C, (e) => events.push(e));
  observe = chatObserver({ items, blocks, bus });
});

describe("chatObserver", () => {
  it("is absent outside a chat scope", () => {
    expect(observe()).toBeUndefined();
  });

  it("streams thinking to the bus keyed by the turn, and stores one thinking item at the end of the response", async () => {
    const o = (await chatScope.run(SCOPE, async () => observe())) as CallObserver;
    o.onThinking?.("Weighing the Nocturne ");
    o.onThinking?.("forecast question carefully.");
    await o.onBlocks?.([], [{ type: "thinking", thinking: "t", signature: "s" }]);
    expect(events).toEqual([
      { kind: "thinking", turnKey: 3, text: "Weighing the Nocturne " },
      { kind: "thinking", turnKey: 3, text: "forecast question carefully." },
    ]);
    expect(items.puts).toEqual([
      {
        turnKey: 3,
        stepKey: "conv#o3#turn:0",
        item: { kind: "thinking", body: { text: THINKING } },
      },
    ]);
  });

  it("stores reasoning blocks under the tool-use ids and reads them back for the next request", async () => {
    const o = (await chatScope.run(SCOPE, async () => observe())) as CallObserver;
    const content = [
      { type: "thinking", thinking: "x", signature: "sig" },
      { type: "tool_use", id: "toolu_1", name: "search_docs", input: {} },
    ] as const;
    await o.onBlocks?.(["toolu_1"], content);
    expect(await blocks.get(REF, ["toolu_1"])).toEqual(content);
    expect(items.puts).toEqual([]); // no thinking text was streamed
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

  it("stores the thinking once, at onBlocks: onUsage stores nothing", async () => {
    const o = (await chatScope.run(SCOPE, async () => observe())) as CallObserver;
    o.onThinking?.("abc");
    o.onUsage({ inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(items.puts).toEqual([]);
    await o.onBlocks?.([], [{ type: "thinking", thinking: "abc", signature: "s" }]);
    expect(items.puts.filter((p) => p.item.kind === "thinking")).toHaveLength(1);
  });

  it("stores no thinking item for a refused turn, and tells the bus to drop what it showed", async () => {
    const o = (await chatScope.run(SCOPE, async () => observe())) as CallObserver;
    o.onThinking?.("abc");
    await o.onRefusal({ category: "policy" });
    await o.onBlocks?.([], [{ type: "thinking", thinking: "abc", signature: "s" }]);
    expect(items.puts.map((p) => p.item.kind)).toEqual(["outcome"]);
    expect(events.at(-1)).toEqual({ kind: "reset", turnKey: 3 });
  });

  it("a refusal removes the thinking row an earlier attempt of the step left, not other frames'", async () => {
    await items.put(REF, 3, "conv#o3#turn:0", { kind: "thinking", body: { text: "stale" } });
    await items.put(REF, 3, "conv#o3#turn:1", { kind: "thinking", body: { text: "other frame" } });
    const o = (await chatScope.run(SCOPE, async () => observe())) as CallObserver;
    await o.onRefusal({ category: "policy" });
    expect(items.puts.map((p) => `${p.stepKey}:${p.item.kind}`)).toEqual([
      "conv#o3#turn:1:thinking",
      "conv#o3#turn:0:outcome",
    ]);
  });

  it("keeps two concurrent observers of different chats apart", async () => {
    const C2 = "c4c4c4c4-c4c4-4c4c-8c4c-c4c4c4c4c4c4";
    const U2 = "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2";
    const refs: { userId: string; chatId: string }[] = [];
    const puts: { chatId: string; kind: string }[] = [];
    const bus = new ChatBus();
    const got: Record<string, string[]> = { [C]: [], [C2]: [] };
    bus.subscribe(C, (e) => e.kind === "thinking" && got[C]?.push(e.text));
    bus.subscribe(C2, (e) => e.kind === "thinking" && got[C2]?.push(e.text));
    const obs = chatObserver({
      items: {
        put: async (r, _t, _s, i) => {
          refs.push(r);
          await Promise.resolve();
          puts.push({ chatId: r.chatId, kind: i.kind });
        },
        remove: async () => {},
      },
      blocks: new FakeBlocks(),
      bus,
    });
    const s2: ChatCallScope = { ...SCOPE, userId: U2, chatId: C2 };
    const a = (await chatScope.run(SCOPE, async () => obs())) as CallObserver;
    const b = (await chatScope.run(s2, async () => obs())) as CallObserver;
    a.onThinking?.("a1");
    b.onThinking?.("b1");
    await Promise.all([
      a.onBlocks?.([], [{ type: "thinking", thinking: "t", signature: "s" }]),
      b.onBlocks?.([], [{ type: "thinking", thinking: "t", signature: "s" }]),
    ]);
    expect(got).toEqual({ [C]: ["a1"], [C2]: ["b1"] });
    expect(refs.map((r) => `${r.userId}/${r.chatId}`).sort()).toEqual(
      [`${U}/${C}`, `${U2}/${C2}`].sort(),
    );
    expect(puts.map((p) => p.chatId).sort()).toEqual([C, C2].sort());
  });

  it("caps the stored thinking", async () => {
    const o = (await chatScope.run(SCOPE, async () => observe())) as CallObserver;
    o.onThinking?.("x".repeat(40_000));
    await o.onBlocks?.([], [{ type: "thinking", thinking: "t", signature: "s" }]);
    const put = items.puts[0]?.item;
    expect(put?.kind === "thinking" && put.body.text.length).toBe(32_000);
  });
});

describe("chatObserver with the real provider and FakeAnthropic (Phase A contract)", () => {
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
  const drain = (
    p: AnthropicMessagesProvider,
    messages: Parameters<AnthropicMessagesProvider["stream"]>[0]["messages"],
  ) =>
    chatScope.run(SCOPE, async () => {
      const chunks = [];
      for await (const c of p.stream({ messages })) chunks.push(c);
      return chunks;
    });

  beforeEach(async () => {
    fake = await startFakeAnthropic();
  });
  afterEach(async () => {
    await fake.close();
  });

  it("a final answer with thinking: the thinking reaches the bus and is stored as an item, the answer carries no thinking", async () => {
    fake.reply(() => ({
      stream: {
        steps: [
          { thinking: THINKING },
          { signature: "sig-1" },
          { text: "Seventeen thousand." },
          { stop: "end_turn" },
        ],
      },
    }));
    const chunks = await drain(provider(), [{ role: "user", content: "forecast?" }]);
    expect(chunks.map((c) => c.delta).join("")).toBe("Seventeen thousand.");
    expect(
      events
        .filter((e) => e.kind === "thinking")
        .map((e) => (e.kind === "thinking" ? e.text : ""))
        .join(""),
    ).toBe(THINKING);
    expect(items.puts.map((p) => p.item)).toEqual([{ kind: "thinking", body: { text: THINKING } }]);
  });

  it("a refusal: stored as an outcome item, and the stream ends normally with the text it had", async () => {
    fake.reply(() => ({
      stream: {
        steps: [
          { text: "I can" },
          { stop: "refusal", details: { category: "policy", explanation: "No." } },
        ],
      },
    }));
    const chunks = await drain(provider(), [{ role: "user", content: "x" }]);
    expect(chunks.at(-1)?.stopReason).toBe("end_turn");
    expect(items.puts.map((p) => p.item)).toEqual([
      {
        kind: "outcome",
        body: { kind: "refusal", details: { category: "policy", explanation: "No." } },
      },
    ]);
  });
});
