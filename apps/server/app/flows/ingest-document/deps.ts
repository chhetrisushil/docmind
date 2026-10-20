import type { Effect } from "@loom/effect-runtime";
import type { IngestStartInput } from "./flow";
import type { DocumentResults } from "./pgResults";
import type { StepResult } from "./stepEffect";
import { analyzeEffect } from "./steps/analyze";
import { type ChunkDeps, chunkEffect } from "./steps/chunk";
import { type EmbedDeps, embedEffect } from "./steps/embed";
import { finalizeEffect } from "./steps/finalize";
import { type LinkDeps, linkEffect } from "./steps/link";
import { type ParseDeps, parseEffect } from "./steps/parse";
import { type SummarizeDeps, summarizeEffect } from "./steps/summarize";

/**
 * What the flow's steps need from the outside world. Loom has no per-flow dependency argument, so
 * `buildApp` hands these to the runtime as effects (`execution.registerEffects`), one per step id.
 * The composition root (`main.ts`, or a test) supplies them per app; nothing is process-global.
 */
export interface IngestDeps extends ParseDeps, ChunkDeps, EmbedDeps, SummarizeDeps, LinkDeps {
  results: DocumentResults;
}

/** The effect of each step, keyed by step id (which is also its tool id). */
export const ingestEffects = (
  deps: IngestDeps,
): Record<string, Effect<IngestStartInput, StepResult>> => ({
  "ingest-parse": parseEffect(deps),
  "ingest-chunk": chunkEffect(deps),
  "ingest-embed": embedEffect(deps),
  "ingest-analyze": analyzeEffect(deps),
  "ingest-summarize": summarizeEffect(deps),
  "ingest-link": linkEffect(deps),
  "ingest-finalize": finalizeEffect(deps),
});
