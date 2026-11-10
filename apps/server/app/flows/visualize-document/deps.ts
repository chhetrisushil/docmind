import type { Lineage } from "@loom-ui/lineage";
import type { Planner } from "@loom-ui/planner";
import type { Effect } from "@loom/effect-runtime";
import type { LlmProvider } from "@loom/llm";
import type { ProgressBus } from "../../documents/progress";
import { visualizeGenerationOf } from "../../status/model";
import { IngestGate } from "../ingest-document/gate";
import type { ChunkStore } from "../ingest-document/pgChunks";
import type { StepGuard, StepSeams } from "../ingest-document/stepEffect";
import { type CommitInput, commitEffect } from "./commit";
import { extractEffect } from "./extract";
import type { VisualFactStore, VisualizeRef } from "./pgFacts";
import { loadEffect } from "./plan";
import type { VisualRuns } from "./runs";
import { type StructureReader, structureEffect } from "./structure";

/**
 * What the visualize flow's steps and runner need from the outside world. Built per app by the composition root;
 * `buildApp` registers the effects (`execution.registerEffects`) and the flow (its runner holds the planner).
 */
export interface VisualizeDeps extends StepSeams {
  guard: StepGuard;
  chunks: Pick<ChunkStore, "sectionsOf" | "read">;
  facts: VisualFactStore;
  /** The structure step's reads (headings, entity mentions), owner-scoped. */
  structure: StructureReader;
  /** The extract step's read bound: the summary cap (DOCMIND_SUMMARY_MAX_CHARS). */
  summaryMaxChars: number;
  lineage: Lineage;
  /** Tells the owner's open browsers the visuals are ready (the commit step publishes). */
  bus: ProgressBus;
  now: () => string;
  /** The `visuals` role's provider; absent when the role is off (the extract step then ends `skipped`). */
  llm?: LlmProvider;
  /** The `visuals` role sized for a document extraction (longer answer, longer timeout); the extract step prefers it over `llm`, which the planner and chat keep. */
  extractLlm?: LlmProvider;
  /** The run reader and the starter's note of re-runs after a `done` run: a zero-fact document is re-planned without extraction. */
  runs?: Pick<VisualRuns, "last">;
  afterDone?: Set<string>;
  /** The planner over the same provider (R19: keyed decision ids); absent when the role is off. */
  planner?: Planner;
}

/** The effect of each step, keyed by step id (which is also its tool id). */
export const visualizeEffects = (seams: VisualizeDeps): Record<string, Effect> => {
  // The D1 generation guard: a visualize execution of a superseded ingest generation must not write.
  const deps = { ...seams, generationOf: visualizeGenerationOf };
  return {
    "visualize-extract": extractEffect(deps) as unknown as Effect,
    "visualize-structure": structureEffect({
      ...deps,
      reader: deps.structure,
    }) as unknown as Effect,
    "visualize-load": loadEffect(deps) as unknown as Effect,
    "visualize-commit": commitEffect(deps) as unknown as Effect<CommitInput>,
  };
};

export type { VisualizeRef };

/**
 * The visualize steps' own gate, never ingest's: one slot per tenant and two for the process (the boot sweep
 * runs two executions at most), so an ingest step never queues behind a visualize step.
 */
export const newVisualizeGate = (): IngestGate =>
  new IngestGate({ concurrency: 2, tenantConcurrency: 1 });
