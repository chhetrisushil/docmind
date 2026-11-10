import { describe, expect, it } from "vitest";
import {
  MAX_ENTITIES,
  MAX_LINKS,
  MAX_PARTY,
  MAX_REL,
  MIN_LINKS,
  buildRelations,
  rawLinksOf,
} from "./relations";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const POS = new Map([1, 2, 3, 4, 5].map((n, i) => [ID(n), i] as const));
const link = (from: string, rel: string, to: string, over: Record<string, unknown> = {}) => ({
  from,
  rel,
  to,
  chunkIds: [ID(1)],
  ...over,
});
const GOOD = [
  link("Acme", "acquired", "Beta Corp"),
  link("Cora", "leads", "Project X"),
  link("Acme", "owns", "Project X"),
];

describe("buildRelations", () => {
  it("keeps the limits the spec names", () => {
    expect([MAX_LINKS, MIN_LINKS, MAX_PARTY, MAX_REL, MAX_ENTITIES]).toEqual([30, 3, 80, 40, 60]);
  });

  it("lists each party once in order of first appearance and joins links by index, directed from to to", () => {
    const r = buildRelations(GOOD, POS);
    expect(r?.entities).toEqual(["Acme", "Beta Corp", "Cora", "Project X"]);
    expect(r?.links).toEqual([
      { from: 0, to: 1, rel: "acquired", chunkId: ID(1) },
      { from: 2, to: 3, rel: "leads", chunkId: ID(1) },
      { from: 0, to: 3, rel: "owns", chunkId: ID(1) },
    ]);
  });

  it("dedupes parties by normalised name and keeps the first spelling", () => {
    const r = buildRelations(
      [
        link("Acme Corp", "acquired", "Beta"),
        link("  ACME   corp ", "owns", "Gamma"),
        link("Beta", "supplies", "ACME CORP"),
      ],
      POS,
    );
    expect(r?.entities).toEqual(["Acme Corp", "Beta", "Gamma"]);
    expect(r?.links.map((l) => [l.from, l.to])).toEqual([
      [0, 1],
      [0, 2],
      [1, 0],
    ]);
  });

  it("drops a self-link (the same normalised endpoints) but keeps a link between two spellings of different parties", () => {
    const r = buildRelations(
      [...GOOD, link("Acme", "is", " acme "), link("Acme", "is", "Acme Inc")],
      POS,
    );
    expect(r?.links).toHaveLength(4);
    expect(r?.entities).toEqual(["Acme", "Beta Corp", "Cora", "Project X", "Acme Inc"]);
  });

  it("dedupes by from, rel and to, normalised, but keeps another relation between the same pair and the reverse direction", () => {
    const r = buildRelations(
      [
        link("Acme", "acquired", "Beta"),
        link(" ACME ", "Acquired", "beta"),
        link("Acme", "owns", "Beta"),
        link("Beta", "acquired", "Acme"),
      ],
      POS,
    );
    expect(r?.links.map((l) => [l.from, l.rel, l.to])).toEqual([
      [0, "acquired", 1],
      [0, "owns", 1],
      [1, "acquired", 0],
    ]);
  });

  it("clips parties to 80 and the relation to 40, and strips control characters", () => {
    const r = buildRelations(
      [
        link("p".repeat(120), "r".repeat(70), "Q\u0000uark"),
        link("Quark", "x\ny", "Third"),
        link("Third", "ok", "Fourth"),
      ],
      POS,
    );
    expect(r?.entities[0]).toBe("p".repeat(MAX_PARTY));
    expect(r?.links[0]?.rel).toBe("r".repeat(MAX_REL));
    expect(r?.entities[1]).toBe("Q uark");
    expect(r?.links[1]?.rel).toBe("x y");
  });

  it("drops a link with an empty or non-string endpoint or relation, and one that is not an object", () => {
    const r = buildRelations(
      [
        ...GOOD,
        link("", "r", "B"),
        link("A", " \u200b", "B"),
        link("A", "r", ""),
        { from: 1, rel: "r", to: "B", chunkIds: [ID(1)] },
        null,
        "x",
      ],
      POS,
    );
    expect(r?.links).toHaveLength(3);
  });

  it("cites only passages of this document and drops a link with none left; the cited passage is the earliest", () => {
    const r = buildRelations(
      [
        link("A", "r", "B", { chunkIds: [ID(4), ID(2)] }),
        link("B", "r", "C", { chunkIds: [ID(99)] }),
        link("C", "r", "D", { chunkIds: [] }),
        link("D", "r", "E", { chunkIds: undefined }),
        link("E", "r", "F", { chunkIds: [ID(99), ID(5)] }),
        link("F", "r", "G", { chunkIds: [ID(3)] }),
      ],
      POS,
    );
    expect(r?.links.map((l) => l.chunkId)).toEqual([ID(2), ID(5), ID(3)]);
    expect(r?.chunkIds).toEqual([ID(2), ID(5), ID(3)]);
    expect(r?.entities).toEqual(["A", "B", "E", "F", "G"]); // parties of dropped links are not listed
  });

  it("caps at 30 links in the model's order, and a capped fact never lists more than 60 parties", () => {
    const raw = Array.from({ length: 40 }, (_, i) => link(`From ${i}`, "to", `To ${i}`));
    const r = buildRelations(raw, POS);
    expect(r?.links).toHaveLength(MAX_LINKS);
    expect(r?.links.at(-1)).toEqual({ from: 58, to: 59, rel: "to", chunkId: ID(1) });
    expect(r?.entities).toHaveLength(60);
    expect(r?.entities.at(-1)).toBe("To 29");
  });

  it("needs at least 3 links after every drop: 3 is a fact, 2 and 0 are none", () => {
    expect(buildRelations(GOOD, POS)).not.toBeNull();
    expect(buildRelations(GOOD.slice(0, 2), POS)).toBeNull();
    expect(buildRelations([GOOD[0], GOOD[0], GOOD[1]], POS)).toBeNull();
    expect(buildRelations([], POS)).toBeNull();
  });
});

describe("rawLinksOf", () => {
  it("reads the links list of a relations field, and nothing from anything else", () => {
    expect(rawLinksOf({ links: [1, 2] })).toEqual([1, 2]);
    for (const v of [undefined, null, "x", { links: "x" }, {}]) expect(rawLinksOf(v)).toEqual([]);
  });
  it("reads a bare list as the links", () => {
    expect(rawLinksOf([1, 2])).toEqual([1, 2]);
    expect(rawLinksOf(Array.from({ length: 500 }, (_, i) => i))).toHaveLength(200);
  });
  it("hands over at most 200 items", () => {
    expect(rawLinksOf({ links: Array.from({ length: 500 }, (_, i) => i) })).toHaveLength(200);
  });
});
