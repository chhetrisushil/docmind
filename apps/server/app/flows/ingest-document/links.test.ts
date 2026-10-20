import { describe, expect, it } from "vitest";
import { buildLinks, findReferences, referenceMatcher } from "./links";
import type { Link, LinkKind } from "./pgLinks";

const EMPTY = { chunks: [], similar: [], shared: [], references: [] };
const c = (id: string, ordinal: number, sectionOrdinal: number) => ({
  id,
  ordinal,
  sectionOrdinal,
});
const L = (src: string, dst: string, kind: LinkKind, weight: number): Link => ({
  src,
  dst,
  kind,
  weight,
});
const sorted = (l: Link[]) =>
  [...l].sort((a, b) => `${a.src}${a.dst}${a.kind}`.localeCompare(`${b.src}${b.dst}${b.kind}`));

describe("buildLinks", () => {
  it("links neighbours in a section at 0.9 and other pairs in small sections at 0.6", () => {
    const links = buildLinks({
      ...EMPTY,
      chunks: [c("a", 0, 0), c("b", 1, 0), c("c", 2, 0), c("d", 3, 1)],
    });
    expect(sorted(links)).toEqual(
      sorted([
        L("a", "b", "structure", 0.9),
        L("b", "c", "structure", 0.9),
        L("a", "c", "structure", 0.6),
      ]),
    );
  });

  it("links only neighbours in a section with more than SECTION_PAIR_LIMIT chunks", () => {
    const big = Array.from({ length: 9 }, (_, i) => c(`x${i}`, i, 0));
    const links = buildLinks({ ...EMPTY, chunks: big });
    expect(links).toHaveLength(8);
    expect(links.every((l) => l.weight === 0.9)).toBe(true);
  });

  it("weights entity links by rarity and keeps the strongest per pair and kind", () => {
    const links = buildLinks({
      ...EMPTY,
      shared: [
        { chunkId: "a", otherChunkId: "z", chunksWithEntity: 2 },
        { chunkId: "a", otherChunkId: "z", chunksWithEntity: 50 },
      ],
    });
    expect(links).toEqual([L("a", "z", "entity", 1 / (1 + Math.log(2)))]);
  });

  it("passes similar scores through, clamped to (0, 1], and references at 0.7", () => {
    const links = buildLinks({
      ...EMPTY,
      similar: [
        { chunkId: "a", neighbourId: "z", score: 1.0000001 },
        { chunkId: "a", neighbourId: "w", score: 0 },
      ],
      references: [{ chunkId: "a", targetChunkId: "y" }],
    });
    expect(sorted(links)).toEqual(
      sorted([L("a", "z", "similar", 1), L("a", "y", "reference", 0.7)]),
    );
  });

  it("never emits a self link", () => {
    expect(
      buildLinks({ ...EMPTY, similar: [{ chunkId: "a", neighbourId: "a", score: 0.9 }] }),
    ).toEqual([]);
  });
});

describe("findReferences", () => {
  it("finds titles as whole phrases, case-insensitively, ignoring short and numeric titles", () => {
    const refs = findReferences(
      [
        { id: "a", text: "As set out in the master services agreement, clause 4." },
        { id: "b", text: "see 12345678" },
      ],
      [
        { title: "Master Services Agreement", firstChunkId: "t1" },
        { title: "Notes", firstChunkId: "t2" },
        { title: "12345678", firstChunkId: "t3" },
      ],
    );
    expect(refs).toEqual([{ chunkId: "a", targetChunkId: "t1" }]);
  });

  it("does not match inside a longer word and escapes regex characters", () => {
    const refs = findReferences(
      [{ id: "a", text: "megamaster plan (v1.0) here" }],
      [
        { title: "master plan", firstChunkId: "t1" },
        { title: "plan (v1.0)", firstChunkId: "t2" },
      ],
    );
    expect(refs).toEqual([{ chunkId: "a", targetChunkId: "t2" }]);
  });
});

describe("referenceMatcher", () => {
  const titles = [
    { title: "Master Services Agreement", firstChunkId: "t1" },
    { title: "Statement of Work", firstChunkId: "t2" },
  ];
  const batches = [
    [{ id: "a", text: "As agreed in the master services agreement, payment is due." }],
    [{ id: "b", text: "See the Statement of Work (SOW) for scope." }],
    [{ id: "t1", text: "Master Services Agreement" }],
  ];

  it("finds what findReferences finds, batch after batch, with one matcher reused", () => {
    const match = referenceMatcher(titles);
    const expected = [
      { chunkId: "a", targetChunkId: "t1" },
      { chunkId: "b", targetChunkId: "t2" },
    ];
    expect(batches.flatMap((b) => match(b))).toEqual(expected);
    expect(batches.flatMap((b) => findReferences(b, titles))).toEqual(expected);
    // A second pass over the same batches gives the same answer: no state is kept between calls.
    expect(batches.flatMap((b) => match(b))).toEqual(expected);
  });
});
