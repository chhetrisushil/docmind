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
