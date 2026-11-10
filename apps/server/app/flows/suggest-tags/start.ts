import type { Identity } from "@docmind/auth";
import {
  ExecutionAlreadyExistsError,
  type ExecutionHandle,
  type WorkflowRuntime,
} from "@loom/workflow-runtime";
import {
  type UserIdSource,
  existingUser,
  suggestTagsCandidates,
} from "../../documents/executionCandidates";
import { opaqueIds } from "../../opaqueIds";
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
  /** Whether a run is in flight for the document in this process (the route checks it before it spends a rate-limit token). */
  inFlight(ref: { userId: string; documentId: string }): boolean;
  /** Erasure: resolves when the document's pending starts have settled, so a cancel never runs before a start lands. */
  settle(identity: Pick<Identity, "userId">, documentId: string): Promise<void>;
  /**
   * Erasure: cancels the document's durable runs, walking r1, r2, … in Loom until one does not exist (past this process's
   * own counter), so it also finds runs started before a restart. `reason` lands in the log in the clear: a fixed word,
   * never content. Runs are recovery-owned, so one this walk misses is still re-driven or given up at boot.
   */
  cancel(identity: Identity, documentId: string, reason: string): Promise<void>;
  /** Resolves when every pending start has settled (shutdown, and before an erasure's shred). */
  idle(): Promise<void>;
}

/** A suggest-tags execution (boot recovery re-drives it: the step replaces the suggestions row, so a re-run is safe). */
export const isSuggestTagsExecution = (id: string): boolean =>
  opaqueIds.family(id) === "suggestTags";

const keyOf = (userId: string, documentId: string) => `${userId}:${documentId.toLowerCase()}`;

export function loomSuggestTagsStarter(
  runtime: Pick<WorkflowRuntime, "start" | "cancel">,
  o: { ids: UserIdSource; enabled?: () => boolean },
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
        // A key-store outage throws here, before Loom sees anything: a start never falls back to an id with the plain UUIDs.
        const user = await o.ids.ensureUser({ tenantId: input.tenantId, userId: input.userId });
        const out = await tracker.probe(key, 0, async (n): Promise<ExecutionHandle | null> => {
          const executionId = user.suggestTags(input.documentId, n);
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
    inFlight: (ref) => tracker.running(keyOf(ref.userId, ref.documentId)),
    async settle(identity, documentId) {
      while (true) {
        const runs = byDocument.get(keyOf(identity.userId, documentId));
        if (!runs || runs.size === 0) return;
        await Promise.all([...runs]);
      }
    },
    async cancel(identity, documentId, reason) {
      const principal = { tenant: identity.tenantId, actor: identity.userId };
      // Run numbers are taken in order, so the durable runs of a document are normally r1..rK: walk up from r1 until Loom
      // has no such execution (a restart forgets this process's counter, so it cannot be trusted alone). A start that failed
      // after taking a number can leave a gap and stop the walk early; recovery ownership then re-drives or ends that run.
      const seen = Math.min(tracker.last(keyOf(identity.userId, documentId)), MAX_RERUNS);
      // A run may be under either id format (from before the deploy, or after): cancel every candidate that exists. The walk stops at the
      // first number past this process's counter for which neither format exists.
      const user = await existingUser(o.ids, identity);
      const doc = documentId.toLowerCase(); // ids are lower-case; a caller's spelling may not be
      for (let n = 1; n <= MAX_RERUNS; n++) {
        let found = false;
        for (const executionId of suggestTagsCandidates(identity.userId, doc, n, user)) {
          try {
            await runtime.cancel(executionId, reason, { principal });
            found = true;
          } catch (err) {
            // Loom throws a plain Error (no class) for an execution that never existed; match its exact message for this id only.
            if (
              !(err instanceof Error && err.message === `No execution found for id: ${executionId}`)
            )
              throw err;
          }
        }
        if (!found && n > seen) break;
      }
    },
    async idle() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
