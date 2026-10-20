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
  /**
   * Cosine similarity over the scope's vectors of this modelId, best first, ties by chunkId.
   * `filter.documentIds` keeps only chunks of those documents (still only the scope's own: an id of
   * another owner's document matches nothing); `[]` matches nothing, absent means every document.
   * `limit` is applied after the filter.
   */
  search(
    scope: VectorScope,
    query: readonly number[],
    limit: number,
    minScore?: number,
    filter?: SearchFilter,
  ): Promise<{ chunkId: string; score: number }[]>;
  /**
   * The stored vectors of the listed chunks, for re-ranking (MMR). Owner-scoped like `search`: an
   * unknown id, another owner's or tenant's chunk, a chunk with no vector for this modelId and a zero
   * vector are absent from the map. At most `MAX_VECTOR_IDS` ids (RangeError otherwise).
   */
  vectors(scope: VectorScope, chunkIds: readonly string[]): Promise<Map<string, number[]>>;
  /**
   * For each listed chunk of `documentId` (the scope's own), its nearest chunks among the scope's OTHER
   * documents, by cosine similarity over this modelId's vectors: at most `perChunk` each, score >= minScore,
   * best first, ties by neighbour id. Unknown, foreign or unembedded source ids yield nothing.
   * `perChunk` is an integer from 1 to 100 and `minScore` is finite in [-1, 1]; otherwise RangeError.
   */
  neighbours(
    scope: VectorScope,
    documentId: string,
    chunkIds: string[],
    perChunk: number,
    minScore: number,
  ): Promise<{ chunkId: string; neighbourId: string; score: number }[]>;
}

/** Restricts `search` to some documents. */
export interface SearchFilter {
  documentIds?: readonly string[];
}

export const MAX_FILTER_DOCUMENTS = 1000;
export const MAX_VECTOR_IDS = 1000;

/** Shared by both stores. The messages name the parameter, never a value. */
export function checkSearchFilter(filter: SearchFilter | undefined): void {
  if (filter?.documentIds && filter.documentIds.length > MAX_FILTER_DOCUMENTS) {
    throw new RangeError(`search: filter.documentIds is limited to ${MAX_FILTER_DOCUMENTS} ids`);
  }
}

export function checkVectorIds(chunkIds: readonly string[]): void {
  if (chunkIds.length > MAX_VECTOR_IDS) {
    throw new RangeError(`vectors: at most ${MAX_VECTOR_IDS} ids`);
  }
}

/** Shared by both stores so they reject the same inputs. The message names the parameter, never a value. */
export function checkNeighbourParams(perChunk: number, minScore: number): void {
  if (!Number.isInteger(perChunk) || perChunk < 1 || perChunk > 100) {
    throw new RangeError("neighbours: perChunk must be an integer from 1 to 100");
  }
  if (!Number.isFinite(minScore) || minScore < -1 || minScore > 1) {
    throw new RangeError("neighbours: minScore must be a finite number in [-1, 1]");
  }
}

/** Largest magnitude float4 (pgvector's element type) holds; beyond it Postgres rejects the value. */
export const FLOAT4_MAX = 3.4028234663852886e38;

/** True when `vector` has `dimensions` elements, each finite and within float4 range. */
export const isValidVector = (vector: readonly number[], dimensions: number): boolean =>
  vector.length === dimensions &&
  vector.every((x) => Number.isFinite(x) && Math.abs(x) <= FLOAT4_MAX);

/** The `chunks.embedding` column is not `vector(<dimensions>)`: a deployment fault. The message carries configuration only, never data. */
export class VectorSchemaError extends Error {
  constructor(dimensions: number) {
    super(`chunks.embedding is not vector(${dimensions})`);
    this.name = "VectorSchemaError";
  }
}

export class VectorDimensionError extends Error {
  constructor() {
    super("vector has the wrong size or a non-finite value");
    this.name = "VectorDimensionError";
  }
}
