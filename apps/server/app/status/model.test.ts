import { randomUUID } from "node:crypto";
import { ProgressDetail } from "@docmind/contracts";
import { InMemoryReadModelStore, ReadModelService } from "@loom/plugin-read-model";
import { describe, expect, it } from "vitest";
import { FAILURE_CODES } from "../flows/ingest-document/errors";
import {
  INITIAL_STATUS,
  RECOVERY_EXHAUSTED_REASON,
  STATUS_MESSAGES,
  STATUS_OF_STEP,
  UNRECOVERABLE_REASONS,
  UPLOADED,
  foldIngestStatus,
  generationOf,
  ingestKeyOf,
  ingestScopeOf,
  ingestStatus,
  isIngestExecution,
  progressOf,
  viewOf,
} from "./model";
import { evt, ingestRun } from "./testing";

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
      "2",
      INITIAL_STATUS,
    ]);
    expect(Object.keys(ingestStatus.handlers).sort()).toEqual([
      "EXECUTION_CANCELLED",
      "EXECUTION_FAILED",
      "EXECUTION_STARTED",
      "STEP_COMPLETED",
      "STEP_STARTED",
    ]);
  });
});

describe("through Loom's folded-model service", () => {
  it("folds by key and scope; a non-ingest execution gets a row with null key and scope", async () => {
    const store = new InMemoryReadModelStore();
    const service = new ReadModelService(store, {});
    await service.registerFolded({
      projection: ingestStatus,
      keyOf: ingestKeyOf,
      scopeOf: ingestScopeOf,
    });
    const chat = `u_${U}:chat-${D}`;
    for (const e of [...ingestRun(exec(".2"), "ready"), ...ingestRun(chat, "started")]) {
      service.handleEvent(e);
    }
    await service.drain();
    const [row] = await store.getFoldedByKey("ingest-status", [D]);
    expect(row).toMatchObject({
      executionId: exec(".2"),
      key: D,
      scope: U,
      state: { status: "ready", step: "finalize", code: null },
    });
    const [other] = await store.getFolded("ingest-status", [chat]);
    expect(other).toMatchObject({ key: null, scope: null, state: INITIAL_STATUS });
  });
});

describe("the view", () => {
  it("carries the fixed message of a failure code, and no error for a healthy state", () => {
    const state = foldIngestStatus(ingestRun(exec(), "failed:corrupt_content"));
    expect(viewOf(state)).toEqual({
      status: "failed",
      step: "parse",
      error: STATUS_MESSAGES.corrupt_content,
    });
    expect(viewOf(INITIAL_STATUS)).toEqual(UPLOADED);
  });

  it("has a message for every failure code and for internal, and UPLOADED carries no error", () => {
    expect(Object.keys(STATUS_MESSAGES).sort()).toEqual([...FAILURE_CODES, "internal"].sort());
    expect(UPLOADED).toEqual({ status: "uploaded", step: null, error: null });
  });

  it("keeps the contract's detail enum equal to the app's codes", () => {
    expect([...ProgressDetail.options].sort()).toEqual([...FAILURE_CODES, "internal"].sort());
  });
});

describe("progressOf", () => {
  const e = (type: string, payload: unknown) => evt(exec(".2"), 3, type, payload);
  it("derives the SSE event for a step start, a permanent failure and finalize's completion", () => {
    expect(progressOf(e("STEP_STARTED", { stepId: "ingest-embed" }))).toEqual({
      userId: U,
      progress: { documentId: D, step: "embed", status: "embedding" },
    });
    expect(
      progressOf(
        e("STEP_COMPLETED", {
          stepId: "ingest-parse",
          output: { outcome: "failed", code: "unsupported_content" },
        }),
      ),
    ).toEqual({
      userId: U,
      progress: { documentId: D, step: "parse", status: "failed", detail: "unsupported_content" },
    });
    expect(
      progressOf(e("STEP_COMPLETED", { stepId: "ingest-finalize", output: { outcome: "done" } })),
    ).toEqual({ userId: U, progress: { documentId: D, step: "finalize", status: "ready" } });
  });

  it("derives a terminal failed event, without a step, for an execution failure", () => {
    expect(progressOf(e("EXECUTION_FAILED", {}))).toEqual({
      userId: U,
      progress: { documentId: D, status: "failed", detail: "internal" },
    });
  });

  it("puts only a fixed code in detail, even when the log carries free text as the code", () => {
    const out = progressOf(
      e("STEP_COMPLETED", {
        stepId: "ingest-parse",
        output: { outcome: "failed", code: "secret text" },
      }),
    );
    expect(out?.progress.detail).toBe("internal");
  });

  it("derives nothing for events that do not move the status, or for other executions", () => {
    expect(progressOf(evt(exec(), 1, "EXECUTION_STARTED", {}))).toBeNull();
    expect(
      progressOf(
        evt(exec(), 2, "STEP_COMPLETED", { stepId: "ingest-parse", output: { outcome: "done" } }),
      ),
    ).toBeNull();
    expect(
      progressOf(evt(`u_${U}:chat-${D}`, 1, "STEP_STARTED", { stepId: "ingest-parse" })),
    ).toBeNull();
    expect(progressOf(evt(`u_${U}:chat-${D}`, 2, "EXECUTION_FAILED", {}))).toBeNull();
  });
});

describe("an execution recovery gave up on", () => {
  const cancelled = (reason: unknown) => evt(exec(), 9, "EXECUTION_CANCELLED", { reason });

  it.each(UNRECOVERABLE_REASONS)("folds a cancel with reason %s to failed / internal", (reason) => {
    const log = [...ingestRun(exec(), "parsed"), cancelled(reason)];
    expect(foldIngestStatus(log)).toEqual({ status: "failed", step: "parse", code: "internal" });
    expect(viewOf(foldIngestStatus(log)).error).toBe(STATUS_MESSAGES.internal);
    expect(progressOf(cancelled(reason))).toEqual({
      userId: U,
      progress: { documentId: D, status: "failed", detail: "internal" },
    });
  });

  it("leaves a user's delete (any other reason) and a missing reason as they were", () => {
    for (const reason of ["document-deleted", undefined, 42]) {
      const log = [...ingestRun(exec(), "parsed"), cancelled(reason)];
      expect(foldIngestStatus(log)).toEqual(foldIngestStatus(ingestRun(exec(), "parsed")));
      expect(progressOf(cancelled(reason))).toBeNull();
    }
  });

  it("does not reopen or change a terminal state", () => {
    const log = [...ingestRun(exec(), "failed:too_large"), cancelled(RECOVERY_EXHAUSTED_REASON)];
    expect(foldIngestStatus(log)).toMatchObject({ status: "failed", code: "too_large" });
  });
});
