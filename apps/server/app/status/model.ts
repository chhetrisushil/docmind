import type { DocumentProgressEvent, DocumentStatus, IngestStep } from "@docmind/contracts";
import { type EventEnvelope, projection$ } from "@loom/core";
import { FAILURE_CODES, type FailureCode } from "../flows/ingest-document/errors";

export const INGEST_STATUS_MODEL = "ingest-status";

export type StatusCode = FailureCode | "internal";

/** Enums and a failure code only: Loom's sensitive-state guard refuses anything else. */
export interface IngestStatusState {
  status: DocumentStatus;
  step: IngestStep | null;
  code: StatusCode | null;
}
export const INITIAL_STATUS: IngestStatusState = { status: "uploaded", step: null, code: null };

/** Decision D7. The spec's enum has no "analyzing"; `finalize` is `embedding` until it completes. */
export const STATUS_OF_STEP: Record<IngestStep, DocumentStatus> = {
  parse: "parsing",
  chunk: "parsing",
  embed: "embedding",
  analyze: "embedding",
  summarize: "embedding",
  link: "embedding",
  finalize: "embedding",
};

/** Fixed text shown to the user for a failed document. It never includes content. */
export const STATUS_MESSAGES: Record<StatusCode, string> = {
  unsupported_content: "This file's content is not a supported document.",
  corrupt_content: "This file could not be read; it may be damaged or use an unsupported encoding.",
  too_large: "This document is too large to process.",
  vision_unavailable: "Reading images needs a Claude API key on the server.",
  internal: "Processing failed. Try again.",
};

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Exactly `executionIdFor(user, "ingest-<doc>")` plus an optional positive `.<generation>` (no leading zero).
const INGEST_EXECUTION = new RegExp(`^u_(${UUID}):ingest-(${UUID})(?:\\.([1-9][0-9]{0,8}))?$`);

export const ingestKeyOf = (executionId: string): string | undefined =>
  INGEST_EXECUTION.exec(executionId)?.[2];
export const ingestScopeOf = (executionId: string): string | undefined =>
  INGEST_EXECUTION.exec(executionId)?.[1];
export const isIngestExecution = (executionId: string): boolean =>
  INGEST_EXECUTION.test(executionId);
/** No suffix is generation 1; `undefined` for an id that is not an ingest execution. */
export const generationOf = (executionId: string): number | undefined => {
  const match = INGEST_EXECUTION.exec(executionId);
  return match ? Number(match[3] ?? 1) : undefined;
};

const STEP_OF_ID = new Map<string, IngestStep>(
  (Object.keys(STATUS_OF_STEP) as IngestStep[]).map((step) => [`ingest-${step}`, step]),
);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
// The handler sees a masked copy; a shredded payload is `{ $shredded: true }` (skip it, ADR 0132).
const payloadOf = (e: EventEnvelope): Record<string, unknown> =>
  isRecord(e.payload) && e.payload.$shredded !== true ? e.payload : {};
const stepOf = (p: Record<string, unknown>): IngestStep | undefined =>
  typeof p.stepId === "string" ? STEP_OF_ID.get(p.stepId) : undefined;
/**
 * The cancel reasons recovery records when it gives an execution up (a crash loop past its bound, or
 * a flow whose identity changed under it). Loom has no way to fail an execution from outside, so
 * a cancel with one of these reasons is the document's recorded failure. A user's delete cancels
 * with another reason and is not a failure (its row is purged).
 */
export const RECOVERY_EXHAUSTED_REASON = "ingest-recovery-exhausted";
export const FLOW_MISMATCH_REASON = "ingest-flow-mismatch";
export const UNRECOVERABLE_REASONS = [RECOVERY_EXHAUSTED_REASON, FLOW_MISMATCH_REASON] as const;
const isUnrecoverable = (p: Record<string, unknown>): boolean =>
  (UNRECOVERABLE_REASONS as readonly unknown[]).includes(p.reason);

const codeOf = (v: unknown): StatusCode =>
  (FAILURE_CODES as readonly unknown[]).includes(v) ? (v as FailureCode) : "internal";

/** Failed and ready are final: a later event (a replayed step, a crash after finalize) cannot reopen them. */
const isTerminal = (s: IngestStatusState): boolean => s.status === "failed" || s.status === "ready";

type Handler = (state: IngestStatusState, event: EventEnvelope) => IngestStatusState;

/**
 * The state of an execution that is not an ingest one. Loom folds EVERY execution for every folded model (a chat
 * and a chat-title execution too), and its sensitive-state guard refuses a state holding a string of 6+ characters
 * or an object key that equals one lifted from a sealed path (a user message "uploaded", a tool output's `status`
 * key). An empty object has no key and no value, so nothing can match. It is never read: such a row has a NULL key
 * and scope and every reader filters on them.
 */
const NEUTRAL = {} as IngestStatusState;

/** A handler that folds ingest executions only; any other execution gets the neutral state. */
const ingestOnly =
  (handler: Handler): Handler =>
  (s, e) =>
    // An empty state is the tombstone (or a non-ingest row): nothing after it resurrects a status.
    isIngestExecution(e.executionId) && Object.keys(s).length > 0 ? handler(s, e) : NEUTRAL;

const rawHandlers = {
  // The row exists from the start of the execution (the stale-upload sweep relies on it).
  EXECUTION_STARTED: (s) => s,
  STEP_STARTED: (s, e) => {
    if (isTerminal(s)) return s;
    const step = stepOf(payloadOf(e));
    return step ? { status: STATUS_OF_STEP[step], step, code: null } : s;
  },
  STEP_COMPLETED: (s, e) => {
    if (isTerminal(s)) return s;
    const p = payloadOf(e);
    const step = stepOf(p);
    if (!step) return s;
    const out = isRecord(p.output) ? p.output : {};
    if (out.outcome === "failed") return { status: "failed", step, code: codeOf(out.code) };
    if (step === "finalize" && out.outcome === "done") return { status: "ready", step, code: null };
    return s;
  },
  EXECUTION_CANCELLED: (s, e) =>
    isTerminal(s) || !isUnrecoverable(payloadOf(e))
      ? s
      : { ...s, status: "failed", code: "internal" },
  // A failure after a terminal state (a specific code, or ready) changes nothing.
  EXECUTION_FAILED: (s) => (isTerminal(s) ? s : { ...s, status: "failed", code: "internal" }),
  // The erasure tombstone Loom writes to an erased user's log (compliance Art. 17). A row a rebuild brings back for an
  // erased execution must hold no status: the neutral state, like a chat execution's row.
  PAYLOAD_SHREDDED: () => NEUTRAL,
} satisfies Record<string, Handler>;

export const ingestHandlers: Record<keyof typeof rawHandlers, Handler> = {
  EXECUTION_STARTED: ingestOnly(rawHandlers.EXECUTION_STARTED),
  STEP_STARTED: ingestOnly(rawHandlers.STEP_STARTED),
  STEP_COMPLETED: ingestOnly(rawHandlers.STEP_COMPLETED),
  EXECUTION_CANCELLED: ingestOnly(rawHandlers.EXECUTION_CANCELLED),
  EXECUTION_FAILED: ingestOnly(rawHandlers.EXECUTION_FAILED),
  PAYLOAD_SHREDDED: rawHandlers.PAYLOAD_SHREDDED,
};

/** The durable fold (ADR 0132). Bump `version` when a handler's meaning changes: Loom re-folds at boot ("4": erasure tombstones fold to the neutral state). */
export const ingestStatus = projection$<IngestStatusState>({
  id: INGEST_STATUS_MODEL,
  name: "IngestStatus",
  version: "4",
  initialState: INITIAL_STATUS,
  handlers: ingestHandlers,
});

export function foldIngestStatus(events: readonly EventEnvelope[]): IngestStatusState {
  const handlers: Record<string, Handler> = ingestHandlers;
  return events.reduce((state, e) => {
    const handler = Object.hasOwn(handlers, e.eventType) ? handlers[e.eventType] : undefined;
    return handler ? handler(state, e) : state;
  }, INITIAL_STATUS);
}

export interface StatusView {
  status: DocumentStatus;
  step: IngestStep | null;
  error: string | null;
}
export const UPLOADED: StatusView = { status: "uploaded", step: null, error: null };

export const viewOf = (s: IngestStatusState): StatusView => ({
  status: s.status,
  step: s.step,
  error: s.code === null ? null : STATUS_MESSAGES[s.code],
});

/** The SSE event one log event produces, from the same handlers the model folds with. Pure; `detail` is only ever a fixed code. */
export function progressOf(
  e: EventEnvelope,
): { userId: string; progress: DocumentProgressEvent } | null {
  const documentId = ingestKeyOf(e.executionId);
  const userId = ingestScopeOf(e.executionId);
  if (documentId === undefined || userId === undefined) return null;
  // An unexpected failure (an embedder outage, a crash) names no step: the terminal event carries none.
  if (e.eventType === "EXECUTION_FAILED") {
    return { userId, progress: { documentId, status: "failed", detail: "internal" } };
  }
  if (e.eventType === "EXECUTION_CANCELLED") {
    return isUnrecoverable(payloadOf(e))
      ? { userId, progress: { documentId, status: "failed", detail: "internal" } }
      : null;
  }
  const next = foldIngestStatus([e]);
  if (next.step === null) return null; // not a step transition (the model's null step is absent here)
  const detail = next.status === "failed" && next.code !== null ? { detail: next.code } : {};
  return { userId, progress: { documentId, step: next.step, status: next.status, ...detail } };
}
