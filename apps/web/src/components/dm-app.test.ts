import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/http";
import { Router, parseRoute } from "../router";
import { createServices } from "../services";
import { AuthStore } from "../state/auth";
import { fakeUi } from "../testing/fakeUi";
import { mountWith } from "../testing/mount";
import "./index";
import { DmApp } from "./dm-app";

const ME = {
  userId: "0b4f7d52-6c53-4c6e-9d49-2b0e7a3f9a10",
  tenantId: "7f6d1b8e-3b0a-4a56-8f2f-0a8e0f7c4d11",
  email: "a@example.com",
};
function fakeWindow(path: string) {
  const win = {
    location: { pathname: path, search: "" },
    history: {
      pushState: vi.fn((_s: unknown, _t: string, u: string) => {
        win.location.pathname = u;
      }),
      replaceState: vi.fn((_s: unknown, _t: string, u: string) => {
        win.location.pathname = u;
      }),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return win;
}
function servicesWithAuth(path: string, over: Record<string, unknown> = {}) {
  const win = fakeWindow(path);
  const api = {
    me: async () => ME,
    login: async () => ME,
    logout: async () => {},
    signUp: async () => {},
    ...over,
  } as never;
  const svc = createServices({ router: new Router(win as never), api, auth: new AuthStore(api) });
  return Object.assign(svc, { win });
}
/** A signed-in session, so the views are reachable. */
const services = (path: string) => servicesWithAuth(path);
const root = (el: Element) => el.shadowRoot as ShadowRoot;
const settle = async (el: Element) => {
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
};

describe("dm-app", () => {
  it("draws the view of the current route, and not-found for a route with no view", async () => {
    const svc = services("/nope");
    const app = await mountWith<HTMLElement>(svc, "dm-app", { services: svc });
    await vi.waitFor(() => expect(root(app).querySelector("dm-not-found")).not.toBeNull());
    expect(svc.router.route).toEqual({ name: "not-found" });
  });

  it("follows the router", async () => {
    const svc = services("/nope");
    const app = await mountWith<HTMLElement>(svc, "dm-app", { services: svc });
    await vi.waitFor(() => expect(root(app).querySelector("dm-not-found")).not.toBeNull());
    svc.router.navigate(parseRoute("/nope"));
    await settle(app);
    expect(root(app).querySelector("dm-not-found")).not.toBeNull(); // a route that never has a view
  });

  it("turns a click on a same-origin link into a navigation, and leaves modified and external links alone", async () => {
    const svc = services("/nope");
    const app = await mountWith<HTMLElement>(svc, "dm-app", { services: svc });
    await vi.waitFor(() => expect(root(app).querySelector("dm-not-found")).not.toBeNull());
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

  it("keeps one live region per urgency from the first render and puts toasts inside it", async () => {
    const svc = services("/nope");
    const app = await mountWith<HTMLElement>(svc, "dm-app", { services: svc });
    await vi.waitFor(() => expect(root(app).querySelector("dm-toasts")).not.toBeNull());
    const toasts = root(app).querySelector("dm-toasts") as HTMLElement;
    await settle(toasts);
    const status = root(toasts).querySelector("[role=status]") as HTMLElement;
    const alert = root(toasts).querySelector("[role=alert]") as HTMLElement;
    expect(status).not.toBeNull();
    expect(alert).not.toBeNull();
    expect(status.getAttribute("aria-atomic")).toBe("false");
    expect(alert.getAttribute("aria-atomic")).toBe("false");
    expect(root(toasts).querySelectorAll("[data-toast]").length).toBe(0);
    svc.toasts.push({ kind: "ok", text: "Saved" });
    svc.toasts.push({ kind: "err", text: "Failed" });
    await settle(toasts);
    expect(root(toasts).querySelector("[role=status]")).toBe(status); // the same node: announcements are not lost on re-render
    expect(root(toasts).querySelector("[role=alert]")).toBe(alert);
    expect(
      [...status.querySelectorAll("[data-toast]")].map((i) => i.textContent?.includes("Saved")),
    ).toEqual([true]);
    expect(
      [...alert.querySelectorAll("[data-toast]")].map((i) => i.textContent?.includes("Failed")),
    ).toEqual([true]);
    (alert.querySelector("[data-toast] button[aria-label='Dismiss']") as HTMLButtonElement).click();
    await settle(toasts);
    expect(root(toasts).querySelectorAll("[data-toast]").length).toBe(1);
  });

  it("leaves a link to an unknown path, an api path, a hash and a download to the browser", async () => {
    const svc = services("/settings");
    const app = await mountWith<HTMLElement>(svc, "dm-app", { services: svc });
    await settle(app);
    const click = (href: string, download = false) => {
      const a = document.createElement("a");
      a.href = href;
      if (download) a.setAttribute("download", "");
      root(app).append(a);
      const ev = new MouseEvent("click", { bubbles: true, composed: true, cancelable: true });
      a.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    expect(click("/no-such-page")).toBe(false);
    expect(click("/api/documents/x/file")).toBe(false);
    expect(click("/documents#top")).toBe(false);
    expect(click("/documents", true)).toBe(false);
    expect(svc.router.route).toEqual({ name: "settings" });
    expect(click("/documents")).toBe(true);
    expect(svc.router.route).toEqual({ name: "documents" });
  });

  it("sends an anonymous visitor to sign-in and a signed-in one away from it", async () => {
    const anon = servicesWithAuth("/documents", {
      me: async () => {
        throw new ApiError(401, "unauthorized");
      },
    });
    await mountWith<HTMLElement>(anon, "dm-app", { services: anon });
    await vi.waitFor(() => expect(anon.router.route).toEqual({ name: "sign-in" }));
    expect(anon.win.history.replaceState).toHaveBeenCalledTimes(1);
    const signedIn = servicesWithAuth("/sign-in", { me: async () => ME });
    await mountWith<HTMLElement>(signedIn, "dm-app", { services: signedIn });
    await vi.waitFor(() => expect(signedIn.router.route).toEqual({ name: "chat" }));
    const erased = servicesWithAuth("/account-deleted", {
      me: async () => {
        throw new ApiError(401, "unauthorized");
      },
    });
    await mountWith<HTMLElement>(erased, "dm-app", { services: erased });
    await vi.waitFor(() => expect(erased.auth.get().status).toBe("anonymous"));
    expect(erased.router.route).toEqual({ name: "account-deleted" });
  });

  it("draws nothing but a busy marker until the session is known", async () => {
    const pending = servicesWithAuth("/chats", { me: () => new Promise(() => {}) });
    const app = await mountWith<HTMLElement>(pending, "dm-app", { services: pending });
    expect(root(app).querySelector("[aria-busy='true']")).not.toBeNull();
    expect(root(app).querySelector("dm-not-found")).toBeNull();
  });

  it("a 401 'unauthorized' from any call ends the session and routes to sign-in once, with no loop", async () => {
    let live = true;
    const fetch = (async (url: string) =>
      String(url).includes("/api/ui/")
        ? new Promise<Response>(() => {}) // the sidebar's chat list: its own 401 is covered in "dm-app: the sidebar"
        : live && String(url).endsWith("/api/me")
          ? new Response(JSON.stringify(ME), { headers: { "content-type": "application/json" } })
          : new Response(JSON.stringify({ error: { code: "unauthorized", message: "x" } }), {
              status: 401,
              headers: { "content-type": "application/json" },
            })) as never;
    const win = fakeWindow("/settings"); // not /documents: that page fetches its view, and this fetch answers 401 once "live" is false
    const svc = createServices({ router: new Router(win as never), fetch });
    const app = await mountWith<HTMLElement>(svc, "dm-app", { services: svc });
    await vi.waitFor(() => expect(svc.auth.get().status).toBe("signed-in"));
    await settle(app);
    expect(win.history.replaceState).not.toHaveBeenCalled();
    live = false;
    await svc.api.me().catch(() => {});
    await vi.waitFor(() => expect(svc.router.route).toEqual({ name: "sign-in" }));
    await svc.api.me().catch(() => {});
    await svc.api.me().catch(() => {});
    await settle(app);
    expect(win.history.replaceState).toHaveBeenCalledTimes(1);
    expect(svc.router.route).toEqual({ name: "sign-in" });
  });

  it("a page that fetches on load and gets a 401 ends the session once: one sign-in route, no refetch loop", async () => {
    const seen: string[] = [];
    const fetch = (async (url: string) => {
      seen.push(String(url));
      return String(url).endsWith("/api/me")
        ? new Response(JSON.stringify(ME), { headers: { "content-type": "application/json" } })
        : new Response(JSON.stringify({ error: { code: "unauthorized", message: "x" } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
    }) as never;
    const win = fakeWindow("/documents");
    const svc = createServices({ router: new Router(win as never), fetch });
    const app = await mountWith<HTMLElement>(svc, "dm-app", { services: svc });
    await vi.waitFor(() => expect(svc.router.route).toEqual({ name: "sign-in" }));
    await settle(app);
    // let the sign-out burst of requests settle before counting
    await new Promise((r) => setTimeout(r, 50));
    const count = seen.length;
    // negative wait: nothing more may be requested once signed out
    await new Promise((r) => setTimeout(r, 100));
    expect(seen.length).toBe(count);
    expect(win.history.replaceState).toHaveBeenCalledTimes(1);
    expect(svc.router.route).toEqual({ name: "sign-in" });
  });

  it("does not navigate when the session ends on sign-in or sign-up", async () => {
    for (const path of ["/sign-in", "/sign-up"]) {
      const svc = servicesWithAuth(path, {
        me: async () => {
          throw new ApiError(401, "unauthorized");
        },
      });
      const nav = vi.spyOn(svc.router, "navigate");
      const app = await mountWith<HTMLElement>(svc, "dm-app", { services: svc });
      await vi.waitFor(() => expect(svc.auth.get().status).toBe("anonymous"));
      svc.auth.expired();
      await settle(app);
      expect(nav).not.toHaveBeenCalled();
      expect(svc.win.history.replaceState).not.toHaveBeenCalled();
    }
  });
});

describe("dm-app: fix round 1", () => {
  it("keeps the same toast regions through the busy marker and every navigation", async () => {
    let release: (v: unknown) => void = () => {};
    const svc = servicesWithAuth("/settings", {
      me: () =>
        new Promise((r) => {
          release = r;
        }),
    });
    const app = await mountWith<HTMLElement>(svc, "dm-app", { services: svc });
    const toasts = root(app).querySelector("dm-toasts") as HTMLElement;
    expect(toasts).not.toBeNull();
    await settle(toasts);
    const status = root(toasts).querySelector("[role=status]");
    const alert = root(toasts).querySelector("[role=alert]");
    release(ME);
    await vi.waitFor(() => expect(root(app).querySelector("[aria-busy='true']")).toBeNull());
    for (const path of ["/documents", "/sign-in", "/nope"]) {
      svc.router.navigate(parseRoute(path));
      await settle(app);
      expect(root(app).querySelector("dm-toasts")).toBe(toasts);
      expect(root(toasts).querySelector("[role=status]")).toBe(status);
      expect(root(toasts).querySelector("[role=alert]")).toBe(alert);
    }
  });

  it("redirects in one render, without Lit's update-after-update warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const render = vi.spyOn(DmApp.prototype, "render");
    const svc = servicesWithAuth("/documents", {
      me: async () => {
        throw new ApiError(401, "unauthorized");
      },
    });
    const app = await mountWith<HTMLElement>(svc, "dm-app", { services: svc });
    await vi.waitFor(() => expect(svc.router.route).toEqual({ name: "sign-in" }));
    await settle(app);
    const lit = warn.mock.calls.filter((c) => String(c[0]).includes("scheduled an update"));
    warn.mockRestore();
    const renders = render.mock.calls.length;
    render.mockRestore();
    expect(lit).toEqual([]);
    expect(renders).toBe(2); // busy while unknown, then the sign-in view: no extra pass for the redirect
  });

  it("the busy marker is a labelled status", async () => {
    const svc = servicesWithAuth("/chats", { me: () => new Promise(() => {}) });
    const app = await mountWith<HTMLElement>(svc, "dm-app", { services: svc });
    const busy = root(app).querySelector("[aria-busy='true']") as HTMLElement;
    expect(busy.getAttribute("role")).toBe("status");
    expect(busy.textContent).toContain("Loading");
  });

  it("an anonymous visitor to an unknown path lands on sign-in", async () => {
    const svc = servicesWithAuth("/nope", {
      me: async () => {
        throw new ApiError(401, "unauthorized");
      },
    });
    const app = await mountWith<HTMLElement>(svc, "dm-app", { services: svc });
    await vi.waitFor(() => expect(svc.router.route).toEqual({ name: "sign-in" }));
    expect(root(app).querySelector("dm-not-found")).toBeNull();
  });

  it("draws signed-in routes inside the shell, and sign-in, account-deleted and not-found outside it", async () => {
    const svc = services("/settings");
    const app = await mountWith<HTMLElement>(svc, "dm-app", { services: svc });
    await vi.waitFor(() =>
      expect(root(app).querySelector("dm-app-shell > dm-settings")).not.toBeNull(),
    );
    expect(root(app).querySelector("dm-app-shell dm-toasts")).toBeNull(); // the live regions stay outside
    svc.router.navigate({ name: "account-deleted" });
    await vi.waitFor(() => expect(root(app).querySelector("dm-account-deleted")).not.toBeNull());
    expect(root(app).querySelector("dm-app-shell")).toBeNull();
    svc.router.navigate(parseRoute("/nope"));
    await vi.waitFor(() => expect(root(app).querySelector("dm-not-found")).not.toBeNull());
    expect(root(app).querySelector("dm-app-shell")).toBeNull();
  });
});

describe("dm-app: the sidebar", () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("a 401 on the sidebar's own view fetch ends the session once: one sign-in route, one replaceState, no further /api/ui/ requests", async () => {
    const seen: string[] = [];
    const fetch = (async (url: string) => {
      seen.push(String(url));
      return String(url).endsWith("/api/me")
        ? json(ME)
        : json({ error: { code: "unauthorized", message: "x" } }, 401);
    }) as never;
    const win = fakeWindow("/settings"); // a page that fetches nothing itself: only the sidebar asks
    const svc = createServices({ router: new Router(win as never), fetch });
    const app = await mountWith<HTMLElement>(svc, "dm-app", { services: svc });
    await vi.waitFor(() => expect(svc.router.route).toEqual({ name: "sign-in" }));
    await settle(app);
    expect(seen.filter((u) => u.includes("/api/ui/")).length).toBeGreaterThan(0);
    // let the sign-out burst of requests settle before counting
    await new Promise((r) => setTimeout(r, 50));
    const ui = () => seen.filter((u) => u.includes("/api/ui/")).length;
    const count = ui();
    // negative wait: nothing more may be requested once signed out
    await new Promise((r) => setTimeout(r, 100));
    expect(ui()).toBe(count);
    expect(win.history.replaceState).toHaveBeenCalledTimes(1);
    expect(svc.router.route).toEqual({ name: "sign-in" });
    expect(root(app).querySelector("dm-app-shell")).toBeNull();
  });

  it("signing out and in as another user leaves none of the first user's chats, and fetches the view again", async () => {
    const A = { ...ME, email: "a@example.com" };
    const B = { ...ME, userId: "1b4f7d52-6c53-4c6e-9d49-2b0e7a3f9a10", email: "b@example.com" };
    const who = { now: A };
    const chat = (n: number, title: string) => ({
      id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
      title,
      scope: "all" as const,
      createdAt: "2026-10-01T10:00:00.000Z",
      lastMessageAt: "2026-10-05T10:00:00.000Z",
      messageCount: 1,
    });
    const ui = fakeUi({
      documents: async () => ({ items: [], truncated: false }),
      document: async () => null,
      content: async () => null,
      chats: async () => (who.now === A ? [chat(1, "Alpha invoices")] : [chat(2, "Beta plans")]),
    });
    const uiView = vi.fn(ui.api.uiView);
    const sessionsFetched = () => uiView.mock.calls.filter((c) => c[0] === "sessions").length;
    const svc = servicesWithAuth("/chats", {
      ...ui.api,
      uiView,
      me: async () => who.now,
      login: async () => who.now,
    });
    const app = await mountWith<HTMLElement>(svc, "dm-app", { services: svc });
    const text = () => {
      const side = root(app)
        .querySelector("dm-app-shell")
        ?.shadowRoot?.querySelector("dm-sessions");
      const table = side?.shadowRoot
        ?.querySelector("dm-view")
        ?.shadowRoot?.querySelector("lu-table");
      return table?.shadowRoot?.textContent ?? "";
    };
    await vi.waitFor(() => expect(text()).toContain("Alpha invoices"));
    expect(sessionsFetched()).toBe(1);
    await svc.auth.logout();
    await vi.waitFor(() => expect(svc.router.route).toEqual({ name: "sign-in" }));
    await settle(app);
    expect(root(app).querySelector("dm-app-shell")).toBeNull();
    who.now = B;
    await svc.auth.login({ email: B.email, password: "x" });
    svc.router.navigate({ name: "chat" });
    await vi.waitFor(() => expect(text()).toContain("Beta plans"));
    expect(text()).not.toContain("Alpha invoices");
    expect(sessionsFetched()).toBe(2);
  });
});
