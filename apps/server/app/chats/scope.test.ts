import type { EffectContext } from "@loom/effect-runtime";
import { describe, expect, it } from "vitest";
import { chatConversationId } from "./ids";
import { ChatScopeError, chatScope, scopeOfEffect, turnKeyOfRecord } from "./scope";

const T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const U = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const C = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
const EXEC = chatConversationId(U, C);

const ctx = (over: Partial<EffectContext> = {}): EffectContext => ({
  executionId: EXEC,
  stepId: "conv#o3#turn:1",
  workflowId: "doc-chat",
  attempt: 2,
  emit: () => {},
  principal: { tenant: T, actor: U },
  ...over,
});

describe("scopeOfEffect", () => {
  it("reads tenant and user from the principal, the chat from the execution id, the turn key from the step id", () => {
    expect(scopeOfEffect(ctx())).toEqual({
      tenantId: T,
      userId: U,
      chatId: C,
      turnKey: 3,
      stepKey: "conv#o3#turn:1",
      attempt: 2,
    });
  });

  it("reads a tool step of a later generation", () => {
    expect(
      scopeOfEffect(
        ctx({
          executionId: `${EXEC}~2`,
          stepId: "conv#o120#turn:0:tool:3",
          workflowId: "doc-chat-gk",
        }),
      ),
    ).toMatchObject({ chatId: C, turnKey: 120, stepKey: "conv#o120#turn:0:tool:3" });
  });

  it.each([
    ["no principal", { principal: undefined }],
    ["no tenant", { principal: { actor: U } }],
    ["no actor", { principal: { tenant: T } }],
    ["a delegated principal", { principal: { tenant: T, actor: U, onBehalfOf: "someone" } }],
    [
      "another user's conversation",
      { principal: { tenant: T, actor: "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1" } },
    ],
    ["an ingest execution", { executionId: `u_${U}:ingest-${C}` }],
    ["a non-chat flow", { workflowId: "ingest-document" }],
    ["the summarize step", { stepId: "conv#o3:summarize" }],
    ["turn key 0", { stepId: "conv#o0#turn:0" }],
    ["a leading-zero turn key", { stepId: "conv#o03#turn:0" }],
    ["a loop that is not a conversation's", { stepId: "agent#turn:0" }],
    ["trailing text", { stepId: "conv#o3#turn:0:tool:1:outcome" }],
  ] as [string, Partial<EffectContext>][])("throws ChatScopeError for %s", (_name, over) => {
    expect(() => scopeOfEffect(ctx(over))).toThrow(ChatScopeError);
  });

  it("uses a fixed message that names no id", () => {
    expect(() => scopeOfEffect(ctx({ principal: undefined }))).toThrow(
      /^no chat scope for this call$/,
    );
  });
});

describe("chatScope", () => {
  const scope = scopeOfEffect(ctx());

  it("is visible to everything the callback awaits, and gone outside it", async () => {
    expect(chatScope.current()).toBeUndefined();
    const seen = await chatScope.run(scope, async () => {
      await Promise.resolve();
      return chatScope.current();
    });
    expect(seen).toBe(scope);
    expect(chatScope.current()).toBeUndefined();
  });

  it("keeps two concurrent runs apart", async () => {
    const other = { ...scope, turnKey: 9 };
    const [a, b] = await Promise.all([
      chatScope.run(scope, async () => {
        await Promise.resolve();
        return chatScope.current()?.turnKey;
      }),
      chatScope.run(other, async () => chatScope.current()?.turnKey),
    ]);
    expect([a, b]).toEqual([3, 9]);
  });
});

describe("turnKeyOfRecord (fact C4)", () => {
  // Turn 1: consumed #1, records 1 (user) and 2 (reply). A rejected message: consumed #2, record 3.
  // Turn 2: consumed #3, records 4 (user) and 5 (reply).
  it("maps a record back to the consumed-message counter of its turn", () => {
    expect(turnKeyOfRecord({ role: "user", ord: 1, turn: 1 })).toBe(1);
    expect(turnKeyOfRecord({ role: "assistant", ord: 2, turn: 1 })).toBe(1);
    expect(turnKeyOfRecord({ role: "user", ord: 4, turn: 2 })).toBe(3);
    expect(turnKeyOfRecord({ role: "assistant", ord: 5, turn: 2 })).toBe(3);
  });
});
