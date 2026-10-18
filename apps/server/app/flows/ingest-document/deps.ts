import type { Effect } from "@loom/effect-runtime";
import type { IngestOutput, IngestStartInput } from "./flow";

/**
 * What the flow's steps need from the outside world. Loom has no per-flow dependency argument, so
 * `buildApp` hands these to the runtime as effects (`execution.registerEffects`), one per step id.
 * The composition root (`main.ts`, or a test) supplies them per app; nothing is process-global.
 */
export interface IngestDeps {
  /** Is the document still there for its owner? Ids only: no filename, title or content. */
  documentExists(ref: IngestStartInput): Promise<boolean>;
}

/** The runnable side of the `ingest-begin` step: it only asks, and writes nothing. */
export function ingestBeginEffect(deps: IngestDeps): Effect<IngestStartInput, IngestOutput> {
  return {
    kind: "tool",
    execute: async (input) => ({
      outcome: (await deps.documentExists(input)) ? "accepted" : "document_gone",
    }),
  };
}
