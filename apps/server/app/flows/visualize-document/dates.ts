/** How exactly a document wrote a date. The stored event keeps the first day of the period at that precision. */
export const DATE_PRECISIONS = ["day", "month", "quarter", "year"] as const;
export type DatePrecision = (typeof DATE_PRECISIONS)[number];

export interface EventDate {
  /** The ISO first day of the period: `YYYY-MM-DD`. */
  at: string;
  precision: DatePrecision;
}

const MIN_YEAR = 1000;
const MAX_YEAR = 9999;
const YEAR = /^(\d{4})$/;
const QUARTER = /^(\d{4})-Q([1-4])$/;
const MONTH = /^(\d{4})-(\d{2})$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad = (n: number) => String(n).padStart(2, "0");
const yearOk = (y: number) => y >= MIN_YEAR && y <= MAX_YEAR;
/** The last day of `month` (1 to 12) of `year`: day 0 of the next month, so leap years come out right. */
const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * A model's `date` field at its precision: `YYYY`, `YYYY-Qn`, `YYYY-MM` or `YYYY-MM-DD` (surrounding space ignored, a quarter
 * written with a capital Q). Anything else, or a date that does not exist, is null: a relative or undated phrase is dropped,
 * never repaired. Pure; the input is never echoed.
 */
export function parseEventDate(raw: unknown): EventDate | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  const year = YEAR.exec(s);
  if (year) return yearOk(Number(year[1])) ? { at: `${year[1]}-01-01`, precision: "year" } : null;
  const quarter = QUARTER.exec(s);
  if (quarter) {
    if (!yearOk(Number(quarter[1]))) return null;
    return {
      at: `${quarter[1]}-${pad((Number(quarter[2]) - 1) * 3 + 1)}-01`,
      precision: "quarter",
    };
  }
  const month = MONTH.exec(s);
  if (month) {
    const m = Number(month[2]);
    return yearOk(Number(month[1])) && m >= 1 && m <= 12
      ? { at: `${month[1]}-${month[2]}-01`, precision: "month" }
      : null;
  }
  const day = DAY.exec(s);
  if (day) {
    const [y, m, d] = [Number(day[1]), Number(day[2]), Number(day[3])];
    return yearOk(y) && m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m)
      ? { at: s, precision: "day" }
      : null;
  }
  return null;
}

/** True when `at` is a real `YYYY-MM-DD` that is the first day of a period of `precision` (what `parseEventDate` stores). */
export function isStoredAt(at: string, precision: DatePrecision): boolean {
  const m = DAY.exec(at);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!yearOk(y) || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return false;
  switch (precision) {
    case "day":
      return true;
    case "month":
      return d === 1;
    case "quarter":
      return d === 1 && mo % 3 === 1;
    case "year":
      return d === 1 && mo === 1;
  }
}
