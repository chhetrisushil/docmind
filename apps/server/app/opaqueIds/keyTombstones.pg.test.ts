import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword } from "../db/migrate";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";

const EPOCH = "1970-01-01T00:00:00.000Z";
const H = `h_${"a".repeat(26)}`;
const USER = "11111111-1111-4111-8111-111111111111";

describe.skipIf(!PG_URL)("data_keys tombstones of h_ subjects (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
  });
  afterAll(async () => {
    await db?.drop();
  });
  const times = async (subject: string) =>
    (
      await db.owner.query("SELECT created_at, destroyed_at FROM data_keys WHERE subject_id = $1", [
        subject,
      ])
    ).rows[0] as { created_at: Date; destroyed_at: Date };

  it("an h_ tombstone carries a fixed instant, so it cannot be paired with the user's by time", async () => {
    await db.owner.query("SELECT * FROM key_put($1, $2, 'k')", [H, Buffer.from("x")]);
    await db.owner.query("SELECT * FROM key_put($1, $2, 'k')", [USER, Buffer.from("y")]);
    await db.owner.query("SELECT key_destroy($1)", [H]);
    await db.owner.query("SELECT key_destroy($1)", [USER]);
    const h = await times(H);
    expect(h.created_at.toISOString()).toBe(EPOCH);
    expect(h.destroyed_at.toISOString()).toBe(EPOCH);
    expect((await times(USER)).destroyed_at.getTime()).toBeGreaterThan(0); // the user's own is unchanged
    expect((await db.owner.query("SELECT key_was_destroyed($1) AS d", [H])).rows[0].d).toBe(true);
    // a never-seen h_ subject is tombstoned the same way
    const other = `h_${"e".repeat(26)}`;
    await db.owner.query("SELECT key_destroy($1)", [other]);
    expect((await times(other)).created_at.toISOString()).toBe(EPOCH);
    await db.owner.query("SELECT key_destroy($1)", [other]); // idempotent
    expect((await times(other)).destroyed_at.toISOString()).toBe(EPOCH);
  });
});
