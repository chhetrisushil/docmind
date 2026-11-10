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
import { type UserIdSource, existingUser, ingestCandidates } from "./executionCandidates";
import type { ExecutionRecorder } from "./executionIds";

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
    generation: checkGeneration(generation),
    principal: { tenant: ref.tenantId, actor: ref.userId },
  };
};

// A fixed reason: the cancel reason is recorded in the log, so it never names the document.
const CANCEL_REASON = "document-deleted";

export interface LoomIngestOptions {
  /** The id cache: a start builds the new-format id with the user's key; a cancel also tries the old format. */
  ids: UserIdSource;
  /** Records the id of the generation's execution on the document before it starts (migration 0038); absent in tests that need no sweep. */
  executions?: ExecutionRecorder;
}

export function loomIngest(
  runtime: Pick<WorkflowRuntime, "start" | "cancel">,
  o: LoomIngestOptions,
): IngestPort {
  return {
    async start(identity, documentId, generation) {
      const { ref, principal, generation: g } = target(identity, documentId, generation);
      // A key-store outage throws here, before Loom sees anything: a start never falls back to an id with the plain UUIDs.
      const user = await o.ids.ensureUser({ tenantId: ref.tenantId, userId: ref.userId });
      const executionId = user.ingest(ref.documentId, g);
      // Recorded BEFORE the start: a crash in between leaves an id with no status row, which the stale-upload sweep lists and starts again.
      await o.executions?.recordIngest(
        { tenantId: ref.tenantId, userId: ref.userId },
        ref.documentId,
        g,
        executionId,
      );
      try {
        return await runtime.start(ingestDocumentFlow, ref, { executionId, principal });
      } catch (err) {
        if (err instanceof ExecutionAlreadyExistsError) return null;
        throw err;
      }
    },
    async cancel(identity, documentId, generation) {
      const { ref, principal, generation: top } = target(identity, documentId, generation);
      // Old-format runs (from before the deploy) and new-format runs may both exist: cancel every candidate that does.
      const user = await existingUser(o.ids, identity);
      for (let g = Math.max(1, top - 1); g <= top; g++) {
        for (const executionId of ingestCandidates(ref.userId, ref.documentId, g, user)) {
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
      }
    },
  };
}
