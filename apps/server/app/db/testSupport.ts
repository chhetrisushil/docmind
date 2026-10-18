import { randomBytes } from "node:crypto";
import { Pool } from "pg";

/** Set by CI and in a local .env; the Postgres suites skip cleanly without it. */
export const PG_URL = process.env.DOCMIND_TEST_PG_URL;

/** Cluster-wide and fixed, so test files agree on it. */
export const APP_PASSWORD = "docmind_app_test";
export const LOOM_PASSWORD = "docmind_loom_test";

export interface TestDb {
  /** Connected as the owner named in DOCMIND_TEST_PG_URL (runs migrations, seeds data). */
  owner: Pool;
  /** The same database as `docmind_app`; call `setAppRolePassword` first. */
  appUrl: string;
  /** The same database as `docmind_loom`; call `setRolePassword(owner, "docmind_loom", LOOM_PASSWORD)` first. */
  loomUrl: string;
  drop(): Promise<void>;
}

/** An empty database of its own, so suites never see each other's tables. */
export async function createTestDb(): Promise<TestDb> {
  if (!PG_URL) throw new Error("DOCMIND_TEST_PG_URL is not set");
  const name = `docmind_t_${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString: PG_URL, max: 1 });
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(PG_URL);
  url.pathname = `/${name}`;
  const owner = new Pool({ connectionString: url.toString() });
  const appUrl = new URL(url);
  appUrl.username = "docmind_app";
  appUrl.password = APP_PASSWORD;
  const loomUrl = new URL(url);
  loomUrl.username = "docmind_loom";
  loomUrl.password = LOOM_PASSWORD;

  return {
    owner,
    appUrl: appUrl.toString(),
    loomUrl: loomUrl.toString(),
    async drop() {
      await owner.end();
      const dropper = new Pool({ connectionString: PG_URL, max: 1 });
      await dropper.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await dropper.end();
    },
  };
}
