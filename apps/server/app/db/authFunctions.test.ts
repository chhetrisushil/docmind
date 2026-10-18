import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword } from "./migrate";
import { withTenant } from "./tenant";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "./testSupport";

const T1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const U1 = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const T2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const U2 = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";

describe.skipIf(!PG_URL)("auth SQL functions (need DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    app = new Pool({ connectionString: db.appUrl, max: 1 });
  });

  afterAll(async () => {
    await app?.end();
    await db?.drop();
  });

  const signUp = async (t: string, u: string, email: string) =>
    (await app.query("SELECT auth_sign_up($1, $2, $3, 'hash') AS ok", [t, u, email])).rows[0].ok;

  it("signs a user up, with no tenant context, as the app role", async () => {
    expect(await signUp(T1, U1, "a@example.com")).toBe(true);
    const login = await app.query("SELECT * FROM auth_find_login('a@example.com')");
    expect(login.rows).toEqual([{ user_id: U1, tenant_id: T1, password_hash: "hash" }]);
    expect((await app.query("SELECT * FROM auth_find_login('x@example.com')")).rowCount).toBe(0);
  });

  it("reports a taken email and leaves no orphan tenant behind", async () => {
    expect(await signUp(T2, U2, "a@example.com")).toBe(false);
    const { rowCount } = await db.owner.query("SELECT 1 FROM tenants WHERE id = $1", [T2]);
    expect(rowCount).toBe(0);
  });

  it("finds a live session by token hash and ignores an expired one", async () => {
    await withTenant(app, T1, async (tx) => {
      await tx.query(
        `INSERT INTO auth_sessions (token_hash, tenant_id, user_id, expires_at) VALUES
           ('live', $1, $2, now() + interval '1 day'), ('dead', $1, $2, now() - interval '1 day')`,
        [T1, U1],
      );
    });
    const live = await app.query("SELECT * FROM auth_find_session('live')");
    expect(live.rows).toEqual([{ user_id: U1, tenant_id: T1 }]);
    expect((await app.query("SELECT * FROM auth_find_session('dead')")).rowCount).toBe(0);
    expect((await app.query("SELECT * FROM auth_find_session('nope')")).rowCount).toBe(0);
  });

  it("sweeps expired sessions across tenants and keeps live ones", async () => {
    expect((await app.query("SELECT auth_purge_expired_sessions() AS n")).rows[0].n).toBe("1");
    const { rows } = await db.owner.query("SELECT token_hash FROM auth_sessions");
    expect(rows).toEqual([{ token_hash: "live" }]);
  });

  it("pins search_path on every definer function, so a caller's path cannot redirect it", async () => {
    const { rows } = await db.owner.query(
      `SELECT proname, proconfig FROM pg_proc WHERE prosecdef AND proname LIKE 'auth\\_%' AND pronamespace = 'public'::regnamespace
       ORDER BY proname`,
    );
    expect(rows.map((r) => r.proname)).toEqual([
      "auth_find_login",
      "auth_find_session",
      "auth_purge_expired_sessions",
      "auth_sign_up",
    ]);
    for (const r of rows)
      expect(r.proconfig, r.proname).toContain("search_path=pg_catalog, pg_temp");
  });

  it("is executable by the app role and by nobody else", async () => {
    const { rows } = await db.owner.query(
      `SELECT p.proname,
              has_function_privilege('docmind_app', p.oid, 'EXECUTE') AS app,
              has_function_privilege(0, p.oid, 'EXECUTE') AS public
         FROM pg_proc p
        WHERE prosecdef AND proname LIKE 'auth\\_%' AND pronamespace = 'public'::regnamespace`,
    );
    expect(rows.length).toBe(4);
    for (const r of rows) expect([r.app, r.public], r.proname).toEqual([true, false]);
  });

  it("indexes sessions by (tenant_id, user_id) and by expires_at", async () => {
    const { rows } = await db.owner.query(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'auth_sessions'",
    );
    const defs = rows.map((r) => r.indexdef).join("\n");
    expect(defs).toContain("(tenant_id, user_id)");
    expect(defs).toContain("(expires_at)");
  });
});
