import { createAgentModelEffect } from "@loom/agent";
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
import { type ChatFlowConfig, chatFlow } from "./agent";
import { ChatBus } from "./bus";
import { CHAT_MODEL_TOOL_ID } from "./ids";
import type { ChatLlm } from "./llm";
import { chatModelEffect } from "./model";
import { chatObserver } from "./observer";
import type { PassageReader, Retriever } from "./retrieval";
import type { ChatSettings } from "./settings";
import { StopRegistry, stoppableBargeIn } from "./stop";
import { chatTools } from "./tools";
import type { DocumentReads } from "./tools/documents";
import type { ChatLookup } from "./tools/harness";
import type { PgReasoningBlocks, PgTurnItems } from "./turnItems";

export interface ChatCollaborators {
  items: Pick<PgTurnItems, "put" | "remove" | "forTurns">;
  blocks: Pick<PgReasoningBlocks, "put" | "get">;
  retriever: Pick<Retriever, "search" | "related">;
  passages: Pick<PassageReader, "read" | "section">;
  chats: ChatLookup;
  documents: DocumentReads;
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
  const strict = chatFlow(flowConfig);
  const gk = chatFlow({ ...flowConfig, generalKnowledge: true });
  const effects: Record<string, Effect> = chatTools({
    chats: c.chats,
    items: c.items,
    bus,
    retriever: c.retriever,
    passages: c.passages,
    documents: c.documents,
  });
  if (o.llm) {
    o.llm.observer.current = chatObserver({ items: c.items, blocks: c.blocks, bus });
    effects[CHAT_MODEL_TOOL_ID] = chatModelEffect(
      createAgentModelEffect(hub.wrapProvider(o.llm.provider), {
        stream: true,
        onDelta: hub.deltaSink(),
      }),
      { items: c.items, bus, shutdown: shutdown.signal },
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
    deps: { flows: [strict, gk] as unknown as RegisteredFlow[], effects, timers: o.timers },
  };
}

export interface ChatWiring {
  conversations: Conversations;
  hub: ConversationHub;
  bus: ChatBus;
  stops: StopRegistry;
  items: ChatCollaborators["items"];
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
