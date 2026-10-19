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
const SEALED = {
  __loomEnc: "loom/aes-256-gcm",
  iv: Buffer.alloc(12, 1).toString("base64"),
  tag: Buffer.alloc(16, 2).toString("base64"),
  data: Buffer.alloc(20, 3).toString("base64"),
};
const MODEL = "ollama/fake-embed";
const check = (...events: RawEvent[]) => assertEventsAreContentFree(events, ref);
const checkEmbed = (...events: RawEvent[]) => assertEventsAreContentFree(events, ref, MODEL);
const embedDone = (output: Record<string, unknown>) =>
  ev("STEP_COMPLETED", { output, stepId: "ingest-embed" });

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
      "a model when no embedder model was configured for the check",
      embedDone({ outcome: "done", count: 2, model: MODEL }),
      /output\.model is not an id/,
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
    [
      "a step id outside the flow's steps",
      ev("STEP_STARTED", { input: ref, stepId: "ingest-quarterly" }),
      /\.stepId is not an id/,
    ],
    [
      "a failure naming a step the flow does not have",
      ev("EXECUTION_FAILED", { error: "Error: ingest step failed: quarterly" }),
      /\.error is not an id/,
    ],
    [
      "a sealed leaf that is not base64",
      ev("EXECUTION_STARTED", {
        input: ref,
        flowHash: "fnv1a:41c3727d",
        principal: {
          v: 1,
          identity: { actor: { ...SEALED, data: "Q3 report!" }, tenant: SEALED },
        },
      }),
      /identity\.actor is not an id/,
    ],
    [
      "a sealed iv of the wrong length",
      ev("EXECUTION_STARTED", {
        input: ref,
        flowHash: "fnv1a:41c3727d",
        principal: {
          v: 1,
          identity: {
            actor: { ...SEALED, iv: Buffer.alloc(8).toString("base64") },
            tenant: SEALED,
          },
        },
      }),
      /identity\.actor is not an id/,
    ],
  ])("throws for %s", (_name, event, message) => {
    expect(() => check(event)).toThrow(message);
  });

  it("accepts the chunk step and its fixed failure message, and a well-formed sealed envelope", () => {
    expect(() =>
      check(
        ev("EXECUTION_STARTED", {
          input: ref,
          flowHash: "fnv1a:41c3727d",
          principal: { v: 1, identity: { actor: SEALED, tenant: SEALED } },
        }),
        ev("STEP_STARTED", { input: ref, stepId: "ingest-chunk" }),
        ev("STEP_FAILED", { error: "Error: ingest step failed: chunk", stepId: "ingest-chunk" }),
      ),
    ).not.toThrow();
  });

  it("accepts the embed step's result with exactly the configured model, and its fixed failure", () => {
    expect(() =>
      checkEmbed(
        ev("STEP_STARTED", { input: ref, stepId: "ingest-embed" }),
        embedDone({ outcome: "done", count: 2, model: MODEL }),
        ev("STEP_FAILED", { error: "Error: ingest step failed: embed", stepId: "ingest-embed" }),
      ),
    ).not.toThrow();
  });

  it.each([
    [
      "a filename-like model",
      { outcome: "done", count: 2, model: "quarterly-report.pdf" },
      /output\.model is not an id/,
    ],
    [
      "another model id",
      { outcome: "done", count: 2, model: "ollama/other" },
      /output\.model is not an id/,
    ],
    [
      "a model that only contains the configured one",
      { outcome: "done", model: `${MODEL}-x` },
      /output\.model is not an id/,
    ],
    [
      "chunk text in the result",
      { outcome: "done", count: 2, model: MODEL, text: SENTENCE },
      /unexpected key .*\.output\.text/,
    ],
    [
      "chunk text as the count",
      { outcome: "done", count: SENTENCE, model: MODEL },
      /output\.count is not an id/,
    ],
  ])("throws for %s in an embed result", (_name, output, message) => {
    expect(() => checkEmbed(embedDone(output))).toThrow(message);
  });

  it("throws for an empty log, which would prove nothing", () => {
    expect(() => check()).toThrow(/no events to check/);
  });
});
