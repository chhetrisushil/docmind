import { describe, expect, it } from "vitest";
import { CloseTimeoutError, closeSequence } from "./closeSequence";
import { runAll } from "./shutdown";

describe("closeSequence", () => {
  it("interrupts the steps, then releases the leases, then closes the stores and the pools, in that order", async () => {
    const calls: string[] = [];
    const note = (name: string) => async () => void calls.push(name);
    await runAll(
      ...closeSequence({
        startsIdle: async () => void calls.push("starts"),
        closeIngest: note("closeIngest"),
        closeHeartbeat: note("closeHeartbeat"),
        detachStatusFeed: () => void calls.push("detach"),
        closeStatus: note("closeStatus"),
        closeApp: note("closeApp"),
        closeDurable: note("closeDurable"),
        endPool: note("endPool"),
      }),
    );
    expect(calls).toEqual([
      "starts",
      "closeIngest",
      "closeHeartbeat",
      "detach",
      "closeStatus",
      "closeApp",
      "closeDurable",
      "endPool",
    ]);
  });

  it("keeps going when a step fails (every store still closes) and rethrows that failure", async () => {
    const calls: string[] = [];
    const ok = async () => void calls.push("ok");
    const boom = new RangeError("closeIngest failed");
    await expect(
      runAll(
        ...closeSequence({
          startsIdle: ok,
          closeIngest: async () => {
            throw boom;
          },
          closeHeartbeat: ok,
          detachStatusFeed: () => {},
          closeStatus: ok,
          closeApp: ok,
          closeDurable: ok,
          endPool: ok,
        }),
      ),
    ).rejects.toBe(boom);
    expect(calls).toHaveLength(6);
  });

  const base = (calls: string[]) => {
    const ok = async () => {};
    return {
      startsIdle: ok,
      closeIngest: ok,
      closeHeartbeat: ok,
      detachStatusFeed: () => {},
      closeStatus: ok,
      closeApp: ok,
      closeDurable: ok,
      endPool: async () => void calls.push("endPool"),
    };
  };

  it("a failing endPool propagates its rejection (so shutdown logs its class and exits 1)", async () => {
    const boom = new RangeError("pool end failed");
    await expect(
      runAll(
        ...closeSequence({
          ...base([]),
          endPool: async () => {
            throw boom;
          },
        }),
      ),
    ).rejects.toBe(boom);
  });

  it("a hung closeDurable times out after the bound with a fixed error, and the pool still ends", async () => {
    const calls: string[] = [];
    await expect(
      runAll(...closeSequence({ ...base(calls), closeDurable: () => new Promise(() => {}) }, 5)),
    ).rejects.toMatchObject({
      name: "CloseTimeoutError",
      message: "shutdown step timed out: closeDurable",
    });
    expect(calls).toEqual(["endPool"]);
  });

  it("a hung endPool times out after the bound", async () => {
    await expect(
      runAll(...closeSequence({ ...base([]), endPool: () => new Promise(() => {}) }, 5)),
    ).rejects.toBeInstanceOf(CloseTimeoutError);
  });
});
