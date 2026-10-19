import { randomUUID } from "node:crypto";
import { sensitivePathsFromSteps } from "@loom/plugin-crypto";
import { ExecutionAlreadyExistsError, ExecutionDeniedError } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../config";
import { ingestExecutionId } from "../../documents/ingest";
import { SENSITIVE_EVENT_PATHS } from "../../sensitive";
import type { IngestDeps } from "./deps";
import { DocumentGoneError } from "./errors";
import { INGEST_STEPS, IngestOutput, IngestStartInput, ingestDocumentFlow } from "./flow";
import { StepResult } from "./stepEffect";
import { fakeIngestDeps } from "./testing";

const ids = (): IngestStartInput => ({
  tenantId: randomUUID(),
  userId: randomUUID(),
  documentId: randomUUID(),
});
/** Fake ports; `run` is the sandboxed parse, `sleep` the (instant) wait between retry attempts. */
const fakeDeps = (over: Partial<IngestDeps> = {}) => {
  const seen: string[] = [];
  const deps: IngestDeps = fakeIngestDeps({
    guard: { begin: async (_r, step) => void seen.push(`begin:${step}`) },
    sleep: async () => {},
    ...over,
  });
  return { deps, seen };
};
type App = ReturnType<typeof buildApp>;
const run = (input: IngestStartInput, app: App) =>
  app.runtime.start(ingestDocumentFlow, input, {
    executionId: ingestExecutionId(input.userId, input.documentId),
    principal: { tenant: input.tenantId, actor: input.userId },
  });
const outputOf = async (deps: IngestDeps) => {
  const app = buildApp({ kind: "memory" }, undefined, { ingest: deps });
  const state = await (await run(ids(), app)).waitForCompletion();
  await app.close();
  return state.variables._output;
};

describe("ingest-document flow v2", () => {
  it("runs the parse step and completes done, asking with ids only", async () => {
    const { deps, seen } = fakeDeps();
    expect(await outputOf(deps)).toEqual({ outcome: "done" });
    expect(seen).toEqual(["begin:parse"]);
  });

  it("stops cleanly, not as a failure, when the document is gone", async () => {
    const guard = {
      begin: async () => {
        throw new DocumentGoneError();
      },
    };
    expect(await outputOf(fakeDeps({ guard }).deps)).toEqual({ outcome: "document_gone" });
  });

  it("is start-once per document and generation", async () => {
    const app = buildApp({ kind: "memory" }, undefined, { ingest: fakeDeps().deps });
    const input = ids();
    await (await run(input, app)).waitForCompletion();
    await expect(run(input, app)).rejects.toBeInstanceOf(ExecutionAlreadyExistsError);
    await app.close();
  });

  it("fails at its step, not silently, when the app was built without ingest deps", async () => {
    const app = buildApp({ kind: "memory" });
    await expect((await run(ids(), app)).waitForCompletion()).rejects.toThrow(
      /No effect registered for toolId: "ingest-parse"/,
    );
    await app.close();
  });

  it("is refused for a caller with no principal (the grants and owner policy are live)", async () => {
    const app = buildApp({ kind: "memory" }, undefined, { ingest: fakeDeps().deps });
    const input = ids();
    await expect(
      app.runtime.start(ingestDocumentFlow, input, {
        executionId: ingestExecutionId(input.userId, input.documentId),
      }),
    ).rejects.toBeInstanceOf(ExecutionDeniedError);
    await app.close();
  });
});

describe("what the flow may carry (owner decision 1: ids only)", () => {
  it("accepts exactly three UUIDs as start input and refuses any other field", () => {
    const input = ids();
    expect(Object.keys(IngestStartInput.shape).sort()).toEqual([
      "documentId",
      "tenantId",
      "userId",
    ]);
    expect(IngestStartInput.safeParse(input).success).toBe(true);
    for (const extra of ["filename", "title", "content", "text", "summary", "mime"]) {
      expect(
        IngestStartInput.safeParse({ ...input, [extra]: "tax-return.pdf" }).success,
        extra,
      ).toBe(false);
    }
    expect(IngestStartInput.safeParse({ ...input, documentId: "tax-return.pdf" }).success).toBe(
      false,
    );
  });

  it("gives every step the same content-free result and the flow an outcome and a code only", () => {
    expect(Object.keys(StepResult.shape).sort()).toEqual(["code", "count", "model", "outcome"]);
    expect(Object.keys(IngestOutput.shape).sort()).toEqual(["code", "outcome"]);
    for (const step of INGEST_STEPS) expect(step.outputSchema).toBe(StepResult);
  });

  it("marks nothing sensitive, and so registers no event paths", () => {
    expect(sensitivePathsFromSteps(ingestDocumentFlow.definition.steps)).toEqual({});
    // If a content-bearing field is ever added to this flow, register it in the same PR and update
    // this expectation: an event written before its path is registered stays readable forever.
    expect(SENSITIVE_EVENT_PATHS).toEqual({});
  });

  it("keeps the execution id free of content: u_<user>:ingest-<document uuid>.<generation> only", () => {
    const input = ids();
    expect(ingestExecutionId(input.userId, input.documentId)).toMatch(
      /^u_[0-9a-f-]{36}:ingest-[0-9a-f-]{36}\.\d+$/,
    );
  });
});
