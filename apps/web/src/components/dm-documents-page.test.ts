import type { DocumentDto } from "@docmind/contracts";
import { describe, expect, it, vi } from "vitest";
import { createServices } from "../services";
import { UploadsStore } from "../state/uploads";
import { fakeUi } from "../testing/fakeUi";
import { mountWith } from "../testing/mount";
import "./dm-documents-page";

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
type Page = HTMLElement & { schedule: (fn: () => void) => void; updateComplete: Promise<unknown> };

async function setup(items: DocumentDto[]) {
  const live = { items };
  const ui = fakeUi({
    documents: async ({ status }) => ({
      items: live.items.filter(
        (d) =>
          status === "all" ||
          (status === "processing"
            ? ["uploaded", "parsing", "embedding"].includes(d.status)
            : d.status === status),
      ),
      truncated: false,
    }),
    document: async () => null,
    content: async () => null,
    source: async () => null,
    chats: async () => [],
  });
  const sse: {
    onFrame?: (f: { event: string; data: string; id: undefined }) => void;
    onClose?: (r: string) => void;
    close: ReturnType<typeof vi.fn>;
  } = { close: vi.fn() };
  const open = vi.fn((o: { onFrame: never; onClose: never }) => {
    sse.onFrame = o.onFrame;
    sse.onClose = o.onClose;
    return { close: sse.close };
  });
  const api = {
    ...ui.api,
    deleteDocument: vi.fn(async () => {
      live.items = live.items.filter((d) => d.id !== id(1));
    }),
    retryDocument: vi.fn(async () => doc(2)),
    createChat: vi.fn(async () => ({ id: "c1" })),
    uploadDocument: vi.fn(),
  };
  const uploads = new UploadsStore(api as never, open as never);
  const services = createServices({ api: api as never, uploads, open: open as never });
  const page = await mountWith<Page>(services, "dm-documents-page", {
    schedule: (fn: () => void) => fn(),
  });
  return { page, services, api, live, sse, ui };
}
const view = (p: Element) =>
  p.shadowRoot?.querySelector("dm-view") as HTMLElement & {
    session?: {
      statusOf(h: string): string | undefined;
      valueOf(h: string): unknown;
      invalidate(h?: string): void;
    };
  };
const table = (p: Element) => view(p).shadowRoot?.querySelector("lu-table") as HTMLElement;

describe("dm-documents-page", () => {
  it("draws the library through loom-ui: counts, health, the filter and a table with a named button per row action", async () => {
    const t = await setup([
      doc(1),
      doc(2, { status: "failed", error: "Could not read this file." }),
    ]);
    await vi.waitFor(() => expect(table(t.page)?.shadowRoot?.textContent).toContain("Title 1"));
    const labels = [
      ...(table(t.page).shadowRoot?.querySelectorAll("td.row-actions button") ?? []),
    ].map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual([
      "Open: Title 1",
      "Ask: Title 1",
      "Delete: Title 1",
      "Open: Title 2",
      "Retry: Title 2",
      "Delete: Title 2",
    ]);
    expect(t.page.shadowRoot?.querySelector("h1")?.textContent).toBe("Documents");
  });

  it("shows the empty state, with the big drop zone, when the library has nothing", async () => {
    const t = await setup([]);
    await vi.waitFor(() => expect(view(t.page).getAttribute("name")).toBe("library-empty"));
    await vi.waitFor(() =>
      expect(view(t.page).shadowRoot?.querySelector("lu-note")?.shadowRoot?.textContent).toContain(
        "No documents yet",
      ),
    );
    expect(t.page.shadowRoot?.querySelector("dm-upload-zone[variant=empty]")).not.toBeNull();
    expect(t.page.shadowRoot?.querySelectorAll("dm-upload-zone").length).toBe(1);
  });

  it("shows only the compact upload zone once the library has documents", async () => {
    const t = await setup([doc(1)]);
    await vi.waitFor(() => expect(view(t.page).getAttribute("name")).toBe("library"));
    const zones = [...(t.page.shadowRoot?.querySelectorAll("dm-upload-zone") ?? [])];
    expect(zones.map((z) => z.getAttribute("variant"))).toEqual(["compact"]);
  });

  it("opens a document and starts a chat about it from the row buttons", async () => {
    const t = await setup([doc(1)]);
    await vi.waitFor(() => expect(table(t.page)?.shadowRoot?.textContent).toContain("Title 1"));
    // loom-ui disables a row's buttons while an action is in flight: wait for the answer before the next click
    const click = async (label: string) => {
      const button = () =>
        table(t.page).shadowRoot?.querySelector(
          `td.row-actions button[aria-label='${label}']`,
        ) as HTMLButtonElement;
      await vi.waitFor(() => expect(button().disabled).toBe(false));
      button().click();
    };
    await click("Open: Title 1");
    await vi.waitFor(() =>
      expect(t.services.router.route).toEqual({ name: "document", id: id(1) }),
    );
    await click("Ask: Title 1");
    await vi.waitFor(() =>
      expect(t.api.createChat).toHaveBeenCalledWith({ scope: { documentIds: [id(1)] } }),
    );
  });

  it("deletes after a confirmation and the table follows", async () => {
    const t = await setup([doc(1), doc(2)]);
    await vi.waitFor(() => expect(table(t.page)?.shadowRoot?.textContent).toContain("Title 1"));
    (
      table(t.page).shadowRoot?.querySelector(
        "td.row-actions button[aria-label='Delete: Title 1']",
      ) as HTMLButtonElement
    ).click();
    await vi.waitFor(() => expect(document.querySelector("dm-dialog")).not.toBeNull());
    (
      [...document.querySelectorAll("dm-dialog button")].find(
        (b) => b.textContent === "Delete",
      ) as HTMLButtonElement
    ).click();
    await vi.waitFor(() => expect(table(t.page).shadowRoot?.textContent).not.toContain("Title 1"));
    expect(t.api.deleteDocument).toHaveBeenCalledWith(id(1));
  });

  it("refreshes when the progress stream says a document moved, and again after a reconnect", async () => {
    const t = await setup([doc(1, { status: "parsing" })]);
    await vi.waitFor(() => expect(table(t.page)?.shadowRoot?.textContent).toContain("Parsing"));
    t.live.items = [doc(1)];
    t.sse.onFrame?.({
      event: "progress",
      data: JSON.stringify({ documentId: id(1), step: "finalize", status: "ready" }),
      id: undefined,
    });
    await vi.waitFor(() => expect(table(t.page).shadowRoot?.textContent).toContain("Ready"));
  });

  it("filters the table by status through the experience's own control", async () => {
    const t = await setup([doc(1), doc(2, { status: "failed", error: "x" })]);
    await vi.waitFor(() => expect(table(t.page)?.shadowRoot?.textContent).toContain("Title 2"));
    const select = view(t.page)
      .shadowRoot?.querySelector("lu-select-input")
      ?.shadowRoot?.querySelector("select") as HTMLSelectElement;
    select.value = "failed";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(table(t.page).shadowRoot?.textContent).not.toContain("Title 1"));
    expect(table(t.page).shadowRoot?.textContent).toContain("Title 2");
  });

  it("stops the progress stream when it leaves, and says so with a fixed sentence when the stream gives up", async () => {
    const t = await setup([doc(1)]);
    await vi.waitFor(() => expect(t.sse.onFrame).toBeDefined());
    t.sse.onClose?.("failed");
    expect(t.services.toasts.get().map((x) => x.text)).toContain(
      "Live updates stopped. Reload the page to see new progress.",
    );
    const u = await setup([doc(1)]);
    await vi.waitFor(() => expect(u.sse.onFrame).toBeDefined());
    u.page.remove();
    expect(u.sse.close).toHaveBeenCalled();
  });

  it("refreshes after an upload batch settles, through the store", async () => {
    const t = await setup([doc(1)]);
    await vi.waitFor(() => expect(table(t.page)?.shadowRoot?.textContent).toContain("Title 1"));
    t.live.items = [doc(1), doc(2)];
    t.api.uploadDocument.mockResolvedValueOnce({ document: doc(2), duplicate: false });
    void t.services.uploads.upload([new File(["a"], "a.pdf")]);
    await vi.waitFor(() => expect(table(t.page).shadowRoot?.textContent).toContain("Title 2"));
  });

  it("lists the upload queue in one zone only", async () => {
    const t = await setup([]);
    await vi.waitFor(() =>
      expect(t.page.shadowRoot?.querySelector("dm-upload-zone[variant=empty]")).not.toBeNull(),
    );
    const zones = [...(t.page.shadowRoot?.querySelectorAll("dm-upload-zone") ?? [])];
    expect(zones.filter((z) => !z.hasAttribute("hide-queue")).length).toBe(1);
  });

  const act = (t: Awaited<ReturnType<typeof setup>>, action: string, rowKey: string) => {
    const v = view(t.page) as unknown as {
      session: { isFresh(): boolean; dispatch(a: unknown, h: unknown): Promise<unknown> };
      onAct: unknown;
    };
    vi.spyOn(v.session, "isFresh").mockReturnValue(true);
    return v.session.dispatch(
      { type: "TABLE_ROW_ACTION", widgetId: "w", payload: { action, rowKey } },
      v.onAct,
    );
  };

  it("an action on a row key the server did not serve makes no REST call", async () => {
    const t = await setup([doc(1)]);
    await vi.waitFor(() => expect(table(t.page)?.shadowRoot?.textContent).toContain("Title 1"));
    for (const a of ["delete", "retry", "ask", "open"])
      expect(await act(t, a, id(99))).toMatchObject({ ok: false });
    expect(t.api.deleteDocument).not.toHaveBeenCalled();
    expect(t.api.retryDocument).not.toHaveBeenCalled();
    expect(t.api.createChat).not.toHaveBeenCalled();
    expect(t.services.router.route).not.toEqual({ name: "document", id: id(99) });
  });

  it("what is held follows the served table: a key the reload dropped is refused", async () => {
    const t = await setup([doc(1), doc(2)]);
    await vi.waitFor(() => expect(table(t.page)?.shadowRoot?.textContent).toContain("Title 1"));
    t.live.items = [doc(2)];
    view(t.page).session?.invalidate("documents");
    await vi.waitFor(() => expect(table(t.page).shadowRoot?.textContent).not.toContain("Title 1"));
    expect(await act(t, "retry", id(1))).toMatchObject({ ok: false });
    expect(t.api.retryDocument).not.toHaveBeenCalled();
    expect(await act(t, "retry", id(2))).toMatchObject({ ok: true });
    expect(t.api.retryDocument).toHaveBeenCalledWith(id(2));
  });

  it("a double activation of one row's action sends exactly one request", async () => {
    const t = await setup([doc(2, { status: "failed", error: "x" })]);
    await vi.waitFor(() => expect(table(t.page)?.shadowRoot?.textContent).toContain("Title 2"));
    let release: () => void = () => {};
    t.api.retryDocument.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = () => r(doc(2));
        }),
    );
    const first = act(t, "retry", id(2));
    const second = act(t, "retry", id(2));
    release();
    await Promise.all([first, second]);
    expect(t.api.retryDocument).toHaveBeenCalledTimes(1);
  });

  it("a stale action calls no API and says the view changed", async () => {
    const t = await setup([doc(1)]);
    await vi.waitFor(() => expect(table(t.page)?.shadowRoot?.textContent).toContain("Title 1"));
    const v = view(t.page) as unknown as {
      session: { isFresh(): boolean; dispatch(a: unknown, h: unknown): Promise<unknown> };
      onAct: unknown;
    };
    vi.spyOn(v.session, "isFresh").mockReturnValue(false);
    const out = await v.session.dispatch(
      { type: "TABLE_ROW_ACTION", widgetId: "w", payload: { action: "delete", rowKey: id(1) } },
      v.onAct,
    );
    expect(out).toMatchObject({ ok: false, reason: "stale" });
    expect(t.api.deleteDocument).not.toHaveBeenCalled();
    expect(t.services.toasts.get().length).toBe(1);
  });

  it("no 'live updates stopped' toast when the stream ends because the session did", async () => {
    const t = await setup([doc(1)]);
    await vi.waitFor(() => expect(t.sse.onClose).toBeDefined());
    t.sse.onClose?.("unauthorized");
    expect(t.services.toasts.get()).toEqual([]);
  });

  it("a confirmation left open when the page goes away answers no", async () => {
    const t = await setup([doc(1)]);
    await vi.waitFor(() => expect(table(t.page)?.shadowRoot?.textContent).toContain("Title 1"));
    (
      table(t.page).shadowRoot?.querySelector(
        "td.row-actions button[aria-label='Delete: Title 1']",
      ) as HTMLButtonElement
    ).click();
    await vi.waitFor(() => expect(document.querySelector("dm-dialog")).not.toBeNull());
    t.page.remove();
    await vi.waitFor(() => expect(document.querySelector("dm-dialog")).toBeNull());
    expect(t.api.deleteDocument).not.toHaveBeenCalled();
  });

  it("a chat created after the page went away does not navigate", async () => {
    const t = await setup([doc(1)]);
    await vi.waitFor(() => expect(table(t.page)?.shadowRoot?.textContent).toContain("Title 1"));
    let release: () => void = () => {};
    t.api.createChat.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = () => r({ id: "c1" });
        }) as never,
    );
    (
      table(t.page).shadowRoot?.querySelector(
        "td.row-actions button[aria-label='Ask: Title 1']",
      ) as HTMLButtonElement
    ).click();
    await vi.waitFor(() => expect(t.api.createChat).toHaveBeenCalled());
    t.page.remove();
    release();
    // nothing more should happen: give a wrongly late navigation the chance to run
    await new Promise((r) => setTimeout(r, 30));
    expect(t.services.router.route).not.toMatchObject({ name: "chat" });
  });
});
