import type { IngestStep } from "@docmind/contracts";
import { ParseAbortedError } from "@docmind/parsers";
import type { RetryPolicy } from "@loom/core";
import type { Effect } from "@loom/effect-runtime";
import { z } from "zod";
import { FAILURE_CODES, isDocumentGone, permanentCode } from "./errors";
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
 * `maxAttempts` attempts in all. Permanent outcomes and cancellations are never retried.
 */
export const PARSE_RETRY: RetryPolicy = { maxAttempts: 3, backoffMs: 500, backoffMultiplier: 2 };

export interface StepOptions {
  retry?: RetryPolicy;
  /** Injectable wait between attempts; must reject if `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
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
 * A shutdown (`runner.close()`) aborts an in-flight parse while the execution's own signal is
 * quiet. That is neither a failure nor an attempt: the step must stay un-completed in the log, as
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
  ) => Promise<{ count?: number; model?: string } | undefined>,
  options: StepOptions = {},
): Effect<IngestStartInput, StepResult> {
  const maxAttempts = Math.max(1, options.retry?.maxAttempts ?? 1);
  const sleep = options.sleep ?? defaultSleep;
  return {
    kind: "tool",
    execute: async (ref, ctx) => {
      for (let attempt = 1; ; attempt++) {
        try {
          await guard.begin(ref, step);
          return { outcome: "done", ...((await work(ref, ctx?.signal)) ?? {}) };
        } catch (err) {
          if (isDocumentGone(err)) return { outcome: "document_gone" };
          const code = permanentCode(err);
          if (code) return { outcome: "failed", code };
          const cancelled = ctx?.signal?.aborted === true;
          if (err instanceof ParseAbortedError && !cancelled) return INTERRUPTED;
          if (err instanceof ParseAbortedError || attempt >= maxAttempts) throw failure(step, err);
          try {
            const base = options.retry?.backoffMs ?? 0;
            await sleep(
              base * (options.retry?.backoffMultiplier ?? 1) ** (attempt - 1),
              ctx?.signal,
            );
          } catch {
            throw failure(step, err); // cancelled while waiting
          }
        }
      }
    },
  };
}

/** A step failure's message is written to the event log: fixed text; only the class goes to the process log. */
function failure(step: IngestStep, cause: unknown): Error {
  // A cancellation (a delete aborting the runner) is expected, so it is not logged.
  if (!(cause instanceof ParseAbortedError)) {
    console.error(
      "ingest step failed",
      step,
      cause instanceof Error ? cause.constructor.name : typeof cause,
    );
  }
  return new Error(`ingest step failed: ${step}`);
}
