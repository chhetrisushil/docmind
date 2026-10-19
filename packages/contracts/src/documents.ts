import { z } from "zod";
import { Cursor, IsoDateTime, Uuid } from "./common";

export const DocumentStatus = z.enum(["uploaded", "parsing", "embedding", "ready", "failed"]);
export type DocumentStatus = z.infer<typeof DocumentStatus>;

/** Steps of the `ingest-document` flow, in order. */
export const IngestStep = z.enum([
  "parse",
  "chunk",
  "embed",
  "analyze",
  "summarize",
  "link",
  "finalize",
]);
export type IngestStep = z.infer<typeof IngestStep>;

const Count = z.number().int().nonnegative();
/**
 * Where a chunk or section sits in its source. Numbers only: a heading path is content, so it is
 * kept (sealed) beside the text and never in a locator that is stored or logged in the clear.
 * `chars` offsets are UTF-16 code units into the parsed text.
 */
export const Locator = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("chars"), start: Count, end: Count }).strict(),
    z.object({ kind: z.literal("section"), index: Count }).strict(),
    z.object({ kind: z.literal("page"), page: z.number().int().min(1) }).strict(),
    z.object({ kind: z.literal("paragraphs"), from: Count, to: Count }).strict(),
    z
      .object({
        kind: z.literal("region"),
        page: z.number().int().min(1),
        x: z.number().nonnegative(),
        y: z.number().nonnegative(),
        w: z.number().nonnegative(),
        h: z.number().nonnegative(),
      })
      .strict(),
  ])
  .superRefine((l, ctx) => {
    const [a, b] =
      l.kind === "chars" ? [l.start, l.end] : l.kind === "paragraphs" ? [l.from, l.to] : [0, 0];
    if (b < a) ctx.addIssue({ code: "custom", message: "end must not precede start" });
  });
export type Locator = z.infer<typeof Locator>;

/** Output of the analyze step: deterministic statistics. */
export const DocumentStats = z.object({
  wordCount: z.number().int().nonnegative(),
  pageCount: z.number().int().nonnegative().nullable(),
  readingTimeMinutes: z.number().nonnegative(),
  language: z.string().nullable(),
  outline: z.array(z.string()),
  dates: z.array(z.string()),
  numbers: z.array(z.string()),
});
export type DocumentStats = z.infer<typeof DocumentStats>;

/** Output of the summarize step. */
export const DocumentSummary = z.object({
  tldr: z.string(),
  keyPoints: z.array(z.string()),
  entities: z.array(z.string()),
  topics: z.array(z.string()),
  suggestedQuestions: z.array(z.string()),
});
export type DocumentSummary = z.infer<typeof DocumentSummary>;

export const DocumentDto = z.object({
  id: Uuid,
  title: z.string(),
  filename: z.string(),
  mime: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  status: DocumentStatus,
  error: z.string().nullable(),
  stats: DocumentStats.nullable(),
  summary: DocumentSummary.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type DocumentDto = z.infer<typeof DocumentDto>;

/** `POST /api/documents` (the multipart body is not a JSON contract). `duplicate`: same bytes re-sent. */
export const UploadDocumentResponse = z.object({ document: DocumentDto, duplicate: z.boolean() });
export type UploadDocumentResponse = z.infer<typeof UploadDocumentResponse>;

export const ListDocumentsQuery = z.object({
  cursor: Cursor.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListDocumentsQuery = z.infer<typeof ListDocumentsQuery>;

export const ListDocumentsResponse = z.object({
  items: z.array(DocumentDto),
  nextCursor: Cursor.nullable(),
});
export type ListDocumentsResponse = z.infer<typeof ListDocumentsResponse>;

/** One event on `GET /api/documents/events` (SSE). */
export const DocumentProgressEvent = z.object({
  documentId: Uuid,
  step: IngestStep.optional(),
  status: DocumentStatus,
  detail: z.string().optional(),
});
export type DocumentProgressEvent = z.infer<typeof DocumentProgressEvent>;
