import { DiagramValue, MAX_DIAGRAM_NODES, TableValue, diagramProblems } from "@loom-ui/core";
import { describe, expect, it } from "vitest";
import { EMPTY_RELATED, SELF_LABEL } from "./connectionShapes";
import type { RawConnections } from "./invoker";
import { shape } from "./reshapers";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SELF = uuid(1);
const B = uuid(2);
const C = uuid(3);
const D = uuid(4);

const RAW: RawConnections = {
  documentId: SELF,
  related: [
    {
      documentId: B,
      title: "Contract B",
      kinds: { entity: 2, reference: 0, similar: 0 },
      strength: 0.9,
    },
    {
      documentId: C,
      title: "Notes C",
      kinds: { entity: 0, reference: 0, similar: 3 },
      strength: 0.6,
    },
    {
      documentId: D,
      title: "Memo D",
      kinds: { entity: 0, reference: 1, similar: 0 },
      strength: 0.4,
    },
  ],
  entities: [
    {
      entityId: uuid(10),
      name: "Acme Corp",
      kind: "organization",
      documents: [{ documentId: B, title: "Contract B" }],
    },
    {
      entityId: uuid(11),
      name: "Jane Doe",
      kind: "person",
      documents: [
        { documentId: B, title: "Contract B" },
        { documentId: uuid(99), title: "Not a node" },
      ],
    },
  ],
};
const EMPTY: RawConnections = { documentId: SELF, related: [], entities: [] };

type Table = {
  columns: unknown[];
  rows: unknown[][];
  rowKeys?: string[];
  rowActions?: { id: string; label: string; primary?: boolean }[][];
  refs?: unknown;
};
type Diagram = {
  layout: string;
  nodes: { id: string; label: string; group?: string; kind?: string }[];
  edges: { from: string; to: string; label?: string; kind?: string }[];
  refs?: unknown;
};

describe("connections-table", () => {
  const t = shape("connections-table", RAW) as Table;

  it("has Document, Why and Strength columns and one keyed row per related document, in order", () => {
    expect(t.columns).toEqual([
      "Document",
      "Why",
      { label: "Strength", format: { semanticType: "percentage", maximumFractionDigits: 0 } },
    ]);
    expect(t.rows).toEqual([
      ["Contract B", "shares Acme Corp, Jane Doe", 0.9],
      ["Notes C", "similar content", 0.6],
      ["Memo D", "referenced", 0.4],
    ]);
    expect(t.rowKeys).toEqual([B, C, D]);
  });

  it("gives every row one primary Open action and cites nothing", () => {
    expect(t.rowActions).toEqual([
      [{ id: "open", label: "Open", primary: true }],
      [{ id: "open", label: "Open", primary: true }],
      [{ id: "open", label: "Open", primary: true }],
    ]);
    expect(t.refs).toBeUndefined();
  });

  it("is a valid loom-ui Table value", () => {
    expect(TableValue.safeParse(t).success).toBe(true);
  });

  it("joins the kinds that apply, names at most three shared entities, and says 'entities' when none is listed", () => {
    const many: RawConnections = {
      documentId: SELF,
      related: [
        { documentId: B, title: "B", kinds: { entity: 1, reference: 1, similar: 1 }, strength: 1 },
        { documentId: C, title: "C", kinds: { entity: 1, reference: 0, similar: 0 }, strength: 1 },
      ],
      entities: ["One", "Two", "Three", "Four"].map((name, i) => ({
        entityId: uuid(20 + i),
        name,
        kind: "other",
        documents: [{ documentId: B, title: "B" }],
      })),
    };
    const rows = (shape("connections-table", many) as Table).rows;
    expect(rows[0]?.[1]).toBe("shares One, Two, Three; referenced; similar content");
    expect(rows[1]?.[1]).toBe("shares entities");
  });

  it("is a single visible placeholder row, with no keys or actions, when nothing is connected", () => {
    const e = shape("connections-table", EMPTY) as Table;
    expect(e.rows).toEqual([[EMPTY_RELATED, "", ""]]);
    expect(EMPTY_RELATED).toBe("No connected documents yet");
    expect(e.rowKeys).toBeUndefined();
    expect(e.rowActions).toBeUndefined();
    expect(TableValue.safeParse(e).success).toBe(true);
  });

  it("labels an untitled document and clips a very long title", () => {
    const odd: RawConnections = {
      documentId: SELF,
      related: [
        {
          documentId: B,
          title: "  ",
          kinds: { entity: 0, reference: 0, similar: 1 },
          strength: 0.5,
        },
        {
          documentId: C,
          title: "x".repeat(500),
          kinds: { entity: 0, reference: 0, similar: 1 },
          strength: 0.4,
        },
      ],
      entities: [],
    };
    const rows = (shape("connections-table", odd) as Table).rows;
    expect(rows[0]?.[0]).toBe("Untitled document");
    expect((rows[1]?.[0] as string).length).toBe(200);
  });
});

describe("connections-map", () => {
  const m = shape("connections-map", RAW) as Diagram;

  it("is a network of this document, the related documents and the shared entities, with prefixed unique ids", () => {
    expect(m.layout).toBe("network");
    expect(m.nodes).toEqual([
      { id: `doc:${SELF}`, label: SELF_LABEL, group: "self" },
      { id: `doc:${B}`, label: "Contract B", group: "document" },
      { id: `doc:${C}`, label: "Notes C", group: "document" },
      { id: `doc:${D}`, label: "Memo D", group: "document" },
      { id: `ent:${uuid(10)}`, label: "Acme Corp", group: "entity", kind: "organization" },
      { id: `ent:${uuid(11)}`, label: "Jane Doe", group: "entity", kind: "person" },
    ]);
    expect(new Set(m.nodes.map((n) => n.id)).size).toBe(m.nodes.length);
  });

  it("links self to a document by a reference or similar link (labelled), and documents to the entities they share (spec 4: no self edge for an entity a listed document has)", () => {
    expect(m.edges).toEqual([
      { from: `doc:${SELF}`, to: `doc:${C}`, label: "similar", kind: "similar" },
      { from: `doc:${SELF}`, to: `doc:${D}`, label: "reference", kind: "reference" },
      { from: `doc:${B}`, to: `ent:${uuid(10)}` },
      { from: `doc:${B}`, to: `ent:${uuid(11)}` },
    ]);
  });

  it("names only documents that are nodes, and passes loom-ui's diagram checks, with no refs", () => {
    expect(m.edges.every((e) => m.nodes.some((n) => n.id === e.to))).toBe(true);
    expect(diagramProblems(m)).toEqual([]);
    expect(DiagramValue.safeParse(m).success).toBe(true);
    expect(m.refs).toBeUndefined();
  });

  it("is one self node when nothing is connected", () => {
    const e = shape("connections-map", EMPTY) as Diagram;
    expect(e.nodes).toEqual([{ id: `doc:${SELF}`, label: SELF_LABEL, group: "self" }]);
    expect(e.edges).toEqual([]);
    expect(diagramProblems(e)).toEqual([]);
  });

  it("never exceeds 21 nodes, even from an over-long raw value, and stays clean", () => {
    const big: RawConnections = {
      documentId: SELF,
      related: Array.from({ length: 30 }, (_, i) => ({
        documentId: uuid(100 + i),
        title: `D${i}`,
        kinds: { entity: 0, reference: 1, similar: 0 },
        strength: 0.5,
      })),
      entities: Array.from({ length: 30 }, (_, i) => ({
        entityId: uuid(200 + i),
        name: `E${i}`,
        kind: "person",
        documents: Array.from({ length: 12 }, (_, j) => ({
          documentId: uuid(100 + j),
          title: `D${j}`,
        })),
      })),
    };
    const out = shape("connections-map", big) as Diagram;
    expect(out.nodes.length).toBe(21);
    expect(out.nodes.length).toBeLessThanOrEqual(MAX_DIAGRAM_NODES);
    expect(diagramProblems(out)).toEqual([]);
    expect(new Set(out.edges.map((e) => `${e.from}>${e.to}`)).size).toBe(out.edges.length);
  });

  it("links self to an entity only when no listed related document has it", () => {
    const solo: RawConnections = {
      documentId: SELF,
      related: [RAW.related[0]] as never,
      entities: [
        {
          entityId: uuid(30),
          name: "Orphan",
          kind: "person",
          documents: [{ documentId: uuid(98), title: "x" }],
        },
        { entityId: uuid(31), name: "Empty", kind: "person", documents: [] },
      ],
    };
    const out = shape("connections-map", solo) as Diagram;
    expect(out.edges).toEqual([
      { from: `doc:${SELF}`, to: `ent:${uuid(30)}` },
      { from: `doc:${SELF}`, to: `ent:${uuid(31)}` },
    ]);
    expect(diagramProblems(out)).toEqual([]);
  });

  it("keeps ids unique when the same document or entity appears twice", () => {
    const dup: RawConnections = {
      documentId: SELF,
      related: [RAW.related[0], RAW.related[0], { ...RAW.related[1], documentId: SELF }] as never,
      entities: [RAW.entities[0], RAW.entities[0]] as never,
    };
    const out = shape("connections-map", dup) as Diagram;
    expect(diagramProblems(out)).toEqual([]);
  });
});
