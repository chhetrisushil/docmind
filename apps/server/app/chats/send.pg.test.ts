import { randomUUID } from "node:crypto";
import { SendMessageResponse } from "@docmind/contracts";
import {
  ConversationNotFoundError,
  InvalidTurnError,
  QueueFullError,
  SubscriberLimitError,
} from "@loom/conversation";
import { InboxClosedError, InboxFullError } from "@loom/workflow-runtime";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PG_URL } from "../db/testSupport";
import { ALICE } from "../documents/testHarness";
import type { ChatTitleTrigger } from "./routes";
import { type ChatHarness, seedChat, startChatServer } from "./testHarness";
import type { ChatRef } from "./turnItems";

describe.skipIf(!PG_URL)("POST /api/chats/:id/messages (needs DOCMIND_TEST_PG_URL)", () => {
  const fired: ChatRef[] = [];
  const titles: ChatTitleTrigger = { fire: (ref) => void fired.push(ref) };
  let h: ChatHarness;
  let noKey: ChatHarness;
  beforeAll(async () => {
    h = await startChatServer({ titles });
    noKey = await startChatServer({ available: false, titles });
  });
  afterAll(async () => {
    await Promise.all([h.close(), noKey.close()]);
  });
  const send = (user: string, chatId: string, body: unknown) =>
    h.req(user, "POST", `/api/chats/${chatId}/messages`, body);

  it("hands the question to the conversation as the caller and answers 202 with its message id", async () => {
    const chatId = await seedChat(h, ALICE);
    const messageId = randomUUID();
    const res = await send("alice", chatId, { text: "  What is due?  ", messageId });
    expect(res.status).toBe(202);
    expect(SendMessageResponse.parse(await res.json())).toEqual({ messageId });
    expect(h.fake.sent.at(-1)).toEqual({
      id: `u_${ALICE.userId}.c-${chatId}`,
      text: "What is due?",
      messageId,
    });
  });

  it("passes editOf through, and mints a message id when the client sends none", async () => {
    const chatId = await seedChat(h, ALICE);
    const res = await send("alice", chatId, { text: "again", editOf: 3 });
    expect(res.status).toBe(202);
    expect(h.fake.sent.at(-1)).toMatchObject({ text: "again", editOf: 3 });
    expect(typeof SendMessageResponse.parse(await res.json()).messageId).toBe("string");
  });

  it("accepts 8000 multi-byte characters, refuses 8001 characters and refuses a body over 64 KiB", async () => {
    const chatId = await seedChat(h, ALICE);
    expect((await send("alice", chatId, { text: "é".repeat(8000) })).status).toBe(202);
    expect((await send("alice", chatId, { text: "é".repeat(8001) })).status).toBe(400);
    const huge = await fetch(`${h.base}/api/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "x-test-user": "alice", "content-type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(65 * 1024) }),
    });
    expect(huge.status).toBe(413);
  });

  it("accepts 8000 units written as \\uXXXX escapes (48,000 bytes of body)", async () => {
    const chatId = await seedChat(h, ALICE);
    const res = await fetch(`${h.base}/api/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "x-test-user": "alice", "content-type": "application/json" },
      body: `{"text":"${"\\u00e9".repeat(8000)}"}`,
    });
    expect(res.status).toBe(202);
  });

  it("refuses an empty question and a body that is not a message", async () => {
    const chatId = await seedChat(h, ALICE);
    const before = h.fake.sent.length;
    expect((await send("alice", chatId, { text: "   " })).status).toBe(400);
    expect((await send("alice", chatId, { message: "hi" })).status).toBe(400);
    expect((await send("alice", chatId, { text: "hi", editOf: 0 })).status).toBe(400); // P7
    expect(h.fake.sent).toHaveLength(before);
  });

  it("answers 404 and sends nothing for another user, another tenant, an unknown, a malformed and a deleted chat", async () => {
    const chatId = await seedChat(h, ALICE);
    const before = h.fake.sent.length;
    const firedBefore = fired.length;
    const answers = [
      await send("alice2", chatId, { text: "hi" }),
      await send("bob", chatId, { text: "hi" }),
      await send("alice", randomUUID(), { text: "hi" }),
      await send("alice", "nope", { text: "hi" }),
    ];
    await h.owner.query("UPDATE chat_sessions SET deleted_at = now() WHERE id = $1", [chatId]);
    answers.push(await send("alice", chatId, { text: "hi" }));
    expect(answers.map((r) => r.status)).toEqual([404, 404, 404, 404, 404]);
    expect(h.fake.sent).toHaveLength(before);
    expect(fired).toHaveLength(firedBefore);
  });

  it("answers 503 chat_unavailable without a Claude key, and sends nothing", async () => {
    const chatId = await seedChat(noKey, ALICE);
    const firedBefore = fired.length;
    const res = await noKey.req("alice", "POST", `/api/chats/${chatId}/messages`, { text: "hi" });
    expect([res.status, ((await res.json()) as { error: { code: string } }).error.code]).toEqual([
      503,
      "chat_unavailable",
    ]);
    expect(noKey.fake.sent).toEqual([]);
    expect(fired).toHaveLength(firedBefore);
  });

  it("maps Loom's refusals: a closed conversation is 409, a bad turn 400, a full queue 429", async () => {
    const chatId = await seedChat(h, ALICE);
    h.fake.failNextSend(new InboxClosedError("x", "completed"));
    h.fake.failNextSend(new InvalidTurnError("edit-invalid"));
    h.fake.failNextSend(new QueueFullError());
    const codes = [];
    for (let i = 0; i < 3; i++) {
      const res = await send("alice", chatId, { text: "hi" });
      codes.push([res.status, ((await res.json()) as { error: { code: string } }).error.code]);
    }
    expect(codes).toEqual([
      [409, "chat_closed"],
      [400, "invalid_turn"],
      [429, "too_many_requests"],
    ]);
  });

  it("maps the rest of Loom's refusals: a full inbox and a subscriber limit are 429 with retry-after, a missing conversation 404", async () => {
    const chatId = await seedChat(h, ALICE);
    h.fake.failNextSend(new InboxFullError("x", 5));
    h.fake.failNextSend(new SubscriberLimitError("x", 3));
    h.fake.failNextSend(new ConversationNotFoundError("x"));
    const got = [];
    for (let i = 0; i < 3; i++) {
      const res = await send("alice", chatId, { text: "hi" });
      got.push([
        res.status,
        res.headers.get("retry-after"),
        ((await res.json()) as { error: { code: string } }).error.code,
      ]);
    }
    expect(got).toEqual([
      [429, "1", "too_many_requests"],
      [429, "1", "too_many_requests"],
      [404, null, "not_found"],
    ]);
  });

  it("answers 500 for an error it does not know, without its message", async () => {
    const chatId = await seedChat(h, ALICE);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.fake.failNextSend(new RangeError("SECRET-DETAIL"));
      const res = await send("alice", chatId, { text: "hi" });
      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain("SECRET-DETAIL");
    } finally {
      spy.mockRestore();
    }
  });

  describe("auto title (D14, P5)", () => {
    it("starts the title for an untitled chat after the send succeeded, with the session's identity only", async () => {
      const chatId = await seedChat(h, ALICE);
      const before = fired.length;
      expect((await send("alice", chatId, { text: "hi" })).status).toBe(202);
      expect(fired.slice(before)).toEqual([
        { tenantId: ALICE.tenantId, userId: ALICE.userId, chatId },
      ]);
    });

    it("does not start it for a titled chat, or when the send was refused", async () => {
      const titled = await seedChat(h, ALICE, { title: "My chat" });
      const untitled = await seedChat(h, ALICE);
      const before = fired.length;
      expect((await send("alice", titled, { text: "hi" })).status).toBe(202);
      h.fake.failNextSend(new InboxClosedError("x", "completed"));
      expect((await send("alice", untitled, { text: "hi" })).status).toBe(409);
      expect(fired).toHaveLength(before);
    });

    it("still answers 202 when the starter throws", async () => {
      const throwing = await startChatServer({
        titles: {
          fire: () => {
            throw new RangeError("boom");
          },
        },
      });
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const chatId = await seedChat(throwing, ALICE);
        const res = await throwing.req("alice", "POST", `/api/chats/${chatId}/messages`, {
          text: "hi",
        });
        expect(res.status).toBe(202);
        expect(errors.mock.calls).toEqual([["chat title start failed", "RangeError"]]);
      } finally {
        errors.mockRestore();
        await throwing.close();
      }
    });
  });
});
