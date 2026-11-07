import { LlmOutputError, LlmRefusalError } from "@docmind/llm-anthropic";
import { tainted } from "@loom/classify";
import type { Effect } from "@loom/effect-runtime";
import { type LlmProvider, UNTRUSTED_CONTENT_SYSTEM_NOTE, guardRequest } from "@loom/llm";
import { jsonAnswer } from "../ingest-document/llmJson";
import type { ChunkStore } from "../ingest-document/pgChunks";
import {
  LLM_BACKOFF_CAP_MS,
  LLM_RETRY,
  type StepGuard,
  type StepResult,
  type StepSeams,
  ingestStepOptions,
  stepEffect,
} from "../ingest-document/stepEffect";
import { type DraftFact, ExtractAnswer, admit } from "./facts";
import type { VisualFactStore, VisualizeRef } from "./pgFacts";
import { EXTRACT_INSTRUCTION, EXTRACT_SYSTEM } from "./prompts";

/** The most chunk text sent to the model in one request; a window never splits a chunk. */
export const EXTRACT_WINDOW_CHARS = 24_000;
const READ_BATCH = 200;
const EXTRACT_STEP_TIMEOUT_MS = 600_000;

export interface ExtractDeps extends StepSeams {
  guard: StepGuard;
  chunks: Pick<ChunkStore, "sectionsOf" | "read">;
  facts: VisualFactStore;
  /** Absent when the visuals role is off: the step is then done with no facts. */
  llm?: LlmProvider;
}

type Chunk = { id: string; text: string };

/** Consecutive chunks while the running length stays within `max`; an oversized chunk is its own window. */
function windows(chunks: Chunk[], max: number): Chunk[][] {
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

async function readAll(
  store: Pick<ChunkStore, "read">,
  ref: VisualizeRef,
  ids: string[],
): Promise<Chunk[]> {
  const byId = new Map<string, string>();
  for (let i = 0; i < ids.length; i += READ_BATCH)
    for (const c of await store.read(ref, ids.slice(i, i + READ_BATCH))) byId.set(c.id, c.text);
  // Keep ordinal order; a chunk that vanished (document being deleted) is skipped.
  return ids.flatMap((id) => (byId.has(id) ? [{ id, text: byId.get(id) as string }] : []));
}

/**
 * Visualize-extract step: the document's chunks go to the `visuals` model in windows, as fenced
 * untrusted data; the answer is parsed, grounded against the chunks, and the survivors stored sealed.
 */
export function extractEffect(deps: ExtractDeps): Effect<VisualizeRef, StepResult> {
  return stepEffect(
    "visualize-extract",
    deps.guard,
    async (ref, signal) => {
      const llm = deps.llm;
      if (!llm) return { model: "none" };
      const model = String((llm as { model?: unknown }).model ?? "unknown").slice(0, 200);
      const ids = (await deps.chunks.sectionsOf(ref)).map((s) => s.id);
      const chunks = await readAll(deps.chunks, ref, ids);
      const texts = new Map(chunks.map((c) => [c.id, c.text]));
      const drafts: DraftFact[] = [];
      try {
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
      } catch (err) {
        if (!(err instanceof LlmRefusalError)) throw err;
        // A refusal is no facts, not a failure; the stored facts must reflect this run, so clear them.
        await deps.facts.replace(ref, [], signal);
        return { count: 0, model };
      }
      const { facts } = admit(drafts, texts, new Set(ids));
      const count = await deps.facts.replace(ref, facts, signal);
      return { count, model };
    },
    ingestStepOptions(
      { ...deps, stepTimeoutMs: EXTRACT_STEP_TIMEOUT_MS },
      LLM_RETRY,
      LLM_BACKOFF_CAP_MS,
    ),
  );
}
