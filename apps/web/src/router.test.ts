import { describe, expect, it, vi } from "vitest";
import { type Route, Router, hrefOf, parseRoute } from "./router";

const ID = "0b4f7d52-6c53-4c6e-9d49-2b0e7a3f9a10";
const ID2 = "1c5e8a63-7d64-4d7f-8e5a-3c1f8b4a0b21";

describe("parseRoute / hrefOf", () => {
  const table: [string, string, Route][] = [
    ["/", "", { name: "chat" }],
    ["/chats", "", { name: "chat" }],
    ["/chats/", "", { name: "chat" }],
    [`/chats/${ID}`, "", { name: "chat", chatId: ID }],
    [`/chats/${ID.toUpperCase()}`, "", { name: "chat", chatId: ID }],
    ["/documents", "", { name: "documents" }],
    ["/documents", `?tags=${ID}`, { name: "documents", tags: [ID] }],
    [
      "/documents",
      `?tags=${ID},${ID2}&match=all`,
      { name: "documents", tags: [ID, ID2], match: "all" },
    ],
    ["/documents", `?tags=${ID.toUpperCase()},${ID}`, { name: "documents", tags: [ID] }],
    ["/documents", "?tags=nope,&match=all", { name: "documents" }],
    ["/documents", "?match=all", { name: "documents" }],
    ["/documents", `?tags=${ID}&match=any`, { name: "documents", tags: [ID] }],
    [`/documents/${ID}`, "", { name: "document", id: ID }],
    [`/documents/${ID}`, `?passage=${ID}`, { name: "document", id: ID, passage: ID }],
    [`/documents/${ID}`, "?passage=not-an-id", { name: "document", id: ID }],
    ["/sign-in", "", { name: "sign-in" }],
    ["/sign-up", "", { name: "sign-up" }],
    ["/account-deleted", "", { name: "account-deleted" }],
    ["/settings", "", { name: "settings" }],
  ];
  it.each(table)("%s%s", (path, search, route) => expect(parseRoute(path, search)).toEqual(route));

  it("anything else, including a path that is not an id, is not-found", () => {
    for (const path of [
      "/chats/abc",
      "/documents/../x",
      "/nope",
      "//evil.example.com",
      `/chats/${ID}/x`,
    ])
      expect(parseRoute(path)).toEqual({ name: "not-found" });
  });

  it("hrefOf is the inverse for every route that has a path", () => {
    for (const [path, search, route] of table) {
      if (
        path === "/" ||
        path.endsWith("/") ||
        path.includes(ID.toUpperCase()) ||
        search === "?passage=not-an-id" ||
        // Non-canonical addresses that parse to a route which writes itself differently.
        search.includes(ID.toUpperCase()) ||
        search === "?tags=nope,&match=all" ||
        search === "?match=all" ||
        search.endsWith("&match=any")
      )
        continue;
      expect(hrefOf(route)).toBe(path + search);
    }
    expect(hrefOf({ name: "not-found" })).toBe("/chats");
  });
});

describe("the library route's tag filter in the address", () => {
  it("round-trips: Any is omitted, All and the ids are written", () => {
    expect(hrefOf({ name: "documents" })).toBe("/documents");
    expect(hrefOf({ name: "documents", tags: [ID] })).toBe(`/documents?tags=${ID}`);
    expect(hrefOf({ name: "documents", tags: [ID, ID2], match: "all" })).toBe(
      `/documents?tags=${ID},${ID2}&match=all`,
    );
    expect(hrefOf({ name: "documents", tags: [], match: "all" })).toBe("/documents");
  });
  it("keeps at most 10 distinct valid ids", () => {
    const ids = Array.from(
      { length: 12 },
      (_, i) => `1c5e8a63-7d64-4d7f-8e5a-${String(i).padStart(12, "0")}`,
    );
    const r = parseRoute("/documents", `?tags=${ids.join(",")}`);
    expect(r).toEqual({ name: "documents", tags: ids.slice(0, 10) });
  });
});

function fakeWindow(path = "/chats") {
  const listeners: Record<string, (() => void)[]> = {};
  const win = {
    location: { pathname: path, search: "" },
    history: {
      pushState: vi.fn((_s: unknown, _t: string, url: string) => {
        win.location.pathname = new URL(url, "http://x").pathname;
        win.location.search = new URL(url, "http://x").search;
      }),
      replaceState: vi.fn((_s: unknown, _t: string, url: string) => {
        win.location.pathname = new URL(url, "http://x").pathname;
        win.location.search = new URL(url, "http://x").search;
      }),
    },
    addEventListener: (t: string, fn: () => void) => {
      listeners[t] = [...(listeners[t] ?? []), fn];
    },
    removeEventListener: (t: string, fn: () => void) => {
      listeners[t] = (listeners[t] ?? []).filter((f) => f !== fn);
    },
  };
  return {
    win: win as never,
    raw: win,
    fire: (t: string) => {
      for (const fn of listeners[t] ?? []) fn();
    },
    listeners,
  };
}

describe("Router", () => {
  it("starts on the current location, pushes or replaces on navigate, and follows popstate", () => {
    const f = fakeWindow("/documents");
    const router = new Router(f.win);
    router.start();
    expect(router.route).toEqual({ name: "documents" });
    router.navigate({ name: "settings" });
    expect(f.raw.history.pushState).toHaveBeenCalledWith(null, "", "/settings");
    router.navigate({ name: "chat" }, { replace: true });
    expect(f.raw.history.replaceState).toHaveBeenCalledWith(null, "", "/chats");
    f.raw.location.pathname = "/documents";
    f.fire("popstate");
    expect(router.route).toEqual({ name: "documents" });
    const seen: string[] = [];
    router.subscribe((r) => seen.push(r.name));
    router.navigate({ name: "settings" });
    expect(seen).toEqual(["settings"]);
  });

  it("does not push the route it is already on, and stop() removes the listener", () => {
    const f = fakeWindow("/settings");
    const router = new Router(f.win);
    router.start();
    router.navigate({ name: "settings" });
    expect(f.raw.history.pushState).not.toHaveBeenCalled();
    router.stop();
    expect(f.listeners.popstate).toEqual([]);
  });
});
