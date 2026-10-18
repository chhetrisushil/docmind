import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, setAppRolePassword } from "./migrate";
import { createAppPool } from "./pool";
import { APP_PASSWORD, PG_URL, type TestDb, createTestDb } from "./testSupport";

describe.skipIf(!PG_URL)("createAppPool (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
  });

  afterAll(async () => {
    await db?.drop();
  });

  it("accepts the app role", async () => {
    const pool = await createAppPool(db.appUrl);
    expect((await pool.query("SELECT current_user AS u")).rows[0].u).toBe("docmind_app");
    await pool.end();
  });

  it("refuses the owner role (a superuser here)", async () => {
    const url = new URL(db.appUrl);
    const owner = new URL(PG_URL as string);
    url.username = owner.username;
    url.password = owner.password;
    await expect(createAppPool(url.toString())).rejects.toThrow(/voids row-level security/);
  });

  it("refuses an app role that was granted BYPASSRLS", async () => {
    await db.owner.query("ALTER ROLE docmind_app BYPASSRLS");
    try {
      await expect(createAppPool(db.appUrl)).rejects.toThrow(/BYPASSRLS/);
    } finally {
      await db.owner.query("ALTER ROLE docmind_app NOBYPASSRLS");
    }
  });

  describe("roles created for the case", () => {
    const tag = randomBytes(4).toString("hex");
    const created: string[] = [];
    const mk = async (name: string, attrs = "LOGIN") => {
      const role = `dm_${name}_${tag}`;
      await db.owner.query(`CREATE ROLE ${role} ${attrs} PASSWORD 'pw'`);
      created.push(role);
      return role;
    };
    const urlFor = (role: string, search = "") => {
      const url = new URL(db.appUrl);
      url.username = role;
      url.password = "pw";
      url.search = search;
      return url.toString();
    };
    afterAll(async () => {
      if (!db) return;
      for (const role of created.reverse()) {
        await db.owner.query(`DROP OWNED BY ${role}`);
        await db.owner.query(`DROP ROLE ${role}`);
      }
    });

    it("refuses a non-superuser that owns a table with row-level security", async () => {
      const owner = await mk("own");
      await db.owner.query(`CREATE TABLE ${owner}_t (id int)`);
      await db.owner.query(`ALTER TABLE ${owner}_t ENABLE ROW LEVEL SECURITY`);
      await db.owner.query(`ALTER TABLE ${owner}_t OWNER TO ${owner}`);
      await expect(createAppPool(urlFor(owner))).rejects.toThrow(
        /owns, or is a member of the owner/,
      );

      const member = await mk("mem");
      await db.owner.query(`GRANT ${owner} TO ${member}`);
      await expect(createAppPool(urlFor(member))).rejects.toThrow(/owner of/);
    });

    it("refuses a member of a BYPASSRLS role", async () => {
      const bypass = await mk("byp", "NOLOGIN BYPASSRLS");
      const member = await mk("bm");
      await db.owner.query(`GRANT ${bypass} TO ${member}`);
      await expect(createAppPool(urlFor(member))).rejects.toThrow(
        /member of, a superuser or BYPASSRLS/,
      );
    });

    it("refuses a session whose current_user differs from its session_user", async () => {
      const inner = await mk("in", "NOLOGIN");
      const login = await mk("lg");
      await db.owner.query(`GRANT ${inner} TO ${login}`);
      await expect(createAppPool(urlFor(login, `?options=-c%20role%3D${inner}`))).rejects.toThrow(
        /other than the one it logged in as/,
      );
    });
  });
});
