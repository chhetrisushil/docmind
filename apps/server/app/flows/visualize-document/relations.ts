import { MAX_RELATION_ENTITIES, MAX_RELATION_LINKS } from "@docmind/experiences";
import {
  MAX_RAW_ITEMS,
  MAX_STRUCTURE_LABEL,
  cleanText,
  earliestPassage,
  isRecord,
  nameKey,
} from "./structureText";

export const MAX_LINKS = MAX_RELATION_LINKS;
export const MIN_LINKS = 3;
/** The longest party name; at most 30 links name at most 60 parties. */
export const MAX_PARTY = MAX_STRUCTURE_LABEL;
export const MAX_REL = 40;
/** At most 30 links name at most 2 parties each; the stored schema (`facts.ts`) imports this, never repeats it. */
export const MAX_ENTITIES = MAX_RELATION_ENTITIES;

export interface RelationLink {
  /** Indexes into `RelationsDraft.entities`; the link is directed from to to. */
  from: number;
  to: number;
  rel: string;
  chunkId: string;
}
export interface RelationsDraft {
  kind: "relations";
  /** The parties, distinct by normalised name, in order of first appearance. */
  entities: string[];
  links: RelationLink[];
  /** The distinct `chunkId`s in link order. */
  chunkIds: string[];
}

/** The raw links of the answer's `relations` field: its `links` list, or the field itself when it is a bare list; at most 200 items; else none. */
export const rawLinksOf = (field: unknown): unknown[] => {
  const list = Array.isArray(field) ? field : isRecord(field) ? field.links : undefined;
  return Array.isArray(list) ? list.slice(0, MAX_RAW_ITEMS) : [];
};

/**
 * The relationships of a document from the model's raw links, or null (no relations). Every bad item is dropped on its
 * own: an empty or non-text party or relation, a self-link (the same normalised endpoints), no cited passage of this
 * document, a repeat of (from, rel, to) once normalised. The first 30 survivors in the model's order are kept; parties are
 * listed once each, in order of first appearance, by normalised name (the first spelling is shown). Fewer than 3 links is
 * no relations. Never throws, never echoes an item. `position` maps this document's passage ids (lower case) to their index.
 */
export function buildRelations(
  raw: readonly unknown[],
  position: ReadonlyMap<string, number>,
): RelationsDraft | null {
  const entities: string[] = [];
  const indexOf = new Map<string, number>();
  const seen = new Set<string>();
  const links: RelationLink[] = [];
  const partyIndex = (name: string, key: string): number => {
    const known = indexOf.get(key);
    if (known !== undefined) return known;
    entities.push(name);
    indexOf.set(key, entities.length - 1);
    return entities.length - 1;
  };
  for (const item of raw.slice(0, MAX_RAW_ITEMS)) {
    if (links.length >= MAX_LINKS) break;
    if (!isRecord(item)) continue;
    const from = typeof item.from === "string" ? cleanText(item.from, MAX_PARTY) : "";
    const to = typeof item.to === "string" ? cleanText(item.to, MAX_PARTY) : "";
    const rel = typeof item.rel === "string" ? cleanText(item.rel, MAX_REL) : "";
    const chunkId = earliestPassage(item.chunkIds, position);
    if (from === "" || to === "" || rel === "" || chunkId === null) continue;
    const [fromKey, toKey] = [nameKey(from), nameKey(to)];
    if (fromKey === toKey) continue;
    const key = `${fromKey}|${nameKey(rel)}|${toKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ from: partyIndex(from, fromKey), to: partyIndex(to, toKey), rel, chunkId });
  }
  if (links.length < MIN_LINKS) return null;
  return {
    kind: "relations",
    entities,
    links,
    chunkIds: [...new Set(links.map((l) => l.chunkId))],
  };
}
