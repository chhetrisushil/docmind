import type { AgentModelCall } from "@loom/agent";
import type { Effect, EffectContext } from "@loom/effect-runtime";
import type { LlmResponse } from "@loom/llm";
import type { ChatBus } from "./bus";
import { chatScope, scopeOfEffect } from "./scope";
import type { PgTurnItems } from "./turnItems";

export interface ChatModelDeps {
  items: Pick<PgTurnItems, "put">;
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
  const { deltaSink, warm } = inner;
  return {
    kind: inner.kind,
    ...(inner.idempotent !== undefined && { idempotent: inner.idempotent }),
    ...(inner.errors !== undefined && { errors: inner.errors }),
    ...(inner.mode !== undefined && { mode: inner.mode }),
    ...(warm && { warm: () => warm.call(inner) }),
    ...(deltaSink && { deltaSink: (chunk, ctx) => deltaSink.call(inner, chunk, ctx) }),
    async execute(input: AgentModelCall, ctx: EffectContext): Promise<LlmResponse> {
      const scope = scopeOfEffect(ctx); // throws ChatScopeError before anything is sent
      // A retried attempt starts the stream over: tell the listeners to drop what they showed.
      if (ctx.attempt > 1)
        deps.bus.publish(scope.chatId, { kind: "reset", turnKey: scope.turnKey });
      const call = withShutdown(ctx, deps.shutdown);
      let response: LlmResponse;
      try {
        response = await chatScope.run(scope, () => inner.execute(input, call));
      } catch (err) {
        if (deps.shutdown?.aborted === true && ctx.signal?.aborted !== true) return INTERRUPTED;
        throw err;
      }
      if (response.stopReason === "max_tokens") {
        await deps.items.put(scope, scope.turnKey, scope.stepKey, {
          kind: "outcome",
          body: { kind: "max_tokens" },
        });
      }
      return response;
    },
  };
}

/** The context with the shutdown signal merged into the call's own, so the provider stream is cut. */
function withShutdown(ctx: EffectContext, shutdown: AbortSignal | undefined): EffectContext {
  if (!shutdown) return ctx;
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, shutdown]) : shutdown;
  return { ...ctx, signal };
}
