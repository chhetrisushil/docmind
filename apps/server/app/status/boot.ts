import { runAll } from "../shutdown";

/** The only text a failed status boot surfaces: the real error can carry ids (an execution id names a user and a document). */
export const bootFailedMessage = (label: string) => `${label} failed to boot`;
export const STATUS_BOOT_FAILED = bootFailedMessage("ingest status");

/**
 * Boots the status model before anything is served (ADR 0132 D13, ruling R5). On failure it logs the
 * error class only, runs every cleanup step (one failing does not skip the rest), and throws a fixed
 * message: the boot error itself is never printed or rethrown.
 */
export async function bootStatus(
  status: { boot(): Promise<unknown> },
  cleanup: readonly (() => Promise<unknown>)[],
  label = "ingest status",
): Promise<void> {
  try {
    await status.boot();
  } catch (err) {
    console.error(`${label} failed`, err instanceof Error ? err.constructor.name : typeof err);
    await runAll(...cleanup).catch(() => undefined);
    throw new Error(bootFailedMessage(label));
  }
}
