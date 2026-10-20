import { randomUUID } from "node:crypto";
import { bootIngest } from "../app/bootIngest";
import { runBackfill } from "../app/documents/backfill";
import { BACKFILL_DAYS_MESSAGE, parseBackfillArgs } from "../app/documents/backfillArgs";
import { setupServer } from "../app/setup";
import { FORCE_EXIT_DEADLINE_MS, scheduleForceExit } from "../app/shutdown";
import { reportStartupFailure } from "../app/startupError";

// Starts ingestion for documents older than the sweep's 7-day lookback that never got a flow.
// Usage: backfill-ingest --days <1..400> [--no-wait]. Logs counts only.
// Exit codes: 0 done, 1 a failure, 2 bad arguments, 3 incomplete (run again).
async function main(): Promise<void> {
  const args = parseBackfillArgs(process.argv.slice(2));
  if ("error" in args) {
    console.error(args.error);
    if (args.error !== BACKFILL_DAYS_MESSAGE)
      console.error("usage: backfill-ingest --days <1..400> [--no-wait]");
    process.exit(2);
  }
  console.log(
    "backfill: the server must be stopped; this process is the only flow engine while it runs",
  );
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
  const abort = new AbortController();
  let closing: Promise<void> | undefined;
  const stop = () => {
    abort.abort();
    if (!closing) scheduleForceExit(process.exit, () => 1, FORCE_EXIT_DEADLINE_MS);
    closing ??= boot
      .stop()
      .catch((err: unknown) => {
        console.error("shutdown failed", err instanceof Error ? err.constructor.name : typeof err);
        process.exitCode = 1;
      })
      .finally(() => scheduleForceExit(process.exit, () => process.exitCode));
    return closing;
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void stop());

  let code = 0;
  try {
    const { incomplete } = await runBackfill(pool, built.starts, {
      lookbackDays: args.days,
      signal: abort.signal,
      drain: () => built.status.drain(),
    });
    if (args.wait && !abort.signal.aborted) {
      await boot.recoveryIdle(); // limit: executions recovery resumed are not tracked beyond its current pass
      await built.starts.finished();
    }
    const c = built.starts.counts();
    console.log(
      `backfill: started=${c.started} alreadyRunning=${c.alreadyRunning} failedStarts=${c.failed}`,
    );
    if (args.wait)
      console.log(`backfill: executions completed=${c.completed} failed=${c.executionsFailed}`);
    if (c.failed > 0) code = 1;
    else if (incomplete) {
      console.error("backfill incomplete: more documents may remain; run the command again");
      code = 3;
    }
  } catch (err) {
    code = 1;
    console.error("backfill failed", err instanceof Error ? err.constructor.name : typeof err);
  } finally {
    await stop();
  }
  if (abort.signal.aborted && code === 0) code = 1;
  process.exit(process.exitCode || code);
}

main().catch((err) => {
  reportStartupFailure(err);
  process.exit(1);
});
