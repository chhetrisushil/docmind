import { BlobKeyUnavailableError } from "@docmind/blob-store";
import { ParseLimitError, ParseMemoryError, ParseRejectedError } from "@docmind/parsers";
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
 * PARSE_REJECT_CODES (the same three values); an input or memory limit is deterministic for the
 * same bytes, so it is `too_large`. Timeouts, crashes, aborts (cancellation) and key-store
 * outages are NOT permanent: they stay transient and are never recorded as a code.
 */
export function permanentCode(err: unknown): FailureCode | undefined {
  if (err instanceof PermanentIngestError || err instanceof ParseRejectedError) {
    // Runtime guard: a code outside the contract is never recorded.
    return (FAILURE_CODES as readonly string[]).includes(err.code) ? err.code : undefined;
  }
  // ParseLimitError's only variant today is "input"; revisit if another limit is added.
  if (err instanceof ParseLimitError || err instanceof ParseMemoryError) return "too_large";
  return undefined;
}
