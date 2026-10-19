import { describe, expect, it } from "vitest";
import { closeSequence } from "./closeSequence";
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
});
