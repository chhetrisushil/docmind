import { ParseAbortedError } from "@docmind/parsers";
import type { Effect } from "@loom/effect-runtime";
import { chunkDocument } from "../chunker";
import type { IngestStartInput } from "../flow";
import type { ChunkStore } from "../pgChunks";
import type { ParsedStore } from "../pgParsed";
import {
  type StepGuard,
  type StepOptions,
  type StepResult,
  ingestStepOptions,
  stepEffect,
} from "../stepEffect";

export interface ChunkDeps {
  guard: StepGuard;
  parsed: ParsedStore;
  chunks: ChunkStore;
  /** Test seam: the wait between retry attempts (default: a real, abortable timer). */
  sleep?: StepOptions["sleep"];
  /** Aborted by the composition root before the runner closes (see StepOptions). */
  shutdown?: AbortSignal;
  /** Test seam: the wall-clock bound of one attempt (default STEP_TIMEOUT_MS). */
  stepTimeoutMs?: number;
  /** Test seam: how long a timed-out attempt may take to settle before the step fails (default ATTEMPT_SETTLE_MS). */
  attemptSettleMs?: number;
}

/**
 * Chunk step: guard first, skip when chunks already exist (D2), else read the sealed parsed
 * document, chunk it and store the sealed chunks. The parsed row is kept: analyze and summarize read
 * it, and finalize drops it. Safe to run twice (at-least-once): chunks are stored in one transaction,
 * so after a crash between the store and STEP_COMPLETED the re-run finds the chunks and skips.
 * The result is a count only: neither the parsed text nor a chunk's text leaves this function.
 */
export function chunkEffect(deps: ChunkDeps): Effect<IngestStartInput, StepResult> {
  return stepEffect(
    "chunk",
    deps.guard,
    async (ref, signal) => {
      const existing = await deps.chunks.count(ref);
      if (existing > 0) return { count: existing };
      const parsed = await deps.parsed.take(ref);
      if (signal?.aborted) throw new ParseAbortedError(); // an abandoned attempt does not go on to write
      if (!parsed) throw new Error("no parsed document to chunk"); // parse always stores one: an invariant break
      const count = await deps.chunks.replace(ref, chunkDocument(parsed), signal); // deterministic ids
      return { count };
    },
    ingestStepOptions(deps),
  );
}
