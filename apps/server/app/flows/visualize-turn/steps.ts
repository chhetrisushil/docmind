import { LlmRefusalError } from "@docmind/llm-anthropic";
import type { Effect } from "@loom/effect-runtime";
import type { LlmProvider } from "@loom/llm";
import { MAX_READ_IDS } from "../../chats/retrieval/passages";
import { isDocumentGone } from "../ingest-document/errors";
import {
  LLM_BACKOFF_CAP_MS,
  type StepGuard,
  type StepResult,
  type StepSeams,
  ingestStepOptions,
  stepEffect,
  stepEffectOf,
} from "../ingest-document/stepEffect";
import { EXTRACT_STEP_TIMEOUT_MS, askForFacts, readChunks } from "../visualize-document/extract";
import { type Fact, admit } from "../visualize-document/facts";
import type { VisualFactStore } from "../visualize-document/pgFacts";
import { coverFacts } from "./coverage";
import type { TurnRef } from "./ids";
import { TURN_RETRY, type TurnFactsInput, TurnFactsOutput, TurnLoadOutput } from "./model";
import type { TurnFactStore } from "./pgTurnFacts";
import type { TurnRead } from "./readTurn";

export interface TurnLoadDeps extends StepSeams {
  guard: StepGuard<TurnRef>;
  /** `readTurn` bound to its collaborators (deps.ts does the binding). */
  turn: { read(ref: TurnRef, signal?: AbortSignal): Promise<TurnRead | null> };
  facts: Pick<VisualFactStore, "list">;
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

export interface TurnExtractDeps extends StepSeams {
  guard: StepGuard<TurnRef>;
  turn: TurnLoadDeps["turn"];
  passages: {
    read(
      scope: { tenantId: string; ownerId: string },
      chunkIds: readonly string[],
    ): Promise<Map<string, { text: string }>>;
  };
  facts: TurnFactStore;
  /** The most chunk text read, in retrieval order (DOCMIND_SUMMARY_MAX_CHARS): it bounds the model calls. */
  summaryMaxChars: number;
  /** Absent when the visuals role is off: the step is then done with no facts. */
  llm?: LlmProvider;
}

/** The retrieved chunks' text in retrieval order (a chunk whose document was deleted is absent from the read and skipped), through the same capped reader the document step uses. */
const readRetrieved = (deps: TurnExtractDeps, ref: TurnRef, ids: string[]) =>
  readChunks(
    async (batch) => {
      const byId = await deps.passages.read({ tenantId: ref.tenantId, ownerId: ref.userId }, batch);
      return new Map([...byId].map(([id, p]) => [id, p.text]));
    },
    ids,
    deps.summaryMaxChars,
    MAX_READ_IDS,
  );

/**
 * Step 2 (C1 fallback), run only when `turn-load` kept nothing: the model reads the turn's retrieved chunks with
 * sub-project 1's prompt, the grounding check keeps the facts whose numbers appear in the chunks they cite,
 * at most 16, sealed in `turn_visual_facts`. A refusal or no grounded fact is done with none. A turn that already has
 * facts (a re-run) is not extracted again: its rows are kept so an earlier head's widgets still resolve.
 */
export function turnExtractEffect(deps: TurnExtractDeps): Effect<TurnRef, StepResult> {
  return stepEffect<TurnRef>(
    "turn-extract",
    deps.guard,
    async (ref, signal) => {
      const llm = deps.llm;
      if (!llm) return { model: "none" };
      const model = String((llm as { model?: unknown }).model ?? "unknown").slice(0, 200);
      // A re-run keeps the facts the kept head's widgets point at (`<family>-<ordinal>`): extraction runs only for a turn with none.
      const existing = await deps.facts.list(ref);
      if (existing.length > 0) return { count: existing.length, model };
      const turn = await deps.turn.read(ref, signal);
      const chunks = turn ? await readRetrieved(deps, ref, turn.retrieved) : [];
      if (chunks.length === 0) {
        await deps.facts.replace(ref, [], signal);
        return { count: 0, model };
      }
      let drafts: Awaited<ReturnType<typeof askForFacts>>;
      try {
        drafts = await askForFacts(llm, chunks, signal);
      } catch (err) {
        if (!(err instanceof LlmRefusalError)) throw err;
        await deps.facts.replace(ref, [], signal); // the stored facts must reflect this run
        return { count: 0, model };
      }
      const { facts, dropped } = admit(
        drafts,
        new Map(chunks.map((c) => [c.id, c.text])),
        new Set(chunks.map((c) => c.id)),
      );
      console.info("turn-extract dropped ungrounded facts", dropped); // the count only, never content
      return { count: await deps.facts.replace(ref, facts, signal), model };
    },
    ingestStepOptions(
      { ...deps, stepTimeoutMs: EXTRACT_STEP_TIMEOUT_MS },
      TURN_RETRY,
      LLM_BACKOFF_CAP_MS,
    ),
  );
}

export interface TurnFactsDeps extends StepSeams {
  guard: StepGuard<TurnRef>;
  stored: Pick<VisualFactStore, "list">;
  turnFacts: TurnFactStore;
}

/**
 * Step 3: the kept facts' content, for the planner. Stored facts are read per referenced document (one read each) and
 * picked by ordinal in reference order; with no references the turn's own extracted facts are read. A document gone
 * since, or a fact replaced since, drops out. The output is sealed (`output.facts`).
 */
export function turnFactsEffect(deps: TurnFactsDeps): Effect<TurnFactsInput, TurnFactsOutput> {
  return stepEffectOf<TurnFactsOutput, TurnFactsInput>(
    "turn-facts",
    deps.guard,
    async (input) => {
      const ref: TurnRef = {
        tenantId: input.tenantId,
        userId: input.userId,
        chatId: input.chatId,
        ord: input.ord,
      };
      if (input.refs.length === 0) {
        const own = await deps.turnFacts.list(ref);
        return { facts: own.map((fact) => ({ origin: { kind: "turn" as const }, fact })) };
      }
      const byDocument = new Map<string, Map<number, Fact>>();
      for (const documentId of new Set(input.refs.map((r) => r.documentId))) {
        try {
          const list = await deps.stored.list({
            tenantId: ref.tenantId,
            userId: ref.userId,
            documentId,
          });
          byDocument.set(documentId, new Map(list.map((f) => [f.ordinal, f])));
        } catch (err) {
          if (!isDocumentGone(err)) throw err;
        }
      }
      const facts = input.refs.flatMap((r) => {
        const fact = byDocument.get(r.documentId)?.get(r.ordinal);
        return fact ? [{ origin: { kind: "doc" as const, documentId: r.documentId }, fact }] : [];
      });
      return { facts };
    },
    { schema: TurnFactsOutput, ended: (end) => ({ ...end, facts: [] }) },
    ingestStepOptions(deps, TURN_RETRY),
  );
}
