import type { PoolClient } from "pg";
import {
  type ChunkVectorStore,
  type SearchFilter,
  VectorDimensionError,
  VectorSchemaError,
  type VectorScope,
  checkNeighbourParams,
  checkSearchFilter,
  checkVectorIds,
  isValidVector,
} from "./types";

export interface PgVectorOptions {
  tenant: <T>(tenantId: string, fn: (tx: PoolClient) => Promise<T>) => Promise<T>;
  modelId: string;
  dimensions: number;
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

export class PgChunkVectorStore implements ChunkVectorStore {
  readonly modelId: string;
  readonly dimensions: number;
  constructor(private readonly options: PgVectorOptions) {
    this.modelId = options.modelId;
    this.dimensions = options.dimensions;
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
    // Exact scan of the tenant's rows by design until Task 137 (the HNSW index is not used by this SQL).
    return this.options.tenant(scope.tenantId, async (tx) => {
      const { rows } = await tx.query<{ id: string; score: number }>(
        `SELECT c.id, 1 - (c.embedding <=> $1::vector) AS score FROM chunks c ${JOIN_OWNER}
          WHERE d.owner_id = $2 AND c.embedding_model = $3 AND vector_norm(c.embedding) > 0
            AND 1 - (c.embedding <=> $1::vector) >= $4
            ${documentIds ? "AND c.document_id = ANY($6::uuid[])" : ""}
          ORDER BY c.embedding <=> $1::vector, c.id LIMIT $5`,
        [
          literal(query),
          scope.ownerId,
          this.modelId,
          minScore ?? -1,
          limit,
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
    const found = await this.options.tenant(tenantId, async (tx) => {
      const { rows } = await tx.query<{ t: string }>(
        "SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = 'chunks'::regclass AND attname = 'embedding'",
      );
      return rows[0]?.t;
    });
    if (found !== `vector(${this.dimensions})`) {
      throw new VectorSchemaError(this.dimensions);
    }
  }
}
