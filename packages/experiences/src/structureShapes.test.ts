import { DiagramValue, MAX_DIAGRAM_NODES, diagramProblems } from "@loom-ui/core";
import { describe, expect, it } from "vitest";
import {
  entityMapDiagram,
  outlineDiagram,
  relationshipsDiagram,
  timelineDiagram,
} from "./structureShapes";
import { MAX_RELATION_ENTITIES } from "./visuals";
import type { EntityMapFact, OutlineFact, RelationsFact, TimelineFact } from "./visuals";

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

const TIMELINE: TimelineFact = {
  kind: "timeline",
  events: [
    {
      at: "2024-03-01",
      precision: "month",
      when: "March 2024",
      label: "Acme acquires Beta",
      chunkId: cid(1),
    },
    { at: "2025-07-01", precision: "quarter", when: "Q3 2025", label: "Launch", chunkId: cid(2) },
    {
      at: "2026-02-14",
      precision: "day",
      when: "14 February 2026",
      label: "Office opens",
      chunkId: cid(3),
    },
  ],
  chunkIds: [cid(1), cid(2), cid(3)],
  ordinal: 18,
};
const E0 = TIMELINE.events[0] as TimelineFact["events"][number];
const RELATIONS: RelationsFact = {
  kind: "relations",
  entities: ["Acme", "Beta Corp", "Cora", "Project X"],
  links: [
    { from: 0, to: 1, rel: "acquired", chunkId: cid(1) },
    { from: 2, to: 3, rel: "leads", chunkId: cid(2) },
    { from: 0, to: 3, rel: "owns", chunkId: cid(3) },
  ],
  chunkIds: [cid(1), cid(2), cid(3)],
  ordinal: 19,
};
const L0 = RELATIONS.links[0] as RelationsFact["links"][number];

describe("timelineDiagram", () => {
  it("is a timeline of dated nodes with no edges and a date-only axis; the written date prefixes every label that is not dated to the day", () => {
    const v = timelineDiagram(TIMELINE);
    expect(v?.layout).toBe("timeline");
    expect(v?.timeFormat).toEqual({ granularity: "day" });
    expect(v?.edges).toEqual([]);
    expect(v?.nodes).toEqual([
      {
        id: "t0",
        label: "March 2024 · Acme acquires Beta",
        group: "month",
        kind: "event",
        at: "2024-03-01",
      },
      { id: "t1", label: "Q3 2025 · Launch", group: "quarter", kind: "event", at: "2025-07-01" },
      { id: "t2", label: "Office opens", group: "day", kind: "event", at: "2026-02-14" },
    ]);
  });

  it("is a value loom-ui accepts as a Diagram, and every node has a parseable `at`", () => {
    const v = timelineDiagram(TIMELINE);
    expect(diagramProblems(v as never)).toEqual([]);
    expect(DiagramValue.safeParse(v).success).toBe(true);
    for (const n of v?.nodes ?? []) expect(Number.isNaN(Date.parse(n.at as string))).toBe(false);
    // the control: loom-ui does refuse an undated timeline node
    expect(
      diagramProblems({ layout: "timeline", nodes: [{ id: "a", label: "A" }], edges: [] }).length,
    ).toBeGreaterThan(0);
  });

  it("is null for no events, an `at` that is not a date, and more events than a diagram holds (at the cap it still fits)", () => {
    expect(timelineDiagram({ ...TIMELINE, events: [] })).toBeNull();
    expect(
      timelineDiagram({
        ...TIMELINE,
        events: [{ ...E0, at: "soon" }, ...TIMELINE.events.slice(1)],
      }),
    ).toBeNull();
    const events = (n: number) => Array.from({ length: n }, (_, i) => ({ ...E0, label: `E${i}` }));
    expect(timelineDiagram({ ...TIMELINE, events: events(MAX_DIAGRAM_NODES) })).not.toBeNull();
    expect(timelineDiagram({ ...TIMELINE, events: events(MAX_DIAGRAM_NODES + 1) })).toBeNull();
  });
});

describe("relationshipsDiagram", () => {
  it("is a network of the parties, a directed edge from to to labelled with the relation", () => {
    const v = relationshipsDiagram(RELATIONS);
    expect(v?.layout).toBe("network");
    expect(v?.nodes).toEqual([
      { id: "n0", label: "Acme", group: "party", kind: "party" },
      { id: "n1", label: "Beta Corp", group: "party", kind: "party" },
      { id: "n2", label: "Cora", group: "party", kind: "party" },
      { id: "n3", label: "Project X", group: "party", kind: "party" },
    ]);
    expect(v?.edges).toEqual([
      { from: "n0", to: "n1", label: "acquired" },
      { from: "n2", to: "n3", label: "leads" },
      { from: "n0", to: "n3", label: "owns" },
    ]);
    expect(DiagramValue.safeParse(v).success).toBe(true);
  });

  it("keeps two relations between the same pair as two labelled edges", () => {
    const v = relationshipsDiagram({
      ...RELATIONS,
      links: [L0, { ...L0, rel: "owns" }, ...RELATIONS.links.slice(1)],
    });
    expect(v?.edges.filter((e) => e.from === "n0" && e.to === "n1").map((e) => e.label)).toEqual([
      "acquired",
      "owns",
    ]);
    expect(DiagramValue.safeParse(v).success).toBe(true);
  });

  it("is null for fewer than 2 parties, no links, a self-link, a link to an unlisted party, and more parties than a diagram holds", () => {
    expect(relationshipsDiagram({ ...RELATIONS, entities: ["Only"] })).toBeNull();
    expect(relationshipsDiagram({ ...RELATIONS, links: [] })).toBeNull();
    expect(relationshipsDiagram({ ...RELATIONS, links: [{ ...L0, from: 1, to: 1 }] })).toBeNull();
    expect(relationshipsDiagram({ ...RELATIONS, links: [{ ...L0, to: 9 }] })).toBeNull();
    const parties = (n: number) => Array.from({ length: n }, (_, i) => `P${i}`);
    expect(
      relationshipsDiagram({ ...RELATIONS, entities: parties(MAX_RELATION_ENTITIES) }),
    ).not.toBeNull();
    expect(
      relationshipsDiagram({ ...RELATIONS, entities: parties(MAX_RELATION_ENTITIES + 1) }),
    ).toBeNull();
    expect(MAX_RELATION_ENTITIES).toBeLessThan(MAX_DIAGRAM_NODES);
  });

  it("is null when two parties are one name once normalised, however they are spelled, and keeps distinct names", () => {
    const dup = (b: string) => ({ ...RELATIONS, entities: ["Acme", b, "Cora", "Project X"] });
    expect(relationshipsDiagram(dup("acme"))).toBeNull();
    expect(relationshipsDiagram(dup("  ACME "))).toBeNull();
    expect(relationshipsDiagram(dup("\uff21cme"))).toBeNull();
    expect(relationshipsDiagram(dup("Acme  Two"))).not.toBeNull();
  });
});
