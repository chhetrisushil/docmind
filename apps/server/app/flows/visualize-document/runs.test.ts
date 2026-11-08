import { randomUUID } from "node:crypto";
import type { DocumentProgressEvent } from "@docmind/contracts";
import type { EventEnvelope } from "@loom/core";
import { describe, expect, it, vi } from "vitest";
import { InMemoryProgressBus } from "../../documents/progress";
import { type VisualRuns, visualRunRecorder } from "./runs";
import { visualizeExecutionId } from "./start";

const ids = () => ({ userId: randomUUID(), documentId: randomUUID() });
const event = (executionId: string, eventType: string, payload: unknown = {}): EventEnvelope =>
  ({
    id: randomUUID(),
    executionId,
    workflowId: "visualize-document",
    timestamp: 1,
    sequence: 1,
    eventType,
    payload,
  }) as EventEnvelope;

function setup() {
  const record = vi.fn<VisualRuns["record"]>(async () => {});
  const bus = new InMemoryProgressBus();
  const seen: DocumentProgressEvent[] = [];
  const who = ids();
  bus.subscribe({ userId: who.userId }, (e) => seen.push(e));
  const errors: unknown[] = [];
  const rec = visualRunRecorder({ runs: { record }, bus, onError: (e) => errors.push(e) });
  return { record, seen, who, rec, errors };
}

describe("visualRunRecorder", () => {
  it("records a completed run's outcome and code, with the generation and run number from the execution id", async () => {
    const s = setup();
    const id = visualizeExecutionId(s.who.userId, s.who.documentId, 3, 2);
    s.rec.onEvent(
      event(id, "EXECUTION_COMPLETED", {
        output: { outcome: "failed", code: "visuals-model-unavailable" },
      }),
    );
    await s.rec.idle();
    expect(s.record).toHaveBeenCalledWith(
      { userId: s.who.userId, documentId: s.who.documentId, generation: 3, run: 2 },
      "failed",
      "visuals-model-unavailable",
    );
  });

  it("a failed outcome tells the owner's open pages (visuals: failed); other outcomes do not", async () => {
    const s = setup();
    const id = visualizeExecutionId(s.who.userId, s.who.documentId, 1);
    s.rec.onEvent(event(id, "EXECUTION_COMPLETED", { output: { outcome: "empty" } }));
    s.rec.onEvent(event(id, "EXECUTION_COMPLETED", { output: { outcome: "done" } }));
    await s.rec.idle();
    expect(s.seen).toEqual([]);
    s.rec.onEvent(
      event(id, "EXECUTION_COMPLETED", {
        output: { outcome: "failed", code: "visuals-plan-invalid" },
      }),
    );
    await s.rec.idle();
    expect(s.seen).toEqual([
      { documentId: s.who.documentId, status: "ready", step: "finalize", visuals: "failed" },
    ]);
  });

  it("a thrown failure records failed/internal and notifies; a cancel records but does not notify", async () => {
    const s = setup();
    const id = visualizeExecutionId(s.who.userId, s.who.documentId, 1);
    s.rec.onEvent(event(id, "EXECUTION_FAILED", { error: "sealed text" }));
    await s.rec.idle();
    expect(s.record).toHaveBeenLastCalledWith(expect.anything(), "failed", "internal");
    expect(s.seen).toHaveLength(1);
    s.rec.onEvent(event(id, "EXECUTION_CANCELLED", { reason: "document-deleted" }));
    await s.rec.idle();
    expect(s.record).toHaveBeenCalledTimes(2);
    expect(s.seen).toHaveLength(1);
  });

  it("ignores other events, other executions (ingest, turn visuals) and an output outside the schema", async () => {
    const s = setup();
    const id = visualizeExecutionId(s.who.userId, s.who.documentId, 1);
    s.rec.onEvent(event(id, "STEP_COMPLETED", { output: { outcome: "failed" } }));
    s.rec.onEvent(event(`u_${s.who.userId}:ingest-${s.who.documentId}`, "EXECUTION_FAILED"));
    s.rec.onEvent(event(`u_${s.who.userId}:visualize-turn-${randomUUID()}-4`, "EXECUTION_FAILED"));
    s.rec.onEvent(event(id, "EXECUTION_COMPLETED", { output: { outcome: "weird" } }));
    s.rec.onEvent(event(id, "EXECUTION_COMPLETED", { output: { outcome: "done", leak: "text" } }));
    await s.rec.idle();
    expect(s.record).not.toHaveBeenCalled();
  });

  it("hands the store ids, enums and a code only: no event payload field reaches it or the bus", async () => {
    const s = setup();
    const id = visualizeExecutionId(s.who.userId, s.who.documentId, 1);
    s.rec.onEvent(
      event(id, "EXECUTION_COMPLETED", {
        output: { outcome: "failed", code: "visuals-model-unavailable" },
        facts: "Zebra-Secret",
        error: "Zebra-Secret",
      }),
    );
    await s.rec.idle();
    expect(JSON.stringify([s.record.mock.calls, s.seen])).not.toContain("Zebra");
  });

  it("never throws into the feed: a failing store is reported, later events still record in order", async () => {
    const s = setup();
    s.record.mockRejectedValueOnce(new RangeError("db down"));
    const id = visualizeExecutionId(s.who.userId, s.who.documentId, 1);
    expect(() =>
      s.rec.onEvent(event(id, "EXECUTION_COMPLETED", { output: { outcome: "done" } })),
    ).not.toThrow();
    s.rec.onEvent(event(id, "EXECUTION_COMPLETED", { output: { outcome: "empty" } }));
    await s.rec.idle();
    expect(s.errors).toHaveLength(1);
    expect(s.record.mock.calls.map((c) => c[1])).toEqual(["done", "empty"]);
  });
});
