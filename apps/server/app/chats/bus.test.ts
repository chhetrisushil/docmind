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
    bus.publish("a", { kind: "thinking", turnKey: 1, text: "x" });
    bus.publish("a", { kind: "tool", turnKey: 1, step });
    a.off();
    bus.publish("a", { kind: "thinking", turnKey: 1, text: "y" });
    expect(a.got.map((e) => e.kind)).toEqual(["thinking", "tool"]);
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

  it("accumulates the running turn's thinking for a late joiner, and starts over on a new turn", () => {
    const bus = new ChatBus();
    expect(bus.partial("a")).toBeNull();
    bus.publish("a", { kind: "thinking", turnKey: 3, text: "Looking " });
    bus.publish("a", { kind: "thinking", turnKey: 3, text: "at it." });
    expect(bus.partial("a")).toEqual({ turnKey: 3, thinking: "Looking at it." });
    bus.publish("a", { kind: "thinking", turnKey: 5, text: "Next." });
    expect(bus.partial("a")).toEqual({ turnKey: 5, thinking: "Next." });
  });

  it("keeps only the tail of an over-long thinking partial", () => {
    const bus = new ChatBus({ maxThinkingChars: 10 });
    bus.publish("a", { kind: "thinking", turnKey: 1, text: "0123456789" });
    bus.publish("a", { kind: "thinking", turnKey: 1, text: "abc" });
    expect(bus.partial("a")).toEqual({ turnKey: 1, thinking: "3456789abc" });
  });

  it("clears the partial on a reset (a new attempt) and on end of its turn, but not another turn's", () => {
    const bus = new ChatBus();
    bus.publish("a", { kind: "thinking", turnKey: 2, text: "old" });
    bus.publish("a", { kind: "reset", turnKey: 2 });
    expect(bus.partial("a")).toBeNull();
    bus.publish("a", { kind: "thinking", turnKey: 2, text: "new" });
    bus.publish("a", { kind: "reset", turnKey: 1 }); // another turn's reset changes nothing either
    expect(bus.partial("a")).toEqual({ turnKey: 2, thinking: "new" });
    bus.end("a", 1); // an earlier turn's end must not clear this one
    expect(bus.partial("a")).toEqual({ turnKey: 2, thinking: "new" });
    bus.end("a", 2);
    expect(bus.partial("a")).toBeNull();
  });

  it("does not let a tool event disturb the partial", () => {
    const bus = new ChatBus();
    bus.publish("a", { kind: "thinking", turnKey: 1, text: "t" });
    bus.publish("a", { kind: "tool", turnKey: 1, step });
    expect(bus.partial("a")).toEqual({ turnKey: 1, thinking: "t" });
  });

  it("bounds the chats it remembers, dropping the least recently written", () => {
    const bus = new ChatBus({ maxChats: 2 });
    for (const chat of ["a", "b", "c"])
      bus.publish(chat, { kind: "thinking", turnKey: 1, text: chat });
    expect([bus.partial("a"), bus.partial("b")?.thinking, bus.partial("c")?.thinking]).toEqual([
      null,
      "b",
      "c",
    ]);
  });

  it("refuses a subscriber beyond the per-chat limit with a typed error", () => {
    const bus = new ChatBus({ maxSubscribersPerChat: 1 });
    const first = bus.subscribe("a", () => {});
    expect(() => bus.subscribe("a", () => {})).toThrow(ChatBusLimitError);
    first();
    expect(() => bus.subscribe("a", () => {})).not.toThrow();
  });
});
