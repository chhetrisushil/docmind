import { LlmOutputError, LlmRefusalError, LlmUnavailableError } from "@docmind/llm-anthropic";
import { tainted } from "@loom/classify";
import type { Effect } from "@loom/effect-runtime";
import { type LlmProvider, UNTRUSTED_CONTENT_SYSTEM_NOTE, guardRequest } from "@loom/llm";
import { z } from "zod";
import { parseVisualizeExecution, visualizeGenerationOf } from "../../status/model";
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
import {
  type AggregateFact,
  DocumentAnswer,
  type DraftFact,
  ExtractAnswer,
  RELATIONS_ORDINAL,
  TIMELINE_ORDINAL,
  admit,
} from "./facts";
import type { VisualFactStore, VisualizeRef } from "./pgFacts";
import { EXTRACT_DOCUMENT_SYSTEM, EXTRACT_INSTRUCTION, EXTRACT_SYSTEM } from "./prompts";
import { buildRelations, rawLinksOf } from "./relations";
import type { VisualRuns } from "./runs";
import { buildTimeline, rawEventsOf } from "./timeline";

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
  /** The timeline and relations stored (1 or 2; absent when none). Counted apart from `count`, which is the extracted facts. */
  aggregates: z.number().int().min(1).max(2).optional(),
});
export type ExtractResult = z.infer<typeof ExtractResult>;

/** The extract step's own end: the model stayed unavailable through every attempt. */
export type ModelUnavailableEnd = { outcome: "failed"; code: "visuals-model-unavailable" };

export interface ExtractDeps extends StepSeams {
  guard: StepGuard;
  chunks: Pick<ChunkStore, "sectionsOf" | "read">;
  facts: Pick<VisualFactStore, "replace" | "list" | "aggregateCount">;
  /** The most chunk text read, in chunk order (the summary cap, DOCMIND_SUMMARY_MAX_CHARS): it bounds the model calls. */
  summaryMaxChars: number;
  /** Absent when the visuals role is off: the step is then done with no facts. */
  llm?: LlmProvider;
  /** The same role sized for this step's longer answer and longer timeout (`visualsExtract`); preferred over `llm` when present. */
  extractLlm?: LlmProvider;
  /** The run reader: a re-run of a document whose previous run ended `done` re-plans over its stored facts even when there are none. */
  runs?: Pick<VisualRuns, "last">;
  /**
   * Execution ids of re-runs the starter began right after a `done` run (it knew the previous state before the new run
   * overwrote it in visual_runs). In-process only: a run recovered after a crash has no note and may extract once.
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

/** One model call per window of `chunks`, fenced as untrusted data, each answer's text read by `read`. */
async function askWindows<T>(
  llm: LlmProvider,
  chunks: Chunk[],
  system: string,
  read: (content: string) => T,
  signal?: AbortSignal,
): Promise<T[]> {
  const out: T[] = [];
  for (const window of windows(chunks, EXTRACT_WINDOW_CHARS)) {
    const text = window.map((c) => `[[${c.id}]]\n${c.text}`).join("\n\n");
    const request = guardRequest({
      system: `${system}\n\n${UNTRUSTED_CONTENT_SYSTEM_NOTE}`,
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
    out.push(read(res.content));
  }
  return out;
}

/**
 * The facts the `visuals` model finds in `chunks`: windowed, fenced as untrusted data. Not grounded, not stored. This is
 * the CHAT turn's call (and its request is unchanged): it asks for facts only.
 */
export async function askForFacts(
  llm: LlmProvider,
  chunks: Chunk[],
  signal?: AbortSignal,
): Promise<DraftFact[]> {
  const answers = await askWindows(
    llm,
    chunks,
    EXTRACT_SYSTEM,
    (content) => jsonAnswer(content, ExtractAnswer).facts,
    signal,
  );
  return answers.flat();
}

/** What a document extraction reads from the model: the facts (strict) and the raw events and links of every window, not yet validated. */
export interface Extraction {
  drafts: DraftFact[];
  events: unknown[];
  links: unknown[];
}

/**
 * The DOCUMENT extraction's call: the same windows, with the prompt that also asks for a timeline and relations. The raw
 * events and links of every window are concatenated in window order and normalised once (`aggregatesOf`), so a duplicate
 * across windows is removed by the same dedupe. A fact that is malformed still fails its window (as `askForFacts`); a bad
 * aggregate never does.
 */
export async function askForExtraction(
  llm: LlmProvider,
  chunks: Chunk[],
  signal?: AbortSignal,
): Promise<Extraction> {
  const answers = await askWindows(
    llm,
    chunks,
    EXTRACT_DOCUMENT_SYSTEM,
    (content) => jsonAnswer(content, DocumentAnswer),
    signal,
  );
  return {
    drafts: answers.flatMap((a) => a.facts),
    events: answers.flatMap((a) => rawEventsOf(a.timeline)),
    links: answers.flatMap((a) => rawLinksOf(a.relations)),
  };
}

/**
 * The timeline (ordinal 18) and the relations (ordinal 19) the answers carried, validated against this document's passages
 * (`ids`, in passage order). Either may be absent; neither costs anything else.
 */
function aggregatesOf(extraction: Extraction, ids: readonly string[]): AggregateFact[] {
  const position = new Map(ids.map((id, i) => [id.toLowerCase(), i] as const));
  const timeline = buildTimeline(extraction.events, position);
  const relations = buildRelations(extraction.links, position);
  return [
    ...(timeline ? [{ ...timeline, ordinal: TIMELINE_ORDINAL }] : []),
    ...(relations ? [{ ...relations, ordinal: RELATIONS_ORDINAL }] : []),
  ];
}

/**
 * Visualize-extract step: the document's chunks go to the `visuals` model in windows, as fenced
 * untrusted data; the answer is parsed, the facts grounded against the chunks, the timeline and relations validated, and the
 * survivors stored sealed (one write that owns ordinals 0..15 and 18..19).
 */
export function extractEffect(deps: ExtractDeps): Effect<VisualizeRef, ExtractResult> {
  return stepEffectOf<ExtractResult, VisualizeRef, ModelUnavailableEnd>(
    "visualize-extract",
    deps.guard,
    async (ref, signal, _progress, executionId) => {
      const llm = deps.extractLlm ?? deps.llm;
      if (!llm) return { model: "none" };
      const generation =
        executionId === undefined
          ? undefined
          : (deps.generationOf ?? visualizeGenerationOf)(executionId);
      const model = String((llm as { model?: unknown }).model ?? "unknown").slice(0, 200);
      // A re-run (`-r<n>`) re-plans over the stored facts without extracting, when there are some or the previous run
      // already ended `done` (a document that has no facts: its plan is the connections alone). It extracts otherwise.
      const id = executionId === undefined ? null : parseVisualizeExecution(executionId);
      const rerun = id?.rerun ?? 0;
      if (executionId !== undefined && id && rerun > 0) {
        // The starter's note is read once and removed here (stored facts or not), so the set never fills up over a large boot.
        const noted = deps.afterDone?.delete(executionId) === true;
        const stored = await deps.facts.list(ref);
        // A timeline or relations fact is a stored fact too: the model already answered for this document.
        const held = await deps.facts.aggregateCount(ref);
        if (stored.length > 0 || held > 0)
          return { count: stored.length, ...(held > 0 && { aggregates: held }), model };
        // The new run is recorded `running` right after it starts, which replaces the previous state: the starter's note
        // is the sure source; the reader only helps if it runs before this run's own `running` record lands.
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
      let extraction: Extraction;
      try {
        extraction = await askForExtraction(llm, chunks, signal);
      } catch (err) {
        if (!(err instanceof LlmRefusalError)) throw err;
        // A refusal is no facts, not a failure; the stored facts (and aggregates) must reflect this run, so clear them.
        await deps.facts.replace(ref, [], signal, generation);
        return { count: 0, model };
      }
      const { facts, dropped } = admit(extraction.drafts, texts, new Set(ids));
      // The count only, never a fact's content (spec 5: ungrounded facts are counted).
      console.info("visualize-extract dropped ungrounded facts", dropped);
      const aggregates = aggregatesOf(extraction, ids);
      await deps.facts.replace(ref, [...facts, ...aggregates], signal, generation);
      return {
        count: facts.length,
        ...(aggregates.length > 0 && { aggregates: aggregates.length }),
        model,
      };
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
