import { MAX_DIAGRAM_NODES, diagramProblems } from "@loom-ui/core";
import type { EntityMapFact, OutlineFact } from "./visuals";

export interface DiagramNode {
  id: string;
  label: string;
  group: string;
  kind: string;
}
export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
}
export interface DiagramShape {
  layout: "tree" | "network";
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

/** The shape if loom-ui accepts it as a `Diagram` value (`diagramProblems`: unique ids, one root, nodes and edges in range), else null. */
const accepted = (v: DiagramShape): DiagramShape | null =>
  v.nodes.length <= MAX_DIAGRAM_NODES && diagramProblems(v).length === 0 ? v : null;

/**
 * The document's sections as a tree: a root for the title, one node per section under the fact's own node id (group = its
 * level), an edge from each node's parent. The parent is the nearest earlier node one level up, so a first node below level 1
 * or a skipped level does not fit; an id that repeats or is "root" does not fit either (`diagramProblems`: unique ids).
 * Labels are text only.
 */
export function outlineDiagram(f: OutlineFact): DiagramShape | null {
  if (f.nodes.length === 0) return null;
  const nodes: DiagramNode[] = [{ id: "root", label: f.title, group: "0", kind: "document" }];
  const edges: DiagramEdge[] = [];
  const open = ["root"]; // open[level] is the latest node id at that level
  for (const n of f.nodes) {
    const parent = open[n.level - 1];
    if (parent === undefined) return null;
    nodes.push({ id: n.id, label: n.label, group: String(n.level), kind: "section" });
    edges.push({ from: parent, to: n.id });
    open.length = n.level;
    open.push(n.id);
  }
  return accepted({ layout: "tree", nodes, edges });
}

/** The entities as a network (group = their kind), an edge per co-occurrence labelled with the shared-passage count. */
export function entityMapDiagram(f: EntityMapFact): DiagramShape | null {
  const nodes = f.entities.map((e, i) => ({
    id: `e${i}`,
    label: e.name,
    group: e.entityKind,
    kind: e.entityKind,
  }));
  if (nodes.length < 2 || f.edges.length === 0) return null;
  const edges: DiagramEdge[] = [];
  const pairs = new Set<string>();
  for (const e of f.edges) {
    if (e.a === e.b || nodes[e.a] === undefined || nodes[e.b] === undefined) return null;
    const pair = e.a < e.b ? `${e.a}-${e.b}` : `${e.b}-${e.a}`;
    if (pairs.has(pair)) return null; // a-b and b-a are one edge
    pairs.add(pair);
    edges.push({ from: `e${e.a}`, to: `e${e.b}`, label: String(e.weight) });
  }
  return accepted({ layout: "network", nodes, edges });
}
