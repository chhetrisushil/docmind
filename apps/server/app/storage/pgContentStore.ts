import {
  type ContentListPage,
  type ContentListPageOptions,
  type ContentRef,
  type ContentStore,
  contentAddress,
  contentListPageLimit,
} from "@loom/plugin-content";
import type { Pool } from "pg";

export interface PgContentStoreOptions {
  /** Clock for touch times (epoch ms). Default: the database's clock, so nodes never disagree. */
  now?: () => number;
}

// The database clock in epoch ms, used when no `now` is given. `$1::bigint` null means "use it".
const DB_NOW = "floor(extract(epoch from clock_timestamp()) * 1000)::bigint";
const STAMP = `coalesce($1::bigint, ${DB_NOW})`;

/**
 * A durable, multi-subject `ContentStore` in Postgres (`lineage_content`, migration 0027).
 *
 * It holds exactly the bytes it is handed and ignores `ContentAccess`. It is only ever used UNDERNEATH
 * `EncryptingContentStore` (see `sealedLineageContent`), so those bytes are ciphertext; never give a `Lineage`
 * this store directly. Implements the whole SPI 1.3.0/1.4.0 optional set (the touch-based orphan sweep).
 */
export class PgContentStore implements ContentStore {
  private readonly now: () => number | null;

  constructor(
    private readonly pool: Pool,
    options: PgContentStoreOptions = {},
  ) {
    this.now = options.now ?? (() => null);
  }

  async put(bytes: Uint8Array): Promise<ContentRef> {
    const address = contentAddress(bytes);
    await this.pool.query(
      `INSERT INTO lineage_content (address, bytes, touched_ms) VALUES ($2, $3, ${STAMP})
       ON CONFLICT (address) DO UPDATE SET touched_ms = greatest(lineage_content.touched_ms, EXCLUDED.touched_ms)`,
      [this.now(), address, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)],
    );
    return { __loomContent: address, size: bytes.byteLength };
  }

  async putStream(stream: AsyncIterable<Uint8Array>): Promise<ContentRef> {
    // The blob is one bytea row, so it is materialized here; the address is of the whole sequence.
    const chunks: Buffer[] = [];
    for await (const chunk of stream)
      chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    return this.put(Buffer.concat(chunks));
  }

  async get(ref: ContentRef): Promise<Uint8Array | null> {
    const { rows } = await this.pool.query<{ bytes: Buffer }>(
      "SELECT bytes FROM lineage_content WHERE address = $1",
      [ref.__loomContent],
    );
    return rows[0] ? new Uint8Array(rows[0].bytes) : null;
  }

  async getMany(refs: readonly ContentRef[]): Promise<(Uint8Array | null)[]> {
    if (refs.length === 0) return [];
    const { rows } = await this.pool.query<{ address: string; bytes: Buffer }>(
      "SELECT address, bytes FROM lineage_content WHERE address = ANY($1::text[])",
      [[...new Set(refs.map((r) => r.__loomContent))]],
    );
    const byAddress = new Map(rows.map((r) => [r.address, new Uint8Array(r.bytes)]));
    return refs.map((r) => byAddress.get(r.__loomContent) ?? null);
  }

  async delete(ref: ContentRef): Promise<void> {
    await this.pool.query("DELETE FROM lineage_content WHERE address = $1", [ref.__loomContent]);
  }

  async deleteIfUntouchedSince(ref: ContentRef, cutoffMs: number): Promise<boolean> {
    const res = await this.pool.query(
      "DELETE FROM lineage_content WHERE address = $1 AND touched_ms < $2",
      [ref.__loomContent, cutoffMs],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async touchClock(): Promise<number> {
    const stamp = this.now();
    if (stamp !== null) return stamp;
    const { rows } = await this.pool.query<{ ms: string }>(`SELECT ${DB_NOW} AS ms`);
    return Number(rows[0]?.ms);
  }

  async touch(addresses: readonly string[]): Promise<string[]> {
    if (addresses.length === 0) return [];
    const { rows } = await this.pool.query<{ address: string }>(
      `UPDATE lineage_content SET touched_ms = greatest(touched_ms, ${STAMP})
       WHERE address = ANY($2::text[]) RETURNING address`,
      [this.now(), [...new Set(addresses)]],
    );
    const present = new Set(rows.map((r) => r.address));
    return [...new Set(addresses)].filter((a) => !present.has(a));
  }

  async listPage(opts: ContentListPageOptions = {}): Promise<ContentListPage> {
    const limit = contentListPageLimit(opts.limit);
    const { rows } = await this.pool.query<{ address: string; touched_ms: string }>(
      `SELECT address, touched_ms FROM lineage_content
       WHERE ($1::text IS NULL OR address > $1)
         AND ($2::bigint IS NULL OR touched_ms < $2)
       ORDER BY address LIMIT $3`,
      [opts.cursor ?? null, opts.touchedBefore ?? null, limit + 1],
    );
    const page = rows.slice(0, limit);
    const entries = page.map((r) => ({ address: r.address, touchedAt: Number(r.touched_ms) }));
    const last = page[page.length - 1];
    return rows.length > limit && last ? { entries, nextCursor: last.address } : { entries };
  }
}
