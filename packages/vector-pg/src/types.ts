/** The caller's identity. Every port method takes it; nothing is read without it. */
export interface VectorScope {
  tenantId: string;
  ownerId: string;
}

/**
 * Vectors for existing chunk rows. The port carries ids, vectors and the model id
 * only, never chunk text. Chunk ids that are not the scope's own rows (unknown, or
 * another owner's) are invisible: `upsert` reports them as `missing` and writes
 * nothing, `missing` and `search` never return them.
 */
export interface ChunkVectorStore {
  readonly modelId: string;
  readonly dimensions: number;
  /**
   * Sets the vector of each listed chunk of `documentId` (an update of a known row,
   * never an insert). Every vector is validated first; one bad vector rejects the
   * whole call with VectorDimensionError and writes nothing. Ids that are not the
   * scope's chunks of that document come back in `missing`. A repeated id in one call
   * is written once (the last vector wins), counted once, and reported once.
   */
  upsert(
    scope: VectorScope,
    documentId: string,
    items: { chunkId: string; vector: readonly number[] }[],
  ): Promise<{ written: number; missing: string[] }>;
  /** Chunk ids of the document, in ordinal order, with no vector for this modelId; at most `limit`. */
  missing(scope: VectorScope, documentId: string, limit: number): Promise<string[]>;
  /** Cosine similarity over the scope's vectors of this modelId, best first, ties by chunkId. */
  search(
    scope: VectorScope,
    query: readonly number[],
    limit: number,
    minScore?: number,
  ): Promise<{ chunkId: string; score: number }[]>;
}

/** Largest magnitude float4 (pgvector's element type) holds; beyond it Postgres rejects the value. */
export const FLOAT4_MAX = 3.4028234663852886e38;

/** True when `vector` has `dimensions` elements, each finite and within float4 range. */
export const isValidVector = (vector: readonly number[], dimensions: number): boolean =>
  vector.length === dimensions &&
  vector.every((x) => Number.isFinite(x) && Math.abs(x) <= FLOAT4_MAX);

export class VectorDimensionError extends Error {
  constructor() {
    super("vector has the wrong size or a non-finite value");
    this.name = "VectorDimensionError";
  }
}
