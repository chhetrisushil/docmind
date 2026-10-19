import type { PoolClient } from "pg";
import {
  type ChunkVectorStore,
  VectorDimensionError,
  type VectorScope,
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
  ): Promise<{ chunkId: string; score: number }[]> {
    scoped(scope);
    this.check(query);
    // Cosine distance of a zero vector is NaN, which Postgres sorts above every number.
    if (limit <= 0 || query.every((x) => x === 0)) return [];
    // Exact scan of the tenant's rows by design until M4 (the HNSW index is not used by this SQL).
    return this.options.tenant(scope.tenantId, async (tx) => {
      const { rows } = await tx.query<{ id: string; score: number }>(
        `SELECT c.id, 1 - (c.embedding <=> $1::vector) AS score FROM chunks c ${JOIN_OWNER}
          WHERE d.owner_id = $2 AND c.embedding_model = $3 AND vector_norm(c.embedding) > 0
            AND 1 - (c.embedding <=> $1::vector) >= $4
          ORDER BY c.embedding <=> $1::vector, c.id LIMIT $5`,
        [literal(query), scope.ownerId, this.modelId, minScore ?? -1, limit],
      );
      return rows.map((r) => ({ chunkId: r.id, score: Number(r.score) }));
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
      throw new Error(`chunks.embedding is not vector(${this.dimensions})`);
    }
  }
}
