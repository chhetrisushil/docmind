import { describe, expect, it } from "vitest";
import { type DocumentParser, ParseRejectedError } from "../types";
import { CHECKS, type ParserFixtures, runDocumentParserConformance } from "./conformance";

const bytes = (s: string) => new TextEncoder().encode(s);
const good: DocumentParser = {
  id: "toy",
  accepts: (m, e) => m === "text/plain" || e?.toLowerCase() === "toy",
  parse(input) {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(input);
    if (text.includes("\0")) throw new ParseRejectedError("unsupported_content");
    return {
      text,
      sections: [{ headingPath: [], text, locator: { kind: "chars", start: 0, end: text.length } }],
      media: [],
    };
  },
};
const fixtures: ParserFixtures = {
  valid: [{ name: "plain", bytes: bytes("hello\nworld"), mime: "text/plain", ext: "toy" }],
  rejected: [{ name: "nul", bytes: new Uint8Array([104, 0, 105]) }],
};

runDocumentParserConformance(() => good, fixtures, "toy parser");

describe("the kit catches broken parsers", () => {
  const broken = (over: Partial<DocumentParser>): DocumentParser => ({ ...good, ...over });
  it("a locator that does not slice to the section text", async () => {
    const p = broken({
      parse: () => ({
        text: "abc",
        sections: [{ headingPath: [], text: "abc", locator: { kind: "chars", start: 0, end: 2 } }],
        media: [],
      }),
    });
    expect(await CHECKS["section locators slice the text"]?.(p, fixtures)).toBe(
      "plain: section 0 does not equal text.slice(0, 2)",
    );
  });
  it("a parser that mutates its input", async () => {
    const p = broken({
      parse: (b) => {
        b[0] = 0;
        return good.parse(bytes("x"));
      },
    });
    expect(await CHECKS["does not modify its input"]?.(p, fixtures)).toBe(
      "plain: the input bytes were modified",
    );
  });
  it("a parser that accepts garbage", async () => {
    const p = broken({ parse: () => ({ text: "", sections: [], media: [] }) });
    expect(await CHECKS["rejects what it cannot read with ParseRejectedError"]?.(p, fixtures)).toBe(
      "nul: did not reject",
    );
  });
  it("a parser that throws a plain Error for garbage", async () => {
    const p = broken({
      parse: () => {
        throw new Error("boom");
      },
    });
    expect(await CHECKS["rejects what it cannot read with ParseRejectedError"]?.(p, fixtures)).toBe(
      "nul: threw Error, not ParseRejectedError",
    );
  });
  it("a parser that claims every type", async () => {
    expect(
      await CHECKS["accepts its own types and not others"]?.(
        broken({ accepts: () => true }),
        fixtures,
      ),
    ).toBe("accepts application/x-docmind-unknown");
  });
  it("a parser whose output changes between runs", async () => {
    let n = 0;
    const p = broken({ parse: () => ({ text: `t${n++}`, sections: [], media: [] }) });
    expect(await CHECKS["is deterministic"]?.(p, fixtures)).toBe("plain: two parses differ");
  });
});
