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
  it("empty fixtures", async () => {
    const check = CHECKS["has valid and rejected fixtures"];
    expect(await check?.(good, { valid: [], rejected: fixtures.rejected })).toBe(
      "no valid fixtures",
    );
    expect(await check?.(good, { valid: fixtures.valid, rejected: [] })).toBe(
      "no rejected fixtures",
    );
  });
  it("a section whose locator kind is not in the schema", async () => {
    const p = broken({
      parse: () =>
        ({
          text: "a",
          sections: [{ headingPath: [], text: "a", locator: { kind: "bogus" } }],
          media: [],
        }) as never,
    });
    expect(await CHECKS["produces a valid ParsedDocument"]?.(p, fixtures)).toBe(
      "plain: output fails the ParsedDocument schema",
    );
  });
  it("an empty id", async () => {
    expect(await CHECKS["has a non-empty id"]?.(broken({ id: "" }), fixtures)).toBe("empty id");
  });
  it("an extension match that is case sensitive", async () => {
    const p = broken({ accepts: (m, e) => m === "text/plain" || e === "toy" });
    expect(await CHECKS["accepts its own types and not others"]?.(p, fixtures)).toBe(
      "plain: extension match is case sensitive",
    );
  });
  it("a parser that accepts any extension", async () => {
    const p = broken({ accepts: (m, e) => m === "text/plain" || e !== undefined });
    expect(await CHECKS["accepts its own types and not others"]?.(p, fixtures)).toBe(
      "accepts an unknown mime with an unknown extension",
    );
  });
  it("an error message that carries the rejected content", async () => {
    const text = "secret document text";
    class Leaky extends ParseRejectedError {
      constructor() {
        super("corrupt_content");
        this.message = text;
      }
    }
    const p = broken({
      parse: () => {
        throw new Leaky();
      },
    });
    const f = { valid: fixtures.valid, rejected: [{ name: "leak", bytes: bytes(text) }] };
    expect(await CHECKS["rejects what it cannot read with ParseRejectedError"]?.(p, f)).toBe(
      "leak: the error message carries the content",
    );
  });
});
