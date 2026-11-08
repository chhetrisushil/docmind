import { randomUUID } from "node:crypto";
import { InMemoryReadModelStore } from "@loom/plugin-read-model";
import { ExecutionAlreadyExistsError, type WorkflowRuntime } from "@loom/workflow-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../config";
import { ingestExecutionId } from "../../documents/ingest";
import { InMemoryProgressBus } from "../../documents/progress";
import { IngestStatus } from "../../status/ingestStatus";
import { MemoryLog, evt } from "../../status/testing";
import { executionIdFor } from "../../subject";
import { visualizeDocumentFlow } from "./flow";
import type { ReadyDocument } from "./start";
import { SWEEP_EXECUTIONS, loomVisualsStarter, visualizeExecutionId } from "./start";

const ref = () => ({ tenantId: randomUUID(), userId: randomUUID(), documentId: randomUUID() });

afterEach(() => vi.restoreAllMocks());

describe("visualizeExecutionId", () => {
  it("is visualize-<doc> for generation 1 and visualize-<doc>.<gen> otherwise, under the user's prefix", () => {
    const r = ref();
    expect(visualizeExecutionId(r.userId, r.documentId, 1)).toBe(
      executionIdFor(r.userId, `visualize-${r.documentId}`),
    );
    expect(visualizeExecutionId(r.userId, r.documentId.toUpperCase(), 3)).toBe(
      `u_${r.userId}:visualize-${r.documentId}.3`,
    );
  });

  it("refuses a generation outside 1..999999999", () => {
    const r = ref();
    for (const g of [0, -1, 1.5, 1_000_000_000])
      expect(() => visualizeExecutionId(r.userId, r.documentId, g)).toThrow(RangeError);
  });
});

describe("the starter", () => {
  const flow = visualizeDocumentFlow();
  const fake = () => {
    const started = new Set<string>();
    const runtime = {
      start: vi.fn(async (_f: unknown, _i: unknown, o: { executionId: string }) => {
        if (started.has(o.executionId)) throw new ExecutionAlreadyExistsError(o.executionId);
        started.add(o.executionId);
        return { executionId: o.executionId } as never;
      }),
      cancel: vi.fn(async (_id: string, _reason: string, _o: unknown) => {}),
    };
    return {
      runtime: runtime as unknown as Pick<WorkflowRuntime, "start" | "cancel">,
      calls: runtime.start,
      cancel: runtime.cancel,
      started,
    };
  };

  it("starts once per (document, generation); a repeat is null, a new generation starts again", async () => {
    const { runtime, started } = fake();
    const starter = loomVisualsStarter(runtime, flow);
    const r = ref();
    expect(await starter.start(r, 2)).not.toBeNull();
    expect(await starter.start(r, 2)).toBeNull();
    expect(await starter.start(r, 3)).not.toBeNull();
    expect([...started]).toEqual([
      visualizeExecutionId(r.userId, r.documentId, 2),
      visualizeExecutionId(r.userId, r.documentId, 3),
    ]);
  });

  it("fire never throws: an already-started id is silent, any other failure goes to onError by itself", async () => {
    const f = fake();
    const errors: unknown[] = [];
    const starter = loomVisualsStarter(f.runtime, flow, { onError: (e) => errors.push(e) });
    const r = ref();
    starter.fire(r, 2);
    starter.fire(r, 2);
    await starter.idle();
    expect(errors).toEqual([]);
    expect(f.calls).toHaveBeenCalledTimes(2);
    f.calls.mockRejectedValueOnce(new RangeError("boom"));
    starter.fire(ref(), 2);
    await starter.idle();
    expect(errors).toHaveLength(1);
    starter.fire({ ...r, documentId: "not-a-uuid" }, 2); // malformed ref: reported, not thrown
    await starter.idle();
    expect(errors).toHaveLength(2);
  });

  it("starts nothing while disabled (the visuals role is off), sweep included", async () => {
    const f = fake();
    const ready = vi.fn(async () => [] as ReadyDocument[]);
    const starter = loomVisualsStarter(f.runtime, flow, { enabled: false, ready });
    expect(await starter.start(ref(), 2)).toBeNull();
    expect(await starter.sweep()).toBe(0);
    expect(f.calls).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
  });

  it("sweep fires every ready document, page by page, keyed by the last document id", async () => {
    const f = fake();
    const docs: ReadyDocument[] = Array.from({ length: 5 }, (_, i) => ({
      ...ref(),
      generation: i + 1,
    }));
    const ready = vi.fn(async (after: string, limit: number) => {
      const from =
        after === "00000000-0000-0000-0000-000000000000"
          ? 0
          : docs.findIndex((d) => d.documentId === after) + 1;
      return docs.slice(from, from + limit);
    });
    const starter = loomVisualsStarter(f.runtime, flow, { ready, pageSize: 2 });
    expect(await starter.sweep()).toBe(5);
    await starter.idle();
    expect(ready.mock.calls.map((c) => c[1])).toEqual([2, 2, 2]);
    expect(ready.mock.calls[1]?.[0]).toBe(docs[1]?.documentId);
    expect([...f.started]).toEqual(
      docs.map((d) => visualizeExecutionId(d.userId, d.documentId, d.generation)),
    );
    // A second sweep over the same list starts nothing new: Loom's start-once is the backstop.
    expect(await starter.sweep()).toBe(5);
    await starter.idle();
    expect(f.started.size).toBe(5);
  });

  it("sweep stops at an abort and never throws on a failing source (class only)", async () => {
    const f = fake();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const starter = loomVisualsStarter(f.runtime, flow, {
      ready: async () => {
        throw new RangeError("secret detail");
      },
    });
    expect(await starter.sweep()).toBe(0);
    expect(log).toHaveBeenCalledWith("visualize sweep failed", "RangeError");
    const aborted = new AbortController();
    aborted.abort();
    const never = vi.fn(async () => [] as ReadyDocument[]);
    expect(await loomVisualsStarter(f.runtime, flow, { ready: never }).sweep(aborted.signal)).toBe(
      0,
    );
    expect(never).not.toHaveBeenCalled();
  });

  it("cancel records the caller's reason", async () => {
    const f = fake();
    const r = ref();
    await loomVisualsStarter(f.runtime, flow).cancel(
      { tenantId: r.tenantId, userId: r.userId },
      r.documentId,
      1,
      "erased",
    );
    expect(f.cancel.mock.calls[0]?.[1]).toBe("erased");
  });

  it("settle waits for a fired start of that document only, so a cancel never runs before the start lands", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const runtime = {
      start: async (_f: unknown, _i: unknown, o: { executionId: string }) => {
        await gate;
        order.push("start");
        return { executionId: o.executionId } as never;
      },
      cancel: async () => void order.push("cancel"),
    } as unknown as Pick<WorkflowRuntime, "start" | "cancel">;
    const starter = loomVisualsStarter(runtime, flow);
    const r = ref();
    const other = ref();
    starter.fire(r, 2);
    const id = { tenantId: r.tenantId, userId: r.userId };
    let settledOther = false;
    await starter
      .settle({ tenantId: other.tenantId, userId: other.userId }, other.documentId)
      .then(() => {
        settledOther = true;
      });
    expect(settledOther).toBe(true); // unrelated document: no wait
    const done = starter
      .settle(id, r.documentId.toUpperCase())
      .then(() => starter.cancel(id, r.documentId, 2, "x"));
    release();
    await done;
    expect(order.slice(0, 2)).toEqual(["start", "cancel"]);
  });

  it("sweep keeps at most SWEEP_EXECUTIONS executions in flight, across pages", async () => {
    let live = 0;
    let peak = 0;
    const runtime = {
      start: async (_f: unknown, _i: unknown, o: { executionId: string }) => ({
        executionId: o.executionId,
        waitForCompletion: async () => {
          live++;
          peak = Math.max(peak, live);
          await new Promise((r) => setTimeout(r, 5));
          live--;
          return { status: "completed" };
        },
      }),
      cancel: async () => {},
    } as unknown as Pick<WorkflowRuntime, "start" | "cancel">;
    const docs: ReadyDocument[] = Array.from({ length: 7 }, () => ({ ...ref(), generation: 1 }));
    const ready = async (after: string, limit: number) => {
      const from =
        after === "00000000-0000-0000-0000-000000000000"
          ? 0
          : docs.findIndex((d) => d.documentId === after) + 1;
      return docs.slice(from, from + limit);
    };
    const fired = await loomVisualsStarter(runtime, flow, { ready, pageSize: 3 }).sweep();
    expect(fired).toBe(7);
    expect(peak).toBe(SWEEP_EXECUTIONS);
    expect(live).toBe(0); // the sweep resolves after every execution completed
  });

  it("a failed execution frees its sweep slot (class only)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = {
      start: async (_f: unknown, _i: unknown, o: { executionId: string }) => ({
        executionId: o.executionId,
        waitForCompletion: async () => {
          throw new RangeError("secret");
        },
      }),
      cancel: async () => {},
    } as unknown as Pick<WorkflowRuntime, "start" | "cancel">;
    const docs: ReadyDocument[] = Array.from({ length: 4 }, () => ({ ...ref(), generation: 1 }));
    const ready = async (after: string) =>
      after === "00000000-0000-0000-0000-000000000000" ? docs : [];
    expect(await loomVisualsStarter(runtime, flow, { ready }).sweep()).toBe(4);
    expect(log).toHaveBeenCalledWith("visualize execution failed", "RangeError");
  });

  it("cancel covers the generation and the one before it and tolerates 'No execution found'", async () => {
    const f = fake();
    f.cancel.mockImplementation(async (id: string) => {
      throw new Error(`No execution found for id: ${id}`);
    });
    const starter = loomVisualsStarter(f.runtime, flow);
    const r = ref();
    await starter.cancel({ tenantId: r.tenantId, userId: r.userId }, r.documentId, 4, "why");
    expect(f.cancel.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      visualizeExecutionId(r.userId, r.documentId, 3),
      visualizeExecutionId(r.userId, r.documentId, 4),
    ]);
    await starter.cancel({ tenantId: r.tenantId, userId: r.userId }, r.documentId, 1, "why");
    expect(f.cancel).toHaveBeenCalledTimes(3); // generation 1 has no earlier one
    f.cancel.mockRejectedValueOnce(new RangeError("db down"));
    await expect(
      starter.cancel({ tenantId: r.tenantId, userId: r.userId }, r.documentId, 2, "why"),
    ).rejects.toThrow(RangeError);
  });
});

describe("IngestStatus onReady starts the visualize flow", () => {
  const readyRun = (r: ReturnType<typeof ref>, generation: number) => {
    const id = ingestExecutionId(r.userId, r.documentId, generation);
    return [
      evt(id, 0, "EXECUTION_STARTED", { input: r }),
      evt(id, 1, "STEP_STARTED", { stepId: "ingest-finalize" }),
      evt(id, 2, "STEP_COMPLETED", { stepId: "ingest-finalize", output: { outcome: "done" } }),
    ];
  };
  function setup(over: { onReadyThrows?: boolean } = {}) {
    const app = buildApp({ kind: "memory" }, undefined, {});
    const flow = visualizeDocumentFlow();
    const starter = loomVisualsStarter(app.runtime, flow);
    const created: string[] = [];
    const starts: Promise<void>[] = [];
    const errors: unknown[] = [];
    const log = new MemoryLog();
    const status = new IngestStatus({
      writer: new InMemoryReadModelStore(),
      readerFor: () => new InMemoryReadModelStore(),
      source: log,
      sensitive: {},
      bus: new InMemoryProgressBus(),
      onError: (e) => errors.push(e),
      onReady: (r, g) => {
        if (over.onReadyThrows) throw new RangeError("hook failed");
        starts.push(starter.start(r, g).then((h) => void (h && created.push(h.executionId))));
      },
    });
    const feed = (...events: ReturnType<typeof readyRun>) => {
      for (const e of events) {
        log.append(e);
        status.onEvent(e);
      }
    };
    const settle = async () => {
      await status.close();
      await Promise.all(starts);
    };
    return { app, starter, status, feed, created, errors, settle };
  }

  it("fires once per (document, generation), however often the ready event is seen again", async () => {
    const s = setup();
    const r = ref();
    // Loom registers the flow only with deps; a plain start of an unregistered RegisteredFlow works by value.
    s.feed(...readyRun(r, 2));
    await s.settle();
    s.feed(
      ...readyRun(r, 2)
        .slice(2)
        .map((e, i) => ({ ...e, sequence: 3 + i, id: `${e.executionId}-r${i}` })),
    ); // a replayed finalize
    await s.settle();
    expect(s.created).toEqual([visualizeExecutionId(r.userId, r.documentId, 2)]);
    expect(s.errors).toEqual([]);
    // A document that turned ready again at a newer generation is a new execution.
    s.feed(...readyRun(r, 3));
    await s.settle();
    expect(s.created).toEqual([
      visualizeExecutionId(r.userId, r.documentId, 2),
      visualizeExecutionId(r.userId, r.documentId, 3),
    ]);
    await s.app.close();
  });

  it("never throws into onEvent: a failing hook or an unreadable log is reported", async () => {
    const hook = setup({ onReadyThrows: true });
    const r = ref();
    expect(() => hook.feed(...readyRun(r, 2))).not.toThrow();
    await hook.status.close();
    expect(hook.errors.some((e) => e instanceof RangeError)).toBe(true);
    await hook.app.close();
  });

  it("does not fire for a step that is not the finalize, nor for a visualize execution's events", async () => {
    const s = setup();
    const r = ref();
    const id = ingestExecutionId(r.userId, r.documentId, 2);
    s.feed(
      evt(id, 0, "EXECUTION_STARTED", { input: r }),
      evt(id, 1, "STEP_STARTED", { stepId: "ingest-parse" }),
    );
    const vid = visualizeExecutionId(r.userId, r.documentId, 2);
    s.status.onEvent(
      evt(vid, 0, "STEP_COMPLETED", { stepId: "visualize-commit", output: { outcome: "done" } }),
    );
    await s.settle();
    expect(s.created).toEqual([]);
    await s.app.close();
  });
});

describe("a start still pending when the cancel runs", () => {
  it("leaves no live execution: settle lets the start land, then the cancel ends it", async () => {
    const { InMemoryLineageStore, Lineage } = await import("@loom-ui/lineage");
    const { InMemoryContentStore } = await import("@loom/plugin-content");
    const hang = new Promise<never>(() => {});
    const flow = visualizeDocumentFlow();
    const app = buildApp({ kind: "memory" }, undefined, {
      visualize: {
        flow,
        deps: {
          guard: { begin: () => hang },
          chunks: { sectionsOf: async () => [], read: async () => [] },
          facts: { replace: async () => 0, list: async () => [] },
          summaryMaxChars: 400_000,
          bus: new InMemoryProgressBus(),
          lineage: new Lineage({
            events: new InMemoryLineageStore(),
            content: new InMemoryContentStore(),
          }),
          now: () => "2026-11-08T10:00:00.000Z",
        },
      },
    });
    const starter = loomVisualsStarter(app.runtime, flow);
    const r = ref();
    const id = { tenantId: r.tenantId, userId: r.userId };
    starter.fire(r, 2); // still pending: the cancel below would otherwise find no execution
    await starter.settle(id, r.documentId);
    await starter.cancel(id, r.documentId, 2, "document-deleted");
    const state = await app.runtime.loadState(visualizeExecutionId(r.userId, r.documentId, 2), {
      principal: { tenant: r.tenantId, actor: r.userId },
    });
    expect(state?.status).toBe("cancelled");
    await app.close();
  });
});
