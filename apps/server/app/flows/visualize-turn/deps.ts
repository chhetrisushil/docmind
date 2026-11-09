import type { Lineage } from "@loom-ui/lineage";
import type { Planner } from "@loom-ui/planner";
import type { Effect } from "@loom/effect-runtime";
import type { LlmProvider } from "@loom/llm";
import type { ChatBus } from "../../chats/bus";
import type { StepGuard, StepSeams } from "../ingest-document/stepEffect";
import type { VisualFactStore } from "../visualize-document/pgFacts";
import { type TurnCommitInput, turnCommitEffect } from "./commit";
import type { TurnRef } from "./ids";
import type { TurnFactStore } from "./pgTurnFacts";
import { type TurnExtractDeps, turnExtractEffect, turnFactsEffect, turnLoadEffect } from "./steps";

/** What the turn flow's steps and runner need from the outside world. Built per app by the composition root. */
export interface TurnVisualizeDeps extends StepSeams {
  guard: StepGuard<TurnRef>;
  turn: TurnExtractDeps["turn"];
  /** Sub-project 1's store: the stored facts of the cited documents. */
  stored: Pick<VisualFactStore, "list">;
  turnFacts: TurnFactStore;
  passages: TurnExtractDeps["passages"];
  /** The extract step's read bound: the summary cap (DOCMIND_SUMMARY_MAX_CHARS). */
  summaryMaxChars: number;
  lineage: Lineage;
  bus: Pick<ChatBus, "publish">;
  now: () => string;
  /** The `visuals` role's provider; absent when the role is off. */
  llm?: LlmProvider;
  /** The planner over the same provider (R19: keyed decision ids); absent when the role is off. */
  planner?: Planner;
}

/** The effect of each step, keyed by step id (which is also its tool id). */
export const turnEffects = (d: TurnVisualizeDeps): Record<string, Effect> => ({
  "turn-load": turnLoadEffect({ ...d, facts: d.stored }) as unknown as Effect,
  "turn-extract": turnExtractEffect({ ...d, facts: d.turnFacts }) as unknown as Effect,
  "turn-facts": turnFactsEffect({
    ...d,
    stored: d.stored,
    turnFacts: d.turnFacts,
  }) as unknown as Effect,
  "turn-commit": turnCommitEffect(d) as unknown as Effect<TurnCommitInput>,
});
