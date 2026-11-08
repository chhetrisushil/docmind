import { describe, expect, it } from "vitest";
import { type DraftFact, StoredFact, admit, grounded as groundedDraft, numbersOf } from "./facts";

const C1 = "11111111-1111-4111-8111-111111111111";
const text = (s: string) => new Map([[C1, s]]);
// The fixtures are readonly literals that also carry an ordinal; `grounded` only reads the draft part.
const grounded = (f: unknown, texts: ReadonlyMap<string, string>) =>
  groundedDraft(f as DraftFact, texts);

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
  it("stores a percent that grounded only as a fraction in the document's form", () => {
    const fig: DraftFact = {
      kind: "figure",
      label: "g",
      value: 0.38,
      unit: "%",
      compare: { label: "p", value: 0.3 },
      chunkIds: [C1],
    };
    const ser: DraftFact = {
      kind: "series",
      label: "s",
      unit: "%",
      points: [
        { x: "a", y: 0.41 },
        { x: "b", y: 46 },
      ],
      chunkIds: [C1],
    };
    const r = admit([fig, ser], text("up 38% from 30%; margin 41% then 46%"), new Set([C1]));
    expect(r.facts[0]).toMatchObject({ value: 38, compare: { value: 30 } });
    expect(r.facts[1]).toMatchObject({
      points: [
        { x: "a", y: 41 },
        { x: "b", y: 46 },
      ],
    });
  });
  it("leaves a written percent and every non-percent unit unchanged", () => {
    const pct: DraftFact = { kind: "figure", label: "g", value: 38, unit: "%", chunkIds: [C1] };
    const eur: DraftFact = { kind: "figure", label: "g", value: 38, unit: "EUR", chunkIds: [C1] };
    const r = admit([pct, eur], text("38% and EUR 38"), new Set([C1]));
    expect(r.facts.map((f) => (f.kind === "figure" ? f.value : null))).toEqual([38, 38]);
  });
  it("numbersOf lists series points, figure values and numeric table cells", () => {
    expect(
      numbersOf({
        kind: "factTable",
        title: "t",
        columns: ["a"],
        rows: [["7"], ["n/a"]],
        chunkIds: [C1],
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
  it("grounds a parenthesised year, (2024), as 2024", () => {
    const fig = { kind: "figure", label: "x", value: 2024, chunkIds: [C1], ordinal: 0 } as const;
    expect(grounded(fig, one("in (2024)"))).toBe(true);
  });
  it("grounds a parenthesised -5 from (5) and still refuses +5 from a leading minus", () => {
    const fig = (value: number) =>
      ({ kind: "figure", label: "x", value, chunkIds: [C1], ordinal: 0 }) as const;
    expect(grounded(fig(-5), one("a loss of (5)"))).toBe(true);
    expect(grounded(fig(5), one("a change of -5"))).toBe(false);
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
  it("grounds an ISO-date x on its year, not its month or day", () => {
    const s = {
      kind: "series",
      label: "sales",
      points: [
        { x: "2024-01-05", y: 3 },
        { x: "2024-02-05", y: 4 },
      ],
      chunkIds: [C1],
      ordinal: 0,
    } as const;
    expect(grounded(s, one("In January 2024 sales were 3 and in February 2024 they were 4"))).toBe(
      true,
    );
    expect(grounded(s, one("In January sales were 3 and in February they were 4"))).toBe(false);
  });
  it("does not let trailing text hide numbers after an ISO date", () => {
    const series = (x: string) =>
      ({
        kind: "series",
        label: "sales",
        points: [
          { x, y: 4 },
          { x: "2025", y: 5 },
        ],
        chunkIds: [C1],
        ordinal: 0,
      }) as const;
    // "2024-01 Q3 2031" is not a date with a time, so every number in it is checked: 2024, 1, 3, 2031.
    const q3 = series("2024-01 Q3 2031");
    expect(grounded(q3, one("2024, month 1 of 2031, Q3, 2025: 4 and 5"))).toBe(true);
    expect(grounded(q3, one("2024, month 1 of 2031, 2025: 4 and 5"))).toBe(false);
    // "2024-01-05 999" is checked for 2024, 1, 5, 999.
    const day = series("2024-01-05 999");
    expect(grounded(day, one("2024, 2025, month 1, day 5, 999: 4 and 5"))).toBe(true);
    expect(grounded(day, one("2024, 2025, month 1, day 5: 4 and 5"))).toBe(false);
  });
  it("grounds an ISO timestamp on its year alone", () => {
    const s = {
      kind: "series",
      label: "sales",
      points: [
        { x: "2024-01-05T10:30:00Z", y: 4 },
        { x: "2025", y: 5 },
      ],
      chunkIds: [C1],
      ordinal: 0,
    } as const;
    expect(grounded(s, one("2024 and 2025 sales were 4 and 5"))).toBe(true);
  });
  it("still requires every number of a non-date x such as Q3 2031", () => {
    const s = {
      kind: "series",
      label: "sales",
      points: [
        { x: "Q3 2031", y: 4 },
        { x: "Q4 2031", y: 5 },
      ],
      chunkIds: [C1],
      ordinal: 0,
    } as const;
    expect(grounded(s, one("Q3 2031 sales were 4 and Q4 2031 were 5"))).toBe(true);
    expect(grounded(s, one("in 2031 sales were 4 and 5"))).toBe(false);
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

describe("StoredFact", () => {
  const C = "11111111-1111-4111-8111-111111111111";
  it("round-trips every kind of stored fact, keeping its ordinal", () => {
    const facts = [
      {
        kind: "series",
        label: "s",
        points: [
          { x: "a", y: 1 },
          { x: "b", y: 2 },
        ],
        chunkIds: [C],
        ordinal: 0,
      },
      {
        kind: "figure",
        label: "f",
        value: 3,
        compare: { label: "p", value: 2 },
        chunkIds: [C],
        ordinal: 1,
      },
      { kind: "factTable", title: "t", columns: ["a"], rows: [["1"]], chunkIds: [C], ordinal: 15 },
    ];
    for (const f of facts) expect(StoredFact.parse(f)).toEqual(f);
  });
  it("rejects an unknown key and an out-of-range ordinal", () => {
    const f = { kind: "figure", label: "f", value: 3, chunkIds: [C], ordinal: 0 };
    expect(StoredFact.safeParse({ ...f, extra: 1 }).success).toBe(false);
    expect(StoredFact.safeParse({ ...f, ordinal: 16 }).success).toBe(false);
  });
});
