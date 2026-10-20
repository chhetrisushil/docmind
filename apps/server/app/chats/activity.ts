import { RECORD_SOURCE } from "@loom/conversation";
import { type EventEnvelope, projection$ } from "@loom/core";
import {
  type ReadModelEventSource,
  ReadModelService,
  type ReadModelStore,
  type SensitiveMap,
} from "@loom/plugin-read-model";
import { chatIdOfConversation } from "./ids";
import { CHAT_ACTIVITY_MODEL } from "./sessions";

export { CHAT_ACTIVITY_MODEL };

/**
 * Numbers only. Loom's sensitive-state guard refuses a state leaf equal to a value lifted from a sealed path,
 * and sealed values are strings (a user can type any text, an ISO time included), so `lastAt` is the event's
 * epoch milliseconds: a number leaf never matches. One row per conversation generation; `messages` counts that
 * generation only. `lastOrd` is informational (the highest turn key seen), NOT a dedupe guard: Loom's per-execution
 * sequence watermark makes each event fold exactly once.
 */
export interface ChatActivityState {
  messages: number;
  lastOrd: number;
  lastAt: number | null;
}
export const INITIAL_ACTIVITY: ChatActivityState = {
  messages: 0,
  lastOrd: 0,
  lastAt: null,
};

export const chatKeyOf = (executionId: string): string | undefined =>
  chatIdOfConversation(executionId)?.chatId;
export const chatScopeOf = (executionId: string): string | undefined =>
  chatIdOfConversation(executionId)?.userId;
export const isChatExecution = (executionId: string): boolean =>
  chatIdOfConversation(executionId) !== null;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
// The handler sees a masked copy; a shredded payload is `{ $shredded: true }`.
const payloadOf = (e: EventEnvelope): Record<string, unknown> =>
  isRecord(e.payload) && e.payload.$shredded !== true ? e.payload : {};

export interface RecordFact {
  /** The turn key `<o>` of `conv#o<o>:...` (not the record's own `ord`). */
  ord: number;
  role: "user" | "reply";
  status: string;
}

const DECISION = /^conv#o([1-9][0-9]{0,8}):(user|reply)$/;

/**
 * The conversation record an event holds, if it is one. The decision id and the source are plain (only the
 * message text is sealed); when the whole `choice` was masked the status is unknown and reads as complete.
 */
export function recordOf(e: EventEnvelope): RecordFact | undefined {
  if (e.eventType !== "DECISION_RECORDED") return undefined;
  const p = payloadOf(e);
  if (p.source !== RECORD_SOURCE || typeof p.decisionId !== "string") return undefined;
  const m = DECISION.exec(p.decisionId);
  if (!m) return undefined;
  const choice = isRecord(p.choice) ? p.choice : {};
  return {
    ord: Number(m[1]),
    role: m[2] as "user" | "reply",
    status: typeof choice.status === "string" ? choice.status : "complete",
  };
}

type Handler = (state: ChatActivityState, event: EventEnvelope) => ChatActivityState;

export const activityHandlers = {
  // The row exists from the start of the execution.
  EXECUTION_STARTED: (s) => s,
  DECISION_RECORDED: (s, e) => {
    const fact = recordOf(e);
    if (!fact || fact.status === "rejected") return s;
    return {
      messages: s.messages + 1,
      lastOrd: Math.max(s.lastOrd, fact.ord),
      lastAt: Number.isFinite(e.timestamp) ? e.timestamp : s.lastAt,
    };
  },
} satisfies Record<string, Handler>;

/** The durable fold. Bump `version` when a handler's meaning changes: Loom re-folds at boot. */
export const chatActivity = projection$<ChatActivityState>({
  id: CHAT_ACTIVITY_MODEL,
  name: "ChatActivity",
  version: "1",
  initialState: INITIAL_ACTIVITY,
  handlers: activityHandlers,
});

export interface ChatActivityOptions {
  /** The Loom role's store (the same one the ingest status uses). */
  writer: ReadModelStore;
  /** The decrypting event store: live source for holes and the catch-up source. */
  source: ReadModelEventSource;
  /** The same map the ingest status computes after `defineConfig` (`statusSensitive`). */
  sensitive: SensitiveMap;
  onError?(err: unknown): void;
}

const logClass = (err: unknown) =>
  console.error("chat activity failed", err instanceof Error ? err.constructor.name : typeof err);

export class ChatActivity {
  private readonly service: ReadModelService;
  private readonly report: (err: unknown) => void;

  constructor(private readonly o: ChatActivityOptions) {
    this.report = o.onError ?? logClass;
    this.service = new ReadModelService(o.writer, {
      liveSource: o.source,
      sensitive: o.sensitive,
      onError: (err) => this.report(err),
    });
  }

  /** Register (a changed version or sensitive map rebuilds), then catch up. Throws on a poison event: do not serve. */
  async boot(): Promise<void> {
    await this.service.registerFolded({
      projection: chatActivity,
      keyOf: chatKeyOf,
      scopeOf: chatScopeOf,
    });
    await this.service.catchUp([this.o.source]);
  }

  /** `observability.onEvent` fan-out sink: synchronous, never throws. Only chat conversations are folded. */
  onEvent = (event: EventEnvelope): void => {
    if (chatIdOfConversation(event.executionId) === null) return;
    this.service.handleEvent(event);
  };

  /** Wait for every fold scheduled so far. */
  async drain(): Promise<void> {
    await this.service.drain();
  }

  /** Callers detach the event feed first: events fed afterwards are not awaited. */
  async close(): Promise<void> {
    await this.service.drain();
  }
}
