import { type ProviderSpec, type SemanticCatalog, defineSemanticCatalog } from "@loom-ui/core";
import type { CapabilityRef } from "@loom-ui/planner";
import { DOCMIND_CATALOG, SURFACES } from "./catalog";
import { KIND, PINS, provider } from "./providers";

/** A fact the visualize step extracted from a document; structurally the server's `Fact`, which experiences does not depend on. */
export type VisualFactRaw =
  | {
      kind: "series";
      label: string;
      unit?: string;
      points: { x: string; y: number }[];
      chunkIds: string[];
      ordinal: number;
    }
  | {
      kind: "figure";
      label: string;
      value: number;
      unit?: string;
      compare?: { label: string; value: number };
      chunkIds: string[];
      ordinal: number;
    }
  | {
      kind: "factTable";
      title: string;
      columns: string[];
      rows: string[][];
      chunkIds: string[];
      ordinal: number;
    };

const ENTRIES = [
  ["FigureChart", "BarChart"],
  ["FigureTrend", "TimeSeries"],
  ["KeyFigure", "Kpi"],
  ["FactTable", "Table"],
] as const;
const PROPS: Record<string, string[]> = {
  BarChart: ["unit", "format"],
  TimeSeries: ["unit", "format"],
  Kpi: ["unit", "format"],
  Table: [],
};

/** The closed set of widgets the planner may bind to a document's facts. */
export const VISUALS_CATALOG: SemanticCatalog = defineSemanticCatalog({
  id: "docmind.visuals.v1",
  entries: ENTRIES.map(([name, kind]) => ({
    name,
    version: "1.0.0",
    props: PROPS[kind] as string[],
    binding: "required" as const,
    surfaces: Object.fromEntries(
      SURFACES.map((s) => [
        s,
        { kind, props: PROPS[kind] as string[], binding: "required" as const },
      ]),
    ),
  })),
});

/** The static detail's catalogue plus the visuals entries, for the per-document detail. */
export const mergedCatalog = (): SemanticCatalog =>
  defineSemanticCatalog({
    id: "docmind.detail+visuals.v1",
    entries: [...DOCMIND_CATALOG.entries, ...VISUALS_CATALOG.entries],
  });

export const MAX_VISUAL_FACTS = 16;
const TOOL = "visual.facts" as const;

export function capabilitiesOf(facts: readonly VisualFactRaw[]): CapabilityRef[] {
  return facts.map((f) => ({
    handle: `fact-${f.ordinal}`,
    kind: KIND,
    toolName: TOOL,
    toolVersion: "1.0.0",
    toolSchemaHash: PINS[TOOL],
    description:
      f.kind === "series"
        ? "a series of numbers from the document"
        : f.kind === "figure"
          ? "one headline figure"
          : "a table of facts",
    sampleOutput: f,
    sensitivity: "sensitive",
  }));
}

export type VisualEntry = "FigureChart" | "FigureTrend" | "KeyFigure" | "FactTable";
const FAMILY: Record<VisualEntry, string> = {
  FigureChart: "visual-bar",
  FigureTrend: "visual-trend",
  KeyFigure: "visual-kpi",
  FactTable: "visual-table",
};

export const factProvider = (
  ordinal: number,
  documentId: string,
  entry: VisualEntry,
): ProviderSpec =>
  provider(`fact-${ordinal}`, {
    target: TOOL,
    args: { id: documentId },
    reshaper: `${FAMILY[entry]}-${ordinal}`,
  });

const isDate = (x: string) => /^\d{4}-\d{2}(-\d{2})?/.test(x);
const unitOf = (f: { unit?: string }) => (f.unit ? { unit: f.unit } : {});
const wrong = (): never => {
  throw new Error("visual fact does not fit this widget");
};

/** One value contract per family. A fact that does not fit throws, and loom-ui draws the per-widget placeholder. */
const TO: Record<string, (f: VisualFactRaw) => unknown> = {
  "visual-kpi": (f) =>
    f.kind !== "figure"
      ? wrong()
      : {
          value: f.value,
          ...unitOf(f),
          label: f.label,
          ...(f.compare &&
            f.compare.value !== 0 && {
              deltaPct: (f.value - f.compare.value) / Math.abs(f.compare.value),
            }),
        },
  "visual-bar": (f) =>
    f.kind !== "series"
      ? wrong()
      : { ...unitOf(f), bars: f.points.map((p) => ({ label: p.x, value: p.y })) },
  "visual-trend": (f) =>
    f.kind !== "series" || !f.points.every((p) => isDate(p.x))
      ? wrong()
      : {
          series: [
            {
              label: f.label,
              ...unitOf(f),
              points: f.points.map((p) => ({ timestamp: p.x, value: p.y })),
            },
          ],
        },
  "visual-table": (f) => (f.kind !== "factTable" ? wrong() : { columns: f.columns, rows: f.rows }),
};

export const VISUAL_SHAPES: Record<string, (raw: never) => unknown> = Object.fromEntries(
  Object.entries(TO).flatMap(([family, to]) =>
    Array.from({ length: MAX_VISUAL_FACTS }, (_, n) => [
      `${family}-${n}`,
      (raw: VisualFactRaw[]) => {
        const f = raw.find((x) => x.ordinal === n);
        if (!f) throw new Error("visual fact missing");
        return to(f);
      },
    ]),
  ),
);
