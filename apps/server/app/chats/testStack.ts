import {
  type FakeAnthropic,
  type StreamScript,
  startFakeAnthropic,
} from "@docmind/llm-anthropic/testing";
import { followConversation } from "@loom/conversation";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import { EncryptingEventStore, InMemoryKeyStore, type KeyStore } from "@loom/plugin-crypto";
import { buildApp } from "../config";
import { FieldCrypto } from "../crypto/fields";
import { SENSITIVE_EVENT_PATHS } from "../sensitive";
import { subjectOfExecution } from "../subject";
import { chatConversationId } from "./ids";
import { createChatLlm } from "./llm";
import type { Passage } from "./retrieval";
import { loadChatSettings } from "./settings";
import { ChatReasoningStore } from "./reasoningStore";
import { C, FakeItems, MemoryReasoningRows, T, U } from "./testing";
import { FakeChats } from "./tools/testing";
import { type ChatWiring, connectChat, prepareChat } from "./wiring";

export interface ChatStack {
  app: ReturnType<typeof buildApp>;
  chat: ChatWiring;
  fake: FakeAnthropic;
  /** The unsealed log, as Postgres would hold it. */
  raw: InMemoryAsyncEventStore;
  items: FakeItems;
  /** The decrypting view of the log (what a route reads reasoning through). */
  events: EncryptingEventStore;
  reasoning: ChatReasoningStore;
  /** The sealed rows the reasoning store wrote. */
  reasoningRows: MemoryReasoningRows;
  /** Every subject a key was requested for: the proof that nothing is sealed under another user. */
  subjects: ReadonlySet<string>;
  start(): Promise<string>;
  send(conversationId: string, text: string): Promise<void>;
  /** Waits until the conversation has `n` assistant messages and returns all of them so far. */
  replies(conversationId: string, n: number): Promise<{ text: string; status: string }[]>;
  close(): Promise<void>;
}

const PRINCIPAL = { tenant: T, actor: U };

/**
 * A real Loom app with the production sealing, the real conversation flow, the real tools and model
 * effect, the real provider against FakeAnthropic, over an in-memory log. Retrieval and the stores are
 * fakes (so no Postgres), which is what the sealing and flow tests need; Task 155 runs the same chat
 * over Postgres and fake Ollama.
 */
export async function startChatStack(o: {
  scripts: StreamScript[];
  passages?: Passage[];
  rotateEveryTurns?: number;
  generalKnowledge?: boolean;
  /** Makes retrieval throw this (to prove a collaborator's message never reaches the log). */
  searchError?: Error;
}): Promise<ChatStack> {
  const fake = await startFakeAnthropic();
  const queue = [...o.scripts];
  fake.reply(() => ({ stream: queue.shift() as StreamScript }));
  const env = {
    ANTHROPIC_API_KEY: "sk-test-not-real",
    ANTHROPIC_BASE_URL: fake.url,
    DOCMIND_CHAT_ENVELOPE_KEY: "e".repeat(32),
    ...(o.generalKnowledge && { DOCMIND_CHAT_GENERAL_KNOWLEDGE: "true" }),
  };
  const settings = loadChatSettings(env);
  const llm = createChatLlm(env, settings);
  const raw = new InMemoryAsyncEventStore();
  const subjects = new Set<string>();
  const keys = new InMemoryKeyStore();
  const recording: KeyStore = {
    getOrCreate: (id) => {
      subjects.add(id);
      return keys.getOrCreate(id);
    },
    get: (id) => {
      subjects.add(id);
      return keys.get(id);
    },
    destroy: (id) => keys.destroy(id),
  };
  const events = new EncryptingEventStore(raw, recording, {
    sensitive: { ...SENSITIVE_EVENT_PATHS },
    subjectOf: subjectOfExecution,
  });
  const items = new FakeItems();
  const reasoningRows = new MemoryReasoningRows();
  const reasoning = new ChatReasoningStore(reasoningRows, new FieldCrypto(recording));
  const prepared = prepareChat({
    settings,
    ...(llm && { llm }),
    eventStore: events,
    timers: new InMemoryTimerStore(),
    ...(o.rotateEveryTurns !== undefined && { rotateEveryTurns: o.rotateEveryTurns }),
    collaborators: {
      items,
      reasoning,
      retriever: {
        search: async () => {
          if (o.searchError) throw o.searchError;
          return o.passages ?? [];
        },
        related: async () => [],
      },
      passages: { read: async () => new Map(), section: async () => [] },
      chats: new FakeChats("all"),
      documents: { summary: async () => null, list: async () => [] },
    },
  });
  const app = buildApp({ kind: "custom", eventStore: events }, { events }, { chat: prepared.deps });
  const chat = connectChat(prepared, app.runtime, events);
  return {
    app,
    chat,
    fake,
    raw,
    items,
    events,
    reasoning,
    reasoningRows,
    subjects,
    async start() {
      const { conversationId } = await chat.conversations.start({
        conversationId: chatConversationId(U, C),
        principal: PRINCIPAL,
      });
      return conversationId;
    },
    async send(conversationId, text) {
      await chat.conversations.sendTurn(conversationId, text, { principal: PRINCIPAL });
    },
    async replies(conversationId, n) {
      const stop = new AbortController();
      const out: { text: string; status: string }[] = [];
      for await (const item of followConversation(
        { reader: chat.reader, eventStore: events },
        conversationId,
        {
          signal: stop.signal,
          pollMs: 20,
        },
      )) {
        if (item.type !== "message" || item.entry.role !== "assistant") continue;
        out.push({ text: item.entry.text, status: item.entry.status });
        if (out.length === n) {
          stop.abort();
          break;
        }
      }
      return out;
    },
    async close() {
      await chat.close();
      await app.close();
      await fake.close();
    },
  };
}
