import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword } from "../db/migrate";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "../db/testSupport";
import { ALICE, ALICE2, BOB, T1, U1, U1B, U2, seedUsers } from "../documents/testHarness";
import { PgHandleStore } from "./pgHandles";

const H1 = "a".repeat(26);
const H2 = "e".repeat(26);

describe.skipIf(!PG_URL)("users.id_handle and its lookups (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;
  let store: PgHandleStore;
  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await seedUsers(db.owner);
    app = new Pool({ connectionString: db.appUrl });
    store = new PgHandleStore(app);
  });
  afterAll(async () => {
    await app?.end();
    await db?.drop();
  });

  it("claims once, and every later claim returns the stored value", async () => {
    expect(await store.read(ALICE)).toBeNull();
    expect(await store.claim(ALICE, H1)).toBe(H1);
    expect(await store.claim(ALICE, H2)).toBe(H1); // the stored one wins; the caller refuses a mismatch
    expect(await store.read(ALICE)).toBe(H1);
  });

  it("a concurrent claim settles on one value", async () => {
    const results = await Promise.all([
      store.claim(ALICE2, H2),
      store.claim(ALICE2, H2),
      store.claim(ALICE2, "i".repeat(26)),
    ]);
    expect(new Set(results).size).toBe(1);
    expect(await store.read(ALICE2)).toBe(results[0]);
  });

  it("the column accepts only the canonical spelling of a handle (last character a e i m q u y 4)", async () => {
    for (const bad of [`${"a".repeat(25)}b`, "a".repeat(25), "a".repeat(27), `${"a".repeat(25)}z`])
      await expect(
        db.owner.query("UPDATE users SET id_handle = $2 WHERE id = $1", [U2, bad]),
      ).rejects.toMatchObject({ code: "23514" });
    await db.owner.query("UPDATE users SET id_handle = NULL WHERE id = $1", [U2]);
  });

  it("is unique across users and tenants, and shaped", async () => {
    await expect(store.claim(BOB, H1)).rejects.toMatchObject({ code: "23505" });
    await expect(
      db.owner.query("UPDATE users SET id_handle = 'short' WHERE id = $1", [U2]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      db.owner.query("UPDATE users SET id_handle = $2 WHERE id = $1", [U2, "A".repeat(26)]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("row-level security keeps a claim inside its tenant", async () => {
    await expect(store.claim({ tenantId: T1, userId: U2 }, "m".repeat(26))).rejects.toThrow();
    expect(await store.read({ tenantId: T1, userId: U2 })).toBeNull();
  });

  it("an erasing user cannot claim a handle", async () => {
    await db.owner.query(
      "INSERT INTO users (id, tenant_id, email, password_hash, erasing_at) VALUES ('c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1', $1, 'gone@example.com', 'x', now())",
      [T1],
    );
    await expect(
      store.claim({ tenantId: T1, userId: "c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1" }, "q".repeat(26)),
    ).rejects.toMatchObject({ name: "FieldKeyUnavailableError" });
  });

  it("finds the user of a handle across tenants, and pages the users that have one", async () => {
    expect(await store.userOf(H1)).toBe(U1);
    expect(await store.userOf("y".repeat(26))).toBeNull();
    const all = await store.page("00000000-0000-0000-0000-000000000000", 500);
    expect(all.map((r) => r.userId)).toEqual([U1, U1B].sort());
    const first = all[0] as { userId: string };
    expect((await store.page(first.userId, 500)).map((r) => r.userId)).toEqual(
      all.slice(1).map((r) => r.userId),
    );
    expect(await store.page("00000000-0000-0000-0000-000000000000", 1)).toHaveLength(1);
  });
});
