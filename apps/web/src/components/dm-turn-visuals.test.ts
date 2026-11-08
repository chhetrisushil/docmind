import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./dm-turn-visuals";
import type { DmTurnVisuals } from "./dm-turn-visuals";

const view = (over = {}) => ({
  strip: true,
  action: "Re-visualize",
  busy: false,
  note: null,
  ...over,
});
async function mount(props: Partial<DmTurnVisuals> = {}) {
  const el = document.createElement("dm-turn-visuals") as DmTurnVisuals;
  Object.assign(el, { chatId: "c1", ord: 2, rev: 0, view: view(), ...props });
  document.body.append(el);
  await el.updateComplete;
  return el;
}
const q = (el: HTMLElement, sel: string) => el.shadowRoot?.querySelector(sel) as HTMLElement | null;
beforeEach(() => vi.stubGlobal("IntersectionObserver", undefined)); // mount the widgets at once
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("dm-turn-visuals", () => {
  it("is a collapsed strip titled Visuals that expands in place", async () => {
    const el = await mount();
    const toggle = q(el, "[data-toggle]");
    expect(toggle?.textContent).toContain("Visuals");
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(q(el, "[data-body]")?.hasAttribute("data-collapsed")).toBe(true);
    toggle?.click();
    await el.updateComplete;
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(q(el, "[data-body]")?.hasAttribute("data-collapsed")).toBe(false);
  });
  it("mounts the turn's view only when there is a strip, with the turn as its source", async () => {
    const el = await mount();
    const v = q(el, "dm-view") as unknown as { turn?: unknown };
    expect(v.turn).toEqual({ chatId: "c1", ord: 2 });
    const none = await mount({ view: view({ strip: false }) });
    expect(q(none, "dm-view")).toBeNull();
    expect(q(none, "[data-toggle]")).toBeNull();
  });
  it("opens a fresh view when a re-run bumps rev", async () => {
    const el = await mount();
    const first = q(el, "dm-view");
    el.rev = 1;
    await el.updateComplete;
    expect(q(el, "dm-view")).not.toBe(first);
  });
  it("shows the action, disabled and labelled Visualizing… while busy, and raises visualize on a click", async () => {
    const el = await mount({ view: view({ strip: false, action: "Visualize" }) });
    const seen: number[] = [];
    el.addEventListener("visualize", (e) =>
      seen.push((e as CustomEvent<{ ord: number }>).detail.ord),
    );
    q(el, "[data-action]")?.click();
    expect(seen).toEqual([2]);
    el.view = view({ strip: false, action: "Visualizing…", busy: true });
    await el.updateComplete;
    expect((q(el, "[data-action]") as HTMLButtonElement).disabled).toBe(true);
    expect(q(el, "[data-action]")?.textContent).toContain("Visualizing…");
  });
  it("announces a note politely and shows nothing at all without a view", async () => {
    const el = await mount({
      view: view({ strip: false, action: null, note: "Try again in a minute" }),
    });
    expect(q(el, "[data-note]")?.getAttribute("role")).toBe("status");
    expect(q(el, "[data-note]")?.textContent).toBe("Try again in a minute");
    const empty = await mount({ view: null });
    expect(empty.shadowRoot?.querySelector("button")).toBeNull();
  });
  it("waits to mount the view until the strip is seen when IntersectionObserver exists", async () => {
    let seen: (entries: { isIntersecting: boolean }[]) => void = () => {};
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(cb: typeof seen) {
          seen = cb;
        }
        observe() {}
        disconnect() {}
      },
    );
    const el = await mount();
    expect(q(el, "dm-view")).toBeNull();
    seen([{ isIntersecting: true }]);
    await el.updateComplete;
    expect(q(el, "dm-view")).not.toBeNull();
  });
  it("keeps its nested view's view-ready and view-problem to itself (ruling P11)", async () => {
    const el = await mount();
    const outer = vi.fn();
    document.body.addEventListener("view-ready", outer);
    document.body.addEventListener("view-problem", outer);
    const inner = q(el, "dm-view") as HTMLElement;
    inner.dispatchEvent(
      new CustomEvent("view-ready", { detail: { session: {} }, bubbles: true, composed: true }),
    );
    inner.dispatchEvent(new CustomEvent("view-problem", { bubbles: true, composed: true }));
    document.body.removeEventListener("view-ready", outer);
    document.body.removeEventListener("view-problem", outer);
    expect(outer).not.toHaveBeenCalled();
  });
  it("hides the strip when its view cannot load: no toggle, no body, no alert, the count reset, the action kept", async () => {
    const el = await mount();
    const inner = q(el, "dm-view") as HTMLElement;
    inner.dispatchEvent(new CustomEvent("view-problem", { bubbles: true, composed: true }));
    await el.updateComplete;
    expect(q(el, "[data-toggle]")).toBeNull();
    expect(q(el, "[data-body]")).toBeNull();
    expect(q(el, "dm-view")).toBeNull();
    expect(q(el, '[role="alert"]')).toBeNull();
    expect(q(el, "[data-count]")).toBeNull();
    expect(q(el, "[data-action]")?.textContent).toContain("Re-visualize");
    el.rev = 1; // a re-run's fresh view gets another try
    await el.updateComplete;
    expect(q(el, "[data-toggle]")).not.toBeNull();
  });
});
