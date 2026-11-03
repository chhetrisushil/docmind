import { runEventStoreDecoratorConformance } from "@loom/conformance";
import type { EventEnvelope } from "@loom/core";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { describe, expect, it } from "vitest";
import {
  SummaryChoiceEventStore,
  restoredSummaryChoice,
  sealableSummaryChoice,
} from "./summaryChoice";

const env = (over: Partial<EventEnvelope> & { payload?: unknown }): EventEnvelope =>
  ({
    id: "e1",
    workflowId: "doc-chat",
    executionId: "u_x.c-y",
    eventType: "DECISION_RECORDED",
    sequence: 3,
    timestamp: 1,
    payload: {},
    ...over,
  }) as EventEnvelope;

const fit = (choice: unknown, decisionId = "conv#o7:summary-fit") =>
  env({ payload: { decisionId, choice, source: "conversation-budget" } });

describe("sealableSummaryChoice / restoredSummaryChoice", () => {
  it("stores a summary-fit string choice as { docmindSummary: 1, text } and restores it", () => {
    const original = fit("the user asked about payment terms");
    const stored = sealableSummaryChoice(original);
    expect((stored.payload as { choice: unknown }).choice).toEqual({
      docmindSummary: 1,
      text: "the user asked about payment terms",
    });
    expect(restoredSummaryChoice(stored)).toEqual(original);
    // the caller's envelope is untouched
    expect((original.payload as { choice: unknown }).choice).toBe(
      "the user asked about payment terms",
    );
  });

  it.each([
    [
      "a conversation record",
      env({ payload: { decisionId: "conv#o7:user", choice: { text: "hi", status: "complete" } } }),
    ],
    ["a summary-fit whose choice is not a string", fit({ text: "x" })],
    ["a look-alike decision id", fit("s", "conv#o7:summary-fit-2")],
    ["ord 0", fit("s", "conv#o0:summary-fit")],
    [
      "another event type",
      env({
        eventType: "STEP_COMPLETED",
        payload: { decisionId: "conv#o7:summary-fit", choice: "s" },
      }),
    ],
    ["a null payload", env({ payload: null })],
  ])("leaves %s alone on write", (_label, e) => {
    expect(sealableSummaryChoice(e)).toBe(e);
  });

  it.each([
    ["a choice with an extra key", fit({ docmindSummary: 1, text: "s", other: 1 })],
    ["a choice whose marker is not 1", fit({ docmindSummary: 2, text: "s" })],
    ["a choice whose text is not a string", fit({ docmindSummary: 1, text: 5 })],
    [
      "a record decision shaped like ours",
      env({ payload: { decisionId: "conv#o7:user", choice: { docmindSummary: 1, text: "s" } } }),
    ],
  ])("leaves %s alone on read", (_label, e) => {
    expect(restoredSummaryChoice(e)).toBe(e);
  });
});

describe("SummaryChoiceEventStore", () => {
  it("round-trips through append/read, appendBatch/readRange, readFrom and subscribe; the inner store holds the object form", async () => {
    const inner = new InMemoryAsyncEventStore();
    const store = new SummaryChoiceEventStore(inner);
    const seen: EventEnvelope[] = [];
    const off = await store.subscribe("u_x.c-y", (e) => seen.push(e));
    const a = fit("first summary");
    const b = { ...fit("second summary", "conv#o8:summary-fit"), id: "e2", sequence: 4 };
    await store.append(a);
    await store.appendBatch?.([b]);
    expect(
      (await inner.read("u_x.c-y")).map((e) => (e.payload as { choice: unknown }).choice),
    ).toEqual([
      { docmindSummary: 1, text: "first summary" },
      { docmindSummary: 1, text: "second summary" },
    ]);
    expect(await store.read("u_x.c-y")).toEqual([a, b]);
    expect(await store.readFrom("u_x.c-y", 4)).toEqual([b]);
    expect(await store.readRange?.("u_x.c-y", 3, 3)).toEqual([a]);
    await expect.poll(() => seen.length).toBe(2);
    expect(seen).toEqual([a, b]);
    off();
    await store.close();
  });

  it("appendIfUnchanged stores the object form in the inner store and reads back the string", async () => {
    const inner = new InMemoryAsyncEventStore();
    const store = new SummaryChoiceEventStore(inner);
    const first = fit("first", "conv#o1:summary-fit");
    first.sequence = 0;
    await store.append(first);
    const tip = await store.appendIfUnchanged?.("u_x.c-y", null);
    expect(tip).toMatchObject({ appended: false, reason: "observed", head: 0 });
    const { head, fence, anchor } = tip as { head: number; fence: number; anchor: string };
    const next = { ...fit("second summary"), id: "e2", sequence: 1 };
    expect(await store.appendIfUnchanged?.("u_x.c-y", next, { head, fence, anchor })).toEqual({
      appended: true,
    });
    const stored = await inner.read("u_x.c-y");
    expect((stored[1]?.payload as { choice: unknown }).choice).toEqual({
      docmindSummary: 1,
      text: "second summary",
    });
    expect((await store.read("u_x.c-y"))[1]).toEqual(next);
    await store.close();
  });

  it("carries the sealing store's keys, subjectOf and senderSubjectOf", () => {
    const keys = { getOrCreate: async () => Buffer.alloc(32) };
    const subjectOf = () => "s";
    const senderSubjectOf = async () => "t";
    const inner = Object.assign(new InMemoryAsyncEventStore(), {
      keys,
      subjectOf,
      senderSubjectOf,
    });
    const store = new SummaryChoiceEventStore(inner) as unknown as Record<string, unknown>;
    expect(store.keys).toBe(keys);
    expect(store.subjectOf).toBe(subjectOf);
    expect(store.senderSubjectOf).toBe(senderSubjectOf);
  });
});

runEventStoreDecoratorConformance(
  "SummaryChoiceEventStore",
  (inner) => new SummaryChoiceEventStore(inner),
);
