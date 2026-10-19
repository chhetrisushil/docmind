import type { Effect } from "@loom/effect-runtime";
import { isDocumentGone } from "./errors";
import type { IngestOutput, IngestStartInput } from "./flow";
import type { StepGuard } from "./stepEffect";

/**
 * What the flow's steps need from the outside world. Loom has no per-flow dependency argument, so
 * `buildApp` hands these to the runtime as effects (`execution.registerEffects`), one per step id.
 * The composition root (`main.ts`, or a test) supplies them per app; nothing is process-global.
 */
export interface IngestDeps {
  guard: StepGuard;
}

/** The stub step (retired by Task 80c): the same guard question the real steps ask; it writes nothing. */
export function ingestBeginEffect(deps: IngestDeps): Effect<IngestStartInput, IngestOutput> {
  return {
    kind: "tool",
    execute: async (input) => {
      try {
        await deps.guard.begin(input, "parse");
        return { outcome: "accepted" };
      } catch (err) {
        if (isDocumentGone(err)) return { outcome: "document_gone" };
        throw err;
      }
    },
  };
}
