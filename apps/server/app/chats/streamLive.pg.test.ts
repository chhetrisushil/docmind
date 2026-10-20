import http from "node:http";
import { tainted } from "@loom/classify";
import { withTurnScope } from "@loom/conversation";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PG_URL } from "../db/testSupport";
import { ALICE, ALICE2, openSse } from "../documents/testHarness";
import { chatConversationId } from "./ids";
import { type ChatHarness, seedChat, startChatServer } from "./testHarness";

const convOf = (chatId: string) => chatConversationId(ALICE.userId, chatId);

describe.skipIf(!PG_URL)(
  "GET /api/chats/:id/stream, live kinds and limits (needs DOCMIND_TEST_PG_URL)",
  () => {
    let h: ChatHarness;
    let ended: () => void = () => {};
    const streamEnded = () =>
      new Promise<void>((resolve) => {
        ended = resolve;
      });
    beforeAll(async () => {
      h = await startChatServer({ stream: { maxStreamsPerUser: 2, onStreamEnd: () => ended() } });
    });
    afterAll(async () => {
      await h.close();
    });
    const open = (user: string, chatId: string, headers: Record<string, string> = {}) =>
      openSse(`${h.base}/api/chats/${chatId}/stream`, { "x-test-user": user, ...headers });

    const step = { name: "search_docs", label: 'Searched documents: "x"', count: 3 } as const;

    it("carries reasoning, tool and answer events live, in the order they were published, as their own kinds", async () => {
      const chatId = await seedChat(h, ALICE);
      const s = await open("alice", chatId);
      await s.next();
      await s.next();
      h.wiring.hub.publish(convOf(chatId), {
        type: "reasoning",
        conversationId: convOf(chatId),
        turn: 1,
        text: "Looking",
      });
      h.wiring.bus.publish(chatId, { kind: "tool", turnKey: 1, step });
      h.wiring.hub.publish(convOf(chatId), {
        type: "delta",
        conversationId: convOf(chatId),
        turn: 1,
        text: "Hel",
      });
      expect(await s.next()).toBe('event: reasoning\ndata: {"turn":1,"text":"Looking"}');
      expect(await s.next()).toBe(
        'event: tool\ndata: {"turnKey":1,"step":{"name":"search_docs","label":"Searched documents: \\"x\\"","count":3}}',
      );
      expect(await s.next()).toBe('event: answer\ndata: {"turn":1,"text":"Hel"}');
      s.close();
    });

    it("tells a late joiner what the running turn has reasoned and answered so far, once, before anything new", async () => {
      const chatId = await seedChat(h, ALICE);
      // The hub keeps the in-progress reasoning and reply of a running turn; produce them the way the model effect does.
      await withTurnScope(convOf(chatId), 2, new AbortController().signal, async () => {
        h.wiring.hub.deltaSink()("Part of the answer");
        h.wiring.hub.reasoningSink()(tainted("So far", "llm-reasoning:s"));
      });
      const s = await open("alice", chatId);
      await s.next();
      await s.next();
      expect(await s.next()).toBe('event: reasoning-partial\ndata: {"turn":2,"text":"So far"}');
      expect(await s.next()).toBe('event: answer\ndata: {"turn":2,"text":"Part of the answer"}');
      s.close();
    });

    it("sends reset and tool-reset when a re-run restarts a turn, and delivers nothing of another chat", async () => {
      const [mine, theirs] = [await seedChat(h, ALICE), await seedChat(h, ALICE)];
      const s = await open("alice", mine);
      await s.next();
      await s.next();
      h.wiring.bus.publish(theirs, { kind: "tool", turnKey: 1, step });
      h.wiring.hub.publish(convOf(theirs), {
        type: "reasoning",
        conversationId: convOf(theirs),
        turn: 1,
        text: "NOT FOR THIS STREAM",
      });
      h.wiring.hub.publish(convOf(mine), { type: "reset", conversationId: convOf(mine), turn: 3 });
      h.wiring.bus.publish(mine, { kind: "reset", turnKey: 5 });
      h.wiring.hub.publish(convOf(mine), {
        type: "reasoning",
        conversationId: convOf(mine),
        turn: 3,
        text: "again",
      });
      expect(await s.next()).toBe('event: reset\ndata: {"turn":3}');
      expect(await s.next()).toBe('event: tool-reset\ndata: {"turnKey":5}');
      expect(await s.next()).toBe('event: reasoning\ndata: {"turn":3,"text":"again"}');
      s.close();
    });

    it("pings on the heartbeat, so a quiet stream stays open through proxies", async () => {
      const beats: (() => void)[] = [];
      const quiet = await startChatServer({
        stream: {
          schedule: (fn) => {
            beats.push(fn);
            return () => {};
          },
        },
      });
      const chatId = await seedChat(quiet, ALICE);
      const stream = await openSse(`${quiet.base}/api/chats/${chatId}/stream`, {
        "x-test-user": "alice",
      });
      await stream.next();
      await stream.next();
      for (const beat of beats) beat();
      expect(await stream.next()).toBe(": ping");
      stream.close();
      await quiet.close();
    });

    it("limits open streams per user with 429, frees the slot when one closes, and unsubscribes from the hub", async () => {
      // Its own user, so streams that earlier tests have closed but the server has not yet noticed cannot count.
      const chatId = await seedChat(h, ALICE2);
      const conv = chatConversationId(ALICE2.userId, chatId);
      const [a, b] = [await open("alice2", chatId), await open("alice2", chatId)];
      await a.next();
      await b.next();
      const third = await h.req("alice2", "GET", `/api/chats/${chatId}/stream`);
      expect([
        third.status,
        ((await third.json()) as { error: { code: string } }).error.code,
      ]).toEqual([429, "too_many_streams"]);
      expect(h.wiring.hub.subscriberCount(conv)).toBe(2);
      const gone = streamEnded();
      a.close();
      await gone;
      const again = await open("alice2", chatId);
      expect(again.res.status).toBe(200);
      expect(h.wiring.hub.subscriberCount(conv)).toBe(2);
      again.close();
      b.close();
    });

    it("ends every open stream on closeAll, and answers a late request 200 with a retry hint and nothing else", async () => {
      const own = await startChatServer();
      const chatId = await seedChat(own, ALICE);
      const stream = await openSse(`${own.base}/api/chats/${chatId}/stream`, {
        "x-test-user": "alice",
      });
      await stream.next();
      await stream.next();
      own.streams.closeAll();
      await expect(stream.next()).rejects.toThrow("stream ended");
      const late = await own.req("alice", "GET", `/api/chats/${chatId}/stream`);
      expect([late.status, await late.text()]).toEqual([200, "retry: 5000\n\n"]);
      await own.close();
    });

    it("releases the hub and bus subscriptions when the client leaves", async () => {
      const chatId = await seedChat(h, ALICE);
      const conv = convOf(chatId);
      const s = await open("alice", chatId);
      await s.next();
      await s.next();
      expect(h.wiring.hub.subscriberCount(conv)).toBe(1);
      const gone = streamEnded();
      s.close();
      await gone;
      expect(h.wiring.hub.subscriberCount(conv)).toBe(0);
      // A bus listener left behind would receive this; the publish must reach nobody.
      const seen: unknown[] = [];
      const off = h.wiring.bus.subscribe(chatId, (e) => seen.push(e));
      h.wiring.bus.publish(chatId, { kind: "reset", turnKey: 1 });
      off();
      expect(seen).toHaveLength(1);
    });

    it("sends too_many_streams, keeps delivering messages and releases everything when the bus has no room", async () => {
      const chatId = await seedChat(h, ALICE);
      const conv = convOf(chatId);
      const offs = Array.from({ length: 16 }, () => h.wiring.bus.subscribe(chatId, () => {}));
      try {
        const s = await open("alice", chatId);
        await s.next();
        await s.next();
        expect(await s.next()).toBe('event: error\ndata: {"code":"too_many_streams"}');
        h.fake.addTurn(conv, { question: "q", answer: "a" });
        expect((await s.next()).startsWith("id: 0.1\nevent: message\n")).toBe(true);
        const gone = streamEnded();
        s.close();
        await gone;
        expect(h.wiring.hub.subscriberCount(conv)).toBe(0);
      } finally {
        for (const off of offs) off();
      }
    });

    it("cuts off a client that does not read, and releases its subscriptions", async () => {
      const own = await startChatServer({
        stream: { maxPendingBytes: 1024, onStreamEnd: () => ended() },
      });
      const chatId = await seedChat(own, ALICE);
      const conv = chatConversationId(ALICE.userId, chatId);
      const stalled = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.get(
          `${own.base}/api/chats/${chatId}/stream`,
          { headers: { "x-test-user": "alice" } },
          (res) => {
            res.pause(); // never read: the socket buffers fill
            resolve(res);
          },
        );
        req.on("error", reject);
      });
      stalled.on("error", () => {});
      await vi.waitFor(() => expect(own.wiring.hub.subscriberCount(conv)).toBe(1));
      const gone = streamEnded();
      const chunk = "x".repeat(256 * 1024);
      for (let i = 0; i < 400 && own.wiring.hub.subscriberCount(conv) > 0; i++)
        own.wiring.hub.publish(conv, { type: "delta", conversationId: conv, turn: 1, text: chunk });
      await gone;
      expect(own.wiring.hub.subscriberCount(conv)).toBe(0);
      stalled.destroy();
      await own.close();
    });
  },
);
