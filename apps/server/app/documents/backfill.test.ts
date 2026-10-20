import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { runBackfill } from "./backfill";

const row = (n: number) => ({ tenant_id: "t", owner_id: "u", id: `d${n}`, generation: 1 });

function fakePool(pages: number[][]) {
  const lookbacks: number[] = [];
  const query = vi.fn(async (_sql: string, params: number[]) => {
    lookbacks.push(params[1] as number);
    return { rows: (pages.shift() ?? []).map(row) };
  });
  return { pool: { query } as unknown as Pool, lookbacks };
}
const fakeStarts = () => {
  const fired: string[] = [];
  let idles = 0;
  return {
    fired,
    idles: () => idles,
    starts: {
      fire: (_i: unknown, id: string) => void fired.push(id),
      idle: async () => void idles++,
    },
  };
};

describe("runBackfill", () => {
  it("sweeps until a batch comes back short, waiting for the starts between batches", async () => {
    const { pool, lookbacks } = fakePool([[1, 2], [3, 4], [5]]);
    const s = fakeStarts();
    expect(await runBackfill(pool, s.starts as never, { lookbackDays: 60, batch: 2 })).toBe(5);
    expect(s.fired).toEqual(["d1", "d2", "d3", "d4", "d5"]);
    expect(s.idles()).toBe(3);
    expect(lookbacks).toEqual([60 * 86400, 60 * 86400, 60 * 86400]);
  });

  it("fires each document once and stops when a full batch brings nothing new", async () => {
    const { pool } = fakePool([
      [1, 2],
      [1, 2],
      [1, 2],
    ]);
    const s = fakeStarts();
    expect(await runBackfill(pool, s.starts as never, { lookbackDays: 7, batch: 2 })).toBe(2);
    expect(s.fired).toEqual(["d1", "d2"]);
  });

  it("starts nothing when nothing is stale", async () => {
    const { pool } = fakePool([[]]);
    const s = fakeStarts();
    expect(await runBackfill(pool, s.starts as never, { lookbackDays: 7 })).toBe(0);
  });

  it("refuses a lookback outside 1 to 400 days", async () => {
    const s = fakeStarts();
    for (const lookbackDays of [0, 401, 1.5, Number.NaN])
      await expect(
        runBackfill(fakePool([]).pool, s.starts as never, { lookbackDays }),
      ).rejects.toThrow(/lookbackDays must be an integer from 1 to 400/);
  });
});
