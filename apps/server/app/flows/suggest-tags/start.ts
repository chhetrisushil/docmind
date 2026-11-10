import type { Identity } from "@docmind/auth";
import {
  ExecutionAlreadyExistsError,
  type ExecutionHandle,
  type WorkflowRuntime,
} from "@loom/workflow-runtime";
import { type UserExecutionId, executionIdFor } from "../../subject";
import { MAX_RERUNS, rerunTracker } from "../rerunTracker";
import { SuggestTagsInput, suggestTagsFlow } from "./flow";

export type SuggestTagsStart =
  | { kind: "started"; run: number }
  | { kind: "running" }
  | { kind: "disabled" };

export interface SuggestTagsStarter {
  /**
   * Starts a run for the document unless one is in flight for it (`running`; also when every number is taken) or the model role
   * is off (`disabled`). One request at a time per document: the check, the probe and the start are one step. Throws on a
   * malformed ref (synchronously) or a Loom failure other than an id already taken.
   */
  start(ref: SuggestTagsInput): Promise<SuggestTagsStart>;
  /** Erasure: resolves when the document's pending starts have settled, so a cancel never runs before a start lands. */
  settle(identity: Pick<Identity, "userId">, documentId: string): Promise<void>;
  /**
   * Erasure: cancels every run number this process took for the document (unknown ones are fine). `reason` lands in the
   * log in the clear: a fixed word, never content. Runs are not recovery-owned, so none survives a restart to cancel.
   */
  cancel(identity: Identity, documentId: string, reason: string): Promise<void>;
  /** Resolves when every pending start has settled (shutdown, and before an erasure's shred). */
  idle(): Promise<void>;
}

/** `suggest-tags-<doc>-r<n>`: the name holds ids and a number, never content. */
export function suggestTagsExecutionId(
  userId: string,
  documentId: string,
  run: number,
): UserExecutionId {
  return executionIdFor(userId, `suggest-tags-${documentId.toLowerCase()}-r${run}`);
}

const keyOf = (userId: string, documentId: string) => `${userId}:${documentId.toLowerCase()}`;

export function loomSuggestTagsStarter(
  runtime: Pick<WorkflowRuntime, "start" | "cancel">,
  o: { enabled?: () => boolean } = {},
): SuggestTagsStarter {
  const tracker = rerunTracker();
  const pending = new Set<Promise<unknown>>();
  const byDocument = new Map<string, Set<Promise<unknown>>>();
  return {
    start(ref) {
      const input = SuggestTagsInput.parse(ref);
      const key = keyOf(input.userId, input.documentId);
      const work = tracker.exclusive(key, async (): Promise<SuggestTagsStart> => {
        if (o.enabled && !o.enabled()) return { kind: "disabled" };
        if (tracker.running(key)) return { kind: "running" };
        const out = await tracker.probe(key, 0, async (n): Promise<ExecutionHandle | null> => {
          const executionId = suggestTagsExecutionId(input.userId, input.documentId, n);
          try {
            const handle = await runtime.start(suggestTagsFlow, input, {
              executionId,
              principal: { tenant: input.tenantId, actor: input.userId },
            });
            tracker.track(key, executionId, handle);
            return handle;
          } catch (err) {
            if (err instanceof ExecutionAlreadyExistsError) return null;
            throw err;
          }
        });
        return out.kind === "started" ? { kind: "started", run: out.rerun } : { kind: "running" };
      });
      const mark = work.then(
        () => undefined,
        () => undefined,
      );
      const set = byDocument.get(key) ?? new Set<Promise<unknown>>();
      byDocument.set(key, set);
      pending.add(mark);
      set.add(mark);
      void mark.finally(() => {
        pending.delete(mark);
        set.delete(mark);
        if (set.size === 0 && byDocument.get(key) === set) byDocument.delete(key);
      });
      return work;
    },
    async settle(identity, documentId) {
      while (true) {
        const runs = byDocument.get(keyOf(identity.userId, documentId));
        if (!runs || runs.size === 0) return;
        await Promise.all([...runs]);
      }
    },
    async cancel(identity, documentId, reason) {
      const principal = { tenant: identity.tenantId, actor: identity.userId };
      const top = Math.min(tracker.last(keyOf(identity.userId, documentId)), MAX_RERUNS);
      for (let n = 1; n <= top; n++) {
        const executionId = suggestTagsExecutionId(identity.userId, documentId, n);
        try {
          await runtime.cancel(executionId, reason, { principal });
        } catch (err) {
          // Loom throws a plain Error (no class) for an execution that never existed; match its exact message for this id only.
          if (
            !(err instanceof Error && err.message === `No execution found for id: ${executionId}`)
          )
            throw err;
        }
      }
    },
    async idle() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
