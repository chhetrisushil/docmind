import { tool$ } from "@loom/core";
import { z } from "zod";
import { SearchUnavailableError } from "../retrieval";
import type { Retriever } from "../retrieval";
import { type ToolHarnessDeps, type ToolResult, clip, modelPassageOf, toolEffect } from "./harness";

export const SearchInput = z
  .object({
    query: z.string().trim().min(1).max(500),
    k: z.number().int().min(1).max(12).optional(),
  })
  .strict();

export const searchDocsTool = tool$({
  id: "search_docs",
  name: "search_docs",
  description:
    "Search the user's documents for passages relevant to a query. Returns up to k passages (default 8, at most 12), each with a passageId to cite, the document title, where it sits in the document and its text. Some passages are reached by following links between documents; `via` says how. Use focused queries, and search again with different words if the first results are off.",
  inputSchema: SearchInput,
  outputSchema: z.unknown(),
  idempotent: true,
});

type SearchOut =
  | { passages: ReturnType<typeof modelPassageOf>[] }
  | { error: "search_unavailable" };

export interface SearchDeps extends ToolHarnessDeps {
  retriever: Pick<Retriever, "search">;
}

export function searchEffects(deps: SearchDeps) {
  return {
    search_docs: toolEffect(
      deps,
      SearchInput,
      async ({ query, k }, call): Promise<ToolResult<SearchOut>> => {
        try {
          const passages = await deps.retriever.search(
            call.vector,
            call.chat,
            query,
            k ?? 8,
            call.signal,
          );
          return {
            out: { passages: passages.map(modelPassageOf) },
            step: {
              name: "search_docs",
              label: `Searched documents: "${clip(query, 80)}"`,
              count: passages.length,
            },
            passages,
          };
        } catch (err) {
          // An embedder outage is an answer the model can act on, never a failed turn and never passages from elsewhere.
          if (!(err instanceof SearchUnavailableError)) throw err;
          return {
            out: { error: "search_unavailable" as const },
            step: { name: "search_docs", label: "Search is unavailable", count: 0 },
          };
        }
      },
    ),
  };
}
