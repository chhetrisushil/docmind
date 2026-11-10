/**
 * The one abortable wait between attempts. An abort rejects with `abortError()` (default: the signal's reason), so a step can
 * surface its own abort class, which its caller then treats as a cancel or shutdown rather than a failure.
 */
export const defaultSleep = (
  ms: number,
  signal?: AbortSignal,
  abortError: () => unknown = () => signal?.reason,
): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
