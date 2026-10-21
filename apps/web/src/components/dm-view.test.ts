import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/http";
import { createServices } from "../services";
import { fakeUi } from "../testing/fakeUi";
import { mountWith } from "../testing/mount";
import "./dm-view";

const settle = (el: Element) =>
  (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
const q = <T extends Element>(el: Element, sel: string) => el.shadowRoot?.querySelector(sel) as T;

describe("dm-view", () => {
  it("shows a loading line, then the view, and says it is ready", async () => {
    const ui = fakeUi();
    const services = createServices({ api: ui.api as never });
    const ready = vi.fn();
    const mounted = await mountWith<HTMLElement>(services, "dm-view", { name: "library-empty" });
    mounted.addEventListener("view-ready", ready); // the view is fetched asynchronously, so this is in time
    await vi.waitFor(() => expect(q(mounted, "#host lu-note")).not.toBeNull());
    expect(q(mounted, "#host lu-note").shadowRoot?.textContent).toContain("No documents yet");
    expect(q(mounted, "[data-loading]")).toBeNull();
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it("shows a fixed sentence and a Try again button when the view cannot be fetched, and recovers", async () => {
    const ui = fakeUi();
    let fail = true;
    const api = {
      ...ui.api,
      uiView: vi.fn(async (name: never) => {
        if (fail) throw new ApiError(0, "network");
        return ui.api.uiView(name);
      }),
    };
    const services = createServices({ api: api as never });
    const el = await mountWith<HTMLElement>(services, "dm-view", { name: "library-empty" });
    await vi.waitFor(() => expect(q(el, "[role=alert]")).not.toBeNull());
    expect(q(el, "[role=alert]").textContent).toContain("could not be loaded");
    await new Promise((r) => setTimeout(r, 30));
    expect(api.uiView).toHaveBeenCalledTimes(1); // a failed fetch does not retry by itself
    fail = false;
    q<HTMLButtonElement>(el, "button[data-retry]").click();
    await vi.waitFor(() => expect(q(el, "#host lu-note")).not.toBeNull());
  });

  it("swaps the experience when the name changes, and disposes the old one", async () => {
    const ui = fakeUi();
    const services = createServices({ api: ui.api as never });
    const el = await mountWith<HTMLElement & { name: string; session?: { name: string } }>(
      services,
      "dm-view",
      { name: "library-empty" },
    );
    await vi.waitFor(() => expect(el.session?.name).toBe("library-empty"));
    el.name = "sessions";
    await settle(el);
    await vi.waitFor(() => expect(el.session?.name).toBe("sessions"));
    expect(q(el, "#host lu-note")).toBeNull();
  });

  const gate = <T>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  type ViewEl = HTMLElement & { name: string; session?: { name: string }; params?: unknown };

  it("A to B to A during a fetch mounts exactly one view and disposes the others", async () => {
    const ui = fakeUi();
    const held: Array<{ name: string; resolve: () => void }> = [];
    const api = {
      ...ui.api,
      uiView: vi.fn(async (name: never, signal?: AbortSignal) => {
        const g = gate<void>();
        held.push({ name, resolve: g.resolve });
        await g.promise;
        return ui.api.uiView(name, signal);
      }),
    };
    const services = createServices({ api: api as never });
    const el = await mountWith<ViewEl>(services, "dm-view", { name: "library-empty" });
    await vi.waitFor(() => expect(held).toHaveLength(1));
    el.name = "sessions";
    await settle(el);
    await vi.waitFor(() => expect(held).toHaveLength(2));
    el.name = "library-empty";
    await settle(el);
    await vi.waitFor(() => expect(held).toHaveLength(3));
    for (const h of held) h.resolve();
    await vi.waitFor(() => expect(el.session?.name).toBe("library-empty"));
    await new Promise((r) => setTimeout(r, 30));
    expect(el.shadowRoot?.querySelectorAll("#host lu-note").length).toBe(1);
    expect(el.shadowRoot?.querySelectorAll("#host > *").length).toBeGreaterThan(0);
  });

  it("a disconnect during the fetch mounts nothing and fires no event", async () => {
    const ui = fakeUi();
    const g = gate<void>();
    const api = {
      ...ui.api,
      uiView: vi.fn(async (name: never) => {
        await g.promise;
        return ui.api.uiView(name);
      }),
    };
    const services = createServices({ api: api as never });
    const el = await mountWith<ViewEl>(services, "dm-view", { name: "library-empty" });
    const seen = vi.fn();
    el.addEventListener("view-ready", seen);
    el.addEventListener("view-problem", seen);
    await vi.waitFor(() => expect(api.uiView).toHaveBeenCalledTimes(1));
    el.remove();
    g.resolve();
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).not.toHaveBeenCalled();
    expect(el.session).toBeUndefined();
    expect(el.shadowRoot?.querySelector("#host")?.children.length).toBe(0);
  });

  it("a fetch that fails after a disconnect sets no phase and fires no event", async () => {
    const ui = fakeUi();
    const g = gate<void>();
    const api = {
      ...ui.api,
      uiView: vi.fn(async () => {
        await g.promise;
        throw new ApiError(0, "network");
      }),
    };
    const services = createServices({ api: api as never });
    const el = await mountWith<ViewEl & { phase: string }>(services, "dm-view", {
      name: "library-empty",
    });
    const seen = vi.fn();
    el.addEventListener("view-problem", seen);
    await vi.waitFor(() => expect(api.uiView).toHaveBeenCalledTimes(1));
    el.remove();
    g.resolve();
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).not.toHaveBeenCalled();
    expect(el.phase).toBe("loading");
  });

  it("a mount failure disposes the session and shows the fixed sentence", async () => {
    const ui = fakeUi();
    const services = createServices({ api: ui.api as never });
    const { ViewSession } = await import("../ui/session");
    const mount = vi.spyOn(ViewSession.prototype, "mount").mockImplementation(() => {
      throw new Error("boom");
    });
    const dispose = vi.spyOn(ViewSession.prototype, "dispose");
    const problem = vi.fn();
    const el = await mountWith<ViewEl>(services, "dm-view", { name: "library-empty" });
    el.addEventListener("view-problem", problem);
    await vi.waitFor(() => expect(el.shadowRoot?.querySelector("[role=alert]")).not.toBeNull());
    expect(dispose).toHaveBeenCalled();
    expect(el.session).toBeUndefined();
    mount.mockRestore();
    dispose.mockRestore();
  });

  it("disconnecting always disposes, even when the session's teardown throws, and a reconnect opens again", async () => {
    const ui = fakeUi();
    const services = createServices({ api: ui.api as never });
    const el = await mountWith<ViewEl & { session?: { dispose(): void } }>(services, "dm-view", {
      name: "library-empty",
    });
    await vi.waitFor(() => expect(el.session).toBeDefined());
    const session = el.session as { dispose(): void };
    session.dispose = () => {
      throw new Error("x");
    };
    const parent = el.parentElement as HTMLElement;
    expect(() => el.remove()).not.toThrow();
    expect(el.session).toBeUndefined();
    parent.append(el);
    await vi.waitFor(() => expect(el.session).toBeDefined());
  });

  it("tells the page with a toast when an action was stale, and passes new params to the session", async () => {
    const ui = fakeUi();
    const services = createServices({ api: ui.api as never });
    const el = await mountWith<
      ViewEl & {
        session?: { dispatch(a: never, h: never): Promise<unknown>; setParams(p: unknown): void };
      }
    >(services, "dm-view", { name: "library-empty" });
    await vi.waitFor(() => expect(el.session).toBeDefined());
    const session = el.session as NonNullable<typeof el.session>;
    const set = vi.spyOn(session, "setParams");
    el.params = { id: "x" };
    await settle(el);
    expect(set).toHaveBeenCalledWith({ id: "x" });
    await session.dispatch({ type: "SELECT", widgetId: "w" } as never, (() => undefined) as never);
    expect(services.toasts.get().some((t) => t.text.includes("changed"))).toBe(true);
  });
});
