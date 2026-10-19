import { randomUUID } from "node:crypto";
import { EmbeddingAbortedError } from "@docmind/embeddings";
import { ParseAbortedError, ParseCrashedError, ParseRejectedError } from "@docmind/parsers";
import { InMemoryChunkVectors } from "@docmind/vector-pg";
import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { sensitivePathsFromSteps } from "@loom/plugin-crypto";
import { ExecutionAlreadyExistsError, ExecutionDeniedError } from "@loom/workflow-runtime";
import { recoverAbandoned } from "@loom/workflow-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../config";
import { ingestExecutionId, loomIngest } from "../../documents/ingest";
import { SENSITIVE_EVENT_PATHS } from "../../sensitive";
import type { IngestDeps } from "./deps";
import { DocumentGoneError } from "./errors";
import {
  INGEST_STEPS,
  IngestOutput,
  IngestStartInput,
  ingestDocumentFlow,
  ingestParseStep,
  runIngestSteps,
} from "./flow";
import { type IngestWiring, closeIngest } from "./limits";
import { STEP_RETRY, StepResult } from "./stepEffect";
import { fakeIngestDeps } from "./testing";

afterEach(() => vi.restoreAllMocks());

const ids = (): IngestStartInput => ({
  tenantId: randomUUID(),
  userId: randomUUID(),
  documentId: randomUUID(),
});
const PARSED = {
  text: "h",
  sections: [{ headingPath: [], text: "h", locator: { kind: "chars" as const, start: 0, end: 1 } }],
  media: [],
};
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
    expect(seen).toEqual(
      ["parse", "chunk", "embed", "analyze", "summarize", "link", "finalize"].map(
        (step) => `begin:${step}`,
      ),
    );
    expect(INGEST_STEPS.map((s) => s.id)).toEqual([
      "ingest-parse",
      "ingest-chunk",
      "ingest-embed",
      "ingest-analyze",
      "ingest-summarize",
      "ingest-link",
      "ingest-finalize",
    ]);
  });

  it("stops cleanly, not as a failure, when the document is gone", async () => {
    const guard = {
      begin: async () => {
        throw new DocumentGoneError();
      },
    };
    expect(await outputOf(fakeDeps({ guard }).deps)).toEqual({ outcome: "document_gone" });
  });

  it("ends with outcome failed and the code for a permanent content problem", async () => {
    const runner = {
      run: async () => {
        throw new ParseRejectedError("corrupt_content");
      },
    };
    expect(await outputOf(fakeDeps({ runner }).deps)).toEqual({
      outcome: "failed",
      code: "corrupt_content",
    });
  });

  it("a cancel during embed (what the delete route issues) cancels the execution and aborts the embedder call", async () => {
    let inEmbed: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      inEmbed = resolve;
    });
    let aborted = false;
    let embedCalls = 0;
    const input = ids();
    const embedder = {
      modelId: "m",
      dimensions: 8,
      embed: (_texts: string[], options?: { signal?: AbortSignal }) =>
        new Promise<number[][]>((_, reject) => {
          embedCalls++;
          inEmbed();
          options?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new EmbeddingAbortedError());
          });
        }),
    };
    const vectors = new InMemoryChunkVectors({
      modelId: "m",
      dimensions: 8,
      chunkIds: async () => ["c1"],
    });
    const upsert = vi.spyOn(vectors, "upsert");
    const { deps } = fakeDeps({
      embedder,
      vectors,
      chunks: {
        replace: async (_r, c) => c.length,
        count: async () => 1,
        read: async (_r, rows) => rows.map((id) => ({ id, text: "t" })),
      },
    });
    const app = buildApp({ kind: "memory" }, undefined, { ingest: deps });
    const handle = await run(input, app);
    await entered;
    await loomIngest(app.runtime).cancel(
      { tenantId: input.tenantId, userId: input.userId },
      input.documentId,
    );
    await vi.waitFor(() => expect(handle.getState().status).toBe("cancelled"));
    expect(aborted).toBe(true);
    expect(embedCalls).toBe(1); // a cancel is not retried
    expect(upsert).not.toHaveBeenCalled(); // and nothing was written
    expect(handle.getState().status).toBe("cancelled"); // not a failure
    await app.close();
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

describe("the step runner", () => {
  const second = { ...ingestParseStep, id: "ingest-second" };
  const sequence = async (first: StepResult) => {
    const ran: string[] = [];
    const ctx = {
      run: async (step: { id: string }) => {
        ran.push(step.id);
        return step.id === ingestParseStep.id ? first : { outcome: "done" as const };
      },
    };
    const out = await runIngestSteps([ingestParseStep, second])(ctx as never, ids());
    return { out, ran };
  };

  it.each([
    [{ outcome: "document_gone" as const }, { outcome: "document_gone" }],
    [
      { outcome: "failed" as const, code: "corrupt_content" as const },
      { outcome: "failed", code: "corrupt_content" },
    ],
  ])("returns early on %j without running a later step", async (first, expected) => {
    expect(await sequence(first)).toEqual({ out: expected, ran: ["ingest-parse"] });
  });

  it("runs every step when each is done", async () => {
    expect(await sequence({ outcome: "done" })).toEqual({
      out: { outcome: "done" },
      ran: ["ingest-parse", "ingest-second"],
    });
  });
});

describe("the parse step's failures and restarts", () => {
  it("declares the retry policy on the step and keeps it small", () => {
    expect(ingestParseStep.retry).toBe(STEP_RETRY);
    expect(STEP_RETRY.maxAttempts).toBe(3);
  });

  it("ends a deterministic crash after maxAttempts attempts and does not loop", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    const runner = {
      run: async () => {
        calls++;
        throw new ParseCrashedError();
      },
    };
    const app = buildApp({ kind: "memory" }, undefined, { ingest: fakeDeps({ runner }).deps });
    await expect((await run(ids(), app)).waitForCompletion()).rejects.toThrow(
      /ingest step failed: parse/,
    );
    expect(calls).toBe(STEP_RETRY.maxAttempts);
    await app.close();
  });

  it("recovers a transient crash within the attempts", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    const runner = {
      run: async () => {
        if (++calls < 2) throw new ParseCrashedError();
        return PARSED;
      },
    };
    expect(await outputOf(fakeDeps({ runner }).deps)).toEqual({ outcome: "done" });
    expect(calls).toBe(2);
  });

  it("a graceful restart mid-parse is not a failure and not an attempt: recovery re-runs the step to done", async () => {
    const eventStore = new InMemoryAsyncEventStore();
    // The log outlives the first app: app.close() would otherwise drop an in-memory store (a restart keeps it).
    const kept = new Proxy(eventStore, {
      get: (target, prop) => {
        if (prop === "close") return async () => {};
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const input = ids();
    const executionId = ingestExecutionId(input.userId, input.documentId);
    // A runner that, like ParseRunner.close(), aborts its in-flight parse with ParseAbortedError.
    let entered: () => void = () => {};
    const inParse = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let abortParse: () => void = () => {};
    let attempts = 0;
    const runner = {
      run: async () => {
        attempts++;
        entered();
        await new Promise<never>((_, reject) => {
          abortParse = () => reject(new ParseAbortedError());
        });
        return PARSED;
      },
      close: async () => abortParse(),
    };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const wiring = { shutdown: new AbortController(), runner } as unknown as IngestWiring;
    const first = buildApp({ kind: "custom", eventStore: kept }, undefined, {
      ingest: fakeDeps({ runner, shutdown: wiring.shutdown.signal }).deps,
    });
    await run(input, first);
    await inParse;
    await closeIngest(wiring); // the shutdown signal, then the runner aborts the parse; the execution's own signal is quiet
    // A failure would be journaled by now: let the rejection and the write-behind journal run.
    await new Promise((resolve) => setImmediate(resolve));
    await first.close();
    expect(attempts).toBe(1);
    expect(errors).not.toHaveBeenCalled();
    const types = (await eventStore.read(executionId)).map((e) => e.eventType);
    expect(types).toContain("STEP_STARTED");
    expect(types.filter((t) => /FAILED|COMPLETED|CANCELLED/.test(t))).toEqual([]);

    const second = buildApp({ kind: "custom", eventStore: kept }, undefined, {
      ingest: fakeDeps().deps,
    });
    const summary = await recoverAbandoned(second.runtime, {
      source: eventStore,
      isAbandoned: () => true,
    });
    expect(summary).toMatchObject({ recovered: 1, failed: 0 });
    const state = await second.runtime.loadState(executionId, {
      principal: { tenant: input.tenantId, actor: input.userId },
    });
    expect([state?.status, state?.variables._output]).toEqual(["completed", { outcome: "done" }]);
    await second.close();
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
