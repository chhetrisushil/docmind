import type { CallObserver } from "@docmind/llm-anthropic";
import type { ChatBus } from "./bus";
import { type ChatCallScope, chatScope } from "./scope";
import type { PgReasoningBlocks, PgTurnItems } from "./turnItems";

export interface ChatObserverDeps {
  items: Pick<PgTurnItems, "put" | "remove">;
  blocks: Pick<PgReasoningBlocks, "put" | "get">;
  bus: Pick<ChatBus, "publish">;
}

const MAX_THINKING_CHARS = 32_000;

const refOf = (s: ChatCallScope) => ({ tenantId: s.tenantId, userId: s.userId, chatId: s.chatId });

/**
 * What the chat provider calls while a model request runs (D3): reasoning blocks go to the sealed
 * store (and come back for the next request of the tool loop), thinking deltas go to the live bus and
 * are kept for the turn item, a refusal becomes an outcome item. Absent outside a chat scope, so the
 * ingest providers and any call that is not a chat's are untouched. Usage is not used yet.
 */
export function chatObserver(deps: ChatObserverDeps): () => CallObserver | undefined {
  return () => {
    const scope = chatScope.current();
    if (!scope) return undefined;
    const ref = refOf(scope);
    let thinking = "";
    let stored: Promise<void> | undefined;
    let refused = false;
    // The accumulated thinking, stored once per request (a retried attempt overwrites its own row).
    const storeThinking = (): Promise<void> => {
      stored ??=
        thinking === "" || refused
          ? Promise.resolve()
          : deps.items.put(ref, scope.turnKey, scope.stepKey, {
              kind: "thinking",
              body: { text: thinking },
            });
      return stored;
    };
    return {
      onThinking(text) {
        if (thinking.length < MAX_THINKING_CHARS)
          thinking = (thinking + text).slice(0, MAX_THINKING_CHARS);
        deps.bus.publish(scope.chatId, { kind: "thinking", turnKey: scope.turnKey, text });
      },
      async onBlocks(toolUseIds, blocks) {
        if (refused) return; // a refused turn keeps no reasoning (its tool calls are dropped)
        if (toolUseIds.length > 0 && blocks.length > 0)
          await deps.blocks.put(ref, toolUseIds, blocks);
        await storeThinking();
      },
      async onRefusal(details) {
        // Thinking streamed before the refusal was known: the bus may have shown it, so drop it there
        // and store none (Task 130 carry).
        refused = true;
        await deps.items.remove(ref, scope.turnKey, scope.stepKey, "thinking"); // an earlier attempt's row
        deps.bus.publish(scope.chatId, { kind: "reset", turnKey: scope.turnKey });
        await deps.items.put(ref, scope.turnKey, scope.stepKey, {
          kind: "outcome",
          body: { kind: "refusal", details },
        });
      },
      onUsage() {
        // Usage is metered only through this hook (ruling P3); M4 meters nothing.
      },
    };
  };
}
