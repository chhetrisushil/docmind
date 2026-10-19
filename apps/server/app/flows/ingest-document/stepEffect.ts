import type { IngestStep } from "@docmind/contracts";
import { ParseAbortedError } from "@docmind/parsers";
import type { RetryPolicy } from "@loom/core";
import type { Effect } from "@loom/effect-runtime";
import { z } from "zod";
import {
  FAILURE_CODES,
  StepResultError,
  isAbort,
  isDocumentGone,
  isFatal,
  permanentCode,
} from "./errors";
import type { IngestStartInput } from "./flow";

/** What every step returns, and so what the event log holds: an outcome, a count, a model id, a code. Never text. */
export const StepResult = z
  .object({
    outcome: z.enum(["done", "document_gone", "failed"]),
    count: z.number().int().nonnegative().optional(),
    model: z.string().max(200).optional(),
    code: z.enum(FAILURE_CODES).optional(),
  })
  .strict();
export type StepResult = z.infer<typeof StepResult>;

/**
 * Called first by every step. Throws DocumentGoneError when the document (or its owner row) is
 * gone, and writes nothing: the document's status is the `ingest-status` model's job, folded from
 * the step events.
 */
export interface StepGuard {
  begin(ref: IngestStartInput, step: IngestStep): Promise<void>;
}

/**
 * The parse step's retry policy. Loom records a step's `retry` as declared metadata (it is part of
 * the flow's identity) and enforces nothing itself, so `stepEffect` applies it: a transient failure
 * (a parser crash, a key store outage) is re-run in memory, with exponential backoff, up to
 * `maxAttempts` attempts in all. Permanent outcomes and cancellations are never retried. The policy
 * is part of the flow's identity (flowHash): changing a number here changes the flow version, and an
 * execution recorded under the old one is refused (FlowCodeMismatchError) until it is cancelled or restarted.
 */
export const STEP_RETRY: RetryPolicy = { maxAttempts: 3, backoffMs: 500, backoffMultiplier: 2 };

/**
 * The wall-clock bound of one attempt of a step that has no runner clock of its own (the chunk step;
 * parse is bounded by the parser runner's wall clock, DOCMIND_PARSE_TIMEOUT_MS). Generous: chunking is
 * CPU work over text already in memory. Recovery re-drives steps one by one, so a step that never
 * settles would stall every execution behind it on the node.
 */
export const STEP_TIMEOUT_MS = 120_000;

/** An attempt hit its wall clock: transient (retried by the policy), never a permanent code. */
export class StepTimeoutError extends Error {
  /** Resolves when the timed-out attempt finally settles (either way); it may never. */
  constructor(readonly settled: Promise<void> = Promise.resolve()) {
    super("the step attempt timed out");
    this.name = "StepTimeoutError";
  }
}

/**
 * After a timeout the next attempt waits for the timed-out one to settle, at most this long: two
 * attempts of one step never overlap (a late write could land after its successor finished). If it
 * is still alive after the wait, the step fails with no further attempt.
 */
export const ATTEMPT_SETTLE_MS = 30_000;

/**
 * Absolute ceiling on attempts of one step, progress or not. Progress resets the retry count, so this
 * is what makes termination unconditional (a store that reports success but never shrinks its work
 * list would otherwise retry forever under repeated timeouts). Sized for the largest allowed document:
 * parse maxChars tops out at 100,000,000; at about 2,400 chars per chunk that is about 42,000 chunks,
 * about 650 batches of 64 (smaller chunks and overlap add some), and one batch per attempt is the worst
 * case, so 1024 leaves headroom. Reaching it fails the step with the fixed message.
 */
export const MAX_ATTEMPTS_TOTAL = 1024;

export interface StepOptions {
  /** Test seam: the absolute attempt ceiling (default MAX_ATTEMPTS_TOTAL). */
  maxAttemptsTotal?: number;
  /** Test seam: the settle wait after a timed-out attempt (default ATTEMPT_SETTLE_MS). */
  settleMs?: number;
  retry?: RetryPolicy;
  /** Wall-clock bound of each attempt (guard, work and all); a hit is a transient failure. Unset: no bound. */
  timeoutMs?: number;
  /** Injectable wait between attempts; must reject if `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Aborted by the composition root just before the runner closes: whatever the step is doing is interrupted, not failed. */
  shutdown?: AbortSignal;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ParseAbortedError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ParseAbortedError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * A shutdown (the `shutdown` signal, aborted just before `runner.close()`) interrupts a step while
 * the execution's own signal is quiet, whatever error that surfaces as. That is neither a failure nor an attempt: the step must stay un-completed in the log, as
 * after a crash, so recovery re-runs it. Loom turns any rejection into STEP_FAILED and a failed
 * execution is final, so the effect does not settle: the process is about to exit.
 */
const INTERRUPTED: Promise<never> = new Promise<never>(() => {});

export function stepEffect(
  step: IngestStep,
  guard: StepGuard,
  work: (
    ref: IngestStartInput,
    signal?: AbortSignal,
    progress?: () => void,
  ) => Promise<{ count?: number; model?: string } | undefined>,
  options: StepOptions = {},
): Effect<IngestStartInput, StepResult> {
  const maxAttempts = Math.max(1, options.retry?.maxAttempts ?? 1);
  const sleep = options.sleep ?? defaultSleep;
  const settleMs = options.settleMs ?? ATTEMPT_SETTLE_MS;
  const attemptOnce = async (
    ref: IngestStartInput,
    signal: AbortSignal | undefined,
    progress: () => void,
  ): Promise<StepResult> => {
    const bound = options.timeoutMs;
    const run = async (inner: AbortSignal | undefined): Promise<StepResult> => {
      await guard.begin(ref, step);
      // The result is written to the event log: nothing outside StepResult may reach it.
      const parsed = StepResult.safeParse({
        outcome: "done",
        ...((await work(ref, inner, progress)) ?? {}),
      });
      if (!parsed.success) throw new StepResultError();
      return parsed.data;
    };
    if (bound === undefined) return run(signal);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), bound);
    const pending = run(signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal);
    const settled = pending.then(
      () => {},
      () => {}, // a late rejection after the bound is not unhandled
    );
    const expired = new Promise<never>((_, reject) =>
      timeout.signal.addEventListener("abort", () => reject(new StepTimeoutError(settled)), {
        once: true,
      }),
    );
    try {
      return await Promise.race([pending, expired]);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    kind: "tool",
    execute: async (ref, ctx) => {
      const interrupted = () => options.shutdown?.aborted === true && ctx?.signal?.aborted !== true;
      const waitSignals = [ctx?.signal, options.shutdown].filter((x): x is AbortSignal => !!x);
      const waitSignal = waitSignals.length ? AbortSignal.any(waitSignals) : undefined;
      const ceiling = options.maxAttemptsTotal ?? MAX_ATTEMPTS_TOTAL;
      let total = 0;
      for (let attempt = 1; ; attempt++) {
        total++;
        // Set by the work (after a committed unit) through `progress`; read only when this attempt times out.
        const made = { value: false };
        try {
          return await attemptOnce(ref, ctx?.signal, () => {
            made.value = true;
          });
        } catch (err) {
          if (interrupted()) return INTERRUPTED;
          if (isDocumentGone(err)) return { outcome: "document_gone" };
          const code = permanentCode(err);
          if (code) return { outcome: "failed", code };
          // Progress-aware budget: a timeout after the work reported progress is not a failed attempt
          // (the committed units stay and the next attempt resumes), so the count restarts. Bound: each
          // progressing attempt commits at least one unit that the work will not redo, so a step of n units
          // has at most n progressing attempts, plus at most maxAttempts non-progressing ones in a row.
          if (err instanceof StepTimeoutError && made.value) attempt = 0;
          if (total >= ceiling) throw failure(step, err);
          if (isAbort(err) || isFatal(err) || attempt >= maxAttempts) throw failure(step, err);
          if (
            err instanceof StepTimeoutError &&
            !(await settledWithin(err.settled, settleMs, waitSignal))
          ) {
            // A shutdown leaves the step un-completed; a user cancel is a cancel, not a failure.
            if (interrupted()) return INTERRUPTED;
            // Otherwise a zombie is still running: no attempt may overlap it.
            throw failure(step, err, ctx?.signal?.aborted === true);
          }
          try {
            const base = options.retry?.backoffMs ?? 0;
            await sleep(
              base * (options.retry?.backoffMultiplier ?? 1) ** Math.max(0, attempt - 1),
              waitSignal,
            );
          } catch {
            if (interrupted()) return INTERRUPTED;
            throw failure(step, err, ctx?.signal?.aborted === true); // cancelled while waiting
          }
        }
      }
    },
  };
}

/** True when `settled` resolves within `ms`; false at the deadline or as soon as `signal` aborts. */
async function settledWithin(
  settled: Promise<void>,
  ms: number,
  signal?: AbortSignal,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    onAbort = () => resolve(false);
    if (signal?.aborted) resolve(false);
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([settled.then(() => true), late]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

/** A step failure's message is written to the event log: fixed text; only the class goes to the process log. */
function failure(step: IngestStep, cause: unknown, cancelled = false): Error {
  // A cancellation (a delete aborting the runner) is expected, so it is not logged.
  if (!cancelled && !isAbort(cause)) {
    console.error(
      "ingest step failed",
      step,
      cause instanceof Error ? cause.constructor.name : typeof cause,
    );
  }
  return new Error(`ingest step failed: ${step}`);
}
