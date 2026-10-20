import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../db/tenant";
import { PG_URL } from "../db/testSupport";
import { T1, T2, U1, U1B, U2 } from "../documents/testHarness";
import { type PgFixture, startPgFixture } from "../flows/ingest-document/pgFixture";
import { insertChat } from "./sessions";
import { type ChatRef, PgReasoningBlocks, type ReasoningBlock, chatBlocksBind } from "./turnItems";

describe.skipIf(!PG_URL)("chat reasoning blocks (needs DOCMIND_TEST_PG_URL)", () => {
  let fx: PgFixture;
  let blocks: PgReasoningBlocks;
  let chat: ChatRef; // U1's chat
  let theirs: ChatRef; // U1B's chat, same tenant
  beforeAll(async () => {
    fx = await startPgFixture();
    blocks = new PgReasoningBlocks(fx.app, fx.fields);
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

  describe("PgReasoningBlocks", () => {
    const block = (n: number): ReasoningBlock => ({
      type: "thinking",
      thinking: `summary ${n}`,
      signature: `sig-${n}`,
    });
    const redacted: ReasoningBlock = { type: "redacted_thinking", data: "opaque-bytes" };

    it("returns the blocks stored for a tool_use id, verbatim, and none for an unknown id", async () => {
      await blocks.put(chat, ["toolu_a"], [block(1), redacted]);
      expect(await blocks.get(chat, ["toolu_a"])).toEqual([block(1), redacted]);
      expect(await blocks.get(chat, ["toolu_unknown"])).toEqual([]);
      expect(await blocks.get(chat, [])).toEqual([]);
    });

    it("stores a response's full ordered content under each of its tool_use ids and returns that list once, in id order", async () => {
      await blocks.put(chat, ["toolu_b1", "toolu_b2"], [block(2)]);
      await blocks.put(chat, ["toolu_c"], [block(3)]);
      expect(await blocks.get(chat, ["toolu_b1", "toolu_b2"])).toEqual([block(2)]);
      expect(await blocks.get(chat, ["toolu_c", "toolu_b2", "toolu_c"])).toEqual([
        block(3),
        block(2),
      ]);
    });

    it("keeps thinking, text and tool_use blocks in the order they were stored", async () => {
      const full: ReasoningBlock[] = [
        block(8),
        { type: "tool_use", id: "toolu_g", name: "search_docs", input: { query: "x" } },
        block(9),
        { type: "text", text: "between" },
        { type: "tool_use", id: "toolu_h", name: "related", input: {} },
      ];
      await blocks.put(chat, ["toolu_g", "toolu_h"], full);
      expect(await blocks.get(chat, ["toolu_g", "toolu_h"])).toEqual(full);
      expect(await blocks.get(chat, ["toolu_h"])).toEqual(full);
    });

    it("stores nothing for a response without tool_use ids", async () => {
      const before = await raw(
        "SELECT count(*)::int AS n FROM chat_reasoning_blocks WHERE chat_id = $1",
        [chat.chatId],
      );
      await blocks.put(chat, [], [block(10)]);
      const after = await raw(
        "SELECT count(*)::int AS n FROM chat_reasoning_blocks WHERE chat_id = $1",
        [chat.chatId],
      );
      expect(after[0].n).toBe(before[0].n);
    });

    it("replaces the blocks of an id a retried call stored again", async () => {
      await blocks.put(chat, ["toolu_d"], [block(4)]);
      await blocks.put(chat, ["toolu_d"], [block(5)]);
      expect(await blocks.get(chat, ["toolu_d"])).toEqual([block(5)]);
    });

    it("seals the blocks under a bind of the chat and the id", async () => {
      await blocks.put(
        chat,
        ["toolu_seal"],
        [{ type: "thinking", thinking: "private reasoning text", signature: "s" }],
      );
      const [row] = await raw(
        "SELECT blocks_enc FROM chat_reasoning_blocks WHERE chat_id = $1 AND tool_use_id = 'toolu_seal'",
        [chat.chatId],
      );
      expect(row.blocks_enc.__loomEnc).toBe("loom/aes-256-gcm");
      expect(JSON.stringify(row.blocks_enc)).not.toContain("private reasoning text");
      const cipher = fx.fields.forUser(U1);
      expect(
        await cipher.open(chatBlocksBind(chat.chatId, "toolu_seal"), row.blocks_enc),
      ).toMatchObject({ blocks: [{ signature: "s" }] });
      await expect(
        cipher.open(chatBlocksBind(chat.chatId, "toolu_other"), row.blocks_enc),
      ).rejects.toThrow(/authenticate/);
    });

    it("is owner-scoped: another user's chat, or the wrong owner, reads and writes nothing", async () => {
      await blocks.put(theirs, ["toolu_e"], [block(6)]);
      expect(await blocks.get({ ...theirs, userId: U1 }, ["toolu_e"])).toEqual([]);
      expect(await blocks.get(chat, ["toolu_e"])).toEqual([]);
      await expect(
        blocks.put({ ...theirs, userId: U1 }, ["toolu_f"], [block(7)]),
      ).rejects.toMatchObject({
        constraint: "chat_reasoning_blocks_chat_fkey",
      });
    });

    it("refuses to overwrite another owner's existing tool_use id, and leaves it intact", async () => {
      await blocks.put(theirs, ["toolu_dup"], [block(11)]);
      await expect(
        blocks.put({ ...theirs, userId: U1 }, ["toolu_dup"], [block(12)]),
      ).rejects.toMatchObject({ constraint: "chat_reasoning_blocks_chat_fkey" });
      expect(await blocks.get(theirs, ["toolu_dup"])).toEqual([block(11)]);
    });

    it("counts the size cap in bytes", async () => {
      await expect(
        blocks.put(chat, ["t"], [{ type: "text", text: "€".repeat(100 * 1024) }]),
      ).rejects.toThrow(/^reasoning blocks: too large$/);
    });

    it("refuses bad ids, malformed or oversized blocks, and a stored value of the wrong shape, naming the rule only", async () => {
      await expect(blocks.put(chat, [""], [block(1)])).rejects.toThrow(
        /^reasoning blocks: bad tool use ids$/,
      );
      await expect(blocks.put(chat, ["x".repeat(201)], [block(1)])).rejects.toThrow(
        /^reasoning blocks: bad tool use ids$/,
      );
      await expect(
        blocks.put(chat, ["t"], [{ thinking: "no type" } as unknown as ReasoningBlock]),
      ).rejects.toThrow(/^the reasoning blocks have an invalid shape$/);
      await expect(
        blocks.put(chat, ["t"], [{ type: "thinking", thinking: "x".repeat(300 * 1024) }]),
      ).rejects.toThrow(/^reasoning blocks: too large$/);
      await blocks.put(chat, [], [block(1)]);
      await blocks.put(chat, ["t"], []);
      const sealed = await fx.fields
        .forUser(U1)
        .seal(chatBlocksBind(chat.chatId, "toolu_bad"), { blocks: "nope" });
      await fx.db.owner.query(
        `INSERT INTO chat_reasoning_blocks (tenant_id, user_id, chat_id, tool_use_id, blocks_enc) VALUES ($1, $2, $3, 'toolu_bad', $4::jsonb)`,
        [T1, U1, chat.chatId, JSON.stringify(sealed)],
      );
      await expect(blocks.get(chat, ["toolu_bad"])).rejects.toThrow(
        /^the stored reasoning blocks have an invalid shape$/,
      );
    });
  });
});
