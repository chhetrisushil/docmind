import { randomUUID } from "node:crypto";
import { sealReasoningText } from "@loom/llm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../db/tenant";
import { PG_URL } from "../db/testSupport";
import { T1, T2, U1, U1B, U2 } from "../documents/testHarness";
import { type PgFixture, startPgFixture } from "../flows/ingest-document/pgFixture";
import { chatConversationId } from "./ids";
import { PgReasoningRows } from "./pgReasoningRows";
import { ChatReasoningStore } from "./reasoningStore";
import { type ChatCallScope, chatScope } from "./scope";
import { insertChat } from "./sessions";
import type { ChatRef } from "./turnItems";

const TEXT = "Weighing the Nocturne revenue forecast against the memo.";

describe.skipIf(!PG_URL)("chat reasoning texts (needs DOCMIND_TEST_PG_URL)", () => {
  let fx: PgFixture;
  let store: ChatReasoningStore;
  let chat: ChatRef; // U1's chat
  let theirs: ChatRef; // U1B's chat, same tenant
  let foreign: ChatRef; // U2's chat, another tenant
  const scopeOf = (ref: ChatRef): ChatCallScope => ({
    ...ref,
    turnKey: 1,
    stepKey: "conv#o1#turn:0",
    attempt: 1,
  });
  const put = (ref: ChatRef, text = TEXT) =>
    chatScope.run(scopeOf(ref), () =>
      store.put(sealReasoningText(text, chatConversationId(ref.userId, ref.chatId))),
    );
  const raw = async (sql: string, values: unknown[] = []) =>
    (await fx.db.owner.query(sql, values)).rows;

  beforeAll(async () => {
    fx = await startPgFixture();
    store = new ChatReasoningStore(new PgReasoningRows(fx.app), fx.fields);
    const make = async (tenantId: string, userId: string): Promise<ChatRef> => {
      const row = await withTenant(fx.app, tenantId, (tx) =>
        insertChat(tx, tenantId, userId, randomUUID(), "all"),
      );
      return { tenantId, userId, chatId: row.id };
    };
    chat = await make(T1, U1);
    theirs = await make(T1, U1B);
    foreign = await make(T2, U2);
  });
  afterAll(async () => {
    await fx?.close();
  });

  it("stores a sealed envelope and reads the same bytes back as the owner", async () => {
    const ref = await put(chat);
    const rows = await raw("SELECT text_enc FROM chat_reasoning_texts WHERE address = $1", [
      ref.__loomContent,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].text_enc.__loomEnc).toBe("loom/aes-256-gcm");
    expect(JSON.stringify(rows[0].text_enc)).not.toContain("Nocturne");
    const bytes = await store.readerFor(chat).get(ref);
    expect(new TextDecoder().decode(bytes ?? new Uint8Array())).toContain(TEXT);
  });

  it("is owner-scoped: another user of the tenant, and another tenant, read null", async () => {
    const ref = await put(chat);
    expect(await store.readerFor(theirs).get(ref)).toBeNull();
    expect(await store.readerFor({ ...chat, userId: U1B }).get(ref)).toBeNull();
    expect(await store.readerFor({ ...foreign }).get(ref)).toBeNull();
    expect(await store.readerFor({ ...chat, tenantId: T2 }).get(ref)).toBeNull();
  });

  it("hides every row from another tenant under row-level security", async () => {
    await put(chat);
    const seen = await withTenant(fx.app, T2, (tx) =>
      tx.query("SELECT count(*)::int AS n FROM chat_reasoning_texts"),
    );
    expect(seen.rows[0].n).toBe(0);
  });

  it("cannot write a row for a chat that is not the writer's own", async () => {
    // the composite foreign key (tenant, user, chat) has no such chat
    await expect(
      chatScope.run(scopeOf({ ...theirs, userId: U1 }), () =>
        store.put(sealReasoningText(TEXT, chatConversationId(U1, theirs.chatId))),
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("refuses an address that is not 32 lower-case hex digits", async () => {
    await expect(
      fx.db.owner.query(
        "INSERT INTO chat_reasoning_texts (tenant_id, user_id, chat_id, address, text_enc) VALUES ($1, $2, $3, 'NOT-HEX', '{}'::jsonb)",
        [chat.tenantId, chat.userId, chat.chatId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("goes with the chat: deleting the chat row deletes its texts", async () => {
    const mine = (await insertOwn()).ref;
    await put(mine);
    await fx.db.owner.query("DELETE FROM chat_sessions WHERE id = $1", [mine.chatId]);
    const left = await raw(
      "SELECT count(*)::int AS n FROM chat_reasoning_texts WHERE chat_id = $1",
      [mine.chatId],
    );
    expect(left[0].n).toBe(0);
  });

  async function insertOwn() {
    const row = await withTenant(fx.app, T1, (tx) => insertChat(tx, T1, U1, randomUUID(), "all"));
    return { ref: { tenantId: T1, userId: U1, chatId: row.id } as ChatRef };
  }
});
