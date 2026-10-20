import { LlmRefusalError } from "@docmind/llm-anthropic";
import type { Effect } from "@loom/effect-runtime";
import type { LlmProvider } from "@loom/llm";
import type { IngestStartInput } from "../flow";
import type { ChunkStore } from "../pgChunks";
import type { EntityStore } from "../pgEntities";
import type { ParsedStore } from "../pgParsed";
import type { DocumentResults } from "../pgResults";
import {
  LLM_BACKOFF_CAP_MS,
  LLM_RETRY,
  type StepGuard,
  type StepResult,
  type StepSeams,
  ingestStepOptions,
  stepEffect,
} from "../stepEffect";
import { type SummaryRun, summarizeDocument } from "../summarize/summarize";

/** About 17 map calls (up to about twice that when sections are just over 12,000 characters) at 4 at a time and 60 s each, plus the reduce: far above STEP_TIMEOUT_MS, and applied to this step only. */
export const SUMMARIZE_STEP_TIMEOUT_MS = 600_000;

export interface SummarizeDeps extends StepSeams {
  guard: StepGuard;
  parsed: ParsedStore;
  chunks: ChunkStore;
  results: DocumentResults;
  entities: EntityStore;
  /** Absent without an API key: the step is then skipped (D7). */
  llm?: LlmProvider;
  /** The reduce prompt bound (DOCMIND_SUMMARY_MAX_CHARS), not the parse bound. */
  summaryMaxChars: number;
  /** Summarize's own attempt bound; the deps object is shared, so this is not the generic `stepTimeoutMs`. */
  summarizeStepTimeoutMs?: number;
}

/**
 * Summarize step (spec 5.2, D2, D7, D9): map-reduce summary stored sealed, plus each group's entity
 * mentions attached to that group's chunks. The summary is written last: its presence means "done".
 */
export function summarizeEffect(deps: SummarizeDeps): Effect<IngestStartInput, StepResult> {
  return stepEffect(
    "summarize",
    deps.guard,
    async (ref, signal) => {
      const provider = deps.llm;
      if (!provider) return { model: "none" }; // D7: no key, no summary; the document is still ready
      const model = String((provider as { model?: unknown }).model ?? "unknown").slice(0, 200);
      if (await deps.results.hasSummary(ref)) return { count: 0, model }; // D2
      const parsed = await deps.parsed.take(ref);
      if (!parsed) throw new Error("no parsed document to summarize");
      let run: SummaryRun | null;
      try {
        run = await summarizeDocument(provider, parsed, {
          maxChars: deps.summaryMaxChars,
          ...(signal && { signal }),
        });
      } catch (err) {
        if (err instanceof LlmRefusalError) return { count: 0, model };
        throw err;
      }
      if (!run) return { count: 0, model };
      const chunks = await deps.chunks.sectionsOf(ref);
      const bySection = new Map<number, string[]>();
      for (const c of chunks)
        bySection.set(c.sectionOrdinal, [...(bySection.get(c.sectionOrdinal) ?? []), c.id]);
      const mentions = run.groups.flatMap((g) => {
        const chunkIds = g.sections.flatMap((s) => bySection.get(s) ?? []);
        return chunkIds.length === 0
          ? []
          : g.entities.map((e) => ({ chunkIds, name: e.name, kind: e.kind }));
      });
      await deps.entities.replaceForDocument(ref, mentions, signal);
      await deps.results.putSummary(ref, run.summary, signal); // last: its presence means "summarize done" (D2)
      return { count: run.groups.length, model };
    },
    ingestStepOptions(
      { ...deps, stepTimeoutMs: deps.summarizeStepTimeoutMs ?? SUMMARIZE_STEP_TIMEOUT_MS },
      LLM_RETRY,
      LLM_BACKOFF_CAP_MS,
    ),
  );
}
