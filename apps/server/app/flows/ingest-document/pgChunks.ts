import { ParseAbortedError } from "@docmind/parsers";
import type { Pool, PoolClient } from "pg";
import type { FieldCrypto } from "../../crypto/fields";
import { withTenant } from "../../db/tenant";
import { type Chunk, chunkIdFor } from "./chunker";
import { DocumentGoneError } from "./errors";
import type { IngestStartInput } from "./flow";

export const chunkBind = (chunkId: string) => `chunk:${chunkId}:text`;

export interface ChunkStore {
  /**
   * `signal` is the attempt's: if it aborted (the attempt timed out or was cancelled), the transaction
   * rolls back instead of committing, so an abandoned attempt never writes after its successor.
   */
  replace(ref: IngestStartInput, chunks: Chunk[], signal?: AbortSignal): Promise<number>;
  count(ref: IngestStartInput): Promise<number>;
  read(ref: IngestStartInput, ids: string[]): Promise<{ id: string; text: string }[]>;
}

const OWNED = "EXISTS (SELECT 1 FROM documents d WHERE d.id = $1 AND d.owner_id = $2)";

/** Owner-scoped FOR KEY SHARE: a concurrent DELETE waits, then cascades our rows. Not found is gone. */
async function lockDocument(tx: PoolClient, ref: IngestStartInput) {
  const { rowCount } = await tx.query(
    "SELECT 1 FROM documents WHERE id = $1 AND owner_id = $2 FOR KEY SHARE",
    [ref.documentId, ref.userId],
  );
  if (!rowCount) throw new DocumentGoneError();
}

export class PgChunkStore implements ChunkStore {
  constructor(
    private readonly pool: Pool,
    private readonly fields: FieldCrypto,
  ) {}

  async replace(ref: IngestStartInput, chunks: Chunk[], signal?: AbortSignal): Promise<number> {
    const cipher = this.fields.forUser(ref.userId);
    const ids = chunks.map((c) => chunkIdFor(ref.documentId, c.ordinal));
    const sealed = await Promise.all(
      chunks.map((c, i) =>
        cipher.seal(chunkBind(ids[i] as string), { text: c.text, headingPath: c.headingPath }),
      ),
    );
    await withTenant(this.pool, ref.tenantId, async (tx) => {
      await lockDocument(tx, ref);
      await tx.query("DELETE FROM chunks WHERE document_id = $1", [ref.documentId]);
      if (chunks.length > 0) await insertChunks(tx);
      // The last statement before COMMIT: an abandoned attempt rolls back.
      if (signal?.aborted) throw new ParseAbortedError();
    });
    return chunks.length;

    async function insertChunks(tx: PoolClient) {
      await tx.query(
        `INSERT INTO chunks (id, tenant_id, document_id, ordinal, section_ordinal, text_enc, locator, token_count)
         SELECT u.id, $1, $2, u.ordinal, u.section, u.text_enc::jsonb, u.locator::jsonb, u.tokens
           FROM unnest($3::uuid[], $4::int[], $5::int[], $6::text[], $7::text[], $8::int[])
             AS u(id, ordinal, section, text_enc, locator, tokens)`,
        [
          ref.tenantId,
          ref.documentId,
          ids,
          chunks.map((c) => c.ordinal),
          chunks.map((c) => c.sectionOrdinal),
          sealed.map((s) => JSON.stringify(s)),
          chunks.map((c) => JSON.stringify(c.locator)),
          chunks.map((c) => c.tokenCount),
        ],
      );
    }
  }

  async count(ref: IngestStartInput): Promise<number> {
    // One statement, one snapshot: the ownership check and the count cannot straddle a delete.
    const row = await withTenant(this.pool, ref.tenantId, async (tx) => {
      const { rows } = await tx.query<{ owned: boolean; n: number }>(
        `SELECT ${OWNED} AS owned, (SELECT count(*)::int FROM chunks WHERE document_id = $1) AS n`,
        [ref.documentId, ref.userId],
      );
      return rows[0];
    });
    if (!row?.owned) throw new DocumentGoneError();
    return row.n;
  }

  async read(ref: IngestStartInput, ids: string[]): Promise<{ id: string; text: string }[]> {
    // One statement: the ownership check and the rows share a snapshot. Ids compare as text, so a
    // malformed id is a miss and no driver error echoes it.
    const rows = await withTenant(this.pool, ref.tenantId, async (tx) => {
      const res = await tx.query<{ owned: boolean; id: string | null; text_enc: unknown }>(
        `SELECT o.owned, c.id, c.text_enc FROM (SELECT ${OWNED} AS owned) o
           LEFT JOIN chunks c ON o.owned AND c.document_id = $1 AND c.id::text = ANY($3::text[])
          ORDER BY c.ordinal`,
        [ref.documentId, ref.userId, ids],
      );
      return res.rows;
    });
    if (!rows[0]?.owned) throw new DocumentGoneError();
    const cipher = this.fields.forUser(ref.userId);
    const found = rows.filter((r): r is typeof r & { id: string } => r.id !== null);
    return Promise.all(
      found.map(async (r) => {
        const opened = await cipher.open(chunkBind(r.id), r.text_enc);
        // A fixed message: a schema error could carry decrypted content.
        if (
          typeof opened !== "object" ||
          opened === null ||
          typeof (opened as { text?: unknown }).text !== "string"
        )
          throw new Error("the stored chunk has an invalid shape");
        return { id: r.id, text: (opened as { text: string }).text };
      }),
    );
  }
}
