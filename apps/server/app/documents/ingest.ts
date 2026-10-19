import type { Identity } from "@docmind/auth";
import {
  ExecutionAlreadyExistsError,
  type ExecutionHandle,
  type WorkflowRuntime,
} from "@loom/workflow-runtime";
import {
  type IngestStartInput,
  IngestStartInput as IngestStartInputSchema,
  ingestDocumentFlow,
} from "../flows/ingest-document/flow";
import { type UserExecutionId, executionIdFor } from "../subject";

/**
 * The one value everything about an ingest start derives from: the start input, the principal and
 * the execution id. The document id is lower-cased (the execution id is a plain string key) and the
 * whole thing is validated, so a malformed id throws here, before Loom sees it.
 */
export const ingestStartInput = (identity: Identity, documentId: string): IngestStartInput =>
  IngestStartInputSchema.parse({
    tenantId: identity.tenantId,
    userId: identity.userId,
    documentId: documentId.toLowerCase(),
  });

/** 1 is the M2 stub's execution (bare name); a restart in part 2 bumps this. */
export const INGEST_GENERATION = 2;

/** The execution that ingests one document. `name` is a fixed prefix plus a UUID: no content. */
export const ingestExecutionId = (
  userId: string,
  documentId: string,
  generation = INGEST_GENERATION,
): UserExecutionId => {
  const id = documentId.toLowerCase();
  // Generation 1 is the bare name (the status model's parser never sees `.1`).
  return executionIdFor(userId, generation === 1 ? `ingest-${id}` : `ingest-${id}.${generation}`);
};

/** What the document routes need from the flow engine. */
export interface IngestPort {
  /** Starts the document's ingest execution. `null`: it already exists (start-once). */
  start(identity: Identity, documentId: string): Promise<ExecutionHandle | null>;
  /** Cancels every generation. An unknown or already finished execution is not an error; safe to repeat. */
  cancel(identity: Identity, documentId: string): Promise<void>;
}

const target = (identity: Identity, documentId: string) => {
  const ref = ingestStartInput(identity, documentId);
  return {
    ref,
    executionId: ingestExecutionId(ref.userId, ref.documentId),
    principal: { tenant: ref.tenantId, actor: ref.userId },
  };
};

// A fixed reason: the cancel reason is recorded in the log, so it never names the document.
const CANCEL_REASON = "document-deleted";

export function loomIngest(runtime: Pick<WorkflowRuntime, "start" | "cancel">): IngestPort {
  return {
    async start(identity, documentId) {
      const { ref, executionId, principal } = target(identity, documentId);
      try {
        return await runtime.start(ingestDocumentFlow, ref, { executionId, principal });
      } catch (err) {
        if (err instanceof ExecutionAlreadyExistsError) return null;
        throw err;
      }
    },
    async cancel(identity, documentId) {
      const { ref, principal } = target(identity, documentId);
      for (let generation = 1; generation <= INGEST_GENERATION; generation++) {
        const executionId = ingestExecutionId(ref.userId, ref.documentId, generation);
        try {
          await runtime.cancel(executionId, CANCEL_REASON, { principal });
        } catch (err) {
          // Loom throws a plain Error (no class or code) for an execution that never existed in
          // this generation; match its exact message for this id and nothing else.
          if (
            !(err instanceof Error && err.message === `No execution found for id: ${executionId}`)
          ) {
            throw err;
          }
        }
      }
    },
  };
}
