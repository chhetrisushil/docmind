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

export function isDocumentGone(err: unknown): boolean {
  return (
    err instanceof DocumentGoneError ||
    err instanceof FieldKeyUnavailableError ||
    err instanceof BlobKeyUnavailableError ||
    (typeof err === "object" && err !== null && (err as { code?: unknown }).code === FK_VIOLATION)
  );
}

/**
 * The failure code of a permanent error, else undefined. Parser rejections carry a code from
 * PARSE_REJECT_CODES (the same three values); an input or memory limit is deterministic for the
 * same bytes, so it is `too_large`. Timeouts, crashes, aborts (cancellation) and key-store
 * outages are NOT permanent: they stay transient and are never recorded as a code.
 */
export function permanentCode(err: unknown): FailureCode | undefined {
  if (err instanceof PermanentIngestError || err instanceof ParseRejectedError) return err.code;
  if (err instanceof ParseLimitError || err instanceof ParseMemoryError) return "too_large";
  return undefined;
}
