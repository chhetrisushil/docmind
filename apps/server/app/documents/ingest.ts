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

/** The generation a new document starts at (0018's column default). Tests use it; production passes the row's. */
export const INGEST_GENERATION = 2;
const MAX_GENERATION = 999_999_999; // the status model's execution-id pattern allows 9 digits

const checkGeneration = (generation: number): number => {
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > MAX_GENERATION)
    throw new RangeError("generation must be an integer from 1 to 999999999");
  return generation;
};

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
  /** Starts this generation of the document's ingest. `null`: it already exists (start-once). */
  start(
    identity: Identity,
    documentId: string,
    generation: number,
  ): Promise<ExecutionHandle | null>;
  /**
   * Cancels the document's current generation and the one before it (`max(1, generation - 1)..generation`).
   * A retry is only allowed when the previous generation is failed (terminal), so older ones are
   * already finished. Unknown or finished ones are not an error.
   */
  cancel(identity: Identity, documentId: string, generation: number): Promise<void>;
}

const target = (identity: Identity, documentId: string, generation: number) => {
  const ref = ingestStartInput(identity, documentId);
  return {
    ref,
    executionId: ingestExecutionId(ref.userId, ref.documentId, checkGeneration(generation)),
    principal: { tenant: ref.tenantId, actor: ref.userId },
  };
};

// A fixed reason: the cancel reason is recorded in the log, so it never names the document.
const CANCEL_REASON = "document-deleted";

export function loomIngest(runtime: Pick<WorkflowRuntime, "start" | "cancel">): IngestPort {
  return {
    async start(identity, documentId, generation) {
      const { ref, executionId, principal } = target(identity, documentId, generation);
      try {
        return await runtime.start(ingestDocumentFlow, ref, { executionId, principal });
      } catch (err) {
        if (err instanceof ExecutionAlreadyExistsError) return null;
        throw err;
      }
    },
    async cancel(identity, documentId, generation) {
      const { ref, principal } = target(identity, documentId, generation);
      for (let g = Math.max(1, generation - 1); g <= generation; g++) {
        const executionId = ingestExecutionId(ref.userId, ref.documentId, g);
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
