import { clipLabel } from "./structureText";

export const MAX_OUTLINE_NODES = 120;
export const MIN_HEADINGS = 3;
/** Heading depth is clamped here (markdown stops at 6, other formats go deeper). */
export const MAX_OUTLINE_LEVEL = 32;
export const UNTITLED_DOCUMENT = "Untitled document";
const UNTITLED_SECTION = "Untitled section";

export interface OutlineNode {
  /** `s<index>` among the kept nodes: unique by position (spec 3), and the diagram node id. */
  id: string;
  label: string;
  /** 1 for a top-level heading. A node's parent is the nearest earlier node of `level - 1`. */
  level: number;
  /** The passages of this section, plus those of pruned descendants folded into it. */
  passageCount: number;
  /** The first passage of the section (of its first descendant, for an ancestor with no section of its own). */
  firstChunkId: string;
}

export interface OutlineDraft {
  kind: "outline";
  title: string;
  /** In document (pre-)order. */
  nodes: OutlineNode[];
  /** The distinct `firstChunkId`s, top-level sections first, then document order. */
  chunkIds: string[];
}

/** A passage as the outline sees it: its section (plaintext ordinal) and the sealed heading path, opened. */
export interface HeadingRow {
  chunkId: string;
  sectionOrdinal: number;
  headingPath: readonly string[];
  /** The passages this row stands for (the section's first passage carries the section's count); default 1. */
  passages?: number;
}

export const outlineTitle = (raw: string): string => clipLabel(raw) || UNTITLED_DOCUMENT;

interface Built {
  /** The trimmed, unclipped heading: ancestors merge on this, so headings differing only past 80 characters stay apart. */
  key: string;
  label: string;
  level: number;
  parent: number;
  own: number;
  first: string;
}

/**
 * The document's sections as a tree, or null when it has fewer than 3 headings (also after pruning). `rows` are the
 * document's passages in passage order. A new `sectionOrdinal` starts a new section: its ancestors reuse the open path
 * where the text matches and its leaf is always a new node, so a duplicate heading under one parent stays separate.
 * Over `MAX_OUTLINE_NODES` the deepest levels go first, each pruned node's passages folded into its parent.
 */
export function buildOutline(title: string, rows: readonly HeadingRow[]): OutlineDraft | null {
  const nodes: Built[] = [];
  let stack: number[] = [];
  let section: number | undefined;
  for (const row of rows) {
    const raw = row.headingPath.slice(0, MAX_OUTLINE_LEVEL).map((h) => h.trim());
    const path = raw.map((h) => clipLabel(h) || UNTITLED_SECTION);
    if (path.length === 0) {
      stack = []; // text before the first heading: no node
      section = row.sectionOrdinal;
      continue;
    }
    if (row.sectionOrdinal !== section) {
      section = row.sectionOrdinal;
      let shared = 0;
      while (
        shared < path.length - 1 &&
        shared < stack.length &&
        nodes[stack[shared] as number]?.key === raw[shared]
      )
        shared++;
      stack = stack.slice(0, shared);
      for (let depth = shared; depth < path.length; depth++) {
        nodes.push({
          key: raw[depth] as string,
          label: path[depth] as string,
          level: depth + 1,
          parent: depth === 0 ? -1 : (stack[depth - 1] as number),
          own: 0,
          first: row.chunkId,
        });
        stack.push(nodes.length - 1);
      }
    }
    const leaf = stack[stack.length - 1];
    if (leaf !== undefined) (nodes[leaf] as Built).own += row.passages ?? 1;
  }
  if (nodes.length < MIN_HEADINGS) return null;

  const alive = nodes.map(() => true);
  let count = nodes.length;
  while (count > MAX_OUTLINE_NODES) {
    let deepest = 0;
    nodes.forEach((n, i) => {
      if (alive[i] && n.level > deepest) deepest = n.level;
    });
    if (deepest <= 1) break;
    nodes.forEach((n, i) => {
      if (!alive[i] || n.level !== deepest) return;
      alive[i] = false;
      count--;
      (nodes[n.parent] as Built).own += n.own;
    });
  }
  if (count > MAX_OUTLINE_NODES) {
    // Only level 1 is left: keep the first 120 in document order.
    let kept = 0;
    nodes.forEach((_, i) => {
      if (!alive[i]) return;
      if (kept < MAX_OUTLINE_NODES) kept++;
      else {
        alive[i] = false;
        count--;
      }
    });
  }
  const live = nodes.filter((_, i) => alive[i]);
  if (live.length < MIN_HEADINGS) return null;
  const out: OutlineNode[] = live.map((n, i) => ({
    id: `s${i}`,
    label: n.label,
    level: n.level,
    passageCount: n.own,
    firstChunkId: n.first,
  }));
  const byLevel = [...out.keys()].sort(
    (a, b) => (out[a] as OutlineNode).level - (out[b] as OutlineNode).level || a - b,
  );
  const chunkIds = [...new Set(byLevel.map((i) => (out[i] as OutlineNode).firstChunkId))];
  return { kind: "outline", title: outlineTitle(title), nodes: out, chunkIds };
}
