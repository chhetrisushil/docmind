import { z } from "zod";

export const MAX_FACTS = 16;
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

export const DraftFact = z.discriminatedUnion("kind", [Series, Figure, FactTable]);
export type DraftFact = z.infer<typeof DraftFact>;
export type Fact = DraftFact & { ordinal: number };
export const ExtractAnswer = z.object({ facts: z.array(DraftFact).max(32) }).strict();

const SUFFIX: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, bn: 1e9 };
// Groups: 1 "(" open, 2 sign, 3 currency, 4 whole part, 5 decimals, 6 suffix, 7 "%", 8 ")" close.
const NUMBER =
  /(\()?([-−]\s?)?([$€£¥]\s?)?(\d{1,3}(?:[ ,.]\d{3})+|\d+)(?:[.,](\d+))?\s?(k|m|bn|b)?\b\s?(%)?(\))?/gi;

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
        ...f.points.flatMap((p) => NUMERIC_VALUES(p.x)),
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

const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-6);

/** A fact is grounded only if every number it asserts appears in the text of the chunks it cites. */
export function grounded(f: DraftFact, chunkTexts: ReadonlyMap<string, string>): boolean {
  const pool = f.chunkIds.flatMap((id) => sourcePool(chunkTexts.get(id) ?? ""));
  const percentUnit = f.kind !== "factTable" && f.unit === "%";
  return numbersInFact(f).every((n) =>
    pool.some((p) => close(p.value, n) || (percentUnit && p.percent && close(p.value / 100, n))),
  );
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
    if (facts.length < MAX_FACTS) facts.push({ ...d, ordinal: facts.length });
  }
  return { facts, dropped };
}
