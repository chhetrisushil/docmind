import { describe, expect, it, vi } from "vitest";
import { deepActiveElement } from "./dm-dialog";
import "./dm-dialog";

type Dlg = HTMLElement & { updateComplete: Promise<unknown>; open: boolean };
async function mount(opts: { persistent?: boolean } = {}) {
  const opener = document.createElement("button");
  opener.textContent = "open";
  document.body.append(opener);
  opener.focus();
  const el = document.createElement("dm-dialog") as Dlg;
  el.setAttribute("heading", "Delete chat?");
  if (opts.persistent) el.setAttribute("persistent", "");
  el.innerHTML = `<p>Body</p><input id="first" aria-label="Password"><button slot="actions" id="cancel">Cancel</button><button slot="actions" id="go">Delete</button>`;
  document.body.append(el);
  await el.updateComplete;
  return { el, opener };
}
const press = (target: HTMLElement) => {
  target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
};
const panel = (el: Dlg) => el.shadowRoot?.querySelector("[role=dialog]") as HTMLElement;

describe("dm-dialog", () => {
  it("draws nothing while closed, and a labelled modal panel when open", async () => {
    const { el } = await mount();
    expect(panel(el)).toBeNull();
    el.open = true;
    await el.updateComplete;
    expect(panel(el).getAttribute("aria-modal")).toBe("true");
    const labelled = panel(el).getAttribute("aria-labelledby") as string;
    expect(el.shadowRoot?.getElementById(labelled)?.textContent).toBe("Delete chat?");
  });

  it("moves focus in, wraps Tab at both ends, and gives focus back when it closes", async () => {
    const { el, opener } = await mount();
    el.open = true;
    await el.updateComplete;
    await vi.waitFor(() => expect((deepActiveElement() as HTMLElement | null)?.id).toBe("first"));
    const go = el.querySelector("#go") as HTMLButtonElement;
    go.focus();
    panel(el).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
    );
    expect((deepActiveElement() as HTMLElement).id).toBe("first");
    panel(el).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }),
    );
    expect((deepActiveElement() as HTMLElement).id).toBe("go");
    el.open = false;
    await el.updateComplete;
    await vi.waitFor(() => expect(deepActiveElement()).toBe(opener));
  });

  it("asks to close on Escape and on a backdrop click, but not on a click inside the panel or for a persistent one", async () => {
    const { el } = await mount();
    el.open = true;
    await el.updateComplete;
    const closes = vi.fn();
    el.addEventListener("dm-close", closes);
    panel(el).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(closes).toHaveBeenCalledTimes(1);
    press(el.shadowRoot?.querySelector(".backdrop") as HTMLElement);
    expect(closes).toHaveBeenCalledTimes(2);
    panel(el).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(closes).toHaveBeenCalledTimes(2);
    expect(el.open).toBe(true); // it only asks
    const sticky = await mount({ persistent: true });
    sticky.el.open = true;
    await sticky.el.updateComplete;
    const stickyCloses = vi.fn();
    sticky.el.addEventListener("dm-close", stickyCloses);
    press(sticky.el.shadowRoot?.querySelector(".backdrop") as HTMLElement);
    expect(stickyCloses).not.toHaveBeenCalled();
    panel(sticky.el).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(stickyCloses).toHaveBeenCalledTimes(1); // Escape always asks
  });

  it("makes the rest of the page inert while open and restores it on close", async () => {
    const other = document.createElement("main");
    document.body.append(other);
    const { el } = await mount();
    expect(other.inert).toBe(false);
    el.open = true;
    await el.updateComplete;
    expect(other.inert).toBe(true);
    expect(el.inert).toBe(false);
    el.open = false;
    await el.updateComplete;
    expect(other.inert).toBe(false);
  });

  it("still answers Escape and Tab after focus has left the panel, and pulls focus back on a backdrop press", async () => {
    const { el } = await mount({ persistent: true });
    el.open = true;
    await el.updateComplete;
    const closes = vi.fn();
    el.addEventListener("dm-close", closes);
    (deepActiveElement() as HTMLElement).blur();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(closes).toHaveBeenCalledTimes(1);
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
    );
    expect((deepActiveElement() as HTMLElement).id).toBe("first");
    (deepActiveElement() as HTMLElement).blur();
    (el.shadowRoot?.querySelector(".backdrop") as HTMLElement).dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
    );
    expect((deepActiveElement() as HTMLElement).id).toBe("first");
    expect(closes).toHaveBeenCalledTimes(1); // persistent: the press alone closes nothing
  });

  it("does not close when the press began inside the panel and ended on the backdrop", async () => {
    const { el } = await mount();
    el.open = true;
    await el.updateComplete;
    const closes = vi.fn();
    el.addEventListener("dm-close", closes);
    panel(el).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    (el.shadowRoot?.querySelector(".backdrop") as HTMLElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    expect(closes).not.toHaveBeenCalled();
  });

  it("finds focusables inside a slotted custom element's shadow root, and lets Tab move inside it", async () => {
    customElements.define(
      "x-pair",
      class extends HTMLElement {
        constructor() {
          super();
          this.attachShadow({
            mode: "open",
          }).innerHTML = `<input id="a" aria-label="A"><input id="b" aria-label="B"><button disabled id="off"></button><input id="gone" hidden aria-label="G">`;
        }
      },
    );
    const el = document.createElement("dm-dialog") as Dlg;
    el.setAttribute("heading", "x");
    el.innerHTML = `<x-pair id="pair"></x-pair><button slot="actions" id="ok">OK</button>`;
    document.body.append(el);
    el.open = true;
    await el.updateComplete;
    const pair = el.querySelector("#pair") as HTMLElement;
    const inner = (id: string) => pair.shadowRoot?.getElementById(id) as HTMLElement;
    await vi.waitFor(() => expect(deepActiveElement()).toBe(inner("a")));
    const ev = (shiftKey: boolean) =>
      new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true });
    const mid = ev(false);
    inner("a").focus();
    panel(el).dispatchEvent(mid);
    expect(mid.defaultPrevented).toBe(false); // from the first to the second: the browser moves on
    (el.querySelector("#ok") as HTMLElement).focus();
    panel(el).dispatchEvent(ev(false));
    expect(deepActiveElement()).toBe(inner("a")); // wraps past the end
    panel(el).dispatchEvent(ev(true));
    expect((deepActiveElement() as HTMLElement).id).toBe("ok");
    inner("b").focus();
    const fromB = ev(false);
    panel(el).dispatchEvent(fromB);
    expect(fromB.defaultPrevented).toBe(false); // B is not the last stop: "ok" is
  });

  it("hides a slotted-in shell's own shadow content, and what is added to it after opening", async () => {
    customElements.define(
      "x-shell",
      class extends HTMLElement {
        constructor() {
          super();
          this.attachShadow({
            mode: "open",
          }).innerHTML = `<nav><button id="nav">nav</button></nav><slot></slot>`;
        }
      },
    );
    const shell = document.createElement("x-shell");
    const el = document.createElement("dm-dialog") as Dlg;
    el.setAttribute("heading", "x");
    el.innerHTML = "<button>in</button>";
    shell.append(el);
    document.body.append(shell);
    const nav = shell.shadowRoot?.querySelector("nav") as HTMLElement;
    el.open = true;
    await el.updateComplete;
    expect(nav.inert).toBe(true);
    const late = document.createElement("aside");
    shell.shadowRoot?.append(late);
    document.body.append(document.createElement("footer"));
    await vi.waitFor(() => expect(late.inert).toBe(true));
    await vi.waitFor(() => expect((document.body.lastChild as HTMLElement).inert).toBe(true));
    el.open = false;
    await el.updateComplete;
    expect(nav.inert).toBe(false);
    expect(late.inert).toBe(false);
  });

  it("lets only the topmost of nested dialogs answer keys, and hides the outer one's content meanwhile", async () => {
    const outer = document.createElement("dm-dialog") as Dlg;
    outer.setAttribute("heading", "outer");
    outer.innerHTML = `<button id="o1">o1</button><dm-dialog id="inner" heading="inner"><button id="i1">i1</button><button id="i2">i2</button></dm-dialog><button slot="actions" id="o2">o2</button>`;
    document.body.append(outer);
    const inner = outer.querySelector("#inner") as Dlg;
    outer.open = true;
    await outer.updateComplete;
    const o1 = outer.querySelector("#o1") as HTMLElement;
    expect(o1.inert).toBe(false);
    inner.open = true;
    await inner.updateComplete;
    expect(o1.inert).toBe(true);
    const outerCloses = vi.fn();
    const innerCloses = vi.fn();
    outer.addEventListener("dm-close", outerCloses);
    inner.addEventListener("dm-close", innerCloses);
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(innerCloses).toHaveBeenCalledTimes(1);
    expect(outerCloses).not.toHaveBeenCalled(); // dm-close does not bubble into the outer dialog
    (inner.querySelector("#i2") as HTMLElement).focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    panel(inner).dispatchEvent(tab);
    expect((deepActiveElement() as HTMLElement).id).toBe("i1");
    inner.open = false;
    await inner.updateComplete;
    expect(o1.inert).toBe(false);
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(outerCloses).toHaveBeenCalledTimes(1);
  });

  it("gives focus back when removed while open, and hides the page again when re-attached", async () => {
    const other = document.createElement("main");
    document.body.append(other);
    const { el, opener } = await mount();
    el.open = true;
    await el.updateComplete;
    el.remove();
    expect(other.inert).toBe(false);
    expect(deepActiveElement()).toBe(opener);
    document.body.append(el);
    await vi.waitFor(() => expect(other.inert).toBe(true));
    expect((deepActiveElement() as HTMLElement).id).toBe("first");
  });

  it("describes the panel by its body", async () => {
    const { el } = await mount();
    el.open = true;
    await el.updateComplete;
    const id = panel(el).getAttribute("aria-describedby") as string;
    expect(el.shadowRoot?.getElementById(id)?.querySelector("slot")).not.toBeNull();
  });
});
