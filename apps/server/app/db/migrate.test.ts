import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword } from "./migrate";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "./testSupport";

describe.skipIf(!PG_URL)("migration runner (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let dir: string;

  beforeAll(async () => {
    db = await createTestDb();
    dir = mkdtempSync(join(tmpdir(), "docmind-migrations-"));
    writeFileSync(join(dir, "0001_one.sql"), "CREATE TABLE one (id int);");
    writeFileSync(join(dir, "0002_two.sql"), "CREATE TABLE two (id int);");
    writeFileSync(join(dir, "notes.txt"), "not a migration");
  });

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db.drop();
  });

  it("applies files in name order, once, and records them", async () => {
    expect(await migrate(db.owner, dir)).toEqual(["0001_one.sql", "0002_two.sql"]);
    expect(await migrate(db.owner, dir)).toEqual([]);
    const { rows } = await db.owner.query("SELECT name FROM schema_migrations ORDER BY name");
    expect(rows.map((r) => r.name)).toEqual(["0001_one.sql", "0002_two.sql"]);
  });

  it("rolls a failing file back whole and keeps the earlier ones", async () => {
    const bad = join(dir, "0003_bad.sql");
    writeFileSync(bad, "CREATE TABLE three (id int); SELECT 1/0;");
    await expect(migrate(db.owner, dir)).rejects.toThrow(/division by zero/);
    rmSync(bad);
    const { rows } = await db.owner.query("SELECT to_regclass('three') AS t");
    expect(rows[0].t).toBeNull();
    const done = await db.owner.query("SELECT count(*)::int AS n FROM schema_migrations");
    expect(done.rows[0].n).toBe(2);
  });

  it("lets two runners started together apply each file once", async () => {
    const racy = await createTestDb();
    try {
      const runs = await Promise.all([migrate(racy.owner, dir), migrate(racy.owner, dir)]);
      expect(runs.flat().sort()).toEqual(["0001_one.sql", "0002_two.sql"]);
    } finally {
      await racy.drop();
    }
  });

  it("refuses a tampered docmind_app; else unprivileged, no PUBLIC function execute", async () => {
    const fresh = await createTestDb();
    const q = (sql: string) => fresh.owner.query(sql);
    try {
      for (const [bad, undo] of [
        ["ALTER ROLE docmind_app BYPASSRLS", "ALTER ROLE docmind_app NOBYPASSRLS"],
        ["GRANT pg_read_all_data TO docmind_app", "REVOKE pg_read_all_data FROM docmind_app"],
      ] as const) {
        await q(bad);
        await expect(migrate(fresh.owner)).rejects.toThrow(/docmind_app must not/);
        await q(undo);
      }
      expect(await migrate(fresh.owner)).toContain("0001_app_role.sql");
      await q("CREATE FUNCTION probe() RETURNS int LANGUAGE sql AS 'SELECT 1'");
      const { rows } = await q(
        `SELECT (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR EXISTS
                 (SELECT FROM pg_auth_members m WHERE m.member = r.oid)) AS bad,
                has_function_privilege('docmind_app', 'probe()', 'EXECUTE') AS exec
           FROM pg_roles r WHERE rolname = 'docmind_app'`,
      );
      expect(rows[0]).toEqual({ bad: false, exec: false });
    } finally {
      await fresh.drop();
    }
  });

  it("gives the app role a login that is still not privileged", async () => {
    const fresh = await createTestDb();
    try {
      await migrate(fresh.owner);
      await setAppRolePassword(fresh.owner, APP_PASSWORD);
      const app = new Pool({ connectionString: fresh.appUrl });
      const { rows } = await app.query(
        "SELECT current_user AS who, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      );
      await app.end();
      expect(rows[0]).toEqual({ who: "docmind_app", rolsuper: false, rolbypassrls: false });
    } finally {
      await fresh.drop();
    }
  });
});
