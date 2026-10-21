import { describe, expect, it, vi } from "vitest";
import { createServices } from "../services";
import { AuthStore } from "../state/auth";
import { fakeUi } from "../testing/fakeUi";
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
    ...fakeUi().api,
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
  it("has labelled landmarks: navigation, main, the chats list, and the user's email in the footer", async () => {
    const { el } = await setup();
    expect(q(el, "nav[aria-label='Primary']")).not.toBeNull();
    expect(q(el, "main")).not.toBeNull();
    expect(q(el, "dm-sessions")).not.toBeNull();
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

  it("Escape works from the Menu button itself", async () => {
    const { el } = await setup();
    const menu = q<HTMLButtonElement>(el, "button[data-menu]");
    menu.click();
    await settle(el);
    menu.focus();
    menu.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }),
    );
    await settle(el);
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    expect(el.shadowRoot?.activeElement).toBe(menu);
  });

  it("opening the menu moves focus into the sidebar, and main is inert behind it until it closes", async () => {
    const { el } = await setup();
    const menu = q<HTMLButtonElement>(el, "button[data-menu]");
    expect(q<HTMLElement>(el, "main").inert).toBe(false);
    menu.click();
    await settle(el);
    await settle(el);
    expect(q<HTMLElement>(el, "aside").contains(el.shadowRoot?.activeElement ?? null)).toBe(true);
    expect(q<HTMLElement>(el, "main").inert).toBe(true);
    menu.click();
    await settle(el);
    expect(q<HTMLElement>(el, "main").inert).toBe(false);
  });

  it("the menu closes on any route change, not only on New chat", async () => {
    const { services, el } = await setup();
    q<HTMLButtonElement>(el, "button[data-menu]").click();
    await settle(el);
    services.router.navigate({ name: "settings" });
    await settle(el);
    expect(q(el, "aside").hasAttribute("data-open")).toBe(false);
    expect(q<HTMLElement>(el, "main").inert).toBe(false);
    q<HTMLButtonElement>(el, "button[data-menu]").click();
    await settle(el);
    services.router.navigate({ name: "documents" });
    await settle(el);
    expect(q(el, "aside").hasAttribute("data-open")).toBe(false);
  });

  it("navigation closing the menu returns focus to the Menu button only if focus was inside the menu", async () => {
    const { services, el } = await setup();
    const menu = q<HTMLButtonElement>(el, "button[data-menu]");
    menu.click();
    await settle(el);
    expect(q<HTMLElement>(el, "aside").contains(el.shadowRoot?.activeElement ?? null)).toBe(true);
    services.router.navigate({ name: "settings" });
    await settle(el);
    expect(el.shadowRoot?.activeElement).toBe(menu);
    menu.click();
    await settle(el);
    (el.shadowRoot?.activeElement as HTMLElement).blur();
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    services.router.navigate({ name: "documents" });
    await settle(el);
    expect(q(el, "aside").hasAttribute("data-open")).toBe(false);
    expect(document.activeElement).toBe(outside);
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

  it("puts what is slotted into the main region, and the chats list in the sidebar", async () => {
    const { el } = await setup(`<p id="view">View</p>`);
    const main = q<HTMLSlotElement>(el, "main slot:not([name])");
    expect(main.assignedNodes().map((n) => (n as Element).id)).toEqual(["view"]);
    expect(q<HTMLElement>(el, "aside").contains(q(el, "dm-sessions"))).toBe(true);
  });

  it("a dialog opened inside the view makes the sidebar and the navigation inert, and releases them on close", async () => {
    const { el } = await setup(
      `<dm-dialog id="dlg" heading="Sure?"><p>Body</p><button slot="actions" id="ok">OK</button></dm-dialog>`,
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
