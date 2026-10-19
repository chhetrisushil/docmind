import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Pool, type PoolClient } from "pg";

// Resolved from the source tree: this runs under tsx and vitest, never from `dist`.
export const MIGRATIONS_DIR = resolve(__dirname, "../../../../infra/migrations");

// Serializes runners: two started together apply each file once.
const LOCK_KEY = 727274;

// Anything that looks like the header, however it is spelled, must then match HEADER exactly.
const HEADER_LIKE = /^\s*--\s*requires-extension/i;
const HEADER = /^-- requires-extension: ([a-z0-9_]+)$/;

/**
 * The extensions a migration declares with `-- requires-extension: <name>` lines. Strict: any line
 * that looks like the header (leading space, no space after the dashes, other case, extra text) but
 * is not exactly that format is an error, so a typo cannot silently
 * disable the check. The name is only ever bound as a parameter, never interpolated into SQL.
 */
export function requiredExtensions(file: string, sql: string): string[] {
  const names: string[] = [];
  for (const line of sql.split("\n")) {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!HEADER_LIKE.test(text)) continue;
    const name = HEADER.exec(text)?.[1];
    if (!name) throw new Error(`migration ${file} has a malformed requires-extension header`);
    names.push(name);
  }
  return names;
}

const extensionAvailable = async (client: PoolClient, name: string): Promise<boolean> =>
  ((await client.query("SELECT 1 FROM pg_available_extensions WHERE name = $1", [name])).rowCount ??
    0) > 0;

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
      const sql = readFileSync(join(dir, file), "utf8");
      let missing: string | undefined;
      for (const name of requiredExtensions(file, sql)) {
        if (!(await extensionAvailable(client, name))) {
          missing = name;
          break;
        }
      }
      if (missing !== undefined) {
        // Tests only. Not recorded, so a later run applies the file once the extension exists, out of
        // order: after the migrations that came after it.
        if (process.env.DOCMIND_MIGRATE_SKIP_MISSING_EXTENSIONS === "true") continue;
        throw new Error(
          `migration ${file} needs the ${missing} extension, which this server does not offer`,
        );
      }
      try {
        await client.query("BEGIN");
        await client.query(sql);
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
