import { ConversationNotFoundError } from "@loom/conversation";
import { InboxClosedError } from "@loom/workflow-runtime";
import { describe, expect, it, vi } from "vitest";
import { chatConversationId } from "../chats/ids";
import { legacyIds } from "../opaqueIds";
import { testOpaqueIds } from "../opaqueIds/testing";
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
    visuals: { cancel: async () => {}, settle: async () => {}, idle: async () => {} },
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

  it("settles and cancels the document's suggest-tags runs with its other starts, and awaits the starter with the titles", async () => {
    const calls: string[] = [];
    const { parts: p } = parts({
      suggestTags: {
        settle: async (_who, doc) => void calls.push(`suggest.settle:${doc}`),
        cancel: async (_who, doc, reason) => void calls.push(`suggest.cancel:${doc}:${reason}`),
        idle: async () => void calls.push("suggest.idle"),
      },
    });
    const deps = erasureDeps(p);
    await deps.settleStart(who, "d");
    await deps.cancelVisualize(who, "d", 3);
    await deps.settleTitles();
    expect(calls).toEqual(["suggest.settle:d", "suggest.cancel:d:erased", "suggest.idle"]);
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

  it("cancels the document's visualize executions through the visuals port, once per call", async () => {
    const cancel = vi.fn(
      async (_who: unknown, _doc: string, _generation: number, _reason: string) => {},
    );
    const { parts: p } = parts({
      visuals: { cancel, settle: async () => {}, idle: async () => {} },
    });
    await erasureDeps(p).cancelVisualize(who, "d", 3);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(who, "d", 3, "erased");
  });

  it("settles the document's pending visualize starts with its ingest start, and awaits the visuals starter with the titles", async () => {
    const calls: string[] = [];
    const { parts: p } = parts({
      starts: { settle: async () => void calls.push("starts.settle") },
      visuals: {
        cancel: async () => {},
        settle: async () => void calls.push("visuals.settle"),
        idle: async () => void calls.push("visuals.idle"),
      },
    });
    const deps = erasureDeps(p);
    await deps.settleStart(who, "d");
    await deps.settleTitles();
    expect(calls).toEqual(["starts.settle", "visuals.settle", "visuals.idle"]);
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

  it("cancels the chat title under both formats and stops both conversations when the user has a handle", async () => {
    const t = testOpaqueIds();
    t.store.add(USER, TENANT);
    const user = await t.ids.ensureUser({ tenantId: TENANT, userId: USER });
    const { calls, parts: p } = parts({ ids: t.ids });
    const deps = erasureDeps(p);
    await deps.cancelTitle(who, CHAT);
    expect(calls).toEqual(
      expect.arrayContaining([
        `cancel:${legacyIds.chatTitle(USER, CHAT)}`,
        `cancel:${user.chatTitle(CHAT)}`,
      ]),
    );
    await deps.stopChat(who, CHAT);
    expect(calls).toEqual(
      expect.arrayContaining([
        `stop:${legacyIds.conversation(USER, CHAT)}`,
        `stop:${user.conversation(CHAT)}`,
      ]),
    );
  });

  it("a user with no handle cancels the old formats only, and a destroyed key reads as no new-format runs", async () => {
    const t = testOpaqueIds();
    t.store.add(USER, TENANT);
    const none = parts({ ids: t.ids });
    await erasureDeps(none.parts).cancelTitle(who, CHAT);
    expect(none.calls.filter((c) => c.startsWith("cancel:"))).toEqual([
      `cancel:${legacyIds.chatTitle(USER, CHAT)}`,
    ]);
    await t.ids.ensureUser({ tenantId: TENANT, userId: USER });
    await t.keys.destroy(USER);
    t.ids.forgetSubject(USER);
    const gone = parts({ ids: t.ids });
    await expect(erasureDeps(gone.parts).cancelTitle(who, CHAT)).resolves.toBeUndefined();
    expect(gone.calls.filter((c) => c.startsWith("cancel:"))).toEqual([
      `cancel:${legacyIds.chatTitle(USER, CHAT)}`,
    ]);
  });

  it("forgets the cached id key of every subject whose key it destroys", async () => {
    const t = testOpaqueIds();
    t.store.add(USER, TENANT);
    const user = await t.ids.ensureUser({ tenantId: TENANT, userId: USER });
    const { parts: p } = parts({ ids: t.ids });
    await erasureDeps(p).keys.destroy(`h_${user.handle}`);
    expect(t.ids.cached(USER)).toBeUndefined();
  });

  it("forwards the handle to the status and activity forgets", async () => {
    const seen: unknown[] = [];
    const { parts: p } = parts({
      status: { forgetUser: async (u: string, h?: string | null) => void seen.push(["s", u, h]) },
      activity: { forgetUser: async (u: string, h?: string | null) => void seen.push(["a", u, h]) },
    });
    const deps = erasureDeps(p);
    await deps.forgetStatus(USER, "a".repeat(26));
    await deps.forgetActivity(USER, "a".repeat(26));
    expect(seen).toEqual([
      ["s", USER, "a".repeat(26)],
      ["a", USER, "a".repeat(26)],
    ]);
  });

  it("evicts the cached id key of a subject Loom's shred erased, right after the shred", async () => {
    const t = testOpaqueIds();
    t.store.add(USER, TENANT);
    const user = await t.ids.ensureUser({ tenantId: TENANT, userId: USER });
    const { parts: p } = parts({ ids: t.ids });
    expect(t.ids.cached(USER)).toBeDefined();
    await erasureDeps(p).eraseSubject(`h_${user.handle}`);
    expect(t.ids.cached(USER)).toBeUndefined();
  });

  it("keeps the cached id key when the shred did not erase (parked or unknown)", async () => {
    const t = testOpaqueIds();
    t.store.add(USER, TENANT);
    const user = await t.ids.ensureUser({ tenantId: TENANT, userId: USER });
    const { parts: p } = parts({
      ids: t.ids,
      app: { eraseSubject: async () => ({ outcome: "parked" as const }) },
    });
    await erasureDeps(p).eraseSubject(`h_${user.handle}`);
    expect(t.ids.cached(USER)).toBeDefined();
  });

  it("evicts the cached id key when the shred answers unknown but the key is already destroyed (a retry after a committed shred)", async () => {
    const t = testOpaqueIds();
    t.store.add(USER, TENANT);
    const user = await t.ids.ensureUser({ tenantId: TENANT, userId: USER });
    const { parts: p } = parts({
      ids: t.ids,
      app: { eraseSubject: async () => ({ outcome: "unknown" as const }) },
      keys: { destroy: async () => {}, wasDestroyed: async () => true },
    });
    await erasureDeps(p).eraseSubject(`h_${user.handle}`);
    expect(t.ids.cached(USER)).toBeUndefined();
  });

  it("keeps the cached id key on unknown when the key is not destroyed", async () => {
    const t = testOpaqueIds();
    t.store.add(USER, TENANT);
    const user = await t.ids.ensureUser({ tenantId: TENANT, userId: USER });
    const { parts: p } = parts({
      ids: t.ids,
      app: { eraseSubject: async () => ({ outcome: "unknown" as const }) },
      keys: { destroy: async () => {}, wasDestroyed: async () => false },
    });
    await erasureDeps(p).eraseSubject(`h_${user.handle}`);
    expect(t.ids.cached(USER)).toBeDefined();
  });
});
