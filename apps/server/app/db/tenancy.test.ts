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

  // schema_migrations holds only file names, timestamps and checksums (no tenant data); docmind_app
  // may SELECT it (0017, the boot checksum check) and nothing else, so it is exempt from RLS.
  const unprotected = async () => {
    const { rows } = await db.owner.query<{ relname: string }>(
      `SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND relname <> 'schema_migrations' AND (
         (c.relkind IN ('r', 'p') AND NOT c.relrowsecurity) OR c.relkind = 'm' OR
         (c.relkind = 'v' AND NOT coalesce(c.reloptions @> ARRAY['security_invoker=true'], false)))
       ORDER BY relname`,
    );
    return rows.map((r) => r.relname);
  };

  it("has row-level security on every table, including ones later PRs add", async () => {
    expect(await unprotected()).toEqual([]);
  });

  it("flags views and materialized views, which would leak every tenant's rows", async () => {
    await db.owner.query("CREATE VIEW leaky AS SELECT * FROM users");
    await db.owner.query("CREATE MATERIALIZED VIEW leaky_m AS SELECT * FROM users");
    await db.owner.query("CREATE VIEW safe WITH (security_invoker = true) AS SELECT * FROM users");
    expect(await unprotected()).toEqual(["leaky", "leaky_m"]);
    await db.owner.query("DROP VIEW leaky, safe; DROP MATERIALIZED VIEW leaky_m");
  });

  it("rejects a session for a user of another tenant, and moving a row to another tenant", async () => {
    const forge = "INSERT INTO auth_sessions VALUES ('forged', $1, $2, now())";
    await expect(withTenant(app, A, (tx) => tx.query(forge, [A, USER_B]))).rejects.toThrow(
      /foreign key/,
    );
    const move = "UPDATE users SET tenant_id = $1";
    await expect(withTenant(app, A, (tx) => tx.query(move, [B]))).rejects.toThrow(
      /row-level security/,
    );
  });

  it("cannot delete or create tenants", async () => {
    await expect(withTenant(app, A, (tx) => tx.query("DELETE FROM tenants"))).rejects.toThrow(
      /permission denied/,
    );
    const mk = "INSERT INTO tenants (id, name) VALUES ($1, 'x')";
    await expect(withTenant(app, A, (tx) => tx.query(mk, [crypto.randomUUID()]))).rejects.toThrow(
      /permission denied/,
    );
  });

  it("does not report success when the callback swallowed a database error", async () => {
    const dup = "INSERT INTO users (id, tenant_id, email, password_hash) VALUES ($1, $2, $3, 'x')";
    const saved = withTenant(app, A, async (tx) => {
      await tx.query(dup, [crypto.randomUUID(), A, "b@example.com"]).catch(() => undefined);
    });
    await expect(saved).rejects.toThrow(/aborted/);
  });

  it("does not let a session-level tenant setting outlive withTenant", async () => {
    await withTenant(app, A, (tx) =>
      tx.query("SELECT set_config('app.tenant_id', $1, false)", [B]),
    );
    const { rows } = await app.query("SELECT count(*)::int AS n FROM users");
    expect(rows[0].n).toBe(0);
  });

  it("keeps the original error and discards a connection that died mid-transaction", async () => {
    const kill = withTenant(app, A, (tx) =>
      tx.query("SELECT pg_terminate_backend(pg_backend_pid())"),
    );
    await expect(kill).rejects.toThrow(/terminat/);
    expect((await app.query("SELECT 1 AS ok")).rows[0].ok).toBe(1);
  });
});
