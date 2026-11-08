import type { Effect } from "@loom/effect-runtime";
import { isDocumentGone } from "../ingest-document/errors";
import {
  type StepGuard,
  type StepSeams,
  ingestStepOptions,
  stepEffectOf,
} from "../ingest-document/stepEffect";
import type { Fact } from "../visualize-document/facts";
import type { VisualFactStore } from "../visualize-document/pgFacts";
import { coverFacts } from "./coverage";
import type { TurnRef } from "./ids";
import { TURN_RETRY, TurnLoadOutput } from "./model";
import type { TurnRead } from "./readTurn";

export interface TurnLoadDeps extends StepSeams {
  guard: StepGuard<TurnRef>;
  /** `readTurn` bound to its collaborators (deps.ts does the binding). */
  turn: { read(ref: TurnRef, signal?: AbortSignal): Promise<TurnRead | null> };
  facts: VisualFactStore;
}

/**
 * Step 1 (C1): the cited, still-owned documents' stored facts that cite a cited chunk. Output: references only.
 * `cited: false` (uncited, not complete, or no such turn) ends the run as "nothing".
 */
export function turnLoadEffect(deps: TurnLoadDeps): Effect<TurnRef, TurnLoadOutput> {
  return stepEffectOf<TurnLoadOutput, TurnRef>(
    "turn-load",
    deps.guard,
    async (ref, signal) => {
      const turn = await deps.turn.read(ref, signal);
      if (!turn || turn.status !== "complete" || turn.citations.length === 0)
        return { cited: false, refs: [] };
      const documents = new Map<string, Fact[]>();
      for (const documentId of new Set(turn.citations.map((c) => c.documentId))) {
        try {
          documents.set(
            documentId,
            await deps.facts.list({ tenantId: ref.tenantId, userId: ref.userId, documentId }),
          );
        } catch (err) {
          if (!isDocumentGone(err)) throw err; // a document deleted since the answer: its facts do not count
        }
      }
      return {
        cited: true,
        refs: coverFacts({ citedChunkIds: turn.citations.map((c) => c.passageId), documents }),
      };
    },
    { schema: TurnLoadOutput, ended: (end) => ({ ...end, cited: false, refs: [] }) },
    ingestStepOptions(deps, TURN_RETRY),
  );
}
