import { describe, expect, it } from "vitest";
import { ParserRegistry } from "./registry";
import { type DocumentParser, ParseRejectedError, ParsedDocument } from "./types";

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

  it("ParseRejectedError carries a code and a fixed message", () => {
    const err = new ParseRejectedError("corrupt_content");
    expect(err).toMatchObject({
      name: "ParseRejectedError",
      code: "corrupt_content",
      message: "parse rejected: corrupt_content",
    });
  });
});
