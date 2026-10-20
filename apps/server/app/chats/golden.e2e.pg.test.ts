import { randomUUID } from "node:crypto";
import {
  ChatMessageDto,
  ChatSessionDto,
  ListMessagesResponse,
  ReasoningResponse,
  type UploadDocumentResponse,
} from "@docmind/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PG_URL } from "../db/testSupport";
import { type IngestStack, startIngestStack } from "../documents/ingestStack";
import { DOC, SENTENCE, SIG, collectUntil, isReply, scriptChat } from "./e2eSupport";
import { assertNoPlaintext, sealedPaths } from "./eventLogProof";
import { chatConversationId } from "./ids";

const WAIT = 60_000;
const QUESTION = "When is payment due?";

describe.skipIf(!PG_URL)(
  "M4 acceptance: upload, ask, stream, reload (needs DOCMIND_TEST_PG_URL)",
  () => {
    let st: IngestStack;
    beforeAll(async () => {
      st = await startIngestStack({ chat: true });
    });
    afterAll(async () => {
      await st?.close();
    });

    it(
      "streams reasoning, a tool step and the answer, stores a message with a valid citation, and shows it all again after a reload",
      async () => {
        const claude = st.claude;
        if (!claude) throw new Error("the stack has no fake Claude");
        const ada = await st.signUpAndLogIn("ada@example.com");

        // 1. upload and wait until the document is ready (one chunk, no summary: ingest has no key here)
        const events = await st.events(ada.cookie);
        const uploaded = await st.upload(ada.cookie, "terms.txt", Buffer.from(DOC));
        expect(uploaded.status).toBe(201);
        const documentId = ((await uploaded.json()) as UploadDocumentResponse).document.id;
        await st.until(events, documentId, (s) => s === "ready" || s === "failed");
        events.close();
        const chunks = await st.db.owner.query("SELECT id FROM chunks WHERE document_id = $1", [
          documentId,
        ]);
        expect(chunks.rowCount).toBe(1);
        const passageId = chunks.rows[0].id as string;
        const answer = `Payment is due within 30 days [[${passageId}]].`;
        scriptChat(claude, () => ({
          stream: {
            steps: [
              { text: "Payment is due " },
              { text: `within 30 days [[${passageId}]].` },
              { stop: "end_turn" },
            ],
          },
        }));

        // 2. create a chat and open its stream
        const created = await st.chatReq(ada.cookie, "POST", "/api/chats", {});
        expect(created.status).toBe(201);
        const chat = ChatSessionDto.parse(await created.json());
        const stream = await st.openChat(ada.cookie, chat.id);

        // 3. ask
        const messageId = randomUUID();
        const sent = await st.chatReq(ada.cookie, "POST", `/api/chats/${chat.id}/messages`, {
          text: QUESTION,
          messageId,
        });
        expect([sent.status, await sent.json()]).toEqual([202, { messageId }]);

        // 4. the stream: the question first (durable), then reasoning, the tool step and the answer, then the reply (durable)
        let frames: Awaited<ReturnType<typeof collectUntil>>;
        try {
          frames = await collectUntil(stream, isReply);
        } finally {
          stream.close();
        }
        // The live frames come from the hub and the bus at once; the durable question comes from the history poll, so
        // where it falls among the first live frames is not fixed. What is fixed: the live order, and the two
        // durable messages in order, the reply last.
        const kinds = frames
          .map((f) => f.event)
          .filter((k, i, all) => k !== all[i - 1] && k !== "message");
        expect(kinds).toEqual(["status", "reasoning", "tool", "answer"]);
        expect(frames[0]?.event).toBe("status");
        expect(
          frames.filter((f) => f.event === "message").map((f) => (f.data as { role: string }).role),
        ).toEqual(["user", "assistant"]);
        expect(frames.at(-1)?.event).toBe("message");
        const live = (event: string) =>
          frames
            .filter((f) => f.event === event)
            .map(
              (f) => f.data as { turn?: number; turnKey?: number; text?: string; step?: unknown },
            );
        expect(
          live("reasoning")
            .map((d) => d.text)
            .join(""),
        ).toBe("I should look for the payment terms.");
        expect(live("reasoning")[0]?.turn).toBe(1);
        expect(live("tool")[0]?.step).toMatchObject({ name: "search_docs", count: 1 });
        expect(
          live("answer")
            .map((d) => d.text)
            .join(""),
        ).toBe(answer); // live deltas carry the raw marker
        const [userFrame, replyFrame] = frames.filter((f) => f.event === "message");
        expect(ChatMessageDto.parse(userFrame?.data)).toMatchObject({
          role: "user",
          text: QUESTION,
          status: "complete",
        });

        // 5. the durable reply: a valid citation, the reasoning and the step, no outcome
        const reply = ChatMessageDto.parse(replyFrame?.data);
        expect(reply).toMatchObject({
          role: "assistant",
          status: "complete",
          text: answer,
          reasoning: { text: "I should look for the payment terms.", kind: "summary" },
          outcome: null,
          cursor: expect.stringMatching(/^0\.\d+$/),
        });
        expect(reply.citations).toHaveLength(1);
        expect(reply.citations[0]).toMatchObject({ passageId, documentId });
        expect(reply.citations[0]?.snippet).toContain("due within 30 days");
        expect(reply.steps).toEqual([
          { name: "search_docs", label: expect.stringContaining("Searched documents"), count: 1 },
        ]);

        // 6. the second model request carried the first one's thinking block, with its text and signature, ahead of the tool call
        const second = claude.requests.filter((r) => r.body.model !== "title-model")[1];
        const assistantTurn = second?.body.messages.find((m) => m.role === "assistant");
        expect(assistantTurn?.content[0]).toMatchObject({
          type: "thinking",
          thinking: "I should look for the payment terms.",
          signature: SIG,
        });
        expect(assistantTurn?.content.some((b) => b.type === "tool_use")).toBe(true);

        // 7. a reload shows the same two messages, the same ids, citations, reasoning and steps
        const history = ListMessagesResponse.parse(
          await (await st.chatReq(ada.cookie, "GET", `/api/chats/${chat.id}/messages`)).json(),
        );
        expect(history.nextCursor).toBeNull();
        expect(history.items).toEqual([ChatMessageDto.parse(userFrame?.data), reply]);

        // 7b. the durable endpoint returns the same reasoning, and nobody else gets it
        const durable = await st.chatReq(
          ada.cookie,
          "GET",
          `/api/chats/${chat.id}/reasoning?cursor=${reply.cursor}`,
        );
        expect(durable.status).toBe(200);
        const body = ReasoningResponse.parse(await durable.json());
        expect(
          body.steps.flatMap((s) =>
            s.attempts.flatMap((a) => a.parts.map((p) => [p.kind, p.status, p.text])),
          ),
        ).toEqual([["summary", "ok", "I should look for the payment terms."]]);
        const bob = await st.signUpAndLogIn("bob@example.com");
        expect(
          (
            await st.chatReq(
              bob.cookie,
              "GET",
              `/api/chats/${chat.id}/reasoning?cursor=${reply.cursor}`,
            )
          ).status,
        ).toBe(404);
        const userCursor = ChatMessageDto.parse(userFrame?.data).cursor; // a user message has no reasoning
        expect(
          (
            await st.chatReq(
              ada.cookie,
              "GET",
              `/api/chats/${chat.id}/reasoning?cursor=${userCursor}`,
            )
          ).status,
        ).toBe(404);

        // 8. the list: one chat, two messages, and a title: the send route started `chat-title` for the first question
        await st.composed.activity.drain();
        await vi.waitFor(
          async () => {
            const one = ChatSessionDto.parse(
              await (await st.chatReq(ada.cookie, "GET", `/api/chats/${chat.id}`)).json(),
            );
            expect(one).toMatchObject({ title: "Payment due dates", messageCount: 2 });
            expect(one.lastMessageAt).not.toBeNull();
          },
          { timeout: 20_000 }, // the title flow is a durable execution with no hook to await; this waits on its result
        );
        const row = (
          await st.db.owner.query("SELECT title_source FROM chat_sessions WHERE id = $1", [chat.id])
        ).rows[0];
        expect(row.title_source).toBe("auto");

        // 9. nothing readable is left in the stores. The event-log proof of Task 147b (ruling P10), over the whole
        //    stack: Postgres, the real retriever, fake Ollama and FakeAnthropic.
        const raw = await st.durable.raw.eventStore.read(chatConversationId(ada.userId, chat.id));
        expect(raw.length).toBeGreaterThan(5);
        assertNoPlaintext(raw, [
          QUESTION,
          "Payment is due",
          "I should look for the payment terms",
          "Payment terms:",
          SENTENCE,
          SIG,
        ]);
        expect([...sealedPaths(raw)]).toEqual(
          expect.arrayContaining([
            "DECISION_RECORDED:choice.text",
            "STEP_STARTED:input.messages",
            "STEP_COMPLETED:output.content",
            "STEP_COMPLETED:output.toolCalls[].input",
            "STEP_COMPLETED:output.reasoning",
            "LLM_REASONING_CAPTURED:parts",
          ]),
        );
        const items = await st.db.owner.query(
          "SELECT body_enc FROM chat_turn_items WHERE chat_id = $1",
          [chat.id],
        );
        expect(items.rowCount).toBeGreaterThanOrEqual(2); // tool, passages
        for (const { body_enc } of items.rows) {
          expect(body_enc.__loomEnc).toBeDefined();
          expect(JSON.stringify(body_enc)).not.toContain("payment terms");
        }
        const texts = await st.db.owner.query(
          "SELECT text_enc FROM chat_reasoning_texts WHERE chat_id = $1",
          [chat.id],
        );
        expect(texts.rowCount).toBeGreaterThanOrEqual(1); // the first model frame's summary
        for (const { text_enc } of texts.rows) {
          expect(text_enc.__loomEnc).toBeDefined();
          expect(JSON.stringify(text_enc)).not.toContain("payment terms");
        }
        expect(raw.some((e) => e.eventType === "LLM_REASONING_CAPTURED")).toBe(true);
        const titleRow = (
          await st.db.owner.query("SELECT title_enc FROM chat_sessions WHERE id = $1", [chat.id])
        ).rows[0];
        expect(JSON.stringify(titleRow.title_enc)).not.toContain("Payment due dates");
        // 10. the production stack seals snapshots too (Task 147b's testStack sealed none): whatever Loom
        //     snapshotted for this conversation holds none of the secrets in the clear
        const snapshot = await st.durable.raw.snapshotStore.loadLatest(
          chatConversationId(ada.userId, chat.id),
        );
        expect(snapshot?.state).toMatchObject({ aad: "loom-snap-v1" }); // there is a snapshot, and its state is sealed
        const snapshotJson = JSON.stringify(snapshot);
        for (const secret of [QUESTION, "Payment is due", "payment terms", SIG])
          expect(snapshotJson).not.toContain(secret);
      },
      WAIT,
    );

    it(
      "after a rejected edit, a cited question's steps and citations join to the right turn in a reloaded history",
      async () => {
        const claude = st.claude;
        if (!claude) throw new Error("the stack has no fake Claude");
        const cam = await st.signUpAndLogIn("cam@example.com");
        const events = await st.events(cam.cookie);
        const uploaded = await st.upload(cam.cookie, "terms.txt", Buffer.from(DOC));
        const documentId = ((await uploaded.json()) as UploadDocumentResponse).document.id;
        await st.until(events, documentId, (s) => s === "ready" || s === "failed");
        events.close();
        const passageId = (
          await st.db.owner.query("SELECT id FROM chunks WHERE document_id = $1", [documentId])
        ).rows[0].id as string;
        scriptChat(claude, () => ({
          stream: { steps: [{ text: `Due in 30 days [[${passageId}]].` }, { stop: "end_turn" }] },
        }));
        const chat = ChatSessionDto.parse(
          await (await st.chatReq(cam.cookie, "POST", "/api/chats", {})).json(),
        );
        const stream = await st.openChat(cam.cookie, chat.id);
        try {
          // Loom records a rejected user turn for an edit of a turn that does not exist
          const bad = await st.chatReq(cam.cookie, "POST", `/api/chats/${chat.id}/messages`, {
            text: "An edit of nothing",
            editOf: 999,
          });
          expect(bad.status).toBe(202);
          await collectUntil(stream, (f) => f.event === "message" && !isReply(f));
          const good = await st.chatReq(cam.cookie, "POST", `/api/chats/${chat.id}/messages`, {
            text: QUESTION,
          });
          expect(good.status).toBe(202);
          await collectUntil(stream, isReply);
        } finally {
          stream.close();
        }
        const history = ListMessagesResponse.parse(
          await (await st.chatReq(cam.cookie, "GET", `/api/chats/${chat.id}/messages`)).json(),
        );
        expect(history.items.map((m) => [m.role, m.status])).toEqual([
          ["user", "rejected"],
          ["user", "complete"],
          ["assistant", "complete"],
        ]);
        const replies = history.items.filter((m) => m.role === "assistant");
        expect(replies).toHaveLength(1);
        const [only] = replies;
        expect(only).toMatchObject({
          status: "complete",
          text: `Due in 30 days [[${passageId}]].`,
        });
        expect(only?.citations.map((c) => c.passageId)).toEqual([passageId]);
        expect(only?.steps).toEqual([
          { name: "search_docs", label: expect.stringContaining("Searched documents"), count: 1 },
        ]);
        expect(only?.reasoning).toMatchObject({ text: "I should look for the payment terms." });
        // the reply follows the cited question, not the rejected one
        const at = history.items.findIndex((m) => m === only);
        expect(history.items[at - 1]).toMatchObject({ role: "user", text: QUESTION });
      },
      WAIT,
    );
  },
);
