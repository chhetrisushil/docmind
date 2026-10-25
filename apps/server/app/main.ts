import { randomUUID } from "node:crypto";
import { listen } from "./boot";
import { bootIngest } from "./bootIngest";
import { setupServer } from "./setup";
import { scheduleForceExit, shutdown } from "./shutdown";
import { createStopGate } from "./signals";
import { reportStartupFailure } from "./startupError";

async function main(): Promise<void> {
  // Registered first: a stop during a slow boot must not wait out the platform's grace for a SIGKILL
  // (node is PID 1 in a container). What it does at each phase is in signals.ts. `once`, so a second
  // signal from an impatient operator falls through to the default and ends the process.
  const gate = createStopGate({
    exit: process.exit,
    forceExitAfter: (ms) => scheduleForceExit(process.exit, () => 1, ms),
    log: (message) => console.error(message),
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, gate.onSignal);
  }

  const { built, ingest, durable, pool, port, host, shutdownDeadlineMs, shutdownDelayMs } =
    await setupServer();
  gate.booting(shutdownDeadlineMs);

  // Boot order lives in bootIngest, shared with the acceptance stack: verify, register, decoy, bind, then
  // recovery and the sweepers. The bind comes first so a failed bind does not spend recovery budget.
  const ingestBoot = await bootIngest({
    built,
    ingest,
    durable,
    pool,
    recoveryOwner: randomUUID(),
    shutdownDelayMs,
    listen: async () => {
      await listen(built.server, port, host);
      console.log(`docmind server listening on http://${host}:${port}`);
    },
    drainServer: (then) => shutdown(built.server, { close: then }),
  });

  // One shutdown, shared by every signal: a second signal reuses the same promise (bootIngest's stop is
  // idempotent, and a second server.close() would reject with ERR_SERVER_NOT_RUNNING).
  // The deadline starts at the first signal, so a drain that never ends (a slow upload) cannot outlive it: exit 1.
  let closing: Promise<void> | undefined;
  const stop = () => {
    if (!closing) scheduleForceExit(process.exit, () => 1, shutdownDeadlineMs);
    closing ??= ingestBoot
      .stop()
      .catch((err: unknown) => {
        console.error("shutdown failed", err instanceof Error ? err.constructor.name : typeof err);
        process.exitCode = 1;
      })
      .finally(() => scheduleForceExit(process.exit, () => process.exitCode));
  };

  gate.running(stop);
}

main().catch((err) => {
  reportStartupFailure(err);
  process.exit(1);
});
