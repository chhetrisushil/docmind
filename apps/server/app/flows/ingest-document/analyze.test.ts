import type { ParsedDocument } from "@docmind/parsers";
import { describe, expect, it } from "vitest";
import { LANGUAGES, WORDS_PER_MINUTE, analyzeDocument } from "./analyze";

const doc = (sections: { path?: string[]; text: string; page?: number }[]): ParsedDocument => ({
  text: sections.map((s) => s.text).join("\n\n"),
  sections: sections.map((s, i) => ({
    headingPath: s.path ?? [],
    text: s.text,
    locator: s.page
      ? { kind: "page" as const, page: s.page }
      : { kind: "chars" as const, start: i, end: i },
  })),
  media: [],
});

describe("analyzeDocument", () => {
  it("counts words, reading time and pages", () => {
    const stats = analyzeDocument(
      doc([
        { text: "one two three", page: 1 },
        { text: "four, five!", page: 4 },
      ]),
    );
    expect(stats).toMatchObject({ wordCount: 5, pageCount: 4, readingTimeMinutes: 0 });
    expect(analyzeDocument(doc([{ text: "x" }])).pageCount).toBeNull();
  });

  it("takes the page count from media and regions too", () => {
    const parsed = doc([{ text: "x", page: 2 }]);
    parsed.media.push({
      mime: "image/png",
      locator: { kind: "region", page: 7, x: 0, y: 0, w: 1, h: 1 } as never,
    });
    expect(analyzeDocument(parsed).pageCount).toBe(7);
  });

  it("rounds reading time to one decimal at 230 words a minute", () => {
    expect(WORDS_PER_MINUTE).toBe(230);
    const words = (n: number) => doc([{ text: Array(n).fill("w").join(" ") }]);
    expect(analyzeDocument(words(460)).readingTimeMinutes).toBe(2);
    expect(analyzeDocument(words(300)).readingTimeMinutes).toBe(1.3);
  });

  it("detects the language by stop words, and returns null when unsure", () => {
    const en =
      "the cat and the dog are in the house with a friend of the family and it is on the table ".repeat(
        3,
      );
    const de =
      "der Hund und die Katze sind in dem Haus mit einem Freund der Familie und es ist auf dem Tisch ".repeat(
        3,
      );
    expect(LANGUAGES).toEqual(["en", "de", "fr", "es", "it", "pt", "nl", "sv"]);
    expect(analyzeDocument(doc([{ text: en }])).language).toBe("en");
    expect(analyzeDocument(doc([{ text: de }])).language).toBe("de");
    expect(analyzeDocument(doc([{ text: "xyzzy plugh qwerty" }])).language).toBeNull();
  });

  it("builds an outline of the first two heading levels, deduplicated, capped at 50", () => {
    const stats = analyzeDocument(
      doc([
        { path: ["A"], text: "x" },
        { path: ["A", "B"], text: "x" },
        { path: ["A", "B", "C"], text: "x" },
        { path: ["A", "B"], text: "x" },
        { path: ["D"], text: "x" },
      ]),
    );
    expect(stats.outline).toEqual(["A", "A › B", "D"]);
    const many = analyzeDocument(
      doc(Array.from({ length: 80 }, (_, i) => ({ path: [`H${i}`], text: "x" }))),
    );
    expect(many.outline).toHaveLength(50);
  });

  it("finds dates and notable numbers, unique, in order, capped at 20", () => {
    const stats = analyzeDocument(
      doc([
        {
          text: "Signed 2024-03-01 and 5 March 2024, paid $1,250.00 or 15% of 10000 units; March 5, 2024 again 2024-03-01.",
        },
      ]),
    );
    expect(stats.dates).toEqual(["2024-03-01", "5 March 2024", "March 5, 2024"]);
    expect(stats.numbers).toEqual(["$1,250.00", "15%", "10000"]);
    const text = Array.from({ length: 30 }, (_, i) => `2024-01-${String(i + 1).padStart(2, "0")}`);
    expect(analyzeDocument(doc([{ text: text.join(" ") }])).dates).toHaveLength(20);
  });
});
