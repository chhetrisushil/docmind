import { describe, expect, it } from "vitest";
import {
  type HeadingRow,
  MAX_OUTLINE_NODES,
  UNTITLED_DOCUMENT,
  buildOutline,
  outlineTitle,
} from "./outline";
import { clipLabel, clipText } from "./structureText";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** Rows of consecutive sections: `section(ordinal, path, passages)` makes `passages` rows sharing one section ordinal. */
function sections(...specs: [number, string[], number?][]): HeadingRow[] {
  const rows: HeadingRow[] = [];
  let n = 0;
  for (const [sectionOrdinal, headingPath, passages = 1] of specs)
    for (let i = 0; i < passages; i++) rows.push({ chunkId: id(++n), sectionOrdinal, headingPath });
  return rows;
}

describe("clipText and clipLabel", () => {
  it("clips to the limit without ending in half a surrogate pair", () => {
    expect(clipText("abcdef", 3)).toBe("abc");
    expect(clipText("ab😀", 3)).toBe("ab"); // the emoji is two UTF-16 units: 3 would cut it in half
    expect(clipText("abc", 5)).toBe("abc");
  });
  it("trims, then clips to 80 characters", () => {
    expect(clipLabel("  Methods  ")).toBe("Methods");
    expect(clipLabel("x".repeat(100))).toHaveLength(80);
    expect(clipLabel("   ")).toBe("");
  });
});

describe("buildOutline", () => {
  it("nests headings in document order and counts each section's own passages", () => {
    const rows = sections(
      [0, []], // text before the first heading makes no node
      [1, ["Intro"], 2],
      [2, ["Methods"]],
      [3, ["Methods", "Data"]],
      [4, ["Methods", "Model"]],
      [5, ["Results"]],
    );
    const o = buildOutline("Report", rows);
    expect(o?.title).toBe("Report");
    expect(o?.nodes.map((n) => [n.label, n.level, n.passageCount])).toEqual([
      ["Intro", 1, 2],
      ["Methods", 1, 1],
      ["Data", 2, 1],
      ["Model", 2, 1],
      ["Results", 1, 1],
    ]);
    // each node cites its first passage (rows are numbered from 1; row 1 is the empty-path preamble)
    expect(o?.nodes.map((n) => n.firstChunkId)).toEqual([id(2), id(4), id(5), id(6), id(7)]);
    // each node has an id unique by position (spec 3): the diagram node id
    expect(o?.nodes.map((n) => n.id)).toEqual(["s0", "s1", "s2", "s3", "s4"]);
  });

  it("makes the ancestors of a deep first section, with no passages of their own", () => {
    const rows = sections([1, ["A", "B"]], [2, ["A", "C"]], [3, ["D"]]);
    const o = buildOutline("T", rows);
    expect(o?.nodes.map((n) => [n.label, n.level, n.passageCount])).toEqual([
      ["A", 1, 0],
      ["B", 2, 1],
      ["C", 2, 1],
      ["D", 1, 1],
    ]);
    expect(o?.nodes[0]?.firstChunkId).toBe(id(1)); // the first descendant passage
  });

  it("keeps a duplicate heading under one parent as a separate node", () => {
    const o = buildOutline("T", sections([1, ["Notes"]], [2, ["Notes"]], [3, ["Other"]]));
    expect(o?.nodes.map((n) => n.label)).toEqual(["Notes", "Notes", "Other"]);
    expect(o?.nodes[0]?.firstChunkId).not.toBe(o?.nodes[1]?.firstChunkId);
  });

  it("produces no outline for fewer than 3 headings, counting distinct nodes", () => {
    expect(buildOutline("T", sections([1, ["A"]], [2, ["B"]]))).toBeNull();
    expect(buildOutline("T", sections([0, [], 5]))).toBeNull(); // a flat document
    expect(buildOutline("T", [])).toBeNull();
    expect(
      buildOutline("T", sections([1, ["A"]], [2, ["A", "B"]], [3, ["A", "C"]])),
    ).not.toBeNull();
  });

  it("trims and clips labels to 80 characters and names an empty one", () => {
    const o = buildOutline(
      "T",
      sections([1, ["  Spaced  "]], [2, ["x".repeat(120)]], [3, ["   "]]),
    );
    expect(o?.nodes.map((n) => n.label)).toEqual(["Spaced", "x".repeat(80), "Untitled section"]);
  });

  it("titles the root, naming an empty title", () => {
    expect(outlineTitle("  My doc  ")).toBe("My doc");
    expect(outlineTitle("")).toBe(UNTITLED_DOCUMENT);
    expect(outlineTitle("t".repeat(200))).toHaveLength(80);
  });

  it("prunes the deepest level first over the cap and folds its passage counts into the parent", () => {
    // 2 level-1 + 20 level-2 + 140 level-3 = 162 headings, one passage each.
    const specs: [number, string[]][] = [];
    let s = 0;
    for (const a of ["A", "B"])
      for (let b = 0; b < 10; b++) {
        specs.push([++s, [a, `${a}${b}`]]);
        for (let c = 0; c < 7; c++) specs.push([++s, [a, `${a}${b}`, `${a}${b}.${c}`]]);
      }
    const o = buildOutline("T", sections(...specs));
    expect(o?.nodes).toHaveLength(22); // level 3 gone; 22 <= 120
    expect(o?.nodes.every((n) => n.level <= 2)).toBe(true);
    // ids are numbered over the kept nodes, so they stay unique and contiguous after pruning
    expect(o?.nodes.map((n) => n.id)).toEqual(Array.from({ length: 22 }, (_, i) => `s${i}`));
    const level2 = o?.nodes.filter((n) => n.level === 2) ?? [];
    expect(level2.every((n) => n.passageCount === 8)).toBe(true); // 1 own + 7 folded
  });

  it("keeps the first 120 level-1 headings when level 1 alone is over the cap", () => {
    const specs: [number, string[]][] = Array.from({ length: 130 }, (_, i) => [i + 1, [`H${i}`]]);
    const o = buildOutline("T", sections(...specs));
    expect(o?.nodes).toHaveLength(MAX_OUTLINE_NODES);
    expect(o?.nodes[119]?.label).toBe("H119");
  });

  it("produces nothing when pruning leaves fewer than 3 nodes", () => {
    const specs: [number, string[]][] = [];
    for (let i = 0; i < 130; i++) specs.push([i + 1, ["Only", `Sub${i}`]]);
    expect(buildOutline("T", sections(...specs))).toBeNull(); // pruning level 2 leaves just "Only"
  });

  it("orders the cited passages by level, then document order, without repeats", () => {
    const rows = sections([1, ["A"]], [2, ["A", "B"]], [3, ["C"]], [4, ["C", "D"]]);
    const o = buildOutline("T", rows);
    expect(o?.nodes.map((n) => n.label)).toEqual(["A", "B", "C", "D"]);
    expect(o?.chunkIds).toEqual([id(1), id(3), id(2), id(4)]); // A, C (level 1), then B, D
  });
});
