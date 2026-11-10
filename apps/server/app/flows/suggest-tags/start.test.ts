import { randomUUID } from "node:crypto";
import { ExecutionAlreadyExistsError, type ExecutionHandle } from "@loom/workflow-runtime";
import { describe, expect, it, vi } from "vitest";
import { executionIdFor } from "../../subject";
import { loomSuggestTagsStarter, suggestTagsExecutionId } from "./start";

const ref = () => ({ tenantId: randomUUID(), userId: randomUUID(), documentId: randomUUID() });
const never = {
  waitForCompletion: () => new Promise<void>(() => {}),
} as unknown as ExecutionHandle;

describe("suggestTagsExecutionId", () => {
  it("is suggest-tags-<doc>-r<n> under the user's prefix", () => {
    const r = ref();
    expect(suggestTagsExecutionId(r.userId, r.documentId.toUpperCase(), 2)).toBe(
      executionIdFor(r.userId, `suggest-tags-${r.documentId}-r2`),
    );
  });
});

describe("loomSuggestTagsStarter", () => {
  it("runs once for a double click: the second request answers running", async () => {
    const start = vi.fn(async () => never);
    const starter = loomSuggestTagsStarter({ start } as never);
    const r = ref();
    const [a, b] = await Promise.all([starter.start(r), starter.start(r)]);
    expect([a, b]).toEqual([{ kind: "started", run: 1 }, { kind: "running" }]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(await starter.start(ref())).toEqual({ kind: "started", run: 1 }); // another document is independent
  });

  it("takes the next free run number when Loom already holds one (a restart forgets the counter)", async () => {
    const r = ref();
    const taken = suggestTagsExecutionId(r.userId, r.documentId, 1);
    const start = vi.fn(async (_f: unknown, _i: unknown, o: { executionId: string }) => {
      if (o.executionId === taken) throw new ExecutionAlreadyExistsError(taken);
      return never;
    });
    const starter = loomSuggestTagsStarter({ start } as never);
    expect(await starter.start(r)).toEqual({ kind: "started", run: 2 });
  });

  it("lets a finished run be followed by another", async () => {
    let done: () => void = () => {};
    const handle = {
      waitForCompletion: () =>
        new Promise<void>((res) => {
          done = res;
        }),
    } as unknown as ExecutionHandle;
    const starter = loomSuggestTagsStarter({ start: vi.fn(async () => handle) } as never);
    const r = ref();
    expect(await starter.start(r)).toEqual({ kind: "started", run: 1 });
    expect(await starter.start(r)).toEqual({ kind: "running" });
    done();
    await vi.waitFor(async () =>
      expect(await starter.start(r)).toEqual({ kind: "started", run: 2 }),
    );
  });

  it("answers disabled without starting anything while the role is off", async () => {
    const start = vi.fn();
    const starter = loomSuggestTagsStarter({ start } as never, { enabled: () => false });
    expect(await starter.start(ref())).toEqual({ kind: "disabled" });
    expect(start).not.toHaveBeenCalled();
  });

  it("rejects a malformed ref and idle() waits for pending starts", async () => {
    const starter = loomSuggestTagsStarter({ start: vi.fn(async () => never) } as never);
    expect(() => starter.start({ tenantId: "x", userId: "y", documentId: "z" } as never)).toThrow();
    await starter.start(ref());
    await starter.idle();
  });
});

describe("settle and cancel (erasure)", () => {
  it("settle waits for the document's pending start and for no other document's", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const start = vi.fn(async () => {
      await gate;
      return never;
    });
    const starter = loomSuggestTagsStarter({ start, cancel: vi.fn() } as never);
    const r = ref();
    void starter.start(r);
    let settled = false;
    const waiting = starter.settle(r, r.documentId).then(() => {
      settled = true;
    });
    const other = ref();
    await starter.settle(other, other.documentId); // another document: nothing to wait for
    expect(settled).toBe(false);
    release();
    await waiting;
    expect(settled).toBe(true);
  });

  it("cancel stops every run number this process took and ignores one Loom does not hold", async () => {
    const r = ref();
    const first = suggestTagsExecutionId(r.userId, r.documentId, 1);
    const cancel = vi.fn(async (id: string, _reason: string) => {
      if (id === first || id === suggestTagsExecutionId(r.userId, r.documentId, 3))
        throw new Error(`No execution found for id: ${id}`);
      return true;
    });
    const finished = { waitForCompletion: () => Promise.resolve() } as unknown as ExecutionHandle;
    const starter = loomSuggestTagsStarter({ start: vi.fn(async () => finished), cancel } as never);
    expect(await starter.start(r)).toEqual({ kind: "started", run: 1 });
    await vi.waitFor(async () =>
      expect(await starter.start(r)).toEqual({ kind: "started", run: 2 }),
    );
    await starter.cancel(r, r.documentId, "erased");
    expect(cancel.mock.calls.map((c) => c[0])).toEqual([
      first,
      suggestTagsExecutionId(r.userId, r.documentId, 2),
      suggestTagsExecutionId(r.userId, r.documentId, 3), // the first one Loom does not hold ends the walk
    ]);
    expect(cancel.mock.calls.map((c) => c[1])).toEqual(["erased", "erased", "erased"]);
  });

  it("cancel finds the runs of an earlier process from Loom, not from this process's counter", async () => {
    const r = ref();
    const held = new Set([1, 2, 3].map((n) => suggestTagsExecutionId(r.userId, r.documentId, n)));
    const cancel = vi.fn(async (id: string) => {
      if (!held.has(id as never)) throw new Error(`No execution found for id: ${id}`);
      return true;
    });
    const starter = loomSuggestTagsStarter({ start: vi.fn(), cancel } as never); // a fresh process: counter at 0
    await starter.cancel(r, r.documentId, "erased");
    expect(cancel.mock.calls.map((c) => c[0])).toEqual(
      [1, 2, 3, 4].map((n) => suggestTagsExecutionId(r.userId, r.documentId, n)),
    );
  });

  it("a start that lands after one cancel is caught by the next (the park-then-cancel retry)", async () => {
    const r = ref();
    const held = new Set<string>();
    const cancel = vi.fn(async (id: string) => {
      if (!held.has(id)) throw new Error(`No execution found for id: ${id}`);
      return true;
    });
    const start = vi.fn(async (_f: unknown, _i: unknown, o: { executionId: string }) => {
      held.add(o.executionId);
      return never;
    });
    const starter = loomSuggestTagsStarter({ start, cancel } as never);
    await starter.cancel(r, r.documentId, "erased"); // nothing yet
    expect(cancel).toHaveBeenCalledTimes(1);
    await starter.start(r); // lands late
    await starter.cancel(r, r.documentId, "erased");
    expect(cancel.mock.calls.map((c) => c[0]).slice(1)).toContain(
      suggestTagsExecutionId(r.userId, r.documentId, 1),
    );
    expect(await starter.inFlight(r)).toBe(true);
  });

  it("cancel rethrows any other failure, so the erasure step is retried", async () => {
    const r = ref();
    const cancel = vi.fn(async () => {
      throw new RangeError("db down");
    });
    const starter = loomSuggestTagsStarter({ start: vi.fn(async () => never), cancel } as never);
    await starter.start(r);
    await expect(starter.cancel(r, r.documentId, "erased")).rejects.toThrow(RangeError);
  });
});
