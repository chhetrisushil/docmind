import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Authenticator } from "@docmind/auth";
import { describe, expect, it, vi } from "vitest";
import { PG_URL } from "../db/testSupport";
import { ALICE, openSse, testAuthenticator } from "../documents/testHarness";
import { chatConversationId } from "./ids";
import { CHAT_STREAM_ROUTE, type ChatStreamDeps, chatStreamRoutes } from "./stream";
import { type ChatHarness, seedChat, startChatServer } from "./testHarness";

const convOf = (chatId: string) => chatConversationId(ALICE.userId, chatId);

/** A server of its own whose streams report their end, so a test awaits the release instead of sleeping. */
async function own(stream: Partial<ChatStreamDeps> = {}) {
  let ended: () => void = () => {};
  const h = await startChatServer({ stream: { ...stream, onStreamEnd: () => ended() } });
  const nextEnd = () =>
    new Promise<void>((resolve) => {
      ended = resolve;
    });
  const open = async (chatId: string) => {
    const s = await openSse(`${h.base}/api/chats/${chatId}/stream`, { "x-test-user": "alice" });
    await s.next();
    await s.next();
    return s;
  };
  return { h, nextEnd, open };
}

/** Both live channels hold no listener for the chat: what a leaked subscription would break. */
const expectReleased = (h: ChatHarness, chatId: string, bus = 0) => {
  expect(h.wiring.hub.subscriberCount(convOf(chatId))).toBe(0);
  expect(h.wiring.bus.subscriberCount(chatId)).toBe(bus);
};
const expectAttached = (h: ChatHarness, chatId: string) => {
  expect(h.wiring.hub.subscriberCount(convOf(chatId))).toBe(1);
  expect(h.wiring.bus.subscriberCount(chatId)).toBe(1);
};

describe.skipIf(!PG_URL)(
  "chat stream releases hub and bus listeners on every exit path (needs DOCMIND_TEST_PG_URL)",
  () => {
    it("client close", async () => {
      const { h, nextEnd, open } = await own();
      const chatId = await seedChat(h, ALICE);
      const s = await open(chatId);
      expectAttached(h, chatId);
      const gone = nextEnd();
      s.close();
      await gone;
      expectReleased(h, chatId);
      await h.close();
    });

    it("closeAll", async () => {
      const { h, nextEnd, open } = await own();
      const chatId = await seedChat(h, ALICE);
      const s = await open(chatId);
      expectAttached(h, chatId);
      const gone = nextEnd();
      h.streams.closeAll();
      await gone;
      await expect(s.next()).rejects.toThrow("stream ended");
      expectReleased(h, chatId);
      await h.close();
    });

    it("conversation closed", async () => {
      const { h, nextEnd, open } = await own();
      const chatId = await seedChat(h, ALICE);
      const s = await open(chatId);
      const gone = nextEnd();
      await h.fake.api.close(convOf(chatId), {
        principal: { tenant: ALICE.tenantId, actor: ALICE.userId },
      });
      await gone;
      expect(await s.next()).toBe("event: closed\ndata: {}");
      expectReleased(h, chatId);
      await h.close();
    });

    it("log read failure", async () => {
      const { h, nextEnd } = await own();
      const chatId = await seedChat(h, ALICE);
      h.wiring.reader.read = async () => {
        throw new RangeError("secret detail");
      };
      const gone = nextEnd();
      const s = await openSse(`${h.base}/api/chats/${chatId}/stream`, { "x-test-user": "alice" });
      await gone;
      expect(await s.next()).toBe("retry: 3000");
      await s.next();
      expect(await s.next()).toBe('event: error\ndata: {"code":"internal"}');
      expectReleased(h, chatId);
      await h.close();
    });

    it("backpressure", async () => {
      const { h, nextEnd } = await own({ maxPendingBytes: 1024 });
      const chatId = await seedChat(h, ALICE);
      const conv = convOf(chatId);
      const stalled = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.get(
          `${h.base}/api/chats/${chatId}/stream`,
          { headers: { "x-test-user": "alice" } },
          (res) => {
            res.pause(); // never read: the socket buffers fill
            resolve(res);
          },
        );
        req.on("error", reject);
      });
      stalled.on("error", () => {});
      await vi.waitFor(() => expectAttached(h, chatId));
      const gone = nextEnd();
      const chunk = "x".repeat(256 * 1024);
      for (let i = 0; i < 400 && h.wiring.hub.subscriberCount(conv) > 0; i++)
        h.wiring.hub.publish(conv, { type: "delta", conversationId: conv, turn: 1, text: chunk });
      await gone;
      expectReleased(h, chatId);
      stalled.destroy();
      await h.close();
    });

    it("bus has no room: the hub listener is released, the bus holds only the other listeners", async () => {
      const { h, nextEnd } = await own();
      const chatId = await seedChat(h, ALICE);
      const offs = Array.from({ length: 16 }, () => h.wiring.bus.subscribe(chatId, () => {}));
      const s = await openSse(`${h.base}/api/chats/${chatId}/stream`, { "x-test-user": "alice" });
      await s.next();
      await s.next();
      expect(await s.next()).toBe('event: error\ndata: {"code":"too_many_streams"}');
      const gone = nextEnd();
      s.close();
      await gone;
      expectReleased(h, chatId, 16);
      for (const off of offs) off();
      expectReleased(h, chatId);
      await h.close();
    });

    it("write error on the response", async () => {
      const h = await startChatServer();
      const chatId = await seedChat(h, ALICE);
      let ended: () => void = () => {};
      const streams = chatStreamRoutes({ ...h.deps, onStreamEnd: () => ended() });
      let captured: http.ServerResponse | undefined;
      const server = http.createServer((req, res) => {
        captured = res;
        void streams.routes[CHAT_STREAM_ROUTE]?.(req, res, { params: { id: chatId } });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const s = await openSse(`${base}/x`, { "x-test-user": "alice" });
      await s.next();
      await s.next();
      expectAttached(h, chatId);
      const gone = new Promise<void>((resolve) => {
        ended = resolve;
      });
      captured?.emit("error", new Error("write failed"));
      await gone;
      expectReleased(h, chatId);
      s.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await h.close();
    });
  },
);

describe.skipIf(!PG_URL)(
  "chat stream re-checks the session and the chat on every heartbeat (needs DOCMIND_TEST_PG_URL)",
  () => {
    const world = async () => {
      let revoked = false;
      let checks = 0;
      const authenticator: Authenticator = {
        async authenticate(req) {
          checks++;
          return revoked ? null : testAuthenticator.authenticate(req);
        },
      };
      const beats: (() => void)[] = [];
      const o = await own({
        authenticator,
        schedule: (fn) => {
          beats.push(fn);
          return () => {};
        },
      });
      const beat = () => {
        for (const fn of beats) fn();
      };
      return {
        ...o,
        beat,
        revoke: () => {
          revoked = true;
        },
        checks: () => checks,
      };
    };

    it("keeps streaming while the session and the chat are live", async () => {
      const w = await world();
      const chatId = await seedChat(w.h, ALICE);
      const s = await w.open(chatId);
      const before = w.checks();
      w.beat();
      expect(await s.next()).toBe(": ping");
      await vi.waitFor(() => expect(w.checks()).toBe(before + 1));
      w.h.fake.addTurn(convOf(chatId), { question: "q", answer: "a" });
      expect((await s.next()).startsWith("id: 0.1\nevent: message\n")).toBe(true);
      s.close();
      await w.h.close();
    });

    it("ends the stream on the next tick after the session is revoked, and releases everything", async () => {
      const w = await world();
      const chatId = await seedChat(w.h, ALICE);
      const s = await w.open(chatId);
      w.revoke();
      const gone = w.nextEnd();
      w.beat();
      await gone;
      expect(await s.next()).toBe(": ping");
      await expect(s.next()).rejects.toThrow("stream ended");
      expectReleased(w.h, chatId);
      await w.h.close();
    });

    it("ends the stream on the next tick after the chat is soft-deleted, and releases everything", async () => {
      const w = await world();
      const chatId = await seedChat(w.h, ALICE);
      const s = await w.open(chatId);
      await w.h.owner.query("UPDATE chat_sessions SET deleted_at = now() WHERE id = $1", [chatId]);
      const gone = w.nextEnd();
      w.beat();
      await gone;
      expect(await s.next()).toBe(": ping");
      await expect(s.next()).rejects.toThrow("stream ended");
      expectReleased(w.h, chatId);
      await w.h.close();
    });
  },
);
