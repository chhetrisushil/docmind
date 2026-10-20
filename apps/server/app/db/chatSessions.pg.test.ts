import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { T1, T2, U1, U1B, U2 } from "../documents/testHarness";
import { type PgFixture, startPgFixture } from "../flows/ingest-document/pgFixture";
import { withTenant } from "./tenant";
import { PG_URL } from "./testSupport";

describe.skipIf(!PG_URL)("chat_sessions (0022) (needs DOCMIND_TEST_PG_URL)", () => {
  let fx: PgFixture;
  beforeAll(async () => {
    fx = await startPgFixture();
  });
  afterAll(async () => {
    await fx?.close();
  });

  const insert = (tenant: string, user: string, id: string, scope = '"all"') =>
    fx.db.owner.query(
      "INSERT INTO chat_sessions (id, tenant_id, user_id, scope) VALUES ($1, $2, $3, $4::jsonb)",
      [id, tenant, user, scope],
    );
  const asApp = (tenant: string, sql: string, values: unknown[] = []) =>
    withTenant(fx.app, tenant, (tx) => tx.query(sql, values));

  it("defaults to no title, source none, scope all, live", async () => {
    const id = randomUUID();
    await insert(T1, U1, id);
    const { rows } = await fx.db.owner.query(
      "SELECT title_enc, title_source, scope, deleted_at FROM chat_sessions WHERE id = $1",
      [id],
    );
    expect(rows[0]).toEqual({
      title_enc: null,
      title_source: "none",
      scope: "all",
      deleted_at: null,
    });
  });

  it("refuses a title without a source, a source without a title and an unknown source, by name", async () => {
    const attempts: [string, string][] = [
      [`title_enc = '{"x":1}'::jsonb`, "chat_sessions_title_pair"],
      [`title_source = 'user'`, "chat_sessions_title_pair"],
      [`title_enc = '{"x":1}'::jsonb, title_source = 'robot'`, "chat_sessions_title_source_check"],
    ];
    for (const [change, constraint] of attempts) {
      const id = randomUUID();
      await insert(T1, U1, id);
      await expect(
        fx.db.owner.query(`UPDATE chat_sessions SET ${change} WHERE id = $1`, [id]),
      ).rejects.toMatchObject({ constraint });
    }
  });

  it("refuses a scope that is neither all nor a list of 1 to 100 ids, by name", async () => {
    const tooMany = JSON.stringify({
      documentIds: Array.from({ length: 101 }, () => randomUUID()),
    });
    for (const bad of [
      '"some"',
      "[]",
      "{}",
      '{"documentIds":"x"}',
      '{"documentIds":[]}',
      tooMany,
    ]) {
      await expect(insert(T1, U1, randomUUID(), bad)).rejects.toMatchObject({
        constraint: "chat_sessions_scope_shape",
      });
    }
    await insert(T1, U1, randomUUID(), JSON.stringify({ documentIds: [randomUUID()] }));
  });

  it("refuses an owner outside the tenant, and cascades with the user", async () => {
    await expect(insert(T2, U1, randomUUID())).rejects.toMatchObject({
      constraint: "chat_sessions_owner_fkey",
    });
    const id = randomUUID();
    await insert(T2, U2, id);
    await fx.db.owner.query("DELETE FROM users WHERE id = $1", [U2]);
    const { rowCount } = await fx.db.owner.query("SELECT 1 FROM chat_sessions WHERE id = $1", [id]);
    expect(rowCount).toBe(0);
  });

  it("shows the app role only its own tenant's rows, and refuses a write into another tenant", async () => {
    const id = randomUUID();
    await insert(T1, U1B, id);
    expect((await asApp(T1, "SELECT 1 FROM chat_sessions WHERE id = $1", [id])).rowCount).toBe(1);
    expect((await asApp(T2, "SELECT 1 FROM chat_sessions WHERE id = $1", [id])).rowCount).toBe(0);
    await expect(
      asApp(T2, "INSERT INTO chat_sessions (id, tenant_id, user_id) VALUES ($1, $2, $3)", [
        randomUUID(),
        T1,
        U1,
      ]),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
