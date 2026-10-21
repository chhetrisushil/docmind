import { LitElement, html } from "lit";
import { describe, expect, it, vi } from "vitest";
import { Store, StoreController } from "./store";

describe("Store", () => {
  it("notifies subscribers on a change only, and unsubscribes", () => {
    const store = new Store(1);
    const seen: number[] = [];
    const off = store.subscribe((v) => seen.push(v));
    store.set(1);
    store.set(2);
    store.update((n) => n + 1);
    off();
    store.set(9);
    expect(seen).toEqual([2, 3]);
    expect(store.get()).toBe(9);
  });

  it("a throwing subscriber does not stop the others and reports only its class", () => {
    const store = new Store(0);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: number[] = [];
    store.subscribe(() => {
      throw new RangeError("sentinel-title-0123456789");
    });
    store.subscribe((v) => seen.push(v));
    store.set(1);
    expect(seen).toEqual([1]);
    expect(error.mock.calls).toEqual([["store RangeError"]]);
  });
});

class Probe extends LitElement {
  static properties = {};
  readonly store = new Store("a");
  readonly ctl = new StoreController(this, this.store);
  render() {
    return html`<p>${this.ctl.value}</p>`;
  }
}
customElements.define("dm-store-probe", Probe);

describe("StoreController", () => {
  it("re-renders its host on change and stops listening when disconnected", async () => {
    const el = document.createElement("dm-store-probe") as Probe;
    document.body.append(el);
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector("p")?.textContent).toBe("a");
    el.store.set("b");
    await el.updateComplete;
    expect(el.shadowRoot?.querySelector("p")?.textContent).toBe("b");
    el.remove();
    const before = vi.spyOn(el, "requestUpdate");
    el.store.set("c");
    expect(before).not.toHaveBeenCalled();
  });
});
