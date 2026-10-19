import { describe, expect, it } from "vitest";
import { ingestExecutionId } from "../../documents/ingest";
import { type RawEvent, assertEventsAreContentFree } from "./testing";

const ID = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const OTHER = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
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
      "an email in a step input",
      ev("STEP_STARTED", { input: { ...ref, email: "a@b.example" }, stepId: "ingest-parse" }),
      /unexpected key .*\.input\.email/,
    ],
    [
      "a title as an id",
      ev("STEP_STARTED", {
        input: { ...ref, documentId: "Quarterly report" },
        stepId: "ingest-parse",
      }),
      /input\.documentId is not an id/,
    ],
    [
      "another document's id",
      ev("STEP_STARTED", { input: { ...ref, documentId: OTHER }, stepId: "ingest-parse" }),
      /input\.documentId is not an id/,
    ],
    [
      "text as the outcome",
      ev("STEP_COMPLETED", { output: { outcome: SENTENCE }, stepId: "ingest-parse" }),
      /output\.outcome is not an id/,
    ],
    [
      "text as a code",
      ev("EXECUTION_COMPLETED", { output: { outcome: "failed", code: "report.pdf is broken" } }),
      /output\.code is not an id/,
    ],
    [
      "a model key (none is allowed yet)",
      ev("STEP_COMPLETED", {
        output: { outcome: "done", model: "quarterly-report.pdf" },
        stepId: "ingest-parse",
      }),
      /unexpected key .*\.output\.model/,
    ],
    [
      "a plaintext principal",
      ev("EXECUTION_STARTED", {
        input: ref,
        flowHash: "fnv1a:41c3727d",
        principal: { v: 1, identity: { actor: "alice@example.com", tenant: "acme" } },
      }),
      /identity\.actor is not an id/,
    ],
    [
      "an error message with text",
      ev("STEP_FAILED", { error: `Error: could not parse ${SENTENCE}`, stepId: "ingest-parse" }),
      /\.error is not an id/,
    ],
    ["an event type nobody listed", ev("NOTE_ADDED", { note: SENTENCE }), /eventType is not an id/],
    ["an inherited event type", ev("constructor", {}), /eventType is not an id/],
    [
      "a toString key",
      ev("STEP_COMPLETED", {
        output: { outcome: "done", toString: SENTENCE },
        stepId: "ingest-parse",
      }),
      /unexpected key .*\.output\.toString/,
    ],
    [
      "a constructor key",
      ev("STEP_COMPLETED", {
        output: { outcome: "done", constructor: SENTENCE },
        stepId: "ingest-parse",
      }),
      /unexpected key .*\.output\.constructor/,
    ],
    [
      "a __proto__ key",
      ev(
        "STEP_COMPLETED",
        JSON.parse(
          `{"output":{"outcome":"done","__proto__":"${SENTENCE}"},"stepId":"ingest-parse"}`,
        ),
      ),
      /unexpected key .*\.output\.__proto__/,
    ],
    [
      "a filename in the execution id",
      ev("STEP_STARTED", started, { executionId: "u_x:ingest-report.pdf" }),
      /executionId is not an id/,
    ],
    [
      "another execution's id",
      ev("STEP_STARTED", started, { executionId: ingestExecutionId(OTHER, ID) }),
      /executionId is not an id/,
    ],
    [
      "an extra envelope key",
      ev("STEP_STARTED", started, { note: SENTENCE }),
      /unexpected key .*\.note/,
    ],
    [
      "a missing envelope field",
      (({ sequence: _dropped, ...rest }) => rest as RawEvent)(ev("STEP_STARTED", started)),
      /missing key .*\.sequence/,
    ],
    [
      "text as the event id",
      ev("STEP_STARTED", started, { id: "Q3 report.pdf" }),
      /\.id is not an id/,
    ],
    [
      "a free-text cancel reason",
      ev("EXECUTION_CANCELLED", { reason: "user deleted Q3 report.pdf" }),
      /\.reason is not an id/,
    ],
    [
      "a text fence",
      ev(
        "EXECUTION_CANCELLED",
        { reason: "document-deleted" },
        { metadata: { fence: "Q3 report.pdf" } },
      ),
      /\.fence is not an id/,
    ],
    [
      "text in a step cancel",
      ev("STEP_CANCELLED", { stepId: "ingest-parse", note: SENTENCE }),
      /unexpected key .*\.note/,
    ],
    [
      "a free-text denied reason",
      ev("EXECUTION_DENIED", { op: "cancel", actor: ID, reason: "no: Q3 report.pdf" }),
      /\.reason is not an id/,
    ],
    [
      "a name as the denied actor",
      ev("EXECUTION_DENIED", {
        op: "cancel",
        actor: "alice@example.com",
        reason: "only the execution's owner may do this",
      }),
      /\.actor is not an id/,
    ],
  ])("throws for %s", (_name, event, message) => {
    expect(() => check(event)).toThrow(message);
  });

  it("throws for an empty log, which would prove nothing", () => {
    expect(() => check()).toThrow(/no events to check/);
  });
});
