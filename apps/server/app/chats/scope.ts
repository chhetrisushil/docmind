import { AsyncLocalStorage } from "node:async_hooks";
import { conversationIdOf } from "@loom/conversation";
import type { EffectContext } from "@loom/effect-runtime";
import { chatIdOfConversation, isChatFlowId } from "./ids";
import type { ChatRef } from "./turnItems";

/** What one model or tool call belongs to: whose chat, which turn, which step, which attempt. */
export interface ChatCallScope extends ChatRef {
  /** The turn key: the `<o>` of the step id (the consumed-message counter), see turnKeyOfRecord. */
  turnKey: number;
  /** The step id; the idempotency key of everything the call stores. */
  stepKey: string;
  attempt: number;
}

/** A model or tool call that is not a chat's, or is not the owner's. The message names nothing. */
export class ChatScopeError extends Error {
  constructor() {
    super("no chat scope for this call");
    this.name = "ChatScopeError";
  }
}

// `conv#o<o>#turn:<i>` (the model frame) and `conv#o<o>#turn:<i>:tool:<j>` (a tool frame), as the agent
// loop mints them under loopId `conv#o<o>` (agentLoop$.ts; there is no `:call` suffix on this route).
const STEP = /^conv#o([1-9][0-9]{0,8})#turn:[0-9]{1,4}(?::tool:[0-9]{1,4})?$/;

/**
 * Derives the scope from the call's own context, never from its input: tenant and user from the
 * principal Loom carries for the owning execution, the chat from the execution id, the turn from the
 * step id. Anything that does not fit throws, so a model call or a tool outside a chat conversation
 * (or one a delegate runs) stores nothing and reads nothing.
 */
export function scopeOfEffect(ctx: EffectContext): ChatCallScope {
  const p = ctx.principal;
  if (!p || !p.tenant || !p.actor || p.onBehalfOf !== undefined) throw new ChatScopeError();
  const ids = chatIdOfConversation(conversationIdOf(ctx.executionId));
  if (!ids || ids.userId !== p.actor || !isChatFlowId(ctx.workflowId)) throw new ChatScopeError();
  const step = STEP.exec(ctx.stepId);
  if (!step) throw new ChatScopeError();
  return {
    tenantId: p.tenant,
    userId: ids.userId,
    chatId: ids.chatId,
    turnKey: Number(step[1]),
    stepKey: ctx.stepId,
    attempt: ctx.attempt,
  };
}

const als = new AsyncLocalStorage<ChatCallScope>();

/** The one AsyncLocalStorage of the chat: set around the inner model effect so the provider's observer can read it. */
export const chatScope = {
  run<T>(scope: ChatCallScope, fn: () => Promise<T>): Promise<T> {
    return als.run(scope, fn);
  },
  current(): ChatCallScope | undefined {
    return als.getStore();
  },
};

/**
 * The turn key of a history record (fact C4). Loom numbers a conversation's messages twice: the step
 * ids use the count of messages CONSUMED (`o`), the records use the count of RECORDS written (`ord`),
 * and an accepted turn writes two records for one message. Every earlier accepted turn adds one to the
 * difference, and a record's `turn` is its accepted-turn number, so for a user record
 * `o = ord − (turn − 1)` and for its reply `o = ord − turn`. This holds while no rejected envelope is
 * only counted instead of recorded; the chat flow sets `maxInvalidRecords` high enough for that
 * (Task 146).
 */
export function turnKeyOfRecord(r: {
  role: "user" | "assistant";
  ord: number;
  turn: number;
}): number {
  return r.role === "user" ? r.ord - (r.turn - 1) : r.ord - r.turn;
}
