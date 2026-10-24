import type { DocumentDto, DocumentPassage } from "@docmind/contracts";
import type { UiReaders } from "@docmind/experiences";
import { describe, expect, it, vi } from "vitest";
import { Router } from "../router";
import { createServices } from "../services";
import { UploadsStore } from "../state/uploads";
import { fakeUi } from "../testing/fakeUi";
import { mountWith } from "../testing/mount";
import "./dm-doc-detail";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const summary = {
  tldr: "Payment is due in 30 days.",
  keyPoints: ["Net 30"],
  entities: ["Acme"],
  topics: ["Payment"],
  suggestedQuestions: ["When is it due?", "Who signs?"],
};
const stats = {
  wordCount: 900,
  pageCount: 3,
  readingTimeMinutes: 4,
  language: "en",
  outline: ["Terms"],
  dates: ["2026-01-01"],
  numbers: ["30"],
};
const mine: DocumentDto = {
  id: id(1),
  title: "Contract",
  filename: "c.pdf",
  mime: "application/pdf",
  sizeBytes: 100,
  status: "ready",
  error: null,
  stats,
  summary,
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:00:00.000Z",
};
const passages: DocumentPassage[] = Array.from({ length: 45 }, (_, i) => ({
  passageId: id(100 + i),
  ordinal: i,
  locator: { kind: "page", page: i + 1 },
  headingPath: ["Terms"],
  text: `passage ${i}`,
}));

/** Text of an element and of every shadow root below it (the A2UI widgets nest several). */
function deepText(root: Node | null | undefined): string {
  if (!root) return "";
  let out = root.nodeType === Node.TEXT_NODE ? (root.textContent ?? "") : "";
  const el = root as Element;
  if (el.shadowRoot) out += deepText(el.shadowRoot);
  for (const c of Array.from(root.childNodes)) out += ` ${deepText(c)}`;
  return out;
}
function deepAll(root: Node | null | undefined, sel: string): Element[] {
  if (!root) return [];
  const found: Element[] = [];
  const walk = (n: Node) => {
    const el = n as Element;
    if (el.shadowRoot) {
      found.push(...Array.from(el.shadowRoot.querySelectorAll(sel)));
      for (const c of Array.from(el.shadowRoot.children)) walk(c);
    }
    for (const c of Array.from(n.childNodes)) walk(c);
  };
  if ((root as Element).querySelectorAll)
    found.push(...Array.from((root as Element).querySelectorAll(sel)));
  walk(root);
  return found;
}

function setup(
  route: { name: "document"; id: string; passage?: string },
  doc: DocumentDto | null = mine,
  readers: Partial<UiReaders> = {},
) {
  const content = vi.fn(async (a: { id: string; upto: number }) =>
    doc ? { items: passages.slice(0, a.upto), more: a.upto < passages.length } : null,
  );
  const live = { doc, fail: false };
  const ui = fakeUi({
    documents: async () => ({ items: [], truncated: false }),
    document: async (a) => {
      if (live.fail) throw new Error("down");
      return live.doc && a.id === live.doc.id ? live.doc : null;
    },
    content,
    source: async () => null,
    chats: async () => [],
    ...readers,
  });
  const win = {
    location: { pathname: `/documents/${route.id}`, search: "" },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
    removeEventListener() {},
  };
  const router = new Router(win as never);
  router.set(route);
  const api = {
    ...ui.api,
    createChat: vi.fn(async () => ({ id: "c1" })),
    deleteDocument: vi.fn(async () => {}),
    retryDocument: vi.fn(async () => ({})),
  };
  const sse: {
    onFrame?: (f: { event: string; data: string; id: undefined }) => void;
    close: ReturnType<typeof vi.fn>;
  } = { close: vi.fn() };
  const open = vi.fn((o: { onFrame: never }) => {
    sse.onFrame = o.onFrame;
    return { close: sse.close };
  });
  const uploads = new UploadsStore(api as never, open as never);
  const services = createServices({ api: api as never, router, uploads, open: open as never });
  const progress = (documentId: string, status: string) =>
    sse.onFrame?.({
      event: "progress",
      data: JSON.stringify({ documentId, step: "finalize", status }),
      id: undefined,
    });
  return {
    sse,
    progress,
    services,
    api,
    content,
    ui,
    live,
    mount: () => mountWith<HTMLElement>(services, "dm-doc-detail"),
  };
}
type Session = {
  isFresh(): boolean;
  dispatch(a: unknown, h: unknown): Promise<unknown>;
  setParams(p: object, h: string): void;
  statusOf(h: string): string | undefined;
};
const view = (p: Element) =>
  p.shadowRoot?.querySelector("dm-view") as HTMLElement & { session?: Session; onAct: unknown };
const tabs = (p: Element) => [...(view(p).shadowRoot?.querySelectorAll("[role=tab]") ?? [])];
const questionButtons = (p: Element) =>
  deepAll(view(p), "button").filter((b) => (b.textContent ?? "").includes("?"));

describe("dm-doc-detail", () => {
  it("draws the document as tabs: status above, summary, analysis and content below", async () => {
    const t = setup({ name: "document", id: id(1) });
    const page = await t.mount();
    await vi.waitFor(() => expect(deepText(view(page))).toContain("Ready"));
    expect(tabs(page).map((b) => b.textContent?.trim())).toEqual([
      "Summary",
      "Analysis",
      "Content",
    ]);
    await vi.waitFor(() => expect(deepText(view(page))).toContain("Payment is due in 30 days."));
  });

  it("uses only icons that exist and no nested main or style bindings", async () => {
    const t = setup({ name: "document", id: id(1) });
    const page = await t.mount();
    const names = [...(page.shadowRoot?.querySelectorAll("dm-icon") ?? [])].map((i) =>
      i.getAttribute("name"),
    );
    expect(names).toEqual(["caret-left", "chat-circle-text"]);
    expect(page.shadowRoot?.querySelector("main")).toBeNull();
  });

  it("a suggested question opens a chat scoped to this document, with no question in the address", async () => {
    const t = setup({ name: "document", id: id(1) });
    const page = await t.mount();
    await vi.waitFor(() => expect(questionButtons(page).length).toBeGreaterThan(0));
    (questionButtons(page)[0] as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(t.api.createChat).toHaveBeenCalledWith({ scope: { documentIds: [id(1)] } }),
    );
    await vi.waitFor(() => expect(t.services.router.route).toEqual({ name: "chat", chatId: "c1" }));
  });

  it("shows more passages with the button in the content tab", async () => {
    const t = setup({ name: "document", id: id(1) });
    const page = await t.mount();
    await vi.waitFor(() => expect(t.content).toHaveBeenCalled());
    expect(t.content.mock.calls[0]?.[0]).toMatchObject({ upto: 20 });
    await vi.waitFor(() => expect(view(page).session?.statusOf("doc-content")).toBe("ready"));
    view(page).session?.setParams({ upto: 40 }, "doc-content");
    await vi.waitFor(() =>
      expect(t.content).toHaveBeenLastCalledWith(expect.objectContaining({ upto: 40 })),
    );
  });

  it("the show-more button raises the page size by 20", async () => {
    const t = setup({ name: "document", id: id(1) });
    const page = await t.mount();
    await vi.waitFor(() => expect(view(page).session?.statusOf("doc-content")).toBe("ready"));
    await vi.waitFor(() =>
      expect(
        deepAll(view(page), "button").some((b) => (b.textContent ?? "").includes("more passages")),
      ).toBe(true),
    );
    (
      deepAll(view(page), "button").find((b) =>
        (b.textContent ?? "").includes("more passages"),
      ) as HTMLButtonElement
    ).click();
    await vi.waitFor(() =>
      expect(t.content).toHaveBeenLastCalledWith(expect.objectContaining({ upto: 40 })),
    );
  });

  it("opens on the Content tab with the cited passage first when the route names a passage", async () => {
    const t = setup({ name: "document", id: id(1), passage: id(130) });
    const page = await t.mount();
    await vi.waitFor(() =>
      expect(t.content).toHaveBeenCalledWith(expect.objectContaining({ passage: id(130) })),
    );
    await vi.waitFor(() =>
      expect(
        view(page).shadowRoot?.querySelector("[role=tab][aria-selected=true]")?.textContent?.trim(),
      ).toBe("Content"),
    );
  });

  it("says the document was not found, the same way for a missing and a foreign one, and shows no tabs", async () => {
    const t = setup({ name: "document", id: id(9) }, null);
    const page = await t.mount();
    await vi.waitFor(() =>
      expect(page.shadowRoot?.querySelector("[data-not-found]")?.textContent).toContain(
        "Document not found.",
      ),
    );
    expect(page.shadowRoot?.querySelector("dm-view")).toBeNull();
    expect(page.shadowRoot?.querySelector("button[data-delete]")).toBeNull();
  });

  it("deletes the open document after a confirmation and returns to the library", async () => {
    const t = setup({ name: "document", id: id(1) });
    const page = await t.mount();
    await vi.waitFor(() => expect(view(page).session?.statusOf("doc-status")).toBe("ready"));
    (page.shadowRoot?.querySelector("button[data-delete]") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector("dm-dialog")).not.toBeNull());
    (
      [...document.querySelectorAll("dm-dialog button")].find(
        (b) => b.textContent === "Delete",
      ) as HTMLButtonElement
    ).click();
    await vi.waitFor(() => expect(t.api.deleteDocument).toHaveBeenCalledWith(id(1)));
    await vi.waitFor(() => expect(t.services.router.route).toEqual({ name: "documents" }));
  });

  it("a delete confirmation left open when the page goes away answers no", async () => {
    const t = setup({ name: "document", id: id(1) });
    const page = await t.mount();
    await vi.waitFor(() => expect(view(page).session?.statusOf("doc-status")).toBe("ready"));
    (page.shadowRoot?.querySelector("button[data-delete]") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector("dm-dialog")).not.toBeNull());
    page.remove();
    await vi.waitFor(() => expect(document.querySelector("dm-dialog")).toBeNull());
    expect(t.api.deleteDocument).not.toHaveBeenCalled();
    expect(t.services.router.route).toEqual({ name: "document", id: id(1) });
  });

  it("a failed document offers Retry, which retries it", async () => {
    const t = setup(
      { name: "document", id: id(1) },
      { ...mine, status: "failed", error: "Could not read this file.", summary: null, stats: null },
    );
    const page = await t.mount();
    await vi.waitFor(() =>
      expect(page.shadowRoot?.querySelector("button[data-retry]")).not.toBeNull(),
    );
    (page.shadowRoot?.querySelector("button[data-retry]") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(t.api.retryDocument).toHaveBeenCalledWith(id(1)));
  });

  const act = (page: Element, payload: unknown, type = "A2UI_ACTION") => {
    const v = view(page);
    vi.spyOn(v.session as Session, "isFresh").mockReturnValue(true);
    return (v.session as Session).dispatch({ type, widgetId: "w", payload }, v.onAct);
  };

  it("a question the server did not serve makes no REST call", async () => {
    const t = setup({ name: "document", id: id(1) });
    const page = await t.mount();
    await vi.waitFor(() => expect(questionButtons(page).length).toBeGreaterThan(0));
    expect(await act(page, { action: "ask-question", context: { index: 7 } })).toMatchObject({
      ok: false,
    });
    expect(await act(page, { action: "nope" })).toMatchObject({ ok: false });
    expect(t.api.createChat).not.toHaveBeenCalled();
    // the question is the served one at the index, never the payload's own text
    expect(
      await act(page, { action: "ask-question", context: { index: 0, question: "Evil?" } }),
    ).toMatchObject({ ok: true });
    expect(t.api.createChat).toHaveBeenCalledTimes(1);
  });

  it("nothing is held until the document was served: an action before that makes no call", async () => {
    const t = setup({ name: "document", id: id(9) }, null);
    const page = await t.mount();
    await vi.waitFor(() =>
      expect(page.shadowRoot?.querySelector("[data-not-found]")).not.toBeNull(),
    );
    expect(t.api.createChat).not.toHaveBeenCalled();
  });

  it("a double activation of a question sends exactly one request", async () => {
    const t = setup({ name: "document", id: id(1) });
    const page = await t.mount();
    await vi.waitFor(() => expect(questionButtons(page).length).toBeGreaterThan(0));
    let release: () => void = () => {};
    t.api.createChat.mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = () => r({ id: "c1" });
        }),
    );
    const first = act(page, { action: "ask-question", context: { index: 0 } });
    const second = act(page, { action: "ask-question", context: { index: 0 } });
    release();
    await Promise.all([first, second]);
    expect(t.api.createChat).toHaveBeenCalledTimes(1);
  });

  it("a stale action calls no API and says the view changed", async () => {
    const t = setup({ name: "document", id: id(1) });
    const page = await t.mount();
    await vi.waitFor(() => expect(questionButtons(page).length).toBeGreaterThan(0));
    const v = view(page);
    vi.spyOn(v.session as Session, "isFresh").mockReturnValue(false);
    const out = await (v.session as Session).dispatch(
      {
        type: "A2UI_ACTION",
        widgetId: "w",
        payload: { action: "ask-question", context: { index: 0 } },
      },
      v.onAct,
    );
    expect(out).toMatchObject({ ok: false, reason: "stale" });
    expect(t.api.createChat).not.toHaveBeenCalled();
    expect(t.services.toasts.get().length).toBe(1);
  });

  it("a missing document says not found and offers Try again, which mounts the view again", async () => {
    const t = setup({ name: "document", id: id(1) }, null);
    const page = await t.mount();
    await vi.waitFor(() =>
      expect(page.shadowRoot?.querySelector("[data-not-found]")).not.toBeNull(),
    );
    t.live.doc = mine;
    (page.shadowRoot?.querySelector("button[data-try-again]") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(tabs(page).length).toBe(3));
    expect(page.shadowRoot?.querySelector("[data-not-found]")).toBeNull();
  });

  it("a read that fails after the page was served is a load problem with Try again, never not found", async () => {
    const t = setup({ name: "document", id: id(1) });
    const page = await t.mount();
    await vi.waitFor(() => expect(view(page).session?.statusOf("doc-status")).toBe("ready"));
    t.live.fail = true;
    (view(page).session as unknown as { invalidate(h?: string): void }).invalidate();
    await vi.waitFor(() =>
      expect(page.shadowRoot?.querySelector("[data-load-failed]")?.textContent).toContain(
        "Couldn't load this document.",
      ),
    );
    expect(page.shadowRoot?.textContent).not.toContain("Document not found.");
    t.live.fail = false;
    (page.shadowRoot?.querySelector("button[data-try-again]") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(tabs(page).length).toBe(3));
  });

  it("Retry is absent for a ready document, and the header buttons wait until the document is served", async () => {
    const t = setup({ name: "document", id: id(1) });
    const page = await t.mount();
    const ask = () => page.shadowRoot?.querySelector("button[data-ask]") as HTMLButtonElement;
    expect(ask().disabled).toBe(true);
    expect(
      (page.shadowRoot?.querySelector("button[data-delete]") as HTMLButtonElement).disabled,
    ).toBe(true);
    await vi.waitFor(() => expect(ask().disabled).toBe(false));
    expect(page.shadowRoot?.querySelector("button[data-retry]")).toBeNull();
  });

  it("a passage the served content does not hold is harmless: the Content tab opens, nothing fails", async () => {
    const t = setup({ name: "document", id: id(1), passage: id(999) });
    const page = await t.mount();
    await vi.waitFor(() =>
      expect(
        view(page).shadowRoot?.querySelector("[role=tab][aria-selected=true]")?.textContent?.trim(),
      ).toBe("Content"),
    );
    expect(t.services.toasts.get()).toEqual([]);
  });

  it("a delete that finishes after the user went elsewhere does not move the route", async () => {
    const t = setup({ name: "document", id: id(1) });
    const page = await t.mount();
    await vi.waitFor(() => expect(view(page).session?.statusOf("doc-status")).toBe("ready"));
    let release: () => void = () => {};
    t.api.deleteDocument.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          release = () => r();
        }),
    );
    (page.shadowRoot?.querySelector("button[data-delete]") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(document.querySelector("dm-dialog")).not.toBeNull());
    (
      [...document.querySelectorAll("dm-dialog button")].find(
        (b) => b.textContent === "Delete",
      ) as HTMLButtonElement
    ).click();
    await vi.waitFor(() => expect(t.api.deleteDocument).toHaveBeenCalled());
    t.services.router.navigate({ name: "settings" });
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(t.services.router.route).toEqual({ name: "settings" });
  });

  it("a processing document turns Ready when the progress stream says so, and the stream stops when the page leaves", async () => {
    const t = setup({ name: "document", id: id(1) }, { ...mine, status: "parsing" });
    const page = await t.mount();
    await vi.waitFor(() => expect(deepText(view(page))).toContain("Parsing"));
    t.live.doc = mine;
    t.progress(id(2), "ready"); // another document: no refresh
    t.progress(id(1), "ready");
    await vi.waitFor(() => expect(deepText(view(page))).toContain("Ready"));
    page.remove();
    expect(t.sse.close).toHaveBeenCalled();
  });
});

describe("dm-doc-detail: rendered content", () => {
  const host = (page: HTMLElement, wid: string) =>
    page.shadowRoot
      ?.querySelector("dm-view")
      ?.shadowRoot?.querySelector(`[data-widget-id="${wid}"]`) as HTMLElement | null;

  it("shows Prose and hides the passage list for a markdown document", async () => {
    const t = setup({ name: "document", id: id(1) }, undefined, {
      source: async () => ({
        applicable: true,
        format: "md",
        text: "# Heading\n\n| a |\n|---|\n| 1 |",
        truncated: false,
      }),
    });
    const page = await t.mount();
    await vi.waitFor(() => expect(host(page, "content-prose")?.hidden).toBe(false));
    expect(host(page, "content-view")?.hidden).toBe(true);
    expect(deepText(page)).toContain("Heading");
  });

  it("keeps the passage list for a format it does not render", async () => {
    const t = setup({ name: "document", id: id(1) }, undefined, {
      source: async () => ({ applicable: false }),
    });
    const page = await t.mount();
    await vi.waitFor(() => expect(host(page, "content-view")?.hidden).toBe(false));
    expect(host(page, "content-prose")?.hidden).toBe(true);
  });

  it("passes the cited passage to the source reader", async () => {
    const source = vi.fn(async (_a: { id: string; passage?: string }) => ({
      applicable: true as const,
      format: "md" as const,
      text: "# a\n\nb",
      truncated: false,
      focus: { from: 5, to: 6 },
    }));
    const t = setup({ name: "document", id: id(1), passage: id(130) }, undefined, { source });
    await t.mount();
    await vi.waitFor(() =>
      expect(source).toHaveBeenCalledWith(expect.objectContaining({ passage: id(130) })),
    );
  });
});
