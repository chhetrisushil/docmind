/** 128 + the signal's number: what a shell or tini reports for a process the signal ended. */
const SIGNAL_EXIT_CODE = { SIGINT: 130, SIGTERM: 143 } as const;

/**
 * What a SIGTERM or SIGINT does at each point of the process's life, so a stop that arrives during a slow
 * boot is honoured instead of waiting out the platform's grace period for a SIGKILL (node is PID 1 in a
 * container, and has no default handler there).
 *
 * - `setup` (configuration, pools, the migration check, Loom's stores opening): exit at once with the
 *   signal's conventional status (128 + its number: 143 for SIGTERM, 130 for SIGINT), the status the process
 *   would have had with no handler at all, so a stop is never mistaken for a failed boot (exit 1).
 *   Nothing durable has started: no listener, no recovery, no timers, no leases; only idle connections,
 *   which the server closes with the process, and at most a transactional schema statement that rolls back.
 * - `booting` (`bootIngest`, up to the bind): it has started the timers and may hold leases, so the
 *   ordered stop is the right exit. The stop is deferred until the boot returns (it is bounded: one bind),
 *   and the forced-exit deadline is armed from the signal, so a boot that hangs is still cut off.
 * - `running`: the ordered stop, at once.
 */
export function createStopGate(deps: {
  exit: (code: number) => void;
  /** Arms the unref'd forced exit with code 1 after `ms`. */
  forceExitAfter: (ms: number) => void;
  log: (message: string) => void;
}) {
  let phase: "setup" | "booting" | "running" = "setup";
  let deadlineMs = 0;
  let pending = false;
  let stop: (() => void) | undefined;
  return {
    /** The signal handler (node passes the signal's name; SIGTERM when it is missing). */
    onSignal(signal?: NodeJS.Signals): void {
      if (phase === "running") {
        stop?.();
        return;
      }
      if (phase === "setup") {
        deps.log("docmind server stopped during startup");
        deps.exit(signal === "SIGINT" ? SIGNAL_EXIT_CODE.SIGINT : SIGNAL_EXIT_CODE.SIGTERM);
        return;
      }
      if (!pending) deps.forceExitAfter(deadlineMs);
      pending = true;
    },
    /** Configuration is loaded and the stores are open: from here a stop must be ordered. */
    booting(forceExitDeadlineMs: number): void {
      phase = "booting";
      deadlineMs = forceExitDeadlineMs;
    },
    /** The server is up. Runs `stopNow` now if a signal arrived during the boot. */
    running(stopNow: () => void): void {
      phase = "running";
      stop = stopNow;
      if (pending) stopNow();
    },
  };
}
