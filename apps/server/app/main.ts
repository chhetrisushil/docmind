import { randomUUID } from "node:crypto";
import { listen } from "./boot";
import { bootIngest } from "./bootIngest";
import { setupServer } from "./setup";
import { FORCE_EXIT_DEADLINE_MS, scheduleForceExit, shutdown } from "./shutdown";
import { reportStartupFailure } from "./startupError";

async function main(): Promise<void> {
  const { built, ingest, durable, pool, port, host } = await setupServer();

  // Boot order lives in bootIngest, shared with the acceptance stack: verify, register, decoy, bind, then
  // recovery and the sweepers. The bind comes first so a failed bind does not spend recovery budget.
  const ingestBoot = await bootIngest({
    built,
    ingest,
    durable,
    pool,
    recoveryOwner: randomUUID(),
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
    if (!closing) scheduleForceExit(process.exit, () => 1, FORCE_EXIT_DEADLINE_MS);
    closing ??= ingestBoot
      .stop()
      .catch((err: unknown) => {
        console.error("shutdown failed", err instanceof Error ? err.constructor.name : typeof err);
        process.exitCode = 1;
      })
      .finally(() => scheduleForceExit(process.exit, () => process.exitCode));
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, stop);
  }
}

main().catch((err) => {
  reportStartupFailure(err);
  process.exit(1);
});
