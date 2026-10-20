import { randomBytes, randomUUID } from "node:crypto";
import { ListMessagesResponse } from "@docmind/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_URL } from "../db/testSupport";
import { ALICE, ALICE2, seedDoc } from "../documents/testHarness";
import { DELETED_DOCUMENT } from "./citations";
import { chatConversationId } from "./ids";
import { readHistoryPage, turnKeyOf } from "./messages";
import { type ChatHarness, seedChat, startChatServer } from "./testHarness";
import type { ChatRef, StoredPassage } from "./turnItems";

const ref = (chatId: string): ChatRef => ({
  tenantId: ALICE.tenantId,
  userId: ALICE.userId,
  chatId,
});
const history = async (h: ChatHarness, user: string, chatId: string, query = "") => {
  const res = await h.req(user, "GET", `/api/chats/${chatId}/messages${query}`);
  return {
    status: res.status,
    body: (res.status === 200
      ? ListMessagesResponse.parse(await res.json())
      : await res.json()) as ListMessagesResponse,
  };
};

describe.skipIf(!PG_URL)("GET /api/chats/:id/messages (needs DOCMIND_TEST_PG_URL)", () => {
  let h: ChatHarness; // whole pages
  let short: ChatHarness; // Loom returns at most 4 entries per call, whatever was asked
  let noKey: ChatHarness;
  beforeAll(async () => {
    h = await startChatServer();
    short = await startChatServer({ pageCap: 4 });
    noKey = await startChatServer({ available: false });
  });
  afterAll(async () => {
    await Promise.all([h.close(), short.close(), noKey.close()]);
  });

  const convOf = (chatId: string) => chatConversationId(ALICE.userId, chatId);

  it("returns the user's question and the answer with its citations, reasoning and tool steps merged from the side table", async () => {
    const chatId = await seedChat(h, ALICE);
    const documentId = await seedDoc(
      h.owner,
      h.app,
      h.fields,
      ALICE,
      randomBytes(32).toString("hex"),
      0,
    );
    const passageId = randomUUID();
    const stored: StoredPassage = {
      passageId,
      documentId,
      locator: { kind: "page", page: 2 },
      headingPath: ["Terms"],
      snippet: "Payment is due within 30 days.",
    };
    h.fake.addTurn(convOf(chatId), {
      question: "When is payment due?",
      answer: `Within 30 days [[${passageId}]], and later [[${randomUUID()}]].`,
    });
    const items = h.wiring.items;
    await items.put(ref(chatId), 1, "conv#o1#turn:0:tool:0", {
      kind: "tool",
      body: { name: "search_docs", label: 'Searched documents: "payment terms"', count: 1 },
    });
    await items.put(ref(chatId), 1, "conv#o1#turn:0:tool:0#p", {
      kind: "passages",
      body: { passages: [stored] },
    });

    const first = await history(h, "alice", chatId);
    const replyCursor = first.body.items[1]?.cursor as string;
    expect(first.body.items[1]?.reasoning).toBeNull(); // nothing recorded yet
    h.reasoning.set(replyCursor, { text: "Looking at the contract\n\nFound it", kind: "summary" });
    const { body } = await history(h, "alice", chatId);
    expect(body.nextCursor).toBeNull();
    expect(body.items.map((m) => [m.role, m.status])).toEqual([
      ["user", "complete"],
      ["assistant", "complete"],
    ]);
    const [user, assistant] = body.items;
    expect(user).toMatchObject({
      text: "When is payment due?",
      citations: [],
      reasoning: null,
      steps: [],
      outcome: null,
    });
    expect(assistant?.text).toBe(`Within 30 days [[${passageId}]], and later.`);
    expect(assistant?.citations).toEqual([
      {
        passageId,
        documentId,
        docTitle: "Quarterly report",
        locator: { kind: "page", page: 2 },
        snippet: "Payment is due within 30 days.",
      },
    ]);
    expect(assistant?.reasoning).toEqual({
      text: "Looking at the contract\n\nFound it",
      kind: "summary",
    });
    expect([user?.cursor, assistant?.cursor]).toEqual([
      expect.stringMatching(/^0\.\d+$/),
      replyCursor,
    ]);
    // reasoning is asked for replies only, with their turn keys, in one call per page
    expect(h.reasoning.calls.at(-1)).toEqual([{ cursor: replyCursor, turnKey: 1 }]);
    expect(assistant?.steps).toEqual([
      { name: "search_docs", label: 'Searched documents: "payment terms"', count: 1 },
    ]);
    expect(assistant?.outcome).toBeNull();
  });

  it("joins each reply to its own turn's items by turn key, across several turns", async () => {
    const chatId = await seedChat(h, ALICE);
    // A rejected envelope before turns 2 and 3 consumes a message each, so the turn keys are 1, 3 and 5.
    const keys = [1, 3, 5];
    for (const [i, n] of [1, 2, 3].entries()) {
      if (i > 0) h.fake.addRejected(convOf(chatId));
      h.fake.addTurn(convOf(chatId), { question: `q${n}`, answer: `a${n}` });
    }
    for (const [i, key] of keys.entries())
      await h.wiring.items.put(ref(chatId), key, `conv#o${key}#turn:0:tool:0`, {
        kind: "tool",
        body: { name: "search_docs", label: `step ${i + 1}`, count: i + 1 },
      });
    const { body: three } = await history(h, "alice", chatId);
    const replies = three.items.filter((m) => m.role === "assistant");
    expect(replies.map((m) => m.steps.map((s) => s.label))).toEqual([
      ["step 1"],
      ["step 2"],
      ["step 3"],
    ]);
    expect(h.reasoning.calls.at(-1)?.map((r) => r.turnKey)).toEqual(keys);
  });

  it("names a deleted document, and never the title of a document that is not the caller's", async () => {
    const chatId = await seedChat(h, ALICE);
    const foreignDoc = await seedDoc(
      h.owner,
      h.app,
      h.fields,
      ALICE2,
      randomBytes(32).toString("hex"),
      0,
    );
    const [gone, foreign] = [randomUUID(), randomUUID()];
    h.fake.addTurn(convOf(chatId), { question: "q", answer: `a [[${gone}]] b [[${foreign}]]` });
    const mk = (passageId: string, documentId: string): StoredPassage => ({
      passageId,
      documentId,
      locator: { kind: "chars", start: 0, end: 5 },
      headingPath: [],
      snippet: "s",
    });
    await h.wiring.items.put(ref(chatId), 1, "conv#o1#turn:0:tool:0#p", {
      kind: "passages",
      body: { passages: [mk(gone, randomUUID()), mk(foreign, foreignDoc)] },
    });
    const { body } = await history(h, "alice", chatId);
    expect(body.items[1]?.citations.map((c) => c.docTitle)).toEqual([
      DELETED_DOCUMENT,
      DELETED_DOCUMENT,
    ]);
  });

  it("shows how a reply ended: a refusal, an exhausted loop, a failed or an interrupted turn", async () => {
    const chatId = await seedChat(h, ALICE);
    const conv = convOf(chatId);
    h.fake.addTurn(conv, { question: "refuse me", answer: "I can't help with that." }); // turn key 1
    h.fake.addTurn(conv, { question: "loop forever", answer: "" }); // 2: complete and empty
    h.fake.addTurn(conv, { question: "explode", answer: "", status: "failed" }); // 3
    h.fake.addTurn(conv, { question: "stop me", answer: "part of an ans", status: "interrupted" }); // 4
    h.fake.addTurn(conv, { question: "long", answer: "cut off" }); // 5
    await h.wiring.items.put(ref(chatId), 1, "conv#o1#turn:0", {
      kind: "outcome",
      body: { kind: "refusal" },
    });
    await h.wiring.items.put(ref(chatId), 5, "conv#o5#turn:0", {
      kind: "outcome",
      body: { kind: "max_tokens" },
    });
    const replies = (await history(h, "alice", chatId)).body.items.filter(
      (m) => m.role === "assistant",
    );
    expect(replies.map((m) => [m.status, m.outcome])).toEqual([
      ["complete", "refusal"],
      ["complete", "max_iterations"],
      ["failed", null],
      ["interrupted", null],
      ["complete", "max_tokens"],
    ]);
    expect(replies[3]?.text).toBe("part of an ans");
  });

  it("pages backward 30 messages at a time, oldest first within a page, and follows short pages from Loom until the page is full", async () => {
    const chatId = await seedChat(short, ALICE);
    for (let i = 1; i <= 20; i++)
      short.fake.addTurn(convOf(chatId), { question: `q${i}`, answer: `a${i}` });
    const first = await history(short, "alice", chatId);
    expect(first.body.items).toHaveLength(30); // 8 calls of at most 4 entries each, never a short page
    expect(first.body.items.map((m) => m.text).slice(0, 2)).toEqual(["q6", "a6"]);
    expect(first.body.items.at(-1)?.text).toBe("a20");
    expect(first.body.nextCursor).not.toBeNull();
    const second = await history(
      short,
      "alice",
      chatId,
      `?cursor=${encodeURIComponent(first.body.nextCursor as string)}`,
    );
    expect(second.body.items.map((m) => m.text)).toEqual(
      Array.from({ length: 5 }, (_, i) => [`q${i + 1}`, `a${i + 1}`]).flat(),
    );
    expect(second.body.nextCursor).toBeNull();
    const ids = [...second.body.items, ...first.body.items].map((m) => m.id);
    expect(new Set(ids).size).toBe(40);
  });

  it("answers 400 invalid_cursor for a cursor Loom refuses", async () => {
    const chatId = await seedChat(h, ALICE);
    expect((await history(h, "alice", chatId, "?cursor=nonsense")).body).toMatchObject({
      error: { code: "invalid_cursor" },
    });
  });

  it("answers 404 for another user, another tenant, an unknown, a malformed and a deleted chat, alike", async () => {
    const chatId = await seedChat(h, ALICE);
    h.fake.addTurn(convOf(chatId), { question: "secret question", answer: "secret answer" });
    const answers = [
      await h.req("alice2", "GET", `/api/chats/${chatId}/messages`),
      await h.req("bob", "GET", `/api/chats/${chatId}/messages`),
      await h.req("alice", "GET", `/api/chats/${randomUUID()}/messages`),
      await h.req("alice", "GET", "/api/chats/nope/messages"),
    ];
    await h.owner.query("UPDATE chat_sessions SET deleted_at = now() WHERE id = $1", [chatId]);
    answers.push(await h.req("alice", "GET", `/api/chats/${chatId}/messages`));
    for (const res of answers) {
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("secret");
    }
  });

  it("answers 404 when the chat row exists but its conversation does not", async () => {
    const id = randomUUID();
    await h.owner.query(
      "INSERT INTO chat_sessions (id, tenant_id, user_id, scope) VALUES ($1, $2, $3, '\"all\"'::jsonb)",
      [id, ALICE.tenantId, ALICE.userId],
    );
    const res = await h.req("alice", "GET", `/api/chats/${id}/messages`);
    expect([res.status, ((await res.json()) as { error: { code: string } }).error.code]).toEqual([
      404,
      "not_found",
    ]);
  });

  it("still serves history without a Claude key", async () => {
    const chatId = await seedChat(noKey, ALICE);
    noKey.fake.addTurn(convOf(chatId), { question: "old question", answer: "old answer" });
    expect((await history(noKey, "alice", chatId)).body.items).toHaveLength(2);
  });
  it("asks for no reasoning on a page of user messages, and shows what the store gives as it is", async () => {
    const chatId = await seedChat(h, ALICE);
    h.fake.addTurn(convOf(chatId), { question: "q", answer: "a" });
    const before = h.reasoning.calls.length;
    const { body } = await history(h, "alice", chatId);
    const reply = body.items[1];
    h.reasoning.set(reply?.cursor as string, { text: "", kind: "redacted" });
    const again = await history(h, "alice", chatId);
    expect(again.body.items[1]?.reasoning).toEqual({ text: "", kind: "redacted" });
    expect(h.reasoning.calls.length).toBeGreaterThan(before);
    expect(h.reasoning.calls.flat().every((r) => r.cursor !== body.items[0]?.cursor)).toBe(true);
  });

  it("turnKeyOf equals the o of Loom's conv#o<o>:reply decision id for every reply, and of conv#o<o>:user for its question", async () => {
    const chatId = await seedChat(h, ALICE);
    // Two counters, as in Loom: rejected envelopes consume a message and write a record but are no turn.
    for (let n = 1; n <= 4; n++) {
      if (n === 2 || n === 3) h.fake.addRejected(convOf(chatId));
      h.fake.addTurn(convOf(chatId), { question: `q${n}`, answer: `a${n}` });
    }
    const { entries } = await readHistoryPage(
      h.wiring.conversations,
      convOf(chatId),
      { tenant: ALICE.tenantId, actor: ALICE.userId },
      undefined,
      30,
    );
    expect(entries).toHaveLength(10);
    expect(entries.filter((e) => e.turn === 0)).toHaveLength(2);
    // record ordinals and message ids drift apart: the last reply is record 10 of message 7
    expect(entries.at(-1)).toMatchObject({ ord: 10, turn: 4 });
    for (const e of entries.filter((x) => x.turn >= 1)) {
      const seq = Number(e.cursor.split(".")[1]);
      const events = (await h.fake.eventStore.readRange?.(convOf(chatId), seq, seq)) ?? [];
      const event = events[0];
      const id = (event?.payload as { decisionId: string }).decisionId;
      expect(id).toBe(`conv#o${turnKeyOf(e)}:${e.role === "user" ? "user" : "reply"}`);
    }
  });
});
