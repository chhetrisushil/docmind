import { describe, expect, it } from "vitest";
import { htmlToSections } from "./htmlSections";

function sliceable(html: string) {
  const out = htmlToSections(html);
  for (const s of out.sections) {
    if (s.locator.kind !== "chars") throw new Error("expected chars");
    expect(out.text.slice(s.locator.start, s.locator.end)).toBe(s.text);
  }
  return out;
}

describe("htmlToSections", () => {
  it("builds exact chars sections from headings and blocks", () => {
    const { sections } = sliceable(
      "<p>Lead &amp; intro</p><h1>Title</h1><p>One<br />two</p><h2>Sub</h2><ul><li>a</li><li>b</li></ul><table><tr><td>x</td><td>y</td></tr></table>",
    );
    expect(sections.map((s) => [s.headingPath, s.text])).toEqual([
      [[], "Lead & intro"],
      [["Title"], "One\ntwo"],
      [["Title", "Sub"], "a\n\nb\n\nx\ty"],
    ]);
  });

  it("decodes numeric references and keeps text of unknown tags", () => {
    expect(
      htmlToSections('<p>&#8364;5 <strong>bold</strong> <a href="x">link</a> &#x41; &#0; &lt;</p>')
        .text,
    ).toBe("€5 bold link A &#0; <");
  });

  it("pops deeper heading levels and caps the path and heading text", () => {
    const { sections } = sliceable(
      `<h1>A</h1><h2>B</h2><p>x</p><h1>C</h1><p>y</p><h3>${"z".repeat(600)}</h3><p>w</p>`,
    );
    expect(sections.map((s) => s.headingPath.map((h) => h.length))).toEqual([
      [1, 1],
      [1],
      [1, 500],
    ]);
    const deep = htmlToSections(
      `${Array.from(
        { length: 20 },
        (_, i) => `<h${Math.min(i + 1, 6)}>h${i}</h${Math.min(i + 1, 6)}>`,
      ).join("")}<p>t</p>`,
    );
    expect(deep.sections[0]?.headingPath.length).toBeLessThanOrEqual(6);
  });

  it("separates table rows with a newline and nested list items as blocks", () => {
    const { text } = sliceable(
      "<table><tr><td>a</td><td></td><td>b</td></tr><tr><td>c</td></tr></table><p>after</p>",
    );
    expect(text).toBe("a\t\tb\nc\n\nafter");
    expect(htmlToSections("<ul><li>outer<ul><li>in</li></ul></li></ul>").text).toBe("outer\n\nin");
  });

  it("returns empty output for empty html and drops empty headings", () => {
    expect(htmlToSections("")).toEqual({ text: "", sections: [], images: [] });
    expect(htmlToSections("<h1> </h1><p></p>").sections).toEqual([]);
  });

  it("records the section index open at each image, in order", () => {
    const { images, sections } = htmlToSections(
      '<p>a<img src="" /></p><h1>T</h1><p><img src="" />b<img src="" /></p><h1>U</h1><p>c</p>',
    );
    expect(images).toEqual([0, 1, 1]);
    expect(sections).toHaveLength(3);
  });
});
