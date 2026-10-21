import { describe, expect, it } from "vitest";
import { PG_URL } from "../db/testSupport";
import { ALICE, ALICE2, openSse } from "../documents/testHarness";
import { chatConversationId } from "./ids";
import { seedChat, startChatServer } from "./testHarness";

describe.skipIf(!PG_URL)("chat streams closeUser (needs DOCMIND_TEST_PG_URL)", () => {
  it("ends one user's chat streams at once and frees their listeners, and no other user's", async () => {
    let ended: () => void = () => {};
    const h = await startChatServer({ stream: { onStreamEnd: () => ended() } });
    const nextEnd = () =>
      new Promise<void>((resolve) => {
        ended = resolve;
      });
    try {
      const [chatA, chatB] = [await seedChat(h, ALICE), await seedChat(h, ALICE2)];
      const open = async (chat: string, user: string) => {
        const s = await openSse(`${h.base}/api/chats/${chat}/stream`, { "x-test-user": user });
        await s.next(); // retry
        await s.next(); // status
        return s;
      };
      const [a, b] = [await open(chatA, "alice"), await open(chatB, "alice2")];
      const convA = chatConversationId(ALICE.userId, chatA);
      const convB = chatConversationId(ALICE2.userId, chatB);
      expect(h.wiring.hub.subscriberCount(convA)).toBe(1);

      const gone = nextEnd();
      h.streams.closeUser(ALICE.userId);
      await gone;
      await expect(a.next()).rejects.toThrow(/^stream ended$/);
      expect(h.wiring.hub.subscriberCount(convA)).toBe(0);
      expect(h.wiring.bus.subscriberCount(chatA)).toBe(0);
      // The other user's stream is still attached.
      expect(h.wiring.hub.subscriberCount(convB)).toBe(1);
      b.close();
    } finally {
      await h.close();
    }
  });

  it("is not a shutdown: the user's next stream opens", async () => {
    const h = await startChatServer();
    try {
      const chat = await seedChat(h, ALICE);
      h.streams.closeUser(ALICE.userId);
      const s = await openSse(`${h.base}/api/chats/${chat}/stream`, { "x-test-user": "alice" });
      expect(s.res.status).toBe(200);
      expect(await s.next()).toBe("retry: 3000");
      s.close();
    } finally {
      await h.close();
    }
  });
});
