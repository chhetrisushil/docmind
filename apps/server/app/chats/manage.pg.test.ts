import { randomBytes, randomUUID } from "node:crypto";
import { ChatSessionDto, StopChatResponse } from "@docmind/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withTenant } from "../db/tenant";
import { PG_URL } from "../db/testSupport";
import { ALICE, ALICE2, T1, U1, seedDoc } from "../documents/testHarness";
import { chatConversationId } from "./ids";
import { chatTitleBind, setTitle } from "./sessions";
import { type ChatHarness, seedChat, startChatServer } from "./testHarness";

const convOf = (chatId: string) => chatConversationId(ALICE.userId, chatId);
const rowOf = async (h: ChatHarness, id: string) =>
  (
    await h.owner.query(
      "SELECT title_enc, title_source, scope, deleted_at FROM chat_sessions WHERE id = $1",
      [id],
    )
  ).rows[0];

describe.skipIf(!PG_URL)("PATCH, DELETE and stop (needs DOCMIND_TEST_PG_URL)", () => {
  let h: ChatHarness;
  let noKey: ChatHarness;
  beforeAll(async () => {
    h = await startChatServer();
    noKey = await startChatServer({ available: false });
  });
  afterAll(async () => {
    await Promise.all([h.close(), noKey.close()]);
  });
  const patch = (user: string, id: string, body: unknown) =>
    h.req(user, "PATCH", `/api/chats/${id}`, body);

  it("renames: the title is stored sealed as the user's, and the response shows it", async () => {
    const id = await seedChat(h, ALICE);
    const res = await patch("alice", id, { title: "  Quarterly budget review  " });
    expect(res.status).toBe(200);
    expect(ChatSessionDto.parse(await res.json()).title).toBe("Quarterly budget review");
    const row = await rowOf(h, id);
    expect(row.title_source).toBe("user");
    expect(await h.fields.forUser(U1).openText(chatTitleBind(id), row.title_enc)).toBe(
      "Quarterly budget review",
    );
    expect(row.title_enc.__loomEnc).toBeDefined();
    expect(JSON.stringify(row.title_enc)).not.toContain("Quarterly budget review");
  });

  it("a user rename is never overwritten by an automatic title", async () => {
    const id = await seedChat(h, ALICE);
    await patch("alice", id, { title: "Mine" });
    const auto = await h.fields.forUser(U1).seal(chatTitleBind(id), "Automatic");
    expect(await withTenant(h.app, T1, (tx) => setTitle(tx, U1, id, auto, "auto"))).toBe(false);
    expect(
      await h.fields.forUser(U1).openText(chatTitleBind(id), (await rowOf(h, id)).title_enc),
    ).toBe("Mine");
  });

  it("changes the scope to the caller's own documents, and back to all", async () => {
    const id = await seedChat(h, ALICE);
    const doc = await seedDoc(h.owner, h.app, h.fields, ALICE, randomBytes(32).toString("hex"), 0);
    expect(
      ChatSessionDto.parse(
        await (await patch("alice", id, { scope: { documentIds: [doc] } })).json(),
      ).scope,
    ).toEqual({ documentIds: [doc] });
    expect((await rowOf(h, id)).scope).toEqual({ documentIds: [doc] });
    expect(
      ChatSessionDto.parse(await (await patch("alice", id, { scope: "all" })).json()).scope,
    ).toBe("all");
  });

  it("stores scope ids lowercase and deduplicated", async () => {
    const id = await seedChat(h, ALICE);
    const doc = await seedDoc(h.owner, h.app, h.fields, ALICE, randomBytes(32).toString("hex"), 0);
    const res = await patch("alice", id, { scope: { documentIds: [doc.toUpperCase(), doc] } });
    expect(res.status).toBe(200);
    expect((await rowOf(h, id)).scope).toEqual({ documentIds: [doc.toLowerCase()] });
  });

  it("refuses a scope with another user's document and then changes nothing, not even a title sent with it", async () => {
    const id = await seedChat(h, ALICE);
    const theirs = await seedDoc(
      h.owner,
      h.app,
      h.fields,
      { tenantId: T1, userId: ALICE2.userId },
      randomBytes(32).toString("hex"),
      0,
    );
    const res = await patch("alice", id, {
      title: "Should not stick",
      scope: { documentIds: [theirs] },
    });
    expect([res.status, ((await res.json()) as { error: { code: string } }).error.code]).toEqual([
      400,
      "invalid_scope",
    ]);
    expect(await rowOf(h, id)).toMatchObject({
      title_enc: null,
      title_source: "none",
      scope: "all",
    });
  });

  it("answers 400 for an empty patch, an empty or over-long title and a malformed scope", async () => {
    const id = await seedChat(h, ALICE);
    for (const body of [
      {},
      { title: "   " },
      { title: "x".repeat(201) },
      { scope: { documentIds: [] } },
      { scope: "some" },
    ]) {
      expect((await patch("alice", id, body)).status).toBe(400);
    }
    expect(await rowOf(h, id)).toMatchObject({ title_enc: null, scope: "all" });
  });

  it("deletes: 204, the row is soft-deleted, a running turn is stopped, the conversation is closed, and the chat is 404 everywhere after", async () => {
    const id = await seedChat(h, ALICE);
    const stopped = vi.fn();
    h.wiring.stops.on(convOf(id), stopped);
    const res = await h.req("alice", "DELETE", `/api/chats/${id}`);
    expect(res.status).toBe(204);
    expect((await rowOf(h, id)).deleted_at).not.toBeNull();
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(h.fake.closed.has(convOf(id))).toBe(true);
    for (const [method, path] of [
      ["GET", ""],
      ["GET", "/messages"],
      ["GET", "/stream"],
      ["POST", "/stop"],
      ["PATCH", ""],
      ["DELETE", ""],
    ] as const) {
      const again = await h.req(
        "alice",
        method,
        `/api/chats/${id}${path}`,
        method === "PATCH" ? { title: "x" } : undefined,
      );
      expect([method, path, again.status]).toEqual([method, path, 404]);
    }
    expect((await h.req("alice", "POST", `/api/chats/${id}/messages`, { text: "hi" })).status).toBe(
      404,
    );
    const listed = (await (await h.req("alice", "GET", "/api/chats")).json()) as {
      items: { id: string }[];
    };
    expect(listed.items.map((c) => c.id)).not.toContain(id);
  });

  it("still answers 204 when the conversation cannot be closed, and logs the error class only", async () => {
    const id = await seedChat(h, ALICE);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    h.fake.failNextClose(new RangeError(`close of ${id} failed`));
    expect((await h.req("alice", "DELETE", `/api/chats/${id}`)).status).toBe(204);
    expect(log).toHaveBeenCalledWith("delete chat: close failed", "RangeError");
    expect(JSON.stringify(log.mock.calls)).not.toContain(id);
    log.mockRestore();
  });

  it("stop: 202 with stopped true when a turn was running, false when none was, and it works without a key", async () => {
    const id = await seedChat(h, ALICE);
    const fire = vi.fn();
    const off = h.wiring.stops.on(convOf(id), fire);
    const running = await h.req("alice", "POST", `/api/chats/${id}/stop`);
    expect([running.status, StopChatResponse.parse(await running.json())]).toEqual([
      202,
      { stopped: true },
    ]);
    expect(fire).toHaveBeenCalledTimes(1);
    off();
    const idle = await h.req("alice", "POST", `/api/chats/${id}/stop`);
    expect(StopChatResponse.parse(await idle.json())).toEqual({ stopped: false });
    const other = await seedChat(noKey, ALICE);
    expect((await noKey.req("alice", "POST", `/api/chats/${other}/stop`)).status).toBe(202);
  });

  it("answers 404 on all three routes for another user, another tenant, an unknown and a malformed id, and touches nothing", async () => {
    const id = await seedChat(h, ALICE);
    const fire = vi.fn();
    h.wiring.stops.on(convOf(id), fire);
    for (const user of ["alice2", "bob"]) {
      expect((await patch(user, id, { title: "hijack" })).status).toBe(404);
      expect((await h.req(user, "POST", `/api/chats/${id}/stop`)).status).toBe(404);
      expect((await h.req(user, "DELETE", `/api/chats/${id}`)).status).toBe(404);
    }
    for (const bad of [randomUUID(), "nope"]) {
      expect((await patch("alice", bad, { title: "x" })).status).toBe(404);
      expect((await h.req("alice", "POST", `/api/chats/${bad}/stop`)).status).toBe(404);
      expect((await h.req("alice", "DELETE", `/api/chats/${bad}`)).status).toBe(404);
    }
    expect(fire).not.toHaveBeenCalled();
    expect(await rowOf(h, id)).toMatchObject({ title_enc: null, deleted_at: null });
  });
});
