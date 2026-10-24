import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PG_URL, ROLE_LOCK_KEY, assertSeparateCluster, withRoleLock } from "./testSupport";

describe.skipIf(!PG_URL)("withRoleLock (needs DOCMIND_TEST_PG_URL)", () => {
  it("keeps the lock while the pool reaps its idle clients, and releases it afterwards", async () => {
    const pool = new Pool({ connectionString: PG_URL, max: 2, idleTimeoutMillis: 20 });
    const probe = new Pool({ connectionString: PG_URL, max: 1 });
    const free = async () =>
      (await probe.query("SELECT pg_try_advisory_lock($1) AS got", [ROLE_LOCK_KEY])).rows[0].got;
    try {
      await withRoleLock(async () => {
        // A second client goes idle and is reaped by the short timeout while the lock client is held.
        const reaped = new Promise<void>((resolve) => pool.once("remove", () => resolve()));
        (await pool.connect()).release();
        await reaped;
        expect(await free()).toBe(false); // still held
      }, pool);
      expect(await free()).toBe(true); // released: the probe could take it
    } finally {
      await probe.query("SELECT pg_advisory_unlock_all()");
      await probe.end();
      await pool.end();
    }
  });
});

describe("assertSeparateCluster", () => {
  const app = "postgres://docmind_app:x@127.0.0.1:55432/docmind_dev";
  it("refuses the app's own cluster: the suites reset cluster-wide role passwords", () => {
    expect(() =>
      assertSeparateCluster("postgres://docmind:y@127.0.0.1:55432/postgres", app),
    ).toThrow(/DOCMIND_TEST_PG_URL must not point at the cluster in DATABASE_URL/);
    expect(() =>
      assertSeparateCluster("postgres://docmind:y@localhost:55432/postgres", app),
    ).toThrow();
  });
  it("allows another cluster, or no DATABASE_URL at all (CI)", () => {
    expect(() =>
      assertSeparateCluster("postgres://docmind:y@127.0.0.1:55433/postgres", app),
    ).not.toThrow();
    expect(() =>
      assertSeparateCluster("postgres://docmind:y@127.0.0.1:55432/postgres", undefined),
    ).not.toThrow();
  });
  it("never puts a password in its message", () => {
    expect(() => assertSeparateCluster("postgres://docmind:secret@127.0.0.1:55432/p", app)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("secret") }),
    );
  });
});
