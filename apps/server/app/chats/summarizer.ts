import type { Effect, EffectContext } from "@loom/effect-runtime";

type SummarizerInput = { messages: { role: string; content?: unknown }[] };
type SummarizerOutput = { summary?: string };

export interface TolerantSummarizerDeps {
  /** Aborted by `ChatWiring.close()`: a shutdown must not be recorded as an empty summary. */
  shutdown?: AbortSignal;
  /** One line per swallowed failure: the error class name only (a message can carry the user's text). */
  log?: (line: string) => void;
}

/**
 * The summarizer effect, made unable to fail the conversation. Loom runs the summarize step outside the turn's
 * try/catch, so a model error would end the whole conversation execution; and it records a summary only when the
 * output's `summary` is a string, otherwise it keeps the previous summary and the turn goes on with the turns
 * evicted. So a failed call returns `{}`: that turn is answered without a fresh summary and the next evicting turn
 * folds the older turns in again. An aborted call (shutdown or the call's own signal) is rethrown, so it is never
 * journaled as an empty output.
 */
export function tolerantSummarizer(
  inner: Effect<SummarizerInput, SummarizerOutput>,
  deps: TolerantSummarizerDeps = {},
): Effect<SummarizerInput, SummarizerOutput> {
  const log = deps.log ?? ((line: string) => console.error(line));
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
      try {
        return await inner.execute(input, ctx);
      } catch (err) {
        if (ctx.signal?.aborted === true || deps.shutdown?.aborted === true) throw err;
        log(`chat summary failed: ${err instanceof Error ? err.constructor.name : typeof err}`);
        return {};
      }
    },
  }) as unknown as Effect<SummarizerInput, SummarizerOutput>;
}
