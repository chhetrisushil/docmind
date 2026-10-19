import type { Effect } from "@loom/effect-runtime";
import { chunkDocument } from "../chunker";
import type { IngestStartInput } from "../flow";
import type { ChunkStore } from "../pgChunks";
import type { ParsedStore } from "../pgParsed";
import {
  PARSE_RETRY,
  STEP_TIMEOUT_MS,
  type StepGuard,
  type StepOptions,
  type StepResult,
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
}

/**
 * Chunk step: guard first, read the sealed parsed document, chunk it, store the sealed chunks, then
 * drop the parsed row. Safe to run twice (at-least-once), in both crash windows:
 * - after the chunks are stored but before the drop: the re-run reads the parsed row again and
 *   `replace` overwrites the same deterministic chunk ids, then drops;
 * - after the drop but before STEP_COMPLETED is appended: the re-run finds no parsed row and reports
 *   the chunks that exist.
 * The result is a count only: neither the parsed text nor a chunk's text leaves this function.
 */
export function chunkEffect(deps: ChunkDeps): Effect<IngestStartInput, StepResult> {
  return stepEffect(
    "chunk",
    deps.guard,
    async (ref) => {
      const parsed = await deps.parsed.take(ref);
      // No parsed row for a document that exists: an earlier run stored the chunks and dropped it,
      // and crashed before its STEP_COMPLETED was appended. The chunks are the result.
      if (!parsed) return { count: await deps.chunks.count(ref) };
      const count = await deps.chunks.replace(ref, chunkDocument(parsed)); // deterministic ids: a re-run overwrites
      await deps.parsed.drop(ref); // after the chunks exist, never before
      return { count };
    },
    {
      retry: PARSE_RETRY,
      timeoutMs: deps.stepTimeoutMs ?? STEP_TIMEOUT_MS,
      ...(deps.sleep && { sleep: deps.sleep }),
      ...(deps.shutdown && { shutdown: deps.shutdown }),
    },
  );
}
