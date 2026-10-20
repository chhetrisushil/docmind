import type { CallObserver } from "@docmind/llm-anthropic";
import { chatScope } from "./scope";
import type { PgTurnItems } from "./turnItems";

export interface ChatObserverDeps {
  items: Pick<PgTurnItems, "put">;
}

/**
 * What the chat provider calls while a model request runs (M4 D3, after the ADR 0133 amendment). Reasoning is
 * not here: it comes back in the response and Loom captures it. What is left is what Loom's response type cannot
 * carry: a refusal becomes an outcome item (sealed with the other items), usage is not metered in M4 (ruling P3).
 * Absent outside a chat scope, so the ingest providers and any call that is not a chat's are untouched.
 */
export function chatObserver(deps: ChatObserverDeps): () => CallObserver | undefined {
  return () => {
    const scope = chatScope.current();
    if (!scope) return undefined;
    return {
      async onRefusal(details) {
        await deps.items.put(scope, scope.turnKey, scope.stepKey, {
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
