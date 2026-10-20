import {
  ChatMessageDto,
  ChatSessionDto,
  ListMessagesResponse,
  type UploadDocumentResponse,
} from "@docmind/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { PG_URL } from "../db/testSupport";
import { type IngestStack, startIngestStack } from "../documents/ingestStack";
import { DOC, SIG, collectUntil, isReply, scriptChat } from "./e2eSupport";

describe.skipIf(!PG_URL)(
  "M4 acceptance: a restarted server continues the chat (needs DOCMIND_TEST_PG_URL)",
  () => {
    const stacks: IngestStack[] = [];
    afterAll(async () => {
      const last = stacks.pop();
      for (const s of stacks) await s.close({ keepDb: true }).catch(() => {});
      await last?.close();
    });

    it("answers a second turn after a restart, with the first turn's messages, reasoning and steps intact and in its prompt", async () => {
      const first = await startIngestStack({ chat: true });
      stacks.push(first);
      const claude1 = first.claude;
      if (!claude1) throw new Error("no fake Claude");
      const ada = await first.signUpAndLogIn("ada@example.com");
      const events = await first.events(ada.cookie);
      const up = await first.upload(ada.cookie, "terms.txt", Buffer.from(DOC));
      const documentId = ((await up.json()) as UploadDocumentResponse).document.id;
      await first.until(events, documentId, (s) => s === "ready" || s === "failed");
      events.close();
      const passageId = (
        await first.db.owner.query("SELECT id FROM chunks WHERE document_id = $1", [documentId])
      ).rows[0].id as string;
      scriptChat(claude1, () => ({
        stream: { steps: [{ text: `Due in 30 days [[${passageId}]].` }, { stop: "end_turn" }] },
      }));
      const chat = ChatSessionDto.parse(
        await (await first.chatReq(ada.cookie, "POST", "/api/chats", {})).json(),
      );
      const stream1 = await first.openChat(ada.cookie, chat.id);
      let turnOne: ChatMessageDto;
      try {
        await first.chatReq(ada.cookie, "POST", `/api/chats/${chat.id}/messages`, {
          text: "When is payment due?",
        });
        turnOne = ChatMessageDto.parse((await collectUntil(stream1, isReply)).at(-1)?.data);
      } finally {
        stream1.close();
      }
      await first.close({ keepDb: true }); // main's stop(): the server drains, Loom's pools end
      stacks.pop();

      const second = await startIngestStack({
        chat: true,
        resume: { db: first.db, kek: first.kek, root: first.root },
      });
      stacks.push(second);
      const claude2 = second.claude;
      if (!claude2) throw new Error("no fake Claude");
      scriptChat(claude2, () => ({
        stream: { steps: [{ text: "Two percent per month." }, { stop: "end_turn" }] },
      }));
      // the session cookie is a row in Postgres: it is still good
      const stream2 = await second.openChat(ada.cookie, chat.id);
      let turnTwo: ChatMessageDto;
      try {
        const sent = await second.chatReq(ada.cookie, "POST", `/api/chats/${chat.id}/messages`, {
          text: "And what about late payment?",
        });
        expect(sent.status).toBe(202);
        // a new stream replays the history, turn one's reply included: wait for the one after it
        const frames = await collectUntil(
          stream2,
          (f) => isReply(f) && (f.data as { cursor: string }).cursor !== turnOne.cursor,
        );
        turnTwo = ChatMessageDto.parse(frames.at(-1)?.data);
      } finally {
        stream2.close();
      }
      expect(turnTwo).toMatchObject({ status: "complete", text: "Two percent per month." });

      // the model saw the first turn as history
      const firstRequest = JSON.stringify(
        claude2.requests.find((r) => r.body.model !== "title-model")?.body.messages,
      );
      expect(firstRequest).toContain("When is payment due?");
      expect(firstRequest).toContain("Due in 30 days");

      // four messages in order; turn one is exactly what it was, with its citation, reasoning and steps
      const history = ListMessagesResponse.parse(
        await (await second.chatReq(ada.cookie, "GET", `/api/chats/${chat.id}/messages`)).json(),
      );
      expect(history.items.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
      expect(history.items[1]).toEqual(turnOne);
      expect(history.items[1]?.citations[0]?.passageId).toBe(passageId);
      expect(history.items[1]?.steps).toHaveLength(1);
      expect(history.items[1]?.reasoning).toMatchObject({
        text: "I should look for the payment terms.",
        kind: "summary",
      });
    }, 120_000);

    it("a restart in the middle of a tool loop keeps the thinking block: the recovered model call sends it back with its text and signature", async () => {
      const first = await startIngestStack({ chat: true });
      stacks.push(first);
      const claude1 = first.claude;
      if (!claude1) throw new Error("no fake Claude");
      const ada = await first.signUpAndLogIn("ada@example.com");
      const events = await first.events(ada.cookie);
      const up = await first.upload(ada.cookie, "terms.txt", Buffer.from(DOC));
      const documentId = ((await up.json()) as UploadDocumentResponse).document.id;
      await first.until(events, documentId, (s) => s === "ready" || s === "failed");
      events.close();
      // the first request thinks and searches; the second parks mid-answer, so the server stops with the tool loop unfinished
      scriptChat(claude1, () => ({
        stream: {
          steps: [{ text: "Due " }, { hold: true }, { text: "in 30 days." }, { stop: "end_turn" }],
        },
      }));
      const chat = ChatSessionDto.parse(
        await (await first.chatReq(ada.cookie, "POST", "/api/chats", {})).json(),
      );
      await first.chatReq(ada.cookie, "POST", `/api/chats/${chat.id}/messages`, {
        text: "When is payment due?",
      });
      const gate = await claude1.streamHold(); // the second model call is under way
      expect(gate).toBeDefined();
      try {
        await first.close({ keepDb: true });
      } finally {
        gate.release();
      }
      stacks.pop();

      const second = await startIngestStack({
        chat: true,
        resume: { db: first.db, kek: first.kek, root: first.root },
      });
      stacks.push(second);
      const claude2 = second.claude;
      if (!claude2) throw new Error("no fake Claude");
      scriptChat(claude2, () => ({
        stream: { steps: [{ text: "Due in 30 days." }, { stop: "end_turn" }] },
      }));
      const stream2 = await second.openChat(ada.cookie, chat.id);
      let reply: ChatMessageDto;
      try {
        reply = ChatMessageDto.parse((await collectUntil(stream2, isReply)).at(-1)?.data);
      } finally {
        stream2.close();
      }
      expect(reply).toMatchObject({ status: "complete", text: "Due in 30 days." });
      // the recovered call is a live call: Loom resolved the first block's text from OUR store through the owner's key
      const resumed = claude2.requests.filter((r) => r.body.model !== "title-model")[0];
      const assistantTurn = resumed?.body.messages.find((m) => m.role === "assistant");
      expect(assistantTurn?.content[0]).toMatchObject({
        type: "thinking",
        thinking: "I should look for the payment terms.",
        signature: SIG,
      });
      expect(
        resumed?.body.messages.some((m) => m.content.some((b) => b.type === "tool_result")),
      ).toBe(true);
    }, 120_000);
  },
);
