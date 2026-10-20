import { randomUUID } from "node:crypto";
import { ListChatsResponse } from "@docmind/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PG_URL } from "../db/testSupport";
import { decodeCursor } from "../documents/cursor";
import { ALICE, ALICE2, BOB, T1 } from "../documents/testHarness";
import { listChatsPage } from "./routes";
import { type ChatHarness, seedChat, seedManyChats, startChatServer } from "./testHarness";

const raw = (h: ChatHarness, user: string, query = "") => h.req(user, "GET", `/api/chats${query}`);
const get = async (h: ChatHarness, user: string, query = "") => {
  const res = await raw(h, user, query);
  expect(res.status).toBe(200);
  return { body: ListChatsResponse.parse(await res.json()) };
};

describe.skipIf(!PG_URL)("GET /api/chats (needs DOCMIND_TEST_PG_URL)", () => {
  let h: ChatHarness;
  beforeAll(async () => {
    h = await startChatServer();
  });
  afterAll(async () => {
    await h.close();
  });

  it("lists the caller's chats newest activity first: a chat with recent messages beats a newer empty one", async () => {
    const old = await seedChat(h, ALICE2, {
      ageSeconds: 5000,
      messages: 2,
      lastAt: new Date().toISOString(),
    });
    const fresh = await seedChat(h, ALICE2, { ageSeconds: 100 });
    const stale = await seedChat(h, ALICE2, {
      ageSeconds: 9000,
      messages: 2,
      lastAt: "2020-01-01T00:00:00.000Z",
    });
    const { body } = await get(h, "alice2");
    expect(body.items.map((c) => c.id)).toEqual([old, fresh, stale]);
    expect(body.items[0]).toMatchObject({ messageCount: 2 });
    expect(body.nextCursor).toBeNull();
  });

  it("never shows another user's, another tenant's or a deleted chat", async () => {
    const mine = await seedChat(h, ALICE, {});
    await seedChat(h, ALICE2, {});
    await seedChat(h, BOB, {});
    const gone = await seedChat(h, ALICE, {});
    await h.owner.query("UPDATE chat_sessions SET deleted_at = now() WHERE id = $1", [gone]);
    const ids = (await get(h, "alice")).body.items.map((c) => c.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(gone);
    expect(
      (
        await h.owner.query(
          "SELECT count(*)::int AS n FROM chat_sessions WHERE user_id = $1 AND deleted_at IS NULL",
          [ALICE.userId],
        )
      ).rows[0].n,
    ).toBe(ids.length);
  });

  it("pages at 50 with an opaque cursor, once each, in a stable order", async () => {
    const who = { tenantId: BOB.tenantId, userId: BOB.userId };
    await seedManyChats(h.owner, who, 55);
    const first = await get(h, "bob");
    expect(first.body.items).toHaveLength(50);
    expect(first.body.nextCursor).not.toBeNull();
    const second = await get(
      h,
      "bob",
      `?cursor=${encodeURIComponent(first.body.nextCursor as string)}`,
    );
    expect(second.body.items.length).toBeGreaterThanOrEqual(5);
    expect(second.body.nextCursor).toBeNull();
    const all = [...first.body.items, ...second.body.items].map((c) => c.id);
    expect(new Set(all).size).toBe(all.length);
  });

  it("answers 400 invalid_cursor for a cursor that is not one, and 400 for a query that is not valid", async () => {
    const bad = await raw(h, "alice", "?cursor=AAAA");
    expect([bad.status, await bad.json()]).toEqual([
      400,
      { error: { code: "invalid_cursor", message: "cursor is not valid" } },
    ]);
    expect((await raw(h, "alice", `?q=${"x".repeat(201)}`)).status).toBe(400);
  });

  it("filters by title after decryption, case-insensitively, and skips untitled chats", async () => {
    const mine = { tenantId: ALICE2.tenantId, userId: ALICE2.userId };
    await seedChat(h, mine, { title: "Q3 budget review" });
    await seedChat(h, mine, { title: "Holiday plans" });
    await seedChat(h, mine, { title: "BUDGET 2027" });
    await seedChat(h, mine, {});
    const { body } = await get(h, "alice2", "?q=budget");
    expect(body.items.map((c) => c.title).sort()).toEqual(["BUDGET 2027", "Q3 budget review"]);
    expect((await get(h, "alice2", "?q=nothing-like-this")).body.items).toEqual([]);
  });

  it("finds a match among hundreds of newer chats, and stops scanning at the cap with a cursor to continue", async () => {
    const who = { tenantId: T1, userId: randomUUID() };
    await h.owner.query(
      "INSERT INTO users (id, tenant_id, email, password_hash) VALUES ($1, $2, $3, 'x')",
      [who.userId, who.tenantId, `${who.userId}@example.com`],
    );
    await seedManyChats(h.owner, who, 2100);
    const oldest = (
      await h.owner.query(
        "SELECT id FROM chat_sessions WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1",
        [who.userId],
      )
    ).rows[0].id as string;
    const enc = await h.fields
      .forUser(who.userId)
      .seal(`chat:${oldest}:title`, "needle in the haystack");
    await h.owner.query(
      "UPDATE chat_sessions SET title_enc = $2::jsonb, title_source = 'user' WHERE id = $1",
      [oldest, JSON.stringify(enc)],
    );
    // This user has no harness header, so read through the page function the route calls.
    const page1 = await listChatsPage(h.deps, who, null, "needle");
    expect(page1.items).toEqual([]); // the cap (2000) is reached before the oldest of 2100
    expect(page1.next).not.toBeNull();
    const page2 = await listChatsPage(h.deps, who, decodeCursor(page1.next as string), "needle");
    expect(page2.items.map((c) => c.id)).toEqual([oldest]);
    expect(page2.next).toBeNull();
  });
});
