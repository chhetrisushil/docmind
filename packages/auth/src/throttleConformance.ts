import { describe, expect, it } from "vitest";
import type { Throttle, ThrottlePolicy } from "./throttle";

/** What the suite needs: the throttle, and a way to move time forward without waiting. */
export interface ThrottleHarness {
  throttle: Throttle;
  advance(seconds: number): Promise<void>;
}

const P: ThrottlePolicy = { free: 2, baseSeconds: 10, capSeconds: 60, decaySeconds: 300 };

/** The suite every Throttle implementation must pass. */
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
      await failTimes(throttle, "k", 2);
      expect(await throttle.retryAfter(["k"])).toBe(0);
    });

    it("locks for the base time on the first failure over, and the lock runs out", async () => {
      const { throttle, advance } = await make();
      await failTimes(throttle, "k", 3);
      const wait = await throttle.retryAfter(["k"]);
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(10);
      await advance(10);
      expect(await throttle.retryAfter(["k"])).toBe(0);
    });

    it("doubles the lock with each further failure", async () => {
      const { throttle, advance } = await make();
      await failTimes(throttle, "k", 3);
      await advance(10);
      await failTimes(throttle, "k", 1);
      const wait = await throttle.retryAfter(["k"]);
      expect(wait).toBeGreaterThan(10);
      expect(wait).toBeLessThanOrEqual(20);
    });

    it("never locks for longer than the cap", async () => {
      const { throttle, advance } = await make();
      for (let i = 0; i < 12; i++) {
        await failTimes(throttle, "k", 1);
        await advance(100);
      }
      await failTimes(throttle, "k", 1);
      const wait = await throttle.retryAfter(["k"]);
      expect(wait).toBeGreaterThan(30);
      expect(wait).toBeLessThanOrEqual(60);
    });

    it("starts again from zero once a key has been left alone for the decay time", async () => {
      const { throttle, advance } = await make();
      await failTimes(throttle, "k", 5);
      await advance(301);
      await failTimes(throttle, "k", 1);
      expect(await throttle.retryAfter(["k"])).toBe(0);
    });

    it("forgets a key that is cleared", async () => {
      const { throttle } = await make();
      await failTimes(throttle, "k", 4);
      await throttle.clear("k");
      expect(await throttle.retryAfter(["k"])).toBe(0);
    });

    it("answers with the longest lock among the keys, and keeps keys apart", async () => {
      const { throttle } = await make();
      await failTimes(throttle, "a", 3);
      await failTimes(throttle, "b", 4);
      const both = await throttle.retryAfter(["a", "b", "c"]);
      expect(both).toBeGreaterThan(10);
      expect(await throttle.retryAfter(["c"])).toBe(0);
      expect(await throttle.retryAfter(["a"])).toBeLessThanOrEqual(10);
    });
  });
}
