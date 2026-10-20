import { createAgentModelEffect } from "@loom/agent";
import type { AgentModelCall } from "@loom/agent";
import { type Effect, EffectRuntime } from "@loom/effect-runtime";
import type { LlmProvider, LlmResponse } from "@loom/llm";
import { describe, expect, it } from "vitest";
import { ChatBus, type LiveChatEvent } from "./bus";
import { chatModelEffect } from "./model";
import { type ChatCallScope, ChatScopeError, chatScope } from "./scope";
import { FakeItems, modelCtx } from "./testing";

const CALL: AgentModelCall = { messages: [{ role: "user", content: "hello" }] };

/** A provider that streams "Hel" + "lo" and records the chat scope it was called under. */
function streamingProvider(
  seen: (ChatCallScope | undefined)[],
  stop: LlmResponse["stopReason"] = "end_turn",
): LlmProvider {
  return {
    async complete() {
      seen.push(chatScope.current());
      return { content: "Hello", stopReason: stop };
    },
    async *stream() {
      seen.push(chatScope.current());
      yield { delta: "Hel", done: false };
      yield { delta: "lo", done: false };
      yield { delta: "", done: true, stopReason: stop };
    },
  };
}

function setup(
  over: { stop?: LlmResponse["stopReason"]; stream?: boolean; shutdown?: AbortSignal } = {},
) {
  const seen: (ChatCallScope | undefined)[] = [];
  const deltas: string[] = [];
  const items = new FakeItems();
  const events: LiveChatEvent[] = [];
  const bus = new ChatBus();
  bus.subscribe(modelCtx().executionId.slice(-36), (e) => events.push(e));
  const inner = createAgentModelEffect(streamingProvider(seen, over.stop), {
    stream: over.stream ?? true,
    onDelta: (d) => deltas.push(d),
  });
  const effect = chatModelEffect(inner, {
    items,
    bus,
    ...(over.shutdown && { shutdown: over.shutdown }),
  });
  const runtime = new EffectRuntime([]);
  runtime.register("chat-model", effect);
  return { runtime, effect, inner, seen, deltas, items, events };
}

describe("chatModelEffect on the real EffectRuntime (the probe)", () => {
  it("is still an llm effect: the runtime reports its kind and still feeds the configured delta sink", async () => {
    const s = setup();
    const out = (await s.runtime.execute("chat-model", CALL, modelCtx())) as LlmResponse;
    expect(s.runtime.kindOf("chat-model")).toBe("llm");
    expect(out.content).toBe("Hello");
    expect(s.deltas.join("")).toBe("Hello");
  });

  it("runs the provider inside the call's chat scope", async () => {
    const s = setup();
    await s.runtime.execute("chat-model", CALL, modelCtx({ stepId: "conv#o4#turn:2" }));
    expect(s.seen[0]).toMatchObject({ turnKey: 4, stepKey: "conv#o4#turn:2", attempt: 1 });
    expect(chatScope.current()).toBeUndefined();
  });

  it("copies the capability fields of the inner effect", () => {
    const s = setup();
    const e: Effect = s.effect;
    const inner: Effect = s.inner;
    expect([e.kind, e.idempotent, e.mode, typeof e.deltaSink]).toEqual([
      inner.kind,
      inner.idempotent,
      inner.mode,
      typeof inner.deltaSink,
    ]);
    expect(typeof e.warm).toBe(typeof inner.warm);
  });
});

describe("chatModelEffect behaviour", () => {
  it("forwards every key of the inner effect except execute (reasoningSink, resourceOf, ...)", () => {
    const sink = () => {};
    const inner = {
      kind: "llm",
      idempotent: true,
      reasoning: { supported: true },
      reasoningSink: sink,
      resourceOf: () => "r",
      execute: async () => ({ content: "", stopReason: "end_turn" }),
    } as unknown as Effect<AgentModelCall, LlmResponse>;
    const wrapped = chatModelEffect(inner, { items: new FakeItems(), bus: new ChatBus() });
    for (const k of Object.keys(inner).filter((k) => k !== "execute"))
      expect(k in wrapped).toBe(true);
    const s = setup();
    const own = (e: object) =>
      Object.getOwnPropertyNames(Object.getPrototypeOf(e)).filter(
        (k) => k !== "constructor" && k !== "execute",
      );
    for (const k of own(s.inner)) expect(k in s.effect).toBe(true);
  });

  it("on shutdown a failing max_tokens put does not fail the step: it stays pending", async () => {
    const stop = new AbortController();
    const inner: Effect<AgentModelCall, LlmResponse> = {
      kind: "llm",
      async execute() {
        stop.abort();
        return { content: "x", stopReason: "max_tokens" };
      },
    };
    const items = {
      put: async () => {
        throw new RangeError("db down");
      },
      remove: async () => {},
    };
    const effect = chatModelEffect(inner, { items, bus: new ChatBus(), shutdown: stop.signal });
    const SENTINEL = Symbol("sentinel");
    const sentinel = new Promise<typeof SENTINEL>((resolve) =>
      setTimeout(() => resolve(SENTINEL), 0),
    );
    const winner = await Promise.race([
      effect.execute(CALL, modelCtx()).then(
        () => "settled",
        () => "settled",
      ),
      sentinel,
    ]);
    expect(winner).toBe(SENTINEL);
  });

  it("a retried attempt drops the earlier attempt's outcome row of its own step, and keeps other frames' rows", async () => {
    const s = setup();
    await s.items.put({} as never, 3, "conv#o3#turn:1", {
      kind: "outcome",
      body: { kind: "max_tokens" },
    });
    await s.items.put({} as never, 3, "conv#o3#turn:0", {
      kind: "outcome",
      body: { kind: "max_tokens" },
    });
    await s.runtime.execute("chat-model", CALL, modelCtx({ attempt: 2 }));
    expect(s.items.puts.map((p) => p.stepKey)).toEqual(["conv#o3#turn:0"]);
  });

  it("refuses a call outside a chat conversation before the provider is reached", async () => {
    const s = setup();
    await expect(
      s.runtime.execute("chat-model", CALL, modelCtx({ workflowId: "ingest-document" })),
    ).rejects.toBeInstanceOf(ChatScopeError);
    expect(s.seen).toEqual([]);
  });

  it("publishes a reset for a retried attempt, and not for the first", async () => {
    const s = setup();
    await s.runtime.execute("chat-model", CALL, modelCtx({ attempt: 1 }));
    expect(s.events).toEqual([]);
    await s.runtime.execute("chat-model", CALL, modelCtx({ attempt: 2 }));
    expect(s.events).toEqual([{ kind: "reset", turnKey: 3 }]);
  });

  it("records a max_tokens outcome under the call's step key, and nothing for a normal stop", async () => {
    const cut = setup({ stop: "max_tokens", stream: false });
    await cut.runtime.execute("chat-model", CALL, modelCtx());
    expect(cut.items.puts).toEqual([
      {
        turnKey: 3,
        stepKey: "conv#o3#turn:1",
        item: { kind: "outcome", body: { kind: "max_tokens" } },
      },
    ]);
    const fine = setup();
    await fine.runtime.execute("chat-model", CALL, modelCtx());
    expect(fine.items.puts).toEqual([]);
  });

  it("on shutdown cuts the call and never settles, so the step stays un-completed for recovery", async () => {
    const stop = new AbortController();
    let sawAbort = false;
    const inner: Effect<AgentModelCall, LlmResponse> = {
      kind: "llm",
      async execute(_input, ctx) {
        sawAbort = ctx.signal?.aborted === true;
        throw new TypeError("the provider aborted");
      },
    };
    const effect = chatModelEffect(inner, {
      items: new FakeItems(),
      bus: new ChatBus(),
      shutdown: stop.signal,
    });
    stop.abort();
    const SENTINEL = Symbol("sentinel");
    const sentinel = new Promise<typeof SENTINEL>((resolve) =>
      setTimeout(() => resolve(SENTINEL), 0),
    );
    const winner = await Promise.race([
      effect.execute(CALL, modelCtx()).then(
        () => "settled",
        () => "settled",
      ),
      sentinel,
    ]);
    expect([sawAbort, winner]).toEqual([true, SENTINEL]);
  });

  it("still fails a call that errors while no shutdown is under way", async () => {
    const inner: Effect<AgentModelCall, LlmResponse> = {
      kind: "llm",
      async execute() {
        throw new RangeError("boom");
      },
    };
    const effect = chatModelEffect(inner, {
      items: new FakeItems(),
      bus: new ChatBus(),
      shutdown: new AbortController().signal,
    });
    await expect(effect.execute(CALL, modelCtx())).rejects.toBeInstanceOf(RangeError);
  });
});
