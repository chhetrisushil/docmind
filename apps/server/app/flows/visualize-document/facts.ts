import { z } from "zod";
import { ENTITY_KINDS } from "../../crypto/entityKeys";
import type { CooccurrenceDraft } from "./cooccurrence";
import type { OutlineDraft } from "./outline";

export const MAX_FACTS = 16;
/**
 * Extraction keeps `MAX_FACTS` (16) facts at ordinals 0..15. `visual_facts.ordinal` is 0..17 after migration 0035, and 16 and 17
 * are reserved for the derived structure facts, which are written by their own step and never collide with an extracted fact.
 */
export const STRUCTURE_ORDINAL_BASE = 16;
export const OUTLINE_ORDINAL = 16;
export const ENTITY_MAP_ORDINAL = 17;
/** The most rows one document holds: the extracted facts plus the outline and the entity map. */
export const MAX_STORED_FACTS = MAX_FACTS + 2;
const Label = z.string().trim().min(1).max(120);
const ChunkIds = z.array(z.string().uuid()).min(1).max(8);

const Series = z
  .object({
    kind: z.literal("series"),
    label: Label,
    unit: z.string().max(16).optional(),
    points: z
      .array(z.object({ x: z.string().min(1).max(40), y: z.number().finite() }))
      .min(2)
      .max(64),
    chunkIds: ChunkIds,
  })
  .strict();
const Figure = z
  .object({
    kind: z.literal("figure"),
    label: Label,
    value: z.number().finite(),
    unit: z.string().max(16).optional(),
    compare: z.object({ label: Label, value: z.number().finite() }).strict().optional(),
    chunkIds: ChunkIds,
  })
  .strict();
const Cell = z.string().max(200);
const FactTable = z
  .object({
    kind: z.literal("factTable"),
    title: Label,
    columns: z.array(Cell).min(1).max(8),
    rows: z.array(z.array(Cell).max(8)).min(1).max(12),
    chunkIds: ChunkIds,
  })
  .strict();

const StructureLabel = z.string().trim().min(1).max(80);
const PassageId = z.string().uuid();
const Count = z.number().int().min(0).max(100_000);
const Outline = z
  .object({
    kind: z.literal("outline"),
    title: StructureLabel,
    nodes: z
      .array(
        z
          .object({
            id: z.string().regex(/^s\d{1,3}$/), // "s" + the node's index: unique by position (spec 3)
            label: StructureLabel,
            level: z.number().int().min(1).max(32),
            passageCount: Count,
            firstChunkId: PassageId,
          })
          .strict(),
      )
      .min(3)
      .max(120),
    chunkIds: z.array(PassageId).min(1).max(120),
  })
  .strict();
const EntityIndex = z.number().int().min(0).max(19);
const EntityMap = z
  .object({
    kind: z.literal("cooccurrence"),
    entities: z
      .array(
        z
          .object({
            name: StructureLabel,
            entityKind: z.enum(ENTITY_KINDS),
            passages: z.number().int().min(1).max(100_000),
          })
          .strict(),
      )
      .min(3)
      .max(20),
    edges: z
      .array(
        z
          .object({
            a: EntityIndex,
            b: EntityIndex,
            weight: z.number().int().min(2).max(100_000),
            firstChunkId: PassageId,
          })
          .strict(),
      )
      .min(2)
      .max(40),
    chunkIds: z.array(PassageId).min(1).max(40),
  })
  .strict();

export const DraftFact = z.discriminatedUnion("kind", [Series, Figure, FactTable]);
export type DraftFact = z.infer<typeof DraftFact>;
export type Fact = DraftFact & { ordinal: number };
const Ordinal = z.object({ ordinal: z.number().int().min(0).max(15) });
/** A fact as stored: a draft plus its ordinal. Each member stays strict, so it is built per member, not with `.and`. */
export const StoredFact = z.discriminatedUnion("kind", [
  Series.extend(Ordinal.shape),
  Figure.extend(Ordinal.shape),
  FactTable.extend(Ordinal.shape),
]);

/** A derived fact (never extracted by a model): the document's outline or its entity map. */
export type StructureFact = (OutlineDraft | CooccurrenceDraft) & { ordinal: number };
/** Everything `visual_facts` holds for a document. */
export type AnyFact = Fact | StructureFact;
/** Structure facts have their own ordinal schema: 16 for the outline, 17 for the map. The extracted `Ordinal` (0..15) is untouched. */
const StructureOrdinal = z.object({
  ordinal: z.union([z.literal(OUTLINE_ORDINAL), z.literal(ENTITY_MAP_ORDINAL)]),
});
/** A stored row of any kind (ordinals 0..17). `StoredFact` (extracted kinds, 0..15) stays what chat reads. */
const StoredEntryUnion = z.discriminatedUnion("kind", [
  Series.extend(Ordinal.shape),
  Figure.extend(Ordinal.shape),
  FactTable.extend(Ordinal.shape),
  Outline.extend(StructureOrdinal.shape),
  EntityMap.extend(StructureOrdinal.shape),
]);
/** Also enforces the plan's edge shape on a map: `a < b < entities.length` (a union member cannot carry a refinement). */
export const StoredEntry = StoredEntryUnion.superRefine((f, ctx) => {
  if (f.kind !== "cooccurrence") return;
  f.edges.forEach((e, i) => {
    if (e.a >= e.b || e.b >= f.entities.length)
      ctx.addIssue({
        code: "custom",
        path: ["edges", i],
        message: "edge must satisfy a < b < entities.length",
      });
  });
});
export const isStructureFact = (f: { kind: string }): f is StructureFact =>
  f.kind === "outline" || f.kind === "cooccurrence";
export const ExtractAnswer = z.object({ facts: z.array(DraftFact).max(32) }).strict();

const SUFFIX: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, bn: 1e9 };
// Groups: 1 "(" open, 2 sign, 3 currency, 4 whole part, 5 decimals, 6 suffix, 7 "%", 8 ")" close.
const NUMBER =
  /(\()?([-−]\s?)?([$€£¥]\s?)?([1-9]\d{0,2}(?:[ ,.]\d{3})+|\d+)(?:[.,](\d+))?\s?(k|m|bn|b)?\b\s?(%)?(\))?/gi;

interface Read {
  /** The number as written, sign applied, before any suffix. */
  raw: number;
  /** The number with its k/m/bn/b suffix applied. */
  canonical: number;
  percent: boolean;
}

/** Every number written in `text`, signed by a leading `-`/`−` or by `(n)`, with suffixes and percent read. */
function readNumbers(text: string): Read[] {
  const out: Read[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const whole = (m[4] ?? "").replace(/[ ,.]/g, "");
    const magnitude = Number(m[5] === undefined ? whole : `${whole}.${m[5]}`);
    if (!Number.isFinite(magnitude)) continue;
    // A sign glued to a word or number ("2019-2020") is a separator, not a minus.
    const before = m.index > 0 ? text.charAt(m.index - 1) : "";
    const signed = m[2] !== undefined && !/[\p{L}\p{N}]/u.test(before);
    // "(n)" is ambiguous, so it grounds both n and -n. A leading minus means negative only.
    const parenthesised = m[1] !== undefined && m[8] !== undefined && m[2] === undefined;
    const signs = signed ? [-1] : parenthesised ? [1, -1] : [1];
    const scale = m[6] ? (SUFFIX[m[6].toLowerCase()] ?? 1) : 1;
    for (const sign of signs) {
      out.push({
        raw: sign * magnitude,
        canonical: sign * magnitude * scale,
        percent: m[7] !== undefined,
      });
    }
  }
  return out;
}

/** What a source text can ground: raw and suffix-applied values, each flagged if it was a percentage. */
function sourcePool(text: string): { value: number; percent: boolean }[] {
  return readNumbers(text).flatMap((r) => [
    { value: r.raw, percent: r.percent },
    { value: r.canonical, percent: r.percent },
  ]);
}

const NUMERIC_VALUES = (s: string): number[] => readNumbers(s).map((r) => r.canonical);

// An ISO date (YYYY-MM or YYYY-MM-DD, optional time only) grounds on its year alone.
const ISO_DATE =
  /^(\d{4})-(\d{2})(?:-(\d{2}))?(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
/** The numbers a series x value asserts. A date's month and day are not checked, only its year. */
const xNumbers = (x: string): number[] => {
  const iso = ISO_DATE.exec(x);
  return iso ? [Number(iso[1])] : NUMERIC_VALUES(x);
};

/** The numeric data of a fact: figure values, series y, and every number in table cells. */
export function numbersOf(f: DraftFact): number[] {
  switch (f.kind) {
    case "series":
      return f.points.map((p) => p.y);
    case "figure":
      return f.compare ? [f.value, f.compare.value] : [f.value];
    case "factTable":
      return f.rows.flat().flatMap(NUMERIC_VALUES);
  }
}

/** Every number the fact asserts: its data plus any number written in its label, title, columns, or x values. */
export function numbersInFact(f: DraftFact): number[] {
  switch (f.kind) {
    case "series":
      return [
        ...numbersOf(f),
        ...NUMERIC_VALUES(f.label),
        ...f.points.flatMap((p) => xNumbers(p.x)),
      ];
    case "figure":
      return [
        ...numbersOf(f),
        ...NUMERIC_VALUES(f.label),
        ...(f.compare ? NUMERIC_VALUES(f.compare.label) : []),
      ];
    case "factTable":
      return [...numbersOf(f), ...NUMERIC_VALUES(f.title), ...f.columns.flatMap(NUMERIC_VALUES)];
  }
}

const isPercent = (unit: string | undefined) => unit?.trim() === "%";
const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-6);

/** A fact is grounded only if every number it asserts appears in the text of the chunks it cites. */
export function grounded(f: DraftFact, chunkTexts: ReadonlyMap<string, string>): boolean {
  const pool = f.chunkIds.flatMap((id) => sourcePool(chunkTexts.get(id) ?? ""));
  const percentUnit = f.kind !== "factTable" && isPercent(f.unit);
  return numbersInFact(f).every((n) =>
    pool.some((p) => close(p.value, n) || (percentUnit && p.percent && close(p.value / 100, n))),
  );
}

/**
 * Stored "%" facts are always in the document's form (38 for "38%"). Grounding also accepts the fraction (0.38), so a
 * data value that grounded only as a fraction of a written percentage is rewritten to that written number.
 */
function inDocumentForm(f: DraftFact, chunkTexts: ReadonlyMap<string, string>): DraftFact {
  if (f.kind === "factTable" || !isPercent(f.unit)) return f;
  const pool = f.chunkIds.flatMap((id) => sourcePool(chunkTexts.get(id) ?? ""));
  const asWritten = (n: number): number | undefined =>
    pool.find((p) => p.percent && close(p.value / 100, n))?.value;
  const asFraction = (n: number) =>
    !pool.some((p) => close(p.value, n)) && asWritten(n) !== undefined;
  const values =
    f.kind === "figure"
      ? [f.value, ...(f.compare ? [f.compare.value] : [])]
      : f.points.map((p) => p.y);
  // Mixed scales (some values in the document's form, some fractions) are left exactly as the model gave them.
  if (!values.every(asFraction)) return f;
  const fix = (n: number) => asWritten(n) ?? n;
  return f.kind === "figure"
    ? {
        ...f,
        value: fix(f.value),
        ...(f.compare && {
          compare: { ...f.compare, value: fix(f.compare.value) },
        }),
      }
    : { ...f, points: f.points.map((p) => ({ ...p, y: fix(p.y) })) };
}

export function admit(
  drafts: readonly DraftFact[],
  chunkTexts: ReadonlyMap<string, string>,
  documentChunkIds: ReadonlySet<string>,
): { facts: Fact[]; dropped: number } {
  const facts: Fact[] = [];
  let dropped = 0;
  for (const d of drafts) {
    const ok = d.chunkIds.every((id) => documentChunkIds.has(id)) && grounded(d, chunkTexts);
    if (!ok) {
      dropped++;
      continue;
    }
    if (facts.length < MAX_FACTS)
      facts.push({ ...inDocumentForm(d, chunkTexts), ordinal: facts.length });
  }
  return { facts, dropped };
}
