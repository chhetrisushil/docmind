import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword } from "./migrate";
import { withTenant } from "./tenant";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "./testSupport";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const USER_B = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";

describe.skipIf(!PG_URL)("tenant isolation (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await db.owner.query(`
      INSERT INTO tenants (id, name) VALUES ('${A}', 'A'), ('${B}', 'B');
      INSERT INTO users (id, tenant_id, email, password_hash) VALUES
        ('${USER_A}', '${A}', 'a@example.com', 'x'), ('${USER_B}', '${B}', 'b@example.com', 'x');
      INSERT INTO auth_sessions (token_hash, tenant_id, user_id, expires_at) VALUES
        ('hash-a', '${A}', '${USER_A}', now() + interval '1 day'),
        ('hash-b', '${B}', '${USER_B}', now() + interval '1 day');
    `);
    // One connection, so a leaked tenant setting would show up on the very next query.
    app = new Pool({ connectionString: db.appUrl, max: 1 });
  });

  afterAll(async () => {
    await app?.end();
    await db?.drop();
  });

  it("shows tenant A only its own rows, in every table", async () => {
    await withTenant(app, A, async (tx) => {
      for (const table of ["tenants", "users", "auth_sessions"]) {
        const { rowCount } = await tx.query(`SELECT * FROM ${table}`);
        expect(rowCount, table).toBe(1);
      }
    });
  });

  it("returns nothing for tenant B's rows even when raw SQL names them", async () => {
    await withTenant(app, A, async (tx) => {
      const byTenant = await tx.query("SELECT * FROM users WHERE tenant_id = $1", [B]);
      const byId = await tx.query("SELECT * FROM users WHERE id = $1", [USER_B]);
      const viaJoin = await tx.query(
        "SELECT s.* FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE u.id = $1",
        [USER_B],
      );
      expect([byTenant.rowCount, byId.rowCount, viaJoin.rowCount]).toEqual([0, 0, 0]);
    });
  });

  it("cannot update or delete another tenant's rows", async () => {
    await withTenant(app, A, async (tx) => {
      const upd = await tx.query("UPDATE users SET email = 'owned@evil.test' WHERE true");
      const del = await tx.query("DELETE FROM auth_sessions WHERE true");
      expect([upd.rowCount, del.rowCount]).toEqual([1, 1]);
    });
    const users = await db.owner.query("SELECT email FROM users WHERE tenant_id = $1", [B]);
    const sessions = await db.owner.query("SELECT 1 FROM auth_sessions WHERE tenant_id = $1", [B]);
    expect([users.rows[0].email, sessions.rowCount]).toEqual(["b@example.com", 1]);
  });

  it("refuses to insert a row for another tenant", async () => {
    const insert =
      "INSERT INTO users (id, tenant_id, email, password_hash) VALUES ($1, $2, $3, 'x')";
    await expect(
      withTenant(app, A, (tx) => tx.query(insert, [crypto.randomUUID(), B, "c@example.com"])),
    ).rejects.toThrow(/row-level security/);
  });

  it("sees nothing without a tenant, even on a connection that just served one", async () => {
    await withTenant(app, A, async () => undefined);
    const { rows } = await app.query("SELECT count(*)::int AS n FROM users");
    expect(rows[0].n).toBe(0);
  });

  it("rolls back when the callback throws", async () => {
    await expect(
      withTenant(app, A, async (tx) => {
        await tx.query("DELETE FROM users");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const { rowCount } = await db.owner.query("SELECT 1 FROM users WHERE tenant_id = $1", [A]);
    expect(rowCount).toBe(1);
  });

  it("rejects a tenant id that is not a uuid before touching the database", async () => {
    await expect(withTenant(app, "a'; DROP TABLE users;--", async () => 1)).rejects.toThrow(/uuid/);
  });

  it("connects as a role that cannot switch row-level security off", async () => {
    const off = "ALTER TABLE users DISABLE ROW LEVEL SECURITY";
    await expect(app.query(off)).rejects.toThrow(/must be owner/);
    await expect(app.query("DROP POLICY tenant_isolation ON users")).rejects.toThrow(
      /must be owner/,
    );
  });

  it("has row-level security on every table, including ones later PRs add", async () => {
    const { rows } = await db.owner.query<{ relname: string }>(
      `SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
         AND relname <> 'schema_migrations'`,
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
  });
});
