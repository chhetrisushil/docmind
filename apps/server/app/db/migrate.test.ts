import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MigrationChecksumError,
  loadMigrateConfig,
  migrate,
  setAppRolePassword,
  verifyMigrationChecksums,
} from "./migrate";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "./testSupport";

describe("loadMigrateConfig", () => {
  it("reads the three variables, each from its _FILE when given", () => {
    const dir = mkdtempSync(join(tmpdir(), "docmind-migrate-cfg-"));
    try {
      writeFileSync(join(dir, "url"), "postgres://owner\n");
      writeFileSync(join(dir, "pw"), "app-pw\n");
      expect(
        loadMigrateConfig({
          DOCMIND_MIGRATE_URL_FILE: join(dir, "url"),
          DOCMIND_APP_DB_PASSWORD_FILE: join(dir, "pw"),
          DOCMIND_LOOM_DB_PASSWORD: "loom-pw",
        }),
      ).toEqual({ url: "postgres://owner", appPassword: "app-pw", loomPassword: "loom-pw" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the variable when the URL is missing", () => {
    expect(() => loadMigrateConfig({})).toThrow(/^DOCMIND_MIGRATE_URL is not set/);
  });

  it("ignores another secret's unreadable _FILE: the job resolves only its own", () => {
    expect(
      loadMigrateConfig({
        DOCMIND_MIGRATE_URL: "postgres://owner",
        ANTHROPIC_API_KEY_FILE: "/nonexistent/key",
      }).url,
    ).toBe("postgres://owner");
  });
});

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

  it("records a checksum, passes an unchanged file and refuses an edited applied one, naming the file only", async () => {
    const fresh = await createTestDb();
    const d = mkdtempSync(join(tmpdir(), "docmind-checksums-"));
    try {
      writeFileSync(join(d, "0001_a.sql"), "CREATE TABLE a (id int);");
      expect(await migrate(fresh.owner, d)).toEqual(["0001_a.sql"]);
      const { rows } = await fresh.owner.query("SELECT checksum FROM schema_migrations");
      expect(rows[0].checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(await migrate(fresh.owner, d)).toEqual([]);
      writeFileSync(join(d, "0001_a.sql"), "CREATE TABLE a (id int, secret_edit text);");
      await expect(migrate(fresh.owner, d)).rejects.toThrow(
        /^migration 0001_a\.sql was changed after it was applied$/,
      );
    } finally {
      rmSync(d, { recursive: true, force: true });
      await fresh.drop();
    }
  });

  it("hashes a CRLF or BOM variant of an applied file the same, and still refuses a real change", async () => {
    const fresh = await createTestDb();
    const d = mkdtempSync(join(tmpdir(), "docmind-eol-"));
    try {
      const file = join(d, "0001_a.sql");
      writeFileSync(file, "CREATE TABLE a (id int);\n-- note\n");
      await migrate(fresh.owner, d);
      writeFileSync(file, "\uFEFFCREATE TABLE a (id int);\r\n-- note\r\n");
      expect(await migrate(fresh.owner, d)).toEqual([]);
      await expect(verifyMigrationChecksums(fresh.owner, d)).resolves.toBeUndefined();
      writeFileSync(file, "\uFEFFCREATE TABLE a (id bigint);\r\n-- note\r\n");
      await expect(migrate(fresh.owner, d)).rejects.toBeInstanceOf(MigrationChecksumError);
      await expect(verifyMigrationChecksums(fresh.owner, d)).rejects.toThrow(
        /^migration 0001_a\.sql was changed after it was applied$/,
      );
    } finally {
      rmSync(d, { recursive: true, force: true });
      await fresh.drop();
    }
  });

  it("the start check runs as docmind_app, skips unbackfilled rows and a database without the column, and refuses an edited file", async () => {
    const fresh = await createTestDb();
    const d = mkdtempSync(join(tmpdir(), "docmind-verify-"));
    const app = new Pool({ connectionString: fresh.appUrl });
    try {
      writeFileSync(join(d, "0001_a.sql"), "SELECT 1;");
      await expect(verifyMigrationChecksums(fresh.owner, d)).resolves.toBeUndefined(); // no table yet
      await migrate(fresh.owner); // the real migrations: roles and the 0017 grant
      await setAppRolePassword(fresh.owner, APP_PASSWORD);
      await expect(verifyMigrationChecksums(app)).resolves.toBeUndefined();
      await fresh.owner.query(
        "UPDATE schema_migrations SET checksum = NULL WHERE name = '0002_tenancy.sql'",
      );
      await fresh.owner.query(
        "UPDATE schema_migrations SET checksum = 'x' WHERE name = '0003_tenancy_hardening.sql'",
      );
      await expect(verifyMigrationChecksums(app)).rejects.toThrow(
        /^migration 0003_tenancy_hardening\.sql was changed after it was applied$/,
      );
    } finally {
      rmSync(d, { recursive: true, force: true });
      await app.end();
      await fresh.drop();
    }
  });

  it("backfills a legacy table with no checksum column, then enforces it", async () => {
    const fresh = await createTestDb();
    const d = mkdtempSync(join(tmpdir(), "docmind-legacy-"));
    try {
      writeFileSync(join(d, "0001_a.sql"), "CREATE TABLE a (id int);");
      await fresh.owner.query(
        "CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      await fresh.owner.query("INSERT INTO schema_migrations (name) VALUES ('0001_a.sql')");
      await fresh.owner.query("CREATE TABLE a (id int)");
      expect(await migrate(fresh.owner, d)).toEqual([]); // recorded, not refused, not re-run
      const { rows } = await fresh.owner.query("SELECT checksum FROM schema_migrations");
      expect(rows[0].checksum).toMatch(/^[0-9a-f]{64}$/);
      writeFileSync(join(d, "0001_a.sql"), "CREATE TABLE a (id bigint);");
      await expect(migrate(fresh.owner, d)).rejects.toThrow(/migration 0001_a\.sql was changed/);
    } finally {
      rmSync(d, { recursive: true, force: true });
      await fresh.drop();
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

  describe("requires-extension", () => {
    const dirWith = (files: Record<string, string>) => {
      const d = mkdtempSync(join(tmpdir(), "dm-mig-"));
      for (const [name, sql] of Object.entries(files)) writeFileSync(join(d, name), sql);
      return d;
    };
    const FILES = {
      "0001_a.sql": "CREATE TABLE a (x int);",
      "0002_needs.sql":
        "-- requires-extension: docmind_no_such_extension\nCREATE TABLE needs (x int);",
      "0003_c.sql": "CREATE TABLE c (x int);",
    };
    const withFresh = async (fn: (owner: Pool) => Promise<void>) => {
      const fresh = await createTestDb();
      try {
        await fn(fresh.owner);
      } finally {
        await fresh.drop();
      }
    };

    it("refuses a migration whose extension the server does not offer, naming file and extension (no global skip, F08)", async () => {
      await withFresh(async (owner) => {
        await expect(migrate(owner, dirWith(FILES))).rejects.toThrow(
          /^migration 0002_needs\.sql needs the docmind_no_such_extension extension, which this server does not offer$/,
        );
        const { rows } = await owner.query("SELECT name FROM schema_migrations ORDER BY name");
        expect(rows.map((r) => r.name)).toEqual(["0001_a.sql"]);
      });
    });

    it("with the test switch, skips it unrecorded and still applies the files after it", async () => {
      await withFresh(async (owner) => {
        process.env.DOCMIND_MIGRATE_SKIP_MISSING_EXTENSIONS = "true";
        try {
          expect(await migrate(owner, dirWith(FILES))).toEqual(["0001_a.sql", "0003_c.sql"]);
        } finally {
          // biome-ignore lint/performance/noDelete: assigning undefined would set the string "undefined"
          delete process.env.DOCMIND_MIGRATE_SKIP_MISSING_EXTENSIONS;
        }
        expect((await owner.query("SELECT to_regclass('needs') AS t")).rows[0].t).toBeNull();
        const { rows } = await owner.query("SELECT name FROM schema_migrations ORDER BY name");
        expect(rows.map((r) => r.name)).toEqual(["0001_a.sql", "0003_c.sql"]);
      });
    });

    it("applies it when the extension is available (plpgsql always is)", async () => {
      await withFresh(async (owner) => {
        const d = dirWith({
          "0001_p.sql": "-- requires-extension: plpgsql\nCREATE TABLE p (x int);",
        });
        expect(await migrate(owner, d)).toEqual(["0001_p.sql"]);
      });
    });

    it.each([
      ["upper case", "-- requires-extension: Vector"],
      ["a quote", `-- requires-extension: vec"tor`],
      ["an injection", "-- requires-extension: x'; DROP TABLE a; --"],
      ["no space", "-- requires-extension:vector"],
      ["no name", "-- requires-extension: "],
      ["trailing text", "-- requires-extension: vector extra"],
      ["a misspelling", "-- requires-extensions: vector"],
      ["leading whitespace", "  -- requires-extension: vector"],
      ["no space after the dashes", "--requires-extension: vector"],
      ["wrong case of the key", "-- Requires-Extension: vector"],
    ])("rejects a malformed header (%s) with a fixed message", async (_n, header) => {
      await withFresh(async (owner) => {
        const d = dirWith({ "0001_bad.sql": `${header}\nCREATE TABLE bad (x int);` });
        await expect(migrate(owner, d)).rejects.toThrow(
          /^migration 0001_bad\.sql has a malformed requires-extension header$/,
        );
        expect((await owner.query("SELECT to_regclass('bad') AS t")).rows[0].t).toBeNull();
      });
    });
  });
});
