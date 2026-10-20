import { randomUUID } from "node:crypto";
import { bootIngest } from "../app/bootIngest";
import { runBackfill } from "../app/documents/backfill";
import { BACKFILL_DAYS_MESSAGE, parseBackfillArgs } from "../app/documents/backfillArgs";
import { setupServer } from "../app/setup";
import { reportStartupFailure } from "../app/startupError";

// Starts ingestion for documents older than the sweep's 7-day lookback that never got a flow.
// Usage: backfill-ingest --days <1..400> [--no-wait]. Logs counts only.
async function main(): Promise<void> {
  const args = parseBackfillArgs(process.argv.slice(2));
  if ("error" in args) {
    console.error(args.error);
    if (args.error !== BACKFILL_DAYS_MESSAGE)
      console.error("usage: backfill-ingest --days <1..400> [--no-wait]");
    process.exit(2);
  }
  const { built, ingest, durable, pool } = await setupServer();
  // No listen and no periodic sweeps; recovery runs so the executions started here are driven.
  const boot = await bootIngest({
    built,
    ingest,
    durable,
    pool,
    recoveryOwner: randomUUID(),
    background: false,
  });
  let failed = false;
  try {
    const started = await runBackfill(pool, built.starts, { lookbackDays: args.days });
    console.log(`backfill: ${started} documents started`);
    if (args.wait) {
      await built.starts.finished();
      console.log("backfill: started executions finished");
    }
  } catch (err) {
    failed = true;
    console.error("backfill failed", err instanceof Error ? err.constructor.name : typeof err);
  } finally {
    await boot.stop().catch((err: unknown) => {
      failed = true;
      console.error("shutdown failed", err instanceof Error ? err.constructor.name : typeof err);
    });
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  reportStartupFailure(err);
  process.exit(1);
});
