import { describe, expect, it, vi } from "vitest";
import { INVOKE_ID, createInvoker } from "./invoker";
import { PINS } from "./providers";
import { shape as shapeOf } from "./reshapers";
import {
  VISUALS_CATALOG,
  VISUAL_SHAPES,
  type VisualFactRaw,
  capabilitiesOf,
  factProvider,
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
    expect(shape("visual-kpi-0", raw)).toEqual({ value: 1200, unit: "EUR", label: "Revenue" });
    expect(shape("visual-bar-1", raw)).toEqual({
      bars: [
        { label: "Q1", value: 1 },
        { label: "Q2", value: 2 },
      ],
    });
    expect(shape("visual-trend-2", raw)).toEqual({
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
  it("treat only YYYY-MM or YYYY-MM-DD as a date for the trend", () => {
    const series = (x: string): VisualFactRaw => ({
      ...DATED_SERIES,
      points: [{ x, y: 1 }],
    });
    expect(() => shape("visual-trend-2", [FIGURE, SERIES, series("2024-01-xyz")])).toThrow();
    expect(() => shape("visual-trend-2", [FIGURE, SERIES, series("2024-01")])).not.toThrow();
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
      inv.invokeTransient(INVOKE_ID, { target: "visual.facts", args: { id: "x" } }),
    ).rejects.toMatchObject({ channel: "invalidArgs" });
  });
});
