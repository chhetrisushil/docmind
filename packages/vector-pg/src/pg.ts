import type { PoolClient } from "pg";
import { type ChunkVectorStore, VectorDimensionError, type VectorScope } from "./types";

export interface PgVectorOptions {
  tenant: <T>(tenantId: string, fn: (tx: PoolClient) => Promise<T>) => Promise<T>;
  modelId: string;
  dimensions: number;
}

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
    if (v.length !== this.dimensions || !v.every(Number.isFinite)) throw new VectorDimensionError();
  }

  async upsert(
    scope: VectorScope,
    documentId: string,
    items: { chunkId: string; vector: readonly number[] }[],
  ): Promise<{ written: number; missing: string[] }> {
    for (const item of items) this.check(item.vector);
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

  missing(scope: VectorScope, documentId: string, limit: number): Promise<string[]> {
    if (limit <= 0) return Promise.resolve([]);
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
    this.check(query);
    // Cosine distance of a zero vector is NaN, which Postgres sorts above every number.
    if (limit <= 0 || query.every((x) => x === 0)) return [];
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
}
