import { runThrottleConformance } from "@docmind/auth/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword } from "../db/migrate";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";
import { PgThrottle } from "./pgThrottle";

describe.skipIf(!PG_URL)("PgThrottle (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;
  const policy = { free: 0, baseSeconds: 1, capSeconds: 1, decaySeconds: 60 };

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    app = new Pool({ connectionString: db.appUrl });
  });

  afterAll(async () => {
    await app?.end();
    await db?.drop();
  });

  // Time moves by shifting every stored timestamp back by the same amount (locked_until and
  // updated_at together), so rows that already exist age consistently and the suite never waits.
  runThrottleConformance(async () => {
    await db.owner.query("TRUNCATE auth_throttle");
    return {
      throttle: new PgThrottle(app),
      advance: async (seconds) => {
        await db.owner.query(
          `UPDATE auth_throttle SET locked_until = locked_until - make_interval(secs => $1::float8),
                                    updated_at = updated_at - make_interval(secs => $1::float8)`,
          [seconds],
        );
      },
    };
  }, "PgThrottle");

  it("purges counters that are unlocked and a day old, and only those", async () => {
    await db.owner.query("TRUNCATE auth_throttle");
    const throttle = new PgThrottle(app);
    await throttle.fail("old", policy);
    await throttle.fail("recent", policy);
    await db.owner.query(
      "UPDATE auth_throttle SET updated_at = now() - interval '2 days', locked_until = now() - interval '2 days' WHERE key = 'old'",
    );
    expect(await throttle.purge()).toBe(1);
    const { rows } = await db.owner.query("SELECT key FROM auth_throttle");
    expect(rows).toEqual([{ key: "recent" }]);
  });

  it("is a table the app role can only reach through the functions", async () => {
    await expect(app.query("SELECT * FROM auth_throttle")).rejects.toThrow(/permission denied/);
    await expect(app.query("DELETE FROM auth_throttle")).rejects.toThrow(/permission denied/);
  });
});
