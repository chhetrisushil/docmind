import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryAsyncEventStore, InMemoryTimerStore } from "@loom/event-runtime";
import type { LlmProvider } from "@loom/llm";
import { InMemoryKeyStore } from "@loom/plugin-crypto";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chatConversationId } from "../../chats/ids";
import { loadChatSettings } from "../../chats/settings";
import { buildServer } from "../../compose";
import { loadBlobRoot, loadLimits } from "../../documents/limits";
import { createIngestWiring } from "../ingest-document/limits";

const KEY = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const stub = {
  complete: async () => ({ content: "x", stopReason: "end_turn" }),
} as unknown as LlmProvider;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => void (await Promise.all(closers.splice(0).map((c) => c()))));

function compose(o: { chat: boolean; visuals: boolean; query?: ReturnType<typeof vi.fn> }) {
  const root = mkdtempSync(join(tmpdir(), "dm-compose-turn-"));
  const query = o.query ?? vi.fn(async () => ({ rows: [{ t: null }] }));
  const env = o.visuals
    ? { DOCMIND_VISUALS_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-test-not-real" }
    : {};
  try {
    const built = buildServer({
      pool: { query } as unknown as Pool,
      keys: new InMemoryKeyStore(),
      storage: { kind: "custom", eventStore: new InMemoryAsyncEventStore() },
      limits: loadLimits({}),
      blobRoot: loadBlobRoot({ DOCMIND_BLOB_DIR: root }),
      secureCookies: false,
      trustProxy: false,
      ingest: { ...createIngestWiring(env), sleep: async () => {} },
      status: { source: new InMemoryAsyncEventStore() } as never,
      ...(o.visuals && { plannerDecisionKey: KEY }),
      ...(o.chat && {
        chat: {
          settings: loadChatSettings({ DOCMIND_LLM_PROVIDER: "off" }),
          llm: { provider: stub, summaryProvider: stub, observer: {} },
          timers: new InMemoryTimerStore(),
        },
      }),
    });
    closers.push(async () => void (await built.app.close()));
    return { built, query };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const settled = () => {
  const user = randomUUID();
  const chat = randomUUID();
  const id = chatConversationId(user, chat);
  return {
    user,
    chat,
    e: { conversationId: id, executionId: id, turn: 1, ord: 2, status: "complete" as const },
  };
};

describe("compose: the turn starter", () => {
  it("is absent without chat", () => {
    expect(compose({ chat: false, visuals: true }).built.turns).toBeUndefined();
  });

  it("with the visuals role off: a settled turn does no work at all (no query, no start)", async () => {
    const { built, query } = compose({ chat: true, visuals: false });
    expect(built.turns).toBeDefined();
    const start = vi.spyOn(built.app.runtime, "start");
    built.turns?.onSettled(settled().e);
    await built.turns?.idle();
    expect(query).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("with the role on: the chat's tenant is looked up through docmind_chat_tenant, and an unknown chat starts nothing", async () => {
    const { built, query } = compose({ chat: true, visuals: true });
    const start = vi.spyOn(built.app.runtime, "start");
    const s = settled();
    built.turns?.onSettled(s.e);
    await built.turns?.idle(); // the check has settled: a start would have been made by now
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain("docmind_chat_tenant");
    expect(query.mock.calls[0]?.[1]).toEqual([s.chat, s.user]);
    expect(start).not.toHaveBeenCalled();
  });
});
