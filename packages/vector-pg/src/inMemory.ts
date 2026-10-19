import { type ChunkVectorStore, VectorDimensionError, type VectorScope } from "./types";

type Row = { vector: number[]; model: string };

export interface InMemoryOptions {
  modelId: string;
  dimensions: number;
  /** The document's chunk ids in ordinal order: the stand-in for the `chunks` table. It must be owner-scoped like the table (another owner's document lists nothing). */
  chunkIds: (scope: VectorScope, documentId: string) => Promise<string[]>;
  /** Rows shared between instances (different modelId over the same rows, to test re-embedding). */
  shared?: Map<string, Row>;
}

const prefix = (scope: VectorScope): string => JSON.stringify([scope.tenantId, scope.ownerId]);

export class InMemoryChunkVectors implements ChunkVectorStore {
  readonly modelId: string;
  readonly dimensions: number;
  private readonly rows: Map<string, Row>;
  private readonly lister: InMemoryOptions["chunkIds"];

  constructor(options: InMemoryOptions) {
    this.modelId = options.modelId;
    this.dimensions = options.dimensions;
    this.lister = options.chunkIds;
    this.rows = options.shared ?? new Map();
  }

  private check(vector: readonly number[]): void {
    if (vector.length !== this.dimensions || !vector.every(Number.isFinite)) {
      throw new VectorDimensionError();
    }
  }

  async upsert(
    scope: VectorScope,
    documentId: string,
    items: { chunkId: string; vector: readonly number[] }[],
  ): Promise<{ written: number; missing: string[] }> {
    for (const item of items) this.check(item.vector);
    const known = new Set(await this.lister(scope, documentId));
    const last = new Map<string, readonly number[]>();
    for (const item of items) last.set(item.chunkId, item.vector);
    let written = 0;
    const missing: string[] = [];
    for (const [chunkId, vector] of last) {
      if (!known.has(chunkId)) {
        missing.push(chunkId);
        continue;
      }
      this.rows.set(prefix(scope) + chunkId, { vector: [...vector], model: this.modelId });
      written += 1;
    }
    return { written, missing };
  }

  async missing(scope: VectorScope, documentId: string, limit: number): Promise<string[]> {
    const ids = await this.lister(scope, documentId);
    const todo = ids.filter((id) => this.rows.get(prefix(scope) + id)?.model !== this.modelId);
    return todo.slice(0, Math.max(0, limit));
  }

  async search(
    scope: VectorScope,
    query: readonly number[],
    limit: number,
    minScore?: number,
  ): Promise<{ chunkId: string; score: number }[]> {
    this.check(query);
    const p = prefix(scope);
    const hits: { chunkId: string; score: number }[] = [];
    for (const [key, row] of this.rows) {
      if (!key.startsWith(p) || row.model !== this.modelId) continue;
      const score = cosine(query, row.vector);
      if (score === null || (minScore !== undefined && score < minScore)) continue;
      hits.push({ chunkId: key.slice(p.length), score });
    }
    hits.sort((a, b) => b.score - a.score || (a.chunkId < b.chunkId ? -1 : 1));
    return hits.slice(0, Math.max(0, limit));
  }
}

/** Cosine similarity; null when either vector has zero length (undefined, so no hit). */
function cosine(a: readonly number[], b: readonly number[]): number | null {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] as number) * (b[i] as number);
    na += (a[i] as number) ** 2;
    nb += (b[i] as number) ** 2;
  }
  return na === 0 || nb === 0 ? null : dot / Math.sqrt(na * nb);
}
