import { ConversationNotFoundError } from "@loom/conversation";
import { InboxClosedError } from "@loom/workflow-runtime";
import { describe, expect, it, vi } from "vitest";
import { legacyChatConversationId } from "../chats/ids";
import { existingUser } from "../documents/executionCandidates";
import { OpaqueIds, legacyIds } from "../opaqueIds";
import { testOpaqueIds } from "../opaqueIds/testing";
import { erasureDeps, requireKeyDestroyedProof } from "./wire";

const executionIdFor = legacyIds.named;

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
      `stop:${legacyChatConversationId(USER, CHAT)}`,
      `close:${legacyChatConversationId(USER, CHAT)}`,
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
    expect(eraseSubject).toHaveBeenCalledWith(USER, undefined, {
      parked: "shred",
      record: false,
    });
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

  it("after the h_ shred, a repeated stop builds no h_ candidate, on a cold or a warm cache (the data key is still alive)", async () => {
    const t = testOpaqueIds();
    t.store.add(USER, TENANT);
    const user = await t.ids.ensureUser({ tenantId: TENANT, userId: USER });
    const first = parts({ ids: t.ids, keys: t.keys });
    const deps = erasureDeps(first.parts);
    await deps.eraseSubject(`h_${user.handle}`);
    await t.keys.destroy(`h_${user.handle}`); // what Loom's shred did
    // Another cache writer (a sweep, a restart) re-reads the user: still no h_ id.
    for (const ids of [t.ids, new OpaqueIds(t.keys, t.store)]) {
      const again = parts({ ids, keys: t.keys });
      const d = erasureDeps(again.parts);
      await d.cancelTitle(who, CHAT);
      await d.stopChat(who, CHAT);
      const sent = again.calls.filter((c) => /^(cancel|stop|close):/.test(c));
      expect(sent.filter((c) => c.includes(`h_${user.handle}`))).toEqual([]);
      expect(sent.length).toBeGreaterThan(0); // the legacy candidates are still stopped
    }
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

  it("while Loom shreds the h_ subject, a cache hit builds no h_ id; after a park it builds them again", async () => {
    const t = testOpaqueIds();
    t.store.add(USER, TENANT);
    const user = await t.ids.ensureUser({ tenantId: TENANT, userId: USER });
    const seen: Record<string, unknown> = {};
    let outcome: "parked" | "erased" = "parked";
    const { parts: p } = parts({
      ids: t.ids,
      keys: { destroy: async () => {}, wasDestroyed: async () => outcome === "erased" }, // parked: the key is alive
      app: {
        eraseSubject: async () => {
          // What a concurrent document delete or a visuals reconcile does mid-shred (the key may already be destroyed by Loom).
          seen.cached = t.ids.cached(USER);
          seen.load = await t.ids.load(who);
          seen.ensure = await t.ids.ensureUser(who).then(
            () => "built",
            (e: Error) => e.constructor.name,
          );
          return { outcome };
        },
      },
    });
    const deps = erasureDeps(p);
    await deps.eraseSubject(`h_${user.handle}`);
    expect(seen).toEqual({ cached: undefined, load: false, ensure: "FieldKeyUnavailableError" });
    expect(t.ids.cached(USER)).toBeDefined(); // parked: the key lives, the retried stop can name the h_ runs
    outcome = "erased";
    await t.keys.destroy(`h_${user.handle}`);
    await deps.eraseSubject(`h_${user.handle}`);
    expect(t.ids.cached(USER)).toBeUndefined();
  });

  it("a shred that commits and then throws leaves the handle unusable: no h_ id is built and no cancel reaches Loom", async () => {
    for (const check of ["destroyed", "throws"] as const) {
      const t = testOpaqueIds();
      t.store.add(USER, TENANT);
      const user = await t.ids.ensureUser({ tenantId: TENANT, userId: USER });
      const wasDestroyed = async (s: string) => {
        if (check === "throws") throw new Error("key store down");
        return t.keys.wasDestroyed(s);
      };
      const { parts: p, calls } = parts({
        ids: t.ids,
        keys: { destroy: async () => {}, wasDestroyed },
        app: {
          eraseSubject: async () => {
            await t.keys.destroy(`h_${user.handle}`); // Loom's shred committed
            throw new Error("then it threw");
          },
        },
      });
      const deps = erasureDeps(p);
      await expect(deps.eraseSubject(`h_${user.handle}`)).rejects.toThrow("then it threw");
      expect(t.ids.cached(USER)).toBeUndefined();
      expect(await existingUser(t.ids, who)).toBeUndefined();
      await expect(t.ids.ensureUser(who)).rejects.toBeDefined();
      await deps.cancelTitle(who, CHAT);
      await deps.stopChat(who, CHAT);
      expect(calls.filter((c) => c.includes(`h_${user.handle}`))).toEqual([]);
    }
  });

  it("keeps the handle usable when the key store durably says the key is alive after a throw", async () => {
    const t = testOpaqueIds();
    t.store.add(USER, TENANT);
    const user = await t.ids.ensureUser({ tenantId: TENANT, userId: USER });
    const { parts: p } = parts({
      ids: t.ids,
      keys: { destroy: async () => {}, wasDestroyed: async () => false },
      app: {
        eraseSubject: async () => {
          throw new Error("failed before anything was destroyed");
        },
      },
    });
    await expect(erasureDeps(p).eraseSubject(`h_${user.handle}`)).rejects.toThrow();
    expect(t.ids.cached(USER)).toBeDefined();
  });

  it("keeps the cached id key when the shred did not erase (parked or unknown)", async () => {
    const t = testOpaqueIds();
    t.store.add(USER, TENANT);
    const user = await t.ids.ensureUser({ tenantId: TENANT, userId: USER });
    const { parts: p } = parts({
      ids: t.ids,
      app: { eraseSubject: async () => ({ outcome: "parked" as const }) },
      keys: { destroy: async () => {}, wasDestroyed: async () => false }, // the key is alive
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

  it("evicts the chat id resolver's memory of the user whenever the user's chat activity is forgotten, even if that throws", async () => {
    const forgotten: string[] = [];
    const chatIds = { forgetUser: (userId: string) => void forgotten.push(userId) };
    await erasureDeps(parts({ chatIds }).parts).forgetActivity(USER, "h");
    expect(forgotten).toEqual([USER]);
    const failing = parts({
      chatIds,
      activity: {
        forgetUser: async () => {
          throw new Error("down");
        },
      },
    }).parts;
    await expect(erasureDeps(failing).forgetActivity(USER)).rejects.toThrow("down");
    expect(forgotten).toEqual([USER, USER]); // a retried step evicts again
  });

  it("forgets no chat ids when the resolver is not wired", async () => {
    await expect(erasureDeps(parts().parts).forgetActivity(USER, null)).resolves.toBe(0); // the activity port's own answer, no resolver involved
  });
});
