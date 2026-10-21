import { describe, expect, it, vi } from "vitest";
import { createServices } from "../services";
import { AuthStore } from "../state/auth";
import { mountWith } from "../testing/mount";
import "./dm-app-shell";
import "./dm-dialog";

const ME = {
  userId: "0b4f7d52-6c53-4c6e-9d49-2b0e7a3f9a10",
  tenantId: "7f6d1b8e-3b0a-4a56-8f2f-0a8e0f7c4d11",
  email: "a@example.com",
};
async function setup(children = "") {
  const api = {
    me: async () => ME,
    login: async () => ME,
    logout: vi.fn(async () => {}),
    signUp: async () => {},
  } as never;
  const auth = new AuthStore(api);
  await auth.login({ email: ME.email, password: "x" });
  const services = createServices({ api, auth, fetch: (async () => new Response("{}")) as never });
  const el = await mountWith<HTMLElement>(services, "dm-app-shell");
  if (children) {
    el.innerHTML = children;
    await settle(el);
  }
  return { services, el };
}
const q = <T extends Element>(el: Element, sel: string) => el.shadowRoot?.querySelector(sel) as T;
const settle = (el: Element) =>
  (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;

describe("dm-app-shell", () => {
  it("has labelled landmarks: navigation, main, the sidebar slot, and the user's email in the footer", async () => {
    const { el } = await setup();
    expect(q(el, "nav[aria-label='Primary']")).not.toBeNull();
    expect(q(el, "main")).not.toBeNull();
    expect(q(el, "slot[name='sidebar']")).not.toBeNull();
    expect(q(el, "[data-user]").textContent).toBe("a@example.com");
  });

  it("New chat and Documents navigate; the active destination is marked", async () => {
    const { services, el } = await setup();
    expect(q<HTMLAnchorElement>(el, "a[data-documents]").getAttribute("href")).toBe("/documents");
    services.router.navigate({ name: "documents" });
    await settle(el);
    expect(q(el, "a[data-documents]").getAttribute("aria-current")).toBe("page");
    q<HTMLButtonElement>(el, "button[data-new-chat]").click();
    expect(services.router.route).toEqual({ name: "chat" });
  });

  it("toggles the theme and signs out from the footer", async () => {
    const { services, el } = await setup();
    const before = services.theme.get();
    q<HTMLButtonElement>(el, "button[data-theme-toggle]").click();
    expect(services.theme.get()).not.toBe(before);
    q<HTMLButtonElement>(el, "button[data-sign-out]").click();
    await vi.waitFor(() => expect(services.router.route).toEqual({ name: "sign-in" }));
  });

  it("collapses the sidebar behind a Menu button that says whether it is open", async () => {
    const { el } = await setup();
    const menu = q<HTMLButtonElement>(el, "button[data-menu]");
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    menu.click();
    await settle(el);
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    expect(q(el, "aside").hasAttribute("data-open")).toBe(true);
  });

  it("Escape closes an open menu and gives focus back to the Menu button", async () => {
    const { el } = await setup();
    const menu = q<HTMLButtonElement>(el, "button[data-menu]");
    menu.click();
    await settle(el);
    q(el, "aside").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }),
    );
    await settle(el);
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    expect(el.shadowRoot?.activeElement).toBe(menu);
  });

  it("starts with a skip link to the main region, and following it focuses main without a navigation", async () => {
    const { services, el } = await setup();
    const skip = q<HTMLAnchorElement>(el, "a[data-skip]");
    expect(skip).not.toBeNull();
    expect(el.shadowRoot?.querySelector("a, button")).toBe(skip); // first in tab order
    const before = services.router.route;
    const ev = new MouseEvent("click", { bubbles: true, composed: true, cancelable: true });
    skip.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(el.shadowRoot?.activeElement).toBe(q(el, "main"));
    expect(services.router.route).toEqual(before);
  });

  it("puts what is slotted in the right places", async () => {
    const { el } = await setup(`<p id="view">View</p><p slot="sidebar" id="list">Chats</p>`);
    const side = q<HTMLSlotElement>(el, "slot[name='sidebar']");
    expect(side.assignedNodes().map((n) => (n as Element).id)).toEqual(["list"]);
    const main = q<HTMLSlotElement>(el, "main slot:not([name])");
    expect(main.assignedNodes().map((n) => (n as Element).id)).toEqual(["view"]);
  });

  it("a dialog opened inside the view makes the sidebar and the navigation inert, and releases them on close", async () => {
    const { el } = await setup(
      `<dm-dialog id="dlg" heading="Sure?"><p>Body</p><button slot="actions" id="ok">OK</button></dm-dialog><p slot="sidebar">Chats</p>`,
    );
    const dlg = el.querySelector("#dlg") as HTMLElement & { open: boolean };
    dlg.open = true;
    await settle(dlg);
    expect(q<HTMLElement>(el, "aside").inert).toBe(true);
    dlg.open = false;
    await settle(dlg);
    expect(q<HTMLElement>(el, "aside").inert).toBe(false);
  });
});
