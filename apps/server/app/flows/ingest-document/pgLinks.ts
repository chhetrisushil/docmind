import { ParseAbortedError } from "@docmind/parsers";
import type { Pool } from "pg";
import { LINK_LOCK_EXCLUSIVE } from "../../db/entityLock";
import { withTenant } from "../../db/tenant";
import { DocumentGoneError } from "./errors";
import type { IngestStartInput } from "./flow";

export type LinkKind = "structure" | "reference" | "entity" | "similar";

export interface Link {
  src: string;
  dst: string;
  kind: LinkKind;
  weight: number;
}

/** Each chunk keeps this many strongest outgoing links. */
export const MAX_DEGREE = 24;

export interface LinkStore {
  /** Replaces every link touching the document's chunks; returns the rows left for them after capping. */
  replaceForDocument(ref: IngestStartInput, links: Link[], signal?: AbortSignal): Promise<number>;
  countForDocument(ref: IngestStartInput): Promise<number>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Both directions of every usable link, deduplicated by (src, dst, kind) at the maximum weight. */
function bothDirections(links: Link[]): Link[] {
  const best = new Map<string, Link>();
  const put = (src: string, dst: string, kind: LinkKind, weight: number) => {
    const key = `${src}|${dst}|${kind}`;
    const prev = best.get(key);
    if (!prev || weight > prev.weight) best.set(key, { src, dst, kind, weight });
  };
  for (const l of links) {
    if (!UUID.test(l.src) || !UUID.test(l.dst) || l.src.toLowerCase() === l.dst.toLowerCase()) {
      continue;
    }
    if (!(l.weight >= 1e-30)) continue;
    const w = Math.min(l.weight, 1);
    const src = l.src.toLowerCase();
    const dst = l.dst.toLowerCase();
    put(src, dst, l.kind, w);
    put(dst, src, l.kind, w);
  }
  return [...best.values()];
}

/**
 * Links are stored in both directions. The cap is per source chunk: a pruned `b->a` may leave `a->b` in
 * place, which is fine because lookups are by source. A foreign-key violation on `chunk_links_dst_fkey`
 * (another document deleted concurrently) is left transient: the step retries and the join skips the
 * vanished chunk next time.
 */
export class PgLinkStore implements LinkStore {
  constructor(private readonly pool: Pool) {}

  async replaceForDocument(
    ref: IngestStartInput,
    links: Link[],
    signal?: AbortSignal,
  ): Promise<number> {
    const rows = bothDirections(links);
    return withTenant(this.pool, ref.tenantId, async (tx) => {
      const lock = await tx.query(
        "SELECT 1 FROM documents WHERE id = $1 AND owner_id = $2 FOR KEY SHARE",
        [ref.documentId, ref.userId],
      );
      if (!lock.rowCount) throw new DocumentGoneError();
      await tx.query(LINK_LOCK_EXCLUSIVE, [ref.userId]);
      await tx.query(
        `DELETE FROM chunk_links l USING chunks c
          WHERE c.document_id = $1 AND (l.src_chunk_id = c.id OR l.dst_chunk_id = c.id)`,
        [ref.documentId],
      );
      let touched: string[] = [];
      if (rows.length > 0) {
        const res = await tx.query<{ src_chunk_id: string }>(
          `INSERT INTO chunk_links (tenant_id, src_chunk_id, dst_chunk_id, kind, weight)
           SELECT $1, sc.id, dc.id, u.kind, u.weight
             FROM unnest($2::uuid[], $3::uuid[], $4::text[], $5::real[]) AS u(src, dst, kind, weight)
             JOIN chunks sc ON sc.id = u.src AND sc.tenant_id = $1
             JOIN documents sd ON sd.id = sc.document_id AND sd.owner_id = $6
             JOIN chunks dc ON dc.id = u.dst AND dc.tenant_id = $1
             JOIN documents dd ON dd.id = dc.document_id AND dd.owner_id = $6
            WHERE sc.document_id = $7 OR dc.document_id = $7
           ON CONFLICT (tenant_id, src_chunk_id, dst_chunk_id, kind)
             DO UPDATE SET weight = GREATEST(chunk_links.weight, EXCLUDED.weight)
           RETURNING src_chunk_id`,
          [
            ref.tenantId,
            rows.map((r) => r.src),
            rows.map((r) => r.dst),
            rows.map((r) => r.kind),
            rows.map((r) => r.weight),
            ref.userId,
            ref.documentId,
          ],
        );
        touched = [...new Set(res.rows.map((r) => r.src_chunk_id))];
      }
      if (touched.length > 0) {
        await tx.query(
          `DELETE FROM chunk_links l
            USING (SELECT src_chunk_id, dst_chunk_id, kind,
                          row_number() OVER (PARTITION BY src_chunk_id ORDER BY weight DESC, dst_chunk_id, kind) AS rank
                     FROM chunk_links WHERE src_chunk_id = ANY($1::uuid[])) r
            WHERE l.src_chunk_id = r.src_chunk_id AND l.dst_chunk_id = r.dst_chunk_id AND l.kind = r.kind
              AND r.rank > $2`,
          [touched, MAX_DEGREE],
        );
      }
      // The last statement before COMMIT: an abandoned attempt rolls back.
      if (signal?.aborted) throw new ParseAbortedError();
      return countLinks(tx, ref.documentId);
    });
  }

  async countForDocument(ref: IngestStartInput): Promise<number> {
    return withTenant(this.pool, ref.tenantId, async (tx) => {
      const owned = await tx.query("SELECT 1 FROM documents WHERE id = $1 AND owner_id = $2", [
        ref.documentId,
        ref.userId,
      ]);
      if (!owned.rowCount) throw new DocumentGoneError();
      return countLinks(tx, ref.documentId);
    });
  }
}

async function countLinks(tx: { query: Pool["query"] }, documentId: string): Promise<number> {
  const { rows } = await tx.query(
    `SELECT count(*)::int AS n FROM chunk_links l JOIN chunks c ON c.id = l.src_chunk_id
      WHERE c.document_id = $1`,
    [documentId],
  );
  return rows[0]?.n ?? 0;
}
