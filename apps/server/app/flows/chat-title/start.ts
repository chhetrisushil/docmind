import {
  ExecutionAlreadyExistsError,
  type ExecutionHandle,
  type WorkflowRuntime,
} from "@loom/workflow-runtime";
import type { ChatIdResolver } from "../../chats/chatIds";
import type { ChatRef } from "../../chats/turnItems";
import { ChatTitleInput, chatTitleFlow } from "./flow";

export interface TitleStarter {
  /** Starts the chat's title flow once. `null`: already started, or not the owner's chat (callers must not read `null` as "a title exists"). Throws on a malformed ref or a Loom failure. */
  start(ref: ChatRef): Promise<ExecutionHandle | null>;
  /** `start` that never throws and is awaited by `idle`: for event callbacks and routes. */
  fire(ref: ChatRef): void;
  /** Resolves when every fired start has settled (shutdown). */
  idle(): Promise<void>;
}

const logClass = (err: unknown) =>
  console.error(
    "chat title start failed",
    err instanceof Error ? err.constructor.name : typeof err,
  );

export function loomTitleStarter(
  runtime: Pick<WorkflowRuntime, "start">,
  chatIds: Pick<ChatIdResolver, "forRef">,
  onError: (err: unknown) => void = logClass,
): TitleStarter {
  const pending = new Set<Promise<unknown>>();
  const start = async (ref: ChatRef): Promise<ExecutionHandle | null> => {
    const input = ChatTitleInput.parse({
      tenantId: ref.tenantId,
      userId: ref.userId,
      chatId: ref.chatId,
    });
    // The chat's own format: a chat that began under `u_<user>` starts (once) under it, never a second title under `h_<H>` (Decision 2).
    const ids = await chatIds.forRef(input);
    if (!ids) return null; // not the owner's chat any more
    try {
      return await runtime.start(chatTitleFlow, input, {
        // One title execution per chat: Loom starts a caller-chosen id once.
        executionId: ids.titleExecutionId(),
        principal: { tenant: input.tenantId, actor: input.userId },
      });
    } catch (err) {
      if (err instanceof ExecutionAlreadyExistsError) return null;
      throw err;
    }
  };
  return {
    start,
    fire(ref) {
      const run = start(ref).then(
        () => undefined,
        (err: unknown) => onError(err),
      );
      pending.add(run);
      void run.finally(() => pending.delete(run));
    },
    async idle() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
