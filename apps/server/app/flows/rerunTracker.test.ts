import type { ExecutionHandle } from "@loom/workflow-runtime";
import { describe, expect, it } from "vitest";
import { MAX_RERUNS, rerunTracker } from "./rerunTracker";

const handle = () => {
  let done: () => void = () => {};
  const wait = new Promise<void>((r) => {
    done = r;
  });
  return { h: { waitForCompletion: () => wait } as unknown as ExecutionHandle, done };
};

describe("rerunTracker", () => {
  it("is running while a tracked execution has not ended, per key", async () => {
    const t = rerunTracker();
    const a = handle();
    t.track("k", "e1", a.h);
    expect([t.running("k"), t.running("other")]).toEqual([true, false]);
    a.done();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(t.running("k")).toBe(false);
  });

  it("does not track a handle that cannot be awaited", () => {
    const t = rerunTracker();
    t.track("k", "e1", {} as ExecutionHandle);
    expect(t.running("k")).toBe(false);
  });

  it("probes above the floor and this process's last number, skipping taken ids", async () => {
    const t = rerunTracker();
    const taken = new Set([4, 5]);
    const tried: number[] = [];
    const start = async (n: number) => {
      tried.push(n);
      return taken.has(n) ? null : (handle().h as ExecutionHandle);
    };
    expect(await t.probe("k", 3, start)).toMatchObject({ kind: "started", rerun: 6 });
    expect(tried).toEqual([4, 5, 6]);
    expect(t.last("k")).toBe(6);
    tried.length = 0;
    expect(await t.probe("k", 0, start)).toMatchObject({ rerun: 7 });
    expect(tried).toEqual([7]);
  });

  it("answers running when every number is taken, and after a taken id when a run began meanwhile", async () => {
    const t = rerunTracker();
    expect(await t.probe("k", 0, async () => null)).toEqual({ kind: "running" });
    const t2 = rerunTracker();
    let calls = 0;
    const out = await t2.probe("k", 0, async () => {
      calls++;
      t2.track("k", "other", handle().h);
      return null;
    });
    expect(out).toEqual({ kind: "running" });
    expect(calls).toBe(1);
    expect(MAX_RERUNS).toBe(999);
  });

  it("exclusive serialises a key, survives a failure, and leaves other keys alone", async () => {
    const t = rerunTracker();
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = t.exclusive("k", async () => {
      order.push("a-start");
      await gate;
      order.push("a-end");
      throw new RangeError("boom");
    });
    const second = t.exclusive("k", async () => void order.push("b"));
    await t.exclusive("other", async () => void order.push("other"));
    expect(order).toEqual(["a-start", "other"]);
    release();
    await expect(first).rejects.toThrow(RangeError);
    await second;
    expect(order).toEqual(["a-start", "other", "a-end", "b"]);
  });
});
