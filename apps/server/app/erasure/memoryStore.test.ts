import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryErasureStore } from "./testing";
import { ERASURE_STEPS, isErasureStep } from "./types";

const [U, T] = [randomUUID(), randomUUID()];
const tx = { query: async () => undefined };
const finish = async (s: MemoryErasureStore, user: string) => {
  for (const step of ERASURE_STEPS) await s.mark(user, step);
};
const hash = (n: number) => Buffer.alloc(32, n);

describe("ERASURE_STEPS", () => {
  it("is the fixed order of D3, and the guard accepts exactly those", () => {
    expect(ERASURE_STEPS).toEqual(["stop", "shred", "readModels", "rows", "blobs", "key", "done"]);
    expect(ERASURE_STEPS.every(isErasureStep)).toBe(true);
    for (const x of ["retry", "", "STOP", 1, null]) expect(isErasureStep(x)).toBe(false);
  });
});

describe("MemoryErasureStore", () => {
  it("inserts pending, lists it, records a step once, and counts retries", async () => {
    const store = new MemoryErasureStore();
    expect(await store.insert(tx, U, T, hash(1))).toBe(true);
    expect(await store.insert(tx, U, T, hash(2))).toBe(false); // idempotent: the first receipt stays
    expect(await store.status(hash(1))).toBe("pending");
    expect(await store.status(hash(2))).toBeNull();
    expect(await store.pending()).toEqual([
      { userId: U, tenantId: T, state: "pending", steps: [], attempts: 0 },
    ]);
    await store.mark(U, "stop");
    await store.mark(U, "stop");
    await store.retried(U);
    expect(await store.get(U)).toMatchObject({ steps: ["stop"], attempts: 1 });
  });

  it("done leaves the pending list, and get answers null for it and for a stranger", async () => {
    const store = new MemoryErasureStore();
    await store.insert(tx, U, T, hash(1));
    await finish(store, U);
    expect(await store.pending()).toEqual([]);
    expect(await store.get(U)).toBeNull();
    expect(await store.get(randomUUID())).toBeNull();
    expect(await store.status(hash(1))).toBe("done"); // the receipt keeps answering
    expect(await store.status(hash(9))).toBeNull();
  });

  it("erased() lists the done requests by user id, and never a pending one", async () => {
    const store = new MemoryErasureStore();
    const u1 = "00000000-0000-4000-8000-000000000001";
    const u2 = "00000000-0000-4000-8000-000000000002";
    const u3 = "00000000-0000-4000-8000-000000000003";
    const u4 = "00000000-0000-4000-8000-000000000004";
    for (const [i, u] of [u3, u1, u4, u2].entries()) await store.insert(tx, u, T, hash(i + 1));
    expect(await store.erased()).toEqual([]);
    expect((await store.pending()).map((r) => r.userId)).toEqual([u1, u2, u3, u4]);
    await finish(store, u3);
    await finish(store, u1);
    await finish(store, u2);
    expect(await store.erased()).toEqual([u1, u2, u3]);
    expect((await store.pending()).map((r) => r.userId)).toEqual([u4]);
  });

  it("refuses to mark a request that does not exist", async () => {
    await expect(new MemoryErasureStore().mark(U, "stop")).rejects.toThrow(
      /no such erasure request/,
    );
  });

  it("enforces the order like the database: out of order and early done throw, a repeat and a mark after done do nothing", async () => {
    const store = new MemoryErasureStore();
    await store.insert(tx, U, T, hash(1));
    await expect(store.mark(U, "shred")).rejects.toThrow(/out of order/);
    await expect(store.mark(U, "done")).rejects.toThrow(/out of order/);
    await store.mark(U, "stop");
    await store.mark(U, "stop");
    expect(await store.get(U)).toMatchObject({ steps: ["stop"] });
    await finish(store, U);
    await store.mark(U, "key");
    await expect(store.retried(U)).rejects.toThrow(/no such erasure request/);
    expect(await store.erased()).toEqual([U]);
  });
});
