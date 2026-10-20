import { InMemoryAsyncEventStore } from "@loom/event-runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chatConversationId } from "../../chats/ids";
import { chatTitleBind } from "../../chats/sessions";
import { type ChatHarness, seedChat, startChatServer } from "../../chats/testHarness";
import { buildApp } from "../../config";
import { PG_URL } from "../../db/testSupport";
import { ALICE, T1, U1 } from "../../documents/testHarness";
import { loomTitleStarter } from "./start";

describe.skipIf(!PG_URL)("chat-title through Loom (needs DOCMIND_TEST_PG_URL)", () => {
  let h: ChatHarness;
  beforeAll(async () => {
    h = await startChatServer();
  });
  afterAll(async () => {
    await h.close();
  });

  it("runs the one-step flow durably, titles the chat once, and a second start does nothing", async () => {
    const chatId = await seedChat(h, ALICE);
    h.fake.addTurn(chatConversationId(U1, chatId), {
      question: "When is payment due?",
      answer: "In 30 days.",
    });
    const events = new InMemoryAsyncEventStore();
    const requests: unknown[] = [];
    const app = buildApp({ kind: "custom", eventStore: events }, undefined, {
      chatTitle: {
        pool: h.app,
        fields: h.fields,
        reader: h.fake.api.reader,
        llm: {
          complete: async (r: unknown) => {
            requests.push(r);
            return { content: "Payment due dates", stopReason: "end_turn" };
          },
        } as never,
      },
    });
    try {
      const starter = loomTitleStarter(app.runtime);
      const ref = { tenantId: T1, userId: U1, chatId };
      const handle = await starter.start(ref);
      expect((await handle?.waitForCompletion())?.status).toBe("completed");
      const row = (
        await h.owner.query("SELECT title_enc, title_source FROM chat_sessions WHERE id = $1", [
          chatId,
        ])
      ).rows[0];
      expect(row.title_source).toBe("auto");
      expect(await h.fields.forUser(U1).openText(chatTitleBind(chatId), row.title_enc)).toBe(
        "Payment due dates",
      );
      expect(await starter.start(ref)).toBeNull(); // start-once
      expect(requests).toHaveLength(1);
      // The event log holds ids and the outcome, never the title or the question.
      const log = JSON.stringify(await events.read(`u_${U1}:chat-title-${chatId}`));
      expect(log).not.toContain("Payment due dates");
      expect(log).not.toContain("When is payment due?");
      expect(log).toContain('"outcome":"titled"');
    } finally {
      await app.close();
    }
  });
});
