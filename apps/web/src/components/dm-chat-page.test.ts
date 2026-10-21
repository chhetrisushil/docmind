import type { ChatMessageDto } from "@docmind/contracts";
import { describe, expect, it, vi } from "vitest";
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
  controller?: { state: Store<ChatViewState>; close(): void };
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
const selectOf = (p: Element) =>
  viewOf(p)?.shadowRoot?.querySelector("lu-select-input")?.shadowRoot?.querySelector("select") as
    | HTMLSelectElement
    | null
    | undefined;
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

  it("switches the scope with the select: back to all, and to the started documents", async () => {
    const t = setup();
    const page = await t.mount();
    await vi.waitFor(() => expect(t.api.getChat).toHaveBeenCalled());
    await vi.waitFor(() => expect(selectOf(page)).toBeInstanceOf(HTMLSelectElement));
    const select = selectOf(page) as HTMLSelectElement;
    select.value = "all";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(t.api.patchChat).toHaveBeenCalledWith(CHAT, { scope: "all" }));
    await vi.waitFor(() =>
      expect(
        viewOf(page)
          ?.shadowRoot?.querySelector("lu-select-input")
          ?.shadowRoot?.querySelector("[data-phase]")
          ?.getAttribute("data-phase"),
      ).toBe("sent"),
    );
    const again = selectOf(page) as HTMLSelectElement;
    again.value = "started";
    again.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() =>
      expect(t.api.patchChat).toHaveBeenLastCalledWith(CHAT, { scope: { documentIds: [DOC] } }),
    );
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
