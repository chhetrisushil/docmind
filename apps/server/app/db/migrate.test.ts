import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "./migrate";
import { PG_URL, type TestDb, createTestDb } from "./testSupport";

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

  it("applies the repo's migrations, which create an unprivileged app role", async () => {
    const fresh = await createTestDb();
    try {
      expect(await migrate(fresh.owner)).toContain("0001_app_role.sql");
      const { rows } = await fresh.owner.query(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'docmind_app'",
      );
      expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    } finally {
      await fresh.drop();
    }
  });
});
