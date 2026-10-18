import { randomUUID } from "node:crypto";
import { sensitivePathsFromSteps } from "@loom/plugin-crypto";
import { ExecutionAlreadyExistsError, ExecutionDeniedError } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../config";
import { SENSITIVE_EVENT_PATHS } from "../../sensitive";
import { executionIdFor } from "../../subject";
import type { IngestDeps } from "./deps";
import { IngestOutput, IngestStartInput, ingestDocumentFlow } from "./flow";

const ids = (): IngestStartInput => ({
  tenantId: randomUUID(),
  userId: randomUUID(),
  documentId: randomUUID(),
});
const appWith = (exists: boolean) => {
  const seen: IngestStartInput[] = [];
  const deps: IngestDeps = {
    documentExists: async (ref) => {
      seen.push(ref);
      return exists;
    },
  };
  return { app: buildApp({ kind: "memory" }, undefined, { ingest: deps }), seen };
};
type App = ReturnType<typeof buildApp>;
const run = (input: IngestStartInput, app: App) =>
  app.runtime.start(ingestDocumentFlow, input, {
    executionId: executionIdFor(input.userId, `ingest-${input.documentId}`),
    principal: { tenant: input.tenantId, actor: input.userId },
  });

describe("ingest-document stub flow", () => {
  it("completes with 'accepted' while the document exists, asking with ids only", async () => {
    const { app, seen } = appWith(true);
    const input = ids();
    const state = await (await run(input, app)).waitForCompletion();
    expect(state.status).toBe("completed");
    expect(state.variables._output).toEqual({ outcome: "accepted" });
    expect(seen).toEqual([input]);
    await app.close();
  });

  it("stops cleanly, not as a failure, when the document is gone", async () => {
    const { app } = appWith(false);
    const state = await (await run(ids(), app)).waitForCompletion();
    expect(state.status).toBe("completed");
    expect(state.variables._output).toEqual({ outcome: "document_gone" });
    await app.close();
  });

  it("is start-once per document: the execution id is the idempotency key", async () => {
    const { app } = appWith(true);
    const input = ids();
    await (await run(input, app)).waitForCompletion();
    await expect(run(input, app)).rejects.toBeInstanceOf(ExecutionAlreadyExistsError);
    await app.close();
  });

  it("fails at its step, not silently, when the app was built without ingest deps", async () => {
    const app = buildApp({ kind: "memory" });
    const handle = await run(ids(), app);
    await expect(handle.waitForCompletion()).rejects.toThrow(
      /No effect registered for toolId: "ingest-begin"/,
    );
    await app.close();
  });

  it("is refused for a caller with no principal (the grants and owner policy are live)", async () => {
    const { app } = appWith(true);
    const input = ids();
    await expect(
      app.runtime.start(ingestDocumentFlow, input, {
        executionId: executionIdFor(input.userId, "ingest-x"),
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

  it("produces only a two-value enum, which cannot hold content", () => {
    expect(Object.keys(IngestOutput.shape)).toEqual(["outcome"]);
    expect(IngestOutput.shape.outcome.options).toEqual(["accepted", "document_gone"]);
  });

  it("marks nothing sensitive, and so registers no event paths", () => {
    expect(sensitivePathsFromSteps(ingestDocumentFlow.definition.steps)).toEqual({});
    // If a content-bearing field is ever added to this flow, register it in the same PR and update
    // this expectation: an event written before its path is registered stays readable forever.
    expect(SENSITIVE_EVENT_PATHS).toEqual({});
  });

  it("keeps the execution id free of content: u_<user>:ingest-<document uuid> only", () => {
    const input = ids();
    expect(executionIdFor(input.userId, `ingest-${input.documentId}`)).toMatch(
      /^u_[0-9a-f-]{36}:ingest-[0-9a-f-]{36}$/,
    );
  });
});
