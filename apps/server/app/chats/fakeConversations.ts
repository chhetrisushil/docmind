import {
  ConversationNotFoundError,
  type Conversations,
  type HistoryEntry,
  InvalidCursorError,
  type ReadOptions,
  type ReadResult,
  parseCursor,
} from "@loom/conversation";
import type { EventEnvelope } from "@loom/core";
import type { PrincipalChain } from "@loom/effect-runtime";
import type { EventStore } from "@loom/event-runtime";

const keyOf = (p?: PrincipalChain) => `${p?.tenant}|${p?.actor}`;

export interface FakeTurn {
  question: string;
  answer: string;
  status?: HistoryEntry["status"];
  at?: number;
}

/**
 * In-memory `Conversations`: the owner is whoever passed `principal` to `start`. A conversation holds
 * entries in log order; entry i has cursor `0.<i+1>` (generation 0, sequence i+1).
 */
export function fakeConversations(opts: { pageCap?: number } = {}) {
  const owners = new Map<string, string>();
  const entries = new Map<string, HistoryEntry[]>();
  const events = new Map<string, EventEnvelope>();
  const closed = new Set<string>();
  const wake = new Set<() => void>();
  const calls: string[] = [];
  const sent: { id: string; text: string; messageId?: string; editOf?: number }[] = [];
  const failures: { start: number; send: Error[] } = { start: 0, send: [] };

  const gate = (id: string, o?: { principal?: PrincipalChain }) => {
    if (owners.get(id) !== keyOf(o?.principal)) throw new ConversationNotFoundError(id);
  };
  const cursorSeq = (cursor: string | undefined): number | undefined => {
    if (cursor === undefined) return undefined;
    const at = parseCursor(cursor);
    if (!at) throw new InvalidCursorError();
    return at.seq;
  };
  const read = (id: string, o: ReadOptions = {}): ReadResult => {
    const all = entries.get(id) ?? [];
    const limit = Math.min(o.limit ?? 50, opts.pageCap ?? 500);
    const seq = cursorSeq(o.cursor);
    if (o.direction === "backward") {
      const upper = seq === undefined ? all.length : Math.max(0, seq - 1); // strictly older than the cursor
      const take = all.slice(Math.max(0, upper - limit), upper).reverse();
      const lowest = Math.max(0, upper - limit);
      return {
        entries: take,
        ...(take.length > 0 && { nextCursor: `0.${lowest + 1}` }),
        done: lowest === 0,
      };
    }
    const from = seq ?? 0; // forward: after the cursor
    const take = all.slice(from, from + limit);
    const end = from + take.length;
    return {
      entries: take,
      ...(take.length > 0 && { nextCursor: `0.${end}` }),
      done: end >= all.length,
      ...(closed.has(id) && end >= all.length && { closed: true }),
    };
  };

  const reader = {
    read: async (id: string, o?: ReadOptions) => read(id, o),
    headGeneration: async () => 0,
  };
  const api = {
    mode: "owner",
    requiresPrincipal: true,
    reader,
    async start(o?: { conversationId?: string; principal?: PrincipalChain }) {
      const id = o?.conversationId ?? "conv-fake";
      if (failures.start > 0) {
        failures.start--;
        throw new RangeError("start failed");
      }
      owners.set(id, keyOf(o?.principal));
      entries.set(id, []);
      calls.push(`start:${id}`);
      return { conversationId: id };
    },
    async sendTurn(
      id: string,
      text: string,
      o?: { principal?: PrincipalChain; messageId?: string; editOf?: number },
    ) {
      gate(id, o);
      const failure = failures.send.shift();
      if (failure) throw failure;
      sent.push({
        id,
        text,
        ...(o?.messageId && { messageId: o.messageId }),
        ...(o?.editOf !== undefined && { editOf: o.editOf }),
      });
      calls.push(`send:${id}`);
      return { messageId: o?.messageId ?? `m-${sent.length}`, inboxSeq: sent.length };
    },
    async close(id: string, o?: { principal?: PrincipalChain }) {
      gate(id, o);
      closed.add(id);
      calls.push(`close:${id}`);
      for (const poke of wake) poke();
      return { messageId: "closed", inboxSeq: 0 };
    },
    async history(id: string, o?: ReadOptions & { principal?: PrincipalChain }) {
      gate(id, o);
      return read(id, o);
    },
    async status(id: string, o?: { principal?: PrincipalChain }) {
      gate(id, o);
      return {
        conversationId: id,
        executionId: id,
        generation: 0,
        state: closed.has(id) ? "closed" : "open",
        running: false,
        turns: Math.floor((entries.get(id)?.length ?? 0) / 2),
      };
    },
    async authorizeRead(id: string, o?: { principal?: PrincipalChain }) {
      gate(id, o);
      return { generation: 0 };
    },
  };

  /** What `followConversation` reads: `subscribe` wakes a follower. */
  const eventStore = {
    readRange: async (executionId: string, from: number, to: number) =>
      [...events.values()].filter(
        (e) => e.executionId === executionId && e.sequence >= from && e.sequence <= to,
      ),
    read: async () => [] as EventEnvelope[],
    readFrom: async () => [] as EventEnvelope[],
    subscribe: async (_id: string, fn: () => void) => {
      wake.add(fn);
      return () => void wake.delete(fn);
    },
  } as unknown as EventStore;

  const ctr = new Map<string, { consumed: number; records: number; turns: number }>();
  const counters = (id: string) => {
    const found = ctr.get(id);
    if (found) return found;
    const fresh = { consumed: 0, records: 0, turns: 0 };
    ctr.set(id, fresh);
    return fresh;
  };
  const push = (
    id: string,
    c: { consumed: number; records: number },
    e: Pick<HistoryEntry, "turn" | "role" | "text" | "status" | "at">,
    kind: "user" | "reply",
  ) => {
    const list = entries.get(id) ?? [];
    entries.set(id, list);
    const sequence = list.length + 1;
    list.push({ ...e, ord: ++c.records, cursor: `0.${sequence}`, executionId: id });
    events.set(`${id}:${sequence}`, {
      id: `${id}-${sequence}`,
      workflowId: "conversation",
      executionId: id,
      eventType: "DECISION_RECORDED",
      sequence,
      timestamp: e.at ?? 0,
      payload: {
        decisionId: `conv#o${c.consumed}:${kind}`,
        source: "conversation-record",
        choice: {},
      },
    });
    for (const poke of wake) poke();
  };

  return {
    api: api as unknown as Conversations,
    eventStore,
    calls,
    sent,
    closed,
    entriesOf: (id: string) => entries.get(id) ?? [],
    ownerOf: (id: string) => owners.get(id),
    failNextStart: () => void failures.start++,
    failNextSend: (err: Error) => void failures.send.push(err),
    /**
     * Appends a user message and its reply as Loom's flow records them. Two counters, as in conversation.ts:
     * `consumed` (every message taken from the inbox, accepted or not) names the decision ids `conv#o<consumed>:...`;
     * `records` (every record written) is the record's `ord`. An accepted turn is number `turns + 1`.
     */
    addTurn(id: string, t: FakeTurn): void {
      const c = counters(id);
      c.consumed++;
      c.turns++;
      const at = t.at ?? 1_700_000_000_000 + (entries.get(id)?.length ?? 0) * 1000;
      push(
        id,
        c,
        { turn: c.turns, role: "user", text: t.question, status: "complete", at },
        "user",
      );
      push(
        id,
        c,
        { turn: c.turns, role: "assistant", text: t.answer, status: t.status ?? "complete", at },
        "reply",
      );
    },
    /** A rejected envelope: it consumes a message and writes a record (turn 0, user, rejected), but is no turn. */
    addRejected(id: string, text = "rejected"): void {
      const c = counters(id);
      c.consumed++;
      push(
        id,
        c,
        {
          turn: 0,
          role: "user",
          text,
          status: "rejected",
          at: 1_700_000_000_000 + (entries.get(id)?.length ?? 0) * 1000,
        },
        "user",
      );
    },
  };
}
export type FakeConversations = ReturnType<typeof fakeConversations>;
