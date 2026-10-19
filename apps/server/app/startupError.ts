/** A startup failure whose message names a variable and never a value, so it is safe to print. */
export class StartupConfigError extends Error {
  override readonly name = "StartupConfigError";
}

/** What `main` prints when startup fails: the message only for a `StartupConfigError`, the class alone otherwise. */
export function reportStartupFailure(err: unknown): void {
  if (err instanceof StartupConfigError) {
    console.error("docmind server failed to start:", err.message);
    return;
  }
  console.error(
    "docmind server failed to start",
    err instanceof Error ? err.constructor.name : typeof err,
  );
}
