import { afterEach, describe, expect, it, vi } from "vitest";
import { OpaqueIds, opaqueIds } from "../opaqueIds";
import { testOpaqueIds } from "../opaqueIds/testing";
import { ENSURE_ATTEMPTS, ensureGate } from "./ensureGate";

const T = "00000000-0000-0000-0000-0000000000aa";
const U = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const noSleep = async () => {};

afterEach(() => opaqueIds.install(undefined));

async function cold() {
  const t = testOpaqueIds();
  t.store.add(U, T);
  t.store.add(U2, T);
  const a = await t.ids.ensureUser({ tenantId: T, userId: U });
  const b = await t.ids.ensureUser({ tenantId: T, userId: U2 });
  const fresh = new OpaqueIds(t.keys, t.store); // a process that has booted without them
  opaqueIds.install(fresh);
  return { ...t, fresh, a: a.handle, b: b.handle };
}

describe("ensureGate", () => {
  it("runs at once, in the same tick, for an old-format id and for a cached handle", async () => {
    const { fresh, a } = await cold();
    await fresh.ensureHandle(a);
    const seen: string[] = [];
    const gate = ensureGate(() => {}, noSleep);
    gate(null, () => seen.push("old"));
    gate(a, () => seen.push("cached"));
    expect(seen).toEqual(["old", "cached"]);
  });

  it("queues a cold handle until ensure fills the cache; other handles and old-format ids do not wait for it (per-handle lanes)", async () => {
    const { a, b, fresh } = await cold();
    await fresh.ensureHandle(b);
    const seen: string[] = [];
    const gate = ensureGate(() => {}, noSleep);
    gate(a, () => seen.push(`first:${opaqueIds.known(a)}`)); // cold: waits in its own lane
    gate(b, () => seen.push("second")); // another user's lane: runs at once
    gate(null, () => seen.push("third"));
    expect(seen).toEqual(["second", "third"]);
    await vi.waitFor(() => expect(seen).toEqual(["second", "third", "first:true"]));
    const later: string[] = [];
    gate(a, () => later.push("hot again"));
    expect(later).toEqual(["hot again"]); // the lane drained: the hot path is synchronous again
  });

  it("still runs for a handle nobody holds (an erased user): the fold writes the neutral row", async () => {
    await cold();
    const seen: string[] = [];
    const gate = ensureGate(() => {}, noSleep);
    gate("y".repeat(26), () => seen.push("erased"));
    await vi.waitFor(() => expect(seen).toEqual(["erased"]));
  });

  it("retries a failing ensure, then reports it and does not run the event", async () => {
    const { a, store } = await cold();
    let calls = 0;
    store.userOf = async () => {
      calls += 1;
      throw new Error("db down");
    };
    const reported: unknown[] = [];
    const seen: string[] = [];
    const gate = ensureGate((e) => reported.push(e), noSleep);
    gate(a, () => seen.push("ran"));
    gate(a, () => seen.push("ran again")); // queued behind it, same user: skipped without another round of retries
    await gate.idle();
    expect(reported).toHaveLength(1);
    expect(calls).toBe(ENSURE_ATTEMPTS);
    expect(seen).toEqual([]);
    const next: string[] = [];
    gate(null, () => next.push("after")); // the gate recovers: later events still flow
    expect(next).toEqual(["after"]);
  });

  it("idle resolves once everything queued has run, and at once when nothing is queued", async () => {
    const { a, b } = await cold();
    const seen: string[] = [];
    const gate = ensureGate(() => {}, noSleep);
    await gate.idle();
    gate(a, () => seen.push("a"));
    gate(b, () => seen.push("b"));
    expect(seen).toEqual([]);
    await gate.idle();
    expect(seen).toEqual(["a", "b"]);
  });

  it("one cold handle in an outage delays neither an old-format event nor another handle's, and keeps its own order", async () => {
    const { a, b, store, fresh } = await cold();
    await fresh.ensureHandle(b);
    const real = store.userOf.bind(store);
    store.userOf = async (h: string) => {
      if (h === a) throw new Error("down");
      return real(h);
    };
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const seen: string[] = [];
    const gate = ensureGate(
      () => {},
      () => held, // the cold handle's retries wait here
    );
    gate(a, () => seen.push("a1")); // cold, failing: parked in its lane
    gate(a, () => seen.push("a2"));
    gate(null, () => seen.push("old"));
    gate(b, () => seen.push("b"));
    expect(seen).toEqual(["old", "b"]); // same tick, not behind a
    release();
    await gate.idle();
    expect(seen).toEqual(["old", "b"]); // a failed: neither a1 nor a2 ran
  });

  it("keeps the order of one handle's events across a cold start, and idle waits for every lane", async () => {
    const { a, b, fresh } = await cold();
    const seen: string[] = [];
    const gate = ensureGate(() => {}, noSleep);
    gate(a, () => seen.push("a1"));
    gate(b, () => seen.push("b1"));
    gate(a, () => seen.push("a2"));
    gate(b, () => seen.push("b2"));
    await gate.idle();
    expect(seen.filter((x) => x[0] === "a")).toEqual(["a1", "a2"]);
    expect(seen.filter((x) => x[0] === "b")).toEqual(["b1", "b2"]);
    expect(seen).toHaveLength(4);
    expect(fresh.knows(a) && fresh.knows(b)).toBe(true);
  });

  it("a throwing report neither skips queued events nor rejects idle", async () => {
    const { a, store } = await cold();
    store.userOf = async () => {
      throw new Error("down");
    };
    const seen: string[] = [];
    const gate = ensureGate(() => {
      throw new Error("onError threw");
    }, noSleep);
    gate(a, () => seen.push("a1"));
    gate(a, () => seen.push("a2"));
    await expect(gate.idle()).resolves.toBeUndefined();
    const later: string[] = [];
    gate(null, () => later.push("after"));
    expect(later).toEqual(["after"]);
  });

  it("a throwing run does not stop the lane's later events", async () => {
    const { a } = await cold();
    const seen: string[] = [];
    const gate = ensureGate(() => {
      throw new Error("onError threw");
    }, noSleep);
    gate(a, () => {
      throw new Error("fold threw");
    });
    gate(a, () => seen.push("a2"));
    await gate.idle();
    expect(seen).toEqual(["a2"]);
  });
});
