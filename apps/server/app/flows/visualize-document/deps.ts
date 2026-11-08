import type { Lineage } from "@loom-ui/lineage";
import type { Planner } from "@loom-ui/planner";
import type { Effect } from "@loom/effect-runtime";
import type { LlmProvider } from "@loom/llm";
import { visualizeGenerationOf } from "../../status/model";
import type { ChunkStore } from "../ingest-document/pgChunks";
import type { StepGuard, StepSeams } from "../ingest-document/stepEffect";
import { type CommitInput, commitEffect } from "./commit";
import { extractEffect } from "./extract";
import type { VisualFactStore, VisualizeRef } from "./pgFacts";
import { loadEffect } from "./plan";

/**
 * What the visualize flow's steps and runner need from the outside world. Built per app by the composition root;
 * `buildApp` registers the effects (`execution.registerEffects`) and the flow (its runner holds the planner).
 */
export interface VisualizeDeps extends StepSeams {
  guard: StepGuard;
  chunks: Pick<ChunkStore, "sectionsOf" | "read">;
  facts: VisualFactStore;
  lineage: Lineage;
  now: () => string;
  /** The `visuals` role's provider; absent when the role is off (the extract step then ends `skipped`). */
  llm?: LlmProvider;
  /** The planner over the same provider (R19: keyed decision ids); absent when the role is off. */
  planner?: Planner;
}

/** The effect of each step, keyed by step id (which is also its tool id). */
export const visualizeEffects = (seams: VisualizeDeps): Record<string, Effect> => {
  // The D1 generation guard: a visualize execution of a superseded ingest generation must not write.
  const deps = { ...seams, generationOf: visualizeGenerationOf };
  return {
    "visualize-extract": extractEffect(deps) as unknown as Effect,
    "visualize-load": loadEffect(deps) as unknown as Effect,
    "visualize-commit": commitEffect(deps) as unknown as Effect<CommitInput>,
  };
};

export type { VisualizeRef };
