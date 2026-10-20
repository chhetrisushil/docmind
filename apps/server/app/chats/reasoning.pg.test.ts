import { ReasoningResponse } from "@docmind/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_URL } from "../db/testSupport";
import { ALICE } from "../documents/testHarness";
import { chatConversationId } from "./ids";
import { type ChatHarness, seedChat, seedReasoning, startChatServer } from "./testHarness";

describe.skipIf(!PG_URL)("GET /api/chats/:id/reasoning (needs DOCMIND_TEST_PG_URL)", () => {
  let h: ChatHarness;
  beforeAll(async () => {
    h = await startChatServer();
  });
  afterAll(async () => {
    await h.close();
  });
  const get = (user: string, chatId: string, query: string) =>
    h.req(user, "GET", `/api/chats/${chatId}/reasoning${query}`);

  it("returns Loom's body for a reply: steps, attempts, parts, text unwrapped", async () => {
    const chatId = await seedChat(h, ALICE);
    const cursor = await seedReasoning(h, ALICE, chatId, 1, "Weighing the payment terms.");
    const res = await get("alice", chatId, `?cursor=${cursor}`);
    expect(res.status).toBe(200);
    expect(ReasoningResponse.parse(await res.json())).toEqual({
      steps: [
        {
          stepId: "conv#o1#turn:0",
          recordedAttempt: 1,
          attempts: [
            {
              attempt: 1,
              provider: "anthropic",
              model: "m",
              recorded: true,
              parts: [{ kind: "summary", status: "ok", text: "Weighing the payment terms." }],
            },
          ],
        },
      ],
    });
  });

  it("is the owner's alone: another user and a missing chat are 404, and learn nothing about the cursor", async () => {
    const chatId = await seedChat(h, ALICE);
    const cursor = await seedReasoning(
      h,
      ALICE,
      chatId,
      1,
      "Private reasoning about the contract.",
    );
    for (const [user, id] of [
      ["alice2", chatId],
      ["alice", "00000000-0000-4000-8000-000000000000"],
    ] as const) {
      const res = await get(user, id, `?cursor=${cursor}`);
      expect([res.status, ((await res.json()) as { error: { code: string } }).error.code]).toEqual([
        404,
        "not_found",
      ]);
    }
    expect(await (await get("alice2", chatId, "?cursor=0.2")).text()).not.toContain("Private");
  });

  it("is 404 for a user message and an unknown cursor, and 400 for a missing or malformed cursor", async () => {
    const chatId = await seedChat(h, ALICE);
    const cursor = await seedReasoning(h, ALICE, chatId, 1, "Some reasoning for the first reply.");
    const history = (await (
      await h.req("alice", "GET", `/api/chats/${chatId}/messages`)
    ).json()) as {
      items: { cursor: string }[];
    };
    const userCursor = history.items[0]?.cursor; // the question: a user record has no reasoning
    expect((await get("alice", chatId, `?cursor=${userCursor}`)).status).toBe(404);
    expect((await get("alice", chatId, "?cursor=0.999")).status).toBe(404);
    const none = await get("alice", chatId, "");
    expect([none.status, ((await none.json()) as { error: { code: string } }).error.code]).toEqual([
      400,
      "invalid_request",
    ]);
    const bad = await get("alice", chatId, "?cursor=banana");
    expect([bad.status, ((await bad.json()) as { error: { code: string } }).error.code]).toEqual([
      400,
      "invalid_cursor",
    ]);
  });

  it("answers an empty step list for a reply that kept no reasoning, and works without a Claude key", async () => {
    const noKey = await startChatServer({ available: false });
    const chatId = await seedChat(noKey, ALICE);
    noKey.fake.addTurn(chatConversationId(ALICE.userId, chatId), { question: "q", answer: "a" });
    const history = (await (
      await noKey.req("alice", "GET", `/api/chats/${chatId}/messages`)
    ).json()) as { items: { cursor: string }[] };
    const res = await noKey.req(
      "alice",
      "GET",
      `/api/chats/${chatId}/reasoning?cursor=${history.items[1]?.cursor}`,
    );
    expect([res.status, await res.json()]).toEqual([200, { steps: [] }]);
    await noKey.close();
  });

  it("answers a generic 500 and passes no message through when Loom fails in an unexpected way", async () => {
    const chatId = await seedChat(h, ALICE);
    const cursor = await seedReasoning(
      h,
      ALICE,
      chatId,
      1,
      "Reasoning that must stay out of errors.",
    );
    const api = h.fake.api;
    const original = api.reasoningTarget;
    api.reasoningTarget = async () => {
      throw new RangeError("SECRET-FAILURE-DETAIL");
    };
    try {
      const res = await get("alice", chatId, `?cursor=${cursor}`);
      const text = await res.text();
      expect([res.status, JSON.parse(text).error.code]).toEqual([500, "internal"]);
      expect(text).not.toContain("SECRET");
    } finally {
      api.reasoningTarget = original;
    }
  });
});
