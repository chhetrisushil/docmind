import { randomUUID } from "node:crypto";
import type { EventEnvelope } from "@loom/core";
import { InMemoryReadModelStore, foldedStates } from "@loom/plugin-read-model";
import { describe, expect, it } from "vitest";
import { MemoryLog, evt } from "../status/testing";
import { flowSteps, statusSensitive } from "../status/wire";
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
  it("ignores the model reasoning events of ADR 0133: a capture event and a step value that carries reasoning change nothing", async () => {
    const { feed, activity, rows, errors } = await setup();
    feed(
      record(CONV, 0, 1, "user"),
      evt(CONV, 1, "LLM_REASONING_CAPTURED", {
        stepId: "conv#o1#turn:0",
        attempt: 1,
        provider: "anthropic",
        parts: [{ kind: "summary", ref: "0".repeat(32), digest: "d".repeat(64), size: 12 }],
      }),
      evt(CONV, 2, "STEP_COMPLETED", {
        stepId: "conv#o1#turn:0",
        output: {
          content: "a",
          stopReason: "end_turn",
          reasoning: [
            { type: "reasoning", kind: "summary", provider: "anthropic", signature: "S" },
          ],
        },
      }),
      record(CONV, 3, 1, "reply"),
    );
    await activity.drain();
    expect((await rows())[0]?.state).toMatchObject({ n: 2, o: 1 });
    expect(errors).toEqual([]);
  });

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
        state: { n: 2, o: 1, at: 1_002.5 },
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
    expect((await rows())[0]?.state).toMatchObject({ n: 2, o: 2 });
  });

  it("folds the erasure tombstone to the neutral state, and does not count a shredded record", async () => {
    const { feed, activity, rows, errors } = await setup();
    feed(record(CONV, 0, 1, "user"), record(CONV, 1, 1, "reply"));
    await activity.drain();
    expect((await rows())[0]?.state).toMatchObject({ n: 2 });
    // Loom writes ERASURE_PENDING to the `__loom_erasure__` control stream, not to this log.
    feed(evt(CONV, 2, "PAYLOAD_SHREDDED", { subjectId: U }));
    await activity.drain();
    expect(await rows()).toEqual([{ executionId: CONV, state: {} }]);
    expect(errors).toEqual([]);
  });

  it("keeps the tombstone state absorbing: a later record is not counted", async () => {
    const { feed, activity, rows, errors } = await setup();
    feed(record(CONV, 0, 1, "user"), evt(CONV, 1, "PAYLOAD_SHREDDED", { subjectId: U }));
    feed(record(CONV, 2, 2, "user"));
    await activity.drain();
    expect(await rows()).toEqual([{ executionId: CONV, state: {} }]);
    expect(errors).toEqual([]);
  });

  it("leaves the counts alone for a record whose whole payload was shredded", async () => {
    const { feed, activity, rows } = await setup();
    feed(record(CONV, 0, 1, "user"));
    feed(evt(CONV, 1, "DECISION_RECORDED", { $shredded: true }));
    await activity.drain();
    expect((await rows())[0]?.state).toMatchObject({ n: 1 });
  });

  it("keeps one row per generation of a rotated conversation, all under the same chat key", async () => {
    const { feed, activity, rows } = await setup();
    feed(record(CONV, 0, 1, "user"), record(CONV, 1, 1, "reply"));
    feed(record(`${CONV}~1`, 0, 2, "user"));
    await activity.drain();
    const got = await rows();
    expect(got.map((r) => r.executionId).sort()).toEqual([CONV, `${CONV}~1`]);
    expect(got.map((r) => r.state.n).sort()).toEqual([1, 2]);
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
    // Only the chat's own execution has a row, and the other-source decision changed nothing in it.
    expect(await rows()).toEqual([{ executionId: CONV, state: { n: 0, o: 0, at: null } }]);
  });

  it("folds a record whose body is masked, by its decision id alone", async () => {
    const { feed, activity, rows } = await setup();
    feed(
      record(CONV, 0, 1, "user", "complete", "[masked]"),
      record(CONV, 1, 1, "reply", "complete", "[masked]"),
    );
    await activity.drain();
    expect((await rows())[0]?.state).toMatchObject({ n: 2 });
  });

  it("boots from the log: what was written before this process started is counted", async () => {
    const { log, activity, rows } = await setup(false);
    log.append(record(CONV, 0, 1, "user"), record(CONV, 1, 1, "reply"));
    await activity.boot();
    expect((await rows())[0]?.state.n).toBe(2);
  });

  it("counts a record once when the same envelope is fed twice", async () => {
    const { feed, activity, rows } = await setup();
    const user = record(CONV, 1, 1, "user");
    feed(evt(CONV, 0, "EXECUTION_STARTED", { input: {} }), user);
    activity.onEvent(user); // the same envelope again
    await activity.drain();
    expect((await rows())[0]?.state.n).toBe(1);
  });

  it("boot after live events leaves the count unchanged", async () => {
    const { store, log, activity, rows } = await setup();
    const e = [record(CONV, 0, 1, "user"), record(CONV, 1, 1, "reply")];
    for (const x of e) {
      log.append(x);
      activity.onEvent(x);
    }
    await activity.drain();
    const second = new ChatActivity({
      writer: store,
      source: log,
      sensitive: {},
      onError: () => {},
    });
    await second.boot(); // catch-up over the same log
    expect((await rows())[0]?.state.n).toBe(2);
  });

  it("a rotated generation's EXECUTION_STARTED carrying turns adds nothing", async () => {
    const { feed, activity, rows } = await setup();
    feed(
      evt(`${CONV}~1`, 0, "EXECUTION_STARTED", {
        input: { turns: [{ role: "user", text: "carried" }] },
      }),
    );
    await activity.drain();
    expect((await rows()).map((r) => r.state.n)).toEqual([0]);
  });

  const TS = 1_760_000_000_123; // a real 13-digit epoch-ms
  it.each([
    ["its ISO time", new Date(TS).toISOString()],
    ["its epoch ms", String(TS)],
    ["its stored `at`", String(TS + 0.5)],
  ])(
    "folds a user record whose text equals %s (the sensitive guard cannot trip)",
    async (_n, text) => {
      const store = new InMemoryReadModelStore();
      const log = new MemoryLog();
      const errors: unknown[] = [];
      const sensitive = statusSensitive(flowSteps(), {
        sealingCapability: () => ({ covers: ["DECISION_RECORDED.choice.text"] }) as never,
      });
      const activity = new ChatActivity({
        writer: store,
        source: log,
        sensitive,
        onError: (e) => errors.push(e),
      });
      await activity.boot();
      const stamp = (e: EventEnvelope): EventEnvelope => ({ ...e, timestamp: TS });
      const e = stamp(
        record(CONV, 1, 1, "user", "complete", {
          turn: 1,
          role: "user",
          status: "complete",
          ord: 1,
          text,
        }),
      );
      for (const x of [stamp(evt(CONV, 0, "EXECUTION_STARTED", { input: {} })), e]) {
        log.append(x);
        activity.onEvent(x);
      }
      await activity.drain();
      expect(errors.map((x) => String(x))).toEqual([]);
      const rows = foldedStates((await store.getFoldedByKey?.(CHAT_ACTIVITY_MODEL, [C])) ?? []);
      expect(rows.map((r) => r.state)).toEqual([{ n: 1, o: 1, at: TS + 0.5 }]);
    },
  );
});
