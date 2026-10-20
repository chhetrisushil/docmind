import { BlobKeyUnavailableError } from "@docmind/blob-store";
import { EmbeddingAbortedError, EmbeddingUnavailableError } from "@docmind/embeddings";
import { LlmAbortedError, LlmRefusalError, LlmRequestError } from "@docmind/llm-anthropic";
import {
  PARSE_REJECT_CODES,
  ParseAbortedError,
  ParseLimitError,
  ParseMemoryError,
  ParseRejectedError,
  ParseTimeoutError,
} from "@docmind/parsers";
import { EmbeddingError } from "@loom/memory";
import { FieldKeyUnavailableError } from "../../crypto/fields";

/** The document, its row or its blob is gone (deleted or erased while a step ran): stop quietly. */
export class DocumentGoneError extends Error {
  constructor() {
    super("the document is gone");
    this.name = "DocumentGoneError";
  }
}

/**
 * A blob store returned null for a document whose row may still exist. The parse step re-checks the
 * row: gone stays DocumentGoneError, a live row is this fatal fault (a lost file or a moved blob
 * directory: deployment trouble, never retried). The message is fixed: it is logged.
 */
export class BlobMissingError extends Error {
  constructor() {
    super("blob missing for a live document");
    this.name = "BlobMissingError";
  }
}

/** A step's wait for an ingest slot was aborted (a cancel or a shutdown). Neither retried nor a failure. */
export class IngestAbortedError extends Error {
  constructor() {
    super("the ingest wait was aborted");
    this.name = "IngestAbortedError";
  }
}

export const FAILURE_CODES = [
  "unsupported_content",
  "corrupt_content",
  "too_large",
  "vision_unavailable",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

/** Retrying the same bytes cannot help (spec 5.2 "permanent"). */
export class PermanentIngestError extends Error {
  constructor(readonly code: FailureCode) {
    super(`permanent ingest failure: ${code}`);
    this.name = "PermanentIngestError";
  }
}

const FK_VIOLATION = "23503";
/**
 * Constraint names of the foreign keys whose violation means THIS step's document went away mid-step.
 * Keys that can also fail because a different document vanished (chunk_links, which writes reverse
 * rows into other documents' chunks) stay out: they are retried, and the next attempt's owner-scoped
 * document lock decides.
 */
export const DOCUMENT_FKEY_CONSTRAINTS: readonly string[] = [
  "chunks_document_fkey",
  "parsed_documents_document_fkey",
  "chunk_entities_chunk_fkey",
];

const isDocumentFkViolation = (err: unknown): boolean => {
  if (typeof err !== "object" || err === null) return false;
  const { code, constraint } = err as { code?: unknown; constraint?: unknown };
  return (
    code === FK_VIOLATION &&
    typeof constraint === "string" &&
    DOCUMENT_FKEY_CONSTRAINTS.includes(constraint)
  );
};

/** A caller abort (a cancel, a shutdown, an abandoned attempt): neither retried nor a failure. */
export const isAbort = (err: unknown): boolean =>
  err instanceof ParseAbortedError ||
  err instanceof EmbeddingAbortedError ||
  err instanceof IngestAbortedError ||
  err instanceof LlmAbortedError;

/** Deployment misconfiguration (embedder and vector store disagree): deterministic, never retried. Names no values. */
/** A step produced a result outside StepResult (an extra or malformed field): a programming fault, fatal, never retried. */
export class StepResultError extends Error {
  constructor() {
    super("step result does not match StepResult");
    this.name = "StepResultError";
  }
}

export class IngestConfigError extends Error {
  constructor() {
    super("embedder and vector store modelId/dimensions differ");
    this.name = "IngestConfigError";
  }
}

/**
 * Retrying cannot help and no content code fits: a permanent embedder error (redirect, missing model,
 * unexpected shape: a deployment fault, never the document's) or a config mismatch. The step fails
 * (failed/internal through EXECUTION_FAILED) and the class is logged for ops.
 */
export const isFatal = (err: unknown): boolean =>
  err instanceof IngestConfigError ||
  err instanceof StepResultError ||
  err instanceof BlobMissingError ||
  // a deployment fault (bad key, unknown model) or a model refusal: retrying the same request cannot
  // help. Steps that can map a refusal to a content code do so before it reaches here.
  err instanceof LlmRequestError ||
  err instanceof LlmRefusalError ||
  (err instanceof EmbeddingError && !(err instanceof EmbeddingUnavailableError));

export function isDocumentGone(err: unknown): boolean {
  return (
    err instanceof DocumentGoneError ||
    err instanceof FieldKeyUnavailableError ||
    err instanceof BlobKeyUnavailableError ||
    isDocumentFkViolation(err)
  );
}

/**
 * The failure code of a permanent error, else undefined. Parser rejections carry a code from
 * PARSE_REJECT_CODES (the same three values); an input limit, a memory limit and a timeout are
 * deterministic for the same bytes (Task 78 ruling, superseding 73a), so they are `too_large`.
 * Crashes, aborts (cancellation) and key-store outages are NOT permanent: they stay transient and
 * are never recorded as a code.
 */
export function permanentCode(err: unknown): FailureCode | undefined {
  if (err instanceof PermanentIngestError) {
    // Runtime guard: a code outside the contract is never recorded.
    return (FAILURE_CODES as readonly string[]).includes(err.code) ? err.code : undefined;
  }
  if (err instanceof ParseRejectedError) {
    // A parser may only reject with its own three codes; `vision_unavailable` is the vision step's, never a parse result.
    return (PARSE_REJECT_CODES as readonly string[]).includes(err.code)
      ? (err.code as FailureCode)
      : undefined;
  }
  // ParseLimitError ("input" or "output") is deterministic for the same bytes.
  if (
    err instanceof ParseLimitError ||
    err instanceof ParseMemoryError ||
    err instanceof ParseTimeoutError
  )
    return "too_large";
  return undefined;
}
