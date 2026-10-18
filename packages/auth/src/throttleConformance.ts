import { describe, expect, it } from "vitest";
import { type Throttle, type ThrottlePolicy, lockSeconds } from "./throttle";

/** What the suite needs: the throttle, and a way to move time forward without waiting. */
export interface ThrottleHarness {
  throttle: Throttle;
  advance(seconds: number): Promise<void>;
}

const P: ThrottlePolicy = { free: 2, baseSeconds: 10, capSeconds: 60, decaySeconds: 300 };

/** Within one second of `expected`: a Throttle may round a lock up to the next whole second. */
const near = (actual: number, expected: number) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1);

/**
 * The suite every Throttle implementation must pass. `make` must return a throttle with no prior
 * state (a fresh table or store), because each case assumes its keys have never been used.
 */
export function runThrottleConformance(
  make: () => ThrottleHarness | Promise<ThrottleHarness>,
  label = "Throttle",
): void {
  const failTimes = async (t: Throttle, key: string, n: number) => {
    for (let i = 0; i < n; i++) await t.fail(key, P);
  };

  describe(`${label} conformance`, () => {
    it("does not lock until the free failures are used up", async () => {
      const { throttle } = await make();
      await failTimes(throttle, "k", P.free);
      expect(await throttle.retryAfter(["k"])).toBe(0);
    });

    it("locks for the base time on the first failure over, and the lock runs out", async () => {
      const { throttle, advance } = await make();
      await failTimes(throttle, "k", P.free + 1);
      const wait = await throttle.retryAfter(["k"]);
      expect(wait).toBeGreaterThanOrEqual(P.baseSeconds - 1);
      expect(wait).toBeLessThanOrEqual(P.baseSeconds);
      await advance(5);
      const left = await throttle.retryAfter(["k"]);
      expect(left).toBeGreaterThan(0);
      expect(left).toBeLessThanOrEqual(5);
      await advance(5);
      expect(await throttle.retryAfter(["k"])).toBe(0);
    });

    it("doubles the lock with each further failure, up to the cap", async () => {
      const { throttle } = await make();
      await failTimes(throttle, "k", P.free);
      // Locks for failures 3..6 are 10, 20, 40, 60 seconds (60 is the cap).
      for (let n = P.free + 1; n <= P.free + 4; n++) {
        await throttle.fail("k", P);
        near(await throttle.retryAfter(["k"]), lockSeconds(P, n));
      }
    });

    it("counts a failure made while locked, and re-locks from now with the next value", async () => {
      const { throttle, advance } = await make();
      await failTimes(throttle, "k", P.free + 1); // 10 s lock
      await advance(5);
      await throttle.fail("k", P); // 4th failure: 20 s from now, not the 5 s left
      near(await throttle.retryAfter(["k"]), lockSeconds(P, P.free + 2));
    });

    it("never locks for longer than the cap", async () => {
      const { throttle } = await make();
      await failTimes(throttle, "k", 13);
      const wait = await throttle.retryAfter(["k"]);
      expect(wait).toBeGreaterThanOrEqual(P.capSeconds - 1);
      expect(wait).toBeLessThanOrEqual(P.capSeconds);
    });

    it("starts again from zero once a key has been left alone for the decay time", async () => {
      const { throttle, advance } = await make();
      await failTimes(throttle, "k", 5);
      await advance(P.decaySeconds + 1);
      await failTimes(throttle, "k", P.free);
      expect(await throttle.retryAfter(["k"])).toBe(0);
      await throttle.fail("k", P); // the first failure over the allowance again
      near(await throttle.retryAfter(["k"]), P.baseSeconds);
    });

    it("forgets a key that is cleared, and only that key", async () => {
      const { throttle } = await make();
      await failTimes(throttle, "k", 4);
      await failTimes(throttle, "other", 4);
      await throttle.clear("k");
      expect(await throttle.retryAfter(["k"])).toBe(0);
      expect(await throttle.retryAfter(["other"])).toBeGreaterThan(0);
      // The count is reset, not just the lock: a free allowance again means no lock.
      await failTimes(throttle, "k", P.free);
      expect(await throttle.retryAfter(["k"])).toBe(0);
    });

    it("answers with the longest lock among the keys", async () => {
      const { throttle } = await make();
      await failTimes(throttle, "a", P.free + 1); // 10 s
      await failTimes(throttle, "b", P.free + 2); // 20 s
      const a = await throttle.retryAfter(["a"]);
      const b = await throttle.retryAfter(["b"]);
      const both = await throttle.retryAfter(["a", "b"]);
      near(both, Math.max(a, b));
      expect(both).toBeGreaterThanOrEqual(a);
      expect(both).toBeGreaterThanOrEqual(b);
    });

    it("keeps keys apart: a shared counter would lock both", async () => {
      const { throttle } = await make();
      await failTimes(throttle, "a", P.free);
      await failTimes(throttle, "b", P.free);
      expect(await throttle.retryAfter(["a"])).toBe(0);
      expect(await throttle.retryAfter(["b"])).toBe(0);
    });
  });
}
