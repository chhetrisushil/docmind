import { EmbeddingAbortedError } from "@docmind/embeddings";
import type { ChunkVectorStore } from "@docmind/vector-pg";
import type { Effect } from "@loom/effect-runtime";
import type { EmbeddingProvider } from "@loom/memory";
import { DocumentGoneError, IngestConfigError } from "../errors";
import type { IngestStartInput } from "../flow";
import type { ChunkStore } from "../pgChunks";
import {
  STEP_RETRY,
  STEP_TIMEOUT_MS,
  type StepGuard,
  type StepOptions,
  type StepResult,
  stepEffect,
} from "../stepEffect";

export const EMBED_BATCH = 64;

export interface EmbedDeps {
  guard: StepGuard;
  chunks: ChunkStore;
  vectors: ChunkVectorStore;
  embedder: EmbeddingProvider;
  /** Test seams and the shutdown signal, as in the chunk step. */
  sleep?: StepOptions["sleep"];
  shutdown?: AbortSignal;
  stepTimeoutMs?: number;
  attemptSettleMs?: number;
}

/**
 * Embed step: guard first, then `missing` (ids with no vector for this model) in batches of 64 until
 * none are left, so a re-run, or a retry after a failed batch, embeds only what is unfinished. The
 * loop is bounded by the document's chunk count: a store that keeps listing the same ids fails the
 * step instead of spinning. The result is `{count, model}`: no text, no vectors. Retry, timeout and
 * cancellation are stepEffect's: an outage (EmbeddingUnavailableError) is retried, a permanent
 * EmbeddingError maps to a code, a caller abort is a cancel. The attempt's signal goes to the embedder;
 * ChunkVectorStore.upsert takes none, so it is checked just before each write, and a write already in
 * flight is covered by stepEffect's no-overlap wait for a timed-out attempt to settle.
 */
export function embedEffect(deps: EmbedDeps): Effect<IngestStartInput, StepResult> {
  return stepEffect(
    "embed",
    deps.guard,
    async (ref, signal) => {
      const model = deps.embedder.modelId;
      if (model !== deps.vectors.modelId || deps.embedder.dimensions !== deps.vectors.dimensions)
        throw new IngestConfigError(); // before any batch; fatal, not retried
      const scope = { tenantId: ref.tenantId, ownerId: ref.userId };
      const count = await deps.chunks.count(ref);
      for (let batches = 0; ; batches++) {
        const ids = await deps.vectors.missing(scope, ref.documentId, EMBED_BATCH);
        if (ids.length === 0) break;
        if (batches >= Math.ceil(count / EMBED_BATCH))
          throw new Error("embedding made no progress");
        const rows = await deps.chunks.read(ref, ids);
        if (rows.length !== ids.length) throw new DocumentGoneError(); // chunks deleted or replaced under us
        const vectors = await deps.embedder.embed(
          rows.map((r) => r.text),
          signal ? { signal } : undefined,
        );
        if (vectors.length !== rows.length) throw new Error("embedder returned the wrong count");
        if (signal?.aborted) throw new EmbeddingAbortedError(); // an abandoned attempt does not write
        // upsert takes no signal: a late commit is idempotent (deterministic chunk ids, same text and model) and cannot overlap a successor (stepEffect's settle wait).
        const { missing } = await deps.vectors.upsert(
          scope,
          ref.documentId,
          rows.map((r, i) => ({ chunkId: r.id, vector: vectors[i] as number[] })),
        );
        if (missing.length > 0) throw new DocumentGoneError();
      }
      return { count, model };
    },
    {
      retry: STEP_RETRY,
      timeoutMs: deps.stepTimeoutMs ?? STEP_TIMEOUT_MS,
      ...(deps.attemptSettleMs !== undefined && { settleMs: deps.attemptSettleMs }),
      ...(deps.sleep && { sleep: deps.sleep }),
      ...(deps.shutdown && { shutdown: deps.shutdown }),
    },
  );
}
