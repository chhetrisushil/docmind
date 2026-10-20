import {
  ExecutionAlreadyExistsError,
  type ExecutionHandle,
  type WorkflowRuntime,
} from "@loom/workflow-runtime";
import type { ChatRef } from "../../chats/turnItems";
import { executionIdFor } from "../../subject";
import { ChatTitleInput, chatTitleFlow } from "./flow";

export interface TitleStarter {
  /** Starts the chat's title flow once. `null`: it was already started. Throws on a malformed ref or a Loom failure. */
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
  onError: (err: unknown) => void = logClass,
): TitleStarter {
  const pending = new Set<Promise<unknown>>();
  const start = async (ref: ChatRef): Promise<ExecutionHandle | null> => {
    const input = ChatTitleInput.parse({
      tenantId: ref.tenantId,
      userId: ref.userId,
      chatId: ref.chatId,
    });
    try {
      return await runtime.start(chatTitleFlow, input, {
        // One title execution per chat: Loom starts a caller-chosen id once. The name holds no content.
        executionId: executionIdFor(input.userId, `chat-title-${input.chatId}`),
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
