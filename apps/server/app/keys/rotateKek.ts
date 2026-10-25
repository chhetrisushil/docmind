import { type Kek, loadKeks, rotateKek, verifyKeys } from "@docmind/keystore-pg";
import { Pool } from "pg";
import { resolveSecretEnv } from "../secrets";

/**
 * Re-wraps every data key to the current KEK, then proves they all open with that KEK alone.
 * Prints counts and subject ids, never key material. Returns the process exit code: 0 only when
 * every live key is on the current KEK and opens.
 */
export async function runRotation(
  pool: Pool,
  keks: readonly [Kek, ...Kek[]],
  options: { verifyOnly?: boolean } = {},
  log: (line: string) => void = console.log,
): Promise<number> {
  const [current] = keks;
  let code = 0;
  if (!options.verifyOnly) {
    const run = await rotateKek(pool, keks);
    log(`rotated ${run.rotated} key(s) to ${current.id}`);
    for (const subject of run.failed) log(`FAILED to open the key of ${subject}; left unchanged`);
    for (const [id, n] of Object.entries(run.remaining)) log(`${n} key(s) still wrapped by ${id}`);
    if (run.failed.length > 0 || Object.keys(run.remaining).length > 0) code = 1;
  }
  const check = await verifyKeys(pool, current);
  log(
    `${check.verified} key(s) open with ${current.id} alone; ${check.wrongKek} on another KEK; ${check.failed.length} do not open`,
  );
  for (const subject of check.failed) log(`DOES NOT OPEN: the key of ${subject}`);
  return check.wrongKek > 0 || check.failed.length > 0 ? 1 : code;
}

async function main(): Promise<void> {
  const url = resolveSecretEnv(process.env).DOCMIND_MIGRATE_URL;
  if (!url)
    throw new Error(
      "DOCMIND_MIGRATE_URL is not set (the owner role's connection string; or DOCMIND_MIGRATE_URL_FILE)",
    );
  const pool = new Pool({ connectionString: url });
  try {
    process.exitCode = await runRotation(pool, loadKeks(), {
      verifyOnly: process.argv.includes("--verify-only"),
    });
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : "key rotation failed");
    process.exit(1);
  });
}
