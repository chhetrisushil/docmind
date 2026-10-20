import type { EffectContext } from "@loom/effect-runtime";
import { chatConversationId } from "./ids";
import type {
  ChatRef,
  PgReasoningBlocks,
  PgTurnItems,
  ReasoningBlock,
  TurnItem,
} from "./turnItems";

export const T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const U = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
export const C = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";

/** The context Loom gives a model frame of turn key 3 in chat C, attempt 1. */
export const modelCtx = (over: Partial<EffectContext> = {}): EffectContext => ({
  executionId: chatConversationId(U, C),
  stepId: "conv#o3#turn:1",
  workflowId: "doc-chat",
  attempt: 1,
  emit: () => {},
  principal: { tenant: T, actor: U },
  ...over,
});

/** Records every `put`; an item put twice under one key is overwritten, like the table's ON CONFLICT. */
export class FakeItems implements Pick<PgTurnItems, "put" | "remove" | "forTurns"> {
  readonly puts: { turnKey: number; stepKey: string; item: TurnItem }[] = [];
  async put(_ref: ChatRef, turnKey: number, stepKey: string, item: TurnItem): Promise<void> {
    const at = this.puts.findIndex(
      (p) => p.turnKey === turnKey && p.stepKey === stepKey && p.item.kind === item.kind,
    );
    if (at >= 0) this.puts[at] = { turnKey, stepKey, item };
    else this.puts.push({ turnKey, stepKey, item });
  }
  async remove(
    _ref: ChatRef,
    turnKey: number,
    stepKey: string,
    kind: TurnItem["kind"],
  ): Promise<void> {
    const at = this.puts.findIndex(
      (p) => p.turnKey === turnKey && p.stepKey === stepKey && p.item.kind === kind,
    );
    if (at >= 0) this.puts.splice(at, 1);
  }
  async forTurns(_ref: ChatRef, turnKeys: readonly number[]): Promise<Map<number, TurnItem[]>> {
    const out = new Map<number, TurnItem[]>();
    for (const p of this.puts)
      if (turnKeys.includes(p.turnKey)) out.set(p.turnKey, [...(out.get(p.turnKey) ?? []), p.item]);
    return out;
  }
}

export class FakeBlocks implements Pick<PgReasoningBlocks, "put" | "get"> {
  private readonly store = new Map<string, readonly ReasoningBlock[]>();
  /** Every put, in order (so a test can prove a block was really stored). */
  readonly puts: { ids: readonly string[]; blocks: readonly ReasoningBlock[] }[] = [];
  async put(
    _ref: ChatRef,
    ids: readonly string[],
    blocks: readonly ReasoningBlock[],
  ): Promise<void> {
    if (blocks.length === 0) return;
    this.puts.push({ ids, blocks });
    for (const id of ids) this.store.set(id, blocks);
  }
  async get(_ref: ChatRef, ids: readonly string[]): Promise<ReasoningBlock[]> {
    const first = ids.map((id) => this.store.get(id)).find((b) => b !== undefined);
    return first ? [...first] : [];
  }
}
