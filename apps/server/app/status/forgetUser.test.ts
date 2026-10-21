import { randomUUID } from "node:crypto";
import { InMemoryReadModelStore, foldedStates } from "@loom/plugin-read-model";
import { describe, expect, it } from "vitest";
import { CHAT_ACTIVITY_MODEL, ChatActivity } from "../chats/activity";
import { chatConversationId } from "../chats/ids";
import { InMemoryProgressBus } from "../documents/progress";
import { type UserExecutionLister, forgetUserRows, isUserExecution } from "./forgetUser";
import { IngestStatus } from "./ingestStatus";
import { INGEST_STATUS_MODEL } from "./model";
import { MemoryLog, evt, ingestRun } from "./testing";

const [A, B] = [randomUUID(), randomUUID()];
const [docA, docB, chatA, chatB] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const ingestOf = (u: string, d: string) => `u_${u}:ingest-${d}`;
const titleOf = (u: string, c: string) => `u_${u}:chat-title-${c}`;

/**
 * What the Loom-pool lister does: the user's rows that EXIST in the store and are not tombstoned, by id prefix
 * (`starts_with` semantics, never a pattern). Candidates come from the log; only stored rows count.
 */
const listFrom =
  (log: MemoryLog, store: InMemoryReadModelStore): UserExecutionLister =>
  async (model, userId) => {
    const candidates = (await log.listExecutions()).filter((id) => isUserExecution(id, userId));
    return (await store.getFolded(model, candidates))
      .filter((r) => !r.erased)
      .map((r) => r.executionId);
  };

function setup() {
  const store = new InMemoryReadModelStore();
  const log = new MemoryLog();
  const userExecutions = listFrom(log, store);
  const status = new IngestStatus({
    writer: store,
    readerFor: () => store,
    source: log,
    sensitive: {},
    bus: new InMemoryProgressBus(),
    userExecutions,
    onError: () => {},
  });
  const activity = new ChatActivity({
    writer: store,
    source: log,
    sensitive: {},
    userExecutions,
    onError: () => {},
  });
  const conv = (u: string, c: string) => chatConversationId(u, c);
  log.append(
    ...ingestRun(ingestOf(A, docA), "ready"),
    ...ingestRun(ingestOf(B, docB), "ready"),
    ...ingestRun(titleOf(A, chatA), "started"), // a title execution: a NULL-scope row in both models
    evt(conv(A, chatA), 0, "EXECUTION_STARTED", { input: {} }), // a chat: a NULL-scope row in ingest-status
    evt(conv(B, chatB), 0, "EXECUTION_STARTED", { input: {} }),
  );
  const rows = async (model: string) =>
    (
      await store.getFolded(model, [
        ingestOf(A, docA),
        ingestOf(B, docB),
        titleOf(A, chatA),
        conv(A, chatA),
        conv(B, chatB),
      ])
    ).map((r) => ({ id: r.executionId, state: r.state, erased: r.erased }));
  return { store, log, status, activity, rows, conv };
}

describe("forgetUser over both models", () => {
  it("tombstones the user's rows in each model, the NULL-scope ones included, and only that user's", async () => {
    const { status, activity, rows, conv } = setup();
    await status.boot();
    await activity.boot();

    // ingest-status folds EVERY execution: A has three rows (ingest, title, chat), B two.
    expect(await status.forgetUser(A)).toBe(3);
    // chat-activity: A's chat row and the neutral rows of A's ingest and title executions.
    expect(await activity.forgetUser(A)).toBe(3);

    for (const model of [INGEST_STATUS_MODEL, CHAT_ACTIVITY_MODEL]) {
      for (const r of await rows(model)) {
        const mine = r.id.startsWith(`u_${A}`);
        expect([r.id, r.erased, r.state === null]).toEqual([r.id, mine, mine]);
      }
    }
    expect(
      (await rows(CHAT_ACTIVITY_MODEL)).find((r) => r.id === conv(B, chatB))?.state,
    ).toBeTruthy();
  });

  it("is idempotent: a second call tombstones nothing", async () => {
    const { status, activity } = setup();
    await status.boot();
    await activity.boot();
    await status.forgetUser(A);
    await activity.forgetUser(A);
    expect(await status.forgetUser(A)).toBe(0);
    expect(await activity.forgetUser(A)).toBe(0);
  });

  it("a late event for a tombstoned row does not bring it back", async () => {
    const { store, log, status, activity } = setup();
    await status.boot();
    await activity.boot();
    await activity.forgetUser(A);
    const late = evt(chatConversationId(A, chatA), 1, "DECISION_RECORDED", {
      decisionId: "conv#o1:user",
      source: "conversation-record",
      choice: {},
    });
    log.append(late);
    activity.onEvent(late);
    await activity.drain();
    const [row] = foldedStates(await store.getFolded(CHAT_ACTIVITY_MODEL, [late.executionId]));
    expect(row).toBeUndefined(); // an erased row is hidden from readers
    const [raw] = await store.getFolded(CHAT_ACTIVITY_MODEL, [late.executionId]);
    expect(raw).toMatchObject({ state: null, erased: true });
  });

  it("folds a live fold in flight before it purges: the new row is tombstoned, exactly", async () => {
    const { log, status } = setup();
    await status.boot();
    const run = ingestRun(ingestOf(A, randomUUID()), "ready");
    log.append(...run);
    for (const e of run) status.onEvent(e); // scheduled, not awaited
    expect(await status.forgetUser(A)).toBe(4);
  });

  it("writes the rows a model has not folded yet, so the next boot cannot create live ones (Q1)", async () => {
    const { store, log, status, activity, conv } = setup();
    await status.boot();
    await activity.boot();
    // After boot: a chat and an ingest start. Each model folds only its own live; the other's neutral row
    // would appear at the next boot's catch-up.
    const doc2 = randomUUID();
    const chat2 = randomUUID();
    const late = [
      ...ingestRun(ingestOf(A, doc2), "ready"),
      evt(conv(A, chat2), 0, "EXECUTION_STARTED", { input: {} }),
    ];
    log.append(...late);
    for (const e of late) {
      status.onEvent(e);
      activity.onEvent(e);
    }
    await status.forgetUser(A);
    await activity.forgetUser(A);

    // A restart: fresh models over the same store catch up from the log.
    await new IngestStatus({
      writer: store,
      readerFor: () => store,
      source: log,
      sensitive: {},
      bus: new InMemoryProgressBus(),
      onError: () => {},
    }).boot();
    await new ChatActivity({ writer: store, source: log, sensitive: {}, onError: () => {} }).boot();
    for (const model of [INGEST_STATUS_MODEL, CHAT_ACTIVITY_MODEL]) {
      const ids = (await log.listExecutions()).filter((id) => id.startsWith(`u_${A}`));
      const stored = await store.getFolded(model, ids);
      expect([
        model,
        ids.length,
        stored.length,
        stored.every((r) => r.erased && r.state === null),
      ]).toEqual([model, ids.length, ids.length, true]);
    }
  });

  it("without a lister it purges by scope only (the previous behaviour)", async () => {
    const store = new InMemoryReadModelStore();
    const log = new MemoryLog();
    const status = new IngestStatus({
      writer: store,
      readerFor: () => store,
      source: log,
      sensitive: {},
      bus: new InMemoryProgressBus(),
    });
    log.append(
      ...ingestRun(ingestOf(A, docA), "ready"),
      ...ingestRun(titleOf(A, chatA), "started"),
    );
    await status.boot();
    expect(await status.forgetUser(A)).toBe(1);
  });

  it("refuses an id that is not a uuid, synchronously", () => {
    const { status, activity } = setup();
    expect(() => status.forgetUser("not-a-uuid")).toThrow(/forgetUser: userId must be a uuid/);
    expect(() => activity.forgetUser("x")).toThrow(/forgetUser: userId must be a uuid/);
  });
});

describe("forgetUserRows", () => {
  it("stops when a lister keeps returning rows the purge cannot tombstone", async () => {
    let listed = 0;
    const n = await forgetUserRows(
      { refresh: async () => 0, purgeFolded: async () => 0 },
      "m",
      A,
      async () => {
        listed += 1;
        return ["u_x"];
      },
    );
    expect([n, listed]).toEqual([0, 1]);
  });
});
