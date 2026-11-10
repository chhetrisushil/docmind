import { randomUUID } from "node:crypto";
import type { Identity } from "@docmind/auth";
import { ExecutionDeniedError, type WorkflowRuntime } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { buildApp } from "../config";
import { FieldKeyStoreError } from "../crypto/fields";
import { DocumentGoneError } from "../flows/ingest-document/errors";
import { fakeIngestDeps } from "../flows/ingest-document/testing";
import { deterministicUser, legacyIngestId, testIdSource } from "../opaqueIds/testing";
import { generationOf, ingestKeyOf, ingestScopeOf } from "../status/model";
import type { ExecutionRecorder } from "./executionIds";
import { INGEST_GENERATION, ingestStartInput, loomIngest } from "./ingest";

const identity = () => ({ tenantId: randomUUID(), userId: randomUUID() });
const appWith = (exists: () => Promise<boolean>) =>
  buildApp({ kind: "memory" }, undefined, {
    ingest: fakeIngestDeps({
      guard: {
        begin: async () => {
          if (!(await exists())) throw new DocumentGoneError();
        },
      },
    }),
  });

describe("ingest start input", () => {
  it("is exactly the three ids, validated, and names the execution without content", () => {
    const who = identity();
    const documentId = randomUUID();
    expect(ingestStartInput(who, documentId)).toEqual({ ...who, documentId });
    expect(legacyIngestId(who.userId, documentId, 1)).toBe(`u_${who.userId}:ingest-${documentId}`);
  });

  it("canonicalizes the document id to lower case and refuses a non-uuid", () => {
    const who = identity();
    const documentId = randomUUID();
    expect(ingestStartInput(who, documentId.toUpperCase()).documentId).toBe(documentId);
    expect(legacyIngestId(who.userId, documentId.toUpperCase())).toBe(
      legacyIngestId(who.userId, documentId),
    );
    expect(() => ingestStartInput(who, "tax-return.pdf")).toThrow();
  });
});

describe("loomIngest", () => {
  it("starts an execution once per document and reports the second start as already started", async () => {
    const app = appWith(async () => true);
    const ids = testIdSource();
    const port = loomIngest(app.runtime, { ids });
    const who = identity();
    const documentId = randomUUID();
    const handle = await port.start(who, documentId, INGEST_GENERATION);
    expect(handle?.executionId).toBe(
      (await ids.ensureUser(who)).ingest(documentId, INGEST_GENERATION),
    );
    expect((await handle?.waitForCompletion())?.status).toBe("completed");
    expect(await port.start(who, documentId, INGEST_GENERATION)).toBeNull();
    expect(await port.start(who, documentId.toUpperCase(), INGEST_GENERATION)).toBeNull(); // same document
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
    const port = loomIngest(app.runtime, { ids: testIdSource() });
    const who = identity();
    const documentId = randomUUID();
    const handle = await port.start(who, documentId, INGEST_GENERATION);
    await port.cancel(who, documentId, INGEST_GENERATION);
    release();
    await expect(handle?.waitForCompletion()).rejects.toThrow(/cancel/i);
    expect(handle?.getState().status).toBe("cancelled");
    await app.close();
  });

  it("treats cancel as idempotent: unknown, finished and repeated cancels all succeed", async () => {
    const app = appWith(async () => true);
    const port = loomIngest(app.runtime, { ids: testIdSource() });
    const who = identity();
    await expect(port.cancel(who, randomUUID(), INGEST_GENERATION)).resolves.toBeUndefined(); // never started
    const documentId = randomUUID();
    await (await port.start(who, documentId, INGEST_GENERATION))?.waitForCompletion();
    await expect(port.cancel(who, documentId, INGEST_GENERATION)).resolves.toBeUndefined(); // already completed
    await expect(port.cancel(who, documentId, INGEST_GENERATION)).resolves.toBeUndefined(); // and again
    await app.close();
  });

  it("does not let another actor or tenant cancel the execution", async () => {
    const app = appWith(async () => true);
    const ids = testIdSource();
    const port = loomIngest(app.runtime, { ids });
    const owner = identity();
    const documentId = randomUUID();
    const handle = await port.start(owner, documentId, INGEST_GENERATION);
    // Waited out first: a denied cancel on a still-running execution races its journal (see report).
    await handle?.waitForCompletion();
    const id = (await ids.ensureUser(owner)).ingest(documentId, INGEST_GENERATION);
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

describe("loomIngest records the id", () => {
  const rec = (log: string[], fail = false): ExecutionRecorder => ({
    recordIngest: async (_who, _d, g, id) => {
      log.push(`record:${g}:${id}`);
      if (fail) throw new Error("record failed");
    },
    recordVisualize: async () => {},
  });

  it("records the id it starts BEFORE runtime.start", async () => {
    const log: string[] = [];
    const { runtime } = fakeRuntime();
    const spy = {
      start: async (...a: Parameters<typeof runtime.start>) => {
        log.push("start");
        return runtime.start(...a);
      },
      cancel: runtime.cancel,
    } as typeof runtime;
    await loomIngest(spy, { ids: testIdSource(), executions: rec(log) }).start(IDENTITY, DOC, 2);
    expect(log).toEqual([`record:2:${deterministicUser(IDENTITY.userId).ingest(DOC, 2)}`, "start"]);
  });

  it("a failed record stops the start", async () => {
    const { runtime, calls } = fakeRuntime();
    await expect(
      loomIngest(runtime, { ids: testIdSource(), executions: rec([], true) }).start(
        IDENTITY,
        DOC,
        2,
      ),
    ).rejects.toThrow("record failed");
    expect(calls.starts).toEqual([]);
  });
});

describe("execution id generations", () => {
  it("names generation 1 as the bare id, never .1, and later generations with a counter", () => {
    const [u, d] = [randomUUID(), randomUUID()];
    expect(legacyIngestId(u, d, 1)).toBe(`u_${u}:ingest-${d}`);
    expect(legacyIngestId(u, d)).toBe(`u_${u}:ingest-${d}.2`);
    expect(legacyIngestId(u, d, 3)).toBe(`u_${u}:ingest-${d}.3`);
  });

  it("round-trips every emitted id through the status model's parser", () => {
    const [u, d] = [randomUUID(), randomUUID()];
    for (const generation of [1, 2, 3]) {
      const id = legacyIngestId(u, d, generation);
      expect(ingestScopeOf(id)).toBe(u);
      expect(ingestKeyOf(id)).toBe(d);
      expect(generationOf(id)).toBe(generation);
    }
  });

  it("starts the current generation", async () => {
    const { runtime, calls } = fakeRuntime();
    await loomIngest(runtime, { ids: testIdSource() }).start(IDENTITY, DOC, INGEST_GENERATION);
    expect(calls.starts).toEqual([
      deterministicUser(IDENTITY.userId).ingest(DOC, INGEST_GENERATION),
    ]);
  });

  it("cancels the previous and current generation, tolerating one that never existed, and still throws a real failure", async () => {
    const { runtime, calls } = fakeRuntime({
      unknown: [legacyIngestId(IDENTITY.userId, DOC, 1)],
    });
    await loomIngest(runtime, { ids: testIdSource() }).cancel(IDENTITY, DOC, INGEST_GENERATION);
    expect(calls.cancels).toEqual([
      legacyIngestId(IDENTITY.userId, DOC, 1),
      legacyIngestId(IDENTITY.userId, DOC, 2),
    ]);
    const boom = fakeRuntime({ failWith: new Error("storage down") });
    await expect(
      loomIngest(boom.runtime, { ids: testIdSource() }).cancel(IDENTITY, DOC, INGEST_GENERATION),
    ).rejects.toThrow(/^storage down$/);
    // a lookalike message for a different id is not "never started"
    const other = fakeRuntime({ failWith: new Error("No execution found for id: elsewhere") });
    await expect(
      loomIngest(other.runtime, { ids: testIdSource() }).cancel(IDENTITY, DOC, INGEST_GENERATION),
    ).rejects.toThrow(/elsewhere/);
  });

  it("starts the execution of the generation it is given", async () => {
    const { runtime, calls } = fakeRuntime();
    await loomIngest(runtime, { ids: testIdSource() }).start(IDENTITY, DOC, 5);
    expect(calls.starts).toEqual([deterministicUser(IDENTITY.userId).ingest(DOC, 5)]);
  });

  it("cancels only the given generation and the one before it, ignoring one that never existed", async () => {
    const { runtime, calls } = fakeRuntime({
      unknown: [legacyIngestId(IDENTITY.userId, DOC, 3)],
    });
    await loomIngest(runtime, { ids: testIdSource() }).cancel(IDENTITY, DOC, 4);
    expect(calls.cancels).toEqual([3, 4].map((g) => legacyIngestId(IDENTITY.userId, DOC, g)));
  });

  it("refuses a generation that is not an integer from 1 to 999999999", async () => {
    const port = loomIngest(fakeRuntime().runtime, { ids: testIdSource() });
    for (const g of [0, 1.5, 1_000_000_000, Number.NaN]) {
      await expect(port.start(IDENTITY, DOC, g)).rejects.toThrow(
        /^generation must be an integer from 1 to 999999999$/,
      );
      await expect(port.cancel(IDENTITY, DOC, g)).rejects.toThrow(
        /^generation must be an integer from 1 to 999999999$/,
      );
    }
  });
});

describe("loomIngest across the two id formats", () => {
  it("records the id on the document BEFORE the start, so a crash in between leaves an id the sweep re-starts", async () => {
    const order: string[] = [];
    const runtime = {
      start: async (_f: unknown, _i: unknown, o: { executionId: string }) => {
        order.push(`start:${o.executionId}`);
        return {} as never;
      },
      cancel: async () => {},
    } as unknown as Pick<WorkflowRuntime, "start" | "cancel">;
    const ids = testIdSource();
    const executions = {
      recordIngest: async (_w: unknown, d: string, g: number, id: string) => {
        order.push(`record:${d}:${g}:${id}`);
      },
      recordVisualize: async () => {},
    };
    await loomIngest(runtime, { ids, executions }).start(IDENTITY, DOC, 3);
    const id = (await ids.ensureUser(IDENTITY)).ingest(DOC, 3);
    expect(order).toEqual([`record:${DOC}:3:${id}`, `start:${id}`]);
  });

  it("a key-store outage fails the start before Loom sees it, and never falls back to an id with the plain UUIDs", async () => {
    const { runtime, calls } = fakeRuntime();
    const ids = {
      ensureUser: async () => {
        throw new FieldKeyStoreError();
      },
      load: async () => false,
      cached: () => undefined,
    };
    await expect(loomIngest(runtime, { ids }).start(IDENTITY, DOC, 2)).rejects.toBeInstanceOf(
      FieldKeyStoreError,
    );
    expect(calls.starts).toEqual([]);
  });

  it("cancel tries the old and the new id of each generation when the user has a handle, old first", async () => {
    const ids = testIdSource();
    const user = await ids.ensureUser(IDENTITY);
    const { runtime, calls } = fakeRuntime({
      unknown: [legacyIngestId(IDENTITY.userId, DOC, 3), user.ingest(DOC, 4)],
    });
    await loomIngest(runtime, { ids }).cancel(IDENTITY, DOC, 4);
    expect(calls.cancels).toEqual([
      legacyIngestId(IDENTITY.userId, DOC, 3),
      user.ingest(DOC, 3),
      legacyIngestId(IDENTITY.userId, DOC, 4),
      user.ingest(DOC, 4),
    ]);
  });

  it("cancel never creates a key or a handle for a user who has none", async () => {
    const ids = testIdSource();
    const { runtime, calls } = fakeRuntime();
    await loomIngest(runtime, { ids }).cancel(IDENTITY, DOC, 2);
    expect(calls.cancels).toEqual([1, 2].map((g) => legacyIngestId(IDENTITY.userId, DOC, g)));
    expect(ids.cached(IDENTITY.userId)).toBeUndefined();
  });
});
