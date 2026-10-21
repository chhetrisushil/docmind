/**
 * The only way the UI reports a failure. It logs the scope (a fixed word) and the error's class, and nothing else: an
 * error message can carry a title, a question or a token. Never pass anything but a fixed scope.
 */
export function report(scope: string, err: unknown): void {
  const kind = err instanceof Error ? err.constructor.name : typeof err;
  console.error(`${scope} ${kind}`);
}
