import type { Link, LinkKind } from "./pgLinks";

export const STRUCTURE_NEXT = 0.9;
export const STRUCTURE_SECTION = 0.6;
export const SECTION_PAIR_LIMIT = 8;
export const SIMILAR_PER_CHUNK = 5;
export const SIMILAR_MIN = 0.8;
export const REFERENCE_WEIGHT = 0.7;
export const MIN_TITLE_CHARS = 8;
export const LINK_STEP_TIMEOUT_MS = 600_000;

export interface LinkInput {
  chunks: { id: string; ordinal: number; sectionOrdinal: number }[];
  similar: { chunkId: string; neighbourId: string; score: number }[];
  shared: { chunkId: string; otherChunkId: string; chunksWithEntity: number }[];
  references: { chunkId: string; targetChunkId: string }[];
}

/** Pure: the links a document's chunks, neighbours, shared entities and references imply. */
export function buildLinks(input: LinkInput): Link[] {
  const best = new Map<string, Link>();
  const put = (src: string, dst: string, kind: LinkKind, weight: number) => {
    if (src === dst || !(weight > 0)) return;
    const w = Math.min(1, weight);
    const key = `${src}|${dst}|${kind}`;
    const prev = best.get(key);
    if (!prev || w > prev.weight) best.set(key, { src, dst, kind, weight: w });
  };

  const ordered = [...input.chunks].sort((a, b) => a.ordinal - b.ordinal);
  const sections = new Map<number, typeof ordered>();
  for (const c of ordered)
    sections.set(c.sectionOrdinal, [...(sections.get(c.sectionOrdinal) ?? []), c]);
  for (const members of sections.values()) {
    const pairs = members.length <= SECTION_PAIR_LIMIT;
    for (let i = 0; i < members.length; i++) {
      const a = members[i];
      const next = members[i + 1];
      if (!a || !next) continue;
      put(a.id, next.id, "structure", STRUCTURE_NEXT);
    }
    if (!pairs) continue;
    for (let i = 0; i < members.length; i++)
      for (let j = i + 2; j < members.length; j++) {
        const a = members[i];
        const b = members[j];
        if (a && b) put(a.id, b.id, "structure", STRUCTURE_SECTION);
      }
  }
  for (const s of input.similar) put(s.chunkId, s.neighbourId, "similar", s.score);
  for (const s of input.shared)
    put(s.chunkId, s.otherChunkId, "entity", 1 / (1 + Math.log(Math.max(1, s.chunksWithEntity))));
  for (const r of input.references) put(r.chunkId, r.targetChunkId, "reference", REFERENCE_WEIGHT);
  return [...best.values()];
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Compiles one whole-phrase, case-insensitive pattern per usable title, once; the returned function matches a batch of chunks. */
export function referenceMatcher(
  titles: { title: string; firstChunkId: string }[],
): (chunks: { id: string; text: string }[]) => { chunkId: string; targetChunkId: string }[] {
  const patterns = titles
    .map((t) => ({ ...t, title: t.title.trim() }))
    .filter((t) => t.title.length >= MIN_TITLE_CHARS && !/^\d+$/.test(t.title))
    .map((t) => ({
      target: t.firstChunkId,
      re: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(t.title)}(?![\\p{L}\\p{N}])`, "iu"),
    }));
  return (chunks) => {
    const seen = new Set<string>();
    const out: { chunkId: string; targetChunkId: string }[] = [];
    for (const c of chunks)
      for (const p of patterns) {
        const key = `${c.id}|${p.target}`;
        if (seen.has(key) || c.id === p.target || !p.re.test(c.text)) continue;
        seen.add(key);
        out.push({ chunkId: c.id, targetChunkId: p.target });
      }
    return out;
  };
}

/** Case-insensitive whole-phrase title matches; one link per (chunk, target). */
export const findReferences = (
  chunks: { id: string; text: string }[],
  titles: { title: string; firstChunkId: string }[],
): { chunkId: string; targetChunkId: string }[] => referenceMatcher(titles)(chunks);
