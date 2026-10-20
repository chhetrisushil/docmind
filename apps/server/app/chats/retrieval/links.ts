import { Uuid } from "@docmind/contracts";
import type { VectorScope } from "@docmind/vector-pg";
import type { Pool } from "pg";
import type { FieldCrypto } from "../../crypto/fields";
import { withTenant } from "../../db/tenant";
import { entityNameBind } from "../../flows/ingest-document/pgEntities";
import { type LinkKind, MAX_DEGREE } from "../../flows/ingest-document/pgLinks";

/** One followed link: `src` is a chunk the caller already holds, `dst` the chunk it leads to. */
export interface LinkHop {
  src: string;
  dst: string;
  kind: LinkKind;
  weight: number;
  /** For kind `entity`: the name of one entity both chunks mention (the rarest). Content: never logged. */
  entity?: string;
}

export const MAX_SOURCES = 64;
const isUuid = (s: string) => Uuid.safeParse(s).success;

interface Row {
  src: string;
  dst: string;
  kind: LinkKind;
  weight: number;
  entity_id: string | null;
  name_enc: unknown;
}

/**
 * Reads `chunk_links` for retrieval. Links are stored per owner, but nothing is trusted: both ends must
 * be chunks of documents the caller owns (a stray row linking to another user's chunk is invisible),
 * and an optional document list restricts the targets BEFORE the per-source cap, so a chat scoped to
 * some documents gets its fan-out from inside them.
 */
export class LinkReader {
  constructor(
    private readonly pool: Pool,
    private readonly fields: FieldCrypto,
  ) {}

  /**
   * For each source, its strongest `perChunk` links (weight, then target id, then kind), `kinds` and
   * `documentIds` applied first. Sources that are not the owner's, and malformed ids, yield nothing.
   * Results are ordered by source (as given, de-duplicated), then by rank.
   */
  async from(
    scope: VectorScope,
    chunkIds: readonly string[],
    opts: { perChunk: number; kinds?: readonly LinkKind[]; documentIds?: readonly string[] },
  ): Promise<LinkHop[]> {
    if (!Number.isInteger(opts.perChunk) || opts.perChunk < 1 || opts.perChunk > MAX_DEGREE) {
      throw new RangeError(`from: perChunk must be an integer from 1 to ${MAX_DEGREE}`);
    }
    if (chunkIds.length > MAX_SOURCES)
      throw new RangeError(`from: at most ${MAX_SOURCES} source ids`);
    const sources = [...new Set(chunkIds.map((i) => i.toLowerCase()).filter((i) => isUuid(i)))];
    const documents = opts.documentIds?.filter((i) => isUuid(i)).map((i) => i.toLowerCase());
    if (sources.length === 0 || opts.kinds?.length === 0 || documents?.length === 0) return [];
    const rows = await withTenant(this.pool, scope.tenantId, async (tx) => {
      const res = await tx.query<Row>(
        `WITH ranked AS (
           SELECT l.src_chunk_id AS src, l.dst_chunk_id AS dst, l.kind, l.weight,
                  row_number() OVER (PARTITION BY l.src_chunk_id
                                     ORDER BY l.weight DESC, l.dst_chunk_id, l.kind) AS rank
             FROM chunk_links l
             JOIN chunks sc ON sc.id = l.src_chunk_id AND sc.tenant_id = l.tenant_id
             JOIN documents sd ON sd.id = sc.document_id AND sd.tenant_id = sc.tenant_id AND sd.owner_id = $1
             JOIN chunks dc ON dc.id = l.dst_chunk_id AND dc.tenant_id = l.tenant_id
             JOIN documents dd ON dd.id = dc.document_id AND dd.tenant_id = dc.tenant_id AND dd.owner_id = $1
            WHERE l.src_chunk_id = ANY($2::uuid[])
              AND ($3::text[] IS NULL OR l.kind = ANY($3::text[]))
              AND ($4::uuid[] IS NULL OR dc.document_id = ANY($4::uuid[])))
         SELECT r.src, r.dst, r.kind, r.weight, e.id AS entity_id, e.name_enc
           FROM ranked r
           LEFT JOIN LATERAL (
             SELECT en.id, en.name_enc
               FROM chunk_entities a
               JOIN chunk_entities b ON b.tenant_id = a.tenant_id AND b.entity_id = a.entity_id AND b.chunk_id = r.dst
               JOIN entities en ON en.tenant_id = a.tenant_id AND en.id = a.entity_id AND en.owner_id = $1
              WHERE r.kind = 'entity' AND a.chunk_id = r.src
              ORDER BY (SELECT count(*) FROM chunk_entities x WHERE x.entity_id = en.id), en.id
              LIMIT 1) e ON true
          WHERE r.rank <= $5`,
        [scope.ownerId, sources, opts.kinds ?? null, documents ?? null, opts.perChunk],
      );
      return res.rows;
    });
    const cipher = this.fields.forUser(scope.ownerId);
    const order = new Map(sources.map((s, i) => [s, i]));
    const hops = await Promise.all(
      rows.map(
        async (r): Promise<LinkHop> => ({
          src: r.src,
          dst: r.dst,
          kind: r.kind,
          weight: Number(r.weight),
          ...(r.entity_id !== null && {
            entity: await cipher.openText(entityNameBind(r.entity_id), r.name_enc),
          }),
        }),
      ),
    );
    // The SQL does not promise an order; the contract does.
    return hops.sort(
      (a, b) =>
        (order.get(a.src) as number) - (order.get(b.src) as number) ||
        b.weight - a.weight ||
        (a.dst < b.dst ? -1 : a.dst > b.dst ? 1 : 0) ||
        (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
    );
  }
}
