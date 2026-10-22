import type { ChatMessageDto } from "@docmind/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/http";
import type { SseOptions } from "../api/sse";
import { Router } from "../router";
import { createServices } from "../services";
import { type ChatViewState, LIMITED_TEXT } from "../state/chat";
import { Store } from "../state/store";
import { fakeUi } from "../testing/fakeUi";
import { mountWith } from "../testing/mount";
import "./dm-chat-page";

const CHAT = "0b4f7d52-6c53-4c6e-9d49-2b0e7a3f9a10";
const DOC = "7f6d1b8e-3b0a-4a56-8f2f-0a8e0f7c4d11";
const DOC2 = "00000000-0000-4000-8000-0000000000d2";
const PASSAGE = "c0ffee00-0000-4000-8000-000000000001";
const KEY = "k".repeat(24);
const msg = (
  ord: number,
  role: "user" | "assistant",
  turn: number,
  over: Partial<ChatMessageDto> = {},
): ChatMessageDto => ({
  id: String(ord),
  turn,
  role,
  text: `${role} ${ord}`,
  status: "complete",
  citations: [],
  cursor: `1.${ord * 10}`,
  reasoning: null,
  steps: [],
  outcome: null,
  createdAt: "2026-10-21T10:00:00.000Z",
  ...over,
});
const cited = {
  passageId: PASSAGE,
  documentId: DOC,
  docTitle: "Contract",
  locator: { kind: "page" as const, page: 2 },
  snippet: "Net 30",
};

type Page = HTMLElement & {
  controller?: {
    state: Store<ChatViewState>;
    close(): void;
    loadOlder(): Promise<void>;
    toggleSources(open?: boolean): void;
  };
};
type Session = {
  isFresh(a?: unknown): boolean;
  dispatch(a: unknown, h: unknown): Promise<unknown>;
};

function setup(path = `/chats/${CHAT}`, over: Record<string, unknown> = {}) {
  const ui = fakeUi();
  const sse: { opts?: SseOptions } = {};
  const close = vi.fn();
  const open = vi.fn((opts: SseOptions) => {
    sse.opts = opts;
    return { close };
  });
  const api = {
    ...ui.api,
    listMessages: vi.fn(async () => ({
      items: [
        msg(1, "user", 1),
        msg(2, "assistant", 1, {
          text: `Due in 30 days [[${PASSAGE}]].`,
          citations: [cited],
          steps: [{ name: "search_docs", label: "Searched documents", count: 8 }],
        }),
      ],
      nextCursor: null,
    })),
    sendMessage: vi.fn(async () => ({ messageId: "m" })),
    stopChat: vi.fn(async () => ({ stopped: true })),
    getChat: vi.fn(async () => ({
      id: CHAT,
      title: null,
      scope: { documentIds: [DOC] },
      createdAt: "2026-10-21T10:00:00.000Z",
      lastMessageAt: null,
      messageCount: 2,
    })),
    listDocuments: vi.fn(async () => ({
      items: [
        { id: DOC, title: "Contract", status: "ready" },
        { id: DOC2, title: "Invoice", status: "ready" },
      ],
      nextCursor: null,
    })),
    getDocument: vi.fn(async () => {
      throw new ApiError(404, "not_found");
    }),
    createChat: vi.fn(async () => ({ id: CHAT })),
    patchChat: vi.fn(async () => ({})),
    ...over,
  };
  const win = {
    location: { pathname: path, search: "" },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
    removeEventListener() {},
  };
  const services = createServices({
    api: api as never,
    router: new Router(win as never),
    open: open as never,
    outbox: new Store<{ chatId: string; text: string } | undefined>(undefined) as never,
  });
  const frame = (event: string, data: unknown) =>
    sse.opts?.onFrame({ event, data: JSON.stringify(data), id: undefined });
  return {
    services,
    api,
    frame,
    close,
    mount: () => mountWith<Page>(services, "dm-chat-page"),
  };
}
const viewOf = (p: Element) =>
  p.shadowRoot?.querySelector("dm-view") as
    | (HTMLElement & { session?: Session; onAct?: unknown })
    | null;
const chatRoot = (p: Element) =>
  viewOf(p)?.shadowRoot?.querySelector("lu-chat")?.shadowRoot as ShadowRoot | undefined;
const chatText = (p: Element) => chatRoot(p)?.textContent?.replace(/\s+/g, " ") ?? "";
const composerHost = (p: Element) => viewOf(p)?.shadowRoot?.querySelector("lu-text-input");
const composer = (p: Element) => composerHost(p)?.shadowRoot as ShadowRoot | undefined;
const phase = (p: Element) => composer(p)?.querySelector("form")?.getAttribute("data-phase");
const picker = (p: Element) =>
  viewOf(p)?.shadowRoot?.querySelector("lu-multi-select-input")?.shadowRoot ?? null;
const chips = (p: Element) =>
  Array.from(picker(p)?.querySelectorAll("[data-chip]") ?? []).map((c) =>
    c.getAttribute("data-chip"),
  );
const addDoc = async (p: Element, id: string) => {
  await vi.waitFor(() => expect(picker(p)?.querySelector("[data-add]")).toBeTruthy());
  (picker(p)?.querySelector("[data-add]") as HTMLButtonElement).click();
  await vi.waitFor(() => expect(picker(p)?.querySelector(`[data-option="${id}"]`)).toBeTruthy());
  picker(p)
    ?.querySelector(`[data-option="${id}"]`)
    ?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
};
const removeDoc = (p: Element, id: string) =>
  (picker(p)?.querySelector(`[data-chip="${id}"] button`) as HTMLButtonElement).click();
const toastTexts = (t: { services: { toasts: { get(): { text: string }[] } } }) =>
  t.services.toasts.get().map((x) => x.text);
function typeAndSend(p: Element, text: string) {
  const root = composer(p) as ShadowRoot;
  const input = root.querySelector("textarea,input") as HTMLTextAreaElement;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  root
    .querySelector("form")
    ?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
}
const button = (p: Element, sel: string) =>
  p.shadowRoot?.querySelector(sel) as HTMLButtonElement | null;
const loaded = (p: Element) => vi.waitFor(() => expect(chatText(p)).toContain("Due in 30 days"));
/** An action as the widget would raise it, through the view session (so the staleness check runs). */
const raise = (p: Element, type: string, payload: Record<string, unknown>) => {
  const v = viewOf(p) as NonNullable<ReturnType<typeof viewOf>>;
  return (v.session as Session).dispatch({ type, widgetId: "w", payload }, v.onAct);
};

describe("dm-chat-page: a chat", () => {
  it("loads the history into the transcript, with the tool line, and the citation as a numbered button", async () => {
    const t = setup();
    const page = await t.mount();
    await loaded(page);
    expect(chatText(page)).toContain("Searched documents (8)");
    expect(chatText(page)).not.toContain("[[");
    await vi.waitFor(() =>
      expect(chatRoot(page)?.querySelector("button.ref")).toBeInstanceOf(HTMLButtonElement),
    );
    const ref = chatRoot(page)?.querySelector("button.ref") as HTMLButtonElement;
    expect(ref.getAttribute("aria-label")).toBe("Source 1");
  });

  it("sends a message from the composer and keeps the draft when the send fails (limited says so)", async () => {
    const t = setup();
    const page = await t.mount();
    await loaded(page);
    typeAndSend(page, "  When is it due?  ");
    await vi.waitFor(() =>
      expect(t.api.sendMessage).toHaveBeenCalledWith(
        CHAT,
        expect.objectContaining({ text: "When is it due?" }),
      ),
    );
    await vi.waitFor(() => expect(phase(page)).toBe("sent"));
    t.api.sendMessage.mockRejectedValueOnce(new ApiError(429, "too_many_requests"));
    typeAndSend(page, "again");
    await vi.waitFor(() =>
      expect(t.services.toasts.get().map((x) => x.text)).toContain(LIMITED_TEXT),
    );
    expect((composer(page)?.querySelector("textarea,input") as HTMLTextAreaElement).value).toBe(
      "again",
    );
  });

  it("shows Stop while a reply runs and stops it; Regenerate re-asks the last question", async () => {
    const t = setup();
    const page = await t.mount();
    await loaded(page);
    expect(button(page, "button[data-stop]")).toBeNull();
    await vi.waitFor(() => expect(button(page, "button[data-regenerate]")).not.toBeNull());
    button(page, "button[data-regenerate]")?.click();
    await vi.waitFor(() =>
      expect(t.api.sendMessage).toHaveBeenCalledWith(
        CHAT,
        expect.objectContaining({ text: "user 1", editOf: 1 }),
      ),
    );
    await vi.waitFor(() => expect(button(page, "button[data-stop]")).not.toBeNull());
    button(page, "button[data-stop]")?.click();
    await vi.waitFor(() => expect(t.api.stopChat).toHaveBeenCalledWith(CHAT));
  });

  it("streams: the thinking and the answer grow in the transcript, then the durable reply replaces them", async () => {
    const t = setup();
    const page = await t.mount();
    await loaded(page);
    t.frame("message", msg(3, "user", 2, { text: "Q2" }));
    t.frame("reasoning-partial", { turn: 2, text: "Thinking hard" });
    t.frame("answer", { turn: 2, text: "Half an ans" });
    await vi.waitFor(() => expect(chatText(page)).toContain("Half an ans"));
    t.frame("message", msg(4, "assistant", 2, { text: "Whole answer." }));
    await vi.waitFor(() => expect(chatText(page)).toContain("Whole answer."));
    expect(chatText(page)).not.toContain("Half an ans");
  });

  it("selecting a citation marker is routed to the controller", async () => {
    const t = setup();
    const page = await t.mount();
    await vi.waitFor(() =>
      expect(chatRoot(page)?.querySelector("button.ref")).toBeInstanceOf(HTMLButtonElement),
    );
    (chatRoot(page)?.querySelector("button.ref") as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(page.controller?.state.get().focus).toMatchObject({
        entryId: "t1.assistant",
        passageId: PASSAGE,
      }),
    );
  });

  it("refuses a forged citation: a ref the server did not serve selects nothing", async () => {
    const t = setup();
    const page = await t.mount();
    await vi.waitFor(() =>
      expect(chatRoot(page)?.querySelector("button.ref")).toBeInstanceOf(HTMLButtonElement),
    );
    const v = viewOf(page) as NonNullable<ReturnType<typeof viewOf>>;
    vi.spyOn(v.session as Session, "isFresh").mockReturnValue(true);
    const forged = await raise(page, "CHAT_REF_OPEN", {
      entryId: "t1.assistant",
      refId: "forged-ref",
    });
    expect(forged).toMatchObject({ ok: false });
    const other = await raise(page, "CHAT_REF_OPEN", { entryId: "t9.assistant", refId: PASSAGE });
    expect(other).toMatchObject({ ok: false });
    expect(page.controller?.state.get().focus).toBeUndefined();
  });

  it("a stale action calls no API and says the view changed", async () => {
    const t = setup();
    const page = await t.mount();
    await loaded(page);
    const v = viewOf(page) as NonNullable<ReturnType<typeof viewOf>>;
    vi.spyOn(v.session as Session, "isFresh").mockReturnValue(false);
    const out = await raise(page, "SUBMIT_TEXT", { text: "hello", key: KEY });
    expect(out).toMatchObject({ ok: false, reason: "stale" });
    expect(t.api.sendMessage).not.toHaveBeenCalled();
    expect(t.services.toasts.get().length).toBe(1);
  });

  it("a double send is one request, and the second is silent", async () => {
    let release: () => void = () => {};
    const t = setup(`/chats/${CHAT}`, {
      sendMessage: vi.fn(
        () =>
          new Promise((r) => {
            release = () => r({ messageId: "m" });
          }),
      ),
    });
    const page = await t.mount();
    await loaded(page);
    const v = viewOf(page) as NonNullable<ReturnType<typeof viewOf>>;
    vi.spyOn(v.session as Session, "isFresh").mockReturnValue(true);
    const first = raise(page, "SUBMIT_TEXT", { text: "hello", key: KEY });
    const second = raise(page, "SUBMIT_TEXT", { text: "hello", key: KEY });
    await expect(second).resolves.toMatchObject({ ok: false });
    release();
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(t.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(t.api.sendMessage).toHaveBeenCalledWith(
      CHAT,
      expect.objectContaining({ messageId: KEY }),
    );
    expect(t.services.toasts.get()).toEqual([]);
  });

  it("a send key the widget did not mint is refused", async () => {
    const t = setup();
    const page = await t.mount();
    await loaded(page);
    const v = viewOf(page) as NonNullable<ReturnType<typeof viewOf>>;
    vi.spyOn(v.session as Session, "isFresh").mockReturnValue(true);
    expect(await raise(page, "SUBMIT_TEXT", { text: "hello", key: "short" })).toMatchObject({
      ok: false,
    });
    expect(t.api.sendMessage).not.toHaveBeenCalled();
  });

  it("a send before the history is in is not sent and shows no error; the composer is disabled until then", async () => {
    let release: () => void = () => {};
    const t = setup(`/chats/${CHAT}`, {
      listMessages: vi.fn(
        () =>
          new Promise((r) => {
            release = () =>
              r({
                items: [msg(1, "user", 1), msg(2, "assistant", 1, { text: "Due in 30 days" })],
                nextCursor: null,
              });
          }),
      ),
    });
    const page = await t.mount();
    await vi.waitFor(() => expect(composerHost(page)).toBeTruthy());
    expect(composerHost(page)?.hasAttribute("inert")).toBe(true);
    const v = viewOf(page) as NonNullable<ReturnType<typeof viewOf>>;
    vi.spyOn(v.session as Session, "isFresh").mockReturnValue(true);
    const out = await raise(page, "SUBMIT_TEXT", { text: "early", key: KEY });
    expect(out).toMatchObject({ ok: false });
    expect(t.api.sendMessage).not.toHaveBeenCalled();
    expect(t.services.toasts.get()).toEqual([]);
    release();
    await vi.waitFor(() => expect(chatText(page)).toContain("Due in 30 days"));
    await vi.waitFor(() => expect(composerHost(page)?.hasAttribute("inert")).toBe(false));
  });

  it("shows the chat's documents as chips, and adds one: the PATCH carries the whole set", async () => {
    let scope: unknown = { documentIds: [DOC] };
    const t = setup(`/chats/${CHAT}`, {
      getChat: vi.fn(async () => ({
        id: CHAT,
        title: null,
        scope,
        createdAt: "2026-10-21T10:00:00.000Z",
        lastMessageAt: null,
        messageCount: 2,
      })),
      patchChat: vi.fn(async (_id: string, body: { scope: unknown }) => {
        scope = body.scope;
        return {};
      }),
    });
    const page = await t.mount();
    await vi.waitFor(() => expect(chips(page)).toEqual([DOC]));
    await addDoc(page, DOC2);
    await vi.waitFor(() =>
      expect(t.api.patchChat).toHaveBeenCalledWith(CHAT, { scope: { documentIds: [DOC, DOC2] } }),
    );
    await vi.waitFor(() => expect(chips(page)).toEqual([DOC, DOC2]));
    await loaded(page);
    typeAndSend(page, "next question");
    await vi.waitFor(() => expect(t.api.sendMessage).toHaveBeenCalled());
    await vi.waitFor(() => expect(phase(page)).toBe("sent"));
    expect(chips(page)).toEqual([DOC, DOC2]);
  });

  it("removing the last chip searches every document again, and never patches by itself", async () => {
    const t = setup();
    const page = await t.mount();
    await vi.waitFor(() => expect(chips(page)).toEqual([DOC]));
    expect(t.api.patchChat).not.toHaveBeenCalled();
    removeDoc(page, DOC);
    await vi.waitFor(() => expect(t.api.patchChat).toHaveBeenCalledWith(CHAT, { scope: "all" }));
    await vi.waitFor(() =>
      expect(picker(page)?.querySelector("[data-empty]")?.textContent).toBe("All documents"),
    );
  });

  it("a deleted document stays as a 'Removed document' chip and is dropped on the next save", async () => {
    const GONE = "00000000-0000-4000-8000-0000000000ee";
    const t = setup(`/chats/${CHAT}`, {
      getChat: vi.fn(async () => ({
        id: CHAT,
        title: null,
        scope: { documentIds: [GONE, DOC] },
        createdAt: "2026-10-21T10:00:00.000Z",
        lastMessageAt: null,
        messageCount: 2,
      })),
    });
    const page = await t.mount();
    await vi.waitFor(() =>
      expect(picker(page)?.querySelector(`[data-chip="${GONE}"]`)?.textContent).toContain(
        "Removed document",
      ),
    );
    await addDoc(page, DOC2);
    await vi.waitFor(() =>
      expect(t.api.patchChat).toHaveBeenCalledWith(CHAT, { scope: { documentIds: [DOC, DOC2] } }),
    );
  });

  it("a refused save keeps the chips and says so", async () => {
    const t = setup(`/chats/${CHAT}`, {
      patchChat: vi.fn(async () => {
        throw new ApiError(500, "boom");
      }),
    });
    const page = await t.mount();
    await vi.waitFor(() => expect(chips(page)).toEqual([DOC]));
    await addDoc(page, DOC2);
    await vi.waitFor(() =>
      expect(toastTexts(t)).toContain("Could not change where this chat searches."),
    );
    expect(chips(page)).toEqual([DOC]);
  });

  it("a new chat holds the choice itself and is created with it on the first send", async () => {
    const t = setup("/chats");
    const page = await t.mount();
    await vi.waitFor(() => expect(picker(page)?.querySelector("[data-empty]")).toBeTruthy());
    await addDoc(page, DOC2);
    await vi.waitFor(() => expect(chips(page)).toEqual([DOC2]));
    expect(t.api.patchChat).not.toHaveBeenCalled();
    typeAndSend(page, "first question");
    await vi.waitFor(() =>
      expect(t.api.createChat).toHaveBeenCalledWith({ scope: { documentIds: [DOC2] } }),
    );
  });

  it("draws the scope control after the transcript and before the composer", async () => {
    const t = setup();
    const page = await t.mount();
    await vi.waitFor(() => expect(chips(page)).toEqual([DOC]));
    const order = Array.from(
      viewOf(page)?.shadowRoot?.querySelectorAll("lu-chat, lu-multi-select-input, lu-text-input") ??
        [],
    ).map((e) => e.localName);
    expect(order.indexOf("lu-multi-select-input")).toBeGreaterThan(order.indexOf("lu-chat"));
    expect(order.indexOf("lu-text-input")).toBeGreaterThan(order.indexOf("lu-multi-select-input"));
    expect(page.shadowRoot?.querySelector("[data-scope]")).toBeNull(); // no web-only replacement
  });

  it("says so when the chat cannot be loaded or does not exist", async () => {
    const down = setup(`/chats/${CHAT}`, {
      listMessages: vi.fn(async () => {
        throw new ApiError(0, "network");
      }),
    });
    const a = await down.mount();
    await vi.waitFor(() =>
      expect(a.shadowRoot?.querySelector("[data-problem]")?.textContent).toContain(
        "Could not load this chat.",
      ),
    );
    const gone = setup(`/chats/${CHAT}`, {
      listMessages: vi.fn(async () => {
        throw new ApiError(404, "not_found");
      }),
    });
    const b = await gone.mount();
    await vi.waitFor(() =>
      expect(b.shadowRoot?.querySelector("[data-problem]")?.textContent).toContain(
        "This chat does not exist.",
      ),
    );
  });

  it("stops the stream and closes the controller when the page goes away", async () => {
    const t = setup();
    const page = await t.mount();
    await loaded(page);
    page.remove();
    expect(t.close).toHaveBeenCalled();
    expect(page.controller).toBeUndefined();
  });
});

describe("dm-chat-page: a new chat", () => {
  it("creates the chat on the first send, replaces the URL, and the new page sends the waiting message once", async () => {
    const t = setup("/chats");
    const page = await t.mount();
    await vi.waitFor(() => expect(composer(page)).toBeTruthy());
    typeAndSend(page, "First question");
    await vi.waitFor(() => expect(t.api.createChat).toHaveBeenCalledWith({ scope: "all" }));
    await vi.waitFor(() => expect(t.services.router.get()).toEqual({ name: "chat", chatId: CHAT }));
    await vi.waitFor(() =>
      expect(t.api.sendMessage).toHaveBeenCalledWith(
        CHAT,
        expect.objectContaining({ text: "First question" }),
      ),
    );
    expect(t.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(t.services.outbox.get()).toBeUndefined();
  });

  it("a double first send creates one chat", async () => {
    let release: () => void = () => {};
    const t = setup("/chats", {
      createChat: vi.fn(
        () =>
          new Promise((r) => {
            release = () => r({ id: CHAT });
          }),
      ),
    });
    const page = await t.mount();
    await vi.waitFor(() => expect(composer(page)).toBeTruthy());
    const v = viewOf(page) as NonNullable<ReturnType<typeof viewOf>>;
    vi.spyOn(v.session as Session, "isFresh").mockReturnValue(true);
    const a = raise(page, "SUBMIT_TEXT", { text: "Q", key: KEY });
    const b = raise(page, "SUBMIT_TEXT", { text: "Q", key: KEY });
    await expect(b).resolves.toMatchObject({ ok: false });
    release();
    await a;
    expect(t.api.createChat).toHaveBeenCalledTimes(1);
  });
});

const CHAT_B = "1c5e8e63-7d64-4d7f-8e5a-3c1f8b4a0b21";
const h1 = (p: Element) => p.shadowRoot?.querySelector("h1")?.textContent?.trim();

describe("dm-chat-page: the header, the loading and closed states", () => {
  it("shows the served title as text, New chat before one exists, and follows an auto-title", async () => {
    let title: string | null = null;
    const t = setup(`/chats/${CHAT}`, {
      getChat: vi.fn(async () => ({
        id: CHAT,
        title,
        scope: "all",
        createdAt: "2026-10-21T10:00:00.000Z",
        lastMessageAt: null,
        messageCount: 2,
      })),
    });
    const page = await t.mount();
    await loaded(page);
    await vi.waitFor(() => expect(t.api.getChat).toHaveBeenCalled());
    expect(h1(page)).toBe("New chat");
    title = "Lease review";
    typeAndSend(page, "next");
    await vi.waitFor(() => expect(h1(page)).toBe("Lease review"));
    expect(page.shadowRoot?.querySelector("h1")?.getAttribute("title")).toBe("Lease review");
  });

  it("says Loading conversation (announced) until the history is in, and keeps the composer inert across a re-render", async () => {
    let release: () => void = () => {};
    const t = setup(`/chats/${CHAT}`, {
      listMessages: vi.fn(
        () =>
          new Promise((r) => {
            release = () =>
              r({
                items: [msg(1, "user", 1), msg(2, "assistant", 1, { text: "Due in 30 days" })],
                nextCursor: null,
              });
          }),
      ),
    });
    const page = await t.mount();
    await vi.waitFor(() => expect(composerHost(page)).toBeTruthy());
    const hint = page.shadowRoot?.querySelector("[data-loading]");
    expect(hint?.textContent).toContain("Loading conversation");
    expect(hint?.getAttribute("aria-live")).toBe("polite");
    composerHost(page)?.removeAttribute("inert");
    const c = page.controller as NonNullable<Page["controller"]>;
    c.state.set({ ...c.state.get() });
    expect(composerHost(page)?.hasAttribute("inert")).toBe(true);
    release();
    await vi.waitFor(() => expect(page.shadowRoot?.querySelector("[data-loading]")).toBeNull());
  });

  it("a closed chat says so instead of leaving a silent composer", async () => {
    const t = setup();
    const page = await t.mount();
    await loaded(page);
    t.frame("closed", {});
    await vi.waitFor(() =>
      expect(page.shadowRoot?.querySelector("[data-closed]")?.textContent).toContain(
        "This chat has ended.",
      ),
    );
  });

  it("shows the older-failed line and retries loading earlier messages", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        items: [msg(3, "user", 2), msg(4, "assistant", 2, { text: "Newest" })],
        nextCursor: "1.5",
      })
      .mockRejectedValueOnce(new ApiError(0, "network"))
      .mockResolvedValueOnce({ items: [msg(1, "user", 1)], nextCursor: null });
    const t = setup(`/chats/${CHAT}`, { listMessages: list });
    const page = await t.mount();
    await vi.waitFor(() => expect(chatText(page)).toContain("Newest"));
    await page.controller?.loadOlder();
    await vi.waitFor(() =>
      expect(page.shadowRoot?.querySelector("[data-older-failed]")).not.toBeNull(),
    );
    (page.shadowRoot?.querySelector("[data-older-retry]") as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(page.shadowRoot?.querySelector("[data-older-failed]")).toBeNull(),
    );
    expect(list).toHaveBeenCalledTimes(3);
  });
});

describe("dm-chat-page: the queued first message", () => {
  it("is kept when the send fails, says so, and Retry sends it and clears it", async () => {
    const t = setup("/chats", {
      sendMessage: vi
        .fn()
        .mockRejectedValueOnce(new ApiError(429, "too_many_requests"))
        .mockResolvedValue({ messageId: "m" }),
    });
    const page = await t.mount();
    await vi.waitFor(() => expect(composer(page)).toBeTruthy());
    typeAndSend(page, "First question");
    await vi.waitFor(() => expect(page.shadowRoot?.querySelector("[data-queued]")).not.toBeNull());
    expect(t.services.outbox.get()).toEqual({ chatId: CHAT, text: "First question" });
    expect(t.services.toasts.get().map((x) => x.text)).toContain(LIMITED_TEXT);
    (page.shadowRoot?.querySelector("[data-queued-retry]") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(t.api.sendMessage).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(t.services.outbox.get()).toBeUndefined());
    await vi.waitFor(() => expect(page.shadowRoot?.querySelector("[data-queued]")).toBeNull());
  });

  it("can be discarded", async () => {
    const t = setup("/chats", { sendMessage: vi.fn().mockRejectedValue(new ApiError(500, "x")) });
    const page = await t.mount();
    await vi.waitFor(() => expect(composer(page)).toBeTruthy());
    typeAndSend(page, "Q");
    await vi.waitFor(() => expect(page.shadowRoot?.querySelector("[data-queued]")).not.toBeNull());
    (page.shadowRoot?.querySelector("[data-queued-discard]") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(t.services.outbox.get()).toBeUndefined());
  });

  it("is discarded, never sent, when the user left before the chat was created", async () => {
    let release: () => void = () => {};
    const t = setup("/chats", {
      createChat: vi.fn(
        () =>
          new Promise((r) => {
            release = () => r({ id: CHAT });
          }),
      ),
    });
    const page = await t.mount();
    await vi.waitFor(() => expect(composer(page)).toBeTruthy());
    typeAndSend(page, "Q");
    await vi.waitFor(() => expect(t.api.createChat).toHaveBeenCalled());
    t.services.router.navigate({ name: "documents" });
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(t.services.outbox.get()).toBeUndefined();
    expect(t.api.sendMessage).not.toHaveBeenCalled();
  });

  it("an entry for another chat is cleared, not sent later", async () => {
    const t = setup();
    t.services.outbox.set({ chatId: CHAT_B, text: "stray" });
    const page = await t.mount();
    await loaded(page);
    expect(t.services.outbox.get()).toBeUndefined();
    expect(t.api.sendMessage).not.toHaveBeenCalled();
  });

  it("an entry nobody consumed is cleared when the page goes away", async () => {
    let release: () => void = () => {};
    const t = setup(`/chats/${CHAT}`, {
      listMessages: vi.fn(
        () =>
          new Promise((r) => {
            release = () => r({ items: [], nextCursor: null });
          }),
      ),
    });
    t.services.outbox.set({ chatId: CHAT, text: "waiting" });
    const page = await t.mount();
    t.services.router.navigate({ name: "documents" });
    page.remove();
    release();
    expect(t.services.outbox.get()).toBeUndefined();
  });
});

describe("dm-chat-page: switching chats", () => {
  const byId = () =>
    vi.fn(async (id: string) => ({
      items: [
        msg(1, "user", 1),
        msg(2, "assistant", 1, {
          text: id === CHAT ? `Alpha answer [[${PASSAGE}]]` : "Beta answer",
          citations: id === CHAT ? [cited] : [],
        }),
      ],
      nextCursor: null,
    }));

  it("chat A to chat B: the old stream is closed, nothing of A is shown, and an action from A's view is refused", async () => {
    const t = setup(`/chats/${CHAT}`, { listMessages: byId() });
    const page = await t.mount();
    await vi.waitFor(() => expect(chatText(page)).toContain("Alpha answer"));
    await vi.waitFor(() =>
      expect(chatRoot(page)?.querySelector("button.ref")).toBeInstanceOf(HTMLButtonElement),
    );
    const old = viewOf(page) as NonNullable<ReturnType<typeof viewOf>>;
    const oldSession = old.session as Session;
    const oldAct = old.onAct;
    t.services.router.navigate({ name: "chat", chatId: CHAT_B });
    await vi.waitFor(() => expect(chatText(page)).toContain("Beta answer"));
    expect(t.close).toHaveBeenCalled();
    expect(chatText(page)).not.toContain("Alpha");
    expect(chatRoot(page)?.querySelector("button.ref")).toBeNull();
    const stale = await oldSession.dispatch(
      { type: "SUBMIT_TEXT", widgetId: "w", payload: { text: "x", key: KEY } },
      oldAct,
    );
    expect(stale).toMatchObject({ ok: false });
    const cite = await oldSession.dispatch(
      {
        type: "CHAT_REF_OPEN",
        widgetId: "w",
        payload: { entryId: "t1.assistant", refId: PASSAGE },
      },
      oldAct,
    );
    expect(cite).toMatchObject({ ok: false });
    expect(t.api.sendMessage).not.toHaveBeenCalled();
    expect(page.controller?.state.get().focus).toBeUndefined();
  });

  it("chat A to /chats: the stream is closed, no controller, an empty composer", async () => {
    const t = setup(`/chats/${CHAT}`, { listMessages: byId() });
    const page = await t.mount();
    await vi.waitFor(() => expect(chatText(page)).toContain("Alpha answer"));
    t.services.router.navigate({ name: "chat" });
    await vi.waitFor(() => expect(page.controller).toBeUndefined());
    expect(t.close).toHaveBeenCalled();
    await vi.waitFor(() => expect(composer(page)).toBeTruthy());
    expect(chatText(page)).not.toContain("Alpha");
    expect(h1(page)).toBe("New chat");
  });
});

const panel = (p: Element) =>
  p.shadowRoot?.querySelectorAll("dm-view")[1] as
    | (HTMLElement & { session?: Session; onAct?: unknown })
    | undefined;
const panelView = (p: Element) =>
  panel(p)?.shadowRoot?.querySelector("lu-a2ui-widget")?.shadowRoot?.querySelector("lu-a2ui-view")
    ?.shadowRoot;
const panelText = (p: Element) => panelView(p)?.textContent?.replace(/\s+/g, " ") ?? "";
const panelRaise = (p: Element, payload: Record<string, unknown>) => {
  const v = panel(p) as NonNullable<ReturnType<typeof panel>>;
  vi.spyOn(v.session as Session, "isFresh").mockReturnValue(true); // the staleness check is the session's own, tested there
  return (v.session as Session).dispatch({ type: "A2UI_ACTION", widgetId: "w", payload }, v.onAct);
};
const focusedIsRefOrToggle = (p: Element, ref: HTMLElement) =>
  deepActive() === ref || p.shadowRoot?.activeElement === button(p, "button[data-sources]");
const deepActive = () => {
  let el: Element | null = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
};
const mq: { wide: boolean; fns: Set<() => void> } = { wide: true, fns: new Set() };
const media = (wide: boolean) => {
  mq.wide = wide;
  mq.fns.clear();
  vi.stubGlobal("matchMedia", (q: string) => ({
    get matches() {
      return q.includes("1100px") ? mq.wide : false;
    },
    media: q,
    addEventListener: (_: string, f: () => void) => mq.fns.add(f),
    removeEventListener: (_: string, f: () => void) => mq.fns.delete(f),
  }));
};
const resize = (wide: boolean) => {
  mq.wide = wide;
  for (const f of [...mq.fns]) f();
};
const narrow = () => media(false);
beforeEach(() => media(true));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const OTHER = "c0ffee00-0000-4000-8000-000000000002";
const OTHER_DOC = "7f6d1b8e-3b0a-4a56-8f2f-0a8e0f7c4d12";

describe("dm-chat-page: sources", () => {
  it("shows the sources of the newest cited reply beside the chat, and follows a clicked marker", async () => {
    const t = setup();
    const page = await t.mount();
    await vi.waitFor(() => expect(panelText(page)).toContain("Contract"));
    expect(panelText(page)).toContain("Page 2");
    expect(panelText(page)).toContain("Net 30");
    (chatRoot(page)?.querySelector("button.ref") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(panelView(page)?.querySelector("[aria-current]")).not.toBeNull());
  });
  it("a clicked marker highlights its source in place, never reordering the list", async () => {
    const second = { ...cited, passageId: OTHER, docTitle: "Annex", snippet: "Net 60" };
    const t = setup(`/chats/${CHAT}`, {
      listMessages: vi.fn(async () => ({
        items: [
          msg(1, "user", 1),
          msg(2, "assistant", 1, {
            text: `Due in 30 days [[${PASSAGE}]] or 60 [[${OTHER}]].`,
            citations: [cited, second],
          }),
        ],
        nextCursor: null,
      })),
    });
    const page = await t.mount();
    await vi.waitFor(() => expect(panelText(page)).toContain("Annex"));
    const titles = () =>
      [...(panelView(page)?.querySelectorAll("[aria-current]") ?? [])].map((e) => e.textContent);
    const order = () => panelText(page).match(/Contract|Annex/g);
    const refs = [...(chatRoot(page)?.querySelectorAll("button.ref") ?? [])] as HTMLButtonElement[];
    expect(refs).toHaveLength(2);
    refs[1]?.click();
    await vi.waitFor(() => expect(titles()).toHaveLength(1));
    expect(titles()[0]).toContain("Annex");
    expect(order()).toEqual(["Contract", "Annex"]);
    expect(panelText(page)).not.toContain("Selected - ");
    refs[0]?.click();
    await vi.waitFor(() => expect(titles()[0]).toContain("Contract"));
    expect(titles()).toHaveLength(1);
    expect(order()).toEqual(["Contract", "Annex"]);
  });
  it("says sources appear when the answer is complete while a reply streams", async () => {
    const t = setup(`/chats/${CHAT}`, {
      listMessages: vi.fn(async () => ({ items: [msg(1, "user", 1)], nextCursor: null })),
    });
    const page = await t.mount();
    await vi.waitFor(() =>
      expect(panelText(page)).toContain("Sources appear when the answer is complete."),
    );
  });
  it("opens the cited passage in its document", async () => {
    const t = setup();
    const page = await t.mount();
    await vi.waitFor(() => expect(panelText(page)).toContain("Contract"));
    const open = panelView(page)?.querySelector("button") as HTMLButtonElement;
    expect(open.textContent).toContain("Open in document");
    open.click();
    await vi.waitFor(() =>
      expect(t.services.router.get()).toEqual({ name: "document", id: DOC, passage: PASSAGE }),
    );
  });
  it("navigates with the held ids only, whatever the action says", async () => {
    const t = setup();
    const page = await t.mount();
    await vi.waitFor(() => expect(panelText(page)).toContain("Contract"));
    const out = await panelRaise(page, {
      action: "open-source",
      context: { index: 0, passageId: OTHER, documentId: OTHER_DOC },
    });
    expect(out).toMatchObject({ ok: true });
    expect(t.services.router.get()).toEqual({ name: "document", id: DOC, passage: PASSAGE });
  });
  it("refuses a forged or missing index, and goes nowhere", async () => {
    const t = setup();
    const page = await t.mount();
    await vi.waitFor(() => expect(panelText(page)).toContain("Contract"));
    for (const context of [{ index: 7 }, { index: -1 }, { index: 0.5 }, { index: "0" }, {}]) {
      expect(await panelRaise(page, { action: "open-source", context })).toMatchObject({
        ok: false,
      });
    }
    expect(await panelRaise(page, { action: "other", context: { index: 0 } })).toMatchObject({
      ok: false,
    });
    expect(t.services.router.get().name).toBe("chat");
  });
  it("shows only the selected reply's citations; a citation from another entry is refused", async () => {
    const second = { ...cited, passageId: OTHER, documentId: OTHER_DOC, docTitle: "Lease" };
    const t = setup(`/chats/${CHAT}`, {
      listMessages: vi.fn(async () => ({
        items: [
          msg(1, "user", 1),
          msg(2, "assistant", 1, { text: `One [[${PASSAGE}]].`, citations: [cited] }),
          msg(3, "user", 2),
          msg(4, "assistant", 2, { text: `Two [[${OTHER}]].`, citations: [second] }),
        ],
        nextCursor: null,
      })),
    });
    const page = await t.mount();
    await vi.waitFor(() => expect(panelText(page)).toContain("Lease"));
    expect(panelText(page)).not.toContain("Contract");
    const v = viewOf(page) as NonNullable<ReturnType<typeof viewOf>>;
    vi.spyOn(v.session as Session, "isFresh").mockReturnValue(true);
    const entryB = page.controller?.state.get().entries.at(-1)?.id as string;
    const cross = await raise(page, "CHAT_REF_OPEN", { entryId: entryB, refId: PASSAGE });
    expect(cross).toMatchObject({ ok: false });
    expect(page.controller?.state.get().focus).toBeUndefined();
    expect(panelText(page)).not.toContain("Contract");
  });
  it("hides and shows the panel with the Sources button, and says whether it is open", async () => {
    const t = setup();
    const page = await t.mount();
    const toggle = button(page, "button[data-sources]") as HTMLButtonElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    toggle.click();
    await vi.waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("false"));
    expect(panel(page)).toBeUndefined();
    toggle.click();
    await vi.waitFor(() => expect(panel(page)).toBeDefined());
  });
  it("is a labelled complementary landmark; a citation moves focus to its heading, Escape returns it to the marker", async () => {
    const t = setup();
    const page = await t.mount();
    await vi.waitFor(() => expect(panelText(page)).toContain("Contract"));
    const aside = page.shadowRoot?.querySelector("aside") as HTMLElement;
    expect(aside.getAttribute("aria-label")).toBe("Sources");
    const ref = chatRoot(page)?.querySelector("button.ref") as HTMLButtonElement;
    ref.focus();
    ref.click();
    const heading = page.shadowRoot?.querySelector("aside h2") as HTMLElement;
    await vi.waitFor(() => expect(page.shadowRoot?.activeElement).toBe(heading));
    aside.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.waitFor(() => expect(panel(page)).toBeUndefined());
    await vi.waitFor(() => expect(focusedIsRefOrToggle(page, ref)).toBe(true));
  });
  it("Close returns focus like Escape; a citation with no prior focus falls back to the Sources toggle", async () => {
    const t = setup();
    const page = await t.mount();
    await vi.waitFor(() => expect(panelText(page)).toContain("Contract"));
    (document.activeElement as HTMLElement | null)?.blur();
    (chatRoot(page)?.querySelector("button.ref") as HTMLButtonElement).click();
    const heading = page.shadowRoot?.querySelector("aside h2") as HTMLElement;
    await vi.waitFor(() => expect(page.shadowRoot?.activeElement).toBe(heading));
    (button(page, "button[data-sources-close]") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(panel(page)).toBeUndefined());
    await vi.waitFor(() =>
      expect(page.shadowRoot?.activeElement).toBe(button(page, "button[data-sources]")),
    );
  });
  it("the toggle opens the panel into focus on its heading, and closing it keeps focus on the toggle", async () => {
    const t = setup();
    const page = await t.mount();
    const toggle = button(page, "button[data-sources]") as HTMLButtonElement;
    expect(toggle.getAttribute("aria-controls")).toBe("sources");
    toggle.focus();
    toggle.click();
    await vi.waitFor(() => expect(panel(page)).toBeUndefined());
    expect(toggle.hasAttribute("aria-controls")).toBe(false);
    await vi.waitFor(() => expect(page.shadowRoot?.activeElement).toBe(toggle));
    toggle.click();
    const heading = () => page.shadowRoot?.querySelector("aside h2");
    await vi.waitFor(() => expect(page.shadowRoot?.activeElement).toBe(heading()));
  });
  it("opens the second source's document with its own ids; a selected source keeps its place, so the action still resolves it", async () => {
    const second = { ...cited, passageId: OTHER, documentId: OTHER_DOC, docTitle: "Lease" };
    const t = setup(`/chats/${CHAT}`, {
      listMessages: vi.fn(async () => ({
        items: [
          msg(1, "user", 1),
          msg(2, "assistant", 1, {
            text: `One [[${PASSAGE}]] and [[${OTHER}]].`,
            citations: [cited, second],
          }),
        ],
        nextCursor: null,
      })),
    });
    const page = await t.mount();
    await vi.waitFor(() => expect(panelText(page)).toContain("Lease"));
    const buttons = () => Array.from(panelView(page)?.querySelectorAll("button") ?? []);
    expect(buttons()).toHaveLength(2);
    buttons()[1]?.click();
    await vi.waitFor(() =>
      expect(t.services.router.get()).toEqual({ name: "document", id: OTHER_DOC, passage: OTHER }),
    );
    t.services.router.navigate({ name: "chat", chatId: CHAT });
    await vi.waitFor(() => expect(panelText(page)).toContain("Lease"));
    const refs = Array.from(chatRoot(page)?.querySelectorAll("button.ref") ?? []);
    (refs[1] as HTMLButtonElement).click();
    await vi.waitFor(() => expect(panelView(page)?.querySelector("[aria-current]")).not.toBeNull());
    expect(panelText(page).indexOf("Contract")).toBeLessThan(panelText(page).indexOf("Lease"));
    buttons()[1]?.click();
    await vi.waitFor(() =>
      expect(t.services.router.get()).toEqual({ name: "document", id: OTHER_DOC, passage: OTHER }),
    );
  });
});

describe("dm-chat-page: sources below 1100px", () => {
  it("starts closed; a citation opens a modal panel with a backdrop and the chat inert behind it", async () => {
    narrow();
    const t = setup();
    const page = await t.mount();
    await vi.waitFor(() => expect(chatText(page)).toContain("Due in 30 days"));
    expect(panel(page)).toBeUndefined();
    const toggle = button(page, "button[data-sources]") as HTMLButtonElement;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(page.shadowRoot?.querySelector("[data-backdrop]")).toBeNull();
    const ref = chatRoot(page)?.querySelector("button.ref") as HTMLButtonElement;
    ref.focus();
    ref.click();
    await vi.waitFor(() => expect(panel(page)).toBeDefined());
    expect(page.shadowRoot?.querySelector("aside")?.getAttribute("aria-modal")).toBe("true");
    expect((page.shadowRoot?.querySelector(".main") as HTMLElement).inert).toBe(true);
    expect((page.shadowRoot?.querySelector("header") as HTMLElement).inert).toBe(true);
    expect(page.shadowRoot?.querySelector("[data-backdrop]")).not.toBeNull();
    await vi.waitFor(() =>
      expect(page.shadowRoot?.activeElement).toBe(page.shadowRoot?.querySelector("aside h2")),
    );
    // Escape works with focus outside the panel.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.waitFor(() => expect(panel(page)).toBeUndefined());
    expect((page.shadowRoot?.querySelector(".main") as HTMLElement).inert).toBe(false);
    await vi.waitFor(() => expect(focusedIsRefOrToggle(page, ref)).toBe(true));
  });
  it("the toggle opens it into focus on the heading; the backdrop closes it back to the toggle", async () => {
    narrow();
    const t = setup();
    const page = await t.mount();
    await vi.waitFor(() => expect(chatText(page)).toContain("Due in 30 days"));
    const toggle = button(page, "button[data-sources]") as HTMLButtonElement;
    toggle.focus();
    toggle.click();
    await vi.waitFor(() =>
      expect(page.shadowRoot?.activeElement).toBe(page.shadowRoot?.querySelector("aside h2")),
    );
    (page.shadowRoot?.querySelector("[data-backdrop]") as HTMLElement).click();
    await vi.waitFor(() => expect(panel(page)).toBeUndefined());
    await vi.waitFor(() => expect(page.shadowRoot?.activeElement).toBe(toggle));
  });
});

describe("dm-chat-page: sources, resize and dialogs", () => {
  it("widening past 1100px while open docks the panel: no backdrop, nothing inert", async () => {
    narrow();
    const t = setup();
    const page = await t.mount();
    await vi.waitFor(() => expect(chatText(page)).toContain("Due in 30 days"));
    (button(page, "button[data-sources]") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(panel(page)).toBeDefined());
    resize(true);
    await vi.waitFor(() => expect(page.shadowRoot?.querySelector("[data-backdrop]")).toBeNull());
    expect((page.shadowRoot?.querySelector(".main") as HTMLElement).inert).toBe(false);
    expect((page.shadowRoot?.querySelector("header") as HTMLElement).inert).toBe(false);
    expect(panel(page)).toBeDefined();
    expect(page.shadowRoot?.querySelector("aside")?.hasAttribute("aria-modal")).toBe(false);
  });
  it("narrowing below 1100px while docked-open closes the panel (the narrow default) and leaves nothing inert", async () => {
    const t = setup();
    const page = await t.mount();
    await vi.waitFor(() => expect(panelText(page)).toContain("Contract"));
    resize(false);
    await vi.waitFor(() => expect(panel(page)).toBeUndefined());
    expect((page.shadowRoot?.querySelector(".main") as HTMLElement).inert).toBe(false);
    expect(button(page, "button[data-sources]")?.getAttribute("aria-expanded")).toBe("false");
  });
  it("Escape with a dialog open closes only the dialog; the panel keeps its isolation until it closes", async () => {
    narrow();
    const t = setup();
    const page = await t.mount();
    await vi.waitFor(() => expect(chatText(page)).toContain("Due in 30 days"));
    (button(page, "button[data-sources]") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(panel(page)).toBeDefined());
    const sib = document.createElement("div");
    page.parentNode?.append(sib);
    page.controller?.toggleSources(false);
    page.controller?.toggleSources(true);
    await vi.waitFor(() => expect(sib.inert).toBe(true));
    const d = document.createElement("dm-dialog") as HTMLElement & {
      open: boolean;
      heading: string;
    };
    d.heading = "Confirm";
    d.open = true;
    d.addEventListener("dm-close", () => d.remove());
    document.body.append(d);
    await vi.waitFor(() => expect(d.isConnected).toBe(true));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.waitFor(() => expect(d.isConnected).toBe(false));
    expect(panel(page)).toBeDefined();
    expect(sib.inert).toBe(true);
    // Closing the panel while a dialog is open must not release what the dialog relies on.
    const d2 = document.createElement("dm-dialog") as HTMLElement & {
      open: boolean;
      heading: string;
    };
    d2.heading = "Again";
    d2.open = true;
    document.body.append(d2);
    await new Promise((r) => setTimeout(r, 0));
    page.controller?.toggleSources(false);
    await vi.waitFor(() => expect(panel(page)).toBeUndefined());
    expect(sib.inert).toBe(true);
    d2.remove();
    await vi.waitFor(() => expect(sib.inert).toBe(false));
    expect((page.shadowRoot?.querySelector("header") as HTMLElement).inert).toBe(false);
  });
  it("removing the page releases what the panel made inert, at once, or when an open dialog closes", async () => {
    narrow();
    const t = setup();
    const page = await t.mount();
    await vi.waitFor(() => expect(chatText(page)).toContain("Due in 30 days"));
    const sib = document.createElement("div");
    page.parentNode?.append(sib);
    (button(page, "button[data-sources]") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(sib.inert).toBe(true));
    page.remove();
    expect(sib.inert).toBe(false);

    const page2 = await t.mount();
    await vi.waitFor(() => expect(chatText(page2)).toContain("Due in 30 days"));
    const sib2 = document.createElement("div");
    page2.parentNode?.append(sib2);
    (button(page2, "button[data-sources]") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(sib2.inert).toBe(true));
    const d = document.createElement("dm-dialog") as HTMLElement & {
      open: boolean;
      heading: string;
    };
    d.heading = "Confirm";
    d.open = true;
    document.body.append(d);
    await new Promise((r) => setTimeout(r, 0));
    page2.remove();
    expect(sib2.inert).toBe(true); // the dialog still relies on it
    d.remove();
    await vi.waitFor(() => expect(sib2.inert).toBe(false));
  });
});
