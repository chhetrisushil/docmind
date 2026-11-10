import { randomUUID } from "node:crypto";
import { ExecutionAlreadyExistsError, type ExecutionHandle } from "@loom/workflow-runtime";
import { describe, expect, it, vi } from "vitest";
import { deterministicUser, legacySuggestTagsId, testIdSource } from "../../opaqueIds/testing";
import { loomSuggestTagsStarter } from "./start";

const ref = () => ({ tenantId: randomUUID(), userId: randomUUID(), documentId: randomUUID() });
const never = {
  waitForCompletion: () => new Promise<void>(() => {}),
} as unknown as ExecutionHandle;

describe("suggest-tags execution ids", () => {
  it("a start names the run h_<handle>:suggest-tags-<token>-r<n>, with no plain user or document id", async () => {
    const started: string[] = [];
    const start = vi.fn(async (_f: unknown, _i: unknown, o: { executionId: string }) => {
      started.push(o.executionId);
      return never;
    });
    const ids = testIdSource();
    const r = ref();
    await loomSuggestTagsStarter({ start } as never, { ids }).start(r);
    const user = await ids.ensureUser(r);
    expect(started).toEqual([user.suggestTags(r.documentId, 1)]);
    expect(started[0]).toMatch(/^h_[a-z2-7]{25}[aeimquy4]:suggest-tags-[a-z2-7]{51}[aq]-r1$/);
    expect(started[0]).not.toContain(r.userId);
    expect(started[0]).not.toContain(r.documentId);
  });
});

describe("loomSuggestTagsStarter", () => {
  it("runs once for a double click: the second request answers running", async () => {
    const start = vi.fn(async () => never);
    const starter = loomSuggestTagsStarter({ start } as never, { ids: testIdSource() });
    const r = ref();
    const [a, b] = await Promise.all([starter.start(r), starter.start(r)]);
    expect([a, b]).toEqual([{ kind: "started", run: 1 }, { kind: "running" }]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(await starter.start(ref())).toEqual({ kind: "started", run: 1 }); // another document is independent
  });

  it("takes the next free run number when Loom already holds one (a restart forgets the counter)", async () => {
    const r = ref();
    const taken = deterministicUser(r.userId).suggestTags(r.documentId, 1);
    const start = vi.fn(async (_f: unknown, _i: unknown, o: { executionId: string }) => {
      if (o.executionId === taken) throw new ExecutionAlreadyExistsError(taken);
      return never;
    });
    const starter = loomSuggestTagsStarter({ start } as never, { ids: testIdSource() });
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
    const starter = loomSuggestTagsStarter({ start: vi.fn(async () => handle) } as never, {
      ids: testIdSource(),
    });
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
    const starter = loomSuggestTagsStarter({ start } as never, {
      ids: testIdSource(),
      enabled: () => false,
    });
    expect(await starter.start(ref())).toEqual({ kind: "disabled" });
    expect(start).not.toHaveBeenCalled();
  });

  it("rejects a malformed ref and idle() waits for pending starts", async () => {
    const starter = loomSuggestTagsStarter({ start: vi.fn(async () => never) } as never, {
      ids: testIdSource(),
    });
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
    const starter = loomSuggestTagsStarter({ start, cancel: vi.fn() } as never, {
      ids: testIdSource(),
    });
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

  it("cancel tries both id formats of every run number this process took, and ignores one Loom does not hold", async () => {
    const r = ref();
    const ids = testIdSource();
    const user = await ids.ensureUser(r);
    const held = new Set<string>([user.suggestTags(r.documentId, 2)]);
    const cancel = vi.fn(async (id: string, _reason: string) => {
      if (!held.has(id)) throw new Error(`No execution found for id: ${id}`);
      return true;
    });
    const finished = { waitForCompletion: () => Promise.resolve() } as unknown as ExecutionHandle;
    const starter = loomSuggestTagsStarter(
      { start: vi.fn(async () => finished), cancel } as never,
      { ids },
    );
    expect(await starter.start(r)).toEqual({ kind: "started", run: 1 });
    await vi.waitFor(async () =>
      expect(await starter.start(r)).toEqual({ kind: "started", run: 2 }),
    );
    await starter.cancel(r, r.documentId, "erased");
    const both = (n: number) => [
      legacySuggestTagsId(r.userId, r.documentId, n),
      user.suggestTags(r.documentId, n),
    ];
    // Runs 1 and 2 are this process's; run 3 is the first past its counter for which neither format exists: it ends the walk.
    expect(cancel.mock.calls.map((c) => c[0])).toEqual([...both(1), ...both(2), ...both(3)]);
    expect(new Set(cancel.mock.calls.map((c) => c[1]))).toEqual(new Set(["erased"]));
  });

  it("cancel finds the runs of an earlier process from Loom, not from this process's counter", async () => {
    const r = ref();
    const ids = testIdSource();
    const user = await ids.ensureUser(r);
    const held = new Set<string>([1, 2, 3].map((n) => user.suggestTags(r.documentId, n)));
    const cancel = vi.fn(async (id: string) => {
      if (!held.has(id)) throw new Error(`No execution found for id: ${id}`);
      return true;
    });
    const starter = loomSuggestTagsStarter({ start: vi.fn(), cancel } as never, { ids }); // a fresh process: counter at 0
    await starter.cancel(r, r.documentId, "erased");
    expect(cancel.mock.calls.map((c) => c[0])).toEqual(
      [1, 2, 3, 4].flatMap((n) => [
        legacySuggestTagsId(r.userId, r.documentId, n),
        user.suggestTags(r.documentId, n),
      ]),
    );
  });

  it("a user with no handle is cancelled under the old format only, and cancel mints nothing", async () => {
    const r = ref();
    const ids = testIdSource();
    const cancel = vi.fn(async (id: string) => {
      throw new Error(`No execution found for id: ${id}`);
    });
    await loomSuggestTagsStarter({ start: vi.fn(), cancel } as never, { ids }).cancel(
      r,
      r.documentId.toUpperCase(), // a caller's spelling: ids are lower-case
      "erased",
    );
    expect(cancel.mock.calls.map((c) => c[0])).toEqual([
      legacySuggestTagsId(r.userId, r.documentId, 1),
    ]);
    expect(ids.cached(r.userId)).toBeUndefined();
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
    const ids = testIdSource();
    const starter = loomSuggestTagsStarter({ start, cancel } as never, { ids });
    await starter.cancel(r, r.documentId, "erased"); // nothing yet
    expect(cancel).toHaveBeenCalledTimes(1);
    await starter.start(r); // lands late
    await starter.cancel(r, r.documentId, "erased");
    expect(cancel.mock.calls.map((c) => c[0]).slice(1)).toContain(
      deterministicUser(r.userId).suggestTags(r.documentId, 1),
    );
    expect(await starter.inFlight(r)).toBe(true);
  });

  it("cancel rethrows any other failure, so the erasure step is retried", async () => {
    const r = ref();
    const cancel = vi.fn(async () => {
      throw new RangeError("db down");
    });
    const starter = loomSuggestTagsStarter({ start: vi.fn(async () => never), cancel } as never, {
      ids: testIdSource(),
    });
    await starter.start(r);
    await expect(starter.cancel(r, r.documentId, "erased")).rejects.toThrow(RangeError);
  });
});
