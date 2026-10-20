import type { DocumentStats, DocumentSummary } from "@docmind/contracts";
import type { VectorScope } from "@docmind/vector-pg";
import { tool$ } from "@loom/core";
import { z } from "zod";
import {
  type ToolHarnessDeps,
  type ToolResult,
  clip,
  inScope,
  notFound,
  toolEffect,
} from "./harness";

export interface DocumentSummaryView {
  title: string;
  summary: DocumentSummary | null;
  stats: DocumentStats | null;
}

export interface ListedDocument {
  documentId: string;
  title: string;
  mime: string;
  status: string;
  createdAt: string;
}

/** The owner's documents, read for the tools. Owner-scoped by `scope.ownerId`; a missing or foreign id is null. */
export interface DocumentReads {
  summary(scope: VectorScope, documentId: string): Promise<DocumentSummaryView | null>;
  list(
    scope: VectorScope,
    filter: { titleContains?: string; documentIds?: readonly string[]; limit: number },
  ): Promise<ListedDocument[]>;
}

export const GetSummaryInput = z.object({ documentId: z.string().uuid() }).strict();
export const ListDocumentsInput = z
  .object({
    titleContains: z.string().trim().min(1).max(100).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

export const LIST_DEFAULT_LIMIT = 20;

export const getSummaryTool = tool$({
  id: "get_summary",
  name: "get_summary",
  description:
    "Get one document's title, summary (short summary, key points, entities, topics) and statistics by its documentId. Use it to answer what a document is about. The summary may be null while the document is still being processed.",
  inputSchema: GetSummaryInput,
  outputSchema: z.unknown(),
  idempotent: true,
});

export const listDocumentsTool = tool$({
  id: "list_documents",
  name: "list_documents",
  description:
    "List the user's documents (documentId, title, type, status, upload time), newest first, optionally only those whose title contains some text. Use it to see what exists or to find a document by name.",
  inputSchema: ListDocumentsInput,
  outputSchema: z.unknown(),
  idempotent: true,
});

type SummaryOut =
  | {
      documentId: string;
      title: string;
      summary: DocumentSummary | null;
      stats: DocumentStats | null;
    }
  | { error: "not_found" };

export interface DocumentToolDeps extends ToolHarnessDeps {
  documents: DocumentReads;
}

export function documentEffects(deps: DocumentToolDeps) {
  return {
    get_summary: toolEffect(
      deps,
      GetSummaryInput,
      async ({ documentId }, call): Promise<ToolResult<SummaryOut>> => {
        const id = documentId.toLowerCase();
        // Out of scope is answered without reading the document at all.
        if (!inScope(call.chat, id)) return notFound("get_summary");
        const view = await deps.documents.summary(call.vector, id);
        if (!view) return notFound("get_summary");
        return {
          out: { documentId: id, title: view.title, summary: view.summary, stats: view.stats },
          step: {
            name: "get_summary" as const,
            label: `Read the summary of "${clip(view.title, 60)}"`,
            count: 1,
          },
        };
      },
    ),
    list_documents: toolEffect(
      deps,
      ListDocumentsInput,
      async (
        { titleContains, limit },
        call,
      ): Promise<ToolResult<{ documents: ListedDocument[] }>> => {
        const documents = await deps.documents.list(call.vector, {
          ...(titleContains !== undefined && { titleContains }),
          ...(call.chat !== "all" && { documentIds: call.chat.documentIds }),
          limit: limit ?? LIST_DEFAULT_LIMIT,
        });
        return {
          out: { documents },
          step: {
            name: "list_documents" as const,
            label:
              titleContains === undefined
                ? "Listed documents"
                : `Listed documents matching "${clip(titleContains, 60)}"`,
            count: documents.length,
          },
        };
      },
    ),
  };
}
