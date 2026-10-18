import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword, setRolePassword } from "./migrate";
import { assertUnprivilegedRole } from "./pool";
import { APP_PASSWORD, LOOM_PASSWORD, PG_URL, type TestDb, createTestDb } from "./testSupport";

describe.skipIf(!PG_URL)("docmind_loom role and schema (need DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let loom: Pool;
  let app: Pool;

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await setRolePassword(db.owner, "docmind_loom", LOOM_PASSWORD);
    loom = new Pool({ connectionString: db.loomUrl });
    app = new Pool({ connectionString: db.appUrl });
  });

  afterAll(async () => {
    await loom?.end();
    await app?.end();
    await db?.drop();
  });

  it("is unprivileged, owns the loom schema, and defaults to it", async () => {
    const { rows } = await loom.query(
      `SELECT current_user AS who, current_schema() AS schema, rolsuper, rolbypassrls,
              rolcreatedb, rolcreaterole, rolreplication,
              (SELECT nspowner = r.oid FROM pg_namespace WHERE nspname = 'loom') AS owns,
              EXISTS (SELECT FROM pg_auth_members m WHERE m.member = r.oid) AS member
         FROM pg_roles r WHERE rolname = current_user`,
    );
    expect(rows[0]).toEqual({
      who: "docmind_loom",
      schema: "loom",
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      owns: true,
      member: false,
    });
  });

  it("cannot read DocMind's tables, and creates its own tables only in its schema", async () => {
    await expect(loom.query("SELECT * FROM public.users")).rejects.toThrow(/permission denied/);
    await expect(loom.query("SELECT * FROM public.data_keys")).rejects.toThrow(/permission denied/);
    await loom.query("CREATE TABLE events_probe (id int)");
    const { rows } = await loom.query("SELECT to_regclass('loom.events_probe') AS t");
    expect(rows[0].t).toBe("events_probe");
  });

  it("is invisible to the app role, including objects the loom role creates later", async () => {
    await expect(app.query("SELECT * FROM loom.events_probe")).rejects.toThrow(/permission denied/);
    await expect(app.query("CREATE TABLE loom.intruder (id int)")).rejects.toThrow(
      /permission denied/,
    );
    const { rows } = await db.owner.query(
      `SELECT has_schema_privilege('docmind_app', 'loom', 'USAGE') AS usage,
              has_table_privilege('docmind_app', 'loom.events_probe', 'SELECT') AS sel,
              pg_has_role('docmind_app', 'docmind_loom', 'MEMBER') AS member,
              has_schema_privilege('public', 'loom', 'USAGE') AS pub_usage`,
    );
    expect(rows[0]).toEqual({ usage: false, sel: false, member: false, pub_usage: false });
  });

  it("leaves docmind_app acceptable to the unprivileged-role guard", async () => {
    await expect(assertUnprivilegedRole(app)).resolves.toBeUndefined();
  });
});
