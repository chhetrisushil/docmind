import type { ChatScope } from "@docmind/contracts";
import type { EffectContext } from "@loom/effect-runtime";
import { ChatBus, type LiveChatEvent } from "../bus";
import type { Passage } from "../retrieval";
import { C, FakeItems, T, U, modelCtx } from "../testing";
import type { ChatRef } from "../turnItems";
import type { ChatLookup, ToolHarnessDeps } from "./harness";

export const DOC_A = "d0c0a0a0-0000-4000-8000-00000000000a";
export const DOC_B = "d0c0b0b0-0000-4000-8000-00000000000b";
export const P1 = "00000001-0000-4000-8000-000000000001";
export const P2 = "00000002-0000-4000-8000-000000000002";
export const P3 = "00000003-0000-4000-8000-000000000003";

export const passage = (over: Partial<Passage> = {}): Passage => ({
  passageId: P1,
  documentId: DOC_A,
  docTitle: "Nocturne planning memo",
  locator: { kind: "section", index: 2 },
  headingPath: ["Plan", "Q3"],
  text: "The revenue forecast is seventeen thousand dollars.",
  ...over,
});

/** The context of tool call 0 of model turn 1 of turn key 3. */
export const toolCtx = (over: Partial<EffectContext> = {}): EffectContext =>
  modelCtx({ stepId: "conv#o3#turn:1:tool:0", ...over });

export class FakeChats implements ChatLookup {
  readonly asked: ChatRef[] = [];
  constructor(public scope: ChatScope | null = "all") {}
  async scopeOf(ref: ChatRef): Promise<ChatScope | null> {
    this.asked.push(ref);
    return this.scope;
  }
}

export function harness(scope: ChatScope | null = "all") {
  const chats = new FakeChats(scope);
  const items = new FakeItems();
  const bus = new ChatBus();
  const events: LiveChatEvent[] = [];
  bus.subscribe(C, (e) => events.push(e));
  const deps: ToolHarnessDeps = { chats, items, bus };
  return { deps, chats, items, events };
}

export const vectorScope = { tenantId: T, ownerId: U };
