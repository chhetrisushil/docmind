import {
  MIN_DECISION_KEY_BYTES,
  type Planner,
  type PlannerModel,
  ReferencePlanner,
} from "@loom-ui/planner";
import { type LlmProvider, guardRequest } from "@loom/llm";
import { StartupConfigError } from "../../startupError";

const KEY_VARIABLE = "DOCMIND_PLANNER_DECISION_KEY";

/**
 * R19: the deployment secret that keys the planner's decision ids (plaintext in the log, surviving erasure). Base64 of
 * 32 or more random bytes, decoded to bytes. Never a per-user key (a destroyed key would orphan everyone else's
 * decisions). Required only when the `visuals` role is on; a bad value is a config error naming the variable.
 * Rotate it only with no visualize-document execution in flight: a resumed execution would re-plan live.
 */
export function loadPlannerDecisionKey(
  env: NodeJS.ProcessEnv,
  visualsOn: boolean,
): Uint8Array | undefined {
  const raw = env[KEY_VARIABLE]?.trim();
  if (!visualsOn) return undefined; // the role is off: nothing is read or validated
  if (!raw)
    throw new StartupConfigError(
      `${KEY_VARIABLE} is not set (required while the visuals role is on)`,
    );
  // Buffer's decoder skips what is not base64, so the shape is checked first.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || raw.length % 4 !== 0)
    throw new StartupConfigError(`${KEY_VARIABLE} must be base64`);
  const bytes = Uint8Array.from(Buffer.from(raw, "base64"));
  if (bytes.length < MIN_DECISION_KEY_BYTES)
    throw new StartupConfigError(
      `${KEY_VARIABLE} must decode to at least ${MIN_DECISION_KEY_BYTES} bytes`,
    );
  return bytes;
}

/** Planner calls in flight, process-wide, across both visuals flows (the step gate does not cover `ctx.decide`). */
export const PLANNER_CONCURRENCY = 2;

/** A counting semaphore: `acquire` resolves with a release function; an aborted waiter leaves the queue and rejects. */
class Semaphore {
  private free: number;
  private readonly waiting: (() => void)[] = [];
  constructor(slots: number) {
    this.free = slots;
  }
  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.free > 0) this.free--;
    else
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          this.waiting.splice(this.waiting.indexOf(wake), 1);
          reject(signal?.reason);
        };
        this.waiting.push(wake);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next)
        next(); // the slot passes straight on
      else this.free++;
    };
  }
}

const plannerSlots = new Semaphore(PLANNER_CONCURRENCY);

/**
 * The planner's model over the `visuals` provider, called DIRECTLY (not through the decide scope's
 * `invokeTransient`): the call writes no event, so the prompt (which holds the facts) never reaches the log. The
 * planner fences the document data itself; `guardRequest` is Loom's own request check. Every call holds one of the
 * process-wide planner slots, so at most `PLANNER_CONCURRENCY` planner calls are in flight across both visuals flows.
 */
export function plannerModelOf(llm: LlmProvider): PlannerModel {
  return {
    async complete(request, opts) {
      const release = await plannerSlots.acquire(opts?.signal);
      try {
        const guarded = guardRequest({
          ...(request.system !== undefined && { system: request.system }),
          messages: request.messages.map((m) => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content : [...m.content],
          })) as never,
          temperature: 0,
        });
        const res = await llm.complete({
          ...guarded,
          ...(opts?.signal && { signal: opts.signal }),
        });
        return {
          content: res.content,
          ...(res.usage && { usage: res.usage }),
        };
      } finally {
        release();
      }
    },
  };
}

/** The visuals planner: the reference planner over `plannerModelOf(llm)`, its decision ids keyed by `decisionKey`. */
export function visualsPlanner(llm: LlmProvider, decisionKey: Uint8Array): Planner {
  const model = String((llm as { model?: unknown }).model ?? "unknown").slice(0, 200);
  return new ReferencePlanner({ model: plannerModelOf(llm), modelId: model, decisionKey });
}
