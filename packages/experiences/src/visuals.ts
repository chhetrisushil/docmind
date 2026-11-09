import { type ProviderSpec, type SemanticCatalog, defineSemanticCatalog } from "@loom-ui/core";
import type { CapabilityRef } from "@loom-ui/planner";
import { DOCMIND_CATALOG, SURFACES } from "./catalog";
import { connectionsCapability } from "./connections";
import { KIND, PINS, provider } from "./providers";
import { entityMapDiagram, outlineDiagram } from "./structureShapes";

/**
 * One passage a fact was read from, resolved by the server's reader (owner-scoped, so a deleted document's passage is absent):
 * the passage (a chunk id is a passage id) and its document, and a label of title and place. Never the passage's text.
 */
export interface FactCite {
  documentId: string;
  passageId: string;
  label: string;
}

export interface OutlineFact {
  kind: "outline";
  title: string;
  nodes: { id: string; label: string; level: number; passageCount: number; firstChunkId: string }[];
  chunkIds: string[];
  ordinal: number;
}
export interface EntityMapFact {
  kind: "cooccurrence";
  entities: { name: string; entityKind: string; passages: number }[];
  edges: { a: number; b: number; weight: number; firstChunkId: string }[];
  chunkIds: string[];
  ordinal: number;
}

/** A fact the visualize step stored for a document; structurally the server's `AnyFact` (which experiences does not depend on) plus the reader's `cites`. */
export type VisualFactRaw = (
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
    }
  | OutlineFact
  | EntityMapFact
) & { cites?: readonly FactCite[] };

const ENTRIES = [
  ["FigureChart", "BarChart"],
  ["FigureTrend", "TimeSeries"],
  ["KeyFigure", "Kpi"],
  ["FactTable", "Table"],
  ["RelatedDocuments", "Table"],
  ["ConnectionMap", "Diagram"],
  ["DocumentOutline", "Diagram"],
  ["EntityMap", "Diagram"],
] as const;
const PROPS: Record<string, string[]> = {
  BarChart: ["unit", "format"],
  TimeSeries: ["unit", "format"],
  Kpi: ["unit", "format"],
  Table: [],
  Diagram: ["timeFormat"],
};

const catalogOf = (id: string, names: readonly string[]): SemanticCatalog =>
  defineSemanticCatalog({
    id,
    entries: ENTRIES.filter(([name]) => names.includes(name)).map(([name, kind]) => ({
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

const FACT_ENTRY_NAMES = ["FigureChart", "FigureTrend", "KeyFigure", "FactTable"];

/** The closed set of widgets the document planner may bind: to the document's facts, and to its live connections. */
export const VISUALS_CATALOG: SemanticCatalog = catalogOf(
  "docmind.visuals.v3",
  ENTRIES.map(([name]) => name),
);

/**
 * The fact widgets alone: what the chat-turn planner is given (K7), so a turn can never be planned a connections widget.
 * Connections belong to a document's own page. Its id and entries are exactly the catalogue chat always had (loom-ui keys a
 * planner decision on catalogue id and content), so recorded chat turns still replay. A stored head carries no catalogue id:
 * compile checks node types against the catalogue it is given, so heads planned under the old document catalogue still serve.
 */
export const FACT_VISUALS_CATALOG: SemanticCatalog = catalogOf(
  "docmind.visuals.v1",
  FACT_ENTRY_NAMES,
);

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
  declaredToolClasses: {
    "docmind:visual.facts": "sensitive",
    "docmind:doc.connections": "sensitive",
  },
} as const;
const TOOL = "visual.facts" as const;

export type FactOrigin = { kind: "doc"; documentId: string } | { kind: "turn" };
export interface OfferedFact {
  fact: VisualFactRaw;
  origin: FactOrigin;
}
type FactTool = "visual.facts" | "turn.facts";

const depthOf = (f: OutlineFact) => Math.max(1, ...f.nodes.map((n) => n.level));
const describeFact = (f: VisualFactRaw) =>
  f.kind === "series"
    ? "a series of numbers from the document"
    : f.kind === "figure"
      ? "one headline figure"
      : f.kind === "outline"
        ? `a tree of ${f.nodes.length} ${f.nodes.length === 1 ? "section" : "sections"}, ${depthOf(f)} ${depthOf(f) === 1 ? "level" : "levels"} deep`
        : f.kind === "cooccurrence"
          ? `${f.entities.length} named parties and ${f.edges.length} links between those that appear together`
          : "a table of facts";

/** Neutral stand-ins for a structure fact's nodes and edges: shape only, no document text. They let the planner's JSONPath over the sample (`nodes`, `edges`) select something. */
const OUTLINE_PLACEHOLDER = [
  { label: "Section", level: 1 },
  { label: "Subsection", level: 2 },
];
const MAP_PLACEHOLDER = {
  nodes: [
    { label: "Entity", group: "person" },
    { label: "Entity", group: "organization" },
  ],
  edges: [{ from: "e0", to: "e1", label: "2" }],
};
/** What the planner is shown of a fact: extracted facts show themselves; a structure fact shows counts and placeholders only. */
const sampleOf = (f: VisualFactRaw): unknown =>
  f.kind === "outline"
    ? { kind: "outline", sections: f.nodes.length, levels: depthOf(f), nodes: OUTLINE_PLACEHOLDER }
    : f.kind === "cooccurrence"
      ? {
          kind: "cooccurrence",
          entities: f.entities.length,
          links: f.edges.length,
          ...MAP_PLACEHOLDER,
        }
      : f;

/** The one capability shape of every fact: only the handle, the tool and the pin differ. */
function capability(f: VisualFactRaw, handle: string, tool: FactTool, pin: string): CapabilityRef {
  return {
    handle,
    kind: KIND,
    toolName: tool,
    toolVersion: "1.0.0",
    toolSchemaHash: pin,
    description: describeFact(f),
    sampleOutput: sampleOf(f),
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

/** What the document planner is offered: one capability per stored fact, then the live connections (always, even with no facts). */
export const visualCapabilities = (facts: readonly VisualFactRaw[]): CapabilityRef[] => [
  ...capabilitiesOf(facts),
  connectionsCapability(),
];

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
  declaredToolClasses: {
    "docmind:visual.facts": "sensitive",
    "docmind:turn.facts": "sensitive",
  },
} as const;

export type VisualEntry =
  | "FigureChart"
  | "FigureTrend"
  | "KeyFigure"
  | "FactTable"
  | "DocumentOutline"
  | "EntityMap";
const FAMILY: Record<VisualEntry, string> = {
  FigureChart: "visual-bar",
  FigureTrend: "visual-trend",
  KeyFigure: "visual-kpi",
  FactTable: "visual-table",
  DocumentOutline: "visual-outline",
  EntityMap: "visual-entitymap",
};
/** The reserved ordinal each structure entry reads (the server's `OUTLINE_ORDINAL` and `ENTITY_MAP_ORDINAL`: experiences does not import the server; a server test pins them equal). */
const STRUCTURE_ORDINAL: Partial<Record<VisualEntry, number>> = {
  DocumentOutline: 16,
  EntityMap: 17,
};
/** True when `entry` may read the fact at `ordinal`: a structure entry only its own reserved ordinal, any other entry the extracted ones (0..15). */
export const entryFitsOrdinal = (entry: string, ordinal: number): boolean => {
  const own = STRUCTURE_ORDINAL[entry as VisualEntry];
  return own !== undefined
    ? ordinal === own
    : Number.isInteger(ordinal) && ordinal >= 0 && ordinal < MAX_VISUAL_FACTS;
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
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_LABEL =
  /^(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?[\s-]+(\d{4})$/i;
const ym = (y: string, m: number) => `${y}-${String(m).padStart(2, "0")}`;
type Granularity = "year" | "half" | "quarter" | "month" | "week" | "day" | "datetime";
/** Coarsest first: a trend with mixed labels is drawn at the coarsest granularity any point has. */
const COARSE_FIRST: readonly Granularity[] = [
  "year",
  "half",
  "quarter",
  "month",
  "week",
  "day",
  "datetime",
];
/** A period label ("Q1 2026", "H2 2026", "2026", "Mar 2026") as the ISO month it starts, with the granularity it was written at; an ISO date or anything unknown comes back as it was (a date is a "day", a bare ISO month a "month"). */
const toIso = (raw: string): { iso: string; granularity: Granularity } => {
  const x = raw.trim();
  const q = /^(?:q([1-4])[\s-]+(\d{4})|(\d{4})[\s-]+q([1-4]))$/i.exec(x);
  if (q)
    return {
      iso: ym((q[2] ?? q[3]) as string, (Number(q[1] ?? q[4]) - 1) * 3 + 1),
      granularity: "quarter",
    };
  const h = /^(?:h([12])[\s-]+(\d{4})|(\d{4})[\s-]+h([12]))$/i.exec(x);
  if (h)
    return {
      iso: ym((h[2] ?? h[3]) as string, Number(h[1] ?? h[4]) === 1 ? 1 : 7),
      granularity: "half",
    };
  if (/^\d{4}$/.test(x)) return { iso: ym(x, 1), granularity: "year" };
  const m = MONTH_LABEL.exec(x);
  const month = m ? MONTHS.indexOf((m[1] as string).slice(0, 3).toLowerCase()) : -1;
  if (m && month >= 0) return { iso: ym(m[2] as string, month + 1), granularity: "month" };
  return { iso: x, granularity: /^\d{4}-\d{2}$/.test(x) ? "month" : "day" };
};
/**
 * A trend's points in date order, or null. Every label must be a date and no two may fall on the same instant (mixed
 * granularities can collide, e.g. "2024" and "2024-01"). Reports often list periods newest first, so the points are sorted
 * oldest first rather than refused.
 */
const chronological = <P extends { x: string }>(
  points: readonly P[],
): (P & { iso: string; granularity: Granularity })[] | null => {
  const dated = points.map((p) => ({ ...p, ...toIso(p.x) }));
  if (!dated.every((p) => isDate(p.iso))) return null;
  const sorted = [...dated].sort((a, b) => Date.parse(a.iso) - Date.parse(b.iso));
  return sorted.every(
    (p, i) => i === 0 || Date.parse(p.iso) > Date.parse((sorted[i - 1] as { iso: string }).iso),
  )
    ? sorted
    : null;
};
const coarsest = (points: readonly { granularity: Granularity }[]): Granularity =>
  COARSE_FIRST.find((g) => points.some((p) => p.granularity === g)) ?? "day";
const unitOf = (f: { unit?: string }) => (f.unit ? { unit: f.unit } : {});
/** loom-ui's "%" format reads a fraction (0.38 prints 38%), while facts hold the document's form (38 for "38%"). */
const isPercent = (unit: string | undefined) => unit?.trim() === "%";
const toLoom = (f: { unit?: string }, n: number) => (isPercent(f.unit) ? n / 100 : n);
const decimalsOf = (n: number) => {
  const s = String(n);
  return s.includes("e") ? 4 : (s.split(".")[1]?.length ?? 0);
};
/** loom-ui's percent style rounds to whole percents by default, so a "%" fact states the most decimals any of its stored values has (at most 4). */
const formatOf = (f: { unit?: string }, values: number[]) =>
  isPercent(f.unit)
    ? {
        format: {
          semanticType: "percentage",
          maximumFractionDigits: Math.min(4, Math.max(0, ...values.map(decimalsOf))),
        },
      }
    : {};
const MAX_REFS = 16; // loom-ui's MAX_WIDGET_REFS
const MAX_REF_LABEL = 200; // loom-ui's MAX_WIDGET_REF_LABEL
/** A ref id is `<documentId>:<passageId>` (73 characters, inside loom-ui's id rule); the web reads both halves back from it. */
export const refIdOf = (c: { documentId: string; passageId: string }) =>
  `${c.documentId}:${c.passageId}`;
/** A fact's citations as loom-ui source markers: in the fact's order, one per passage, at most 16; nothing at all when there are none. */
const refsOf = (f: VisualFactRaw) => {
  const seen = new Set<string>();
  const refs: { id: string; label: string }[] = [];
  for (const c of f.cites ?? []) {
    const id = refIdOf(c);
    if (seen.has(id) || refs.length >= MAX_REFS) continue;
    seen.add(id);
    refs.push({ id, label: c.label.slice(0, MAX_REF_LABEL) });
  }
  return refs.length > 0 ? { refs } : {};
};
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
          ...formatOf(f, [f.value]),
          ...refsOf(f),
          ...(f.compare &&
            f.compare.value !== 0 && {
              deltaPct: (f.value - f.compare.value) / Math.abs(f.compare.value),
            }),
        },
  "visual-bar": (f) =>
    f.kind !== "series"
      ? wrong()
      : {
          ...unitOf(f),
          ...formatOf(
            f,
            f.points.map((p) => p.y),
          ),
          bars: f.points.map((p) => ({ label: p.x, value: toLoom(f, p.y) })),
          ...refsOf(f),
        },
  "visual-trend": (f) => {
    const points = f.kind === "series" ? chronological(f.points) : null;
    return f.kind !== "series" || points === null
      ? wrong()
      : {
          timeFormat: { granularity: coarsest(points) },
          ...refsOf(f),
          series: [
            {
              label: f.label,
              ...unitOf(f),
              ...formatOf(
                f,
                f.points.map((p) => p.y),
              ),
              points: points.map((p) => ({ timestamp: p.iso, value: toLoom(f, p.y) })),
            },
          ],
        };
  },
  "visual-table": (f) =>
    f.kind !== "factTable" ? wrong() : { columns: f.columns, rows: f.rows, ...refsOf(f) },
  "visual-outline": (f) => {
    const v = f.kind === "outline" ? outlineDiagram(f) : null;
    return v === null ? wrong() : { ...v, ...refsOf(f) };
  },
  "visual-entitymap": (f) => {
    const v = f.kind === "cooccurrence" ? entityMapDiagram(f) : null;
    return v === null ? wrong() : { ...v, ...refsOf(f) };
  },
};

/**
 * True when `fact` fits the widget `entry` (a catalogue entry name): it runs the very reshaper the hydration runs, so it
 * is true exactly when hydration would not throw `reshape-failed`. A missing fact fits nothing; an entry that binds no
 * fact (a connections widget) has no opinion and fits. Pure, and never reads the fact's text into an error.
 */
export function fitsShape(entry: string, fact: VisualFactRaw | undefined): boolean {
  const family = FAMILY[entry as VisualEntry];
  if (family === undefined) return true;
  if (fact === undefined) return false;
  try {
    (TO[family] as (f: VisualFactRaw) => unknown)(fact);
    return true;
  } catch {
    return false;
  }
}

/** The ordinals a reshaper family serves: an extracted-fact family 0..15, a structure family exactly its reserved one. */
const ordinalsOf = (family: string): number[] => {
  const entry = (Object.keys(FAMILY) as VisualEntry[]).find((e) => FAMILY[e] === family);
  const own = entry === undefined ? undefined : STRUCTURE_ORDINAL[entry];
  return own !== undefined ? [own] : Array.from({ length: MAX_VISUAL_FACTS }, (_, n) => n);
};

export const VISUAL_SHAPES: Record<string, (raw: never) => unknown> = Object.fromEntries(
  Object.entries(TO).flatMap(([family, to]) =>
    ordinalsOf(family).map((n) => [
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
