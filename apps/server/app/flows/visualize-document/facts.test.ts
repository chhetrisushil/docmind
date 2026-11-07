import { describe, expect, it } from "vitest";
import { admit, grounded, numbersOf } from "./facts";

const C1 = "11111111-1111-4111-8111-111111111111";
const text = (s: string) => new Map([[C1, s]]);

describe("grounded", () => {
  it.each([
    ["Revenue was 1,200 in 2024", 1200],
    ["Revenue was 1 200", 1200],
    ["Revenue was 1.2k", 1200],
    ["Revenue was $3M", 3_000_000],
    ["Margin 12 %", 12],
    ["Margin 12%", 12],
  ])("finds %s", (s, n) => {
    const fact = { kind: "figure", label: "x", value: n, chunkIds: [C1], ordinal: 0 } as const;
    expect(grounded(fact, text(s))).toBe(true);
  });
  it("accepts 0.12 for a percent unit when the text says 12%", () => {
    const fact = {
      kind: "figure",
      label: "m",
      value: 0.12,
      unit: "%",
      chunkIds: [C1],
      ordinal: 0,
    } as const;
    expect(grounded(fact, text("margin 12%"))).toBe(true);
  });
  it("rejects a number the cited text does not contain", () => {
    const fact = { kind: "figure", label: "x", value: 1300, chunkIds: [C1], ordinal: 0 } as const;
    expect(grounded(fact, text("Revenue was 1,200"))).toBe(false);
  });
});

describe("admit", () => {
  it("drops facts citing chunks of another document, caps at 16, assigns ordinals", () => {
    const ok = { kind: "figure", label: "x", value: 5, chunkIds: [C1] } as const;
    const foreign = { ...ok, chunkIds: ["22222222-2222-4222-8222-222222222222"] };
    const r = admit([foreign, ...Array(20).fill(ok)], text("five 5"), new Set([C1]));
    expect(r.facts).toHaveLength(16);
    expect(r.facts.map((f) => f.ordinal)).toEqual([...Array(16).keys()]);
    expect(r.dropped).toBe(1);
  });
  it("numbersOf lists series points, figure values and numeric table cells", () => {
    expect(
      numbersOf({
        kind: "factTable",
        title: "t",
        columns: ["a"],
        rows: [["7"], ["n/a"]],
        chunkIds: [C1],
        ordinal: 0,
      }),
    ).toEqual([7]);
  });
});

const C2 = "33333333-3333-4333-8333-333333333333";
const one = (s: string) => new Map([[C1, s]]);

describe("grounding covers every number in a fact (V4)", () => {
  it("grounds a table cell with a currency sign, and drops a different amount", () => {
    const row = (cell: string) =>
      ({
        kind: "factTable",
        title: "Costs",
        columns: ["Cost"],
        rows: [[cell]],
        chunkIds: [C1],
        ordinal: 0,
      }) as const;
    expect(grounded(row("$5"), one("a cost of $5"))).toBe(true);
    expect(grounded(row("$99"), one("a cost of $5"))).toBe(false);
  });
  it("grounds a cell 1,200 by the text 1,200, and does not read it as 1.2", () => {
    const row = {
      kind: "factTable",
      title: "t",
      columns: ["a"],
      rows: [["1,200"]],
      chunkIds: [C1],
      ordinal: 0,
    } as const;
    expect(grounded(row, one("sales 1,200"))).toBe(true);
    expect(grounded(row, one("sales 1.2"))).toBe(false);
  });
  it("checks cells with percent and k suffix", () => {
    const row = (cell: string) =>
      ({
        kind: "factTable",
        title: "t",
        columns: ["a"],
        rows: [[cell]],
        chunkIds: [C1],
        ordinal: 0,
      }) as const;
    expect(grounded(row("12 %"), one("margin 12 %"))).toBe(true);
    expect(grounded(row("1.2k"), one("sales 1.2k"))).toBe(true);
    expect(grounded(row("1.2k"), one("sales 1.3k"))).toBe(false);
  });
  it("grounds a negative series value by (5), −5 or -5, and an unsigned value by none of them", () => {
    const s = (y: number) =>
      ({
        kind: "series",
        label: "net",
        points: [
          { x: "a", y },
          { x: "b", y },
        ],
        chunkIds: [C1],
        ordinal: 0,
      }) as const;
    expect(grounded(s(-5), one("a loss of (5)"))).toBe(true);
    expect(grounded(s(-5), one("a loss of -5"))).toBe(true);
    expect(grounded(s(-5), one("a loss of −5"))).toBe(true);
    expect(grounded(s(-5), one("a gain of 5"))).toBe(false);
  });
  it("does not ground +5 from the text -5", () => {
    const fig = { kind: "figure", label: "x", value: 5, chunkIds: [C1], ordinal: 0 } as const;
    expect(grounded(fig, one("change of -5"))).toBe(false);
  });
  it("reads a dash between numbers as a separator, not a minus", () => {
    const fig = { kind: "figure", label: "x", value: 2020, chunkIds: [C1], ordinal: 0 } as const;
    expect(grounded(fig, one("2019-2020"))).toBe(true);
  });
  it("grounds 5 from '5 m wide', and 5 million from it too", () => {
    const fig = (value: number) =>
      ({ kind: "figure", label: "width", value, chunkIds: [C1], ordinal: 0 }) as const;
    expect(grounded(fig(5), one("5 m wide"))).toBe(true);
    expect(grounded(fig(5_000_000), one("5 m wide"))).toBe(true);
  });
  it("grounds the raw number of a suffixed value, 1.2 from 1.2k", () => {
    const fig = (value: number) =>
      ({ kind: "figure", label: "x", value, chunkIds: [C1], ordinal: 0 }) as const;
    expect(grounded(fig(1.2), one("sales 1.2k"))).toBe(true);
    expect(grounded(fig(1200), one("sales 1.2k"))).toBe(true);
  });
  it("drops a fact whose label has a number the text does not contain", () => {
    const fig = {
      kind: "figure",
      label: "Revenue 2031",
      value: 1200,
      chunkIds: [C1],
      ordinal: 0,
    } as const;
    expect(grounded(fig, one("Revenue was 1,200"))).toBe(false);
  });
  it("grounds a series x value that is a year", () => {
    const s = {
      kind: "series",
      label: "sales",
      points: [
        { x: "2024", y: 3 },
        { x: "2025", y: 4 },
      ],
      chunkIds: [C1],
      ordinal: 0,
    } as const;
    expect(grounded(s, one("2024: 3, 2025: 4"))).toBe(true);
    expect(grounded(s, one("2025: 3, 2026: 4"))).toBe(false);
  });
  it("does not ground a unitless 0.12 from 12%, but a % unit does", () => {
    const bare = { kind: "figure", label: "m", value: 0.12, chunkIds: [C1], ordinal: 0 } as const;
    const pct = { ...bare, unit: "%" } as const;
    expect(grounded(bare, one("margin 12%"))).toBe(false);
    expect(grounded(pct, one("margin 12%"))).toBe(true);
  });
  it("uses every chunk a fact cites when it grounds a number", () => {
    const fig = { kind: "figure", label: "x", value: 7, chunkIds: [C1, C2], ordinal: 0 } as const;
    const texts = new Map([
      [C1, "nothing"],
      [C2, "seven is 7"],
    ]);
    expect(grounded(fig, texts)).toBe(true);
  });
});
