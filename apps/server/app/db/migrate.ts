import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Pool } from "pg";

// Resolved from the source tree: this runs under tsx and vitest, never from `dist`.
export const MIGRATIONS_DIR = resolve(__dirname, "../../../../infra/migrations");

// Serializes runners: two started together apply each file once.
const LOCK_KEY = 727274;

/** Applies every `NNNN_name.sql` in `dir` not yet recorded in `schema_migrations`, in name order. */
export async function migrate(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const done = await client.query<{ name: string }>("SELECT name FROM schema_migrations");
    const seen = new Set(done.rows.map((r) => r.name));
    const applied: string[] = [];
    for (const file of readdirSync(dir)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f))
      .sort()) {
      if (seen.has(file)) continue;
      try {
        await client.query("BEGIN");
        await client.query(readFileSync(join(dir, file), "utf8"));
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
      applied.push(file);
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
    client.release();
  }
}

/** Lets a DocMind role log in. DDL cannot take parameters, so Postgres quotes the password itself. */
export async function setRolePassword(
  pool: Pool,
  role: "docmind_app" | "docmind_loom",
  password: string,
): Promise<void> {
  const { rows } = await pool.query<{ ddl: string }>(
    "SELECT format('ALTER ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) AS ddl",
    [role, password],
  );
  await pool.query(rows[0]?.ddl as string);
}

export const setAppRolePassword = (pool: Pool, password: string) =>
  setRolePassword(pool, "docmind_app", password);

async function main(): Promise<void> {
  const url = process.env.DOCMIND_MIGRATE_URL;
  if (!url) throw new Error("DOCMIND_MIGRATE_URL is not set (the owner role's connection string)");
  const pool = new Pool({ connectionString: url });
  try {
    const applied = await migrate(pool);
    console.log(applied.length > 0 ? `applied: ${applied.join(", ")}` : "schema is up to date");
    const password = process.env.DOCMIND_APP_DB_PASSWORD;
    if (password) await setAppRolePassword(pool, password);
    const loomPassword = process.env.DOCMIND_LOOM_DB_PASSWORD;
    if (loomPassword) await setRolePassword(pool, "docmind_loom", loomPassword);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
