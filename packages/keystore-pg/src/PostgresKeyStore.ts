import { randomBytes } from "node:crypto";
import type { KeyStore } from "@loom/plugin-crypto";
import type { Pool } from "pg";
import type { Kek } from "./kek";
import { unwrapKey, wrapKey } from "./wrap";

interface KeyRow {
  dek: Buffer;
  kek: string;
}

/**
 * Loom's KeyStore on Postgres: one random data key per subject (a user), stored wrapped by a KEK and
 * reached only through the key_* SQL functions (migration 0007). `destroy` leaves a tombstone, and
 * the database never mints a key for a tombstoned subject.
 */
export class PostgresKeyStore implements KeyStore {
  readonly durable = true;
  private readonly byId = new Map<string, Kek>();
  /** `keks[0]` wraps new keys; the others only unwrap (rotation). */
  constructor(
    private readonly pool: Pool,
    private readonly keks: readonly [Kek, ...Kek[]],
  ) {
    if (keks.length === 0) throw new Error("at least one KEK is required");
    for (const k of keks) {
      if (this.byId.has(k.id)) throw new Error(`duplicate KEK id "${k.id}"`);
      this.byId.set(k.id, k);
    }
  }

  async getOrCreate(subjectId: string): Promise<Buffer> {
    const existing = await this.row(subjectId);
    if (existing) return this.open(subjectId, existing);
    const [active] = this.keks;
    const wrapped = wrapKey(active.key, subjectId, randomBytes(32));
    // Of two racing creators the database keeps one row and returns it to both.
    const { rows } = await this.pool.query<KeyRow>("SELECT * FROM public.key_put($1, $2, $3)", [
      subjectId,
      wrapped,
      active.id,
    ]);
    return this.open(subjectId, rows[0] as KeyRow);
  }

  async get(subjectId: string): Promise<Buffer | null> {
    const row = await this.row(subjectId);
    return row ? this.open(subjectId, row) : null;
  }

  /** Tombstones the subject; older copies (dead rows, WAL, backups) stay until the old KEK is retired. */
  async destroy(subjectId: string): Promise<void> {
    await this.pool.query("SELECT public.key_destroy($1)", [subjectId]);
  }

  async wasDestroyed(subjectId: string): Promise<boolean> {
    const { rows } = await this.pool.query("SELECT public.key_was_destroyed($1) AS destroyed", [
      subjectId,
    ]);
    return rows[0].destroyed;
  }

  private async row(subjectId: string): Promise<KeyRow | undefined> {
    const { rows } = await this.pool.query<KeyRow>("SELECT * FROM public.key_get($1)", [subjectId]);
    return rows[0];
  }

  private open(subjectId: string, row: KeyRow): Buffer {
    const kek = this.byId.get(row.kek);
    if (!kek) throw new Error(`the key for "${subjectId}" is wrapped by unknown KEK "${row.kek}"`);
    return unwrapKey(kek.key, subjectId, row.dek);
  }
}
