import type { TurnSettledEvent } from "@loom/conversation";
import {
  ExecutionAlreadyExistsError,
  type ExecutionHandle,
  type RegisteredFlow,
  type WorkflowRuntime,
} from "@loom/workflow-runtime";
import type { ChatIdResolver } from "../../chats/chatIds";
import { rerunTracker } from "../rerunTracker";
import { TurnGoneError } from "./errors";
import type { TurnRef } from "./ids";
import { TurnInput } from "./model";
import { type TriggerDeps, turnToVisualize } from "./trigger";

export type VisualizeStart =
  | { kind: "started"; rerun: number }
  | { kind: "running" }
  | { kind: "disabled" };

export interface TurnVisualsStarter {
  /** For `turnSettledObserver`: enqueues the check and returns. Never throws. */
  onSettled(e: TurnSettledEvent): void;
  /** On demand: starts `-r<n>` with the next free number, unless a run of the turn is in flight (or every number is taken: also `running`). */
  visualize(ref: TurnRef): Promise<VisualizeStart>;
  /** True while a run of this turn that this process started has not finished. */
  running(ref: TurnRef): boolean;
  /** Resolves when every enqueued check and `runtime.start` call has settled (shutdown). It never waits for an execution to complete: a run that outlives shutdown resumes on boot through recovery. */
  idle(): Promise<void>;
}

export interface TurnStarterOptions extends TriggerDeps {
  /** Builds the turn's run id in its chat's own format. */
  chatIds: Pick<ChatIdResolver, "forRef">;
  onError?: (err: unknown) => void;
}

const logClass = (err: unknown) =>
  console.error(
    "visualize-turn start failed",
    err instanceof Error ? err.constructor.name : typeof err,
  );

export function loomTurnStarter(
  runtime: Pick<WorkflowRuntime, "start">,
  flow: RegisteredFlow,
  o: TurnStarterOptions,
): TurnVisualsStarter {
  const onError = o.onError ?? logClass;
  const pending = new Set<Promise<unknown>>();
  const tracker = rerunTracker();
  const keyOf = (r: TurnRef) => `${r.chatId}:${r.ord}`;
  const isRunning = (r: TurnRef) => tracker.running(keyOf(r));

  /** Starts one execution id; null when Loom already has it. */
  const startOne = async (ref: TurnRef, rerun?: number): Promise<ExecutionHandle | null> => {
    const input = TurnInput.parse({
      tenantId: ref.tenantId,
      userId: ref.userId,
      chatId: ref.chatId,
      ord: ref.ord,
    });
    const ids = await o.chatIds.forRef(ref);
    if (!ids) throw new TurnGoneError(); // the chat went (erased): a number probe must not treat it as "id taken"
    const executionId = ids.turnExecutionId(input.ord, rerun);
    try {
      const handle = await runtime.start(flow, input, {
        executionId,
        principal: { tenant: input.tenantId, actor: input.userId },
      });
      tracker.track(keyOf(ref), executionId, handle);
      return handle;
    } catch (err) {
      if (err instanceof ExecutionAlreadyExistsError) return null;
      throw err;
    }
  };

  const enqueue = <T>(p: Promise<T>) => {
    const run = p.then(
      () => undefined,
      (err: unknown) => onError(err),
    );
    pending.add(run);
    void run.finally(() => pending.delete(run));
  };

  return {
    onSettled(e) {
      // Only an async function's synchronous prefix runs here (status, role, conversation id, backlog, and the dispatch of
      // `tenantOf`'s query, which is not awaited here): the runtime calls this on its write chain, so nothing blocks it;
      // everything after that first await runs later.
      enqueue(
        turnToVisualize(e, o).then(async (ref) => {
          if (!ref) return;
          try {
            await startOne(ref);
          } catch (err) {
            if (!(err instanceof TurnGoneError)) throw err; // the chat went (erased): nothing to start, nothing to report
          }
        }),
      );
    },
    visualize: (ref) =>
      // One request at a time per turn: the check, the probe and the start are one step, so two clicks start one run.
      tracker.exclusive(keyOf(ref), async () => {
        if (!o.enabled()) return { kind: "disabled" };
        if (isRunning(ref)) return { kind: "running" };
        const out = await tracker.probe(keyOf(ref), 0, (n) => startOne(ref, n));
        return out.kind === "started" ? { kind: "started", rerun: out.rerun } : { kind: "running" };
      }),
    running: isRunning,
    async idle() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
