import type { ParsedSection } from "@docmind/parsers";
import { describe, expect, it } from "vitest";
import { SUMMARY_GROUP_CHARS, packGroups } from "./pack";
import { MapAnswer, ReduceAnswer } from "./prompts";

const sec = (text: string, path: string[] = []): ParsedSection => ({
  headingPath: path,
  text,
  locator: { kind: "chars", start: 0, end: text.length },
});

describe("packGroups", () => {
  it("packs consecutive sections into groups under the group size, with heading context", () => {
    const groups = packGroups(
      [sec("a".repeat(10), ["H1"]), sec("b".repeat(10)), sec("c".repeat(30), ["H1", "H2"])],
      1_000,
      40,
    );
    expect(groups.map((g) => g.sections)).toEqual([[0, 1], [2]]);
    expect(groups[0]?.text).toBe("## H1\naaaaaaaaaa\n\nbbbbbbbbbb");
    expect(groups[1]?.text).toBe(`## H1 › H2\n${"c".repeat(30)}`);
  });

  it("splits one oversized section into several groups that all name that section", () => {
    const groups = packGroups([sec("x".repeat(100))], 1_000, 40);
    expect(groups.map((g) => g.sections)).toEqual([[0], [0], [0]]);
    expect(groups.every((g) => g.text.length <= 40)).toBe(true);
    expect(groups.map((g) => g.text).join("")).toBe("x".repeat(100));
  });

  it("stops at maxChars of section text and skips blank sections", () => {
    const groups = packGroups(
      [sec("a".repeat(30)), sec("   "), sec("b".repeat(30)), sec("c".repeat(30))],
      50,
      1_000,
    );
    expect(groups.flatMap((g) => g.sections)).toEqual([0, 2]);
    expect(groups.map((g) => g.text).join("")).not.toContain("c");
    expect(groups[0]?.text).toBe(`${"a".repeat(30)}\n\n${"b".repeat(20)}`);
  });

  it("never splits a surrogate pair, when splitting or truncating", () => {
    const text = "😀".repeat(50);
    const split = packGroups([sec(text)], 1_000, 41);
    const truncated = packGroups([sec(text)], 51, 1_000);
    for (const g of [...split, ...truncated]) {
      expect(g.text).not.toMatch(
        /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/,
      );
    }
    expect(split.map((g) => g.text).join("")).toBe(text);
  });

  it("returns no groups for blank input and defaults the group size", () => {
    expect(packGroups([sec(" ")], 100)).toEqual([]);
    expect(SUMMARY_GROUP_CHARS).toBe(24_000);
  });
});

describe("answer schemas", () => {
  it("slices over-long map answers and defaults unknown kinds to other", () => {
    const out = MapAnswer.parse({
      summary: "s".repeat(5_000),
      entities: Array.from({ length: 60 }, () => ({ name: "n".repeat(300), kind: "alien" })),
    });
    expect(out.summary).toHaveLength(4_000);
    expect(out.entities).toHaveLength(50);
    expect(out.entities[0]).toEqual({ name: "n".repeat(200), kind: "other" });
  });

  it("slices over-long reduce answers to the caps", () => {
    const many = (n: number, len: number) => Array.from({ length: n }, () => "x".repeat(len));
    const out = ReduceAnswer.parse({
      tldr: "t".repeat(3_000),
      keyPoints: many(20, 600),
      entities: many(40, 300),
      topics: many(20, 200),
      suggestedQuestions: many(12, 400),
    });
    expect(out.tldr).toHaveLength(2_000);
    expect([out.keyPoints.length, out.keyPoints[0]?.length]).toEqual([12, 500]);
    expect([out.entities.length, out.entities[0]?.length]).toEqual([30, 200]);
    expect([out.topics.length, out.topics[0]?.length]).toEqual([12, 100]);
    expect([out.suggestedQuestions.length, out.suggestedQuestions[0]?.length]).toEqual([8, 300]);
  });
});
