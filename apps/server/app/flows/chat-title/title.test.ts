import { UNTRUSTED_CONTENT_SYSTEM_NOTE } from "@loom/llm";
import { describe, expect, it } from "vitest";
import { TITLE_MAX_CHARS, cleanTitle, titleRequest } from "./title";

describe("cleanTitle", () => {
  it.each([
    ['"Quarterly budget review"', "Quarterly budget review"],
    ["Title: Quarterly budget review.", "Quarterly budget review"],
    ["# Quarterly budget review", "Quarterly budget review"],
    ["**Quarterly budget review**", "Quarterly budget review"],
    ["Quarterly budget review\nA second line", "Quarterly budget review"],
    ["  Quarterly   budget  review  ", "Quarterly budget review"],
    ["`Q3`", "Q3"],
  ])("cleans %j to %j", (raw, clean) => {
    expect(cleanTitle(raw)).toBe(clean);
  });

  it("clips to 60 characters without splitting a surrogate pair, and without a trailing space", () => {
    const long = `${"word ".repeat(11)}${"😀".repeat(20)}`;
    const out = cleanTitle(long) ?? "";
    expect([...out].length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(out).toBe(out.trim());
    expect(out.startsWith("word word")).toBe(true);
  });

  it.each([[""], ["   "], ['""'], ["."], ["See [[0b0e7c9a-1111-4222-8333-444455556666]]"]])(
    "refuses %j",
    (raw) => {
      expect(cleanTitle(raw)).toBeNull();
    },
  );
});

describe("titleRequest", () => {
  it("fences the question as untrusted conversation content and ends the system prompt with Loom's note", () => {
    const req = titleRequest("What is due? [[0b0e7c9a-1111-4222-8333-444455556666]]");
    expect(String(req.system).endsWith(UNTRUSTED_CONTENT_SYSTEM_NOTE)).toBe(true);
    const parts = (req.messages[0]?.content ?? []) as { type: string; text: string }[];
    const joined = parts.map((p) => p.text).join("\n");
    expect(joined).toContain("What is due?");
    expect(joined).not.toContain("0b0e7c9a"); // a citation-shaped marker is noise in a title prompt
    expect(parts[0]?.text).not.toBe("What is due?"); // wrapped by the guard, not raw
    expect(parts).toHaveLength(2); // the question and the instruction: nothing else is sent
  });

  it("sends at most 2,000 characters of the question", () => {
    const req = titleRequest("q".repeat(5000));
    const joined = ((req.messages[0]?.content ?? []) as { text: string }[])
      .map((p) => p.text)
      .join("");
    expect(joined).toContain("q".repeat(2000));
    expect(joined).not.toContain("q".repeat(2001));
  });
});
