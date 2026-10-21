import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword } from "../db/migrate";
import { withTenant } from "../db/tenant";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";
import { T1, T2, U1, U2, seedUsers } from "../documents/testHarness";
import { PgErasureStore } from "./pgStore";
import { ERASURE_STEPS } from "./types";

describe.skipIf(!PG_URL)("PgErasureStore (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;
  let store: PgErasureStore;
  const finish = async (s: PgErasureStore, user: string) => {
    for (const step of ERASURE_STEPS) await s.mark(user, step);
  };
  const hash = (name: string) => createHash("sha256").update(name).digest();

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await seedUsers(db.owner);
    app = new Pool({ connectionString: db.appUrl });
    store = new PgErasureStore(app);
  });
  afterAll(async () => {
    await app?.end();
    await db?.drop();
  });

  it("inserts inside the caller's own tenant transaction, and a second insert changes nothing", async () => {
    expect(await withTenant(app, T1, (tx) => store.insert(tx, U1, T1, hash("u1")))).toBe(true);
    expect(await withTenant(app, T1, (tx) => store.insert(tx, U1, T1, hash("u1-again")))).toBe(
      false,
    );
    expect(await store.status(hash("u1-again"))).toBeNull(); // the first receipt is the only one
    expect(await store.get(U1)).toEqual({
      userId: U1,
      tenantId: T1,
      state: "pending",
      steps: [],
      attempts: 0,
    });
  });

  it("refuses a request that names another tenant's user, and rolls the caller's transaction back with it", async () => {
    await expect(
      withTenant(app, T1, (tx) => store.insert(tx, U2, T1, hash("forged"))),
    ).rejects.toThrow(/row-level security/);
    expect(await store.get(U2)).toBeNull();
  });

  it("lists pending requests across tenants, records steps in the order marked, and counts retries", async () => {
    await withTenant(app, T2, (tx) => store.insert(tx, U2, T2, hash("u2")));
    expect((await store.pending()).map((r) => r.userId).sort()).toEqual([U1, U2].sort());
    for (const step of ["stop", "shred", "stop"] as const) await store.mark(U1, step);
    await store.retried(U1);
    expect(await store.get(U1)).toMatchObject({ steps: ["stop", "shred"], attempts: 1 });
  });

  it("status reads the receipt: pending, then done, null for any other hash", async () => {
    expect(await store.status(hash("u2"))).toBe("pending");
    expect(await store.status(hash("nobody"))).toBeNull();
    await finish(store, U2);
    expect(await store.status(hash("u2"))).toBe("done");
    await store.mark(U2, "done"); // a repeat is a no-op
  });

  it("done takes the request out of the pending list, and get answers null for it", async () => {
    await store.mark(U2, "done");
    await store.mark(U2, "stop"); // after done: nothing changes
    expect(await store.get(U2)).toBeNull();
    expect((await store.pending()).map((r) => r.userId)).toEqual([U1]);
    expect(await store.erased()).toEqual([U2]); // erased() is the same function asked for 'done'
    const { rows } = await db.owner.query(
      "SELECT state, steps FROM erasure_requests WHERE user_id = $1",
      [U2],
    );
    expect(rows[0]).toEqual({ state: "done", steps: [...ERASURE_STEPS] });
  });

  it("refuses an out-of-order step and a done without its steps", async () => {
    await expect(store.mark(U1, "rows")).rejects.toMatchObject({ code: "22023" });
    await expect(store.mark(U1, "done")).rejects.toMatchObject({ code: "22023" });
    expect(await store.get(U1)).toMatchObject({ steps: ["stop", "shred"] });
  });

  it("refuses to mark a request that does not exist, and carries no email, content or receipt token", async () => {
    await expect(store.mark(randomUUID(), "stop")).rejects.toThrow(/no such erasure request/);
    const { rows } = await db.owner.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'erasure_requests' ORDER BY column_name",
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      "attempts",
      "completed_at",
      "receipt_hash",
      "requested_at",
      "state",
      "steps",
      "tenant_id",
      "updated_at",
      "user_id",
    ]);
  });

  it("the 0024 steps CHECK lists exactly ERASURE_STEPS", async () => {
    const { rows } = await db.owner.query(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'erasure_requests_steps_check'",
    );
    const def = String(rows[0]?.def);
    const listed = [...(def.match(/ARRAY\[(.*?)\]/)?.[1] ?? "").matchAll(/'([A-Za-z]+)'/g)].map(
      (m) => m[1],
    );
    expect(listed).toEqual([...ERASURE_STEPS]);
  });
});
