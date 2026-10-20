import type { LinkHop } from "./links";
import type { Via } from "./passages";

/** The knobs of D9. Tuning them is the M7 eval's job; every task and test names them, not their values. */
export const HOP_DECAY = 0.85;
/** `final = PATH_SHARE * pathScore + (1 - PATH_SHARE) * ownSim`. */
export const PATH_SHARE = 0.5;
/** Hop 2 starts only from hop-1 nodes whose final score is at least this. */
export const HOP2_FLOOR = 0.45;

export interface ScoredNode {
  id: string;
  /** The final score: a seed's own similarity, or the blend of its best path and its own similarity. */
  score: number;
  /** 0 for a seed, else the hops of its best path. */
  depth: 0 | 1 | 2;
  /** How the best path reached it (absent for a seed). `from` is the chunk the last link left. */
  via?: Via;
}

export interface HopInput {
  /** Seed chunks with their cosine similarity to the query. */
  seeds: readonly { id: string; score: number }[];
  /** Links followed from the seeds. A link whose `src` is not a seed is ignored. */
  hop1: readonly LinkHop[];
  /** Links followed from `hop2Frontier(...)`; empty when hops < 2. A link from any other chunk is ignored. */
  hop2: readonly LinkHop[];
  /** Cosine similarity to the query of every link target (from the vectors store). A target with none is dropped. */
  ownSim: ReadonlyMap<string, number>;
}

interface Best {
  node: ScoredNode;
  /** seedSim x product of weights x decay^depth. */
  path: number;
}

const better = (a: Best, b: Best | undefined): boolean =>
  b === undefined ||
  a.node.score > b.node.score ||
  (a.node.score === b.node.score &&
    ((a.node.via?.from ?? "") < (b.node.via?.from ?? "") ||
      ((a.node.via?.from ?? "") === (b.node.via?.from ?? "") &&
        (a.node.via?.kind ?? "") < (b.node.via?.kind ?? ""))));

function step(
  from: Best,
  hop: LinkHop,
  depth: 1 | 2,
  ownSim: ReadonlyMap<string, number>,
): Best | undefined {
  const sim = ownSim.get(hop.dst);
  if (sim === undefined) return undefined;
  const path = from.path * hop.weight * HOP_DECAY;
  const via = {
    kind: hop.kind,
    from: hop.src,
    ...(hop.entity !== undefined && { entity: hop.entity }),
  };
  return {
    path,
    node: { id: hop.dst, score: PATH_SHARE * path + (1 - PATH_SHARE) * sim, depth, via },
  };
}

/** Best path per hop-1 target, leaving out the seeds (they are expanded already). */
function firstHop(input: Pick<HopInput, "seeds" | "hop1" | "ownSim">): Map<string, Best> {
  const seeds = new Map(input.seeds.map((s) => [s.id, s.score]));
  const best = new Map<string, Best>();
  for (const hop of input.hop1) {
    const seedSim = seeds.get(hop.src);
    if (seedSim === undefined || seeds.has(hop.dst)) continue;
    const cand = step(
      { path: seedSim, node: { id: hop.src, score: seedSim, depth: 0 } },
      hop,
      1,
      input.ownSim,
    );
    if (cand && better(cand, best.get(hop.dst))) best.set(hop.dst, cand);
  }
  return best;
}

/** The hop-1 nodes worth expanding again (final score >= HOP2_FLOOR), best first: the sources for hop 2's link read. */
export function hop2Frontier(input: Pick<HopInput, "seeds" | "hop1" | "ownSim">): string[] {
  return [...firstHop(input).values()]
    .filter((b) => b.node.score >= HOP2_FLOOR)
    .sort((a, b) => b.node.score - a.node.score || (a.node.id < b.node.id ? -1 : 1))
    .map((b) => b.node.id);
}

/**
 * Scores the passages a retrieval reached, exactly as D9 says:
 *  - a seed scores its own similarity to the query;
 *  - a hop-1 node: path = seedSim x weight x 0.85, score = 0.5 x path + 0.5 x ownSim;
 *  - a hop-2 node (only from a hop-1 node scoring >= 0.45): path = path(hop-1 node) x weight x 0.85, same blend;
 *  - a passage reached several ways keeps its best score (ties: the smaller `from`, then `kind`);
 *  - a seed is never re-scored by a link: its own similarity is its score.
 * Pure: the caller does the I/O between the stages. Sorted best first, ties by id.
 */
export function expandHops(input: HopInput): ScoredNode[] {
  const nodes = new Map<string, Best>(
    input.seeds.map((s) => [s.id, { path: s.score, node: { id: s.id, score: s.score, depth: 0 } }]),
  );
  const first = firstHop(input);
  const frontier = new Set(hop2Frontier(input));
  const merge = (b: Best) => {
    if (better(b, nodes.get(b.node.id))) nodes.set(b.node.id, b);
  };
  for (const b of first.values()) merge(b);
  const seeds = new Set(input.seeds.map((x) => x.id));
  for (const hop of input.hop2) {
    const from = first.get(hop.src);
    if (!from || !frontier.has(hop.src) || seeds.has(hop.dst)) continue;
    const cand = step(from, hop, 2, input.ownSim);
    if (cand) merge(cand);
  }
  return [...nodes.values()]
    .map((b) => b.node)
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
}

/** Cosine similarity; 0 when either vector has no length (a zero vector is similar to nothing). */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new RangeError("cosine: vectors must have equal length");
  if (!a.every(Number.isFinite) || !b.every(Number.isFinite)) {
    throw new RangeError("cosine: vector values must be finite");
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] as number) * (b[i] as number);
    na += (a[i] as number) ** 2;
    nb += (b[i] as number) ** 2;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/**
 * Maximal marginal relevance: repeatedly picks the candidate maximizing
 * `lambda x score - (1 - lambda) x (largest cosine to anything already picked)`; the first pick is the
 * best score. Returns at most `k` ids in pick order. Ties: the higher score, then the smaller id.
 */
export function mmr(
  candidates: readonly { id: string; score: number; vector: readonly number[] }[],
  k: number,
  lambda: number,
): string[] {
  if (!(lambda >= 0 && lambda <= 1)) throw new RangeError("mmr: lambda must be between 0 and 1");
  if (!Number.isInteger(k) || k < 0) throw new RangeError("mmr: k must be a non-negative integer");
  for (const c of candidates) {
    if (!Number.isFinite(c.score)) throw new RangeError("mmr: scores must be finite");
  }
  const picked: { id: string; vector: readonly number[] }[] = [];
  const left = [...candidates];
  while (picked.length < k && left.length > 0) {
    let bestAt = -1;
    let bestValue = Number.NEGATIVE_INFINITY;
    for (const [i, c] of left.entries()) {
      const redundancy = picked.reduce((m, p) => Math.max(m, cosine(c.vector, p.vector)), 0);
      const value = lambda * c.score - (1 - lambda) * redundancy;
      const best = left[bestAt];
      if (
        value > bestValue ||
        (value === bestValue &&
          best &&
          (c.score > best.score || (c.score === best.score && c.id < best.id)))
      ) {
        bestAt = i;
        bestValue = value;
      }
    }
    const [chosen] = left.splice(bestAt, 1);
    picked.push({
      id: (chosen as { id: string }).id,
      vector: (chosen as { vector: readonly number[] }).vector,
    });
  }
  return picked.map((p) => p.id);
}
