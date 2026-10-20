import { beforeEach, describe, expect, it, vi } from "vitest";

type Claim = { isAbandoned?: (c: { executionId: string; updatedAt: number }) => boolean };
const seen = vi.hoisted(() => [] as Claim[]);
vi.mock("@loom/workflow-runtime", async (orig) => ({
  ...(await orig<typeof import("@loom/workflow-runtime")>()),
  collectGhostLeases: vi.fn(async () => 0),
  recoverAbandoned: vi.fn(async (_rt: unknown, options: Claim) => {
    seen.push(options);
    return { scanned: 0, candidates: 0, recovered: 0, failed: 0, exhausted: 0 };
  }),
}));

import { chatConversationId, isRecoverableChatExecution } from "../../chats/ids";
import { recoverIngest } from "./recovery";

const U = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const C = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
const runtime = {
  leaseKeeper: undefined,
  cancel: async () => {},
  systemOptions: () => ({}),
} as never;
const source = {} as never;
const OLD = { updatedAt: 0 };

beforeEach(() => {
  seen.length = 0;
});

describe("recoverIngest owns", () => {
  it("claims only ingest executions by default", async () => {
    await recoverIngest(runtime, source, { graceMs: 10, now: () => 1_000 });
    const claim = seen[0]?.isAbandoned;
    expect(claim?.({ executionId: `u_${U}:ingest-${C}`, ...OLD })).toBe(true);
    expect(claim?.({ executionId: chatConversationId(U, C), ...OLD })).toBe(false);
  });

  it("claims a chat conversation, and a later generation of one, when told to", async () => {
    const owns = (id: string) => id.includes(":ingest-") || id.includes(".c-");
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
});
