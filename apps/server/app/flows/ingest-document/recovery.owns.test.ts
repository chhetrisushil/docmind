import { beforeEach, describe, expect, it, vi } from "vitest";

type Claim = {
  isAbandoned?: (c: { executionId: string; updatedAt: number }) => boolean;
  onError?: (executionId: string, err: unknown) => void;
};
const seen = vi.hoisted(() => [] as Claim[]);
vi.mock("@loom/workflow-runtime", async (orig) => ({
  ...(await orig<typeof import("@loom/workflow-runtime")>()),
  collectGhostLeases: vi.fn(async () => 0),
  recoverAbandoned: vi.fn(async (_rt: unknown, options: Claim) => {
    seen.push(options);
    return { scanned: 0, candidates: 0, recovered: 0, failed: 0, exhausted: 0 };
  }),
}));

import { FlowCodeMismatchError } from "@loom/workflow-runtime";
import { chatConversationId, isRecoverableChatExecution } from "../../chats/ids";
import { recoverIngest } from "./recovery";

const U = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const C = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
const cancel = vi.fn(async () => {});
const runtime = {
  leaseKeeper: undefined,
  cancel,
  systemOptions: () => ({}),
} as never;
const source = {} as never;
const OLD = { updatedAt: 0 };

beforeEach(() => {
  seen.length = 0;
  cancel.mockClear();
});

describe("recoverIngest owns", () => {
  it("claims only ingest executions by default", async () => {
    await recoverIngest(runtime, source, { graceMs: 10, now: () => 1_000 });
    const claim = seen[0]?.isAbandoned;
    expect(claim?.({ executionId: `u_${U}:ingest-${C}`, ...OLD })).toBe(true);
    expect(claim?.({ executionId: chatConversationId(U, C), ...OLD })).toBe(false);
  });

  it("claims a chat conversation, and a later generation of one, when told to", async () => {
    const owns = (id: string) => id.includes(":ingest-") || isRecoverableChatExecution(id);
    await recoverIngest(runtime, source, { graceMs: 10, now: () => 1_000, owns });
    const claim = seen[0]?.isAbandoned;
    expect(claim?.({ executionId: chatConversationId(U, C), ...OLD })).toBe(true);
    expect(claim?.({ executionId: `${chatConversationId(U, C)}~3`, ...OLD })).toBe(true);
    expect(claim?.({ executionId: "x-other", ...OLD })).toBe(false);
  });

  it("claims a chat title execution with isRecoverableChatExecution, and no other id", async () => {
    const owns = (id: string) => id.includes(":ingest-") || isRecoverableChatExecution(id);
    await recoverIngest(runtime, source, { graceMs: 10, now: () => 1_000, owns });
    const claim = seen[0]?.isAbandoned;
    expect(claim?.({ executionId: `u_${U}:chat-title-${C}`, ...OLD })).toBe(true);
    expect(claim?.({ executionId: `u_${U}:other-${C}`, ...OLD })).toBe(false);
  });

  it("still waits out the grace period before claiming", async () => {
    await recoverIngest(runtime, source, { graceMs: 5_000, now: () => 1_000, owns: () => true });
    expect(seen[0]?.isAbandoned?.({ executionId: "any", updatedAt: 0 })).toBe(false);
  });

  it("a flow mismatch cancels an ingest execution but only logs a chat, whichever Loom path reports it", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await recoverIngest(runtime, source, { graceMs: 10, owns: () => true });
    const onError = seen[0]?.onError;
    const mismatch = () => new FlowCodeMismatchError("x", "doc-chat", "1.0.0", "2.0.0", "code");
    onError?.(chatConversationId(U, C), mismatch());
    onError?.(`u_${U}:chat-title-${C}`, mismatch());
    expect(cancel).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith(
      "recovery left a chat on an old flow version",
      "FlowCodeMismatchError",
    );
    onError?.(`u_${U}:ingest-${C}`, mismatch());
    expect(cancel).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });

  it("once recovery is stopped a failing re-drive is not logged; before that it is", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let stopped = false;
    await recoverIngest(runtime, source, { graceMs: 10, owns: () => true, stopped: () => stopped });
    const onError = seen[0]?.onError;
    class LeaseKeeperClosedError extends Error {}
    onError?.(`u_${U}:ingest-${C}`, new LeaseKeeperClosedError("closed"));
    expect(errors).toHaveBeenCalledWith("recovery failed", "LeaseKeeperClosedError");
    errors.mockClear();
    stopped = true;
    onError?.(`u_${U}:ingest-${C}`, new LeaseKeeperClosedError("closed"));
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
