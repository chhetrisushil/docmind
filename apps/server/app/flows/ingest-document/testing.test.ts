import { describe, expect, it } from "vitest";
import { ingestExecutionId } from "../../documents/ingest";
import { type RawEvent, assertEventsAreContentFree } from "./testing";

const ID = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const ref = { documentId: ID, tenantId: ID, userId: ID };
const executionId = ingestExecutionId(ID, ID);
const SENTENCE = "Nocturne quarterly revenue forecast: seventeen thousand dollars";
const ev = (eventType: string, payload: unknown, over: Record<string, unknown> = {}): RawEvent =>
  ({
    id: `${executionId}-1`,
    sequence: 1,
    timestamp: 1,
    executionId,
    workflowId: "ingest-document",
    eventType,
    payload,
    ...over,
  }) as RawEvent;
const started = { input: ref, stepId: "ingest-parse" };
const done = { output: { outcome: "done", count: 3 }, stepId: "ingest-parse" };
const check = (...events: RawEvent[]) => assertEventsAreContentFree(events, ref);

describe("assertEventsAreContentFree (the proof has teeth)", () => {
  it("accepts a clean log of ids, outcomes, counts and codes", () => {
    expect(() =>
      check(
        ev("STEP_STARTED", started),
        ev("STEP_COMPLETED", done),
        ev("EXECUTION_COMPLETED", { output: { outcome: "failed", code: "too_large" } }),
      ),
    ).not.toThrow();
  });

  it.each([
    [
      "text in a step output",
      ev("STEP_COMPLETED", { output: { outcome: "done", text: SENTENCE }, stepId: "ingest-parse" }),
      /unexpected key .*\.output\.text/,
    ],
    [
      "a filename in a step input",
      ev("STEP_STARTED", { input: { ...ref, filename: "Q3 report.pdf" }, stepId: "ingest-parse" }),
      /unexpected key .*\.input\.filename/,
    ],
    [
      "an error message with text",
      ev("STEP_FAILED", { error: `Error: could not parse ${SENTENCE}`, stepId: "ingest-parse" }),
      /\.error is not an id/,
    ],
  ])("throws for %s", (_name, event, message) => {
    expect(() => check(event)).toThrow(message);
  });

  it("throws for an empty log, which would prove nothing", () => {
    expect(() => check()).toThrow(/no events to check/);
  });
});
