import { randomUUID } from "node:crypto";
import type { EventEnvelope } from "@loom/core";
import { describe, expect, it } from "vitest";
import {
  INITIAL_STATUS,
  STATUS_OF_STEP,
  foldIngestStatus,
  generationOf,
  ingestKeyOf,
  ingestScopeOf,
  ingestStatus,
  isIngestExecution,
} from "./model";

/** An event the way Loom writes one (fields as in `EventEnvelope`). */
const evt = (
  executionId: string,
  sequence: number,
  eventType: string,
  payload: unknown = {},
): EventEnvelope => ({
  id: `${executionId}-${sequence}`,
  workflowId: "ingest-document",
  executionId,
  eventType,
  sequence,
  timestamp: 1_000 + sequence,
  payload,
});

/** The events of one ingest execution, from sequence 0: just started, parsing, ready, or failed with a code. */
function ingestRun(
  executionId: string,
  spec: "started" | "parsed" | "ready" | `failed:${string}`,
): EventEnvelope[] {
  const out: EventEnvelope[] = [evt(executionId, 0, "EXECUTION_STARTED", { input: {} })];
  const step = (type: string, stepId: string, output?: unknown) =>
    out.push(
      evt(executionId, out.length, type, output === undefined ? { stepId } : { stepId, output }),
    );
  if (spec === "started") return out;
  step("STEP_STARTED", "ingest-parse");
  if (spec === "parsed") return out;
  if (spec.startsWith("failed:")) {
    step("STEP_COMPLETED", "ingest-parse", { outcome: "failed", code: spec.slice(7) });
    return out;
  }
  step("STEP_COMPLETED", "ingest-parse", { outcome: "done", count: 1 });
  step("STEP_STARTED", "ingest-finalize");
  step("STEP_COMPLETED", "ingest-finalize", { outcome: "done", count: 1 });
  return out;
}

const U = randomUUID();
const D = randomUUID();
const exec = (suffix = "") => `u_${U}:ingest-${D}${suffix}`;

describe("execution ids", () => {
  it.each([[""], [".1"], [".2"], [".12"]])(
    "maps generation suffix %j to the document and the user",
    (suffix) => {
      const id = exec(suffix);
      expect([ingestKeyOf(id), ingestScopeOf(id), isIngestExecution(id)]).toEqual([D, U, true]);
    },
  );
  it.each([
    [`u_${U}:chat-${D}`],
    [`u_${U}:ingest-${D}.x`],
    [`u_${U}:ingest-${D}.0`],
    [`u_${U}:ingest-${D}.02`],
    [`u_${U}:ingest-${D}.`],
    [`u_${U}:ingest-${D}.1.2`],
    [`u_${U}:ingest-${D}\n`],
    [`u_${U}:ingest-${D}:more`],
    [`u_${U}:ingest-${D.toUpperCase()}`],
    [`u_${U.toUpperCase()}:ingest-${D}`],
    [`u_${U}:ingest-not-a-uuid`],
    [`u_${U}:xingest-${D}`],
    [`x:ingest-${D}`],
    [`ingest-${D}`],
    [""],
  ])("treats %j as no ingest execution", (id) => {
    expect([ingestKeyOf(id), ingestScopeOf(id), isIngestExecution(id), generationOf(id)]).toEqual([
      undefined,
      undefined,
      false,
      undefined,
    ]);
  });
  it("reads the generation, with no suffix meaning 1", () => {
    expect([exec(""), exec(".2"), exec(".10")].map(generationOf)).toEqual([1, 2, 10]);
  });
});

describe("the fold", () => {
  it("follows the steps: parse and chunk are parsing, the rest embedding, finalize's completion is ready", () => {
    expect(Object.values(STATUS_OF_STEP).filter((v) => v === "embedding")).toHaveLength(5);
    expect(foldIngestStatus([])).toEqual(INITIAL_STATUS);
    expect(foldIngestStatus(ingestRun(exec(), "started"))).toEqual({
      status: "uploaded",
      step: null,
      code: null,
    });
    expect(foldIngestStatus(ingestRun(exec(), "parsed"))).toEqual({
      status: "parsing",
      step: "parse",
      code: null,
    });
    expect(foldIngestStatus(ingestRun(exec(), "ready"))).toEqual({
      status: "ready",
      step: "finalize",
      code: null,
    });
  });

  it("ends failed with the code of a permanent failure", () => {
    expect(foldIngestStatus(ingestRun(exec(), "failed:corrupt_content"))).toEqual({
      status: "failed",
      step: "parse",
      code: "corrupt_content",
    });
  });

  it("maps an unknown failure code to internal, and an execution failure to failed/internal without overwriting a specific code", () => {
    const odd = [
      ...ingestRun(exec(), "parsed"),
      evt(exec(), 9, "STEP_COMPLETED", {
        stepId: "ingest-parse",
        output: { outcome: "failed", code: "whatever" },
      }),
    ];
    expect(foldIngestStatus(odd)).toMatchObject({ status: "failed", code: "internal" });
    const crashed = [...ingestRun(exec(), "parsed"), evt(exec(), 9, "EXECUTION_FAILED", {})];
    expect(foldIngestStatus(crashed)).toEqual({
      status: "failed",
      code: "internal",
      step: "parse",
    });
    const specific = [
      ...ingestRun(exec(), "failed:too_large"),
      evt(exec(), 9, "EXECUTION_FAILED", {}),
    ];
    expect(foldIngestStatus(specific).code).toBe("too_large");
  });

  it("ignores document_gone and plain done outcomes, foreign steps, other event kinds (even prototype names) and shredded payloads", () => {
    const events = [
      ...ingestRun(exec(), "parsed"),
      evt(exec(), 10, "STEP_COMPLETED", {
        stepId: "ingest-parse",
        output: { outcome: "done", count: 3 },
      }),
      evt(exec(), 11, "STEP_COMPLETED", {
        stepId: "ingest-chunk",
        output: { outcome: "document_gone" },
      }),
      evt(exec(), 12, "STEP_STARTED", { stepId: "something-else" }),
      evt(exec(), 13, "TIMER_FIRED", {}),
      evt(exec(), 14, "STEP_STARTED", { $shredded: true }),
      evt(exec(), 15, "STEP_COMPLETED", { stepId: "ingest-finalize", output: "[redacted]" }),
      evt(exec(), 16, "constructor", {}),
      evt(exec(), 17, "STEP_STARTED", null),
    ];
    expect(foldIngestStatus(events)).toEqual({ status: "parsing", step: "parse", code: null });
  });

  it("keeps a terminal state: nothing after failed or ready reopens it, and a late execution failure leaves ready alone", () => {
    const late = (events: ReturnType<typeof ingestRun>) => [
      ...events,
      evt(exec(), 20, "STEP_STARTED", { stepId: "ingest-embed" }),
      evt(exec(), 21, "STEP_COMPLETED", {
        stepId: "ingest-embed",
        output: { outcome: "failed", code: "too_large" },
      }),
      evt(exec(), 22, "EXECUTION_FAILED", {}),
    ];
    expect(foldIngestStatus(late(ingestRun(exec(), "ready")))).toEqual({
      status: "ready",
      step: "finalize",
      code: null,
    });
    expect(foldIngestStatus(late(ingestRun(exec(), "failed:corrupt_content")))).toEqual({
      status: "failed",
      step: "parse",
      code: "corrupt_content",
    });
  });

  it("is registered as one durable fold, with enums and codes only", () => {
    expect([ingestStatus.id, ingestStatus.version, ingestStatus.initialState]).toEqual([
      "ingest-status",
      "1",
      INITIAL_STATUS,
    ]);
    expect(Object.keys(ingestStatus.handlers).sort()).toEqual([
      "EXECUTION_FAILED",
      "EXECUTION_STARTED",
      "STEP_COMPLETED",
      "STEP_STARTED",
    ]);
  });
});
