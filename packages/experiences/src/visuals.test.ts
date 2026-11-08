import {
  TimeSeriesValue,
  checkKindValue,
  effectiveFormat,
  formatSemanticNumber,
  formatTimeLabel,
  isTimeFormat,
  widgetRefProblems,
} from "@loom-ui/core";
import { describe, expect, it, vi } from "vitest";
import { INVOKE_ID, createInvoker } from "./invoker";
import { PINS } from "./providers";
import { shape as shapeOf } from "./reshapers";
import {
  VISUALS_CATALOG,
  VISUAL_SHAPES,
  type VisualFactRaw,
  capabilitiesOf,
  factCapabilities,
  factProvider,
  factRefOfPin,
} from "./visuals";

const FIGURE: VisualFactRaw = {
  kind: "figure",
  label: "Revenue",
  value: 1200,
  unit: "EUR",
  chunkIds: [],
  ordinal: 0,
};
const SERIES: VisualFactRaw = {
  kind: "series",
  label: "Counts",
  points: [
    { x: "Q1", y: 1 },
    { x: "Q2", y: 2 },
  ],
  chunkIds: [],
  ordinal: 1,
};
const DATED_SERIES: VisualFactRaw = {
  kind: "series",
  label: "Users",
  points: [
    { x: "2024-01-01", y: 3 },
    { x: "2024-02-01", y: 4 },
  ],
  chunkIds: [],
  ordinal: 2,
};
const TABLE: VisualFactRaw = {
  kind: "factTable",
  title: "Dues",
  columns: ["Party", "Due"],
  rows: [["Acme", "2025-01-01"]],
  chunkIds: [],
  ordinal: 3,
};

const shape = (name: string, raw: VisualFactRaw[]) => shapeOf(name, raw);

describe("the visuals catalogue", () => {
  it("resolves every entry on web and terminal to a framework kind", () => {
    for (const e of VISUALS_CATALOG.entries) {
      expect(Object.keys(e.surfaces).sort()).toEqual(["terminal", "web"]);
      expect(e.binding).toBe("required");
    }
    expect(
      VISUALS_CATALOG.entries.map((e) => [e.name, (e.surfaces.web as { kind: string }).kind]),
    ).toEqual([
      ["FigureChart", "BarChart"],
      ["FigureTrend", "TimeSeries"],
      ["KeyFigure", "Kpi"],
      ["FactTable", "Table"],
    ]);
  });
  it("gives one bindable, classed capability per fact", () => {
    const caps = capabilitiesOf([FIGURE, SERIES]);
    expect(caps.map((c) => c.handle)).toEqual(["fact-0", "fact-1"]);
    expect(
      caps.every(
        (c) =>
          c.kind === "docmind" &&
          c.toolName === "visual.facts" &&
          c.toolSchemaHash === `docmind:visual.facts@1#fact-${c.handle.slice(5)}` &&
          c.sensitivity === "sensitive" &&
          c.sampleOutput !== undefined,
      ),
    ).toBe(true);
  });
  it("builds a provider for the fact's handle, reshaper and document", () => {
    const p = factProvider(2, "d", "KeyFigure");
    expect(p.handle).toBe("fact-2");
    expect(p.reshaping).toMatchObject({ scriptRef: "visual-kpi-2" });
    expect(p.executionGraph[0]).toMatchObject({
      toolName: "visual.facts",
      arguments: { id: "d" },
      toolSchemaHash: PINS["visual.facts"],
    });
  });
});

describe("the visual reshapers", () => {
  const raw = [FIGURE, SERIES, DATED_SERIES, TABLE];
  it("map a fact to its kind's value contract", () => {
    expect(shape("visual-kpi-0", raw)).toEqual({ value: 1200, unit: "EUR" });
    expect(shape("visual-bar-1", raw)).toEqual({
      bars: [
        { label: "Q1", value: 1 },
        { label: "Q2", value: 2 },
      ],
    });
    expect(shape("visual-trend-2", raw)).toEqual({
      timeFormat: { granularity: "day" },
      series: [
        {
          label: "Users",
          points: [
            { timestamp: "2024-01-01", value: 3 },
            { timestamp: "2024-02-01", value: 4 },
          ],
        },
      ],
    });
    expect(shape("visual-table-3", raw)).toEqual({
      columns: ["Party", "Due"],
      rows: [["Acme", "2025-01-01"]],
    });
    expect(shape("visual-bar-2", raw)).toEqual({
      bars: [
        { label: "2024-01-01", value: 3 },
        { label: "2024-02-01", value: 4 },
      ],
    });
  });
  it("carry no fact label on a KPI value: the planner's title already names it", () => {
    expect(shape("visual-kpi-0", [FIGURE])).not.toHaveProperty("label");
  });
  it("hand loom-ui a fraction for a percent unit, so a stored 38% renders 38%", () => {
    const pctFigure: VisualFactRaw = { ...FIGURE, value: 38, unit: "%" };
    const pctSeries: VisualFactRaw = {
      ...DATED_SERIES,
      unit: "%",
      points: [
        { x: "2024-01", y: 41 },
        { x: "2024-02", y: 46 },
      ],
    };
    const kpi = shape("visual-kpi-0", [pctFigure]) as {
      value: number;
      unit: string;
    };
    expect(kpi.value).toBeCloseTo(0.38);
    expect(kpi.unit).toBe("%");
    const say = (v: number, unit: string) =>
      formatSemanticNumber(v, effectiveFormat(undefined, unit), "en-US");
    expect(say(kpi.value, kpi.unit)).toBe("38%");
    const bars = shape("visual-bar-2", [pctFigure, SERIES, pctSeries]) as {
      bars: { value: number }[];
    };
    expect(bars.bars.map((b) => b.value)).toEqual([0.41, 0.46]);
    const trend = shape("visual-trend-2", [pctFigure, SERIES, pctSeries]) as {
      series: { points: { value: number }[] }[];
    };
    expect(trend.series[0]?.points.map((p) => p.value)).toEqual([0.41, 0.46]);
    // Non-percent units are untouched.
    expect((shape("visual-kpi-0", [FIGURE]) as { value: number }).value).toBe(1200);
  });
  it("treat only YYYY-MM or YYYY-MM-DD as a date for the trend", () => {
    const series = (x: string): VisualFactRaw => ({
      ...DATED_SERIES,
      points: [{ x, y: 1 }],
    });
    expect(() => shape("visual-trend-2", [FIGURE, SERIES, series("2024-01-xyz")])).toThrow();
    expect(() => shape("visual-trend-2", [FIGURE, SERIES, series("2024-01")])).not.toThrow();
  });
  it("declare the trend's time axis at the granularity its labels were written in", () => {
    const xs = (labels: string[]): VisualFactRaw => ({
      ...DATED_SERIES,
      points: labels.map((x, i) => ({ x, y: i })),
    });
    const trend = (labels: string[]) =>
      shape("visual-trend-2", [FIGURE, SERIES, xs(labels)]) as {
        timeFormat: { granularity: string; timeZone?: string };
        series: { points: { timestamp: string }[] }[];
      };
    const grain = (labels: string[]) => trend(labels).timeFormat;
    expect(grain(["2025", "2026"])).toEqual({ granularity: "year" });
    expect(grain(["H1 2026", "H2 2026"])).toEqual({ granularity: "half" });
    expect(grain(["Q1 2026", "Q2 2026"])).toEqual({ granularity: "quarter" });
    expect(grain(["Mar 2026", "Apr 2026"])).toEqual({ granularity: "month" });
    expect(grain(["2026-03", "2026-04"])).toEqual({ granularity: "month" });
    expect(grain(["2026-03-01", "2026-03-02"])).toEqual({ granularity: "day" });
    // Mixed labels are drawn at the coarsest granularity any point has.
    expect(grain(["2026-03-05", "Q2 2026", "2027-01-01"])).toEqual({ granularity: "quarter" });
    expect(grain(["Mar 2026", "2027", "2028-05-01"])).toEqual({ granularity: "year" });
    expect(grain(["2026-03-05", "2026-04"])).toEqual({ granularity: "month" });
    // Each declared granularity reads as the label it came from, through loom-ui's own formatter.
    const words = (key: string, v: Readonly<Record<string, string | number>>) =>
      key === "lu.time.quarter" ? `Q${v.n} ${v.year}` : `H${v.n} ${v.year}`;
    const say = (labels: string[]) => {
      const t = trend(labels);
      return t.series[0]?.points.map((p) =>
        formatTimeLabel(p.timestamp, t.timeFormat as never, "en-US", words as never),
      );
    };
    expect(say(["Q1 2026", "Q2 2026", "Q3 2026", "Q4 2026"])).toEqual([
      "Q1 2026",
      "Q2 2026",
      "Q3 2026",
      "Q4 2026",
    ]);
    expect(say(["H1 2026", "H2 2026"])).toEqual(["H1 2026", "H2 2026"]);
    expect(say(["2025", "2026"])).toEqual(["2025", "2026"]);
    expect(say(["Jan 2026", "Feb 2026"])).toEqual(["Jan 2026", "Feb 2026"]);
    expect(say(["2026-01-05", "2026-01-06"])).toEqual(["Jan 5, 2026", "Jan 6, 2026"]);
    // The value passes loom-ui's TimeSeries contract and the declared format is a TimeFormat.
    const t = trend(["Q1 2026", "Q2 2026"]);
    expect(isTimeFormat(t.timeFormat)).toBe(true);
    expect(TimeSeriesValue.safeParse(t).success).toBe(true);
    expect(checkKindValue("TimeSeries", t)).toEqual({ ok: true });
  });
  it("normalise quarter, half, year and month labels to ISO dates for the trend", () => {
    const xs = (labels: string[]): VisualFactRaw => ({
      ...DATED_SERIES,
      points: labels.map((x, i) => ({ x, y: i })),
    });
    const stamps = (labels: string[]) =>
      (
        shape("visual-trend-2", [FIGURE, SERIES, xs(labels)]) as {
          series: { points: { timestamp: string }[] }[];
        }
      ).series[0]?.points.map((p) => p.timestamp);
    expect(stamps(["Q1 2026", "q2 2026", "2026 Q3", "Q4-2026", "2027-q1"])).toEqual([
      "2026-01",
      "2026-04",
      "2026-07",
      "2026-10",
      "2027-01",
    ]);
    expect(stamps(["H1 2026", "h2 2026", "2027 H1"])).toEqual(["2026-01", "2026-07", "2027-01"]);
    expect(stamps(["2025", "2026"])).toEqual(["2025-01", "2026-01"]);
    expect(stamps(["Jan 2026", "Sept 2026", "December 2026", "march 2027"])).toEqual([
      "2026-01",
      "2026-09",
      "2026-12",
      "2027-03",
    ]);
    expect(stamps(["2024-01", "Q2 2024", "2025"])).toEqual(["2024-01", "2024-04", "2025-01"]);
    expect(stamps(["Jun. 2026", "Sep-2026"])).toEqual(["2026-06", "2026-09"]);
    // Reports often list periods newest first: the points are drawn oldest first.
    expect(stamps(["2026", "2025", "2024"])).toEqual(["2024-01", "2025-01", "2026-01"]);
    expect(stamps(["Q1 2026", "2025-12-31"])).toEqual(["2025-12-31", "2026-01"]);
    const newestFirst = shape("visual-trend-2", [FIGURE, SERIES, xs(["2026", "2025", "2024"])]) as {
      series: { points: { timestamp: string; value: number }[] }[];
    };
    // Each value stays with its own period (xs gives the first label y 0, the second 1, the third 2).
    expect(newestFirst.series[0]?.points).toEqual([
      { timestamp: "2024-01", value: 2 },
      { timestamp: "2025-01", value: 1 },
      { timestamp: "2026-01", value: 0 },
    ]);
    // Labels that fall on the same instant (mixed granularities collide) are not a trend.
    expect(() => stamps(["2024-01", "Q2 2024", "2024"])).toThrow();
    expect(() => stamps(["2026-01", "2026-01"])).toThrow();
    expect(() => stamps(["Q1 2026", "next spring"])).toThrow();
    expect(() => stamps(["Q5 2026"])).toThrow();
    expect(() => stamps(["Q1"])).toThrow();
  });
  it("read only real English month names as a month label", () => {
    const trend = (x: string) =>
      shape("visual-trend-2", [FIGURE, SERIES, { ...DATED_SERIES, points: [{ x, y: 1 }] }]);
    for (const bad of ["Junk 2026", "Octopus 2026", "mayhem 2026", "Marvel 2026"])
      expect(() => trend(bad), bad).toThrow();
    for (const good of ["Sept 2026", "September 2026", "Jun. 2026", "MAY 2026"])
      expect(() => trend(good), good).not.toThrow();
  });
  it("state the decimals a percent fact needs, so loom-ui does not round to whole percents", () => {
    const say = (v: number, f: unknown) =>
      formatSemanticNumber(v, effectiveFormat(f as never, "%"), "en-US");
    const fig = (value: number) =>
      shape("visual-kpi-0", [{ ...FIGURE, value, unit: "%" }]) as {
        value: number;
        format: unknown;
      };
    for (const [n, text] of [
      [38.5, "38.5%"],
      [0.38, "0.38%"],
      [38, "38%"],
    ] as const) {
      const k = fig(n);
      expect(say(k.value, k.format), String(n)).toBe(text);
    }
    const ser = {
      ...DATED_SERIES,
      unit: "%",
      points: [
        { x: "2024-01", y: 41 },
        { x: "2024-02", y: 46.25 },
      ],
    };
    const bars = shape("visual-bar-2", [FIGURE, SERIES, ser]) as {
      bars: { value: number }[];
      format: unknown;
    };
    expect(bars.bars.map((b) => say(b.value, bars.format))).toEqual(["41%", "46.25%"]);
    const trend = shape("visual-trend-2", [FIGURE, SERIES, ser]) as {
      series: { format: unknown; points: { value: number }[] }[];
    };
    expect(trend.series[0]?.points.map((p) => say(p.value, trend.series[0]?.format))).toEqual([
      "41%",
      "46.25%",
    ]);
    expect(fig(1.123456).format).toMatchObject({ maximumFractionDigits: 4 });
    expect(shape("visual-kpi-0", [FIGURE])).not.toHaveProperty("format");
    // A unit with stray whitespace is still a percent.
    expect(shape("visual-kpi-0", [{ ...FIGURE, value: 38, unit: " % " }])).toMatchObject({
      value: 0.38,
    });
  });
  it("fail for a fact of the wrong kind or a missing fact", () => {
    expect(() => shape("visual-trend-1", raw)).toThrow();
    expect(() => shape("visual-kpi-1", raw)).toThrow();
    expect(() => shape("visual-kpi-9", raw)).toThrow();
  });
  it("carry a compare as deltaPct, a fraction", () => {
    expect(
      shape("visual-kpi-0", [{ ...FIGURE, compare: { label: "2023", value: 1000 } }]),
    ).toMatchObject({ deltaPct: 0.2 });
  });
  it("register all 64 names", () => {
    expect(Object.keys(VISUAL_SHAPES)).toHaveLength(64);
    for (const f of ["bar", "trend", "kpi", "table"])
      for (let n = 0; n < 16; n++) expect(() => shapeOf(`visual-${f}-${n}`, [])).toThrow("missing");
  });
});

describe("the visual.facts invoker target", () => {
  const readers = (visualFacts: () => Promise<VisualFactRaw[] | null>) =>
    ({ visualFacts }) as never;
  const id = "00000000-0000-4000-8000-000000000001";
  it("reads once for the same document, through the memo", async () => {
    const visualFacts = vi.fn(async () => [FIGURE]);
    const inv = createInvoker(readers(visualFacts));
    const input = { target: "visual.facts", args: { id } };
    await inv.invokeTransient(INVOKE_ID, input);
    await inv.invokeTransient(INVOKE_ID, {
      target: "visual.facts",
      args: { id: id.toUpperCase() },
    });
    expect(visualFacts).toHaveBeenCalledTimes(1);
  });
  it("maps a missing document to notFound and bad args to invalidArgs", async () => {
    const inv = createInvoker(readers(async () => null));
    await expect(
      inv.invokeTransient(INVOKE_ID, { target: "visual.facts", args: { id } }),
    ).rejects.toMatchObject({ channel: "notFound" });
    await expect(
      inv.invokeTransient(INVOKE_ID, {
        target: "visual.facts",
        args: { id: "x" },
      }),
    ).rejects.toMatchObject({ channel: "invalidArgs" });
  });
});

describe("factCapabilities", () => {
  const A = "00000000-0000-4000-8000-00000000000a";
  const B = "00000000-0000-4000-8000-00000000000b";
  const figure = (ordinal: number): VisualFactRaw => ({
    kind: "figure",
    label: "Revenue",
    value: 1200,
    chunkIds: [A],
    ordinal,
  });

  it("gives facts of two documents with the same ordinal distinct handles and pins", () => {
    const caps = factCapabilities([
      { fact: figure(0), origin: { kind: "doc", documentId: A } },
      { fact: figure(0), origin: { kind: "doc", documentId: B } },
      { fact: figure(1), origin: { kind: "turn" } },
    ]);
    expect(caps.map((c) => c.handle)).toEqual(["fact-0", "fact-1", "fact-2"]);
    expect(caps.map((c) => [c.toolName, c.toolSchemaHash])).toEqual([
      ["visual.facts", `docmind:visual.facts@1#${A}/fact-0`],
      ["visual.facts", `docmind:visual.facts@1#${B}/fact-0`],
      ["turn.facts", "docmind:turn.facts@1#fact-1"],
    ]);
    expect(
      caps.every(
        (c) => c.sensitivity === "sensitive" && c.kind === "docmind" && c.toolVersion === "1.0.0",
      ),
    ).toBe(true);
  });

  it("leaves sub-project 1's capabilities exactly as they were", () => {
    const [c] = capabilitiesOf([figure(3)]);
    expect(c).toMatchObject({
      handle: "fact-3",
      toolName: "visual.facts",
      toolSchemaHash: "docmind:visual.facts@1#fact-3",
    });
  });

  it("reads each pin kind back, and refuses anything else", () => {
    expect(factRefOfPin("visual.facts", "docmind:visual.facts@1#fact-4")).toEqual({
      kind: "detail",
      ordinal: 4,
    });
    expect(factRefOfPin("visual.facts", `docmind:visual.facts@1#${A}/fact-2`)).toEqual({
      kind: "doc",
      documentId: A,
      ordinal: 2,
    });
    expect(factRefOfPin("turn.facts", "docmind:turn.facts@1#fact-7")).toEqual({
      kind: "turn",
      ordinal: 7,
    });
    for (const [tool, pin] of [
      ["visual.facts", `docmind:visual.facts@1#${A.toUpperCase()}/fact-2`],
      ["visual.facts", `docmind:visual.facts@1#${A}/fact-02`],
      ["visual.facts", "docmind:turn.facts@1#fact-1"],
      ["turn.facts", `docmind:turn.facts@1#${A}/fact-1`],
      ["turn.facts", "docmind:turn.facts@2#fact-1"],
      ["document.get", "docmind:document.get@1"],
      // hostile: a trailing newline, an ordinal of three digits, a mixed-case document id
      ["visual.facts", "docmind:visual.facts@1#fact-1\n"],
      ["visual.facts", `docmind:visual.facts@1#${A}/fact-1\n`],
      ["turn.facts", "docmind:turn.facts@1#fact-1\n"],
      ["visual.facts", "docmind:visual.facts@1#fact-100"],
      ["visual.facts", `docmind:visual.facts@1#${A}/fact-100`],
      ["turn.facts", "docmind:turn.facts@1#fact-100"],
      ["visual.facts", `docmind:visual.facts@1#${A.slice(0, -1)}A/fact-1`],
    ] as const)
      expect(factRefOfPin(tool, pin), pin).toBeNull();
  });
});

describe("the visual reshapers: source references", () => {
  const D = "0b4f7d52-6c53-4c6e-9d49-2b0e7a3f9a10";
  const P = (n: number) => `7f6d1b8e-3b0a-4a56-8f2f-${String(n).padStart(12, "0")}`;
  const cite = (n: number, label = `Report, Page ${n}`) => ({
    documentId: D,
    passageId: P(n),
    label,
  });
  const withCites = (f: VisualFactRaw, cites: ReturnType<typeof cite>[]): VisualFactRaw => ({
    ...f,
    cites,
  });
  const refsOf = (family: string, f: VisualFactRaw) =>
    (shape(`${family}-${f.ordinal}`, [f]) as { refs?: { id: string; label?: string }[] }).refs;

  it("each of the four widgets carries its fact's citations as refs, id = <documentId>:<passageId>", () => {
    const cites = [cite(1), cite(2)];
    const want = [
      { id: `${D}:${P(1)}`, label: "Report, Page 1" },
      { id: `${D}:${P(2)}`, label: "Report, Page 2" },
    ];
    expect(refsOf("visual-kpi", withCites(FIGURE, cites))).toEqual(want);
    expect(refsOf("visual-bar", withCites(SERIES, cites))).toEqual(want);
    expect(refsOf("visual-trend", withCites(DATED_SERIES, cites))).toEqual(want);
    expect(refsOf("visual-table", withCites(TABLE, cites))).toEqual(want);
  });
  it("keeps order, folds a repeated passage, and caps at 16", () => {
    expect(
      refsOf("visual-kpi", withCites(FIGURE, [cite(3), cite(1), cite(3), cite(2)]))?.map(
        (r) => r.id,
      ),
    ).toEqual([P(3), P(1), P(2)].map((p) => `${D}:${p}`));
    const many = Array.from({ length: 30 }, (_, i) => cite(i + 1));
    expect(refsOf("visual-kpi", withCites(FIGURE, many))).toHaveLength(16);
  });
  it("omits refs when there is nothing to cite (none resolved, or an unresolved fact)", () => {
    expect(shape("visual-kpi-0", [FIGURE])).not.toHaveProperty("refs");
    expect(shape("visual-kpi-0", [withCites(FIGURE, [])])).not.toHaveProperty("refs");
  });
  it("never carries anything but the id and the label, and the value passes loom-ui's ref rules", () => {
    const f = withCites(FIGURE, [cite(1), cite(2, "x".repeat(300))]);
    const refs = refsOf("visual-kpi", f) as { id: string; label?: string }[];
    expect(refs.map((r) => Object.keys(r).sort())).toEqual([
      ["id", "label"],
      ["id", "label"],
    ]);
    expect((refs[1] as { label: string }).label.length).toBeLessThanOrEqual(200);
    expect(widgetRefProblems(refs)).toEqual([]);
    for (const r of refs) expect(r.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
    for (const [family, fact] of [
      ["visual-kpi", FIGURE],
      ["visual-bar", SERIES],
      ["visual-trend", DATED_SERIES],
      ["visual-table", TABLE],
    ] as const) {
      const kind = {
        "visual-kpi": "Kpi",
        "visual-bar": "BarChart",
        "visual-trend": "TimeSeries",
        "visual-table": "Table",
      }[family];
      const v = shape(`${family}-${fact.ordinal}`, [withCites(fact, [cite(1)])]);
      expect(checkKindValue(kind, v)).toMatchObject({ ok: true });
    }
  });
});
