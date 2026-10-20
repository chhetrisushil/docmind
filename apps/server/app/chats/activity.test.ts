import { randomUUID } from "node:crypto";
import type { EventEnvelope } from "@loom/core";
import { InMemoryReadModelStore, foldedStates } from "@loom/plugin-read-model";
import { describe, expect, it } from "vitest";
import { MemoryLog, evt } from "../status/testing";
import {
  CHAT_ACTIVITY_MODEL,
  ChatActivity,
  type ChatActivityState,
  chatKeyOf,
  chatScopeOf,
  isChatExecution,
  recordOf,
} from "./activity";
import { chatConversationId } from "./ids";

const U = randomUUID();
const T = randomUUID();
const C = randomUUID();
const CONV = chatConversationId(U, C);

/** A recorded message the way `conversation$` writes it: a decision with a deterministic id. */
const record = (
  executionId: string,
  sequence: number,
  ord: number,
  role: "user" | "reply",
  status = "complete",
  choice: unknown = { turn: ord, role: role === "reply" ? "assistant" : "user", status, ord },
): EventEnvelope =>
  evt(executionId, sequence, "DECISION_RECORDED", {
    decisionId: `conv#o${ord}:${role}`,
    source: "conversation-record",
    choice,
  });

async function setup(boot = true) {
  const store = new InMemoryReadModelStore();
  const log = new MemoryLog();
  const errors: unknown[] = [];
  const activity = new ChatActivity({
    writer: store,
    source: log,
    sensitive: {},
    onError: (e) => errors.push(e),
  });
  if (boot) await activity.boot(); // registers the model; live events are folded only after it
  const feed = (...events: EventEnvelope[]) => {
    for (const e of events) {
      log.append(e);
      activity.onEvent(e);
    }
  };
  const rows = async () =>
    foldedStates((await store.getFoldedByKey?.(CHAT_ACTIVITY_MODEL, [C])) ?? []).map((r) => ({
      executionId: r.executionId,
      state: r.state as ChatActivityState,
    }));
  return { store, log, errors, activity, feed, rows };
}

describe("execution ids", () => {
  it("maps a chat's conversation id, and every rotated generation of it, to the chat and its owner", () => {
    for (const id of [CONV, `${CONV}~1`, `${CONV}~12`]) {
      expect([chatKeyOf(id), chatScopeOf(id), isChatExecution(id)]).toEqual([C, U, true]);
    }
  });
  it("treats an ingest execution as no chat", () => {
    const ingest = `u_${U}:ingest-${C}`;
    expect([chatKeyOf(ingest), chatScopeOf(ingest), isChatExecution(ingest)]).toEqual([
      undefined,
      undefined,
      false,
    ]);
  });
});

describe("recordOf", () => {
  it("reads the turn key, the role and the status of a conversation record", () => {
    expect(recordOf(record(CONV, 1, 3, "reply", "interrupted"))).toEqual({
      ord: 3,
      role: "reply",
      status: "interrupted",
    });
  });
  it("ignores other decisions, other sources and malformed ids", () => {
    const other = evt(CONV, 1, "DECISION_RECORDED", {
      decisionId: "conv#fit:1",
      source: "conversation-budget",
      choice: {},
    });
    const wrongSource = evt(CONV, 2, "DECISION_RECORDED", {
      decisionId: "conv#o1:user",
      source: "agent-response",
      choice: {},
    });
    const malformed = evt(CONV, 3, "DECISION_RECORDED", {
      decisionId: "conv#o0:user",
      source: "conversation-record",
      choice: {},
    });
    const notDecision = evt(CONV, 4, "STEP_COMPLETED", {
      decisionId: "conv#o1:user",
      source: "conversation-record",
    });
    for (const e of [other, wrongSource, malformed, notDecision])
      expect(recordOf(e)).toBeUndefined();
  });
  it("still reads a record whose choice was masked before the fold saw it", () => {
    expect(recordOf(record(CONV, 1, 1, "reply", "complete", "[masked]"))).toEqual({
      ord: 1,
      role: "reply",
      status: "complete",
    });
  });
});

describe("ChatActivity", () => {
  it("counts the user's message and the reply, and notes the last time", async () => {
    const { feed, activity, rows } = await setup();
    feed(
      evt(CONV, 0, "EXECUTION_STARTED", { input: {} }),
      record(CONV, 1, 1, "user"),
      record(CONV, 2, 1, "reply"),
    );
    await activity.drain();
    expect(await rows()).toEqual([
      {
        executionId: CONV,
        state: { messages: 2, lastOrd: 1, lastAt: new Date(1_002).toISOString() },
      },
    ]);
  });

  it("does not count a rejected message, and counts a failed reply", async () => {
    const { feed, activity, rows } = await setup();
    feed(
      record(CONV, 0, 1, "user", "rejected"),
      record(CONV, 1, 2, "user"),
      record(CONV, 2, 2, "reply", "failed"),
    );
    await activity.drain();
    expect((await rows())[0]?.state).toMatchObject({ messages: 2, lastOrd: 2 });
  });

  it("keeps one row per generation of a rotated conversation, all under the same chat key", async () => {
    const { feed, activity, rows } = await setup();
    feed(record(CONV, 0, 1, "user"), record(CONV, 1, 1, "reply"));
    feed(record(`${CONV}~1`, 0, 2, "user"));
    await activity.drain();
    const got = await rows();
    expect(got.map((r) => r.executionId).sort()).toEqual([CONV, `${CONV}~1`]);
    expect(got.map((r) => r.state.messages).sort()).toEqual([1, 2]);
  });

  it("ignores events of other executions and other decision sources", async () => {
    const { feed, activity, rows } = await setup();
    feed(evt(`u_${U}:ingest-${C}`, 0, "EXECUTION_STARTED", {}));
    feed(
      evt(CONV, 0, "DECISION_RECORDED", {
        decisionId: "conv#fit:1",
        source: "conversation-budget",
        choice: {},
      }),
    );
    await activity.drain();
    // Only the chat's own execution can have a row, and a decision of another source changes nothing in it.
    expect((await rows()).every((r) => r.executionId === CONV && r.state.messages === 0)).toBe(
      true,
    );
  });

  it("folds a record whose body is masked, by its decision id alone", async () => {
    const { feed, activity, rows } = await setup();
    feed(
      record(CONV, 0, 1, "user", "complete", "[masked]"),
      record(CONV, 1, 1, "reply", "complete", "[masked]"),
    );
    await activity.drain();
    expect((await rows())[0]?.state).toMatchObject({ messages: 2 });
  });

  it("boots from the log: what was written before this process started is counted", async () => {
    const { log, activity, rows } = await setup(false);
    log.append(record(CONV, 0, 1, "user"), record(CONV, 1, 1, "reply"));
    await activity.boot();
    expect((await rows())[0]?.state.messages).toBe(2);
  });
});
