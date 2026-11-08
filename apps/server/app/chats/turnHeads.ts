import type { Lineage } from "@loom-ui/lineage";
import { turnExperienceId } from "../flows/visualize-turn/ids";

export interface TurnHeads {
  /** Which of the chat's turns (assistant record ordinals) have a visuals head. */
  has(ref: { userId: string; chatId: string }, ords: readonly number[]): Promise<Set<number>>;
}

/** Heads of the turn lines, read at most `concurrency` at a time. A line that cannot be read (erased, unreadable) has no head. */
export function lineageTurnHeads(lineage: Pick<Lineage, "head">, concurrency = 8): TurnHeads {
  return {
    async has(ref, ords) {
      const found = new Set<number>();
      const queue = [...new Set(ords)];
      const worker = async () => {
        for (let ord = queue.shift(); ord !== undefined; ord = queue.shift()) {
          try {
            const r = await lineage.head(turnExperienceId({ ...ref, ord }));
            if (r.ok && r.value !== null) found.add(ord);
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
