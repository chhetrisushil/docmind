import { randomUUID } from "node:crypto";
import { ExecutionAlreadyExistsError } from "@loom/workflow-runtime";
import { describe, expect, it, vi } from "vitest";
import { isChatExecution } from "../../chats/activity";
import { isRecoverableChatExecution } from "../../chats/ids";
import { ChatTitleInput } from "./flow";
import { loomTitleStarter } from "./start";

const ref = { tenantId: randomUUID(), userId: randomUUID(), chatId: randomUUID() };
const handle = { executionId: "x" };

describe("loomTitleStarter", () => {
  it("starts the flow under the user's own execution id, as the user, with ids only", async () => {
    const start = vi.fn(async () => handle);
    const starter = loomTitleStarter({ start } as never);
    expect(await starter.start(ref)).toBe(handle);
    const [flow, input, options] = start.mock.calls[0] as unknown as [
      { definition: { id: string } },
      unknown,
      { executionId: string; principal: unknown },
    ];
    expect(flow.definition.id).toBe("chat-title");
    expect(input).toEqual(ref);
    expect(ChatTitleInput.safeParse(input).success).toBe(true);
    expect(options).toEqual({
      executionId: `u_${ref.userId}:chat-title-${ref.chatId}`,
      principal: { tenant: ref.tenantId, actor: ref.userId },
    });
  });

  it("is not mistaken for a chat conversation by the activity model, and is claimed by boot recovery", () => {
    const id = `u_${ref.userId}:chat-title-${ref.chatId}`;
    expect(isChatExecution(id)).toBe(false);
    expect(isRecoverableChatExecution(id)).toBe(true);
  });

  it("treats an execution that already exists as started", async () => {
    const starter = loomTitleStarter({
      start: async () => {
        throw new ExecutionAlreadyExistsError("x");
      },
    } as never);
    expect(await starter.start(ref)).toBeNull();
  });

  it("fire never throws: a failed start is reported by class, and idle waits for it", async () => {
    const errors: unknown[] = [];
    const starter = loomTitleStarter(
      {
        start: async () => {
          throw new RangeError("boom");
        },
      } as never,
      (e) => errors.push(e),
    );
    starter.fire(ref);
    await starter.idle();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(RangeError);
  });

  it("refuses a ref that is not made of uuids before Loom sees it", async () => {
    const starter = loomTitleStarter({ start: vi.fn() } as never);
    await expect(starter.start({ ...ref, chatId: "not-a-uuid" })).rejects.toMatchObject({
      name: "ZodError",
    });
  });
});
