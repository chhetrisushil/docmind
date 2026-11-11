import type { Lineage } from "@loom-ui/lineage";
import type { ChatIdResolver } from "./chatIds";
import type { ChatRef } from "./turnItems";

export interface TurnHeads {
  /** Which of the chat's turns (assistant record ordinals) have visuals that resolve. */
  has(ref: ChatRef, ords: readonly number[]): Promise<Set<number>>;
}

/**
 * Whether each turn's line resolves, read at most `concurrency` at a time: the same test the visuals route runs first
 * (`resolveLatest`), so a reply is marked `hasVisuals` only when the strip's request can get past it. A line that cannot
 * be resolved (empty, erased, unreadable) has none. The cost is bounded: at most 30 ords per history page (the page
 * cap), 8 reads in flight. (The route's later check that a stored fact's document is still the user's is not repeated
 * here; the web hides a strip whose view fails to load.)
 */
export function lineageTurnHeads(
  lineage: Pick<Lineage, "resolveLatest">,
  chatIds: Pick<ChatIdResolver, "forRef">,
  concurrency = 8,
): TurnHeads {
  return {
    async has(ref, ords) {
      const found = new Set<number>();
      const ids = await chatIds.forRef(ref);
      if (!ids) return found;
      const queue = [...new Set(ords)];
      const worker = async () => {
        for (let ord = queue.shift(); ord !== undefined; ord = queue.shift()) {
          try {
            const r = await lineage.resolveLatest(ids.turnExperienceId(ord));
            if (r.ok) found.add(ord);
          } catch {
            // an unreadable line is no visuals
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
      return found;
    },
  };
}
