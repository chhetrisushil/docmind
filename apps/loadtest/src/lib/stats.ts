/** Percentile by nearest rank over unsorted samples; NaN when there are none. */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] as number;
}

export const fmt = (n: number, digits = 1): string => (Number.isNaN(n) ? "-" : n.toFixed(digits));

/** Left-aligned first column, right-aligned rest. */
export function printTable(header: string[], rows: string[][]): void {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (r: string[]) =>
    r.map((c, i) => (i === 0 ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0))).join("  ");
  console.log(line(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(line(r));
}

/** Numbers from a comma list such as "10,50,100". */
export function parseList(raw: string): number[] {
  const out = raw.split(",").map((s) => Number(s.trim()));
  if (out.length === 0 || out.some((n) => !Number.isInteger(n) || n < 1))
    throw new Error(`not a list of positive integers: ${raw}`);
  return out;
}
