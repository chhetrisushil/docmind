import type { Effect } from "@loom/effect-runtime";
import type { IngestStartInput } from "../flow";
import type { ChunkStore } from "../pgChunks";
import {
  type StepGuard,
  type StepResult,
  type StepSeams,
  ingestStepOptions,
  stepEffect,
} from "../stepEffect";

export const PLACEHOLDER_STEPS = ["analyze", "summarize", "link"] as const;

/** Named, durable, and empty: part 2 replaces the effect registered under the step's id and nothing else. */
export const placeholderEffect = (
  step: (typeof PLACEHOLDER_STEPS)[number],
  guard: StepGuard,
  deps: StepSeams = {},
): Effect<IngestStartInput, StepResult> =>
  stepEffect(step, guard, async () => undefined, ingestStepOptions(deps));

/**
 * Last step. Its `STEP_COMPLETED` with `outcome: "done"` is what the ingest-status model folds to
 * `ready`; it writes no status. A document with no chunks (empty text) is still ready, with count 0.
 */
export const finalizeEffect = (
  deps: { guard: StepGuard; chunks: ChunkStore } & StepSeams,
): Effect<IngestStartInput, StepResult> =>
  stepEffect(
    "finalize",
    deps.guard,
    async (ref) => ({ count: await deps.chunks.count(ref) }),
    ingestStepOptions(deps),
  );
