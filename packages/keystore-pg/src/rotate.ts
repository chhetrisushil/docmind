import type { Pool } from "pg";
import type { Kek } from "./kek";
import { unwrapKey, wrapKey } from "./wrap";

export interface RotateResult {
  /** Keys re-wrapped by this run. */
  rotated: number;
  /** Subjects whose wrapped key would not open under the KEK it names; left exactly as they were. */
  failed: string[];
  /** Live keys still wrapped by some other KEK id afterwards, by id and count (an id nobody gave us, or a failure). */
  remaining: Record<string, number>;
}

/**
 * Re-wraps every live data key from the other KEKs to `keks[0]`. It needs the table itself, so it
 * connects as the migration (owner) role, not as docmind_app.
 *
 * - Safe to stop and re-run: each batch is one transaction that moves rows from an old KEK to the new
 *   one, and a row already on the new KEK is never selected, so a second run does nothing.
 * - Tombstones (destroyed subjects, no key material) are never selected or changed.
 * - A data key exists in memory only between unwrap and wrap, and nothing here prints or returns one.
 * - A row that will not open is reported in `failed`, skipped, and left untouched.
 */
export async function rotateKek(
  pool: Pool,
  keks: readonly [Kek, ...Kek[]],
  batchSize = 100,
): Promise<RotateResult> {
  const [target] = keks;
  const byId = new Map(keks.map((k) => [k.id, k]));
  const failed = new Set<string>();
  let rotated = 0;

  for (;;) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{
        subject_id: string;
        wrapped_dek: Buffer;
        kek_id: string;
      }>(
        `SELECT subject_id, wrapped_dek, kek_id FROM data_keys
          WHERE wrapped_dek IS NOT NULL AND kek_id <> $1 AND kek_id = ANY ($2::text[])
            AND subject_id <> ALL ($3::text[])
          ORDER BY subject_id LIMIT $4 FOR UPDATE SKIP LOCKED`,
        [target.id, [...byId.keys()], [...failed], batchSize],
      );
      for (const row of rows) {
        let rewrapped: Buffer;
        try {
          const dek = unwrapKey((byId.get(row.kek_id) as Kek).key, row.subject_id, row.wrapped_dek);
          rewrapped = wrapKey(target.key, row.subject_id, dek);
        } catch {
          failed.add(row.subject_id); // will not open under the KEK it names: report it, change nothing
          continue;
        }
        await client.query(
          "UPDATE data_keys SET wrapped_dek = $2, kek_id = $3 WHERE subject_id = $1",
          [row.subject_id, rewrapped, target.id],
        );
        rotated++;
      }
      await client.query("COMMIT");
      if (rows.length === 0) break;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  const { rows } = await pool.query<{ kek_id: string; n: string }>(
    `SELECT kek_id, count(*) AS n FROM data_keys
      WHERE wrapped_dek IS NOT NULL AND kek_id <> $1 GROUP BY kek_id`,
    [target.id],
  );
  return {
    rotated,
    failed: [...failed].sort(),
    remaining: Object.fromEntries(rows.map((r) => [r.kek_id, Number(r.n)])),
  };
}

export interface VerifyResult {
  /** Live keys that open with `kek` alone. */
  verified: number;
  /** Live keys wrapped under a different KEK id. */
  wrongKek: number;
  /** Live keys that name `kek` but do not open. */
  failed: string[];
}

/** Checks, with only `kek`, that every live key opens: what must hold before the old KEK is retired. */
export async function verifyKeys(pool: Pool, kek: Kek): Promise<VerifyResult> {
  const { rows } = await pool.query<{ subject_id: string; wrapped_dek: Buffer; kek_id: string }>(
    "SELECT subject_id, wrapped_dek, kek_id FROM data_keys WHERE wrapped_dek IS NOT NULL ORDER BY subject_id",
  );
  const result: VerifyResult = { verified: 0, wrongKek: 0, failed: [] };
  for (const row of rows) {
    if (row.kek_id !== kek.id) result.wrongKek++;
    else {
      try {
        unwrapKey(kek.key, row.subject_id, row.wrapped_dek);
        result.verified++;
      } catch {
        result.failed.push(row.subject_id);
      }
    }
  }
  return result;
}
