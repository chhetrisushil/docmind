import type { PoolClient } from "pg";
import {
  type ChunkVectorStore,
  type SearchFilter,
  VectorDimensionError,
  VectorSchemaError,
  type VectorScope,
  VectorVersionError,
  checkNeighbourParams,
  checkSearchFilter,
  checkVectorIds,
  isValidVector,
} from "./types";

export interface PgVectorOptions {
  tenant: <T>(tenantId: string, fn: (tx: PoolClient) => Promise<T>) => Promise<T>;
  modelId: string;
  dimensions: number;
  /** `hnsw.ef_search` for every search: the width of the index scan. An integer from 10 to 1000; default 100. */
  efSearch?: number;
}

/** The first pgvector with iterative index scans. */
export const MIN_PGVECTOR = [0, 8, 0] as const;

/** True when `version` ("0.8.0", "0.10.1", ...) is at least `min`, compared number by number. */
export function atLeast(version: string, min: readonly [number, number, number]): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const have = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (const [i, want] of min.entries()) {
    if ((have[i] as number) !== want) return (have[i] as number) > want;
  }
  return true;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Fixed message naming the variable, never its value (Postgres would echo a bad uuid). */
const uuid = (name: string, v: string): void => {
  if (!UUID.test(v)) throw new Error(`PgChunkVectorStore: ${name} must be a uuid`);
};
const scoped = (scope: VectorScope): void => {
  uuid("tenantId", scope.tenantId);
  uuid("ownerId", scope.ownerId);
};

/** pgvector's text form. Always sent as a bind parameter, never interpolated. */
const literal = (v: readonly number[]) => `[${v.join(",")}]`;

/**
 * Owner scoping: chunks carry no owner, so every statement joins `documents`. Row-level security
 * (the composed `tenant`) is the tenant fence; `d.owner_id` is the owner fence.
 */
const JOIN_OWNER = "JOIN documents d ON d.id = c.document_id AND d.tenant_id = c.tenant_id";

/**
 * The search statement: $1 query vector, $2 owner, $3 model id, $4 limit, $5 largest distance
 * (1 - minScore), and with `withDocuments` $6 the document ids.
 *
 * It is shaped for the HNSW index (`chunks_embedding_hnsw`): the CTE orders by the bare distance
 * operator, so the planner can walk the index, and `hnsw.iterative_scan = relaxed_order` (set by
 * `search`) keeps walking until `LIMIT` rows pass the owner, model and document filters. Relaxed order
 * may emit rows slightly out of order, so the outer query sorts again. The score floor is applied
 * outside the CTE: a filter on the distance inside it would stop the planner from using the index. It
 * drops zero vectors too (their cosine distance is NaN, which compares greater than any number).
 */
export function searchSql(withDocuments: boolean): string {
  return `WITH hits AS MATERIALIZED (
  SELECT c.id, c.embedding <=> $1::vector AS distance
    FROM chunks c ${JOIN_OWNER}
   WHERE d.owner_id = $2 AND c.embedding_model = $3
     ${withDocuments ? "AND c.document_id = ANY($6::uuid[])" : ""}
   ORDER BY c.embedding <=> $1::vector
   LIMIT $4)
SELECT id, 1 - distance AS score FROM hits WHERE distance <= $5 ORDER BY distance, id`;
}

export class PgChunkVectorStore implements ChunkVectorStore {
  readonly modelId: string;
  readonly dimensions: number;
  private readonly efSearch: number;
  constructor(private readonly options: PgVectorOptions) {
    this.modelId = options.modelId;
    this.dimensions = options.dimensions;
    this.efSearch = options.efSearch ?? 100;
    if (!Number.isInteger(this.efSearch) || this.efSearch < 10 || this.efSearch > 1000) {
      throw new RangeError("PgChunkVectorStore: efSearch must be an integer from 10 to 1000");
    }
  }

  private check(v: readonly number[]): void {
    if (!isValidVector(v, this.dimensions)) throw new VectorDimensionError();
  }

  async upsert(
    scope: VectorScope,
    documentId: string,
    items: { chunkId: string; vector: readonly number[] }[],
  ): Promise<{ written: number; missing: string[] }> {
    scoped(scope);
    uuid("documentId", documentId);
    for (const item of items) {
      uuid("chunkId", item.chunkId);
      this.check(item.vector);
    }
    // One row per id (the last vector wins): UPDATE ... FROM with a repeated key picks arbitrarily.
    const last = new Map<string, readonly number[]>();
    for (const item of items) last.set(item.chunkId, item.vector);
    if (last.size === 0) return { written: 0, missing: [] };
    const chunkIds = [...last.keys()];
    return this.options.tenant(scope.tenantId, async (tx) => {
      // Three array parameters however many items: far below the 65535-parameter limit.
      const { rows } = await tx.query<{ id: string }>(
        `UPDATE chunks c SET embedding = u.v::vector, embedding_model = $4
           FROM unnest($1::uuid[], $2::text[]) AS u(id, v), documents d
          WHERE c.id = u.id AND c.document_id = $3
            AND d.id = c.document_id AND d.tenant_id = c.tenant_id AND d.owner_id = $5
          RETURNING c.id`,
        [chunkIds, [...last.values()].map(literal), documentId, this.modelId, scope.ownerId],
      );
      const written = new Set(rows.map((r) => r.id));
      return { written: written.size, missing: chunkIds.filter((id) => !written.has(id)) };
    });
  }

  async missing(scope: VectorScope, documentId: string, limit: number): Promise<string[]> {
    scoped(scope);
    uuid("documentId", documentId);
    if (limit <= 0) return [];
    return this.options.tenant(scope.tenantId, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT c.id FROM chunks c ${JOIN_OWNER}
          WHERE c.document_id = $1 AND d.owner_id = $2
            AND (c.embedding IS NULL OR c.embedding_model <> $3)
          ORDER BY c.ordinal LIMIT $4`,
        [documentId, scope.ownerId, this.modelId, limit],
      );
      return rows.map((r) => r.id);
    });
  }

  async search(
    scope: VectorScope,
    query: readonly number[],
    limit: number,
    minScore?: number,
    filter?: SearchFilter,
  ): Promise<{ chunkId: string; score: number }[]> {
    scoped(scope);
    this.check(query);
    checkSearchFilter(filter);
    const documentIds = filter?.documentIds;
    for (const id of documentIds ?? []) uuid("documentIds", id);
    // Cosine distance of a zero vector is NaN, which Postgres sorts above every number.
    if (limit <= 0 || query.every((x) => x === 0) || documentIds?.length === 0) return [];
    // Iterative scan: keep walking the index until `limit` rows pass the owner, model and document
    // filters (searchSql). ef_search is at least `limit`; pgvector accepts at most 1000.
    const ef = Math.min(1000, Math.max(this.efSearch, limit));
    return this.options.tenant(scope.tenantId, async (tx) => {
      await tx.query(
        "SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true), set_config('hnsw.ef_search', $1, true)",
        [String(ef)],
      );
      const { rows } = await tx.query<{ id: string; score: number }>(
        searchSql(documentIds !== undefined),
        [
          literal(query),
          scope.ownerId,
          this.modelId,
          limit,
          1 - (minScore ?? -1),
          ...(documentIds ? [documentIds] : []),
        ],
      );
      return rows.map((r) => ({ chunkId: r.id, score: Number(r.score) }));
    });
  }

  async vectors(scope: VectorScope, chunkIds: readonly string[]): Promise<Map<string, number[]>> {
    scoped(scope);
    checkVectorIds(chunkIds);
    const out = new Map<string, number[]>();
    if (chunkIds.length === 0) return out;
    // Ids compare as text, so a malformed id is a miss rather than a cast error.
    return this.options.tenant(scope.tenantId, async (tx) => {
      const { rows } = await tx.query<{ id: string; v: string }>(
        `SELECT c.id, c.embedding::text AS v FROM chunks c ${JOIN_OWNER}
          WHERE d.owner_id = $1 AND c.embedding_model = $2 AND c.id::text = ANY($3::text[])
            AND vector_norm(c.embedding) > 0`,
        [scope.ownerId, this.modelId, [...new Set(chunkIds)]],
      );
      for (const r of rows) out.set(r.id, JSON.parse(r.v) as number[]); // pgvector's text form is a JSON array
      return out;
    });
  }

  async neighbours(
    scope: VectorScope,
    documentId: string,
    chunkIds: string[],
    perChunk: number,
    minScore: number,
  ): Promise<{ chunkId: string; neighbourId: string; score: number }[]> {
    scoped(scope);
    uuid("documentId", documentId);
    checkNeighbourParams(perChunk, minScore);
    if (chunkIds.length === 0) return [];
    // Exact scan per source chunk (the HNSW index is not used by this SQL); the link step batches 64
    // sources. M4's index-friendly search (part 1 carry: iterative HNSW scan) will serve it too.
    // Ids compare as text, so a malformed id is a miss rather than a cast error.
    return this.options.tenant(scope.tenantId, async (tx) => {
      const { rows } = await tx.query<{ chunk_id: string; neighbour_id: string; score: number }>(
        `SELECT s.id AS chunk_id, n.id AS neighbour_id, n.score
           FROM chunks s
           JOIN documents sd ON sd.id = s.document_id AND sd.tenant_id = s.tenant_id AND sd.owner_id = $2
          CROSS JOIN LATERAL (
            SELECT c.id, 1 - (c.embedding <=> s.embedding) AS score
              FROM chunks c ${JOIN_OWNER}
             WHERE d.owner_id = $2 AND c.document_id <> $1 AND c.embedding_model = $3
               AND vector_norm(c.embedding) > 0
             ORDER BY c.embedding <=> s.embedding, c.id
             LIMIT $5) n
          WHERE s.document_id = $1 AND s.id::text = ANY($4::text[])
            AND s.embedding_model = $3 AND vector_norm(s.embedding) > 0
            AND n.score >= $6
          ORDER BY s.id, n.score DESC, n.id`,
        [documentId, scope.ownerId, this.modelId, chunkIds, perChunk, minScore],
      );
      return rows.map((r) => ({
        chunkId: r.chunk_id,
        neighbourId: r.neighbour_id,
        score: Number(r.score),
      }));
    });
  }

  /** Boot check. `tenantId` only opens a tenant transaction; any uuid that owns no rows will do. */
  async verify(tenantId: string): Promise<void> {
    const { type, version } = await this.options.tenant(tenantId, async (tx) => {
      const col = await tx.query<{ t: string }>(
        "SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = 'chunks'::regclass AND attname = 'embedding'",
      );
      const ext = await tx.query<{ v: string }>(
        "SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'",
      );
      return { type: col.rows[0]?.t, version: ext.rows[0]?.v };
    });
    if (type !== `vector(${this.dimensions})`) {
      throw new VectorSchemaError(this.dimensions);
    }
    if (version === undefined || !atLeast(version, MIN_PGVECTOR)) throw new VectorVersionError();
  }
}
