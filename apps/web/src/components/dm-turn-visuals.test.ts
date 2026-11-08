import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "../router";
import { createServices } from "../services";
import { mountWith } from "../testing/mount";
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
  it("is the containing block of its widgets, so their absolute descendants (a table's sr-only caption) can't stretch the page", async () => {
    const el = await mount();
    const body = q(el, "[data-body]");
    expect(body).not.toBeNull();
    expect(getComputedStyle(body as HTMLElement).position).toBe("relative");
  });
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
  it("a re-run's fresh view starts at no count, and one that then fails leaves no stale count behind", async () => {
    const el = await mount();
    el.count = 3; // the first view's widgets
    await el.updateComplete;
    expect(q(el, "[data-count]")?.textContent).toContain("3");
    el.rev = 1; // the re-run
    await el.updateComplete;
    expect(q(el, "[data-count]")).toBeNull();
    el.count = 2; // the fresh view's own widgets
    await el.updateComplete;
    q(el, "dm-view")?.dispatchEvent(
      new CustomEvent("view-problem", { bubbles: true, composed: true }),
    );
    await el.updateComplete;
    expect(el.count).toBe(0);
    expect(q(el, "[data-toggle]")).toBeNull();
    el.rev = 2; // another re-run: the strip is back, and shows no old count
    await el.updateComplete;
    expect(q(el, "[data-toggle]")).not.toBeNull();
    expect(q(el, "[data-count]")).toBeNull();
  });
});

describe("dm-turn-visuals: a source marker on a widget", () => {
  const D = "0b4f7d52-6c53-4c6e-9d49-2b0e7a3f9a10";
  const P = "7f6d1b8e-3b0a-4a56-8f2f-0a8e0f7c4d11";
  const withServices = async () => {
    const win = {
      location: { pathname: "/chats/c1", search: "" },
      history: { pushState() {}, replaceState() {} },
      addEventListener() {},
      removeEventListener() {},
    };
    const router = new Router(win as never);
    const services = createServices({ router });
    const el = await mountWith<DmTurnVisuals>(services, "dm-turn-visuals", {
      chatId: "c1",
      ord: 2,
      rev: 0,
      view: view(),
    });
    const inner = q(el, "dm-view") as unknown as {
      onAct: (a: unknown) => Promise<{ ok: boolean }>;
    };
    return { router, inner, start: router.route };
  };
  const ref = (refId: unknown) => ({ type: "REF_OPEN", widgetId: "w", payload: { refId, n: 1 } });
  it("opens the cited passage of the cited document", async () => {
    const { router, inner } = await withServices();
    expect(await inner.onAct(ref(`${D}:${P}`))).toMatchObject({ ok: true });
    expect(router.route).toEqual({ name: "document", id: D, passage: P });
  });
  it("refuses a malformed ref and any other action, and goes nowhere", async () => {
    const { router, inner, start } = await withServices();
    expect(await inner.onAct(ref("nope"))).toMatchObject({ ok: false });
    expect(await inner.onAct({ type: "A2UI_ACTION", payload: { action: "x" } })).toMatchObject({
      ok: false,
    });
    expect(router.route).toBe(start);
  });
});
