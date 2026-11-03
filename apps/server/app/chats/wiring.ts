import { createAgentModelEffect, createSummarizerEffect } from "@loom/agent";
import {
  type ConversationFlow,
  ConversationHub,
  type ConversationReader,
  type Conversations,
  createConversations,
  inboxBargeIn,
} from "@loom/conversation";
import type { Effect } from "@loom/effect-runtime";
import type { EventStore, TimerStore } from "@loom/event-runtime";
import type { RegisteredFlow, WorkflowRuntime } from "@loom/workflow-runtime";
import type { ChatDeps } from "../config";
import { executionAuthorizer } from "../security";
import { type ChatFlowConfig, SUMMARY_MAX_TOKENS, chatFlow } from "./agent";
import { ChatBus } from "./bus";
import { CHAT_MODEL_TOOL_ID, CHAT_SUMMARIZER_TOOL_ID } from "./ids";
import type { ChatLlm } from "./llm";
import { chatModelEffect } from "./model";
import { chatObserver } from "./observer";
import type { ChatReasoningStore } from "./reasoningStore";
import type { PassageReader, Retriever } from "./retrieval";
import type { ChatSettings } from "./settings";
import { StopRegistry, stoppableBargeIn } from "./stop";
import { tolerantSummarizer } from "./summarizer";
import { chatTools } from "./tools";
import type { DocumentReads } from "./tools/documents";
import type { ChatLookup } from "./tools/harness";
import type { PgTurnItems } from "./turnItems";

export interface ChatCollaborators {
  items: Pick<PgTurnItems, "put" | "remove" | "forTurns">;
  retriever: Pick<Retriever, "search" | "related">;
  passages: Pick<PassageReader, "read" | "section">;
  chats: ChatLookup;
  documents: DocumentReads;
  reasoning: Pick<ChatReasoningStore, "put" | "get" | "readerFor">;
}

export interface PrepareChatOptions {
  settings: ChatSettings;
  /** Absent without an API key: the tools and flows still register, the model effect does not (D12). */
  llm?: ChatLlm;
  collaborators: ChatCollaborators;
  /** The decrypting event store the runtime appends to (the barge-in watcher and the reader read it). */
  eventStore: EventStore;
  timers: TimerStore;
  onError?: ChatFlowConfig["onError"];
  rotateEveryTurns?: number;
  /** Test seam: register and start only the 1.0.0 flows (a server from before the summary). */
  legacyOnly?: boolean;
}

export interface PreparedChat {
  hub: ConversationHub;
  bus: ChatBus;
  stops: StopRegistry;
  /** Aborted by `close()`: cuts in-flight model calls and leaves their steps un-completed for recovery. */
  shutdown: AbortController;
  settings: ChatSettings;
  collaborators: ChatCollaborators;
  available: boolean;
  /** The flow new chats start under (strict, or general knowledge when the flag is on). */
  active: ConversationFlow;
  deps: ChatDeps;
}

const logTurnError: NonNullable<ChatFlowConfig["onError"]> = (errorId, err) =>
  console.error(
    "chat turn failed",
    errorId,
    err instanceof Error ? err.constructor.name : typeof err,
  );

/** Everything that must exist before `buildApp`: the flows, the effects and the in-process pieces. */
export function prepareChat(o: PrepareChatOptions): PreparedChat {
  const { settings, collaborators: c } = o;
  const hub = new ConversationHub();
  const bus = new ChatBus();
  const stops = new StopRegistry();
  const shutdown = new AbortController();
  const flowConfig: ChatFlowConfig = {
    key: settings.envelopeKey,
    ...(settings.previousKeys.length > 0 && { previousKeys: settings.previousKeys }),
    contextTokens: settings.contextTokens,
    maxTokens: settings.maxTokens,
    generalKnowledge: false,
    hub,
    bargeIn: stoppableBargeIn(inboxBargeIn(o.eventStore), stops),
    onError: o.onError ?? logTurnError,
    ...(o.rotateEveryTurns !== undefined && { rotateEveryTurns: o.rotateEveryTurns }),
  };
  const legacy = chatFlow(flowConfig);
  const legacyGk = chatFlow({ ...flowConfig, generalKnowledge: true });
  const withSummary = { ...flowConfig, summarizerToolId: CHAT_SUMMARIZER_TOOL_ID };
  const strict = o.legacyOnly ? legacy : chatFlow(withSummary);
  const gk = o.legacyOnly ? legacyGk : chatFlow({ ...withSummary, generalKnowledge: true });
  // ORDER MATTERS: Loom treats the last-registered version of a flow id as current (WorkflowRuntime; start() and the
  // rotation successor use it, ADR 0109 D3), so 1.1.0 must be registered after 1.0.0.
  // 1.0.0 stays registered: Loom resumes each conversation on the version it started on (ADR 0023), so a chat begun
  // before the summary keeps its code until its next rotation starts the successor on 1.1.0 (ADR 0109 D3).
  const flows = o.legacyOnly ? [legacy, legacyGk] : [legacy, legacyGk, strict, gk];
  const effects: Record<string, Effect> = chatTools({
    chats: c.chats,
    items: c.items,
    bus,
    retriever: c.retriever,
    passages: c.passages,
    documents: c.documents,
  });
  if (o.llm) {
    // Ollama reports no usage or cache telemetry, so on Ollama the observer receives none.
    o.llm.observer.current = chatObserver({ items: c.items });
    effects[CHAT_MODEL_TOOL_ID] = chatModelEffect(
      createAgentModelEffect(hub.wrapProvider(o.llm.provider), {
        stream: true,
        onDelta: hub.deltaSink(),
        // ADR 0133: Loom captures the model's reasoning into OUR store (sealed under the owner's key), streams it
        // live on the hub, and sends it back within a tool loop.
        reasoning: {
          store: c.reasoning,
          live: true,
          onDelta: hub.reasoningSink(),
          model: settings.model,
        },
      }),
      { items: c.items, bus, shutdown: shutdown.signal },
    );
    // The BARE summary provider (no thinking): the hub would stream the summary into the chat's live view as if it
    // were the answer, and thinking tokens would eat the summary's small max_tokens.
    effects[CHAT_SUMMARIZER_TOOL_ID] = tolerantSummarizer(
      createSummarizerEffect(o.llm.summaryProvider, { maxTokens: SUMMARY_MAX_TOKENS }),
      { shutdown: shutdown.signal },
    );
  }
  return {
    hub,
    bus,
    stops,
    shutdown,
    settings,
    collaborators: c,
    available: o.llm !== undefined,
    active: settings.generalKnowledge ? gk : strict,
    // Conversation flows are typed by their carry; `flows` takes them untyped (Conversations does the same cast).
    deps: { flows: flows as unknown as RegisteredFlow[], effects, timers: o.timers },
  };
}

export interface ChatWiring {
  conversations: Conversations;
  hub: ConversationHub;
  bus: ChatBus;
  stops: StopRegistry;
  items: ChatCollaborators["items"];
  reasoning: Pick<ChatReasoningStore, "readerFor">;
  reader: ConversationReader;
  /** False without an API key: create and send answer 503 `chat_unavailable` (D12). */
  available: boolean;
  settings: ChatSettings;
  /** Cuts in-flight model calls (shutdown). Idempotent. */
  close(): Promise<void>;
}

/** After `buildApp`: the client API over the running runtime, with the SAME execution policy object (fact C1). */
export function connectChat(
  p: PreparedChat,
  runtime: WorkflowRuntime,
  eventStore: EventStore,
): ChatWiring {
  const conversations = createConversations({
    runtime,
    eventStore,
    flow: p.active,
    policy: executionAuthorizer,
    maxTurnChars: 8_000,
  });
  return {
    conversations,
    hub: p.hub,
    bus: p.bus,
    stops: p.stops,
    items: p.collaborators.items,
    reasoning: p.collaborators.reasoning,
    reader: conversations.reader,
    available: p.available,
    settings: p.settings,
    async close() {
      p.shutdown.abort();
    },
  };
}

/** For `Retriever.onHopError`: the hop number and the error class only, never a message. */
export const logHopError = (hop: 1 | 2, errorClass: string): void =>
  console.error("chat retrieval hop failed", hop, errorClass);
