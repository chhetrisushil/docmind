import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Pool } from "pg";

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
