import type { IngestStep } from "@docmind/contracts";
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

export function stepEffect(
  step: IngestStep,
  guard: StepGuard,
  work: (ref: IngestStartInput) => Promise<{ count?: number; model?: string } | undefined>,
): Effect<IngestStartInput, StepResult> {
  return {
    kind: "tool",
    execute: async (ref) => {
      try {
        await guard.begin(ref, step);
        return { outcome: "done", ...((await work(ref)) ?? {}) };
      } catch (err) {
        if (isDocumentGone(err)) return { outcome: "document_gone" };
        const code = permanentCode(err);
        if (code) return { outcome: "failed", code };
        throw failure(step, err);
      }
    },
  };
}

/** A step failure's message is written to the event log: fixed text; only the class goes to the process log. */
function failure(step: IngestStep, cause: unknown): Error {
  console.error(
    "ingest step failed",
    step,
    cause instanceof Error ? cause.constructor.name : typeof cause,
  );
  return new Error(`ingest step failed: ${step}`);
}
