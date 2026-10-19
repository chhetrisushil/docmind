import type { Effect } from "@loom/effect-runtime";
import { analyzeDocument } from "../analyze";
import type { IngestStartInput } from "../flow";
import type { ParsedStore } from "../pgParsed";
import type { DocumentResults } from "../pgResults";
import {
  type StepGuard,
  type StepResult,
  type StepSeams,
  ingestStepOptions,
  stepEffect,
} from "../stepEffect";

export interface AnalyzeDeps extends StepSeams {
  guard: StepGuard;
  parsed: ParsedStore;
  results: DocumentResults;
}

/** Analyze step (D11): reads the parsed document (kept until finalize, D2), stores sealed stats. Recomputed on every run: cheap and deterministic. */
export function analyzeEffect(deps: AnalyzeDeps): Effect<IngestStartInput, StepResult> {
  return stepEffect(
    "analyze",
    deps.guard,
    async (ref, signal) => {
      const parsed = await deps.parsed.take(ref);
      if (!parsed) throw new Error("no parsed document to analyze");
      const stats = analyzeDocument(parsed);
      await deps.results.putStats(ref, stats, signal);
      return { count: stats.wordCount };
    },
    ingestStepOptions(deps),
  );
}
