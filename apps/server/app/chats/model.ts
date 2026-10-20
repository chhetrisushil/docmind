import type { AgentModelCall } from "@loom/agent";
import type { Effect, EffectContext } from "@loom/effect-runtime";
import type { LlmResponse } from "@loom/llm";
import type { ChatBus } from "./bus";
import { chatScope, scopeOfEffect } from "./scope";
import type { PgTurnItems } from "./turnItems";

export interface ChatModelDeps {
  items: Pick<PgTurnItems, "put" | "remove">;
  bus: Pick<ChatBus, "publish">;
  /** Aborted by `ChatWiring.close()`: cuts an in-flight model call and leaves the step un-completed. */
  shutdown?: AbortSignal;
}

/** Never settles: a shutdown must leave the step un-completed, as after a crash (cf. stepEffect.ts INTERRUPTED). */
const INTERRUPTED: Promise<never> = new Promise<never>(() => {});

/**
 * The agent's model effect for a chat: the inner `createAgentModelEffect(hub.wrapProvider(provider))`
 * run inside the call's `chatScope`, which is how the provider's observer learns whose chat and turn
 * it is serving (D4). Loom reads an effect's capabilities off the registered object (fact C5), so the
 * fields it uses are copied from the inner effect and the runtime still sees one `llm` effect, with the
 * hub's delta sink and the pre-warm intact.
 */
export function chatModelEffect(
  inner: Effect<AgentModelCall, LlmResponse>,
  deps: ChatModelDeps,
): Effect<AgentModelCall, LlmResponse> {
  const wrapper: Record<string, unknown> = {};
  // Every capability of the inner effect (own or inherited from a class, e.g. reasoning, reasoningSink,
  // resourceOf), methods bound to it; only `execute` is replaced.
  for (let o: object | null = inner; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const key of Object.getOwnPropertyNames(o)) {
      if (key === "execute" || key === "constructor" || key in wrapper) continue;
      const v = (inner as unknown as Record<string, unknown>)[key];
      wrapper[key] = typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(inner) : v;
    }
  }
  return Object.assign(wrapper, {
    async execute(input: AgentModelCall, ctx: EffectContext): Promise<LlmResponse> {
      const scope = scopeOfEffect(ctx); // throws ChatScopeError before anything is sent
      // A retried attempt starts the stream over: tell the listeners to drop what they showed.
      if (ctx.attempt > 1)
        deps.bus.publish(scope.chatId, { kind: "reset", turnKey: scope.turnKey });
      const call = withShutdown(ctx, deps.shutdown);
      // During shutdown whatever fails leaves the step un-completed, as after a crash.
      const interrupted = () => deps.shutdown?.aborted === true && ctx.signal?.aborted !== true;
      let response: LlmResponse;
      try {
        // The retried attempt's response replaces the earlier one: drop its stale outcome row (a refusal or a
        // max_tokens of the attempt before). Reasoning needs no cleanup: Loom keeps every attempt and marks the
        // recorded one.
        if (ctx.attempt > 1)
          await deps.items.remove(scope, scope.turnKey, scope.stepKey, "outcome");
        response = await chatScope.run(scope, () => inner.execute(input, call));
        if (response.stopReason === "max_tokens") {
          await deps.items.put(scope, scope.turnKey, scope.stepKey, {
            kind: "outcome",
            body: { kind: "max_tokens" },
          });
        }
      } catch (err) {
        if (interrupted()) return INTERRUPTED;
        throw err;
      }
      return response;
    },
  } as Effect<AgentModelCall, LlmResponse>);
}

/** The context with the shutdown signal merged into the call's own, so the provider stream is cut. */
function withShutdown(ctx: EffectContext, shutdown: AbortSignal | undefined): EffectContext {
  if (!shutdown) return ctx;
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, shutdown]) : shutdown;
  return { ...ctx, signal };
}
