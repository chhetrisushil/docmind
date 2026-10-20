import { randomUUID } from "node:crypto";
import { ChatMessageDto, ChatStreamEvent } from "@docmind/contracts";
import { tainted } from "@loom/classify";
import { withTurnScope } from "@loom/conversation";
import { frame } from "@loom/plugin-conversation-sse";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_URL } from "../db/testSupport";
import { ALICE, openSse } from "../documents/testHarness";
import { chatConversationId } from "./ids";
import { type ChatHarness, seedChat, startChatServer } from "./testHarness";

const convOf = (chatId: string) => chatConversationId(ALICE.userId, chatId);
const dataOf = (frame: string): unknown => JSON.parse(frame.split("\ndata: ")[1] as string);

describe.skipIf(!PG_URL)(
  "GET /api/chats/:id/stream, durable messages (needs DOCMIND_TEST_PG_URL)",
  () => {
    let h: ChatHarness;
    beforeAll(async () => {
      h = await startChatServer();
    });
    afterAll(async () => {
      await h.close();
    });
    const open = (user: string, chatId: string, headers: Record<string, string> = {}, query = "") =>
      openSse(`${h.base}/api/chats/${chatId}/stream${query}`, { "x-test-user": user, ...headers });

    it("opens with a retry hint and the conversation's status, as text/event-stream", async () => {
      const chatId = await seedChat(h, ALICE);
      const s = await open("alice", chatId);
      expect([
        s.res.status,
        s.res.headers.get("content-type"),
        s.res.headers.get("cache-control"),
      ]).toEqual([200, "text/event-stream", "no-store"]);
      expect(await s.next()).toBe("retry: 3000");
      expect(await s.next()).toBe(
        'event: status\ndata: {"state":"open","running":false,"turns":0}',
      );
      s.close();
    });

    it("delivers each recorded message as a durable event whose id is its history cursor, with citations merged in", async () => {
      const chatId = await seedChat(h, ALICE);
      const s = await open("alice", chatId);
      await s.next();
      await s.next();
      h.fake.addTurn(convOf(chatId), { question: "What is due?", answer: "Soon." });
      const [user, reply] = [await s.next(), await s.next()];
      expect(user.startsWith("id: 0.1\nevent: message\n")).toBe(true);
      expect(reply.startsWith("id: 0.2\nevent: message\n")).toBe(true);
      expect(ChatMessageDto.parse(dataOf(user))).toMatchObject({
        role: "user",
        text: "What is due?",
      });
      expect(ChatMessageDto.parse(dataOf(reply))).toMatchObject({
        role: "assistant",
        text: "Soon.",
        citations: [],
      });
      s.close();
    });

    it("every frame the stream sends parses as a ChatStreamEvent (kind is the SSE event name, the data is the rest)", async () => {
      const parse = (raw: string) => {
        const event = /^(?:id: .*\n)?event: (.*)\n/.exec(raw)?.[1];
        return ChatStreamEvent.parse({ kind: event, ...(dataOf(raw) as object) });
      };
      const chatId = await seedChat(h, ALICE);
      const conv = convOf(chatId);
      const step = { name: "search_docs", label: "Searched documents", count: 3 } as const;
      // a running turn's partials reach a late joiner as reasoning-partial and answer
      await withTurnScope(conv, 2, new AbortController().signal, async () => {
        h.wiring.hub.deltaSink()("Part");
        h.wiring.hub.reasoningSink()(tainted("So far", "llm-reasoning:s"));
        const s = await open("alice", chatId);
        expect(await s.next()).toBe("retry: 3000");
        const kinds: string[] = [];
        const take = async () => {
          const e = parse(await s.next());
          kinds.push(e.kind);
          return e;
        };
        expect(await take()).toEqual(expect.objectContaining({ kind: "status" }));
        expect(await take()).toEqual(expect.objectContaining({ kind: "reasoning-partial" }));
        expect(await take()).toEqual(expect.objectContaining({ kind: "answer" }));
        h.wiring.hub.publish(conv, { type: "reasoning", conversationId: conv, turn: 2, text: "r" });
        h.wiring.bus.publish(chatId, { kind: "tool", turnKey: 1, step });
        h.wiring.hub.publish(conv, { type: "reset", conversationId: conv, turn: 2 });
        h.wiring.bus.publish(chatId, { kind: "reset", turnKey: 1 });
        for (let i = 0; i < 4; i++) await take();
        h.fake.addTurn(conv, { question: "What is due?", answer: "Soon." });
        const user = await take();
        const reply = await take();
        expect(user).toMatchObject({ kind: "message", role: "user", text: "What is due?" });
        expect(reply).toMatchObject({ kind: "message", role: "assistant", cursor: "0.2" });
        await h.fake.api.close(conv, {
          principal: { tenant: ALICE.tenantId, actor: ALICE.userId },
        });
        await take();
        expect([...new Set(kinds)].sort()).toEqual(
          [
            "answer",
            "closed",
            "message",
            "reasoning",
            "reasoning-partial",
            "reset",
            "status",
            "tool",
            "tool-reset",
          ].sort(),
        );
        s.close();
      });
      // the error frame, written by the same helper the stream uses, parses for each code it can carry
      for (const code of ["invalid_cursor", "not_found", "too_many_streams", "internal"]) {
        expect(parse(frame("error", { code }).trimEnd())).toEqual({ kind: "error", code });
      }
    });

    it("resumes after Last-Event-ID, or after ?cursor=, and sends only what came later", async () => {
      const chatId = await seedChat(h, ALICE);
      for (const q of ["a", "b"]) h.fake.addTurn(convOf(chatId), { question: q, answer: q });
      const byHeader = await open("alice", chatId, { "last-event-id": "0.2" });
      await byHeader.next();
      await byHeader.next();
      expect((await byHeader.next()).startsWith("id: 0.3\n")).toBe(true);
      byHeader.close();
      const byQuery = await open("alice", chatId, {}, "?cursor=0.3");
      await byQuery.next();
      await byQuery.next();
      expect((await byQuery.next()).startsWith("id: 0.4\n")).toBe(true);
      byQuery.close();
    });

    it("answers 400 invalid_cursor for a cursor that is not one, before any stream bytes", async () => {
      const chatId = await seedChat(h, ALICE);
      const res = await fetch(`${h.base}/api/chats/${chatId}/stream?cursor=garbage`, {
        headers: { "x-test-user": "alice" },
      });
      expect([res.status, ((await res.json()) as { error: { code: string } }).error.code]).toEqual([
        400,
        "invalid_cursor",
      ]);
    });

    it("sends closed and ends the stream when the chat's conversation is closed", async () => {
      const chatId = await seedChat(h, ALICE);
      const s = await open("alice", chatId);
      await s.next();
      await s.next();
      await h.fake.api.close(convOf(chatId), {
        principal: { tenant: ALICE.tenantId, actor: ALICE.userId },
      });
      expect(await s.next()).toBe("event: closed\ndata: {}");
      await expect(s.next()).rejects.toThrow("stream ended");
    });

    it("answers 404 and subscribes to nothing for another user, another tenant, an unknown, a malformed and a deleted chat", async () => {
      const chatId = await seedChat(h, ALICE);
      const answers = [
        await h.req("alice2", "GET", `/api/chats/${chatId}/stream`),
        await h.req("bob", "GET", `/api/chats/${chatId}/stream`),
        await h.req("alice", "GET", `/api/chats/${randomUUID()}/stream`),
        await h.req("alice", "GET", "/api/chats/nope/stream"),
      ];
      await h.owner.query("UPDATE chat_sessions SET deleted_at = now() WHERE id = $1", [chatId]);
      answers.push(await h.req("alice", "GET", `/api/chats/${chatId}/stream`));
      expect(answers.map((r) => r.status)).toEqual([404, 404, 404, 404, 404]);
      expect(h.wiring.hub.subscriberCount(convOf(chatId))).toBe(0);
      expect(h.wiring.bus.subscriberCount(chatId)).toBe(0);
    });

    it("requires a session", async () => {
      const chatId = await seedChat(h, ALICE);
      expect((await fetch(`${h.base}/api/chats/${chatId}/stream`)).status).toBe(401);
    });
  },
);

describe.skipIf(!PG_URL)(
  "GET /api/chats/:id/stream, slots are released on every path (needs DOCMIND_TEST_PG_URL)",
  () => {
    let h: ChatHarness;
    let ended: () => void = () => {};
    const streamEnded = () =>
      new Promise<void>((resolve) => {
        ended = resolve;
      });
    beforeAll(async () => {
      h = await startChatServer({ stream: { maxStreamsPerUser: 1, onStreamEnd: () => ended() } });
    });
    afterAll(async () => {
      await h.close();
    });
    const open = (chatId: string) =>
      openSse(`${h.base}/api/chats/${chatId}/stream`, { "x-test-user": "alice" });

    it("refuses a second stream of the same user with 429, and takes a new one once the first client has left", async () => {
      const chatId = await seedChat(h, ALICE);
      const first = await open(chatId);
      await first.next();
      await first.next();
      const refused = await h.req("alice", "GET", `/api/chats/${chatId}/stream`);
      expect([
        refused.status,
        ((await refused.json()) as { error: { code: string } }).error.code,
      ]).toEqual([429, "too_many_streams"]);
      const gone = streamEnded();
      first.close();
      await gone;
      const again = await open(chatId);
      expect(again.res.status).toBe(200);
      const done = streamEnded();
      again.close();
      await done;
    });

    it("releases the slot when the conversation closes", async () => {
      const chatId = await seedChat(h, ALICE);
      const s = await open(chatId);
      await s.next();
      await s.next();
      const done = streamEnded();
      await h.fake.api.close(convOf(chatId), {
        principal: { tenant: ALICE.tenantId, actor: ALICE.userId },
      });
      await done;
      const again = await open(await seedChat(h, ALICE)); // the one slot is free again
      expect(again.res.status).toBe(200);
      const gone = streamEnded();
      again.close();
      await gone;
    });

    it("sends a generic internal error and releases the slot when reading the log fails", async () => {
      const chatId = await seedChat(h, ALICE);
      const reader = h.wiring.reader;
      const original = reader.read;
      reader.read = async () => {
        throw new RangeError("secret detail");
      };
      try {
        const s = await open(chatId);
        await s.next();
        await s.next();
        const failure = await s.next();
        expect(failure).toBe('event: error\ndata: {"code":"internal"}');
        await expect(s.next()).rejects.toThrow("stream ended");
      } finally {
        reader.read = original;
      }
      const again = await open(chatId);
      expect(again.res.status).toBe(200);
      const gone = streamEnded();
      again.close();
      await gone;
    });

    it("releases the slot on closeAll", async () => {
      const own = await startChatServer({ stream: { maxStreamsPerUser: 1 } });
      const chatId = await seedChat(own, ALICE);
      const s = await openSse(`${own.base}/api/chats/${chatId}/stream`, { "x-test-user": "alice" });
      await s.next();
      await s.next();
      own.streams.closeAll();
      await expect(s.next()).rejects.toThrow("stream ended");
      await own.close();
    });
  },
);
