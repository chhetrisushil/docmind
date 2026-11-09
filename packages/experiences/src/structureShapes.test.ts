import { DiagramValue, MAX_DIAGRAM_NODES, diagramProblems } from "@loom-ui/core";
import { describe, expect, it } from "vitest";
import { entityMapDiagram, outlineDiagram } from "./structureShapes";
import type { EntityMapFact, OutlineFact } from "./visuals";

const cid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** Outline nodes from (label, level) pairs, with the ids `s<index>` the builder gives them. */
const nodes = (...specs: [string, number][]) =>
  specs.map(([label, level], i) => ({
    id: `s${i}`,
    label,
    level,
    passageCount: 1,
    firstChunkId: cid(i + 1),
  }));
const OUTLINE: OutlineFact = {
  kind: "outline",
  title: "Annual report",
  nodes: nodes(["Intro", 1], ["Methods", 1], ["Data", 2], ["Model", 2], ["Results", 1]),
  chunkIds: [cid(1)],
  ordinal: 16,
};
const MAP: EntityMapFact = {
  kind: "cooccurrence",
  entities: [
    { name: "Acme", entityKind: "organization", passages: 4 },
    { name: "Bolt", entityKind: "organization", passages: 3 },
    { name: "Cora", entityKind: "person", passages: 2 },
  ],
  edges: [
    { a: 0, b: 1, weight: 3, firstChunkId: cid(1) },
    { a: 0, b: 2, weight: 2, firstChunkId: cid(2) },
  ],
  chunkIds: [cid(1), cid(2)],
  ordinal: 17,
};

describe("outlineDiagram", () => {
  it("is a tree rooted at the document title, with parent to child edges, the fact's node ids and the level as the group", () => {
    const v = outlineDiagram(OUTLINE);
    expect(v?.layout).toBe("tree");
    expect(v?.nodes[0]).toEqual({
      id: "root",
      label: "Annual report",
      group: "0",
      kind: "document",
    });
    expect(v?.nodes.map((n) => [n.id, n.label, n.group])).toEqual([
      ["root", "Annual report", "0"],
      ["s0", "Intro", "1"],
      ["s1", "Methods", "1"],
      ["s2", "Data", "2"],
      ["s3", "Model", "2"],
      ["s4", "Results", "1"],
    ]);
    expect(v?.edges.map((e) => [e.from, e.to])).toEqual([
      ["root", "s0"],
      ["root", "s1"],
      ["s1", "s2"],
      ["s1", "s3"],
      ["root", "s4"],
    ]);
    expect(diagramProblems(v as never)).toEqual([]);
    expect(DiagramValue.safeParse(v).success).toBe(true);
  });

  it("does not fit when the nesting is broken or the diagram is over loom-ui's cap", () => {
    expect(
      outlineDiagram({ ...OUTLINE, nodes: nodes(["Deep", 2], ["A", 1], ["B", 1]) }),
    ).toBeNull(); // first node is level 2
    expect(outlineDiagram({ ...OUTLINE, nodes: nodes(["A", 1], ["B", 3], ["C", 1]) })).toBeNull(); // a level is skipped
    const many = nodes(
      ...Array.from({ length: MAX_DIAGRAM_NODES }, (_, i): [string, number] => [`H${i}`, 1]),
    );
    expect(outlineDiagram({ ...OUTLINE, nodes: many })).toBeNull(); // the root makes 201
  });

  it("does not fit when a node id repeats or is the root's", () => {
    expect(
      outlineDiagram({ ...OUTLINE, nodes: OUTLINE.nodes.map((n) => ({ ...n, id: "s0" })) }),
    ).toBeNull();
    expect(
      outlineDiagram({
        ...OUTLINE,
        nodes: OUTLINE.nodes.map((n, i) => (i === 1 ? { ...n, id: "root" } : n)),
      }),
    ).toBeNull();
  });

  it("does not fit with zero section nodes", () => {
    expect(outlineDiagram({ ...OUTLINE, nodes: [] })).toBeNull();
  });

  it("stays a valid tree at the 120-node cap", () => {
    const at = nodes(
      ...Array.from({ length: 120 }, (_, i): [string, number] => [`H${i}`, i % 3 === 0 ? 1 : 2]),
    );
    const v = outlineDiagram({ ...OUTLINE, nodes: at });
    expect(v?.nodes).toHaveLength(121);
    expect(diagramProblems(v as never)).toEqual([]);
  });
});

describe("entityMapDiagram", () => {
  it("is a network of entities grouped by kind, with the shared-passage count on each edge", () => {
    const v = entityMapDiagram(MAP);
    expect(v?.layout).toBe("network");
    expect(v?.nodes).toEqual([
      { id: "e0", label: "Acme", group: "organization", kind: "organization" },
      { id: "e1", label: "Bolt", group: "organization", kind: "organization" },
      { id: "e2", label: "Cora", group: "person", kind: "person" },
    ]);
    expect(v?.edges).toEqual([
      { from: "e0", to: "e1", label: "3" },
      { from: "e0", to: "e2", label: "2" },
    ]);
    expect(diagramProblems(v as never)).toEqual([]);
  });

  it("does not fit when an edge names an entity that is not there", () => {
    expect(
      entityMapDiagram({ ...MAP, edges: [{ a: 0, b: 7, weight: 2, firstChunkId: cid(1) }] }),
    ).toBeNull();
  });

  it("does not fit with fewer than 2 entities or no edges", () => {
    expect(
      entityMapDiagram({ ...MAP, entities: [MAP.entities[0] as never], edges: [] }),
    ).toBeNull();
    expect(entityMapDiagram({ ...MAP, edges: [] })).toBeNull();
  });

  it("does not fit when the same pair repeats, in either direction", () => {
    const e = (a: number, b: number) => ({ a, b, weight: 2, firstChunkId: cid(1) });
    expect(entityMapDiagram({ ...MAP, edges: [e(0, 1), e(0, 1)] })).toBeNull();
    expect(entityMapDiagram({ ...MAP, edges: [e(0, 1), e(1, 0)] })).toBeNull();
  });
});
