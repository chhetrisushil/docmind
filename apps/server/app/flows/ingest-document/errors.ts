import { BlobKeyUnavailableError } from "@docmind/blob-store";
import { EmbeddingAbortedError, EmbeddingUnavailableError } from "@docmind/embeddings";
import {
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

export const FAILURE_CODES = ["unsupported_content", "corrupt_content", "too_large"] as const;
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
 * Constraint names of the foreign keys that point at `documents` (migration 0011). A foreign-key
 * violation on one of them means the document went away mid-step. Tables added later with a
 * documents FK (e.g. chunk_links) must add their constraint name here.
 */
export const DOCUMENT_FKEY_CONSTRAINTS: readonly string[] = [
  "chunks_document_fkey",
  "parsed_documents_document_fkey",
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
  err instanceof ParseAbortedError || err instanceof EmbeddingAbortedError;

/** Deployment misconfiguration (embedder and vector store disagree): deterministic, never retried. Names no values. */
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
  if (err instanceof PermanentIngestError || err instanceof ParseRejectedError) {
    // Runtime guard: a code outside the contract is never recorded.
    return (FAILURE_CODES as readonly string[]).includes(err.code) ? err.code : undefined;
  }
  // ParseLimitError's only variant today is "input"; revisit if another limit is added.
  if (
    err instanceof ParseLimitError ||
    err instanceof ParseMemoryError ||
    err instanceof ParseTimeoutError
  )
    return "too_large";
  return undefined;
}
