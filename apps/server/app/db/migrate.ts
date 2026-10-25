import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { resolveSecretEnv } from "../secrets";

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

/**
 * A migration's text as it is hashed and executed: without a leading BOM and with LF line ends, so
 * an editor's BOM or a CRLF checkout (core.autocrlf) of an unchanged file neither refuses nor runs
 * differently. `.gitattributes` also pins `*.sql` to LF.
 */
const readMigration = (dir: string, file: string): string =>
  readFileSync(join(dir, file), "utf8")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n");
const checksumOf = (sql: string) => createHash("sha256").update(sql).digest("hex");

/** An applied migration file no longer matches its recorded checksum. The message names the file only. */
export class MigrationChecksumError extends Error {
  override readonly name = "MigrationChecksumError";
  constructor(file: string) {
    super(`migration ${file} was changed after it was applied`);
  }
}
const changed = (file: string) => new MigrationChecksumError(file);

/**
 * Read-only check, for server start: refuses when an applied migration file no longer matches its
 * recorded checksum. Rows without a checksum (not yet backfilled by `db:migrate`) and a database
 * without the table or column are not checked. Throws an error naming the file only.
 */
export async function verifyMigrationChecksums(
  pool: Pool,
  dir: string = MIGRATIONS_DIR,
): Promise<void> {
  const column = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'schema_migrations' AND column_name = 'checksum'`,
  );
  if (column.rowCount === 0) return;
  const { rows } = await pool.query<{ name: string; checksum: string | null }>(
    "SELECT name, checksum FROM public.schema_migrations ORDER BY name",
  );
  const files = new Set(readdirSync(dir));
  for (const { name, checksum } of rows)
    if (checksum !== null && files.has(name) && checksum !== checksumOf(readMigration(dir, name)))
      throw changed(name);
}

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
    // Added here, not by a migration: the runner must be able to read it before any migration runs.
    await client.query("ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text");
    const done = await client.query<{ name: string; checksum: string | null }>(
      "SELECT name, checksum FROM schema_migrations",
    );
    const seen = new Map(done.rows.map((r) => [r.name, r.checksum]));
    const files = readdirSync(dir)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f))
      .sort();
    // An applied file that changed is never re-run, so refuse before anything else is applied. Rows
    // from before checksums existed are backfilled from the file as it is now (recorded, not refused).
    for (const file of files) {
      if (!seen.has(file)) continue;
      const sum = checksumOf(readMigration(dir, file));
      const recorded = seen.get(file);
      if (recorded == null) {
        await client.query("UPDATE schema_migrations SET checksum = $2 WHERE name = $1", [
          file,
          sum,
        ]);
      } else if (recorded !== sum) {
        throw changed(file);
      }
    }
    const applied: string[] = [];
    for (const file of files) {
      if (seen.has(file)) continue;
      const sql = readMigration(dir, file);
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
        await client.query("INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)", [
          file,
          checksumOf(sql),
        ]);
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

/** The migration job's settings; each secret may be a `<NAME>_FILE` (the image's job mounts them). */
export function loadMigrateConfig(env: NodeJS.ProcessEnv = process.env): {
  url: string;
  appPassword: string | undefined;
  loomPassword: string | undefined;
} {
  // Only the job's own secrets: an unrelated unreadable _FILE in a shared job environment must not fail it.
  const resolved = resolveSecretEnv(env, [
    "DOCMIND_MIGRATE_URL",
    "DOCMIND_APP_DB_PASSWORD",
    "DOCMIND_LOOM_DB_PASSWORD",
  ]);
  const url = resolved.DOCMIND_MIGRATE_URL;
  if (!url)
    throw new Error(
      "DOCMIND_MIGRATE_URL is not set (the owner role's connection string; or DOCMIND_MIGRATE_URL_FILE)",
    );
  return {
    url,
    appPassword: resolved.DOCMIND_APP_DB_PASSWORD,
    loomPassword: resolved.DOCMIND_LOOM_DB_PASSWORD,
  };
}

async function main(): Promise<void> {
  const config = loadMigrateConfig();
  const pool = new Pool({ connectionString: config.url });
  try {
    const applied = await migrate(pool);
    console.log(applied.length > 0 ? `applied: ${applied.join(", ")}` : "schema is up to date");
    if (config.appPassword) await setAppRolePassword(pool, config.appPassword);
    if (config.loomPassword) await setRolePassword(pool, "docmind_loom", config.loomPassword);
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
