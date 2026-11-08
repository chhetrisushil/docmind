import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { insertChat } from "../../chats/sessions";
import { withTenant } from "../../db/tenant";
import { PG_URL } from "../../db/testSupport";
import { T1, T2, U1, U1B, U2 } from "../../documents/testHarness";
import { type PgFixture, startPgFixture } from "../ingest-document/pgFixture";
import type { Fact } from "../visualize-document/facts";
import type { TurnRef } from "./ids";
import { PgTurnVisualFacts } from "./pgTurnFacts";

describe.skipIf(!PG_URL)("PgTurnVisualFacts (needs DOCMIND_TEST_PG_URL)", () => {
  let fx: PgFixture;
  let store: PgTurnVisualFacts;
  beforeAll(async () => {
    fx = await startPgFixture();
    store = new PgTurnVisualFacts(fx.app, fx.fields);
  });
  afterAll(async () => {
    await fx?.close();
  });

  const chatOf = async (tenantId: string, userId: string): Promise<TurnRef> => {
    const row = await withTenant(fx.app, tenantId, (tx) =>
      insertChat(tx, tenantId, userId, randomUUID(), "all"),
    );
    return { tenantId, userId, chatId: row.id, ord: 2 };
  };
  const fig = (ordinal: number, label = "Revenue"): Fact => ({
    kind: "figure",
    label,
    value: 1200,
    chunkIds: [randomUUID()],
    ordinal,
  });
  const count = async (chatId: string) =>
    (
      await fx.db.owner.query(
        "SELECT count(*)::int AS n FROM turn_visual_facts WHERE chat_id = $1",
        [chatId],
      )
    ).rows[0].n as number;

  it("round-trips sealed facts in ordinal order and replaces the turn's rows in one transaction", async () => {
    const ref = await chatOf(T1, U1);
    expect(await store.replace(ref, [fig(1), fig(0)])).toBe(2);
    expect((await store.list(ref)).map((f) => f.ordinal)).toEqual([0, 1]);
    await store.replace(ref, [fig(0, "Margin")]);
    const after = await store.list(ref);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ label: "Margin" });
    // another turn of the same chat is untouched by a replace
    await store.replace({ ...ref, ord: 4 }, [fig(0)]);
    await store.replace(ref, []);
    expect(await store.list(ref)).toEqual([]);
    expect(await store.list({ ...ref, ord: 4 })).toHaveLength(1);
  });

  it("stores no plaintext label", async () => {
    const ref = await chatOf(T1, U1);
    await store.replace(ref, [fig(0, "Zebra-Quarterly-Takings")]);
    const raw = await fx.db.owner.query(
      "SELECT fact_enc::text AS t FROM turn_visual_facts WHERE chat_id = $1",
      [ref.chatId],
    );
    expect(raw.rows.map((r) => r.t).join()).not.toContain("Zebra-Quarterly-Takings");
  });

  it("is invisible to another tenant and another user, and refuses a write for a chat that is not the caller's", async () => {
    const ref = await chatOf(T1, U1);
    await store.replace(ref, [fig(0)]);
    const other = await withTenant(fx.app, T2, (tx) =>
      tx.query("SELECT 1 FROM turn_visual_facts WHERE chat_id = $1", [ref.chatId]),
    );
    expect(other.rows).toEqual([]);
    expect(await store.list({ ...ref, userId: U1B })).toEqual([]);
    await expect(store.replace({ ...ref, userId: U1B }, [fig(0)])).rejects.toThrow();
    expect(await count(ref.chatId)).toBe(1);
  });

  it("refuses a write under another tenant for a chat of tenant T1, and leaves the rows as they were", async () => {
    const ref = await chatOf(T1, U1);
    await store.replace(ref, [fig(0, "Mine")]);
    await expect(store.replace({ ...ref, tenantId: T2 }, [fig(0, "Theirs")])).rejects.toThrow();
    expect(await store.list({ ...ref, tenantId: T2 })).toEqual([]);
    expect((await store.list(ref)).map((f) => (f as { label: string }).label)).toEqual(["Mine"]);
    expect(await count(ref.chatId)).toBe(1);
  });

  it("an already-aborted signal seals nothing and writes nothing (not even the delete)", async () => {
    const ref = await chatOf(T1, U1);
    await store.replace(ref, [fig(0)]);
    const forUser = vi.spyOn(fx.fields, "forUser");
    try {
      const ac = new AbortController();
      ac.abort();
      await expect(store.replace(ref, [fig(0), fig(1)], ac.signal)).rejects.toMatchObject({
        name: "ParseAbortedError",
      });
      expect(forUser).not.toHaveBeenCalled();
      expect(await count(ref.chatId)).toBe(1); // the earlier row was not deleted
    } finally {
      forUser.mockRestore();
    }
  });

  it("an abort that lands while sealing opens no transaction", async () => {
    const ref = await chatOf(T1, U1);
    await store.replace(ref, [fig(0)]);
    const ac = new AbortController();
    const real = fx.fields.forUser.bind(fx.fields);
    const forUser = vi.spyOn(fx.fields, "forUser").mockImplementation((u: string) => {
      const c = real(u);
      return {
        ...c,
        seal: async (...a: Parameters<typeof c.seal>) => {
          ac.abort();
          return c.seal(...a);
        },
      } as ReturnType<typeof real>;
    });
    try {
      await expect(store.replace(ref, [fig(0), fig(1)], ac.signal)).rejects.toMatchObject({
        name: "ParseAbortedError",
      });
      expect(await count(ref.chatId)).toBe(1);
    } finally {
      forUser.mockRestore();
    }
  });

  it("goes with the chat row (cascade) and is unreadable once the user's key is destroyed (erasure)", async () => {
    const ref = await chatOf(T1, U1);
    await store.replace(ref, [fig(0)]);
    await fx.db.owner.query("DELETE FROM chat_sessions WHERE id = $1", [ref.chatId]);
    expect(await count(ref.chatId)).toBe(0);

    // U2 (tenant T2): destroying its key must not affect the other cases, which run as U1.
    const kept = await chatOf(T2, U2);
    await store.replace(kept, [fig(0)]);
    await fx.keys.destroy(U2);
    await expect(store.list(kept)).rejects.toThrow();
  });

  it("rolls back a replace whose attempt was aborted", async () => {
    const ref = await chatOf(T1, U1);
    await store.replace(ref, [fig(0)]);
    const ac = new AbortController();
    ac.abort();
    await expect(store.replace(ref, [fig(0), fig(1)], ac.signal)).rejects.toMatchObject({
      name: "ParseAbortedError",
    });
    expect(await count(ref.chatId)).toBe(1);
  });

  it("docmind_chat_tenant answers for a live chat only", async () => {
    const live = await chatOf(T1, U1);
    const ask = async (chatId: string, userId: string) =>
      (
        await fx.app.query("SELECT public.docmind_chat_tenant($1::uuid, $2::uuid) AS t", [
          chatId,
          userId,
        ])
      ).rows[0]?.t as string | null | undefined;
    expect(await ask(live.chatId, U1)).toBe(T1);
    expect(await ask(live.chatId, U2)).toBeFalsy(); // the right chat, another user
    expect(await ask(randomUUID(), U1)).toBeFalsy(); // unknown chat
    await fx.db.owner.query("UPDATE chat_sessions SET deleted_at = now() WHERE id = $1", [
      live.chatId,
    ]);
    expect(await ask(live.chatId, U1)).toBeFalsy(); // soft-deleted

    // erasing_at is final (0024), so the erasure case uses a user of its own.
    const doomed = randomUUID();
    await fx.db.owner.query(
      "INSERT INTO users (id, tenant_id, email, password_hash) VALUES ($1, $2, $3, 'x')",
      [doomed, T1, `${doomed}@example.com`],
    );
    const theirs = await chatOf(T1, doomed);
    expect(await ask(theirs.chatId, doomed)).toBe(T1);
    await fx.db.owner.query("UPDATE users SET erasing_at = now() WHERE id = $1", [doomed]);
    expect(await ask(theirs.chatId, doomed)).toBeFalsy(); // owner being erased
  });
});
