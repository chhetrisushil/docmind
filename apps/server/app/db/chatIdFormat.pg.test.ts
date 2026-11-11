import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { T1, U1 } from "../documents/testHarness";
import { type PgFixture, startPgFixture } from "../flows/ingest-document/pgFixture";
import { PG_URL } from "./testSupport";

describe.skipIf(!PG_URL)("chat_sessions.id_format (0039) (needs DOCMIND_TEST_PG_URL)", () => {
  let fx: PgFixture;
  beforeAll(async () => {
    fx = await startPgFixture();
  });
  afterAll(async () => {
    await fx?.close();
  });

  it("is legacy for a row inserted without it (every chat that existed before 0039, and an old pod's insert)", async () => {
    const id = randomUUID();
    await fx.db.owner.query(
      "INSERT INTO chat_sessions (id, tenant_id, user_id) VALUES ($1, $2, $3)",
      [id, T1, U1],
    );
    const { rows } = await fx.db.owner.query("SELECT id_format FROM chat_sessions WHERE id = $1", [
      id,
    ]);
    expect(rows[0]).toEqual({ id_format: "legacy" });
  });

  it("accepts opaque and refuses any other value, by constraint name", async () => {
    const insert = (format: string) =>
      fx.db.owner.query(
        "INSERT INTO chat_sessions (id, tenant_id, user_id, id_format) VALUES ($1, $2, $3, $4)",
        [randomUUID(), T1, U1, format],
      );
    await insert("opaque");
    await expect(insert("h_")).rejects.toThrow(/chat_sessions_id_format_check/);
    await expect(insert("")).rejects.toThrow(/chat_sessions_id_format_check/);
  });

  it("cannot be null", async () => {
    await expect(
      fx.db.owner.query(
        "INSERT INTO chat_sessions (id, tenant_id, user_id, id_format) VALUES ($1, $2, $3, NULL)",
        [randomUUID(), T1, U1],
      ),
    ).rejects.toThrow(/null value in column "id_format"/);
  });
});
