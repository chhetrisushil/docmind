import { randomBytes, randomUUID } from "node:crypto";
import { ChatSessionDto } from "@docmind/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_URL } from "../db/testSupport";
import { ALICE, T1, U1, U1B, seedDoc } from "../documents/testHarness";
import { type ChatHarness, seedChat, startChatServer } from "./testHarness";

describe.skipIf(!PG_URL)(
  "POST /api/chats and GET /api/chats/:id (needs DOCMIND_TEST_PG_URL)",
  () => {
    let h: ChatHarness;
    let hNoKey: ChatHarness;
    beforeAll(async () => {
      h = await startChatServer();
      hNoKey = await startChatServer({ available: false });
    });
    afterAll(async () => {
      await h.close();
      await hNoKey.close();
    });

    it("creates a chat: 201, an untitled empty session, and a conversation started for its owner under the derived id", async () => {
      const res = await h.req("alice", "POST", "/api/chats", {});
      expect(res.status).toBe(201);
      const dto = ChatSessionDto.parse(await res.json());
      expect(dto).toMatchObject({
        title: null,
        scope: "all",
        lastMessageAt: null,
        messageCount: 0,
      });
      const conversationId = `u_${U1}.c-${dto.id}`;
      expect(h.fake.calls).toContain(`start:${conversationId}`);
      expect(h.fake.ownerOf(conversationId)).toBe(`${T1}|${U1}`);
      const row = await h.owner.query(
        "SELECT tenant_id, user_id, deleted_at FROM chat_sessions WHERE id = $1",
        [dto.id],
      );
      expect(row.rows).toEqual([{ tenant_id: T1, user_id: U1, deleted_at: null }]);
    });

    it("keeps a scope of the caller's own documents, lower-cased", async () => {
      const documentId = await seedDoc(
        h.owner,
        h.app,
        h.fields,
        ALICE,
        randomBytes(32).toString("hex"),
        0,
      );
      const res = await h.req("alice", "POST", "/api/chats", {
        scope: { documentIds: [documentId.toUpperCase()] },
      });
      expect(res.status).toBe(201);
      expect(ChatSessionDto.parse(await res.json()).scope).toEqual({ documentIds: [documentId] });
    });

    it("refuses a scope that names another user's document, and creates nothing", async () => {
      const theirs = await seedDoc(
        h.owner,
        h.app,
        h.fields,
        { tenantId: T1, userId: U1B },
        randomBytes(32).toString("hex"),
        0,
      );
      const before = h.fake.calls.length;
      const res = await h.req("alice", "POST", "/api/chats", { scope: { documentIds: [theirs] } });
      expect([res.status, ((await res.json()) as { error: { code: string } }).error.code]).toEqual([
        400,
        "invalid_scope",
      ]);
      expect(h.fake.calls).toHaveLength(before);
      expect(
        (
          await h.owner.query("SELECT 1 FROM chat_sessions WHERE scope::text LIKE $1", [
            `%${theirs}%`,
          ])
        ).rowCount,
      ).toBe(0);
    });

    it("answers 400 for a body that is not a chat request and 415 for one that is not JSON", async () => {
      expect((await h.req("alice", "POST", "/api/chats", { scope: "some" })).status).toBe(400);
      const form = await fetch(`${h.base}/api/chats`, {
        method: "POST",
        headers: { "x-test-user": "alice" },
        body: "scope=all",
      });
      expect(form.status).toBe(415);
    });

    it("answers 503 chat_unavailable without a Claude key, and creates nothing", async () => {
      const res = await hNoKey.req("alice", "POST", "/api/chats", {});
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: { code: "chat_unavailable", message: "Chat needs a Claude API key on the server." },
      });
      expect((await hNoKey.owner.query("SELECT 1 FROM chat_sessions")).rowCount).toBe(0);
      expect(hNoKey.fake.calls).toEqual([]);
    });

    it("takes the row back when the conversation cannot be started, and answers 500", async () => {
      const live = async () =>
        (
          await h.owner.query(
            "SELECT count(*)::int AS n FROM chat_sessions WHERE user_id = $1 AND deleted_at IS NULL",
            [U1],
          )
        ).rows[0].n as number;
      const before = await live();
      h.fake.failNextStart();
      const res = await h.req("alice", "POST", "/api/chats", {});
      expect(res.status).toBe(500);
      expect(await live()).toBe(before); // the row exists, soft-deleted, and is not listed
      const gone = await h.owner.query(
        "SELECT count(*)::int AS n FROM chat_sessions WHERE user_id = $1 AND deleted_at IS NOT NULL",
        [U1],
      );
      expect(gone.rows[0].n).toBeGreaterThanOrEqual(1);
    });

    it("requires a session", async () => {
      const res = await fetch(`${h.base}/api/chats`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(401);
    });

    it("reads one chat as its owner, with its title and folded activity", async () => {
      const id = await seedChat(h, ALICE, {
        title: "Q3 budget",
        messages: 4,
        lastAt: "2026-10-20T10:00:00.000Z",
      });
      const res = await h.req("alice", "GET", `/api/chats/${id}`);
      expect(res.status).toBe(200);
      expect(ChatSessionDto.parse(await res.json())).toMatchObject({
        id,
        title: "Q3 budget",
        messageCount: 4,
        lastMessageAt: "2026-10-20T10:00:00.000Z",
      });
    });

    it("answers 404 for another user, another tenant, an unknown id, a malformed id and a deleted chat, all alike", async () => {
      const id = await seedChat(h, ALICE);
      const answers = [
        await h.req("alice2", "GET", `/api/chats/${id}`),
        await h.req("bob", "GET", `/api/chats/${id}`),
        await h.req("alice", "GET", `/api/chats/${randomUUID()}`),
        await h.req("alice", "GET", "/api/chats/not-a-uuid"),
      ];
      await h.owner.query("UPDATE chat_sessions SET deleted_at = now() WHERE id = $1", [id]);
      answers.push(await h.req("alice", "GET", `/api/chats/${id}`));
      const bodies = await Promise.all(answers.map(async (r) => [r.status, await r.json()]));
      for (const body of bodies)
        expect(body).toEqual([404, { error: { code: "not_found", message: "chat not found" } }]);
    });
  },
);
