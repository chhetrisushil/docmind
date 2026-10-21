import { ConversationNotFoundError } from "@loom/conversation";
import { InboxClosedError } from "@loom/workflow-runtime";
import { describe, expect, it, vi } from "vitest";
import { chatConversationId } from "../chats/ids";
import { executionIdFor } from "../subject";
import { erasureDeps, requireKeyDestroyedProof } from "./wire";

const USER = "11111111-1111-4111-8111-111111111111";
const TENANT = "22222222-2222-4222-8222-222222222222";
const CHAT = "44444444-4444-4444-8444-444444444444";
// Its conversation id ends in "a": the close mock answers ConversationNotFoundError for it, InboxClosedError for CHAT.
const CHAT_A = "4444444a-4444-4444-8444-44444444444a";
const who = { tenantId: TENANT, userId: USER };

function parts(over: Partial<Parameters<typeof erasureDeps>[0]> = {}) {
  const calls: string[] = [];
  const base: Parameters<typeof erasureDeps>[0] = {
    app: { eraseSubject: async () => ({ outcome: "erased" as const }) },
    runtime: {
      cancel: vi.fn(async (id: string) => {
        calls.push(`cancel:${id}`);
        return true;
      }),
    },
    keys: { destroy: async () => {}, wasDestroyed: async () => true },
    store: {
      pending: async () => [],
      mark: async () => {},
      retried: async () => {},
      get: async () => null,
      erased: async () => [],
    },
    sql: {
      lock: async () => null,
      work: async () => ({ documents: [], chatIds: [] }),
      rows: async () => {},
      blobs: async () => {},
    },
    starts: { settle: async () => {} },
    ingest: { cancel: async () => {} },
    chat: {
      stops: {
        stop: (id: string) => {
          calls.push(`stop:${id}`);
          return true;
        },
      },
      conversations: {
        close: vi.fn(async (id: string) => {
          calls.push(`close:${id}`);
          return {} as never;
        }),
      },
    },
    status: { forgetUser: async () => 0 },
    activity: { forgetUser: async () => 0 },
    closeStreams: () => {},
  };
  return { calls, parts: { ...base, ...over } };
}

describe("erasureDeps", () => {
  it("stops a chat by stop signal, then close, and cancels its title execution", async () => {
    const { calls, parts: p } = parts();
    const deps = erasureDeps(p);
    await deps.stopChat(who, CHAT);
    await deps.cancelTitle(who, CHAT);
    expect(calls).toEqual([
      `stop:${chatConversationId(USER, CHAT)}`,
      `close:${chatConversationId(USER, CHAT)}`,
      `cancel:${executionIdFor(USER, `chat-title-${CHAT}`)}`,
    ]);
  });

  it("tolerates a conversation that never started or is closed, and a title that never started", async () => {
    const { parts: p } = parts({
      chat: {
        stops: { stop: () => false },
        conversations: {
          close: async (id: string) => {
            throw id.endsWith("a")
              ? new ConversationNotFoundError(id)
              : new InboxClosedError(id, "completed");
          },
        },
      },
      runtime: {
        cancel: async (id: string) => {
          throw new Error(`No execution found for id: ${id}`);
        },
      },
    });
    const deps = erasureDeps(p);
    await expect(deps.stopChat(who, CHAT)).resolves.toBeUndefined(); // InboxClosedError
    await expect(deps.stopChat(who, CHAT_A)).resolves.toBeUndefined(); // ConversationNotFoundError
    await expect(deps.cancelTitle(who, CHAT)).resolves.toBeUndefined();
  });

  it("rethrows any other failure so the step is retried", async () => {
    const { parts: p } = parts({
      runtime: {
        cancel: async () => {
          throw new RangeError("db down");
        },
      },
    });
    await expect(erasureDeps(p).cancelTitle(who, CHAT)).rejects.toThrow(RangeError);
  });

  it("without chat, stopping a chat is a no-op", async () => {
    const { parts: p } = parts();
    const { chat: _chat, ...withoutChat } = p;
    await expect(erasureDeps(withoutChat).stopChat(who, CHAT)).resolves.toBeUndefined();
  });

  it("passes the shred the user and no tenant, and asks for parked owners to be shredded", async () => {
    const eraseSubject = vi.fn(async () => ({ outcome: "erased" as const }));
    const { parts: p } = parts({ app: { eraseSubject } });
    await erasureDeps(p).eraseSubject(USER);
    expect(eraseSubject).toHaveBeenCalledWith(USER, undefined, { parked: "shred" });
  });

  it("refuses, at wiring time, a key store that cannot prove a destruction", () => {
    const { parts: p } = parts({ keys: { destroy: async () => {} } });
    expect(() => erasureDeps(p)).toThrow("wasDestroyed");
    expect(() => requireKeyDestroyedProof({ wasDestroyed: async () => true })).not.toThrow();
  });

  it("bounds the wait for a document's pending start", async () => {
    vi.useFakeTimers();
    try {
      const { parts: p } = parts({ starts: { settle: () => new Promise<void>(() => {}) } });
      const settled = erasureDeps(p).settleStart(who, "d");
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(settled).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
