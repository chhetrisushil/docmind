import { randomUUID } from "node:crypto";
import { LineErasedError } from "@loom-ui/lineage";
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
import {
  SWEEP_EXECUTIONS,
  hasVisualsHead,
  loomVisualsStarter,
  visualizeExecutionId,
} from "./start";

/** One shared wait per execution, like Loom's handle: asking again for the completion is the same wait. */
const once = <T>(make: () => Promise<T>): (() => Promise<T>) => {
  let wait: Promise<T> | undefined;
  return () => {
    wait ??= make();
    return wait;
  };
};

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
    expect(log).toHaveBeenCalledWith("visuals ready pass failed", "RangeError");
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
      start: async (_f: unknown, _i: unknown, o: { executionId: string }) => {
        return {
          executionId: o.executionId,
          waitForCompletion: once(async () => {
            live++;
            peak = Math.max(peak, live);
            await new Promise((r) => setTimeout(r, 5));
            live--;
            return { status: "completed" };
          }),
        };
      },
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

describe("visualizeExecutionId re-runs", () => {
  it("adds -r<n> after the generation suffix, under the user's prefix", () => {
    const r = ref();
    expect(visualizeExecutionId(r.userId, r.documentId, 1, 2)).toBe(
      `u_${r.userId}:visualize-${r.documentId}-r2`,
    );
    expect(visualizeExecutionId(r.userId, r.documentId.toUpperCase(), 3, 999)).toBe(
      `u_${r.userId}:visualize-${r.documentId}.3-r999`,
    );
  });

  it("refuses a re-run outside 1..999", () => {
    const r = ref();
    for (const n of [0, -1, 1.5, 1000])
      expect(() => visualizeExecutionId(r.userId, r.documentId, 1, n)).toThrow(RangeError);
  });
});

describe("rerun and the retry sweep", () => {
  const flow = visualizeDocumentFlow();
  /** A runtime that starts each id once; `waitForCompletion` settles when `finish(id)` is called. */
  const fake = () => {
    const started: string[] = [];
    const finishers = new Map<string, () => void>();
    const runtime = {
      start: vi.fn(async (_f: unknown, _i: unknown, o: { executionId: string }) => {
        if (started.includes(o.executionId)) throw new ExecutionAlreadyExistsError(o.executionId);
        started.push(o.executionId);
        const done = new Promise<void>((resolve) => finishers.set(o.executionId, resolve));
        return { executionId: o.executionId, waitForCompletion: () => done } as never;
      }),
      cancel: vi.fn(async (_id: string, _reason: string, _o: unknown) => {}),
    };
    return {
      runtime: runtime as unknown as Pick<WorkflowRuntime, "start" | "cancel">,
      started,
      cancel: runtime.cancel,
      finish: (id: string) => finishers.get(id)?.(),
    };
  };
  const runsStore = (last: { run: number; state: string; code: string | null } | null = null) => ({
    record: vi.fn(async () => {}),
    last: vi.fn(async () => last as never),
  });

  it("starts the next free -r<n>: ids Loom already has are skipped, and the run is recorded as running", async () => {
    const f = fake();
    const runs = runsStore();
    const starter = loomVisualsStarter(f.runtime, flow, { runs });
    const r = ref();
    f.started.push(
      visualizeExecutionId(r.userId, r.documentId, 2, 1),
      visualizeExecutionId(r.userId, r.documentId, 2, 2),
    ); // two earlier re-runs (a restart forgot them)
    expect(await starter.rerun(r, 2)).toEqual({ kind: "started", rerun: 3 });
    expect(f.started.at(-1)).toBe(visualizeExecutionId(r.userId, r.documentId, 2, 3));
    expect(runs.record).toHaveBeenCalledWith(
      { userId: r.userId, documentId: r.documentId, generation: 2, run: 3 },
      "running",
    );
  });

  it("answers running while a run of the document is in flight (the automatic run included), then starts again once it ends", async () => {
    const f = fake();
    const starter = loomVisualsStarter(f.runtime, flow);
    const r = ref();
    await starter.start(r, 1); // the automatic run
    expect(starter.running(r, 1)).toBe(true);
    expect(await starter.rerun(r, 1)).toEqual({ kind: "running" });
    f.finish(visualizeExecutionId(r.userId, r.documentId, 1));
    await vi.waitFor(() => expect(starter.running(r, 1)).toBe(false));
    expect(await starter.rerun(r, 1)).toEqual({ kind: "started", rerun: 1 });
    expect(await starter.rerun(r, 1)).toEqual({ kind: "running" });
    f.finish(visualizeExecutionId(r.userId, r.documentId, 1, 1));
    await vi.waitFor(() => expect(starter.running(r, 1)).toBe(false));
    expect(await starter.rerun(r, 1)).toEqual({ kind: "started", rerun: 2 }); // this process remembers its last number
  });

  it("answers running when the table records a run as running (a run recovered after a restart)", async () => {
    const f = fake();
    const starter = loomVisualsStarter(f.runtime, flow, {
      runs: runsStore({ run: 1, state: "running", code: null }),
    });
    expect(await starter.rerun(ref(), 1)).toEqual({ kind: "running" });
    expect(f.started).toEqual([]);
  });

  it("answers disabled while the role is off and starts nothing", async () => {
    const f = fake();
    const starter = loomVisualsStarter(f.runtime, flow, { enabled: false });
    expect(await starter.rerun(ref(), 1)).toEqual({ kind: "disabled" });
    expect(f.started).toEqual([]);
  });

  it("answers running (never throws) when every number is taken", async () => {
    const runtime = {
      start: async (_f: unknown, _i: unknown, o: { executionId: string }) => {
        throw new ExecutionAlreadyExistsError(o.executionId);
      },
      cancel: async () => {},
    } as unknown as Pick<WorkflowRuntime, "start" | "cancel">;
    expect(await loomVisualsStarter(runtime, flow).rerun(ref(), 1)).toEqual({ kind: "running" });
  });

  it("any other start failure is thrown to the caller", async () => {
    const runtime = {
      start: async () => {
        throw new RangeError("down");
      },
      cancel: async () => {},
    } as unknown as Pick<WorkflowRuntime, "start" | "cancel">;
    await expect(loomVisualsStarter(runtime, flow).rerun(ref(), 1)).rejects.toThrow(RangeError);
  });

  it("cancel also cancels the re-runs up to the highest one the table recorded", async () => {
    const f = fake();
    const starter = loomVisualsStarter(f.runtime, flow, {
      runs: runsStore({ run: 2, state: "failed", code: "visuals-model-unavailable" }),
    });
    const r = ref();
    await starter.cancel({ tenantId: r.tenantId, userId: r.userId }, r.documentId, 1, "why");
    expect(f.cancel.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      visualizeExecutionId(r.userId, r.documentId, 1),
      visualizeExecutionId(r.userId, r.documentId, 1, 1),
      visualizeExecutionId(r.userId, r.documentId, 1, 2),
    ]);
  });

  it("the sweep, after the unvisualized documents, re-runs each retry document once, under the same two-slot bound", async () => {
    const f = fake();
    let live = 0;
    let peak = 0;
    const base = f.runtime.start;
    const runtime = {
      cancel: f.cancel,
      start: async (...a: Parameters<typeof base>) => {
        const handle = (await base(...a)) as unknown as { waitForCompletion(): Promise<void> };
        return {
          ...handle,
          waitForCompletion: once(async () => {
            live++;
            peak = Math.max(peak, live);
            await new Promise((r) => setTimeout(r, 5));
            live--;
          }),
        } as never;
      },
    } as unknown as Pick<WorkflowRuntime, "start" | "cancel">;
    const fresh = ref();
    const retry: ReadyDocument[] = Array.from({ length: 5 }, () => ({ ...ref(), generation: 2 }));
    const page = (docs: ReadyDocument[]) => async (after: string, limit: number) => {
      const from =
        after === "00000000-0000-0000-0000-000000000000"
          ? 0
          : docs.findIndex((d) => d.documentId === after) + 1;
      return docs.slice(from, from + limit);
    };
    const runs = runsStore();
    const starter = loomVisualsStarter(runtime, flow, {
      ready: page([{ ...fresh, generation: 1 }]),
      retry: page(retry),
      runs,
      pageSize: 2,
    });
    expect(await starter.sweep()).toBe(6);
    expect(f.started[0]).toBe(visualizeExecutionId(fresh.userId, fresh.documentId, 1));
    expect(f.started.slice(1)).toEqual(
      retry.map((d) => visualizeExecutionId(d.userId, d.documentId, 2, 1)),
    );
    expect(peak).toBeLessThanOrEqual(SWEEP_EXECUTIONS);
    expect(live).toBe(0);
    // Once per sweep: the same documents in a second sweep (a new boot) are re-run again with the next number, not twice in one.
    expect(await starter.sweep()).toBe(6);
    expect(f.started.filter((id) => id.endsWith("-r2"))).toHaveLength(5);
  });

  it("the sweep leaves a retry document alone while a run of it is recorded as running, and does nothing while disabled", async () => {
    const f = fake();
    const doc: ReadyDocument = { ...ref(), generation: 1 };
    const one = async (after: string) =>
      after === "00000000-0000-0000-0000-000000000000" ? [doc] : [];
    const busy = loomVisualsStarter(f.runtime, flow, {
      retry: one,
      runs: runsStore({ run: 1, state: "running", code: null }),
    });
    expect(await busy.sweep()).toBe(1); // fired, but the re-run found it running and started nothing
    expect(f.started).toEqual([]);
    const off = loomVisualsStarter(f.runtime, flow, { retry: one, enabled: false });
    expect(await off.sweep()).toBe(0);
    expect(f.started).toEqual([]);
  });
});

describe("the stale-format boot pass", () => {
  const flow = visualizeDocumentFlow();
  const NIL = "00000000-0000-0000-0000-000000000000";
  const mk = (): ReadyDocument => ({
    tenantId: randomUUID(),
    userId: randomUUID(),
    documentId: randomUUID(),
    generation: 1,
  });
  const page = (docs: ReadyDocument[]) => async (after: string, limit: number) => {
    const from = after === NIL ? 0 : docs.findIndex((d) => d.documentId === after) + 1;
    return docs.slice(from, from + limit);
  };
  const setup = () => {
    const started: string[] = [];
    let live = 0;
    let peak = 0;
    const runtime = {
      cancel: vi.fn(),
      start: vi.fn(async (_f: unknown, _i: unknown, o: { executionId: string }) => {
        started.push(o.executionId);
        return {
          executionId: o.executionId,
          waitForCompletion: once(async () => {
            live++;
            peak = Math.max(peak, live);
            await new Promise((r) => setTimeout(r, 5));
            live--;
          }),
        } as never;
      }),
    } as unknown as Pick<WorkflowRuntime, "start" | "cancel">;
    const runs = { record: vi.fn(async () => {}), last: vi.fn(async () => null as never) };
    return { started, runtime, runs, peak: () => peak };
  };

  it("re-runs each stale-format document once (gate-bounded, through the re-run lock), recorded as running", async () => {
    const s = setup();
    const docs = Array.from({ length: 5 }, mk);
    const starter = loomVisualsStarter(s.runtime, flow, {
      stale: page(docs),
      runs: s.runs,
      pageSize: 2,
    });
    expect(await starter.sweep()).toBe(5);
    expect(s.started).toEqual(docs.map((d) => visualizeExecutionId(d.userId, d.documentId, 1, 1)));
    expect(s.peak()).toBeLessThanOrEqual(SWEEP_EXECUTIONS);
    expect(s.runs.record).toHaveBeenCalledTimes(5);
  });

  it("does not start a document whose run is still going (the shared lock/tracker), and nothing while the role is off or without a source", async () => {
    const s = setup();
    const doc = mk();
    const busy = loomVisualsStarter(s.runtime, flow, {
      stale: page([doc]),
      runs: {
        record: s.runs.record,
        last: vi.fn(async () => ({ run: 1, state: "running", code: null }) as never),
      },
    });
    expect(await busy.sweep()).toBe(1);
    expect(s.started).toEqual([]);
    const off = loomVisualsStarter(s.runtime, flow, { stale: page([doc]), enabled: false });
    expect(await off.sweep()).toBe(0);
    expect(await loomVisualsStarter(s.runtime, flow, {}).sweep()).toBe(0);
    expect(s.started).toEqual([]);
  });

  it("a failing stale source is logged by class and does not undo the other passes", async () => {
    const s = setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const fresh = mk();
    const starter = loomVisualsStarter(s.runtime, flow, {
      ready: page([fresh]),
      stale: async () => {
        throw new RangeError("down");
      },
      runs: s.runs,
    });
    await expect(starter.sweep()).resolves.toBe(1);
    expect(s.started).toEqual([visualizeExecutionId(fresh.userId, fresh.documentId, 1)]);
    expect(log).toHaveBeenCalledWith("visuals stale-format pass failed", "RangeError");
    log.mockRestore();
  });

  it("a failing ready source still runs the retry and stale passes, and a failing retry source still runs the stale pass", async () => {
    const s = setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = async () => {
      throw new RangeError("down");
    };
    const retryDoc = mk();
    const staleDoc = mk();
    const a = loomVisualsStarter(s.runtime, flow, {
      ready: boom,
      retry: page([retryDoc]),
      stale: page([staleDoc]),
      runs: s.runs,
    });
    await expect(a.sweep()).resolves.toBe(2);
    expect(s.started).toEqual([
      visualizeExecutionId(retryDoc.userId, retryDoc.documentId, 1, 1),
      visualizeExecutionId(staleDoc.userId, staleDoc.documentId, 1, 1),
    ]);
    s.started.length = 0;
    const b = loomVisualsStarter(s.runtime, flow, {
      retry: boom,
      stale: page([staleDoc]),
      runs: s.runs,
    });
    await expect(b.sweep()).resolves.toBe(1);
    expect(s.started).toEqual([visualizeExecutionId(staleDoc.userId, staleDoc.documentId, 1, 1)]);
    expect(log).toHaveBeenCalledWith("visuals ready pass failed", "RangeError");
    expect(log).toHaveBeenCalledWith("visuals retry pass failed", "RangeError");
    log.mockRestore();
  });

  it("a failing earlier source does not stop the stale pass either", async () => {
    const s = setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const doc = mk();
    const starter = loomVisualsStarter(s.runtime, flow, {
      running: async () => {
        throw new Error("x");
      },
      stale: page([doc]),
      runs: s.runs,
    });
    await expect(starter.sweep()).resolves.toBe(1);
    expect(s.started).toEqual([visualizeExecutionId(doc.userId, doc.documentId, 1, 1)]);
    log.mockRestore();
  });
});

describe("the unrecorded-documents boot pass (documents visualized before visual_runs existed)", () => {
  const flow = visualizeDocumentFlow();
  const NIL = "00000000-0000-0000-0000-000000000000";
  const mk = (): ReadyDocument => ({
    tenantId: randomUUID(),
    userId: randomUUID(),
    documentId: randomUUID(),
    generation: 1,
  });
  const page = (docs: ReadyDocument[]) => async (after: string, limit: number) => {
    const from = after === NIL ? 0 : docs.findIndex((d) => d.documentId === after) + 1;
    return docs.slice(from, from + limit);
  };
  const setup = () => {
    const started: string[] = [];
    const states = new Map<string, unknown>();
    const runtime = {
      cancel: vi.fn(),
      loadState: vi.fn(async (id: string) => states.get(id) ?? null),
      start: vi.fn(async (_f: unknown, _i: unknown, o: { executionId: string }) => {
        started.push(o.executionId);
        return { executionId: o.executionId, waitForCompletion: async () => {} } as never;
      }),
    } as unknown as Pick<WorkflowRuntime, "start" | "cancel" | "loadState">;
    const rows = new Map<string, { run: number; state: string; code: null }>();
    const runs = {
      record: vi.fn(async (r: { documentId: string; run: number }, state: string) => {
        rows.set(r.documentId, { run: r.run, state, code: null });
      }),
      last: vi.fn(
        async (_i: unknown, documentId: string) => (rows.get(documentId) ?? null) as never,
      ),
    };
    return { started, runtime, runs, states, rows };
  };

  it("re-runs a headed document once, noting it so the extract step never extracts; leaves a head-less one alone", async () => {
    const s = setup();
    const headed = mk();
    const bare = mk();
    const afterDone = new Set<string>();
    const starter = loomVisualsStarter(s.runtime, flow, {
      unrecorded: page([headed, bare]),
      visualized: async (d) => d.documentId === headed.documentId,
      runs: s.runs,
      afterDone,
    });
    expect(await starter.sweep()).toBe(1);
    const id = visualizeExecutionId(headed.userId, headed.documentId, 1, 1);
    expect(s.started).toEqual([id]);
    expect(afterDone.has(id)).toBe(true);
    expect(s.runs.record).toHaveBeenCalledTimes(1);
  });

  it("a recorded row stops a repeat on the next sweep (the source no longer lists it; the run lock sees a running row)", async () => {
    const s = setup();
    const doc = mk();
    let listed = true;
    const starter = loomVisualsStarter(s.runtime, flow, {
      unrecorded: async (after, limit) => (listed ? page([doc])(after, limit) : []),
      visualized: async () => true,
      runs: s.runs,
    });
    await starter.sweep();
    listed = false; // the row now exists
    await starter.sweep();
    expect(s.started).toHaveLength(1);
  });

  it("does nothing without a head source, while the role is off, and logs a failing head check by class without stopping the pass", async () => {
    const s = setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const [bad, good] = [mk(), mk()];
    expect(
      await loomVisualsStarter(s.runtime, flow, { unrecorded: page([bad]), runs: s.runs }).sweep(),
    ).toBe(0);
    expect(
      await loomVisualsStarter(s.runtime, flow, {
        unrecorded: page([bad]),
        visualized: async () => true,
        enabled: false,
      }).sweep(),
    ).toBe(0);
    const starter = loomVisualsStarter(s.runtime, flow, {
      unrecorded: page([bad, good]),
      visualized: async (d) => {
        if (d.documentId === bad.documentId) throw new RangeError("unreadable");
        return true;
      },
      runs: s.runs,
    });
    expect(await starter.sweep()).toBe(1);
    expect(s.started).toEqual([visualizeExecutionId(good.userId, good.documentId, 1, 1)]);
    expect(log).toHaveBeenCalledWith("visuals head check failed", "RangeError");
    log.mockRestore();
  });

  it("a document with no head gets its run-0 outcome recorded from Loom's state, so it is neither listed nor read again", async () => {
    const s = setup();
    const bare = mk();
    s.states.set(visualizeExecutionId(bare.userId, bare.documentId, 1), {
      status: "completed",
      variables: { _output: { outcome: "empty" } },
    });
    const visualized = vi.fn(async () => false);
    const starter = loomVisualsStarter(s.runtime, flow, {
      // The real definer stops listing a document once it has a row.
      unrecorded: async (after, limit) =>
        s.rows.has(bare.documentId) ? [] : page([bare])(after, limit),
      visualized,
      runs: s.runs,
    });
    expect(await starter.sweep()).toBe(0);
    expect(s.runs.record).toHaveBeenCalledWith(
      { userId: bare.userId, documentId: bare.documentId, generation: 1, run: 0 },
      "empty",
      undefined,
    );
    expect(await starter.sweep()).toBe(0);
    expect(visualized).toHaveBeenCalledTimes(1);
    expect(s.started).toEqual([]);
  });

  it("records nothing for a head-less document whose execution is unreadable or not terminal (class logged), and continues", async () => {
    const s = setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const [running, gone, ok] = [mk(), mk(), mk()];
    s.states.set(visualizeExecutionId(running.userId, running.documentId, 1), {
      status: "running",
    });
    s.runtime.loadState = vi.fn(async (id: string) => {
      if (id === visualizeExecutionId(gone.userId, gone.documentId, 1))
        throw new RangeError("down");
      return (s.states.get(id) ?? null) as never;
    }) as never;
    const starter = loomVisualsStarter(s.runtime, flow, {
      unrecorded: page([running, gone, ok]),
      visualized: async () => false,
      runs: s.runs,
    });
    expect(await starter.sweep()).toBe(0);
    expect(s.runs.record).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("visuals unvisualized record failed", "RangeError");
    log.mockRestore();
  });

  it("a failing source is logged by class and does not undo the earlier passes", async () => {
    const s = setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const fresh = mk();
    const starter = loomVisualsStarter(s.runtime, flow, {
      ready: page([fresh]),
      unrecorded: async () => {
        throw new RangeError("down");
      },
      visualized: async () => true,
      runs: s.runs,
    });
    expect(await starter.sweep()).toBe(1);
    expect(log).toHaveBeenCalledWith("visuals unrecorded pass failed", "RangeError");
    log.mockRestore();
  });
});

describe("hasVisualsHead", () => {
  const r = ref();
  const lineage = (result: unknown, throws?: Error) =>
    ({
      head: async () => {
        if (throws) throw throws;
        return result;
      },
    }) as never;
  it("is true for a head, false for none and for an erased line (refusal or error)", async () => {
    expect(await hasVisualsHead(lineage({ ok: true, value: "x" }))(r)).toBe(true);
    expect(await hasVisualsHead(lineage({ ok: true, value: null }))(r)).toBe(false);
    expect(
      await hasVisualsHead(
        lineage({ ok: false, refusal: { kind: "refused", finding: { code: "line-erased" } } }),
      )(r),
    ).toBe(false);
    expect(await hasVisualsHead(lineage(null, new LineErasedError("e")))(r)).toBe(false);
  });
  it("throws (class only) on any other refusal or error", async () => {
    await expect(
      hasVisualsHead(
        lineage({ ok: false, refusal: { kind: "refused", finding: { code: "line-unreadable" } } }),
      )(r),
    ).rejects.toMatchObject({ name: "LineageRefusedError" });
    await expect(
      hasVisualsHead(lineage({ ok: false, refusal: { kind: "head-moved" } }))(r),
    ).rejects.toThrow();
    await expect(hasVisualsHead(lineage(null, new RangeError("x")))(r)).rejects.toThrow(RangeError);
  });
});

describe("rerun: concurrency, numbering and settle", () => {
  const flow = visualizeDocumentFlow();
  const base = () => {
    const started: string[] = [];
    const gate = { release: () => {}, wait: Promise.resolve() as Promise<void> };
    const runtime = {
      start: vi.fn(async (_f: unknown, _i: unknown, o: { executionId: string }) => {
        await gate.wait;
        if (started.includes(o.executionId)) throw new ExecutionAlreadyExistsError(o.executionId);
        started.push(o.executionId);
        return {
          executionId: o.executionId,
          waitForCompletion: () => new Promise(() => {}),
        } as never;
      }),
      cancel: vi.fn(async () => {}),
    };
    return { runtime, started, gate };
  };
  const runsStore = (last: { run: number; state: string; code: string | null } | null = null) => ({
    record: vi.fn(async () => {}),
    last: vi.fn(async () => last as never),
  });

  it("two concurrent retries start exactly one run; the other answers running", async () => {
    const f = base();
    const starter = loomVisualsStarter(f.runtime as never, flow, { runs: runsStore() });
    const r = ref();
    const answers = await Promise.all([starter.rerun(r, 1), starter.rerun(r, 1)]);
    expect(answers.map((a) => a.kind).sort()).toEqual(["running", "started"]);
    expect(f.started).toHaveLength(1);
  });

  it("a taken id found while another request started a run ends in running, not a second run", async () => {
    const f = base();
    const r = ref();
    // Loom has -r1 already (started by another path), and this process tracks a run of the document: no probing on.
    f.started.push(visualizeExecutionId(r.userId, r.documentId, 1, 1));
    const starter = loomVisualsStarter(f.runtime as never, flow);
    await starter.start(r, 1); // the automatic run is in flight
    expect(await starter.rerun(r, 1)).toEqual({ kind: "running" });
    expect(f.started).toHaveLength(2);
  });

  it("numbers from the table's last run, with no probing of the numbers below it", async () => {
    const f = base();
    const starter = loomVisualsStarter(f.runtime as never, flow, {
      runs: runsStore({ run: 5, state: "failed", code: "visuals-plan-invalid" }),
    });
    const r = ref();
    expect(await starter.rerun(r, 1)).toEqual({ kind: "started", rerun: 6 });
    expect(f.runtime.start).toHaveBeenCalledTimes(1);
  });

  it("records every start as running, the automatic run (run 0) included", async () => {
    const f = base();
    const runs = runsStore();
    const starter = loomVisualsStarter(f.runtime as never, flow, { runs });
    const r = ref();
    await starter.start(r, 2);
    expect(runs.record).toHaveBeenCalledWith(
      { userId: r.userId, documentId: r.documentId, generation: 2, run: 0 },
      "running",
    );
  });

  it("settle waits for a route's re-run, so a delete cancels the run it started", async () => {
    const f = base();
    let release: () => void = () => {};
    f.gate.wait = new Promise<void>((r) => {
      release = r;
    });
    const starter = loomVisualsStarter(f.runtime as never, flow);
    const r = ref();
    const answer = starter.rerun(r, 1);
    let settled = false;
    const done = starter
      .settle({ tenantId: r.tenantId, userId: r.userId }, r.documentId)
      .then(() => {
        settled = true;
      });
    await new Promise((x) => setTimeout(x, 10));
    expect(settled).toBe(false);
    release();
    await done;
    expect(await answer).toEqual({ kind: "started", rerun: 1 });
    expect(f.started).toHaveLength(1);
  });
});

describe("a lost end event never leaves a run stuck at running", () => {
  const flow = visualizeDocumentFlow();
  const runningRow = { run: 1, state: "running" as const, code: null };
  const setup = (loadState?: (id: string) => Promise<unknown>) => {
    const started: string[] = [];
    const runtime = {
      start: vi.fn(async (_f: unknown, _i: unknown, o: { executionId: string }) => {
        started.push(o.executionId);
        return {
          executionId: o.executionId,
          waitForCompletion: () => new Promise(() => {}),
        } as never;
      }),
      cancel: vi.fn(async () => {}),
      ...(loadState && { loadState: vi.fn(loadState) }),
    };
    const record = vi.fn(async () => {});
    const runs = { record, last: vi.fn(async () => runningRow as never) };
    return { runtime, started, record, runs };
  };
  const completed = (output: unknown) => async () => ({
    status: "completed",
    variables: { _output: output },
  });

  it("rerun repairs the row from the execution's output and then starts the next run", async () => {
    const s = setup(completed({ outcome: "failed", code: "visuals-model-unavailable" }));
    const starter = loomVisualsStarter(s.runtime as never, flow, { runs: s.runs });
    const r = ref();
    expect(await starter.rerun(r, 1)).toEqual({ kind: "started", rerun: 2 });
    expect(s.runtime.loadState).toHaveBeenCalledWith(
      visualizeExecutionId(r.userId, r.documentId, 1, 1),
      expect.anything(),
    );
    expect(s.record).toHaveBeenCalledWith(
      { userId: r.userId, documentId: r.documentId, generation: 1, run: 1 },
      "failed",
      "visuals-model-unavailable",
    );
  });

  it("a failed or cancelled execution is repaired as failed/internal; an output outside the schema too", async () => {
    for (const load of [
      async () => ({ status: "failed", variables: {} }),
      async () => ({ status: "cancelled", variables: {} }),
      completed({ outcome: "done", extra: "x" }),
    ]) {
      const s = setup(load);
      const starter = loomVisualsStarter(s.runtime as never, flow, { runs: s.runs });
      const r = ref();
      const fixed = await starter.reconcile(r, 1, runningRow);
      expect(fixed).toEqual({ run: 1, state: "failed", code: "internal" });
      expect(s.record).toHaveBeenCalledWith(expect.anything(), "failed", "internal");
    }
  });

  it("leaves a run that is still going, a missing execution, a failing lookup and a tracked run as running", async () => {
    const r = ref();
    for (const load of [
      async () => ({ status: "running", variables: {} }),
      async () => null,
      async () => {
        throw new RangeError("down");
      },
    ]) {
      const errors: unknown[] = [];
      const s = setup(load);
      const starter = loomVisualsStarter(s.runtime as never, flow, {
        runs: s.runs,
        onError: (e) => errors.push(e),
      });
      expect(await starter.rerun(r, 1)).toEqual({ kind: "running" });
      expect(s.record).not.toHaveBeenCalled();
      expect(s.started).toEqual([]);
    }
    const s = setup(completed({ outcome: "done" }));
    const starter = loomVisualsStarter(s.runtime as never, flow, { runs: s.runs });
    await starter.start(r, 1);
    expect(await starter.reconcile(r, 1, runningRow)).toEqual(runningRow); // this process is on it: Loom is not asked
    expect(s.runtime.loadState).not.toHaveBeenCalled();
  });

  it("the boot sweep reconciles every running row, paged, before it starts anything, then retries a repaired unavailable one", async () => {
    const docs = Array.from({ length: 3 }, () => ({ ...ref(), generation: 1, run: 0 }));
    const s = setup(completed({ outcome: "failed", code: "visuals-model-unavailable" }));
    const page = async (after: string, limit: number) => {
      const from =
        after === "00000000-0000-0000-0000-000000000000"
          ? 0
          : docs.findIndex((d) => d.documentId === after) + 1;
      return docs.slice(from, from + limit);
    };
    const order: string[] = [];
    s.record.mockImplementation(async () => void order.push("record"));
    s.runtime.start.mockImplementation(async (_f, _i, o) => {
      order.push("start");
      return { executionId: o.executionId, waitForCompletion: async () => {} } as never;
    });
    const starter = loomVisualsStarter(s.runtime as never, flow, {
      running: page,
      retry: async (after) =>
        after === "00000000-0000-0000-0000-000000000000" ? [docs[0] as never] : [],
      runs: { record: s.record, last: vi.fn(async () => null as never) },
      pageSize: 2,
    });
    await starter.sweep();
    expect(s.runtime.loadState).toHaveBeenCalledTimes(3);
    expect(s.record.mock.calls.filter((c) => (c as unknown[])[1] === "failed")).toHaveLength(3);
    expect(order.slice(0, 3)).toEqual(["record", "record", "record"]);
  });

  it("a failing running-row source does not stop the boot sweep's ready and retry passes", async () => {
    const doc = { ...ref(), generation: 1 };
    const s = setup(completed({ outcome: "done" }));
    s.runtime.start.mockImplementation(
      async (_f, _i, o) =>
        ({ executionId: o.executionId, waitForCompletion: async () => {} }) as never,
    );
    const starter = loomVisualsStarter(s.runtime as never, flow, {
      running: async () => {
        throw new Error("lookup down");
      },
      ready: async (after) =>
        after === "00000000-0000-0000-0000-000000000000" ? [doc as never] : [],
      runs: { record: s.record, last: vi.fn(async () => null as never) },
    });
    await expect(starter.sweep()).resolves.toBe(1);
    expect(s.runtime.start).toHaveBeenCalledTimes(1);
  });
});
