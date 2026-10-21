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
    (el.shadowRoot?.querySelector(".backdrop") as HTMLElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    expect(closes).toHaveBeenCalledTimes(2);
    panel(el).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(closes).toHaveBeenCalledTimes(2);
    expect(el.open).toBe(true); // it only asks
    const sticky = await mount({ persistent: true });
    sticky.el.open = true;
    await sticky.el.updateComplete;
    const stickyCloses = vi.fn();
    sticky.el.addEventListener("dm-close", stickyCloses);
    (sticky.el.shadowRoot?.querySelector(".backdrop") as HTMLElement).dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
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
});
