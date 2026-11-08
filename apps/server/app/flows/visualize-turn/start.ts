import type { TurnSettledEvent } from "@loom/conversation";
import {
  ExecutionAlreadyExistsError,
  type ExecutionHandle,
  type RegisteredFlow,
  type WorkflowRuntime,
} from "@loom/workflow-runtime";
import { type TurnRef, turnExecutionId } from "./ids";
import { TurnInput } from "./model";
import { type TriggerDeps, turnToVisualize } from "./trigger";

export type VisualizeStart =
  | { kind: "started"; rerun: number }
  | { kind: "running" }
  | { kind: "disabled" };

export interface TurnVisualsStarter {
  /** For `turnSettledObserver`: enqueues the check and returns. Never throws. */
  onSettled(e: TurnSettledEvent): void;
  /** On demand: starts `-r<n>` with the next free number, unless a run of the turn is in flight. */
  visualize(ref: TurnRef): Promise<VisualizeStart>;
  /** True while a run of this turn that this process started has not finished. */
  running(ref: TurnRef): boolean;
  /** Resolves when every enqueued check and `runtime.start` call has settled (shutdown). It never waits for an execution to complete: a run that outlives shutdown resumes on boot through recovery. */
  idle(): Promise<void>;
}

export interface TurnStarterOptions extends TriggerDeps {
  onError?: (err: unknown) => void;
}

const MAX_RERUNS = 999;
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
  const inFlight = new Map<string, Set<string>>(); // `<chatId>:<ord>` -> execution ids running
  const lastRerun = new Map<string, number>();
  const keyOf = (r: TurnRef) => `${r.chatId}:${r.ord}`;
  const isRunning = (r: TurnRef) => (inFlight.get(keyOf(r))?.size ?? 0) > 0;

  /** Remembers the run until it ends (only `running` reads this; `idle()` does not wait for it, `pending` holds starts only). */
  const track = (ref: TurnRef, executionId: string, handle: ExecutionHandle) => {
    const key = keyOf(ref);
    const set = inFlight.get(key) ?? new Set<string>();
    inFlight.set(key, set);
    set.add(executionId);
    void handle
      .waitForCompletion()
      .then(
        () => undefined,
        () => undefined, // a failed run frees the turn too
      )
      .finally(() => {
        set.delete(executionId);
        if (set.size === 0 && inFlight.get(key) === set) inFlight.delete(key);
      });
  };

  /** Starts one execution id; null when Loom already has it. */
  const startOne = async (ref: TurnRef, rerun?: number): Promise<ExecutionHandle | null> => {
    const input = TurnInput.parse({
      tenantId: ref.tenantId,
      userId: ref.userId,
      chatId: ref.chatId,
      ord: ref.ord,
    });
    const executionId = turnExecutionId(input.userId, input.chatId, input.ord, rerun);
    try {
      const handle = await runtime.start(flow, input, {
        executionId,
        principal: { tenant: input.tenantId, actor: input.userId },
      });
      track(ref, executionId, handle);
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
      // Only an async function's synchronous prefix runs here (status, role, conversation id, backlog): the runtime calls
      // this on its write chain, so everything that touches the database or Loom is behind the first await.
      enqueue(
        turnToVisualize(e, o).then(async (ref) => {
          if (ref) await startOne(ref);
        }),
      );
    },
    async visualize(ref) {
      if (!o.enabled()) return { kind: "disabled" };
      if (isRunning(ref)) return { kind: "running" };
      for (let n = (lastRerun.get(keyOf(ref)) ?? 0) + 1; n <= MAX_RERUNS; n++) {
        if (await startOne(ref, n)) {
          lastRerun.set(keyOf(ref), n);
          return { kind: "started", rerun: n };
        }
      }
      throw new RangeError("too many re-runs of one turn");
    },
    running: isRunning,
    async idle() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
