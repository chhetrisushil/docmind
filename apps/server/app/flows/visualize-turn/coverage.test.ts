import { describe, expect, it } from "vitest";
import { MAX_KEPT_DOCUMENTS, MAX_KEPT_FACTS, coverFacts } from "./coverage";

const c = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const d = (n: number) => `00000000-0000-4000-8000-0000000d${String(n).padStart(4, "0")}`;
const fact = (ordinal: number, ...chunks: number[]) => ({ ordinal, chunkIds: chunks.map(c) });

describe("coverFacts", () => {
  it("keeps a fact only when its chunks intersect the cited chunks", () => {
    const out = coverFacts({
      citedChunkIds: [c(1)],
      documents: new Map([[d(1), [fact(0, 1), fact(1, 2), fact(2, 9, 1)]]]),
    });
    expect(out).toEqual([
      { documentId: d(1), ordinal: 0 },
      { documentId: d(1), ordinal: 2 },
    ]);
  });

  it("orders by first citation, then document, then ordinal", () => {
    const out = coverFacts({
      citedChunkIds: [c(5), c(1), c(3)],
      documents: new Map([
        [d(1), [fact(0, 1), fact(1, 3)]],
        [d(2), [fact(0, 5)]],
      ]),
    });
    expect(out).toEqual([
      { documentId: d(2), ordinal: 0 }, // chunk 5 is cited first
      { documentId: d(1), ordinal: 0 }, // chunk 1
      { documentId: d(1), ordinal: 1 }, // chunk 3
    ]);
  });

  it("keeps at most 12 facts and at most 8 documents", () => {
    const many = new Map([[d(1), Array.from({ length: 16 }, (_, i) => fact(i, 1))]]);
    expect(coverFacts({ citedChunkIds: [c(1)], documents: many })).toHaveLength(MAX_KEPT_FACTS);
    const docs = new Map(
      Array.from({ length: 10 }, (_, i) => [d(i + 1), [fact(0, i + 1)]] as const),
    );
    const out = coverFacts({
      citedChunkIds: Array.from({ length: 10 }, (_, i) => c(i + 1)),
      documents: docs,
    });
    expect(new Set(out.map((r) => r.documentId)).size).toBe(MAX_KEPT_DOCUMENTS);
  });

  it("keeps nothing when no cited chunk is covered (the caller then extracts)", () => {
    expect(
      coverFacts({ citedChunkIds: [c(1)], documents: new Map([[d(1), [fact(0, 2)]]]) }),
    ).toEqual([]);
    expect(coverFacts({ citedChunkIds: [], documents: new Map() })).toEqual([]);
  });
});
