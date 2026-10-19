import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StartScheduler } from "./startScheduler";
import { startSweeper } from "./sweeper";

const ROW = { tenant_id: "t", owner_id: "u", id: "d" };

describe("startSweeper", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup() {
    const gates: (() => void)[] = [];
    const query = vi.fn(
      () =>
        new Promise<{ rows: (typeof ROW)[] }>((resolve) => {
          gates.push(() => resolve({ rows: [ROW] }));
        }),
    );
    const start = vi.fn(async () => null);
    const starts = new StartScheduler({ start, cancel: async () => {} });
    const args = {
      pool: { query } as unknown as Pool,
      starts,
      olderThanMs: 1,
      lookbackMs: 2,
      limit: 3,
    };
    return { gates, query, start, starts, args };
  }

  it("never overlaps runs: a tick during a running sweep is skipped", async () => {
    const { gates, query, args } = setup();
    const sweeper = startSweeper(args, 10);
    expect(query).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30);
    expect(query).toHaveBeenCalledTimes(1);
    gates[0]?.();
    await vi.advanceTimersByTimeAsync(10);
    expect(query).toHaveBeenCalledTimes(2);
    gates[1]?.();
    await sweeper.stop();
  });

  it("stop clears the timer, waits for the run in progress and fires nothing afterwards", async () => {
    const { gates, query, start, starts, args } = setup();
    const sweeper = startSweeper(args, 10);
    const stopped = sweeper.stop();
    gates[0]?.();
    await stopped;
    await starts.idle();
    expect(start).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
