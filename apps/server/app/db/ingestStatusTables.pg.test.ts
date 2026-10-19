import { readFileSync } from "node:fs";
import { join } from "node:path";
import { foldedStateDdl } from "@loom/plugin-postgres";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { T1, T2, U1, U1B, U2, seedUsers } from "../documents/testHarness";
import { MIGRATIONS_DIR, migrate, setAppRolePassword, setRolePassword } from "./migrate";
import { withTenant } from "./tenant";
import { APP_PASSWORD, LOOM_PASSWORD, PG_URL, type TestDb, createTestDb } from "./testSupport";

const squash = (sql: string) => sql.replace(/\s+/g, " ").trim();

describe.skipIf(!PG_URL)("0012 ingest-status tables (needs DOCMIND_TEST_PG_URL)", () => {
  let db: TestDb;
  let app: Pool;
  let loom: Pool;
  beforeAll(async () => {
    db = await createTestDb();
    await migrate(db.owner);
    await setAppRolePassword(db.owner, APP_PASSWORD);
    await setRolePassword(db.owner, "docmind_loom", LOOM_PASSWORD);
    await seedUsers(db.owner);
    app = new Pool({ connectionString: db.appUrl });
    loom = new Pool({ connectionString: db.loomUrl });
    for (const [key, scope] of [
      ["d1", U1],
      ["d2", U1B],
      ["d3", U2],
      ["d4", null],
    ] as const) {
      await db.owner.query(
        "INSERT INTO public.read_model_state (model_id, execution_id, app_key, scope, sequence) VALUES ('ingest-status', $1, $2, $3, 0)",
        [`e-${key}`, key, scope],
      );
    }
  });
  afterAll(async () => {
    await app?.end();
    await loom?.end();
    await db?.drop();
  });

  it("contains the text of Loom's foldedStateDdl for schema public, so a Loom change shows up here", () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, "0012_ingest_status_model.sql"), "utf8");
    expect(squash(sql)).toContain(squash(foldedStateDdl({ schema: "public" })));
  });

  it("gives the Loom role write access to both tables and the app role read access to the state table only", async () => {
    const has = async (role: string, table: string, privilege: string) =>
      (
        await db.owner.query("SELECT has_table_privilege($1, $2, $3) AS ok", [
          role,
          `public.${table}`,
          privilege,
        ])
      ).rows[0].ok as boolean;
    const privileges = ["SELECT", "INSERT", "UPDATE", "DELETE"];
    for (const table of ["read_model_state", "read_model_folds"]) {
      expect(await Promise.all(privileges.map((p) => has("docmind_loom", table, p)))).toEqual([
        true,
        true,
        true,
        true,
      ]);
    }
    expect(
      await Promise.all(privileges.map((p) => has("docmind_app", "read_model_state", p))),
    ).toEqual([true, false, false, false]);
    expect(await has("docmind_app", "read_model_folds", "SELECT")).toBe(false);
  });

  it("shows the app role only rows whose scope is a user of the transaction's tenant, and none without a tenant", async () => {
    const keys = (tenant: string) =>
      withTenant(app, tenant, async (tx) =>
        (await tx.query("SELECT app_key FROM read_model_state ORDER BY app_key")).rows.map(
          (r) => r.app_key,
        ),
      );
    expect(await keys(T1)).toEqual(["d1", "d2"]);
    expect(await keys(T2)).toEqual(["d3"]);
    expect((await app.query("SELECT app_key FROM read_model_state")).rows).toEqual([]);
  });

  it("lets the Loom role see and change every tenant's rows, and refuses a scope that is not a canonical uuid", async () => {
    expect(
      (await loom.query("SELECT count(*)::int AS n FROM public.read_model_state")).rows[0].n,
    ).toBe(4);
    expect(
      (await loom.query("UPDATE public.read_model_state SET sequence = 1 WHERE app_key = 'd3'"))
        .rowCount,
    ).toBe(1);
    await expect(
      loom.query(
        "INSERT INTO public.read_model_state (model_id, execution_id, scope, sequence) VALUES ('m', 'x', 'not-a-uuid', 0)",
      ),
    ).rejects.toThrow(/read_model_state_scope_uuid/);
  });

  it("refuses the app role any write, and any access to the folds table", async () => {
    await expect(app.query("DELETE FROM public.read_model_state")).rejects.toThrow(
      /permission denied for table read_model_state/,
    );
    await expect(app.query("SELECT * FROM public.read_model_folds")).rejects.toThrow(
      /permission denied for table read_model_folds/,
    );
  });
});
