import type { EntityKind } from "../../crypto/entityKeys";
import { clipLabel } from "./structureText";

export const MAX_MAP_ENTITIES = 20;
export const MIN_SHARED_PASSAGES = 2;
export const MAX_MAP_EDGES = 40;
export const MIN_LINKED = 3;

/** An entity of this document: its owner-scoped id, kind, opened name, and the number of this document's passages it is in. */
export interface EntityCandidate {
  id: string;
  kind: EntityKind;
  name: string;
  passages: number;
}

/** One passage an entity appears in; `ordinal` is the passage's position in the document. */
export interface Mention {
  entityId: string;
  chunkId: string;
  ordinal: number;
}

export interface MapEntity {
  name: string;
  entityKind: EntityKind;
  passages: number;
}
/** `a` and `b` index `entities` (a < b). */
export interface MapEdge {
  a: number;
  b: number;
  weight: number;
  firstChunkId: string;
}
export interface CooccurrenceDraft {
  kind: "cooccurrence";
  entities: MapEntity[];
  edges: MapEdge[];
  /** The distinct edge `firstChunkId`s, strongest edge first. */
  chunkIds: string[];
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The 20 most mentioned entities (ties by name, then id), names clipped to 80 characters; a nameless candidate is dropped. */
export function topEntities(candidates: readonly EntityCandidate[]): EntityCandidate[] {
  return candidates
    .map((c) => ({ ...c, name: clipLabel(c.name) }))
    .filter((c) => c.name !== "")
    .sort((a, b) => b.passages - a.passages || compare(a.name, b.name) || compare(a.id, b.id))
    .slice(0, MAX_MAP_ENTITIES);
}

interface Pair {
  a: number;
  b: number;
  weight: number;
  ordinal: number;
  chunkId: string;
}

/**
 * The entity map over `top` (from `topEntities`) and the passages those entities appear in: an edge for each pair sharing
 * at least 2 passages, the 40 strongest kept, entities with no edge dropped; null when fewer than 3 entities stay linked.
 */
export function buildCooccurrence(
  top: readonly EntityCandidate[],
  mentions: readonly Mention[],
): CooccurrenceDraft | null {
  const index = new Map(top.map((e, i) => [e.id, i]));
  const byChunk = new Map<string, { ordinal: number; members: number[] }>();
  for (const m of mentions) {
    const i = index.get(m.entityId);
    if (i === undefined) continue;
    const entry = byChunk.get(m.chunkId) ?? { ordinal: m.ordinal, members: [] };
    if (!entry.members.includes(i)) entry.members.push(i);
    byChunk.set(m.chunkId, entry);
  }
  const pairs = new Map<string, Pair>();
  for (const [chunkId, { ordinal, members }] of byChunk) {
    members.sort((x, y) => x - y);
    for (let x = 0; x < members.length; x++)
      for (let y = x + 1; y < members.length; y++) {
        const a = members[x] as number;
        const b = members[y] as number;
        const key = `${a}:${b}`;
        const pair = pairs.get(key);
        if (!pair) pairs.set(key, { a, b, weight: 1, ordinal, chunkId });
        else {
          pair.weight++;
          if (ordinal < pair.ordinal) {
            pair.ordinal = ordinal;
            pair.chunkId = chunkId;
          }
        }
      }
  }
  const strongest = [...pairs.values()]
    .filter((p) => p.weight >= MIN_SHARED_PASSAGES)
    .sort((p, q) => q.weight - p.weight || p.a - q.a || p.b - q.b)
    .slice(0, MAX_MAP_EDGES);
  const linked = [...new Set(strongest.flatMap((p) => [p.a, p.b]))].sort((x, y) => x - y);
  if (linked.length < MIN_LINKED) return null;
  const at = new Map(linked.map((old, i) => [old, i]));
  const entities = linked.map((i) => {
    const e = top[i] as EntityCandidate;
    return { name: e.name, entityKind: e.kind, passages: e.passages };
  });
  const edges = strongest.map((p) => ({
    a: at.get(p.a) as number,
    b: at.get(p.b) as number,
    weight: p.weight,
    firstChunkId: p.chunkId,
  }));
  return {
    kind: "cooccurrence",
    entities,
    edges,
    chunkIds: [...new Set(edges.map((e) => e.firstChunkId))],
  };
}
