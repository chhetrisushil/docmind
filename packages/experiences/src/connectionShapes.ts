import type { RawConnections } from "./invoker";
import { CONNECTIONS_CAPS } from "./providers";

export const EMPTY_RELATED = "No connected documents yet";
export const SELF_LABEL = "This document";
const UNTITLED = "Untitled document";
const MAX_LABEL = 200;
const MAX_NAMES = 3;

/** Cuts to at most `max` UTF-16 units, never ending in half a surrogate pair. */
const clip = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
};
const label = (title: string): string =>
  title.trim() === "" ? UNTITLED : clip(title.trim(), MAX_LABEL);

type Related = RawConnections["related"][number];

/** The listed related documents, deduplicated once for both shapes: no repeat of an id and never this document itself. */
const relatedOf = (raw: RawConnections): Related[] => {
  const seen = new Set<string>([raw.documentId]);
  return raw.related
    .slice(0, CONNECTIONS_CAPS.related)
    .filter((r) => !seen.has(r.documentId) && seen.add(r.documentId));
};

/** "shares A, B; referenced; similar content": the kinds that apply, the top shared names (rarest entity first). */
const whyOf = (r: Related, names: readonly string[]): string => {
  const parts: string[] = [];
  if (r.kinds.entity > 0)
    parts.push(names.length > 0 ? `shares ${names.join(", ")}` : "shares entities");
  if (r.kinds.reference > 0) parts.push("referenced");
  if (r.kinds.similar > 0) parts.push("similar content");
  return parts.length > 0 ? parts.join("; ") : "connected";
};

const COLUMNS = [
  "Document",
  "Why",
  { label: "Strength", format: { semanticType: "percentage", maximumFractionDigits: 0 } },
];

/**
 * A Table has no visible caption of its own (loom-ui's `<caption>` is for screen readers), so the empty state is one row
 * that says it. No row keys and no actions: nothing to open.
 */
const table = (raw: RawConnections): unknown => {
  const related = relatedOf(raw);
  if (related.length === 0) return { columns: COLUMNS, rows: [[EMPTY_RELATED, "", ""]] };
  const namesFor = (documentId: string): string[] =>
    raw.entities
      .filter((e) => e.documents.some((d) => d.documentId === documentId))
      .map((e) => e.name)
      .slice(0, MAX_NAMES);
  return {
    columns: COLUMNS,
    rows: related.map((r) => [label(r.title), whyOf(r, namesFor(r.documentId)), r.strength]),
    rowKeys: related.map((r) => r.documentId),
    rowActions: related.map(() => [{ id: "open", label: "Open", primary: true }]),
  };
};

type Node = { id: string; label: string; group: string; kind?: string };
type Edge = { from: string; to: string; label?: string; kind?: string };

const map = (raw: RawConnections): unknown => {
  const self = `doc:${raw.documentId}`;
  const nodes: Node[] = [{ id: self, label: SELF_LABEL, group: "self" }];
  const edges: Edge[] = [];
  const ids = new Set([self]);
  const seenEdges = new Set<string>();
  const edge = (e: Edge) => {
    const key = `${e.from}>${e.to}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    edges.push(e);
  };
  for (const r of relatedOf(raw)) {
    const id = `doc:${r.documentId}`;
    ids.add(id);
    nodes.push({ id, label: label(r.title), group: "document" });
    const kind = r.kinds.reference > 0 ? "reference" : r.kinds.similar > 0 ? "similar" : undefined;
    if (kind !== undefined) edge({ from: self, to: id, label: kind, kind });
  }
  for (const e of raw.entities.slice(0, CONNECTIONS_CAPS.entities)) {
    const id = `ent:${e.entityId}`;
    if (ids.has(id)) continue;
    ids.add(id);
    nodes.push({ id, label: label(e.name), group: "entity", kind: e.kind });
    // Spec 4: self links to an entity only when no listed related document has it; otherwise the document carries the link.
    const owners = e.documents
      .map((d) => `doc:${d.documentId}`)
      .filter((from) => from !== self && ids.has(from));
    if (owners.length === 0) edge({ from: self, to: id });
    for (const from of owners) edge({ from, to: id });
  }
  return { layout: "network", nodes, edges };
};

/** The two connections reshapers, by name (they are also the provider handles `CONNECTION_HANDLE`). Both are total on empty data. */
export const CONNECTION_SHAPES: Record<string, (raw: never) => unknown> = {
  "connections-table": (raw: RawConnections) => table(raw),
  "connections-map": (raw: RawConnections) => map(raw),
};
