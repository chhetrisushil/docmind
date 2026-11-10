import { MAX_DIAGRAM_NODES, diagramProblems } from "@loom-ui/core";
import { MAX_RELATION_ENTITIES, nameKey } from "./visuals";
import type { EntityMapFact, OutlineFact, RelationsFact, TimelineFact } from "./visuals";

export interface DiagramNode {
  id: string;
  label: string;
  group: string;
  kind: string;
  /** A timeline node's date (`YYYY-MM-DD`); loom-ui refuses a timeline node without a parseable one. */
  at?: string;
}
export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
}
export interface DiagramShape {
  layout: "tree" | "network" | "timeline";
  /** How a timeline's dates read (loom-ui `TimeFormat`). */
  timeFormat?: { granularity: "day" };
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

/**
 * The document's dated events as a timeline: one node per event, `at` its ISO first day, no edges. An event dated to the day
 * is labelled with its text alone; any coarser event ("Q3 2025", "March 2024") is prefixed with the date as written, so the axis
 * never implies a day the document did not give. `timeFormat` is date-only (`day`, no zone): a tick is drawn as the written
 * date in every viewer zone. Null when loom-ui would refuse the value (no events, an `at` that is not a date, over the node cap).
 */
export function timelineDiagram(f: TimelineFact): DiagramShape | null {
  if (f.events.length === 0) return null;
  const nodes = f.events.map((e, i) => ({
    id: `t${i}`,
    label: e.precision === "day" ? e.label : `${e.when} · ${e.label}`,
    group: e.precision,
    kind: "event",
    at: e.at,
  }));
  return accepted({ layout: "timeline", timeFormat: { granularity: "day" }, nodes, edges: [] });
}

/**
 * The parties as a network (they are already one node per normalised name), a directed edge from to to per link labelled with
 * the relation: two relations between one pair are two edges. Null when loom-ui would refuse the value, more than 60 parties, two parties that are one name once normalised, a link names a party
 * that is not listed, or joins a party to itself.
 */
export function relationshipsDiagram(f: RelationsFact): DiagramShape | null {
  if (f.entities.length < 2 || f.entities.length > MAX_RELATION_ENTITIES || f.links.length === 0)
    return null;
  if (new Set(f.entities.map(nameKey)).size !== f.entities.length) return null;
  const nodes = f.entities.map((name, i) => ({
    id: `n${i}`,
    label: name,
    group: "party",
    kind: "party",
  }));
  const edges: DiagramEdge[] = [];
  for (const l of f.links) {
    if (l.from === l.to || nodes[l.from] === undefined || nodes[l.to] === undefined) return null;
    edges.push({ from: `n${l.from}`, to: `n${l.to}`, label: l.rel });
  }
  return accepted({ layout: "network", nodes, edges });
}
