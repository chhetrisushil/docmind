import type { Effect, EffectContext } from "@loom/effect-runtime";

type SummarizerInput = { messages: { role: string; content?: unknown }[] };
type SummarizerOutput = { summary?: string };

/** Never settles: a shutdown must leave the step un-completed, as after a crash (cf. model.ts, stepEffect.ts INTERRUPTED). */
const INTERRUPTED: Promise<never> = new Promise<never>(() => {});

/** Waits before the 1st and 2nd retry. In memory only: no durable event, so replay stays deterministic. */
const RETRY_DELAYS_MS = [500, 2_000];

export interface TolerantSummarizerDeps {
  /** Aborted by `ChatWiring.close()`: cuts the in-flight request, and the step is left un-completed (never recorded as empty). */
  shutdown?: AbortSignal;
  /** One line per swallowed failure: the error class name only (a message can carry the user's text). */
  log?: (line: string) => void;
  /** Test seams: the waits before each retry, and how to wait (must reject when `signal` aborts). */
  retryDelaysMs?: number[];
  sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
}

const sleepFor = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Retryable unless the error says otherwise (`retryable: false`, e.g. a refusal); an HTTP 4xx or auth error is still retried, at most twice. */
const retryable = (err: unknown): boolean =>
  (err as { retryable?: unknown } | null)?.retryable !== false;

/**
 * The summarizer effect, made unable to fail the conversation. Loom runs the summarize step outside the turn's
 * try/catch, so a model error would end the whole conversation execution; and it records a summary only when the
 * output's `summary` is a string, otherwise it keeps the previous summary and the turn goes on with the turns
 * evicted. So a failed call returns `{}`. A retryable failure is first retried twice with backoff (in memory, so
 * replay is unchanged). The cost of a failure that outlasts the retries: Loom slices the evicted turns off BEFORE it
 * calls summarize, so those turns are missing from the summary for good; later folds see only newer evictions.
 * An aborted call (the call's own signal: cancel or lost lease) is rethrown. A shutdown never settles the call, so
 * the step is left un-completed as after a crash (model.ts), and the request is cut with the shutdown signal.
 */
export function tolerantSummarizer(
  inner: Effect<SummarizerInput, SummarizerOutput>,
  deps: TolerantSummarizerDeps = {},
): Effect<SummarizerInput, SummarizerOutput> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const delays = deps.retryDelaysMs ?? RETRY_DELAYS_MS;
  const sleep = deps.sleep ?? sleepFor;
  const wrapper: Record<string, unknown> = {};
  for (let o: object | null = inner; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const key of Object.getOwnPropertyNames(o)) {
      if (key === "execute" || key === "constructor" || key in wrapper) continue;
      const v = (inner as unknown as Record<string, unknown>)[key];
      wrapper[key] = typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(inner) : v;
    }
  }
  return Object.assign(wrapper, {
    async execute(input: SummarizerInput, ctx: EffectContext): Promise<SummarizerOutput> {
      const signal = deps.shutdown
        ? ctx.signal
          ? AbortSignal.any([ctx.signal, deps.shutdown])
          : deps.shutdown
        : ctx.signal;
      const call = { ...ctx, signal } as EffectContext;
      const shuttingDown = (): boolean => deps.shutdown?.aborted === true;
      for (let attempt = 0; ; attempt++) {
        try {
          return await inner.execute(input, call);
        } catch (err) {
          if (shuttingDown()) return INTERRUPTED;
          if (ctx.signal?.aborted === true) throw err;
          if (attempt >= delays.length || !retryable(err)) {
            log(`chat summary failed: ${err instanceof Error ? err.constructor.name : typeof err}`);
            return {};
          }
          try {
            await sleep(delays[attempt] as number, signal);
          } catch {
            if (shuttingDown()) return INTERRUPTED;
            throw err;
          }
        }
      }
    },
  }) as unknown as Effect<SummarizerInput, SummarizerOutput>;
}
