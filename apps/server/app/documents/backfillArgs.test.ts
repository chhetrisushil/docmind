import { describe, expect, it } from "vitest";
import { BACKFILL_DAYS_MESSAGE, parseBackfillArgs } from "./backfillArgs";

describe("parseBackfillArgs", () => {
  it("accepts --days in 1..400, with --no-wait", () => {
    expect(parseBackfillArgs(["--days", "30"])).toEqual({ days: 30, wait: true });
    expect(parseBackfillArgs(["--days=400", "--no-wait"])).toEqual({ days: 400, wait: false });
  });
  it("rejects a missing or bad --days with the exact message", () => {
    for (const argv of [
      [],
      ["--days"],
      ["--days", "0"],
      ["--days", "401"],
      ["--days", "1.5"],
      ["--days", "x"],
      ["--days", "-3"],
    ])
      expect(parseBackfillArgs(argv)).toEqual({ error: BACKFILL_DAYS_MESSAGE });
  });
  it("rejects an unknown argument without echoing a value", () => {
    expect(parseBackfillArgs(["--days", "3", "--bogus"])).toEqual({ error: "unknown argument" });
  });
});
