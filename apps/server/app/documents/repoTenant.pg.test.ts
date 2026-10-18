import { InMemoryKeyStore } from "@loom/plugin-crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FieldCrypto } from "../crypto/fields";
import { migrate, setAppRolePassword } from "../db/migrate";
import { withTenant } from "../db/tenant";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";
import { insertDocument, lockTenantForWrite, usageOfTenant } from "./repo";
import { T1, T2, U1, U1B, U2, newDocument, seedUsers } from "./testHarness";

const FP = (c: string) => c.repeat(64);

// The same key lockTenantForWrite takes, so a second connection can probe it without blocking.
async function tryLock(tx: PoolClient, tenantId: string): Promise<boolean> {
  const { rows } = await tx.query<{ got: boolean }>(
    "SELECT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended($1, 0)) AS got",
    [`docmind:documents:${tenantId}`],
  );
  return (rows[0] as { got: boolean }).got;
}

describe.skipIf(!PG_URL)("tenant usage and write lock (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;
  const fields = new FieldCrypto(new InMemoryKeyStore());

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await seedUsers(db.owner);
    app = new Pool({ connectionString: db.appUrl });
  });
  afterAll(async () => {
    await app?.end();
    await db?.drop();
  });

  async function add(tenant: string, owner: string, fingerprint: string, sizeBytes: number) {
    const doc = await newDocument(fields, tenant, owner, fingerprint, { sizeBytes });
    await withTenant(app, tenant, (tx) => insertDocument(tx, doc));
  }

  it("counts a tenant's documents and bytes across its users, and nothing of other tenants", async () => {
    expect(await withTenant(app, T1, (tx) => usageOfTenant(tx))).toEqual({
      documents: 0,
      bytes: 0,
    });
    await add(T1, U1, FP("1"), 1234);
    await add(T1, U1, FP("2"), 10);
    await add(T1, U1B, FP("3"), 100);
    await add(T2, U2, FP("4"), 7);
    expect(await withTenant(app, T1, (tx) => usageOfTenant(tx))).toEqual({
      documents: 3,
      bytes: 1344,
    });
    expect(await withTenant(app, T2, (tx) => usageOfTenant(tx))).toEqual({
      documents: 1,
      bytes: 7,
    });
  });

  it("holds the tenant lock until the transaction ends, independent of other tenants", async () => {
    await withTenant(app, T1, async (tx1) => {
      await lockTenantForWrite(tx1, T1);
      // Another connection cannot take the same tenant's lock while tx1 holds it...
      expect(await withTenant(app, T1, (tx2) => tryLock(tx2, T1))).toBe(false);
      // ...but another tenant's lock is independent.
      expect(await withTenant(app, T2, (tx2) => tryLock(tx2, T2))).toBe(true);
    });
    // tx1 has committed: the lock is free again. Probe from a second pool, so the connection cannot
    // be tx1's own (advisory locks are re-entrant per session; a leaked session lock would pass on it).
    const other = new Pool({ connectionString: db.appUrl });
    try {
      expect(await withTenant(other, T1, (tx2) => tryLock(tx2, T1))).toBe(true);
    } finally {
      await other.end();
    }
  });
});
