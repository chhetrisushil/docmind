import { describe, expect, it } from "vitest";
import { orgParser } from "./org";
import { ParseRunner } from "./runner/ParseRunner";
import { runDocumentParserConformance } from "./testing/conformance";

const enc = (s: string) => new TextEncoder().encode(s);
const SAMPLE =
  "#+TITLE: T\n\nPreamble text.\n\n* TODO One :tag:\nbody one\n** Sub\nbody two\n* Two\n\nbody three\n";
const EXPECTED = [
  [[], "#+TITLE: T\n\nPreamble text."],
  [["One"], "body one"],
  [["One", "Sub"], "body two"],
  [["Two"], "body three"],
];

runDocumentParserConformance(
  () => orgParser,
  {
    valid: [
      { name: "sample", bytes: enc(SAMPLE), mime: "text/x-org", ext: "org" },
      { name: "no headlines", bytes: enc("plain\n"), mime: "text/x-org" },
      { name: "empty", bytes: enc("\n"), mime: "text/x-org" },
    ],
    rejected: [{ name: "binary", bytes: new Uint8Array([0, 1, 2, 3]) }],
  },
  "orgParser",
);

describe("orgParser sections", () => {
  it("makes one section per headline's own body, with keywords, TODO and tags out of the title", async () => {
    const doc = await orgParser.parse(enc(SAMPLE));
    expect(doc.sections.map((s) => [s.headingPath, s.text])).toEqual(EXPECTED);
    for (const s of doc.sections) {
      expect(s.locator.kind).toBe("chars");
      if (s.locator.kind === "chars")
        expect(doc.text.slice(s.locator.start, s.locator.end)).toBe(s.text);
    }
  });

  it("handles CRLF input and a headline with no body", async () => {
    const doc = await orgParser.parse(enc("* A\r\n** B\r\ntext\r\n"));
    expect(doc.sections.map((s) => [s.headingPath, s.text])).toEqual([[["A", "B"], "text"]]);
  });

  it("cuts a long title without leaving half a surrogate pair", async () => {
    const doc = await orgParser.parse(enc(`* ${"a".repeat(499)}\u{1F600}\nbody\n`));
    const title = doc.sections[0]?.headingPath[0] as string;
    expect(title).toBe("a".repeat(499));
  });

  it("runs inside the bundled child and matches the direct call", async () => {
    const runner = new ParseRunner({
      limits: { wallClockMs: 10_000, memoryMb: 256, maxInputBytes: 1 << 20, maxChars: 1 << 20 },
    });
    try {
      const viaChild = await runner.run("org", enc(SAMPLE));
      expect(viaChild).toEqual(await orgParser.parse(enc(SAMPLE)));
      expect(viaChild.sections.map((s) => [s.headingPath, s.text])).toEqual(EXPECTED);
    } finally {
      await runner.close();
    }
  });
});
