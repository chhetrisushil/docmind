import { MAX_BACKFILL_DAYS } from "./backfill";

export const BACKFILL_DAYS_MESSAGE = "--days must be an integer from 1 to 400";

/** `--days N` (required) and `--no-wait`. Returns a message instead of throwing so the script can exit 2. */
export function parseBackfillArgs(
  argv: readonly string[],
): { days: number; wait: boolean } | { error: string } {
  let days: string | undefined;
  let wait = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-wait") wait = false;
    else if (a === "--days") days = argv[++i];
    else if (a?.startsWith("--days=")) days = a.slice("--days=".length);
    else return { error: "unknown argument" };
  }
  if (days === undefined || !/^\d+$/.test(days)) return { error: BACKFILL_DAYS_MESSAGE };
  const n = Number(days);
  if (n < 1 || n > MAX_BACKFILL_DAYS) return { error: BACKFILL_DAYS_MESSAGE };
  return { days: n, wait };
}
