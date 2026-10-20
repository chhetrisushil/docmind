import {
  type ChunkVectorStore,
  type SearchFilter,
  VectorDimensionError,
  type VectorScope,
  checkNeighbourParams,
  checkSearchFilter,
  checkVectorIds,
  isValidVector,
} from "./types";

type Row = { vector: number[]; model: string; documentId: string };

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
    if (!isValidVector(vector, this.dimensions)) {
      throw new VectorDimensionError();
    }
  }

  /** Drops the scope's vectors whose chunk its lister no longer lists (a deleted or re-seeded chunk takes its vector with it, as the foreign key does in Postgres). */
  private async prune(scope: VectorScope, documentIds: Iterable<string>): Promise<void> {
    const p = prefix(scope);
    for (const documentId of new Set(documentIds)) {
      const live = new Set(await this.lister(scope, documentId));
      for (const [key, row] of this.rows) {
        if (key.startsWith(p) && row.documentId === documentId && !live.has(key.slice(p.length))) {
          this.rows.delete(key);
        }
      }
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
      this.rows.set(prefix(scope) + chunkId, {
        vector: [...vector],
        model: this.modelId,
        documentId,
      });
      written += 1;
    }
    return { written, missing };
  }

  async missing(scope: VectorScope, documentId: string, limit: number): Promise<string[]> {
    await this.prune(scope, [documentId]);
    const ids = await this.lister(scope, documentId);
    const todo = ids.filter((id) => this.rows.get(prefix(scope) + id)?.model !== this.modelId);
    return todo.slice(0, Math.max(0, limit));
  }

  async search(
    scope: VectorScope,
    query: readonly number[],
    limit: number,
    minScore?: number,
    filter?: SearchFilter,
  ): Promise<{ chunkId: string; score: number }[]> {
    this.check(query);
    checkSearchFilter(filter);
    const documents = filter?.documentIds ? new Set(filter.documentIds) : undefined;
    const p = prefix(scope);
    const owned = [...this.rows].filter(([key]) => key.startsWith(p));
    await this.prune(
      scope,
      owned.map(([, row]) => row.documentId),
    );
    const hits: { chunkId: string; score: number }[] = [];
    for (const [key, row] of this.rows) {
      if (!key.startsWith(p) || row.model !== this.modelId) continue;
      if (documents && !documents.has(row.documentId)) continue;
      const score = cosine(query, row.vector);
      if (score === null || (minScore !== undefined && score < minScore)) continue;
      hits.push({ chunkId: key.slice(p.length), score });
    }
    hits.sort((a, b) => b.score - a.score || (a.chunkId < b.chunkId ? -1 : 1));
    return hits.slice(0, Math.max(0, limit));
  }

  async vectors(scope: VectorScope, chunkIds: readonly string[]): Promise<Map<string, number[]>> {
    checkVectorIds(chunkIds);
    const out = new Map<string, number[]>();
    if (chunkIds.length === 0) return out;
    const p = prefix(scope);
    await this.prune(
      scope,
      [...this.rows].filter(([key]) => key.startsWith(p)).map(([, row]) => row.documentId),
    );
    for (const chunkId of new Set(chunkIds)) {
      const row = this.rows.get(p + chunkId);
      if (row && row.model === this.modelId && row.vector.some((x) => x !== 0)) {
        out.set(chunkId, [...row.vector]);
      }
    }
    return out;
  }

  async neighbours(
    scope: VectorScope,
    documentId: string,
    chunkIds: string[],
    perChunk: number,
    minScore: number,
  ): Promise<{ chunkId: string; neighbourId: string; score: number }[]> {
    checkNeighbourParams(perChunk, minScore);
    if (chunkIds.length === 0) return [];
    const p = prefix(scope);
    await this.prune(
      scope,
      [...this.rows].filter(([key]) => key.startsWith(p)).map(([, row]) => row.documentId),
    );
    const out: { chunkId: string; neighbourId: string; score: number }[] = [];
    for (const chunkId of new Set(chunkIds)) {
      const source = this.rows.get(p + chunkId);
      if (!source || source.model !== this.modelId || source.documentId !== documentId) continue;
      const hits: { neighbourId: string; score: number }[] = [];
      for (const [key, row] of this.rows) {
        if (!key.startsWith(p) || row.model !== this.modelId || row.documentId === documentId) {
          continue;
        }
        const score = cosine(source.vector, row.vector);
        if (score === null || score < minScore) continue;
        hits.push({ neighbourId: key.slice(p.length), score });
      }
      hits.sort((a, b) => b.score - a.score || (a.neighbourId < b.neighbourId ? -1 : 1));
      for (const h of hits.slice(0, perChunk)) out.push({ chunkId, ...h });
    }
    return out.sort((a, b) => (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0));
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
