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
