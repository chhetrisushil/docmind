import { randomUUID } from "node:crypto";
import type { Identity } from "@docmind/auth";
import { ExecutionDeniedError, type WorkflowRuntime } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { buildApp } from "../config";
import { DocumentGoneError } from "../flows/ingest-document/errors";
import { generationOf, ingestKeyOf, ingestScopeOf } from "../status/model";
import { ingestExecutionId, ingestStartInput, loomIngest } from "./ingest";

const identity = () => ({ tenantId: randomUUID(), userId: randomUUID() });
const appWith = (exists: () => Promise<boolean>) =>
  buildApp({ kind: "memory" }, undefined, {
    ingest: {
      guard: {
        begin: async () => {
          if (!(await exists())) throw new DocumentGoneError();
        },
      },
    },
  });

describe("ingest start input", () => {
  it("is exactly the three ids, validated, and names the execution without content", () => {
    const who = identity();
    const documentId = randomUUID();
    expect(ingestStartInput(who, documentId)).toEqual({ ...who, documentId });
    expect(ingestExecutionId(who.userId, documentId, 1)).toBe(
      `u_${who.userId}:ingest-${documentId}`,
    );
  });

  it("canonicalizes the document id to lower case and refuses a non-uuid", () => {
    const who = identity();
    const documentId = randomUUID();
    expect(ingestStartInput(who, documentId.toUpperCase()).documentId).toBe(documentId);
    expect(ingestExecutionId(who.userId, documentId.toUpperCase())).toBe(
      ingestExecutionId(who.userId, documentId),
    );
    expect(() => ingestStartInput(who, "tax-return.pdf")).toThrow();
  });
});

describe("loomIngest", () => {
  it("starts an execution once per document and reports the second start as already started", async () => {
    const app = appWith(async () => true);
    const port = loomIngest(app.runtime);
    const who = identity();
    const documentId = randomUUID();
    const handle = await port.start(who, documentId);
    expect(handle?.executionId).toBe(ingestExecutionId(who.userId, documentId));
    expect((await handle?.waitForCompletion())?.status).toBe("completed");
    expect(await port.start(who, documentId)).toBeNull();
    expect(await port.start(who, documentId.toUpperCase())).toBeNull(); // same document
    await app.close();
  });

  it("cancels a flow that is still running; the step in flight then finds nothing to do", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = appWith(async () => {
      await gate;
      return false; // the document was deleted meanwhile
    });
    const port = loomIngest(app.runtime);
    const who = identity();
    const documentId = randomUUID();
    const handle = await port.start(who, documentId);
    await port.cancel(who, documentId);
    release();
    await expect(handle?.waitForCompletion()).rejects.toThrow(/cancel/i);
    expect(handle?.getState().status).toBe("cancelled");
    await app.close();
  });

  it("treats cancel as idempotent: unknown, finished and repeated cancels all succeed", async () => {
    const app = appWith(async () => true);
    const port = loomIngest(app.runtime);
    const who = identity();
    await expect(port.cancel(who, randomUUID())).resolves.toBeUndefined(); // never started
    const documentId = randomUUID();
    await (await port.start(who, documentId))?.waitForCompletion();
    await expect(port.cancel(who, documentId)).resolves.toBeUndefined(); // already completed
    await expect(port.cancel(who, documentId)).resolves.toBeUndefined(); // and again
    await app.close();
  });

  it("does not let another actor or tenant cancel the execution", async () => {
    const app = appWith(async () => true);
    const port = loomIngest(app.runtime);
    const owner = identity();
    const documentId = randomUUID();
    const handle = await port.start(owner, documentId);
    // Waited out first: a denied cancel on a still-running execution races its journal (see report).
    await handle?.waitForCompletion();
    const id = ingestExecutionId(owner.userId, documentId);
    for (const principal of [
      { tenant: owner.tenantId, actor: randomUUID() },
      { tenant: randomUUID(), actor: owner.userId },
    ]) {
      await expect(app.runtime.cancel(id, "x", { principal })).rejects.toBeInstanceOf(
        ExecutionDeniedError,
      );
    }
    await app.close();
  });
});

const IDENTITY: Identity = identity();
const DOC = randomUUID();

/**
 * A runtime that records the ids it is asked to start and cancel. An id in `unknown` is answered the
 * way Loom answers an execution that never existed; `failWith` makes every cancel throw it.
 */
function fakeRuntime(opts: { unknown?: string[]; failWith?: Error } = {}) {
  const calls = { starts: [] as string[], cancels: [] as string[] };
  const runtime = {
    start: async (_flow: unknown, _input: unknown, o: { executionId: string }) => {
      calls.starts.push(o.executionId);
      return {} as never;
    },
    cancel: async (executionId: string) => {
      calls.cancels.push(executionId);
      if (opts.failWith) throw opts.failWith;
      if (opts.unknown?.includes(executionId)) {
        throw new Error(`No execution found for id: ${executionId}`);
      }
    },
  } as unknown as Pick<WorkflowRuntime, "start" | "cancel">;
  return { runtime, calls };
}

describe("execution id generations", () => {
  it("names generation 1 as the bare id, never .1, and later generations with a counter", () => {
    const [u, d] = [randomUUID(), randomUUID()];
    expect(ingestExecutionId(u, d, 1)).toBe(`u_${u}:ingest-${d}`);
    expect(ingestExecutionId(u, d)).toBe(`u_${u}:ingest-${d}.2`);
    expect(ingestExecutionId(u, d, 3)).toBe(`u_${u}:ingest-${d}.3`);
  });

  it("round-trips every emitted id through the status model's parser", () => {
    const [u, d] = [randomUUID(), randomUUID()];
    for (const generation of [1, 2, 3]) {
      const id = ingestExecutionId(u, d, generation);
      expect(ingestScopeOf(id)).toBe(u);
      expect(ingestKeyOf(id)).toBe(d);
      expect(generationOf(id)).toBe(generation);
    }
  });

  it("starts the current generation", async () => {
    const { runtime, calls } = fakeRuntime();
    await loomIngest(runtime).start(IDENTITY, DOC);
    expect(calls.starts).toEqual([ingestExecutionId(IDENTITY.userId, DOC)]);
  });

  it("cancels every generation, tolerating one that never existed, and still throws a real failure", async () => {
    const { runtime, calls } = fakeRuntime({
      unknown: [ingestExecutionId(IDENTITY.userId, DOC, 1)],
    });
    await loomIngest(runtime).cancel(IDENTITY, DOC);
    expect(calls.cancels).toEqual([
      ingestExecutionId(IDENTITY.userId, DOC, 1),
      ingestExecutionId(IDENTITY.userId, DOC, 2),
    ]);
    const boom = fakeRuntime({ failWith: new Error("storage down") });
    await expect(loomIngest(boom.runtime).cancel(IDENTITY, DOC)).rejects.toThrow(/^storage down$/);
    // a lookalike message for a different id is not "never started"
    const other = fakeRuntime({ failWith: new Error("No execution found for id: elsewhere") });
    await expect(loomIngest(other.runtime).cancel(IDENTITY, DOC)).rejects.toThrow(/elsewhere/);
  });
});
