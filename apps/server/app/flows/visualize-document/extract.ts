import { LlmOutputError, LlmRefusalError, LlmUnavailableError } from "@docmind/llm-anthropic";
import { tainted } from "@loom/classify";
import type { Effect } from "@loom/effect-runtime";
import { type LlmProvider, UNTRUSTED_CONTENT_SYSTEM_NOTE, guardRequest } from "@loom/llm";
import { z } from "zod";
import { parseVisualizeExecution } from "../../status/model";
import { FAILURE_CODES } from "../ingest-document/errors";
import { jsonAnswer } from "../ingest-document/llmJson";
import type { ChunkStore } from "../ingest-document/pgChunks";
import {
  LLM_BACKOFF_CAP_MS,
  LLM_RETRY,
  type StepGuard,
  StepResult,
  type StepSeams,
  ingestStepOptions,
  stepEffectOf,
} from "../ingest-document/stepEffect";
import { type DraftFact, ExtractAnswer, admit } from "./facts";
import type { VisualFactStore, VisualizeRef } from "./pgFacts";
import { EXTRACT_INSTRUCTION, EXTRACT_SYSTEM } from "./prompts";
import type { VisualRuns } from "./runs";

/** The most chunk text sent to the model in one request; a window never splits a chunk. */
export const EXTRACT_WINDOW_CHARS = 24_000;
const READ_BATCH = 200;
export const EXTRACT_STEP_TIMEOUT_MS = 600_000;

/**
 * The extract step's output: a `StepResult` that may also end `visuals-model-unavailable` (the model stayed unreachable
 * through every attempt). A code, never text.
 */
export const ExtractResult = StepResult.extend({
  code: z.enum([...FAILURE_CODES, "visuals-model-unavailable"]).optional(),
});
export type ExtractResult = z.infer<typeof ExtractResult>;

/** The extract step's own end: the model stayed unavailable through every attempt. */
export type ModelUnavailableEnd = { outcome: "failed"; code: "visuals-model-unavailable" };

export interface ExtractDeps extends StepSeams {
  guard: StepGuard;
  chunks: Pick<ChunkStore, "sectionsOf" | "read">;
  facts: VisualFactStore;
  /** The most chunk text read, in chunk order (the summary cap, DOCMIND_SUMMARY_MAX_CHARS): it bounds the model calls. */
  summaryMaxChars: number;
  /** Absent when the visuals role is off: the step is then done with no facts. */
  llm?: LlmProvider;
  /** The run reader: a re-run of a document whose previous run ended `done` re-plans over its stored facts even when there are none. */
  runs?: Pick<VisualRuns, "last">;
  /**
   * Execution ids of re-runs the starter began right after a `done` run (it knew the previous state before the new run
   * overwrote it in visual_runs). In-process only; after a restart the reader is the fallback.
   */
  afterDone?: Set<string>;
}

export type Chunk = { id: string; text: string };

/** Consecutive chunks while the running length stays within `max`; an oversized chunk is its own window. */
export function windows(chunks: Chunk[], max: number): Chunk[][] {
  const out: Chunk[][] = [];
  let cur: Chunk[] = [];
  let len = 0;
  for (const c of chunks) {
    if (cur.length > 0 && len + c.text.length > max) {
      out.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(c);
    len += c.text.length;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** Chunks in `ids` order, read `batch` ids at a time through `read`; a chunk that vanished (document being deleted) is skipped; none is added once `cap` characters are read (the last one may cross it). */
export async function readChunks(
  read: (ids: string[]) => Promise<Map<string, string>>,
  ids: string[],
  cap: number,
  batch: number,
): Promise<Chunk[]> {
  const out: Chunk[] = [];
  let used = 0;
  for (let i = 0; i < ids.length && used < cap; i += batch) {
    const slice = ids.slice(i, i + batch);
    const byId = await read(slice);
    for (const id of slice) {
      const text = byId.get(id);
      if (text === undefined) continue;
      if (used >= cap) break;
      out.push({ id, text });
      used += text.length;
    }
  }
  return out;
}

/** The facts the `visuals` model finds in `chunks`: windowed, fenced as untrusted data. Not grounded, not stored. */
export async function askForFacts(
  llm: LlmProvider,
  chunks: Chunk[],
  signal?: AbortSignal,
): Promise<DraftFact[]> {
  const drafts: DraftFact[] = [];
  for (const window of windows(chunks, EXTRACT_WINDOW_CHARS)) {
    const text = window.map((c) => `[[${c.id}]]\n${c.text}`).join("\n\n");
    const request = guardRequest({
      system: `${EXTRACT_SYSTEM}\n\n${UNTRUSTED_CONTENT_SYSTEM_NOTE}`,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: tainted(text, "document") },
            { type: "text", text: EXTRACT_INSTRUCTION },
          ],
        },
      ],
      temperature: 0,
    });
    const res = await llm.complete({ ...request, ...(signal && { signal }) });
    if (res.stopReason === "max_tokens") throw new LlmOutputError(); // truncated JSON
    drafts.push(...jsonAnswer(res.content, ExtractAnswer).facts);
  }
  return drafts;
}

/**
 * Visualize-extract step: the document's chunks go to the `visuals` model in windows, as fenced
 * untrusted data; the answer is parsed, grounded against the chunks, and the survivors stored sealed.
 */
export function extractEffect(deps: ExtractDeps): Effect<VisualizeRef, ExtractResult> {
  return stepEffectOf<ExtractResult, VisualizeRef, ModelUnavailableEnd>(
    "visualize-extract",
    deps.guard,
    async (ref, signal, _progress, executionId) => {
      const llm = deps.llm;
      if (!llm) return { model: "none" };
      const model = String((llm as { model?: unknown }).model ?? "unknown").slice(0, 200);
      // A re-run (`-r<n>`) re-plans over the stored facts without extracting, when there are some or the previous run
      // already ended `done` (a document that has no facts: its plan is the connections alone). It extracts otherwise.
      const id = executionId === undefined ? null : parseVisualizeExecution(executionId);
      const rerun = id?.rerun ?? 0;
      if (executionId !== undefined && id && rerun > 0) {
        const stored = await deps.facts.list(ref);
        if (stored.length > 0) return { count: stored.length, model };
        // The new run is recorded `running` right after it starts, which replaces the previous state: the starter's note
        // is the sure source, the reader answers when the previous run is still the last one (or after a restart).
        const noted = deps.afterDone?.has(executionId) === true;
        const last = noted ? null : await deps.runs?.last(ref, ref.documentId, id.generation);
        if (noted || (last?.state === "done" && last.run < rerun)) return { count: 0, model };
      }
      const ids = (await deps.chunks.sectionsOf(ref)).map((s) => s.id);
      const chunks = await readChunks(
        async (batch) => new Map((await deps.chunks.read(ref, batch)).map((c) => [c.id, c.text])),
        ids,
        deps.summaryMaxChars,
        READ_BATCH,
      );
      const texts = new Map(chunks.map((c) => [c.id, c.text]));
      let drafts: DraftFact[];
      try {
        drafts = await askForFacts(llm, chunks, signal);
      } catch (err) {
        if (!(err instanceof LlmRefusalError)) throw err;
        // A refusal is no facts, not a failure; the stored facts must reflect this run, so clear them.
        await deps.facts.replace(ref, [], signal);
        return { count: 0, model };
      }
      const { facts, dropped } = admit(drafts, texts, new Set(ids));
      // The count only, never a fact's content (spec 5: ungrounded facts are counted).
      console.info("visualize-extract dropped ungrounded facts", dropped);
      const count = await deps.facts.replace(ref, facts, signal);
      return { count, model };
    },
    {
      schema: ExtractResult,
      ended: (end) => end,
    },
    {
      ...ingestStepOptions(
        { ...deps, stepTimeoutMs: EXTRACT_STEP_TIMEOUT_MS },
        LLM_RETRY,
        LLM_BACKOFF_CAP_MS,
      ),
      // The model stayed unreachable (a timeout, a 5xx, a rate limit) through every attempt: a recorded failure the user
      // can retry, not a failed execution.
      exhausted: (err) =>
        err instanceof LlmUnavailableError
          ? { outcome: "failed", code: "visuals-model-unavailable" }
          : undefined,
    },
  );
}
