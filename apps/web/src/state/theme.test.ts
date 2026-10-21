import { describe, expect, it } from "vitest";
import { type ThemeEnv, ThemeStore } from "./theme";

function env(opts: { dark?: boolean; stored?: string | null; throwing?: boolean } = {}) {
  const set: Record<string, string> = opts.stored ? { "dm-theme": opts.stored } : {};
  const listeners: EventListener[] = [];
  const storage = {
    getItem: (k: string) => {
      if (opts.throwing) throw new Error("blocked");
      return set[k] ?? null;
    },
    setItem: (k: string, v: string) => {
      if (opts.throwing) throw new Error("blocked");
      set[k] = v;
    },
  };
  const media = {
    matches: opts.dark === false,
    addEventListener: (_: string, fn: EventListener) => {
      listeners.push(fn);
    },
    removeEventListener: (_: string, fn: EventListener) => {
      listeners.splice(listeners.indexOf(fn), 1);
    },
  };
  const doc = document.implementation.createHTMLDocument("t");
  return {
    set,
    listeners,
    media,
    win: { document: doc, matchMedia: () => media, localStorage: storage } satisfies ThemeEnv & {
      document: Document;
    },
  };
}

describe("ThemeStore", () => {
  it("follows the system by default, dark when it says nothing", () => {
    const e = env({ dark: true });
    const store = new ThemeStore(e.win);
    store.apply();
    expect(store.get()).toBe("system");
    expect(e.win.document.documentElement.dataset.theme).toBe("dark");
    const l = env({ dark: false });
    new ThemeStore(l.win).apply();
    expect(l.win.document.documentElement.dataset.theme).toBe("light");
  });

  it("stores only the choice, under one key, and ignores a stored value it does not know", () => {
    const e = env({ stored: "<script>" });
    const store = new ThemeStore(e.win);
    expect(store.get()).toBe("system");
    store.choose("light");
    expect(e.set).toEqual({ "dm-theme": "light" });
    expect(e.win.document.documentElement.dataset.theme).toBe("light");
  });

  it("works with storage blocked", () => {
    const e = env({ throwing: true });
    const store = new ThemeStore(e.win);
    expect(() => store.choose("dark")).not.toThrow();
    expect(e.win.document.documentElement.dataset.theme).toBe("dark");
  });

  it("applies the stored choice on construction", () => {
    const e = env({ stored: "light", dark: true });
    new ThemeStore(e.win);
    expect(e.win.document.documentElement.dataset.theme).toBe("light");
  });

  it("watchSystem re-applies on an OS change while the choice is system, and stops", () => {
    const e = env({ dark: true });
    const store = new ThemeStore(e.win);
    const stop = store.watchSystem();
    expect(e.listeners).toHaveLength(1);
    e.media.matches = true; // the OS flips to light
    for (const fn of e.listeners) fn(new Event("change"));
    expect(e.win.document.documentElement.dataset.theme).toBe("light");
    store.choose("dark");
    e.media.matches = true;
    for (const fn of e.listeners) fn(new Event("change"));
    expect(e.win.document.documentElement.dataset.theme).toBe("dark");
    stop();
    expect(e.listeners).toHaveLength(0);
  });
});
