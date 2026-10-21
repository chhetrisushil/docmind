import type { DocumentDto } from "@docmind/contracts";
import { describe, expect, it, vi } from "vitest";
import { fakeUi } from "../testing/fakeUi";
import { ViewSession } from "./session";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const doc = (n: number, over: Partial<DocumentDto> = {}): DocumentDto => ({
  id: id(n),
  title: `Title ${n}`,
  filename: `f${n}.pdf`,
  mime: "application/pdf",
  sizeBytes: 100,
  status: "ready",
  error: null,
  stats: null,
  summary: null,
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:00:00.000Z",
  ...over,
});
const readers = (items: DocumentDto[]) => ({
  documents: vi.fn(async () => ({ items, truncated: false })),
  document: vi.fn(async (a: { id: string }) => items.find((d) => d.id === a.id) ?? null),
  content: vi.fn(async () => ({ items: [], more: false })),
  chats: vi.fn(async () => []),
});
const tick = () => new Promise((r) => setTimeout(r, 0));

async function open(
  name: "library" | "detail" | "chat",
  items = [doc(1), doc(2, { status: "failed", error: "Could not read this file." })],
) {
  const r = readers(items);
  const ui = fakeUi(r);
  const onStale = vi.fn();
  const session = await ViewSession.open(ui.api, name, { onStale });
  const host = document.createElement("div");
  document.body.append(host);
  const seen: unknown[] = [];
  return {
    r,
    ui,
    session,
    host,
    seen,
    onStale,
    mount: () =>
      session.mount(host, (a) => {
        seen.push(a);
        return { ok: true };
      }),
  };
}

describe("ViewSession", () => {
  it("hydrates a view from the server's plane and draws it with loom-ui's elements", async () => {
    const t = await open("library");
    t.session.start();
    t.mount();
    await vi.waitFor(() =>
      expect(t.host.querySelector("lu-table")?.shadowRoot?.textContent).toContain("Title 1"),
    );
    expect(t.host.querySelectorAll("lu-kpi").length).toBe(2);
    expect(t.host.querySelector("lu-status-card")?.shadowRoot?.textContent).toMatch(/failed/i);
    expect(t.ui.calls.hydrate.flatMap((c) => c.handles).sort()).toEqual([
      "doc-ready",
      "doc-total",
      "documents",
      "ingest",
    ]);
    expect(t.ui.calls.hydrate).toHaveLength(1); // one batch
    expect(t.r.documents).toHaveBeenCalledTimes(1); // the server memoises identical reads within a request (F05): counts, health and table share one
  });

  it("a parameter set before start reaches the handles, and a later one reloads them", async () => {
    const t = await open("detail", [
      doc(1),
      doc(2, { status: "failed", error: "Could not read this file." }),
    ]);
    t.session.start({ id: id(1) });
    t.mount();
    await vi.waitFor(() => expect(t.session.statusOf("doc-status")).toBe("ready"));
    expect(t.host.querySelector("lu-status-card")?.shadowRoot?.textContent).toContain("Ready");
    t.session.setParams({ id: id(2) });
    await vi.waitFor(() =>
      expect(t.host.querySelector("lu-status-card")?.shadowRoot?.textContent).toContain("Failed"),
    );
    expect(t.host.querySelectorAll("[role=tab]").length).toBe(3);
  });

  it("hands a widget action to the handler, with the type, the widget and the payload, when the view is fresh", async () => {
    const t = await open("library");
    t.session.start();
    t.mount();
    await vi.waitFor(() => expect(t.session.statusOf("documents")).toBe("ready"));
    const select = t.host
      .querySelector("lu-select-input")
      ?.shadowRoot?.querySelector("select") as HTMLSelectElement;
    select.value = "failed";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(t.seen).toHaveLength(1));
    expect(t.seen[0]).toMatchObject({
      type: "SELECT",
      widgetId: "filter",
      payload: { value: "failed" },
    });
  });

  it("refuses a stale action, tells the page, and reloads the view", async () => {
    const t = await open("library");
    t.session.start();
    t.mount();
    await vi.waitFor(() => expect(t.session.statusOf("documents")).toBe("ready"));
    const stale = {
      type: "TABLE_ROW_ACTION",
      widgetId: "table",
      payload: { action: "delete", rowKey: id(1) },
      viewedVersion: { experienceId: "docmind.library", versionHash: "sha256:old", compile: "x" },
    };
    expect(t.session.isFresh(stale)).toBe(false);
    await expect(t.session.dispatch(stale as never, () => ({ ok: true }))).resolves.toEqual({
      ok: false,
      reason: "stale",
    });
    expect(t.onStale).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(t.ui.calls.views).toEqual(["library", "library"]));
    expect(t.seen).toEqual([]);
  });

  it("refuses an action that carries no stamp at all", async () => {
    const t = await open("library");
    t.session.start();
    t.mount();
    expect(t.session.isFresh({ type: "SELECT", widgetId: "filter" })).toBe(false);
  });

  it("reloads once when the server says the version moved", async () => {
    const t = await open("library");
    const real = t.ui.api.uiHydrate;
    let first = true;
    const api = {
      ...t.ui.api,
      uiHydrate: vi.fn(async (view, requests, signal) => {
        if (!first) return real(view, requests, signal);
        first = false;
        return requests.map(() => ({
          state: "error",
          finding: { code: "version-mismatch", severity: "error", message: "m" },
        }));
      }),
    };
    const s = await ViewSession.open(api as never, "library", {});
    s.start();
    s.mount(t.host, () => undefined);
    await vi.waitFor(() => expect(s.statusOf("documents")).toBe("ready"));
    expect(t.ui.calls.views.length).toBeGreaterThanOrEqual(2);
  });

  it("publishes a value the page folds itself, for a listed handle and a kind that accepts it", async () => {
    const t = await open("chat");
    t.session.start();
    t.mount();
    const value = {
      entries: [
        {
          id: "t1.assistant",
          turn: 1,
          role: "assistant",
          status: "complete",
          parts: [{ type: "text", text: "Hello" }],
        },
      ],
    };
    expect(t.session.publish("transcript", value, "Chat")).toBe(true);
    await vi.waitFor(() =>
      expect(t.host.querySelector("lu-chat")?.shadowRoot?.textContent).toContain("Hello"),
    );
    expect(t.session.valueOf("transcript")).toEqual(value);
    expect(t.session.publish("nope", value, "Chat")).toBe(false);
    expect(t.session.publish("transcript", { entries: "x" }, "Chat")).toBe(false);
    expect(t.ui.calls.hydrate).toEqual([]); // a published handle is never requested
  });

  it("disposes: nothing more is drawn or accepted", async () => {
    const t = await open("chat");
    t.session.start();
    t.mount();
    t.session.dispose();
    expect(t.session.publish("transcript", { entries: [] }, "Chat")).toBe(false);
    await expect(t.session.reload()).resolves.toBeUndefined();
    expect(t.ui.calls.views).toEqual(["chat"]);
  });
});

describe("ViewSession: bounds and teardown", () => {
  const mismatch = (requests: readonly unknown[]) =>
    requests.map(() => ({
      state: "error",
      finding: { code: "version-mismatch", severity: "error", message: "m" },
    }));

  it("stops reloading when the server keeps answering version-mismatch, and says the view failed", async () => {
    const t = await open("library");
    const api = {
      ...t.ui.api,
      uiHydrate: vi.fn(async (_view: unknown, requests: readonly unknown[]) => mismatch(requests)),
    };
    const onFailed = vi.fn();
    const s = await ViewSession.open(api as never, "library", { onFailed });
    s.start();
    s.mount(t.host, () => undefined);
    await vi.waitFor(() => expect(onFailed).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 40));
    expect(t.ui.calls.views.length).toBe(4); // the helper's own open, this session's open and two reloads
    expect(onFailed).toHaveBeenCalledTimes(1);
    s.dispose();
  });

  it("a clean hydrate round gives the reload budget back", async () => {
    const t = await open("library");
    const real = t.ui.api.uiHydrate;
    let bad = 2;
    const api = {
      ...t.ui.api,
      uiHydrate: vi.fn(async (view: never, requests: never[], signal: never) => {
        if (bad > 0) {
          bad -= 1;
          return mismatch(requests);
        }
        return real(view, requests, signal);
      }),
    };
    const onFailed = vi.fn();
    const s = await ViewSession.open(api as never, "library", { onFailed });
    s.start();
    s.mount(t.host, () => undefined);
    await vi.waitFor(() => expect(s.statusOf("documents")).toBe("ready"));
    bad = 2;
    s.invalidate();
    await vi.waitFor(() => expect(bad).toBe(0));
    await vi.waitFor(() => expect(s.statusOf("documents")).toBe("ready"));
    expect(onFailed).not.toHaveBeenCalled();
    s.dispose();
  });

  it("a reload recomposes with one batch, not one request per handle", async () => {
    const t = await open("library");
    t.session.start();
    t.mount();
    await vi.waitFor(() => expect(t.session.statusOf("documents")).toBe("ready"));
    const before = t.ui.calls.hydrate.length;
    await t.session.reload();
    await vi.waitFor(() => expect(t.session.statusOf("documents")).toBe("ready"));
    await new Promise((r) => setTimeout(r, 20));
    expect(t.ui.calls.hydrate.length - before).toBeLessThanOrEqual(1);
  });

  it("dispose still stops the controller when a widget will not dispose, and does not throw", async () => {
    const t = await open("library");
    t.session.start();
    t.mount();
    const spy = vi.spyOn(t.session.split, "dispose");
    (t.session as unknown as { handle: unknown }).handle = {
      dispose() {
        throw new Error("widget");
      },
      head: () => ({}),
    };
    expect(() => t.session.dispose()).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("aborts the view fetch of a reload on dispose", async () => {
    const t = await open("library");
    let seen: AbortSignal | undefined;
    const api = {
      ...t.ui.api,
      uiView: vi.fn(async (_n: unknown, signal?: AbortSignal) => {
        seen = signal;
        return new Promise<never>(() => {});
      }),
    };
    const s = await ViewSession.open(
      { ...t.ui.api, uiView: t.ui.api.uiView } as never,
      "library",
      {},
    );
    (s as unknown as { api: unknown }).api = api;
    void s.reload();
    await vi.waitFor(() => expect(seen).toBeDefined());
    s.dispose();
    expect(seen?.aborted).toBe(true);
  });

  it("mount on a disposed session draws nothing", async () => {
    const t = await open("library");
    t.session.dispose();
    t.mount();
    expect(t.host.children.length).toBe(0);
  });
});

describe("ViewSession: freshness of moving reads", () => {
  async function mounted() {
    const t = await open("library");
    t.session.start();
    t.mount();
    await vi.waitFor(() => expect(t.session.statusOf("documents")).toBe("ready"));
    const head = (
      t.session as unknown as {
        handle: { head(): { experienceId: string; versionHash: string; compile?: string } };
      }
    ).handle.head();
    const stamp = (extra: object = {}) => ({
      experienceId: head.experienceId,
      versionHash: head.versionHash,
      ...(head.compile !== undefined && { compile: head.compile }),
      ...extra,
    });
    return { t, stamp };
  }
  it("a moving read is fresh when only the data moved; an ordinary action is not", async () => {
    const { t, stamp } = await mounted();
    const moved = stamp({ binding: { seq: 99999 } });
    expect(t.session.isFresh({ type: "LOAD_OLDER", widgetId: "chat", viewedVersion: moved })).toBe(
      true,
    );
    expect(t.session.isFresh({ type: "SELECT", widgetId: "filter", viewedVersion: moved })).toBe(
      false,
    );
  });
  it("a moving read is refused when the composition changed or the stamp is missing", async () => {
    const { t, stamp } = await mounted();
    expect(
      t.session.isFresh({
        type: "LOAD_OLDER",
        widgetId: "chat",
        viewedVersion: stamp({ versionHash: "sha256:old" }),
      }),
    ).toBe(false);
    expect(t.session.isFresh({ type: "LOAD_OLDER", widgetId: "chat" })).toBe(false);
    expect(
      t.session.isFresh({
        type: "EDIT_TURN",
        widgetId: "chat",
        viewedVersion: stamp({ compile: "x" }),
      }),
    ).toBe(false);
  });
});
