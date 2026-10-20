import type { ChatScope } from "@docmind/contracts";
import { EmbeddingUnavailableError } from "@docmind/embeddings";
import type { ChunkVectorStore, VectorScope } from "@docmind/vector-pg";
import type { EmbeddingProvider } from "@loom/memory";
import type { LinkKind } from "../../flows/ingest-document/pgLinks";
import { cosine, expandHops, hop2Frontier, mmr } from "./core";
import type { LinkHop, LinkReader } from "./links";
import type { Passage, PassageReader, Via } from "./passages";

/** The query could not be embedded (the embedder is down): no passages, never passages from elsewhere (D9). */
export class SearchUnavailableError extends Error {
  constructor() {
    super("search is unavailable");
    this.name = "SearchUnavailableError";
  }
}

/** D9's numbers. */
export const CANDIDATES = 24;
export const SEEDS = 8;
export const MIN_SCORE = 0.2;
export const MMR_LAMBDA = 0.7;
export const PER_CHUNK = 4;
export const K_DEFAULT = 8;
export const K_MAX = 12;
export const RELATED_MAX = 8;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RetrieverDeps {
  embedder: EmbeddingProvider;
  vectors: ChunkVectorStore;
  passages: Pick<PassageReader, "read">;
  links: Pick<LinkReader, "from">;
  hops: 0 | 1 | 2;
  /** Called when a hop step failed and the search degraded: the hop and the error's constructor name only (a message can carry an entity name). */
  onHopError?: (hop: 1 | 2, errorClass: string) => void;
}

/**
 * Semantic seeds, then link hops (docs/design/linked-retrieval.md). Everything is owner-scoped by
 * `scope` and restricted to the chat's scope: `{documentIds}` limits the seeds and every hop target.
 * Hits are chunks as soon as they are embedded, whatever their document's status (D9).
 */
export class Retriever {
  constructor(private readonly deps: RetrieverDeps) {}

  /**
   * At most `k` (clamped to 1..12) passages for `query`, best first. Throws SearchUnavailableError when
   * the embedder is unavailable. An abort (`signal`) passes through as the embedder's own abort error.
   */
  async search(
    scope: VectorScope,
    chatScope: ChatScope,
    query: string,
    k: number,
    signal?: AbortSignal,
  ): Promise<Passage[]> {
    const want = Number.isFinite(k) ? Math.min(K_MAX, Math.max(1, Math.trunc(k))) : K_DEFAULT;
    const documentIds = chatScope === "all" ? undefined : chatScope.documentIds;
    // The query is embedded exactly as chunks were at ingest, with no task prefix (H14).
    const q = await this.embed(query, signal);
    const hits = await this.deps.vectors.search(
      scope,
      q,
      CANDIDATES,
      MIN_SCORE,
      documentIds && { documentIds },
    );
    if (hits.length === 0) return [];
    const vectors = await this.deps.vectors.vectors(
      scope,
      hits.map((h) => h.chunkId),
    );
    const seeds = mmr(
      hits.flatMap((h) => {
        const vector = vectors.get(h.chunkId);
        return vector ? [{ id: h.chunkId, score: h.score, vector }] : [];
      }),
      SEEDS,
      MMR_LAMBDA,
    ).map((id) => ({ id, score: (hits.find((h) => h.chunkId === id) as { score: number }).score }));

    // Hop 1, then hop 2 from the strong hop-1 nodes; each stage reads the vectors of its new targets.
    const known = new Map(vectors);
    const sims = new Map<string, number>();
    const targets = async (hops: readonly LinkHop[]) => {
      const need = [...new Set(hops.map((h) => h.dst))].filter((id) => !known.has(id));
      for (const [id, v] of await this.deps.vectors.vectors(scope, need)) known.set(id, v);
      for (const h of hops) {
        const v = known.get(h.dst);
        if (v) sims.set(h.dst, cosine(q, v));
      }
    };
    const follow = (ids: readonly string[]) =>
      this.deps.links.from(scope, ids, {
        perChunk: PER_CHUNK,
        ...(documentIds && { documentIds }),
      });
    // Hop failure policy: links and target vectors are an enrichment of the seeds, so a failure in any
    // hop step (an unreadable entity name, a database error) degrades to what was gathered so far
    // (seeds-only if hop 1 failed; hop 1 kept if only hop 2 failed) rather than failing the search, and
    // is reported through onHopError with the error class only. Not degraded: an abort (rethrown after
    // the block, since the readers take no signal) and TypeError/RangeError/ReferenceError, which are
    // programmer errors and must surface.
    let hop: 1 | 2 = 1;
    let hop1: LinkHop[] = [];
    let hop2: LinkHop[] = [];
    try {
      if (this.deps.hops >= 1) {
        const first = await follow(seeds.map((s) => s.id));
        await targets(first);
        hop1 = first;
      }
      hop = 2;
      if (this.deps.hops >= 2 && hop1.length > 0) {
        const frontier = hop2Frontier({ seeds, hop1, ownSim: sims });
        if (frontier.length > 0) {
          const second = await follow(frontier);
          await targets(second);
          hop2 = second;
        }
      }
    } catch (err) {
      signal?.throwIfAborted();
      if (err instanceof TypeError || err instanceof RangeError || err instanceof ReferenceError) {
        throw err;
      }
      this.deps.onHopError?.(hop, err instanceof Error ? err.constructor.name : "unknown");
      hop2 = []; // hop 1 is kept only if it completed (assigned above after its targets were read)
    }
    signal?.throwIfAborted();
    const nodes = expandHops({ seeds, hop1, hop2, ownSim: sims });
    const picked = mmr(
      nodes.flatMap((n) => {
        const vector = known.get(n.id);
        return vector ? [{ id: n.id, score: n.score, vector }] : [];
      }),
      want,
      MMR_LAMBDA,
    );
    const read = await this.deps.passages.read(scope, picked);
    const via = new Map(nodes.map((n) => [n.id, n.via]));
    return picked.flatMap((id) => {
      const p = read.get(id);
      const v = via.get(id);
      return p ? [v ? { ...p, via: v } : p] : [];
    });
  }

  /**
   * A deliberate hop from one passage: its top 8 links by weight, inside the chat's scope. The passage
   * itself must be the owner's and inside the scope, or the answer is `[]` (the same as for a missing one).
   */
  async related(
    scope: VectorScope,
    chatScope: ChatScope,
    passageId: string,
    kinds?: readonly LinkKind[],
  ): Promise<Passage[]> {
    if (!UUID.test(passageId)) return [];
    const documentIds = chatScope === "all" ? undefined : chatScope.documentIds;
    const self = (await this.deps.passages.read(scope, [passageId])).get(passageId.toLowerCase());
    if (!self || (documentIds && !documentIds.includes(self.documentId))) return [];
    const hops = await this.deps.links.from(scope, [self.passageId], {
      perChunk: RELATED_MAX,
      ...(kinds && { kinds }),
      ...(documentIds && { documentIds }),
    });
    // The same chunk can be linked in more than one kind: keep the strongest link per target.
    const best = new Map<string, LinkHop>();
    for (const h of hops) {
      const prev = best.get(h.dst);
      if (!prev || h.weight > prev.weight) best.set(h.dst, h);
    }
    const top = [...best.values()]
      .sort((a, b) => b.weight - a.weight || (a.dst < b.dst ? -1 : 1))
      .slice(0, RELATED_MAX);
    const read = await this.deps.passages.read(
      scope,
      top.map((h) => h.dst),
    );
    return top.flatMap((h) => {
      const p = read.get(h.dst);
      const v: Via = {
        kind: h.kind,
        from: self.passageId,
        ...(h.entity !== undefined && { entity: h.entity }),
      };
      return p ? [{ ...p, via: v }] : [];
    });
  }

  private async embed(query: string, signal?: AbortSignal): Promise<number[]> {
    try {
      const [vector] = await this.deps.embedder.embed([query], signal && { signal });
      if (!vector) throw new SearchUnavailableError();
      return vector;
    } catch (err) {
      if (err instanceof EmbeddingUnavailableError) throw new SearchUnavailableError();
      throw err;
    }
  }
}
