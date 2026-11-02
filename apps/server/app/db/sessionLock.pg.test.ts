import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgSessionLock } from "./sessionLock";
import { PG_URL, type TestDb, createTestDb } from "./testSupport";

describe.skipIf(!PG_URL)("pgSessionLock (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let pool: Pool;
  beforeAll(async () => {
    db = await createTestDb();
    pool = new Pool({ connectionString: db.loomUrl, max: 4 });
  });
  afterAll(async () => {
    await pool.end();
    await db.drop();
  });

  it("is held by one session at a time and can be taken again once released", async () => {
    const first = await pgSessionLock(pool, "test:one", "test lock");
    expect(first).not.toBeNull();
    expect(await pgSessionLock(pool, "test:one", "test lock")).toBeNull();
    // a different key is independent
    const other = await pgSessionLock(pool, "test:two", "test lock");
    expect(other).not.toBeNull();
    await other?.();
    await first?.();
    const again = await pgSessionLock(pool, "test:one", "test lock");
    expect(again).not.toBeNull();
    await again?.();
  });

  it("returns every connection to the pool, held or refused", async () => {
    const held = await pgSessionLock(pool, "test:pool", "test lock");
    await pgSessionLock(pool, "test:pool", "test lock"); // refused: its connection goes straight back
    await held?.();
    expect(pool.totalCount - pool.idleCount).toBe(0);
  });

  it("reports a lock whose connection died as lost", async () => {
    const held = await pgSessionLock(pool, "test:lost", "test lock");
    expect(held?.lost?.aborted).toBe(false);
    const owner = new Pool({ connectionString: db.loomUrl, max: 1 });
    try {
      await owner.query(
        "SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory' AND objid = (hashtextextended('test:lost', 0) & 4294967295)::oid AND pid <> pg_backend_pid()",
      );
    } finally {
      await owner.end();
    }
    await expect.poll(() => held?.lost?.aborted, { timeout: 5_000 }).toBe(true);
    await held?.(); // releasing a lost lock is a no-op, never a throw
  });
});
