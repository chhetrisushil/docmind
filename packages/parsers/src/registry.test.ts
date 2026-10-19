import { describe, expect, it } from "vitest";
import { ParserRegistry } from "./registry";
import {
  type DocumentParser,
  PARSE_REJECT_CODES,
  ParseRejectedError,
  ParsedDocument,
} from "./types";

const parser = (id: string, mime: string, ext?: string): DocumentParser => ({
  id,
  accepts: (m, e) => m === mime || (ext !== undefined && e === ext),
  parse: () => ({ text: "", sections: [], media: [] }),
});

describe("ParserRegistry", () => {
  const reg = new ParserRegistry([parser("a", "text/plain", "txt"), parser("b", "text/markdown")]);

  it("selects the first parser that accepts the type, by mime or by extension", () => {
    expect(reg.select("text/markdown")?.id).toBe("b");
    expect(reg.select("application/octet-stream", "txt")?.id).toBe("a");
    expect(reg.select("image/png")).toBeUndefined();
  });

  it("lets registration order win when two parsers accept the same type", () => {
    const both = new ParserRegistry([
      parser("first", "text/plain"),
      parser("second", "text/plain"),
    ]);
    expect(both.select("text/plain")?.id).toBe("first");
  });

  it("finds a parser by id and lists ids in registration order", () => {
    expect(reg.byId("b")?.id).toBe("b");
    expect(reg.byId("nope")).toBeUndefined();
    expect(reg.ids()).toEqual(["a", "b"]);
  });

  it("refuses two parsers with the same id, naming the id's position not a value", () => {
    expect(() => new ParserRegistry([parser("a", "x"), parser("a", "y")])).toThrow(
      /duplicate parser id at position 1/,
    );
  });
});

describe("types", () => {
  it("ParsedDocument rejects a heading path that is not an array of strings", () => {
    const bad = {
      text: "t",
      sections: [{ headingPath: "Intro", text: "t", locator: { kind: "section", index: 0 } }],
      media: [],
    };
    expect(ParsedDocument.safeParse(bad).success).toBe(false);
  });

  it("ParsedDocument accepts a well-formed document", () => {
    const ok = {
      text: "t",
      sections: [{ headingPath: ["Intro"], text: "t", locator: { kind: "section", index: 0 } }],
      media: [],
    };
    expect(ParsedDocument.safeParse(ok).success).toBe(true);
  });

  it("ParsedDocument keeps locators numbers-only: a heading string in a locator fails", () => {
    const bad = {
      text: "t",
      sections: [{ headingPath: [], text: "t", locator: { kind: "section", index: "Intro" } }],
      media: [],
    };
    expect(ParsedDocument.safeParse(bad).success).toBe(false);
  });

  it("PARSE_REJECT_CODES lists exactly the three codes", () => {
    expect([...PARSE_REJECT_CODES]).toEqual([
      "unsupported_content",
      "corrupt_content",
      "too_large",
    ]);
  });

  it("ParseRejectedError carries a code and a fixed message", () => {
    const err = new ParseRejectedError("corrupt_content");
    expect(err).toMatchObject({
      name: "ParseRejectedError",
      code: "corrupt_content",
      message: "parse rejected: corrupt_content",
    });
  });
});
