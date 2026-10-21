import type { ChatSessionDto } from "@docmind/contracts";
import { describe, expect, it, vi } from "vitest";
import { Router } from "../router";
import { createServices } from "../services";
import { fakeUi } from "../testing/fakeUi";
import { mountWith } from "../testing/mount";
import "./dm-sessions";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const chat = (n: number, title: string | null): ChatSessionDto => ({
  id: id(n),
  title,
  scope: "all",
  createdAt: "2026-10-01T10:00:00.000Z",
  lastMessageAt: "2026-10-05T10:00:00.000Z",
  messageCount: 1,
});

function setup(path = "/chats") {
  const live = { chats: [chat(1, "Invoices"), chat(2, null)] };
  const chatsReader = vi.fn(async (a: { q: string }) =>
    live.chats.filter((c) => (c.title ?? "New chat").toLowerCase().includes(a.q.toLowerCase())),
  );
  const ui = fakeUi({
    documents: async () => ({ items: [], truncated: false }),
    document: async () => null,
    content: async () => null,
    chats: chatsReader,
  });
  const api = {
    ...ui.api,
    deleteChat: vi.fn(async (cid: string) => {
      live.chats = live.chats.filter((c) => c.id !== cid);
    }),
    patchChat: vi.fn(async (cid: string, b: { title?: string }) => {
      live.chats = live.chats.map((c) => (c.id === cid ? { ...c, title: b.title ?? c.title } : c));
      return {};
    }),
  };
  const win = {
    location: { pathname: path, search: "" },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
    removeEventListener() {},
  };
  const services = createServices({ api: api as never, router: new Router(win as never) });
  return {
    services,
    api,
    chatsReader,
    live,
    mount: () => mountWith<HTMLElement>(services, "dm-sessions"),
  };
}
type Act = (a: { type: string; widgetId: string; payload: Record<string, unknown> }) => Promise<
  { ok: boolean; reason?: string } | undefined
>;
const view = (p: Element) => p.shadowRoot?.querySelector("dm-view") as HTMLElement & { onAct: Act };
const table = (p: Element) => view(p)?.shadowRoot?.querySelector("lu-table") as HTMLElement;
const rows = (p: Element) =>
  [...(table(p)?.shadowRoot?.querySelectorAll("tbody tr") ?? [])].map((r) =>
    r.textContent?.replace(/\s+/g, " ").trim(),
  );
const act = (p: Element, label: string) =>
  (
    table(p).shadowRoot?.querySelector(`button[aria-label='${label}']`) as HTMLButtonElement
  ).click();
const yes = (t: string) =>
  (
    [...document.querySelectorAll("dm-dialog button")].find(
      (b) => b.textContent === t,
    ) as HTMLButtonElement
  ).click();

describe("dm-sessions", () => {
  it("lists the chats newest first with a named Open, Rename and Delete for each", async () => {
    const t = setup();
    const p = await t.mount();
    await vi.waitFor(() => expect(rows(p)).toHaveLength(2));
    expect(rows(p)[0]).toContain("Invoices");
    expect(rows(p)[1]).toContain("New chat");
    expect(
      [...(table(p).shadowRoot?.querySelectorAll("td.row-actions button") ?? [])]
        .map((b) => b.getAttribute("aria-label"))
        .slice(0, 3),
    ).toEqual(["Open: Invoices", "Rename: Invoices", "Delete: Invoices"]);
  });
  it("opens a chat", async () => {
    const t = setup();
    const p = await t.mount();
    await vi.waitFor(() => expect(rows(p)).toHaveLength(2));
    act(p, "Open: Invoices");
    await vi.waitFor(() =>
      expect(t.services.router.route).toEqual({ name: "chat", chatId: id(1) }),
    );
  });
  it("renames a chat with a dialog that starts from its title", async () => {
    const t = setup();
    const p = await t.mount();
    await vi.waitFor(() => expect(rows(p)).toHaveLength(2));
    act(p, "Rename: Invoices");
    await vi.waitFor(() =>
      expect((document.querySelector("dm-dialog input") as HTMLInputElement | null)?.value).toBe(
        "Invoices",
      ),
    );
    (document.querySelector("dm-dialog input") as HTMLInputElement).value = "Tax 2026";
    yes("Save");
    await vi.waitFor(() =>
      expect(t.api.patchChat).toHaveBeenCalledWith(id(1), { title: "Tax 2026" }),
    );
    await vi.waitFor(() => expect(rows(p)[0]).toContain("Tax 2026"));
  });
  it("deletes after a confirmation, and leaves the chat page when the open chat was deleted", async () => {
    const t = setup(`/chats/${id(1)}`);
    const p = await t.mount();
    await vi.waitFor(() => expect(rows(p)).toHaveLength(2));
    act(p, "Delete: Invoices");
    await vi.waitFor(() => expect(document.querySelector("dm-dialog")).not.toBeNull());
    yes("Delete");
    await vi.waitFor(() => expect(t.api.deleteChat).toHaveBeenCalledWith(id(1)));
    await vi.waitFor(() => expect(rows(p)).toHaveLength(1));
    expect(t.services.router.route).toEqual({ name: "chat" });
  });
  it("deleting another chat leaves the open one where it is", async () => {
    const t = setup(`/chats/${id(2)}`);
    const p = await t.mount();
    await vi.waitFor(() => expect(rows(p)).toHaveLength(2));
    act(p, "Delete: Invoices");
    await vi.waitFor(() => expect(document.querySelector("dm-dialog")).not.toBeNull());
    yes("Delete");
    await vi.waitFor(() => expect(rows(p)).toHaveLength(1));
    expect(t.services.router.route).toEqual({ name: "chat", chatId: id(2) });
  });
  it("searches through the experience's own box and refreshes when a chat changes", async () => {
    const t = setup();
    const p = await t.mount();
    await vi.waitFor(() => expect(rows(p)).toHaveLength(2));
    const input = view(p)
      ?.shadowRoot?.querySelector("lu-text-input")
      ?.shadowRoot?.querySelector("input") as HTMLInputElement;
    input.value = "invo";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form")?.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await vi.waitFor(() => expect(t.chatsReader).toHaveBeenCalledWith({ q: "invo" }));
    await vi.waitFor(() => expect(rows(p)).toHaveLength(1));
    t.live.chats = [chat(3, "Invoice follow-up"), ...t.live.chats];
    document.dispatchEvent(new CustomEvent("dm-chats-changed"));
    await vi.waitFor(() => expect(rows(p)).toHaveLength(2));
  });
  it("a burst of chat-changed events schedules one refresh", async () => {
    const t = setup();
    const p = await t.mount();
    await vi.waitFor(() => expect(rows(p)).toHaveLength(2));
    const queued: (() => void)[] = [];
    (p as unknown as { schedule: (fn: () => void) => void }).schedule = (fn) => queued.push(fn);
    const before = t.chatsReader.mock.calls.length;
    for (let i = 0; i < 20; i++) document.dispatchEvent(new CustomEvent("dm-chats-changed"));
    expect(queued).toHaveLength(1);
    queued[0]?.();
    await vi.waitFor(() => expect(t.chatsReader.mock.calls.length).toBe(before + 1));
    document.dispatchEvent(new CustomEvent("dm-chats-changed"));
    expect(queued).toHaveLength(2); // the next change schedules again
  });
  it("refuses a row action for a key the table did not serve, and calls nothing", async () => {
    const t = setup();
    const p = await t.mount();
    await vi.waitFor(() => expect(rows(p)).toHaveLength(2));
    for (const action of ["delete", "rename", "open"]) {
      const answer = await view(p).onAct({
        type: "TABLE_ROW_ACTION",
        widgetId: "chats",
        payload: { action, rowKey: id(99) },
      });
      expect(answer).toEqual({ ok: false, reason: "refused" });
    }
    expect(document.querySelector("dm-dialog")).toBeNull();
    expect(t.api.deleteChat).not.toHaveBeenCalled();
    expect(t.api.patchChat).not.toHaveBeenCalled();
  });
  it("a double click on Delete opens one confirmation and sends one request", async () => {
    const t = setup();
    const p = await t.mount();
    await vi.waitFor(() => expect(rows(p)).toHaveLength(2));
    const del = {
      type: "TABLE_ROW_ACTION",
      widgetId: "chats",
      payload: { action: "delete", rowKey: id(1) },
    };
    const first = view(p).onAct(del);
    const second = view(p).onAct(del);
    await vi.waitFor(() => expect(document.querySelectorAll("dm-dialog")).toHaveLength(1));
    yes("Delete");
    await Promise.all([first, second]);
    expect(t.api.deleteChat).toHaveBeenCalledTimes(1);
  });
  it("a rename dialog still open when the sidebar goes is closed and renames nothing", async () => {
    const t = setup();
    const p = await t.mount();
    await vi.waitFor(() => expect(rows(p)).toHaveLength(2));
    act(p, "Rename: Invoices");
    await vi.waitFor(() => expect(document.querySelector("dm-dialog input")).not.toBeNull());
    (document.querySelector("dm-dialog input") as HTMLInputElement).value = "Changed";
    p.remove();
    await vi.waitFor(() => expect(document.querySelector("dm-dialog")).toBeNull());
    expect(t.api.patchChat).not.toHaveBeenCalled();
  });
  it("a delete confirmation still open when the sidebar goes is closed and deletes nothing", async () => {
    const t = setup(`/chats/${id(1)}`);
    const p = await t.mount();
    await vi.waitFor(() => expect(rows(p)).toHaveLength(2));
    act(p, "Delete: Invoices");
    await vi.waitFor(() => expect(document.querySelector("dm-dialog")).not.toBeNull());
    p.remove();
    await vi.waitFor(() => expect(document.querySelector("dm-dialog")).toBeNull());
    expect(t.api.deleteChat).not.toHaveBeenCalled();
    expect(t.services.router.route).toEqual({ name: "chat", chatId: id(1) });
  });
});
