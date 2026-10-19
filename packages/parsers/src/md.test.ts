import { describe, expect, it } from "vitest";
import { mdParser } from "./md";
import { ParseRunner } from "./runner/ParseRunner";
import { runDocumentParserConformance } from "./testing/conformance";

const enc = (s: string) => new TextEncoder().encode(s);
const SAMPLE = [
  "Intro line before any heading.",
  "",
  "# Title",
  "",
  "Para under title.",
  "",
  "## Part *A*",
  "",
  "```",
  "# not a heading",
  "```",
  "",
  "Setext heading",
  "--------------",
  "",
  "Body of setext.",
  "",
].join("\r\n");
const EXPECTED = [
  [[], "Intro line before any heading."],
  [["Title"], "Para under title."],
  [["Title", "Part A"], "```\n# not a heading\n```"],
  [["Title", "Setext heading"], "Body of setext."],
];

runDocumentParserConformance(
  () => mdParser,
  {
    valid: [
      { name: "sample", bytes: enc(SAMPLE), mime: "text/markdown", ext: "md" },
      {
        name: "no headings",
        bytes: enc("just text\n\nmore"),
        mime: "text/markdown; charset=utf-8",
        ext: "markdown",
      },
      { name: "empty", bytes: enc("  \n"), mime: "text/markdown" },
    ],
    rejected: [{ name: "binary", bytes: new Uint8Array([0x00, 0x01, 0x02, 0x03]) }],
  },
  "mdParser",
);

describe("mdParser sections", () => {
  it("splits at headings, nests heading paths, keeps code fences and strips inline markup", async () => {
    const doc = await mdParser.parse(enc(SAMPLE));
    expect(doc.sections.map((s) => [s.headingPath, s.text])).toEqual(EXPECTED);
    for (const s of doc.sections) expect(s.locator.kind).toBe("chars");
  });

  it("drops a section with no body text but keeps it in later heading paths", async () => {
    const doc = await mdParser.parse(enc("# A\n\n## B\n\ntext\n"));
    expect(doc.sections.map((s) => s.headingPath)).toEqual([["A", "B"]]);
  });

  it("handles a six-level heading (the 16-deep cap is defensive and shared with org)", async () => {
    const doc = await mdParser.parse(enc("###### six\n\nx\n"));
    expect(doc.sections[0]?.headingPath).toEqual(["six"]);
  });

  it("runs inside the bundled child and matches the direct call", async () => {
    const runner = new ParseRunner({
      limits: { wallClockMs: 10_000, memoryMb: 256, maxInputBytes: 1 << 20, maxChars: 1 << 20 },
    });
    try {
      const viaChild = await runner.run("md", enc(SAMPLE));
      expect(viaChild).toEqual(await mdParser.parse(enc(SAMPLE)));
      expect(viaChild.sections.map((s) => [s.headingPath, s.text])).toEqual(EXPECTED);
    } finally {
      await runner.close();
    }
  });
});
