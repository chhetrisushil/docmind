import { randomUUID } from "node:crypto";
import {
  ChatMessageDto,
  ChatSessionDto,
  ListChatsResponse,
  ListMessagesResponse,
  type UploadDocumentResponse,
} from "@docmind/contracts";
import type { HoldGate } from "@docmind/llm-anthropic/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_URL } from "../db/testSupport";
import { type IngestStack, startIngestStack } from "../documents/ingestStack";
import { DOC, collectUntil, isReply, scriptChat } from "./e2eSupport";

const WAIT = 60_000;

describe.skipIf(!PG_URL)(
  "M4 acceptance: stop, refusal, tenancy, embedder outage (needs DOCMIND_TEST_PG_URL)",
  () => {
    let st: IngestStack;
    let ada: Awaited<ReturnType<IngestStack["signUpAndLogIn"]>>;
    let passageId = "";
    let documentId = "";

    const claude = () => {
      if (!st.claude) throw new Error("the stack has no fake Claude");
      return st.claude;
    };
    const newChat = async (cookie = ada.cookie) =>
      ChatSessionDto.parse(await (await st.chatReq(cookie, "POST", "/api/chats", {})).json());
    const ask = (cookie: string, chatId: string, text: string) =>
      st.chatReq(cookie, "POST", `/api/chats/${chatId}/messages`, { text });
    const uploadReady = async (cookie: string, name: string, text: string) => {
      const events = await st.events(cookie);
      try {
        const res = await st.upload(cookie, name, Buffer.from(text));
        const id = ((await res.json()) as UploadDocumentResponse).document.id;
        await st.until(events, id, (s) => s === "ready" || s === "failed");
        return id;
      } finally {
        events.close();
      }
    };
    const messages = async (cookie: string, chatId: string) =>
      ListMessagesResponse.parse(
        await (await st.chatReq(cookie, "GET", `/api/chats/${chatId}/messages`)).json(),
      );
    const reply = async (cookie: string, chatId: string, text: string) => {
      const stream = await st.openChat(cookie, chatId);
      try {
        expect((await ask(cookie, chatId, text)).status).toBe(202);
        const frames = await collectUntil(stream, isReply);
        return { frames, message: ChatMessageDto.parse(frames.at(-1)?.data) };
      } finally {
        stream.close();
      }
    };

    beforeAll(async () => {
      st = await startIngestStack({ chat: true });
      ada = await st.signUpAndLogIn("ada@example.com");
      documentId = await uploadReady(ada.cookie, "terms.txt", DOC);
      passageId = (
        await st.db.owner.query("SELECT id FROM chunks WHERE document_id = $1", [documentId])
      ).rows[0].id as string;
    }, WAIT);
    afterAll(async () => {
      await st?.close();
    });

    it(
      "stop cuts a running answer: the model call is abandoned, the partial text is kept, the reply is interrupted, and the next question is answered",
      async () => {
        scriptChat(claude(), () => ({
          stream: {
            steps: [
              { text: "Part of the answer" },
              { hold: true },
              { text: " that never arrives" },
              { stop: "end_turn" },
            ],
          },
        }));
        const chat = await newChat();
        const stream = await st.openChat(ada.cookie, chat.id);
        let gate: HoldGate | undefined;
        try {
          expect((await ask(ada.cookie, chat.id, "Tell me everything")).status).toBe(202);
          // the model is parked mid-answer, after its first words
          gate = await claude().streamHold();
          await collectUntil(stream, (_f, all) =>
            all
              .filter((f) => f.event === "answer")
              .map((f) => (f.data as { text: string }).text)
              .join("")
              .includes("Part of the answer"),
          ); // the fake splits the text into frames
          const stop = await st.chatReq(ada.cookie, "POST", `/api/chats/${chat.id}/stop`);
          expect([stop.status, await stop.json()]).toEqual([202, { stopped: true }]);
          await gate.closed; // the provider call was abandoned, not left running
          const cut = ChatMessageDto.parse((await collectUntil(stream, isReply)).at(-1)?.data);
          expect(cut).toMatchObject({
            status: "interrupted",
            text: "Part of the answer",
            outcome: null,
          });
          // nothing is running now
          const idle = await st.chatReq(ada.cookie, "POST", `/api/chats/${chat.id}/stop`);
          expect(await idle.json()).toEqual({ stopped: false });
          // the conversation lives on
          scriptChat(claude(), () => ({
            stream: { steps: [{ text: "A complete second answer." }, { stop: "end_turn" }] },
          }));
          expect((await ask(ada.cookie, chat.id, "Try again")).status).toBe(202);
          const next = ChatMessageDto.parse((await collectUntil(stream, isReply)).at(-1)?.data);
          expect(next).toMatchObject({ status: "complete", text: "A complete second answer." });
        } finally {
          gate?.release();
          stream.close();
        }
        const history = await messages(ada.cookie, chat.id);
        expect(history.items.map((m) => m.status)).toEqual([
          "complete",
          "interrupted",
          "complete",
          "complete",
        ]);
      },
      WAIT,
    );

    it(
      "deleting a chat ends its open stream and abandons a running answer",
      async () => {
        scriptChat(claude(), () => ({
          stream: { steps: [{ text: "Working" }, { hold: true }, { stop: "end_turn" }] },
        }));
        const chat = await newChat();
        const stream = await st.openChat(ada.cookie, chat.id);
        let gate: HoldGate | undefined;
        try {
          expect((await ask(ada.cookie, chat.id, "Start something long")).status).toBe(202);
          gate = await claude().streamHold();
          const del = await st.chatReq(ada.cookie, "DELETE", `/api/chats/${chat.id}`);
          expect(del.status).toBe(204);
          await expect(collectUntil(stream, () => false)).rejects.toThrow(); // the stream ended
          await gate.closed;
          expect((await st.chatReq(ada.cookie, "GET", `/api/chats/${chat.id}`)).status).toBe(404);
        } finally {
          gate?.release();
          stream.close();
        }
      },
      WAIT,
    );

    it(
      "a refusal is shown as its own outcome, with whatever text streamed before it, and survives a reload",
      async () => {
        scriptChat(claude(), () => ({
          stream: {
            steps: [
              { text: "I can't help with that request." },
              { stop: "refusal", details: { category: "policy", explanation: "refused" } },
            ],
          },
        }));
        const chat = await newChat();
        const { message } = await reply(ada.cookie, chat.id, "Do something I should not");
        expect(message).toMatchObject({
          status: "complete",
          outcome: "refusal",
          text: "I can't help with that request.",
          citations: [],
        });
        const history = await messages(ada.cookie, chat.id);
        expect(history.items.at(-1)).toMatchObject({ outcome: "refusal" });
        expect(JSON.stringify(history)).not.toContain("refused"); // the stop details are sealed and never shown
      },
      WAIT,
    );

    it(
      "another tenant meets 404 on every chat route, changes nothing, and never sees this tenant's passages",
      async () => {
        scriptChat(claude(), () => ({
          stream: {
            steps: [{ text: `Payment is due in 30 days [[${passageId}]].` }, { stop: "end_turn" }],
          },
        }));
        const chat = await newChat();
        const before = (await reply(ada.cookie, chat.id, "When is payment due?")).message;
        const bea = await st.signUpAndLogIn("bea@example.com");
        const modelCalls = claude().requests.length;
        const attempts: [string, string, unknown?][] = [
          ["GET", `/api/chats/${chat.id}`],
          ["PATCH", `/api/chats/${chat.id}`, { title: "hijacked" }],
          ["DELETE", `/api/chats/${chat.id}`],
          ["GET", `/api/chats/${chat.id}/messages`],
          ["POST", `/api/chats/${chat.id}/messages`, { text: "hello from bea" }],
          ["GET", `/api/chats/${chat.id}/stream`],
          ["POST", `/api/chats/${chat.id}/stop`],
          ["GET", `/api/chats/${chat.id}/reasoning?cursor=${before.cursor}`],
          ["GET", `/api/chats/${randomUUID()}`],
          ["GET", "/api/chats/not-a-uuid"],
        ];
        for (const [method, path, body] of attempts) {
          const res = await st.chatReq(bea.cookie, method, path, body);
          expect([method, path, res.status]).toEqual([method, path, 404]);
          expect(await res.json()).toEqual({
            error: { code: "not_found", message: "chat not found" },
          });
          const anonymous = await fetch(`${st.base}${path}`, {
            method,
            ...(body !== undefined && {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
          });
          expect([method, path, anonymous.status]).toEqual([method, path, 401]);
        }
        expect(claude().requests.length).toBe(modelCalls); // a foreign send reached no model
        expect(
          ListChatsResponse.parse(await (await st.chatReq(bea.cookie, "GET", "/api/chats")).json())
            .items,
        ).toEqual([]);
        // ada's chat is as it was
        const after = await messages(ada.cookie, chat.id);
        expect(after.items.at(-1)).toEqual(before);
        expect(
          ChatSessionDto.parse(
            await (await st.chatReq(ada.cookie, "GET", `/api/chats/${chat.id}`)).json(),
          ).title,
        ).not.toBe("hijacked");

        // bea's own chat searches bea's documents only: nothing of ada's reaches the model on her behalf
        await uploadReady(
          bea.cookie,
          "warranty.txt",
          "Warranty terms: the product is covered for two years from delivery.",
        );
        const mark = claude().requests.length;
        scriptChat(claude(), () => ({
          stream: { steps: [{ text: "Answer from bea's documents." }, { stop: "end_turn" }] },
        }));
        const own = await newChat(bea.cookie);
        await reply(bea.cookie, own.id, "How long is the warranty?");
        const seen = JSON.stringify(
          claude()
            .requests.slice(mark)
            .map((r) => r.body),
        );
        expect(seen).not.toContain(passageId);
        expect(seen).not.toContain("Late payment accrues");
      },
      WAIT,
    );

    it(
      "an embedder outage answers search_unavailable and never an answer from elsewhere",
      async () => {
        const seenBodies: string[] = [];
        scriptChat(claude(), (body) => {
          seenBodies.push(JSON.stringify(body));
          return JSON.stringify(body).includes("search_unavailable")
            ? {
                stream: {
                  steps: [{ text: "Search is unavailable right now." }, { stop: "end_turn" }],
                },
              }
            : {
                stream: {
                  steps: [{ text: "WRONG: answered without sources" }, { stop: "end_turn" }],
                },
              };
        });
        const chat = await newChat();
        for (let i = 0; i < 4; i++) st.fake.failNext(503); // every embed attempt of the query fails
        const { message } = await reply(ada.cookie, chat.id, "When is payment due?");
        expect(message).toMatchObject({ text: "Search is unavailable right now.", citations: [] });
        expect(seenBodies).toHaveLength(1);
        expect(seenBodies[0]).toContain("search_unavailable");
        expect(seenBodies[0]).not.toContain("Late payment accrues"); // no passage from anywhere
        expect(seenBodies[0]).not.toContain(passageId);
      },
      WAIT,
    );
  },
);
