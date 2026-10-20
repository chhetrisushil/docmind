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
    expect(await runBackfill(pool, s.starts as never, { lookbackDays: 60, batch: 2 })).toEqual({
      fired: 5,
      incomplete: false,
    });
    expect(s.fired).toEqual(["d1", "d2", "d3", "d4", "d5"]);
    expect(s.idles()).toBe(3);
    expect(lookbacks).toEqual([60 * 86400, 60 * 86400, 60 * 86400]);
  });

  it("a full batch that repeats while more lie behind it is retried after the status drain", async () => {
    const { pool } = fakePool([[1, 2], [1, 2], [1, 2], [3]]);
    const s = fakeStarts();
    const drain = vi.fn(async () => {});
    const out = await runBackfill(pool, s.starts as never, { lookbackDays: 7, batch: 2, drain });
    expect(out).toEqual({ fired: 3, incomplete: false });
    expect(s.fired).toEqual(["d1", "d2", "d3"]);
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it("reports incomplete when a full batch stays stuck, firing each document once", async () => {
    const { pool } = fakePool(Array.from({ length: 8 }, () => [1, 2]));
    const s = fakeStarts();
    const drain = vi.fn(async () => {});
    const out = await runBackfill(pool, s.starts as never, { lookbackDays: 7, batch: 2, drain });
    expect(out).toEqual({ fired: 2, incomplete: true });
    expect(s.fired).toEqual(["d1", "d2"]);
    expect(drain).toHaveBeenCalledTimes(3);
  });

  it("a failed sweep query rejects instead of reading as nothing stale", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const pool = {
      query: async () => {
        throw new RangeError("boom");
      },
    } as unknown as Pool;
    await expect(
      runBackfill(pool, fakeStarts().starts as never, { lookbackDays: 7 }),
    ).rejects.toBeInstanceOf(RangeError);
  });

  it("starts nothing when nothing is stale", async () => {
    const { pool } = fakePool([[]]);
    const s = fakeStarts();
    expect(await runBackfill(pool, s.starts as never, { lookbackDays: 7 })).toEqual({
      fired: 0,
      incomplete: false,
    });
  });

  it("refuses a lookback outside 1 to 400 days", async () => {
    const s = fakeStarts();
    for (const lookbackDays of [0, 401, 1.5, Number.NaN])
      await expect(
        runBackfill(fakePool([]).pool, s.starts as never, { lookbackDays }),
      ).rejects.toThrow(/lookbackDays must be an integer from 1 to 400/);
  });
});
