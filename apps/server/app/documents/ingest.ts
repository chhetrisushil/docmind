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

/** The execution that ingests one document. `name` is a fixed prefix plus a UUID: no content. */
export const ingestExecutionId = (userId: string, documentId: string): UserExecutionId =>
  executionIdFor(userId, `ingest-${documentId.toLowerCase()}`);

/** What the document routes need from the flow engine. */
export interface IngestPort {
  /** Starts the document's ingest execution. `null`: it already exists (start-once). */
  start(identity: Identity, documentId: string): Promise<ExecutionHandle | null>;
  /** Cancels it. An unknown or already finished execution is not an error; safe to repeat. */
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
      const { executionId, principal } = target(identity, documentId);
      try {
        await runtime.cancel(executionId, CANCEL_REASON, { principal });
      } catch (err) {
        // Never started (the start failed after the upload committed): nothing to cancel.
        if (err instanceof Error && err.message.startsWith("No execution found for id")) return;
        throw err;
      }
    },
  };
}
