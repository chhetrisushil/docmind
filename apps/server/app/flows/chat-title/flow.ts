import { flow$, step$ } from "@loom/core";
import type { RetryPolicy } from "@loom/core";
import type { FlowRunner, RegisteredFlow } from "@loom/workflow-runtime";
import { z } from "zod";

/** Ids only. The execution id is `executionIdFor(userId, "chat-title-" + chatId)`, which makes the start once-only. */
export const ChatTitleInput = z
  .object({ tenantId: z.string().uuid(), userId: z.string().uuid(), chatId: z.string().uuid() })
  .strict();
export type ChatTitleInput = z.infer<typeof ChatTitleInput>;

export const ChatTitleOutput = z.object({ outcome: z.enum(["titled", "skipped"]) }).strict();
export type ChatTitleOutput = z.infer<typeof ChatTitleOutput>;

/** Declared metadata (part of the flow's identity); the effect applies it. */
export const CHAT_TITLE_RETRY: RetryPolicy = {
  maxAttempts: 3,
  backoffMs: 2_000,
  backoffMultiplier: 2,
};

// A step id doubles as its tool id; `security.ts` grants it, and `config.ts` registers its effect.
export const chatTitleStep = step$({
  id: "chat-title",
  name: "ChatTitle",
  inputSchema: ChatTitleInput,
  outputSchema: ChatTitleOutput,
  retry: CHAT_TITLE_RETRY,
});

const runChatTitle: FlowRunner<ChatTitleInput, ChatTitleOutput> = async (ctx, input) =>
  ctx.run(chatTitleStep, input);

export const chatTitleFlow: RegisteredFlow = {
  definition: flow$({
    id: "chat-title",
    name: "ChatTitle",
    version: "1.0.0",
    inputSchema: ChatTitleInput,
    outputSchema: ChatTitleOutput,
    steps: [chatTitleStep],
  }),
  runner: runChatTitle as FlowRunner<unknown, unknown>,
};
