import { describe, expect, it } from "vitest";
import { type EntityCandidate, type Mention, buildCooccurrence, topEntities } from "./cooccurrence";

const cid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const eid = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
const cand = (n: number, name: string, passages: number): EntityCandidate => ({
  id: eid(n),
  kind: "organization",
  name,
  passages,
});
/** `appear(entity, ...passage ordinals)` as mentions; the chunk id of passage `p` is `cid(p)`. */
const appear = (n: number, ...ordinals: number[]): Mention[] =>
  ordinals.map((o) => ({ entityId: eid(n), chunkId: cid(o), ordinal: o }));

describe("topEntities", () => {
  it("keeps the 20 most mentioned, breaking ties by name then id", () => {
    const all = Array.from({ length: 25 }, (_, i) =>
      cand(i, `Name${String(i).padStart(2, "0")}`, 10),
    );
    all.push(cand(100, "Zeta", 11), cand(101, "Alpha", 11));
    const top = topEntities(all);
    expect(top).toHaveLength(20);
    expect(top.slice(0, 3).map((e) => e.name)).toEqual(["Alpha", "Zeta", "Name00"]);
    expect(top[19]?.name).toBe("Name17");
  });

  it("breaks a tie on count and name by id", () => {
    const top = topEntities([cand(9, "Same", 5), cand(3, "Same", 5), cand(5, "Same", 5)]);
    expect(top.map((e) => e.id)).toEqual([eid(3), eid(5), eid(9)]);
  });

  it("clips names to 80 characters and drops a nameless candidate", () => {
    const top = topEntities([cand(1, "x".repeat(120), 3), cand(2, "   ", 9)]);
    expect(top).toHaveLength(1);
    expect(top[0]?.name).toHaveLength(80);
  });
});

describe("buildCooccurrence", () => {
  const trio = [cand(1, "Acme", 4), cand(2, "Bolt", 3), cand(3, "Cora", 2)];

  it("links entities that share at least 2 passages, weighted by the shared count", () => {
    const m = [...appear(1, 1, 2, 3, 4), ...appear(2, 1, 2, 3), ...appear(3, 2, 3)];
    const r = buildCooccurrence(trio, m);
    expect(r?.entities.map((e) => [e.name, e.passages])).toEqual([
      ["Acme", 4],
      ["Bolt", 3],
      ["Cora", 2],
    ]);
    // Acme-Bolt share 1,2,3 (3); Acme-Cora share 2,3 (2); Bolt-Cora share 2,3 (2)
    expect(r?.edges).toEqual([
      { a: 0, b: 1, weight: 3, firstChunkId: cid(1) },
      { a: 0, b: 2, weight: 2, firstChunkId: cid(2) },
      { a: 1, b: 2, weight: 2, firstChunkId: cid(2) },
    ]);
  });

  it("ignores a pair that shares only one passage", () => {
    const m = [...appear(1, 1, 2), ...appear(2, 1, 2), ...appear(3, 1)];
    const r = buildCooccurrence(trio, m);
    expect(r).toBeNull(); // Cora shares one passage with each: only Acme-Bolt is linked, 2 entities
  });

  it("drops an entity left with no edge and re-indexes the rest", () => {
    const four = [...trio, cand(4, "Dune", 2)];
    const m = [
      ...appear(1, 1, 2, 3),
      ...appear(2, 1, 2, 3),
      ...appear(3, 1, 2, 3),
      ...appear(4, 7, 8), // alone
    ];
    const r = buildCooccurrence(four, m);
    expect(r?.entities.map((e) => e.name)).toEqual(["Acme", "Bolt", "Cora"]);
    expect(r?.edges.every((e) => e.a < e.b && e.b <= 2)).toBe(true);
  });

  it("produces nothing with fewer than 3 linked entities", () => {
    const m = [...appear(1, 1, 2), ...appear(2, 1, 2)];
    expect(buildCooccurrence(trio.slice(0, 2), m)).toBeNull();
    expect(buildCooccurrence([], [])).toBeNull();
  });

  it("uses the first shared passage in document order, whatever order the mentions came in", () => {
    const m = [...appear(1, 9, 5, 7), ...appear(2, 7, 9, 5), ...appear(3, 5, 7)];
    const r = buildCooccurrence(trio, m);
    expect(r?.edges.find((e) => e.a === 0 && e.b === 1)?.firstChunkId).toBe(cid(5));
  });

  it("keeps the 40 strongest of 190 possible edges, strongest first, in a stable order", () => {
    const twenty = Array.from({ length: 20 }, (_, i) =>
      cand(i, `E${String(i).padStart(2, "0")}`, 5),
    );
    // Every entity appears in passages 1..5, so all 190 pairs share 5 passages; a 6th passage links E00-E01 only.
    const m = twenty.flatMap((_, i) => appear(i, 1, 2, 3, 4, 5));
    m.push(...appear(0, 6), ...appear(1, 6));
    const r = buildCooccurrence(
      twenty.map((e, i) => (i < 2 ? { ...e, passages: 6 } : e)),
      m,
    );
    expect(r?.entities).toHaveLength(20);
    expect(r?.edges).toHaveLength(40);
    expect(r?.edges[0]).toMatchObject({ a: 0, b: 1, weight: 6 });
    // The rest tie at weight 5 and keep pair order (a, then b): E00-E02 first, E02-E05 last.
    expect(r?.edges[1]).toMatchObject({ a: 0, b: 2, weight: 5 });
    expect(r?.edges[39]).toMatchObject({ a: 2, b: 5, weight: 5 });
    expect(r?.edges.every((e) => e.a < e.b)).toBe(true);
  });

  it("cites each distinct firstChunkId once, strongest edge first", () => {
    // Acme is in passages 1..6, Bolt in 1..3, Cora in 4..6, Dune in 1..2: the pairs' first shared passages differ.
    const four = [cand(1, "Acme", 6), cand(2, "Bolt", 3), cand(3, "Cora", 3), cand(4, "Dune", 2)];
    const m = [
      ...appear(1, 1, 2, 3, 4, 5, 6),
      ...appear(2, 1, 2, 3),
      ...appear(3, 4, 5, 6),
      ...appear(4, 1, 2),
    ];
    const r = buildCooccurrence(four, m);
    // Acme-Bolt 3 (first 1), Acme-Cora 3 (first 4), Acme-Dune 2 (first 1), Bolt-Dune 2 (first 1); Bolt-Cora and Cora-Dune share nothing
    expect(r?.edges).toEqual([
      { a: 0, b: 1, weight: 3, firstChunkId: cid(1) },
      { a: 0, b: 2, weight: 3, firstChunkId: cid(4) },
      { a: 0, b: 3, weight: 2, firstChunkId: cid(1) },
      { a: 1, b: 3, weight: 2, firstChunkId: cid(1) },
    ]);
    expect(r?.chunkIds).toEqual([cid(1), cid(4)]); // four edges, two distinct passages, strongest edge's passage first
  });

  it("leaves out the pair that shares a single passage and lists the others by weight", () => {
    const m = [...appear(1, 1, 2, 3, 4), ...appear(2, 3, 4, 1), ...appear(3, 1, 2)];
    const r = buildCooccurrence(trio, m);
    // Acme-Bolt weight 3 (first 1), Acme-Cora weight 2 (first 1), Bolt-Cora weight 1 (not an edge)
    expect(r?.edges.map((e) => e.weight)).toEqual([3, 2]);
    expect(r?.chunkIds).toEqual([cid(1)]);
  });

  it("counts a repeated mention of one passage once", () => {
    const m = [...appear(1, 1, 1, 2, 2), ...appear(2, 1, 2, 2), ...appear(3, 1, 2)];
    const r = buildCooccurrence(trio, m);
    expect(r?.edges.map((e) => e.weight)).toEqual([2, 2, 2]);
  });

  it("derives an entity's passage count from the mentions, not the candidate's claim", () => {
    const m = [...appear(1, 1, 2, 3), ...appear(2, 1, 2), ...appear(3, 1, 2)];
    const r = buildCooccurrence([cand(1, "Acme", 99), cand(2, "Bolt", 1), cand(3, "Cora", 2)], m);
    expect(r?.entities.map((e) => e.passages)).toEqual([3, 2, 2]);
  });
});
