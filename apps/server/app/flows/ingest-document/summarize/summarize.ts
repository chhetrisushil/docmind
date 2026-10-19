import type { DocumentSummary } from "@docmind/contracts";
import { LlmOutputError } from "@docmind/llm-anthropic";
import type { ParsedDocument } from "@docmind/parsers";
import { tainted } from "@loom/classify";
import { type LlmProvider, UNTRUSTED_CONTENT_SYSTEM_NOTE, guardRequest } from "@loom/llm";
import type { z } from "zod";
import type { EntityKind } from "../../../crypto/entityKeys";
import { jsonAnswer } from "../llmJson";
import { SUMMARY_GROUP_CHARS, packGroups } from "./pack";
import {
  MAP_INSTRUCTION,
  MAP_SYSTEM,
  MapAnswer,
  REDUCE_INSTRUCTION,
  REDUCE_SYSTEM,
  ReduceAnswer,
} from "./prompts";

export const MAP_CONCURRENCY = 4;

export interface SummaryRun {
  summary: DocumentSummary;
  groups: { sections: number[]; entities: { name: string; kind: EntityKind }[] }[];
}

/** Runs `fn` over `items`, at most `limit` at a time; keeps order, rejects on the first failure. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i] as T);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

/**
 * Map-reduce summary (spec 5.2 "summarize", M3b D9). Document text, and the partial summaries derived
 * from it, are untrusted: they travel only inside `tainted(...)` in a user message, which guardRequest
 * fences, and every system prompt ends with Loom's untrusted-content note. Nothing here logs.
 */
export async function summarizeDocument(
  provider: LlmProvider,
  parsed: ParsedDocument,
  options: { maxChars: number; signal?: AbortSignal; groupChars?: number; concurrency?: number },
): Promise<SummaryRun | null> {
  const groups = packGroups(
    parsed.sections,
    options.maxChars,
    options.groupChars ?? SUMMARY_GROUP_CHARS,
  );
  if (groups.length === 0) return null;
  const ac = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, ac.signal]) : ac.signal;
  const concurrency =
    Number.isFinite(options.concurrency) && (options.concurrency as number) >= 1
      ? Math.floor(options.concurrency as number)
      : MAP_CONCURRENCY;
  const ask = async <T>(
    system: string,
    text: string,
    instruction: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  ): Promise<T> => {
    const request = guardRequest({
      system: `${system}\n\n${UNTRUSTED_CONTENT_SYSTEM_NOTE}`,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: tainted(text, "document") },
            { type: "text", text: instruction },
          ],
        },
      ],
      temperature: 0,
    });
    const res = await provider.complete({ ...request, signal });
    if (res.stopReason === "max_tokens") throw new LlmOutputError(); // a truncated JSON answer
    return jsonAnswer(res.content, schema);
  };
  try {
    const maps = await pool(groups, concurrency, (g) =>
      ask(MAP_SYSTEM, g.text, MAP_INSTRUCTION, MapAnswer),
    );
    const joined = maps.map((m, i) => `Part ${i + 1}: ${m.summary}`).join("\n\n");
    const summary = await ask(REDUCE_SYSTEM, joined, REDUCE_INSTRUCTION, ReduceAnswer);
    return {
      summary,
      groups: groups.map((g, i) => ({ sections: g.sections, entities: maps[i]?.entities ?? [] })),
    };
  } finally {
    ac.abort(); // cancels any still-running request after a failure; a no-op once all have settled
  }
}
