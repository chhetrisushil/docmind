import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../config";
import { FieldCrypto } from "../crypto/fields";
import {
  CHAT_EFFECT_IDS,
  CHAT_FLOW_ID,
  CHAT_GK_FLOW_ID,
  CHAT_MODEL_TOOL_ID,
  CHAT_TOOL_IDS,
} from "./ids";
import { createChatLlm } from "./llm";
import { ChatReasoningStore } from "./reasoningStore";
import { loadChatSettings } from "./settings";
import { FakeItems, MemoryReasoningRows } from "./testing";
import { FakeChats } from "./tools/testing";
import { connectChat, logHopError, prepareChat } from "./wiring";

const KEY = "k".repeat(32);
const collaborators = () => ({
  items: new FakeItems(),
  retriever: { search: async () => [], related: async () => [] },
  passages: { read: async () => new Map(), section: async () => [] },
  chats: new FakeChats("all"),
  documents: { summary: async () => null, list: async () => [] },
  reasoning: new ChatReasoningStore(
    new MemoryReasoningRows(),
    new FieldCrypto(new InMemoryKeyStore()),
  ),
});
const env = {
  DOCMIND_LLM_PROVIDER: "anthropic",
  ANTHROPIC_API_KEY: "sk-test-not-real",
  DOCMIND_CHAT_ENVELOPE_KEY: KEY,
};

function prepare(over: Record<string, string> = {}, withLlm = true, legacyOnly = false) {
  const e = { ...env, ...over };
  const settings = loadChatSettings(withLlm ? e : { DOCMIND_LLM_PROVIDER: "off" });
  const store = new InMemoryAsyncEventStore();
  const llm = withLlm ? createChatLlm(e, settings) : undefined;
  const prepared = prepareChat({
    settings,
    ...(llm && { llm }),
    collaborators: collaborators(),
    eventStore: store,
    timers: new InMemoryTimerStore(),
    ...(legacyOnly && { legacyOnly }),
  });
  return { prepared, store, llm };
}

describe("prepareChat", () => {
  it("gives the chat model effect the reasoning store and the hub's live sink, so Loom's boot warning has nobody to name", () => {
    const effect = prepare().prepared.deps.effects[CHAT_MODEL_TOOL_ID] as unknown as {
      reasoning?: { capable: boolean; posture(): string };
    };
    expect(effect.reasoning?.capable).toBe(true);
    expect(effect.reasoning?.posture()).toBe("keeps"); // not "unconfigured": the boot warning needs that
  });

  it("registers the five tools and, with a key, the model effect; never anything else", () => {
    expect(Object.keys(prepare().prepared.deps.effects).sort()).toEqual(
      [...CHAT_EFFECT_IDS].sort(),
    );
    expect(Object.keys(prepare({}, false).prepared.deps.effects).sort()).toEqual(
      [...CHAT_TOOL_IDS].sort(),
    );
  });

  it("builds both flows and chats start under the strict one unless general knowledge is on", () => {
    const strict = prepare().prepared;
    expect(strict.deps.flows.map((f) => `${f.definition.id}@${f.definition.version}`)).toEqual([
      `${CHAT_FLOW_ID}@1.0.0`,
      `${CHAT_GK_FLOW_ID}@1.0.0`,
      `${CHAT_FLOW_ID}@1.1.0`,
      `${CHAT_GK_FLOW_ID}@1.1.0`,
    ]);
    expect(strict.active.definition.version).toBe("1.1.0");
    expect(prepare({}, false).prepared.deps.effects["chat-summarize"]).toBeUndefined();
    expect(prepare().prepared.deps.effects["chat-summarize"]).toBeDefined();
    expect(strict.active.definition.id).toBe(CHAT_FLOW_ID);
    expect(prepare({ DOCMIND_CHAT_GENERAL_KNOWLEDGE: "true" }).prepared.active.definition.id).toBe(
      CHAT_GK_FLOW_ID,
    );
  });

  it("legacyOnly registers just the 1.0.0 flows and starts chats on 1.0.0", () => {
    const { prepared } = prepare({}, true, true);
    expect(prepared.deps.flows.map((f) => `${f.definition.id}@${f.definition.version}`)).toEqual([
      `${CHAT_FLOW_ID}@1.0.0`,
      `${CHAT_GK_FLOW_ID}@1.0.0`,
    ]);
    expect(prepared.active.definition.version).toBe("1.0.0");
  });

  it("fills the provider's observer slot, and reports chat unavailable without a key", () => {
    const withKey = prepare();
    expect(typeof withKey.llm?.observer.current).toBe("function");
    expect([withKey.prepared.available, prepare({}, false).prepared.available]).toEqual([
      true,
      false,
    ]);
  });
});

describe("connectChat and buildApp", () => {
  it("registers the flows and effects on the real runtime, under the owner-only policy", async () => {
    const { prepared, store } = prepare();
    const app = buildApp({ kind: "custom", eventStore: store }, undefined, { chat: prepared.deps });
    expect(app.runtime.getFlowIds()).toEqual(
      expect.arrayContaining([CHAT_FLOW_ID, CHAT_GK_FLOW_ID]),
    );
    expect(app.effectRuntime.kindOf("chat-model")).toBe("llm");
    expect(app.effectRuntime.kindOf("search_docs")).toBe("tool");
    // createConversations refuses a policy that is not owner-scoped for every op it polices (fact C1).
    const chat = connectChat(prepared, app.runtime, store);
    expect([chat.conversations.mode, chat.conversations.requiresPrincipal]).toEqual([
      "owner",
      true,
    ]);
    await app.close();
  });

  it("close() aborts the shutdown signal the model effect watches, once", async () => {
    const { prepared, store } = prepare();
    const app = buildApp({ kind: "custom", eventStore: store }, undefined, { chat: prepared.deps });
    const chat = connectChat(prepared, app.runtime, store);
    expect(prepared.shutdown.signal.aborted).toBe(false);
    await chat.close();
    await chat.close();
    expect(prepared.shutdown.signal.aborted).toBe(true);
    await app.close();
  });
});

describe("logHopError", () => {
  it("logs the hop and the error class only", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logHopError(2, "TypeError");
    expect(spy.mock.calls).toEqual([["chat retrieval hop failed", 2, "TypeError"]]);
    spy.mockRestore();
  });
});
