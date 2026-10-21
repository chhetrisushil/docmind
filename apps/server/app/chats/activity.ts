import { RECORD_SOURCE } from "@loom/conversation";
import { type EventEnvelope, projection$ } from "@loom/core";
import {
  type ReadModelEventSource,
  ReadModelService,
  type ReadModelStore,
  type SensitiveMap,
} from "@loom/plugin-read-model";
import { type UserExecutionLister, forgetUserRows } from "../status/forgetUser";
import { chatIdOfConversation } from "./ids";
import { CHAT_ACTIVITY_MODEL } from "./sessions";

export { CHAT_ACTIVITY_MODEL };

/**
 * Numbers only. Loom's sensitive-state guard (read-model `sensitiveState`, `leaksNumber`) refuses a number leaf that
 * equals a lifted sealed number, or that is an INTEGER whose decimal text equals a lifted sealed string. A conversation
 * record seals only strings (`choice.text` ...), so its lifted set holds no numbers, but a user can type any text, an
 * epoch-ms string included. So `lastAt` is the event's epoch milliseconds PLUS 0.5: never an integer, so the
 * integer-to-string check never applies. Readers subtract 0.5 (`listChats`). One row per conversation generation;
 * `n` (messages) counts that generation only. The keys are 5 characters or fewer on purpose: the guard also lifts
 * every object KEY under a sealed path and only strings of 6+ characters, so a user message that is exactly
 * "messages" cannot match one. `o` (lastOrd) is informational (the highest turn key seen), NOT a dedupe guard:
 * Loom's per-execution sequence watermark makes each event fold exactly once.
 */
export interface ChatActivityState {
  /** Messages in this generation. */
  n: number;
  /** The highest turn key seen. */
  o: number;
  /** The last event's epoch milliseconds + 0.5, or null. */
  at: number | null;
}
export const INITIAL_ACTIVITY: ChatActivityState = {
  n: 0,
  o: 0,
  at: null,
};

/** The state of an execution that is not a chat conversation: no key and no value (see the ingest model). */
const NEUTRAL = {} as ChatActivityState;

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

const chatOnly =
  (handler: Handler): Handler =>
  (s, e) =>
    // An empty state is the tombstone (or a non-chat row): nothing after it counts or resurrects.
    isChatExecution(e.executionId) && Object.keys(s).length > 0 ? handler(s, e) : NEUTRAL;

export const activityHandlers = {
  // The row exists from the start of the execution.
  EXECUTION_STARTED: chatOnly((s) => s),
  DECISION_RECORDED: chatOnly((s, e) => {
    const fact = recordOf(e);
    if (!fact || fact.status === "rejected") return s;
    return {
      n: s.n + 1,
      o: Math.max(s.o, fact.ord),
      at: Number.isFinite(e.timestamp) ? e.timestamp + 0.5 : s.at,
    };
  }),
  // The erasure tombstone Loom writes to an erased user's log: the row holds no counts afterwards.
  PAYLOAD_SHREDDED: () => NEUTRAL,
} satisfies Record<string, Handler>;

/** The durable fold. Bump `version` when a handler's meaning changes: Loom re-folds at boot. */
export const chatActivity = projection$<ChatActivityState>({
  id: CHAT_ACTIVITY_MODEL,
  name: "ChatActivity",
  version: "3",
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
  /** User erasure's narrow read of the user's remaining rows (Task 167). Absent: `forgetUser` purges by scope only. */
  userExecutions?: UserExecutionLister;
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
  /** User erasure: tombstones every chat-activity row of the user, the neutral rows of their ingest and title executions included. */
  forgetUser(userId: string): Promise<number> {
    return forgetUserRows(
      this.service,
      CHAT_ACTIVITY_MODEL,
      userId,
      this.o.userExecutions,
      this.o.source,
    );
  }

  async drain(): Promise<void> {
    await this.service.drain();
  }

  /** Callers detach the event feed first: events fed afterwards are not awaited. */
  async close(): Promise<void> {
    await this.service.drain();
  }
}
