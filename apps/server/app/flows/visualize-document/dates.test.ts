import { describe, expect, it } from "vitest";
import { type DatePrecision, isStoredAt, parseEventDate } from "./dates";

describe("parseEventDate", () => {
  it.each([
    ["2025", "2025-01-01", "year"],
    ["1000", "1000-01-01", "year"],
    ["9999", "9999-01-01", "year"],
    ["2025-Q1", "2025-01-01", "quarter"],
    ["2025-Q2", "2025-04-01", "quarter"],
    ["2025-Q3", "2025-07-01", "quarter"],
    ["2025-Q4", "2025-10-01", "quarter"],
    ["2025-02", "2025-02-01", "month"],
    ["2025-12", "2025-12-01", "month"],
    ["2025-02-28", "2025-02-28", "day"],
    ["2024-02-29", "2024-02-29", "day"],
    ["2000-02-29", "2000-02-29", "day"],
    ["  2025-03-04  ", "2025-03-04", "day"],
  ] as const)("reads %j as %s at %s precision", (raw, at, precision) => {
    expect(parseEventDate(raw)).toEqual({ at, precision });
  });

  it.each([
    "999",
    "0999",
    "10000",
    "2025-Q0",
    "2025-Q5",
    "2025-q3",
    "2025-00",
    "2025-13",
    "2025-02-29",
    "2023-02-29",
    "2100-02-29",
    "2025-04-31",
    "2025-01-00",
    "2025-01-32",
    "2025-1-5",
    "2025/03/04",
    "2025-03-04T10:00:00Z",
    "last year",
    "next month",
    "recently",
    "Q3 2025",
    "",
  ])("drops %j (not a date at any of the four precisions)", (raw) => {
    expect(parseEventDate(raw)).toBeNull();
  });

  it("drops anything that is not a string", () => {
    for (const v of [undefined, null, 2025, {}, ["2025"], true])
      expect(parseEventDate(v)).toBeNull();
  });
});

describe("isStoredAt", () => {
  it.each<[string, DatePrecision, boolean]>([
    ["2025-07-01", "quarter", true],
    ["2025-08-01", "quarter", false],
    ["2025-07-02", "quarter", false],
    ["2025-01-01", "year", true],
    ["2025-02-01", "year", false],
    ["2025-02-01", "month", true],
    ["2025-02-03", "month", false],
    ["2025-02-28", "day", true],
    ["2025-02-30", "day", false],
    ["0999-01-01", "year", false],
    ["2025-1-1", "day", false],
    ["2025-01", "month", false],
  ])("%s at %s precision is %s", (at, precision, ok) => {
    expect(isStoredAt(at, precision)).toBe(ok);
  });
});
