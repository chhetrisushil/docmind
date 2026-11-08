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

/**
 * How the per-document detail is compiled, inventoried and served (R27): for its authenticated owner, who may read
 * their own `sensitive` facts. The table is the host's read floor for the `visual.facts` tool (`toolKey`:
 * `<kind>:<name>`); it equals `declaredToolClassesFrom(capabilitiesOf(...))`. Static views are served without it.
 */
export const OWNER_READ = {
  viewer: { clearance: "sensitive" },
  audience: "viewer",
  declaredToolClasses: { "docmind:visual.facts": "sensitive" },
} as const;
const TOOL = "visual.facts" as const;

export type FactOrigin = { kind: "doc"; documentId: string } | { kind: "turn" };
export interface OfferedFact {
  fact: VisualFactRaw;
  origin: FactOrigin;
}
type FactTool = "visual.facts" | "turn.facts";

const describeFact = (f: VisualFactRaw) =>
  f.kind === "series"
    ? "a series of numbers from the document"
    : f.kind === "figure"
      ? "one headline figure"
      : "a table of facts";

/** The one capability shape of every fact: only the handle, the tool and the pin differ. */
function capability(f: VisualFactRaw, handle: string, tool: FactTool, pin: string): CapabilityRef {
  return {
    handle,
    kind: KIND,
    toolName: tool,
    toolVersion: "1.0.0",
    toolSchemaHash: pin,
    description: describeFact(f),
    sampleOutput: f,
    sensitivity: "sensitive",
  };
}

export function capabilitiesOf(facts: readonly VisualFactRaw[]): CapabilityRef[] {
  // One pin per fact: the planner mints its provider handle from the pin, so two facts never share a handle and the
  // ordinal can be read back from the committed provider (R26: the pin names the fact). The invoker still checks against `PINS[tool]`.
  return facts.map((f) =>
    capability(f, `fact-${f.ordinal}`, TOOL, `${PINS[TOOL]}#fact-${f.ordinal}`),
  );
}

/**
 * Capabilities of a chat turn's facts, which may come from several documents (stored facts) or from the turn itself
 * (extracted). Handles are indexes, because ordinals repeat across documents; the pin names the true source.
 */
export function factCapabilities(offered: readonly OfferedFact[]): CapabilityRef[] {
  return offered.map(({ fact, origin }, i) =>
    origin.kind === "doc"
      ? capability(
          fact,
          `fact-${i}`,
          "visual.facts",
          `${PINS["visual.facts"]}#${origin.documentId}/fact-${fact.ordinal}`,
        )
      : capability(fact, `fact-${i}`, "turn.facts", `${PINS["turn.facts"]}#fact-${fact.ordinal}`),
  );
}

export type FactRef =
  | { kind: "detail"; ordinal: number }
  | { kind: "doc"; documentId: string; ordinal: number }
  | { kind: "turn"; ordinal: number };

const ORD = "(0|[1-9][0-9]{0,1})";
const UUID_L = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const DETAIL_PIN = new RegExp(`^docmind:visual\\.facts@1#fact-${ORD}$`);
const DOC_PIN = new RegExp(`^docmind:visual\\.facts@1#(${UUID_L})/fact-${ORD}$`);
const TURN_PIN = new RegExp(`^docmind:turn\\.facts@1#fact-${ORD}$`);

/** The fact a committed provider step reads, from its tool and pin; null for anything this module did not mint. */
export function factRefOfPin(toolName: string, pin: string): FactRef | null {
  if (toolName === "visual.facts") {
    const d = DETAIL_PIN.exec(pin);
    if (d) return { kind: "detail", ordinal: Number(d[1]) };
    const m = DOC_PIN.exec(pin);
    return m ? { kind: "doc", documentId: m[1] as string, ordinal: Number(m[2]) } : null;
  }
  if (toolName === "turn.facts") {
    const t = TURN_PIN.exec(pin);
    return t ? { kind: "turn", ordinal: Number(t[1]) } : null;
  }
  return null;
}

/** How a chat turn's visuals are compiled, inventoried and served: for its authenticated owner (R27: hydration under the owner's `sensitive` clearance), reading both tools. */
export const TURN_READ = {
  viewer: { clearance: "sensitive" },
  audience: "viewer",
  declaredToolClasses: { "docmind:visual.facts": "sensitive", "docmind:turn.facts": "sensitive" },
} as const;

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

const isDate = (x: string) => /^\d{4}-\d{2}(-\d{2})?$/.test(x);
const unitOf = (f: { unit?: string }) => (f.unit ? { unit: f.unit } : {});
/** loom-ui's "%" format reads a fraction (0.38 prints 38%), while facts hold the document's form (38 for "38%"). */
const toLoom = (f: { unit?: string }, n: number) => (f.unit?.trim() === "%" ? n / 100 : n);
const wrong = (): never => {
  throw new Error("visual fact does not fit this widget");
};

/** One value contract per family. A fact that does not fit throws, and loom-ui draws the per-widget placeholder. */
const TO: Record<string, (f: VisualFactRaw) => unknown> = {
  "visual-kpi": (f) =>
    f.kind !== "figure"
      ? wrong()
      : {
          value: toLoom(f, f.value),
          ...unitOf(f),
          ...(f.compare &&
            f.compare.value !== 0 && {
              deltaPct: (f.value - f.compare.value) / Math.abs(f.compare.value),
            }),
        },
  "visual-bar": (f) =>
    f.kind !== "series"
      ? wrong()
      : { ...unitOf(f), bars: f.points.map((p) => ({ label: p.x, value: toLoom(f, p.y) })) },
  "visual-trend": (f) =>
    f.kind !== "series" || !f.points.every((p) => isDate(p.x))
      ? wrong()
      : {
          series: [
            {
              label: f.label,
              ...unitOf(f),
              points: f.points.map((p) => ({ timestamp: p.x, value: toLoom(f, p.y) })),
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

/** The provider of a fact read for a turn: a stored fact reads its document, an extracted one the turn. Its handle is a placeholder, as `factProvider`'s: the host experience sets the real one. */
export const turnFactProvider = (
  ref: Exclude<FactRef, { kind: "detail" }>,
  turn: { chatId: string; ord: number },
  entry: VisualEntry,
): ProviderSpec =>
  ref.kind === "doc"
    ? provider(`fact-${ref.ordinal}`, {
        target: "visual.facts",
        args: { id: ref.documentId },
        reshaper: `${FAMILY[entry]}-${ref.ordinal}`,
      })
    : provider(`fact-${ref.ordinal}`, {
        target: "turn.facts",
        args: { chatId: turn.chatId, ord: turn.ord },
        reshaper: `${FAMILY[entry]}-${ref.ordinal}`,
      });
