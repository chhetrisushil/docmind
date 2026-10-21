import { describe, expect, it } from "vitest";
import { deepAll, deepFind, deepText, unnamedControls } from "./dom";

function host(html: string): HTMLElement {
  const el = document.createElement("div");
  const root = el.attachShadow({ mode: "open" });
  root.innerHTML = html;
  document.body.append(el);
  return el;
}

describe("deep DOM helpers", () => {
  it("find, list and read text through nested open shadow roots", () => {
    const outer = host("<p>outer</p><section id='slot'></section>");
    const inner = document.createElement("span");
    inner.attachShadow({ mode: "open" }).innerHTML = "<b class='x'>deep</b>";
    outer.shadowRoot?.getElementById("slot")?.append(inner);
    expect(deepFind(outer, "b.x")?.textContent).toBe("deep");
    expect(deepAll(outer, "p, b").map((e) => e.tagName)).toEqual(["P", "B"]);
    expect(deepText(outer)).toContain("outer");
    expect(deepText(outer)).toContain("deep");
    expect(deepFind(outer, "i")).toBeNull();
  });
});

describe("unnamedControls", () => {
  it("accepts a control named by aria-label, aria-labelledby, a label, its text, a title or an image alt", () => {
    const el = host(`
      <button aria-label="Close"></button>
      <span id="n">Name</span><button aria-labelledby="n"></button>
      <label for="e">Email</label><input id="e">
      <label>Wrapped <input></label>
      <button>Send</button>
      <a href="/x" title="Home"></a>
      <a href="/y"><img alt="Logo"></a>
      <select aria-label="Type"></select><textarea aria-label="Message"></textarea>
      <div role="tab" aria-label="Summary"></div>`);
    expect(unnamedControls(el)).toEqual([]);
  });
  it("reports a control with no name, by tag and data attributes only, never by text", () => {
    const el = host(`
      <button data-copy></button>
      <input type="text" placeholder="only a placeholder">
      <a href="/z"></a>
      <input type="hidden">
      <a>no href, not a link</a>
      <button aria-label=""></button>
      <div role="tab"></div>`);
    expect(unnamedControls(el).sort()).toEqual(
      ["a", "button", "button[data-copy]", "input", "tab"].sort(),
    );
  });
  it("looks inside shadow roots", () => {
    const outer = host("<section></section>");
    const inner = document.createElement("span");
    inner.attachShadow({ mode: "open" }).innerHTML = "<button data-x></button>";
    outer.shadowRoot?.querySelector("section")?.append(inner);
    expect(unnamedControls(outer)).toEqual(["button[data-x]"]);
  });
});
