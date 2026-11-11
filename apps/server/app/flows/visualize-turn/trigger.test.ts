import { randomUUID } from "node:crypto";
import type { TurnSettledEvent } from "@loom/conversation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { legacyChatConversationId } from "../../chats/ids";
import { OpaqueIds, opaqueIds } from "../../opaqueIds";
import { testOpaqueIds } from "../../opaqueIds/testing";
import type { TurnRead } from "./readTurn";
import { type TriggerDeps, turnToVisualize } from "./trigger";

const user = randomUUID();
const chat = randomUUID();
const tenant = randomUUID();
const cited: TurnRead = {
  status: "complete",
  retrieved: ["k"],
  citations: [{ passageId: "k", documentId: randomUUID() }],
};
const event = (over: Partial<TurnSettledEvent> = {}): TurnSettledEvent => ({
  conversationId: legacyChatConversationId(user, chat),
  executionId: legacyChatConversationId(user, chat),
  turn: 2,
  ord: 4,
  status: "complete",
  ...over,
});
const deps = (over: Partial<TriggerDeps> = {}): TriggerDeps => ({
  enabled: () => true,
  tenantOf: vi.fn(async () => tenant),
  turn: { read: vi.fn(async () => cited) },
  backlog: () => 0,
  maxWaiting: 20,
  ...over,
});

describe("turnToVisualize", () => {
  it("starts a complete, cited answer of a live chat, with the chat resolved from the conversation id", async () => {
    const d = deps();
    expect(await turnToVisualize(event(), d)).toEqual({
      tenantId: tenant,
      userId: user,
      chatId: chat,
      ord: 4,
    });
    expect(d.tenantOf).toHaveBeenCalledWith(user, chat);
  });
  it("resolves the chat of a rotated generation too", async () => {
    const e = event({
      conversationId: legacyChatConversationId(user, chat),
      executionId: `${legacyChatConversationId(user, chat)}~2`,
    });
    expect((await turnToVisualize(e, deps()))?.chatId).toBe(chat);
  });
  it.each(["interrupted", "failed", "rejected"] as const)(
    "ignores a %s turn without touching the database",
    async (status) => {
      const d = deps();
      expect(await turnToVisualize(event({ status }), d)).toBeNull();
      expect(d.tenantOf).not.toHaveBeenCalled();
    },
  );
  it("ignores everything while the visuals role is off", async () => {
    const d = deps({ enabled: () => false });
    expect(await turnToVisualize(event(), d)).toBeNull();
    expect(d.tenantOf).not.toHaveBeenCalled();
  });
  it("ignores a conversation that is not a chat's", async () => {
    expect(await turnToVisualize(event({ conversationId: "not-a-chat" }), deps())).toBeNull();
  });
  it("ignores a chat that is deleted, unknown or being erased (no tenant)", async () => {
    expect(await turnToVisualize(event(), deps({ tenantOf: async () => null }))).toBeNull();
  });
  it("ignores an uncited, non-complete or missing answer", async () => {
    for (const turn of [
      { ...cited, citations: [] },
      { ...cited, status: "interrupted" as const },
      null,
    ])
      expect(await turnToVisualize(event(), deps({ turn: { read: async () => turn } }))).toBeNull();
  });
  it("drops the start, not queues it, at 20 waiting visuals executions", async () => {
    expect(await turnToVisualize(event(), deps({ backlog: () => 19 }))).not.toBeNull();
    const d = deps({ backlog: () => 20 });
    expect(await turnToVisualize(event(), d)).toBeNull();
    expect(d.tenantOf).not.toHaveBeenCalled();
  });
});

describe("turnToVisualize with a new-format conversation", () => {
  afterEach(() => opaqueIds.install(undefined));

  it("fills the key cache for the conversation's user before it reads the chat", async () => {
    const t = testOpaqueIds();
    t.store.add(user, tenant);
    const u = await t.ids.ensureUser({ tenantId: tenant, userId: user });
    opaqueIds.install(new OpaqueIds(t.keys, t.store)); // cold
    const conversationId = u.conversation(chat);
    const d = deps();
    expect(
      await turnToVisualize(event({ conversationId, executionId: conversationId }), d),
    ).toEqual({
      tenantId: tenant,
      userId: user,
      chatId: chat,
      ord: 4,
    });
    expect(d.tenantOf).toHaveBeenCalledWith(user, chat);
  });

  it("answers null for a conversation whose user is unknown (erased), and never reads a chat for it", async () => {
    const t = testOpaqueIds();
    t.store.add(user, tenant);
    const u = await t.ids.ensureUser({ tenantId: tenant, userId: user });
    opaqueIds.install(testOpaqueIds().ids); // a store that has never heard of this handle
    const conversationId = u.conversation(chat);
    const d = deps();
    expect(
      await turnToVisualize(event({ conversationId, executionId: conversationId }), d),
    ).toBeNull();
    expect(d.tenantOf).not.toHaveBeenCalled();
  });
});
