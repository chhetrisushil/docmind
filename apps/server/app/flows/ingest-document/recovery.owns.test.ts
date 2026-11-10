import { beforeEach, describe, expect, it, vi } from "vitest";

type Claim = {
  isAbandoned?: (c: { executionId: string; updatedAt: number }) => boolean;
  onError?: (executionId: string, err: unknown) => void;
  source?: {
    listExecutionsPage?(o?: { cursor?: string; limit?: number }): Promise<{
      executionIds: string[];
      nextCursor?: string;
    }>;
    listExecutions?(): Promise<string[]>;
  };
  leases?: {
    owner: string;
    store: {
      expired(now?: number, limit?: number): Promise<{ executionId: string }[]>;
      acquire(id: string, owner: string, ttl: number): Promise<unknown>;
    };
  };
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

describe("recoverIngest erased", () => {
  const erasedId = `h_${"a".repeat(26)}:ingest-x.2`;
  const liveChat = chatConversationId(U, C);
  const subjectOf = (id: string) =>
    id.startsWith("h_") ? id.slice(0, 28) : id.startsWith("u_") ? U : undefined;

  it("hands Loom no execution of an erased subject, keeps the cursor, and asks the key store once per subject", async () => {
    const destroyed = vi.fn(async (subject: string) => subject.startsWith("h_"));
    const pages = vi.fn(async (o?: { cursor?: string }) =>
      o?.cursor === undefined
        ? { executionIds: ["__loom_inbox__:x", erasedId, `${erasedId}-r1`], nextCursor: "c1" }
        : { executionIds: [liveChat] },
    );
    await recoverIngest(
      runtime,
      { listExecutionsPage: pages, listExecutions: async () => [erasedId, liveChat] } as never,
      {
        graceMs: 0,
        owns: () => true,
        erased: { subjectOf, destroyed },
      },
    );
    const source = seen[0]?.source;
    // A page the filter empties of executions still carries the store's cursor, so the walk reaches the live chat after it.
    expect(await source?.listExecutionsPage?.()).toEqual({
      executionIds: ["__loom_inbox__:x"],
      nextCursor: "c1",
    });
    expect(await source?.listExecutionsPage?.({ cursor: "c1" })).toEqual({
      executionIds: [liveChat],
    });
    expect(await source?.listExecutions?.()).toEqual([liveChat]);
    expect(destroyed.mock.calls.map(([s]) => s).sort()).toEqual([U, `h_${"a".repeat(26)}`]);
  });

  it("a key-store lookup that fails keeps the execution, and logs the error class once per pass, no id", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await recoverIngest(
      runtime,
      { listExecutions: async () => [erasedId, `${erasedId}-r1`, liveChat] } as never,
      {
        graceMs: 0,
        erased: { subjectOf, destroyed: async () => Promise.reject(new Error(`down ${U}`)) },
      },
    );
    expect(await seen[0]?.source?.listExecutions?.()).toEqual([
      erasedId,
      `${erasedId}-r1`,
      liveChat,
    ]);
    expect(await seen[0]?.source?.listExecutions?.()).toHaveLength(3);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("recovery erased-check failed", "Error");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(U);
    warn.mockRestore();
  });

  it("runs at most 16 key-store lookups at once", async () => {
    let active = 0;
    let peak = 0;
    const destroyed = async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      return false;
    };
    const ids = Array.from({ length: 50 }, (_, i) => `h_${String(i).padStart(26, "0")}:ingest-x.2`);
    await recoverIngest(runtime, { listExecutions: async () => ids } as never, {
      graceMs: 0,
      erased: { subjectOf, destroyed },
    });
    expect(await seen[0]?.source?.listExecutions?.()).toEqual(ids);
    expect(peak).toBe(16);
  });

  it("filters the expired leases too, and leaves every other lease call to the store", async () => {
    const acquire = vi.fn(async () => "held");
    const store = {
      expired: async () => [{ executionId: erasedId }, { executionId: liveChat }],
      acquire,
    };
    await recoverIngest(runtime, source, {
      graceMs: 0,
      leases: { store: store as never, owner: "o" },
      erased: { subjectOf, destroyed: async (s) => s.startsWith("h_") },
    });
    const leases = seen[0]?.leases;
    expect(leases?.owner).toBe("o");
    expect(await leases?.store.expired()).toEqual([{ executionId: liveChat }]);
    expect(await leases?.store.acquire(liveChat, "o", 1)).toBe("held");
    expect(acquire).toHaveBeenCalledWith(liveChat, "o", 1);
  });

  it("without `erased` the source and the leases go to Loom as given", async () => {
    const given = { listExecutions: async () => [erasedId] };
    await recoverIngest(runtime, given as never, { graceMs: 0 });
    expect(seen[0]?.source).toBe(given);
  });
});
