import { describe, expect, it } from "vitest";
import { HOP2_FLOOR, type HopInput, cosine, expandHops, hop2Frontier, mmr } from "./core";
import type { LinkHop } from "./links";

const hop = (
  src: string,
  dst: string,
  weight: number,
  kind: LinkHop["kind"] = "similar",
  entity?: string,
): LinkHop => ({
  src,
  dst,
  kind,
  weight,
  ...(entity !== undefined && { entity }),
});
const sims = (o: Record<string, number>) => new Map(Object.entries(o));
const input = (over: Partial<HopInput>): HopInput => ({
  seeds: [],
  hop1: [],
  hop2: [],
  ownSim: new Map(),
  ...over,
});
const byId = (nodes: ReturnType<typeof expandHops>) => new Map(nodes.map((n) => [n.id, n]));

describe("cosine", () => {
  it("is 1 for parallel, 0 for orthogonal, -1 for opposite vectors, and 0 for a zero vector", () => {
    expect(cosine([1, 2], [2, 4])).toBeCloseTo(1, 12);
    expect(cosine([1, 0], [0, 3])).toBe(0);
    expect(cosine([1, 0], [-2, 0])).toBeCloseTo(-1, 12);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe("mmr", () => {
  const axis = (i: number, n = 4) => Array.from({ length: n }, (_, k) => (k === i ? 1 : 0));
  const cands = [
    { id: "dup1", score: 0.9, vector: axis(0) },
    { id: "dup2", score: 0.89, vector: axis(0) },
    { id: "other", score: 0.7, vector: axis(1) },
  ];

  it("takes the best score first, then prefers a different passage over a near-duplicate", () => {
    expect(mmr(cands, 2, 0.7)).toEqual(["dup1", "other"]);
  });

  it("is plain top-k by score at lambda 1, and plain diversity after the first pick at lambda 0", () => {
    expect(mmr(cands, 2, 1)).toEqual(["dup1", "dup2"]);
    expect(mmr(cands, 3, 0)).toEqual(["dup1", "other", "dup2"]);
  });

  it("returns at most k ids, all of them when k is larger, and none for k = 0 or no candidates", () => {
    expect(mmr(cands, 10, 0.7)).toHaveLength(3);
    expect(mmr(cands, 0, 0.7)).toEqual([]);
    expect(mmr([], 5, 0.7)).toEqual([]);
  });

  it("breaks exact ties by score and then by id, and does not depend on input order", () => {
    const tied = [
      { id: "b", score: 0.5, vector: axis(0) },
      { id: "a", score: 0.5, vector: axis(1) },
    ];
    expect(mmr(tied, 2, 0.7)).toEqual(["a", "b"]);
    expect(mmr([...tied].reverse(), 2, 0.7)).toEqual(["a", "b"]);
  });

  it("refuses a lambda outside [0, 1] with a RangeError naming the parameter", () => {
    for (const bad of [-0.1, 1.1, Number.NaN]) {
      expect(() => mmr(cands, 1, bad)).toThrow(/^mmr: lambda must be between 0 and 1$/);
      expect(() => mmr(cands, 1, bad)).toThrow(RangeError);
    }
  });
});

describe("expandHops (D9)", () => {
  it("scores a seed by its similarity and a hop-1 node by 0.5 x (seedSim x weight x 0.85) + 0.5 x ownSim", () => {
    const out = byId(
      expandHops(
        input({
          seeds: [{ id: "A", score: 0.8 }],
          hop1: [hop("A", "B", 0.5, "entity", "Acme")],
          ownSim: sims({ B: 0.6 }),
        }),
      ),
    );
    expect(out.get("A")).toEqual({ id: "A", score: 0.8, depth: 0 });
    expect(out.get("B")?.score).toBeCloseTo(0.5 * (0.8 * 0.5 * 0.85) + 0.5 * 0.6, 12); // 0.47
    expect(out.get("B")?.depth).toBe(1);
    expect(out.get("B")?.via).toEqual({ kind: "entity", from: "A", entity: "Acme" });
  });

  it("keeps each passage's best path, and breaks an exact tie by the smaller source id", () => {
    const out = byId(
      expandHops(
        input({
          seeds: [
            { id: "A", score: 0.8 },
            { id: "C", score: 0.7 },
          ],
          hop1: [
            hop("A", "B", 0.4),
            hop("C", "B", 0.9, "structure"),
            hop("A", "D", 0.5),
            hop("C", "D", 0.5 * (0.8 / 0.7)),
          ],
          ownSim: sims({ B: 0.5, D: 0.5 }),
        }),
      ),
    );
    expect(out.get("B")?.via).toEqual({ kind: "structure", from: "C" }); // 0.7 x 0.9 beats 0.8 x 0.4
    expect(out.get("D")?.via?.from).toBe("A"); // equal path scores: the smaller source id
  });

  it("drops a link target that has no vector, ignores links from a non-seed, and never re-scores a seed", () => {
    const out = expandHops(
      input({
        seeds: [
          { id: "A", score: 0.3 },
          { id: "S", score: 0.9 },
        ],
        hop1: [hop("A", "NOVEC", 0.9), hop("Z", "Y", 0.9), hop("S", "A", 1)],
        ownSim: sims({ Y: 0.9, A: 1 }),
      }),
    );
    expect(out.map((n) => n.id)).toEqual(["S", "A"]);
    expect(out.find((n) => n.id === "A")).toEqual({ id: "A", score: 0.3, depth: 0 });
  });

  it("expands hop 2 only from hop-1 nodes scoring at least 0.45, with path = path1 x weight x 0.85", () => {
    const base = {
      seeds: [{ id: "A", score: 0.8 }],
      hop1: [hop("A", "B", 0.5), hop("A", "D", 0.5)],
      ownSim: sims({ B: 0.6, D: 0.3, E: 0.5, F: 0.9 }),
    };
    // B: 0.5 x 0.34 + 0.5 x 0.6 = 0.47 (in); D: 0.5 x 0.34 + 0.5 x 0.3 = 0.32 (out)
    expect(hop2Frontier(input(base))).toEqual(["B"]);
    expect(HOP2_FLOOR).toBe(0.45);
    const out = byId(
      expandHops(
        input({
          ...base,
          hop2: [hop("B", "E", 0.9, "reference"), hop("D", "F", 1), hop("A", "F", 1)],
        }),
      ),
    );
    expect(out.get("E")?.score).toBeCloseTo(0.5 * (0.8 * 0.5 * 0.85 * 0.9 * 0.85) + 0.5 * 0.5, 12); // 0.38005
    expect(out.get("E")?.depth).toBe(2);
    expect(out.get("E")?.via).toEqual({ kind: "reference", from: "B" });
    expect(out.has("F")).toBe(false); // from D (below the floor) and from a seed (not a hop-1 node)
  });

  it("lists the frontier best first and returns nodes best first, ties by id", () => {
    const seeds = [{ id: "A", score: 0.9 }];
    const hop1 = [hop("A", "B", 0.5), hop("A", "C", 0.9)];
    const ownSim = sims({ B: 0.7, C: 0.9 });
    expect(hop2Frontier({ seeds, hop1, ownSim })).toEqual(["C", "B"]);
    const out = expandHops(input({ seeds, hop1, ownSim }));
    // A 0.9; C 0.5 x (0.9 x 0.9 x 0.85) + 0.5 x 0.9 = 0.79425; B 0.5 x (0.9 x 0.5 x 0.85) + 0.5 x 0.7 = 0.54125
    expect(out.map((n) => n.id)).toEqual(["A", "C", "B"]);
    expect(out[1]?.score).toBeCloseTo(0.79425, 12);
    expect(out[2]?.score).toBeCloseTo(0.54125, 12);
  });

  it("returns just the seeds when nothing was followed", () => {
    expect(expandHops(input({ seeds: [{ id: "A", score: 0.5 }] }))).toEqual([
      { id: "A", score: 0.5, depth: 0 },
    ]);
    expect(expandHops(input({}))).toEqual([]);
  });
});

describe("input validation", () => {
  it("rejects bad k, mismatched or non-finite vectors, and non-finite scores with fixed messages", () => {
    const c = [{ id: "a", score: 0.5, vector: [1, 0] }];
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() => mmr(c, bad, 0.5)).toThrow(/^mmr: k must be a non-negative integer$/);
    }
    expect(() => cosine([1], [1, 2])).toThrow(/^cosine: vectors must have equal length$/);
    expect(() => cosine([Number.NaN], [1])).toThrow(/^cosine: vector values must be finite$/);
    expect(() => cosine([1], [Number.POSITIVE_INFINITY])).toThrow(RangeError);
    expect(() => mmr([{ id: "a", score: Number.NaN, vector: [1] }], 1, 0.5)).toThrow(
      /^mmr: scores must be finite$/,
    );
    expect(() =>
      mmr(
        [
          { id: "a", score: 1, vector: [1, 0] },
          { id: "b", score: 1, vector: [1] },
        ],
        2,
        0.5,
      ),
    ).toThrow(/^cosine: vectors must have equal length$/);
  });
});
