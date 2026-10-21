import { describe, expect, it } from "vitest";
import { locatorText } from "./locator";

describe("locatorText", () => {
  it.each([
    [{ kind: "page", page: 3 }, "Page 3"],
    [{ kind: "section", index: 1 }, "Section 2"],
    [{ kind: "chars", start: 120, end: 480 }, "Characters 120-480"],
    [{ kind: "paragraphs", from: 4, to: 6 }, "Paragraphs 4-6"],
    [{ kind: "region", page: 2 }, "Page 2, region"],
    [{ kind: "page" }, "Somewhere in the document"],
    [{ kind: "line" }, "Somewhere in the document"],
  ])("%j is %s", (l, text) => expect(locatorText(l as never)).toBe(text));
});
