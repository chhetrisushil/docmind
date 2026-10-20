import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import { buildApp } from "../config";
import { CHAT_EFFECT_IDS, CHAT_FLOW_ID, CHAT_GK_FLOW_ID, CHAT_TOOL_IDS } from "./ids";
import { createChatLlm } from "./llm";
import { loadChatSettings } from "./settings";
import { FakeBlocks, FakeItems } from "./testing";
import { FakeChats } from "./tools/testing";
import { connectChat, prepareChat } from "./wiring";

const KEY = "k".repeat(32);
const collaborators = () => ({
  items: new FakeItems(),
  blocks: new FakeBlocks(),
  retriever: { search: async () => [], related: async () => [] },
  passages: { read: async () => new Map(), section: async () => [] },
  chats: new FakeChats("all"),
  documents: { summary: async () => null, list: async () => [] },
});
const env = { ANTHROPIC_API_KEY: "sk-test-not-real", DOCMIND_CHAT_ENVELOPE_KEY: KEY };

function prepare(over: Record<string, string> = {}, withLlm = true) {
  const e = { ...env, ...over };
  const settings = loadChatSettings(withLlm ? e : {});
  const store = new InMemoryAsyncEventStore();
  const llm = withLlm ? createChatLlm(e, settings) : undefined;
  const prepared = prepareChat({
    settings,
    ...(llm && { llm }),
    collaborators: collaborators(),
    eventStore: store,
    timers: new InMemoryTimerStore(),
  });
  return { prepared, store, llm };
}

describe("prepareChat", () => {
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
    expect(strict.deps.flows.map((f) => f.definition.id)).toEqual([CHAT_FLOW_ID, CHAT_GK_FLOW_ID]);
    expect(strict.active.definition.id).toBe(CHAT_FLOW_ID);
    expect(prepare({ DOCMIND_CHAT_GENERAL_KNOWLEDGE: "true" }).prepared.active.definition.id).toBe(
      CHAT_GK_FLOW_ID,
    );
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
