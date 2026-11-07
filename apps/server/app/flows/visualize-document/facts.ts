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

const NUMERIC = /^[-+]?\d+(?:[.,]\d+)?$/;
export function numbersOf(f: DraftFact): number[] {
  switch (f.kind) {
    case "series":
      return f.points.map((p) => p.y);
    case "figure":
      return f.compare ? [f.value, f.compare.value] : [f.value];
    case "factTable":
      return f.rows
        .flat()
        .map((c) => c.trim())
        .filter((c) => NUMERIC.test(c))
        .map((c) => Number(c.replace(",", ".")));
  }
}

const SUFFIX: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, bn: 1e9 };
/** Every number written in `text`, normalised: grouping (`1,200` `1 200` `1.200`), suffixes, currency, percent. */
function numbersIn(text: string): number[] {
  const out: number[] = [];
  const re = /[$€£¥]?\s?(\d{1,3}(?:[ ,. ]\d{3})+|\d+)(?:[.,](\d+))?\s?(k|m|bn|b)?\b\s?(%)?/gi;
  for (const m of text.matchAll(re)) {
    const whole = (m[1] ?? "").replace(/[ ,. ]/g, "");
    const n = Number(m[2] === undefined ? whole : `${whole}.${m[2]}`);
    if (!Number.isFinite(n)) continue;
    const mult = m[3] ? (SUFFIX[m[3].toLowerCase()] ?? 1) : 1;
    out.push(n * mult);
    if (m[4]) out.push((n * mult) / 100); // 12% also grounds 0.12
  }
  return out;
}

const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-6);

export function grounded(f: DraftFact, chunkTexts: ReadonlyMap<string, string>): boolean {
  const pool = f.chunkIds.flatMap((id) => numbersIn(chunkTexts.get(id) ?? ""));
  return numbersOf(f).every((n) => pool.some((p) => close(p, n)));
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
