import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../db/tenant";
import { PG_URL } from "../db/testSupport";
import { T1, T2, U1, U1B, U2 } from "../documents/testHarness";
import { type PgFixture, startPgFixture } from "../flows/ingest-document/pgFixture";
import { insertChat } from "./sessions";
import {
  type ChatRef,
  PgTurnItems,
  type StoredPassage,
  type TurnItem,
  chatItemBind,
  chatItemId,
} from "./turnItems";

describe.skipIf(!PG_URL)("chat turn items (needs DOCMIND_TEST_PG_URL)", () => {
  let fx: PgFixture;
  let items: PgTurnItems;
  let chat: ChatRef; // U1's chat
  let theirs: ChatRef; // U1B's chat, same tenant
  beforeAll(async () => {
    fx = await startPgFixture();
    items = new PgTurnItems(fx.app, fx.fields);
    const make = async (tenantId: string, userId: string): Promise<ChatRef> => {
      const row = await withTenant(fx.app, tenantId, (tx) =>
        insertChat(tx, tenantId, userId, randomUUID(), "all"),
      );
      return { tenantId, userId, chatId: row.id };
    };
    chat = await make(T1, U1);
    theirs = await make(T1, U1B);
  });
  afterAll(async () => {
    await fx?.close();
  });

  const raw = async (sql: string, values: unknown[] = []) =>
    (await fx.db.owner.query(sql, values)).rows;
  const passage: StoredPassage = {
    passageId: randomUUID(),
    documentId: randomUUID(),
    locator: { kind: "section", index: 1 },
    headingPath: ["Terms", "Payment"],
    snippet: "Invoices are payable within thirty days of receipt.",
  };
  const thinking = (text: string): TurnItem => ({ kind: "thinking", body: { text } });

  describe("PgTurnItems", () => {
    it("returns a turn's items in the order they were first written, and only the turns asked for", async () => {
      const tool: TurnItem = {
        kind: "tool",
        body: { name: "search_docs", label: 'Searched documents: "payment terms"', count: 2 },
      };
      await items.put(chat, 4, "s1:turn:0", thinking("Looking for the payment terms."));
      await items.put(chat, 4, "s1:tool:0", tool);
      await items.put(chat, 4, "s1:tool:0", { kind: "passages", body: { passages: [passage] } });
      await items.put(chat, 6, "s1:turn:0", {
        kind: "outcome",
        body: { kind: "refusal", details: { category: "x" } },
      });
      const got = await items.forTurns(chat, [4, 5]);
      expect([...got.keys()]).toEqual([4]);
      expect(got.get(4)?.map((i) => i.kind)).toEqual(["thinking", "tool", "passages"]);
      expect(got.get(4)?.[1]).toEqual(tool);
      expect(got.get(4)?.[2]).toEqual({ kind: "passages", body: { passages: [passage] } });
      expect((await items.forTurns(chat, [6])).get(6)).toEqual([
        { kind: "outcome", body: { kind: "refusal", details: { category: "x" } } },
      ]);
      expect((await items.forTurns(chat, [])).size).toBe(0);
    });

    it("rewrites a retried attempt's item in place, keeping its position", async () => {
      await items.put(chat, 10, "a:turn:0", thinking("first attempt"));
      await items.put(chat, 10, "a:tool:0", {
        kind: "tool",
        body: { name: "related", label: "Followed links", count: 1 },
      });
      await items.put(chat, 10, "a:turn:0", thinking("second attempt"));
      const got = (await items.forTurns(chat, [10])).get(10);
      expect(got?.map((i) => i.kind)).toEqual(["thinking", "tool"]);
      expect(got?.[0]).toEqual(thinking("second attempt"));
      const rows = await raw(
        "SELECT count(*)::int AS n FROM chat_turn_items WHERE chat_id = $1 AND ord = 10",
        [chat.chatId],
      );
      expect(rows[0].n).toBe(2);
    });

    it("keeps two step keys of one kind apart", async () => {
      await items.put(chat, 11, "step1", thinking("one"));
      await items.put(chat, 11, "step2", thinking("two"));
      expect((await items.forTurns(chat, [11])).get(11)).toEqual([
        thinking("one"),
        thinking("two"),
      ]);
    });

    it("seals the body: the raw column is an envelope that opens under its bind and no other", async () => {
      const text = "Reading the payment clause in the supplier contract.";
      await items.put(chat, 12, "seal", thinking(text));
      const [row] = await raw(
        "SELECT id, body_enc FROM chat_turn_items WHERE chat_id = $1 AND ord = 12",
        [chat.chatId],
      );
      expect(row.id).toBe(chatItemId(chat.chatId, 12, "thinking", "seal"));
      expect(row.body_enc.__loomEnc).toBe("loom/aes-256-gcm");
      expect(JSON.stringify(row.body_enc)).not.toContain(text);
      const cipher = fx.fields.forUser(U1);
      expect(await cipher.open(chatItemBind(row.id), row.body_enc)).toEqual({ text });
      await expect(cipher.open(chatItemBind(randomUUID()), row.body_enc)).rejects.toThrow(
        /authenticate/,
      );
    });

    it("never shows or accepts another owner's chat: same tenant, another tenant", async () => {
      await items.put(theirs, 4, "s1:turn:0", thinking("not yours"));
      expect((await items.forTurns({ ...theirs, userId: U1 }, [4])).size).toBe(0); // read as the wrong owner
      await expect(
        items.put({ ...theirs, userId: U1 }, 4, "x", thinking("x")),
      ).rejects.toMatchObject({
        constraint: "chat_turn_items_chat_fkey",
      });
      await expect(
        items.put({ ...chat, tenantId: T2, userId: U2 }, 4, "x", thinking("x")),
      ).rejects.toMatchObject({
        constraint: "chat_turn_items_chat_fkey",
      });
      expect((await items.forTurns({ ...chat, tenantId: T2, userId: U2 }, [4])).size).toBe(0);
    });

    it("refuses a malformed item, a bad turn key or step key, and an oversized body, naming the rule only", async () => {
      const bad = {
        kind: "tool",
        body: { name: "browse", label: "x", count: 1 },
      } as unknown as TurnItem;
      await expect(items.put(chat, 1, "k", bad)).rejects.toThrow(
        /^the turn item has an invalid shape$/,
      );
      await expect(items.put(chat, -1, "k", thinking("x"))).rejects.toThrow(
        /^turn item: turn key must be a non-negative integer$/,
      );
      await expect(items.put(chat, 1, "", thinking("x"))).rejects.toThrow(
        /^turn item: step key has a bad length$/,
      );
      await expect(items.put(chat, 1, "k".repeat(201), thinking("x"))).rejects.toThrow(
        /^turn item: step key has a bad length$/,
      );
      await expect(items.put(chat, 1, "k", thinking("x".repeat(300 * 1024)))).rejects.toThrow(
        /^turn item: the body is too large$/,
      );
    });

    it("fails a stored item of the wrong shape with a fixed message, never the content", async () => {
      const id = chatItemId(chat.chatId, 13, "tool", "bad");
      const sealed = await fx.fields
        .forUser(U1)
        .seal(chatItemBind(id), { secret: "do not leak this text" });
      await fx.db.owner.query(
        `INSERT INTO chat_turn_items (id, tenant_id, user_id, chat_id, ord, kind, step_key, body_enc)
         VALUES ($1, $2, $3, $4, 13, 'tool', 'bad', $5::jsonb)`,
        [id, T1, U1, chat.chatId, JSON.stringify(sealed)],
      );
      await expect(items.forTurns(chat, [13])).rejects.toThrow(
        /^the stored turn item has an invalid shape$/,
      );
    });

    it("refuses an unknown kind, by constraint name", async () => {
      await expect(
        fx.db.owner.query(
          `INSERT INTO chat_turn_items (id, tenant_id, user_id, chat_id, ord, kind, step_key, body_enc)
           VALUES ($1, $2, $3, $4, 1, 'note', 'k', '{}')`,
          [randomUUID(), T1, U1, chat.chatId],
        ),
      ).rejects.toMatchObject({ constraint: "chat_turn_items_kind_check" });
    });

    it("goes with its chat: deleting the chat removes the items", async () => {
      const own = await withTenant(fx.app, T1, (tx) => insertChat(tx, T1, U1, randomUUID(), "all"));
      const ref = { tenantId: T1, userId: U1, chatId: own.id };
      await items.put(ref, 1, "k", thinking("bye"));
      await fx.db.owner.query("DELETE FROM chat_sessions WHERE id = $1", [own.id]);
      expect((await items.forTurns(ref, [1])).size).toBe(0);
      expect(await raw("SELECT 1 FROM chat_turn_items WHERE chat_id = $1", [own.id])).toHaveLength(
        0,
      );
    });
  });
});
