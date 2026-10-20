import { randomUUID } from "node:crypto";
import type { ChatScope } from "@docmind/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../db/tenant";
import { PG_URL } from "../db/testSupport";
import { T1, T2, U1, U1B, U2 } from "../documents/testHarness";
import { type PgFixture, startPgFixture } from "../flows/ingest-document/pgFixture";
import { getChat, insertChat, softDeleteChat } from "./sessions";

describe.skipIf(!PG_URL)("chat_sessions repo (needs DOCMIND_TEST_PG_URL)", () => {
  let fx: PgFixture;
  beforeAll(async () => {
    fx = await startPgFixture();
  });
  afterAll(async () => {
    await fx?.close();
  });

  const as = <T>(tenant: string, fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(fx.app, tenant, fn);
  const make = (user = U1, scope: ChatScope = "all", tenant = T1) =>
    as(tenant, (tx) => insertChat(tx, tenant, user, randomUUID(), scope));
  it("inserts a live chat with no title and reads it back, scope included", async () => {
    const scope = { documentIds: [randomUUID(), randomUUID()] };
    const row = await make(U1, scope);
    expect(row).toMatchObject({ title_enc: null, title_source: "none", scope, deleted_at: null });
    expect(await as(T1, (tx) => getChat(tx, U1, row.id))).toEqual(row);
    expect((await make()).scope).toBe("all");
  });

  it("hides a chat from anyone but its owner: another user, another tenant, a deleted chat", async () => {
    const row = await make(U1);
    expect(await as(T1, (tx) => getChat(tx, U1B, row.id))).toBeNull();
    expect(await as(T2, (tx) => getChat(tx, U2, row.id))).toBeNull();
    expect(await as(T1, (tx) => softDeleteChat(tx, U1B, row.id))).toBe(false);
    expect(await as(T1, (tx) => softDeleteChat(tx, U1, row.id))).toBe(true);
    expect(await as(T1, (tx) => softDeleteChat(tx, U1, row.id))).toBe(false);
    expect(await as(T1, (tx) => getChat(tx, U1, row.id))).toBeNull();
    const raw = await fx.db.owner.query("SELECT deleted_at FROM chat_sessions WHERE id = $1", [
      row.id,
    ]);
    expect(raw.rows[0].deleted_at).toBeInstanceOf(Date); // the row stays until erasure (D15)
  });

  it("refuses a corrupt scope with a fixed message", async () => {
    const row = await make();
    // The CHECK admits any list of 1..100 values; the repo validates them as uuids on the way out.
    await fx.db.owner.query(
      `UPDATE chat_sessions SET scope = '{"documentIds":["not-a-uuid"]}' WHERE id = $1`,
      [row.id],
    );
    await expect(as(T1, (tx) => getChat(tx, U1, row.id))).rejects.toThrow(
      /^chat_sessions\.scope is invalid$/,
    );
    await fx.db.owner.query("DELETE FROM chat_sessions WHERE id = $1", [row.id]);
  });
});
