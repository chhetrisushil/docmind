export const MAX_KEPT_FACTS = 12;
export const MAX_KEPT_DOCUMENTS = 8;

/**
 * C1, the coverage rule. A stored fact is kept only when it cites a chunk the answer cited, ordered by the first
 * citation of such a chunk (then document id, then ordinal), at most 12 facts from at most 8 documents.
 * Nothing kept means the caller extracts from the turn's own chunks.
 */
export function coverFacts(input: {
  citedChunkIds: readonly string[]; // in citation order
  documents: ReadonlyMap<string, readonly { ordinal: number; chunkIds: readonly string[] }[]>;
}): { documentId: string; ordinal: number }[] {
  const rank = new Map<string, number>();
  input.citedChunkIds.forEach((id, i) => {
    if (!rank.has(id)) rank.set(id, i);
  });
  const covered: { documentId: string; ordinal: number; rank: number }[] = [];
  for (const [documentId, facts] of input.documents)
    for (const f of facts) {
      const ranks = f.chunkIds.flatMap((id) => (rank.has(id) ? [rank.get(id) as number] : []));
      if (ranks.length > 0)
        covered.push({ documentId, ordinal: f.ordinal, rank: Math.min(...ranks) });
    }
  covered.sort(
    (a, b) =>
      a.rank - b.rank ||
      (a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0) ||
      a.ordinal - b.ordinal,
  );
  const documents = new Set<string>();
  const kept: { documentId: string; ordinal: number }[] = [];
  for (const f of covered) {
    if (kept.length >= MAX_KEPT_FACTS) break;
    if (!documents.has(f.documentId) && documents.size >= MAX_KEPT_DOCUMENTS) continue;
    documents.add(f.documentId);
    kept.push({ documentId: f.documentId, ordinal: f.ordinal });
  }
  return kept;
}
