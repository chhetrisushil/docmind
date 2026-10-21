import { describe, expect, it, vi } from "vitest";
import { Router, parseRoute } from "../router";
import { createServices } from "../services";
import { mountWith } from "../testing/mount";
import "./index";

function services(path: string) {
  const win = {
    location: { pathname: path, search: "" },
    history: {
      pushState: vi.fn((_s: unknown, _t: string, u: string) => {
        win.location.pathname = u;
      }),
      replaceState: vi.fn(),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return createServices({
    router: new Router(win as never),
    fetch: (async () => new Response("{}", { status: 404 })) as never,
  });
}
const root = (el: Element) => el.shadowRoot as ShadowRoot;
const settle = async (el: Element) => {
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
};

describe("dm-app", () => {
  it("draws the view of the current route, and not-found for a route with no view", async () => {
    const svc = services("/nope");
    const app = await mountWith<HTMLElement>(svc, "dm-app", { services: svc });
    expect(root(app).querySelector("dm-not-found")).not.toBeNull();
    expect(svc.router.route).toEqual({ name: "not-found" });
  });

  it("follows the router", async () => {
    const svc = services("/nope");
    const app = await mountWith<HTMLElement>(svc, "dm-app", { services: svc });
    svc.router.navigate(parseRoute("/nope"));
    await settle(app);
    expect(root(app).querySelector("dm-not-found")).not.toBeNull(); // a route that never has a view
  });

  it("turns a click on a same-origin link into a navigation, and leaves modified and external links alone", async () => {
    const svc = services("/nope");
    const app = await mountWith<HTMLElement>(svc, "dm-app", { services: svc });
    const a = document.createElement("a");
    a.href = "/settings";
    root(app).append(a);
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, cancelable: true }));
    expect(svc.router.route).toEqual({ name: "settings" });
    const ext = document.createElement("a");
    ext.href = "https://example.com/x";
    root(app).append(ext);
    const ev = new MouseEvent("click", { bubbles: true, composed: true, cancelable: true });
    ext.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    const mod = document.createElement("a");
    mod.href = "/documents";
    root(app).append(mod);
    mod.dispatchEvent(
      new MouseEvent("click", { bubbles: true, composed: true, cancelable: true, ctrlKey: true }),
    );
    expect(svc.router.route).toEqual({ name: "settings" });
  });

  it("shows toasts as status or alert and lets the user dismiss them", async () => {
    const svc = services("/nope");
    const app = await mountWith<HTMLElement>(svc, "dm-app", { services: svc });
    svc.toasts.push({ kind: "ok", text: "Saved" });
    svc.toasts.push({ kind: "err", text: "Failed" });
    await settle(app);
    const toasts = root(app).querySelector("dm-toasts") as HTMLElement;
    await settle(toasts);
    const items = [...root(toasts).querySelectorAll("[data-toast]")];
    expect(
      items.map((i) => [
        i.getAttribute("role"),
        i.textContent?.includes("Saved") || i.textContent?.includes("Failed"),
      ]),
    ).toEqual([
      ["status", true],
      ["alert", true],
    ]);
    (
      root(toasts).querySelector("[data-toast] button[aria-label='Dismiss']") as HTMLButtonElement
    ).click();
    await settle(toasts);
    expect(root(toasts).querySelectorAll("[data-toast]").length).toBe(1);
  });
});
