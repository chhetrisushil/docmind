import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertChat, softDeleteChat } from "../../chats/sessions";
import { withTenant } from "../../db/tenant";
import { PG_URL } from "../../db/testSupport";
import { T1, U1, U1B } from "../../documents/testHarness";
import { DocumentGoneError } from "../ingest-document/errors";
import { type PgFixture, startPgFixture } from "../ingest-document/pgFixture";
import { PgTurnGuard } from "./guard";

describe.skipIf(!PG_URL)("PgTurnGuard (needs DOCMIND_TEST_PG_URL)", () => {
  let fx: PgFixture;
  beforeAll(async () => {
    fx = await startPgFixture();
  });
  afterAll(async () => {
    await fx?.close();
  });
  const chat = async () =>
    (await withTenant(fx.app, T1, (tx) => insertChat(tx, T1, U1, randomUUID(), "all"))).id;

  it("lets a live chat of its owner through", async () => {
    const chatId = await chat();
    await expect(
      new PgTurnGuard(fx.app).begin({ tenantId: T1, userId: U1, chatId, ord: 2 }, "turn-load"),
    ).resolves.toBeUndefined();
  });
  it("refuses a foreign, soft-deleted, unknown or erasing owner's chat as 'gone'", async () => {
    const guard = new PgTurnGuard(fx.app);
    const chatId = await chat();
    await expect(
      guard.begin({ tenantId: T1, userId: U1B, chatId, ord: 2 }, "s"),
    ).rejects.toBeInstanceOf(DocumentGoneError);
    await expect(
      guard.begin({ tenantId: T1, userId: U1, chatId: randomUUID(), ord: 2 }, "s"),
    ).rejects.toBeInstanceOf(DocumentGoneError);
    await withTenant(fx.app, T1, (tx) => softDeleteChat(tx, U1, chatId));
    await expect(
      guard.begin({ tenantId: T1, userId: U1, chatId, ord: 2 }, "s"),
    ).rejects.toBeInstanceOf(DocumentGoneError);
    // erasing_at is final (a trigger refuses to clear it), so the erasing owner goes last, on a second user's own chat.
    const other = (
      await withTenant(fx.app, T1, (tx) => insertChat(tx, T1, U1B, randomUUID(), "all"))
    ).id;
    await fx.db.owner.query("UPDATE users SET erasing_at = now() WHERE id = $1", [U1B]);
    await expect(
      guard.begin({ tenantId: T1, userId: U1B, chatId: other, ord: 2 }, "s"),
    ).rejects.toBeInstanceOf(DocumentGoneError);
  });
});
