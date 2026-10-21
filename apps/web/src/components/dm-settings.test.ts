import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/http";
import { createServices } from "../services";
import { AuthStore } from "../state/auth";
import { mountWith } from "../testing/mount";
import "./dm-settings";
import "./dm-dialog";

const ME = {
  userId: "0b4f7d52-6c53-4c6e-9d49-2b0e7a3f9a10",
  tenantId: "7f6d1b8e-3b0a-4a56-8f2f-0a8e0f7c4d11",
  email: "a@example.com",
};
const RECEIPT = "A".repeat(43);

async function setup(over: Record<string, unknown> = {}) {
  const api = {
    me: async () => ME,
    login: async () => ME,
    logout: vi.fn(async () => {}),
    signUp: async () => {},
    deleteAccount: vi.fn(async () => ({ erasure: "accepted", receipt: RECEIPT })),
    ...over,
  } as never;
  const auth = new AuthStore(api);
  await auth.login({ email: ME.email, password: "x" });
  const services = createServices({ api, auth, fetch: (async () => new Response("{}")) as never });
  const el = await mountWith<HTMLElement>(services, "dm-settings");
  return { services, api, el };
}
const q = <T extends Element>(el: Element, sel: string) => el.shadowRoot?.querySelector(sel) as T;
const settle = (el: Element) =>
  (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;

describe("dm-settings", () => {
  it("shows the signed-in email, signs out, and changes the theme", async () => {
    const { services, api, el } = await setup();
    expect(q(el, "[data-email]").textContent).toBe("a@example.com");
    q<HTMLButtonElement>(el, "button[data-sign-out]").click();
    await vi.waitFor(() => expect(services.router.route).toEqual({ name: "sign-in" }));
    expect((api as never as { logout: ReturnType<typeof vi.fn> }).logout).toHaveBeenCalledTimes(1);
    const select = q<HTMLSelectElement>(el, "select[aria-label='Theme']");
    select.value = "light";
    select.dispatchEvent(new Event("change"));
    expect(services.theme.get()).toBe("light");
  });

  it("asks for the password in a dialog that says the deletion is permanent, and does nothing on Cancel", async () => {
    const { api, el } = await setup();
    q<HTMLButtonElement>(el, "button[data-delete]").click();
    await settle(el);
    const dlg = q<HTMLElement & { open: boolean }>(el, "dm-dialog");
    expect(dlg.open).toBe(true);
    expect(dlg.textContent).toContain("This cannot be undone");
    expect(dlg.textContent).toContain("all your documents and all your chats");
    (dlg.querySelector("button[data-cancel]") as HTMLButtonElement).click();
    await settle(el);
    expect(dlg.open).toBe(false);
    expect(
      (api as never as { deleteAccount: ReturnType<typeof vi.fn> }).deleteAccount,
    ).not.toHaveBeenCalled();
  });

  it("confirms with the password, keeps the receipt in memory only, signs out and goes to the receipt page", async () => {
    const { services, api, el } = await setup();
    q<HTMLButtonElement>(el, "button[data-delete]").click();
    await settle(el);
    const dlg = q<HTMLElement>(el, "dm-dialog");
    const input = dlg.querySelector("input[type=password]") as HTMLInputElement;
    input.value = "my password";
    input.dispatchEvent(new Event("input"));
    await settle(el);
    (dlg.querySelector("button[data-confirm]") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(services.router.route).toEqual({ name: "account-deleted" }));
    expect(
      (api as never as { deleteAccount: ReturnType<typeof vi.fn> }).deleteAccount,
    ).toHaveBeenCalledWith({ password: "my password" });
    expect(services.receipt.get()).toBe(RECEIPT);
    expect(services.auth.get()).toEqual({ status: "anonymous" });
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain(RECEIPT);
    expect(JSON.stringify(Object.entries(sessionStorage))).not.toContain(RECEIPT);
  });

  it.each([
    [new ApiError(401, "invalid_credentials"), "The password is not right."],
    [new ApiError(429, "too_many_requests", 5), "Too many attempts. Try again in 5 seconds."],
    [
      new ApiError(500, "internal"),
      "Something went wrong. The deletion may have been accepted. Use Check status to find out.",
    ],
    [
      new ApiError(0, "network"),
      "Could not reach the server. The deletion may have been accepted. Use Check status to find out.",
    ],
  ])(
    "a refusal (%o) stays in the dialog with a fixed sentence, and the account stays signed in",
    async (err, text) => {
      const { services, el } = await setup({
        deleteAccount: vi.fn(async () => {
          throw err;
        }),
      });
      q<HTMLButtonElement>(el, "button[data-delete]").click();
      await settle(el);
      const dlg = q<HTMLElement>(el, "dm-dialog");
      (dlg.querySelector("input[type=password]") as HTMLInputElement).value = "pw";
      (dlg.querySelector("input[type=password]") as HTMLInputElement).dispatchEvent(
        new Event("input"),
      );
      await settle(el);
      (dlg.querySelector("button[data-confirm]") as HTMLButtonElement).click();
      await vi.waitFor(() =>
        expect(dlg.querySelector("[role=alert]")?.textContent).toContain(text),
      );
      expect(services.auth.get().status).toBe("signed-in");
      expect(services.receipt.get()).toBeUndefined();
      expect((dlg.querySelector("input[type=password]") as HTMLInputElement).value).toBe("");
      expect(dlg.querySelector("input[type=password]")?.getAttribute("aria-invalid")).toBe(
        err.status === 401 ? "true" : "false",
      );
    },
  );

  async function ask(over: Record<string, unknown>) {
    const ctx = await setup(over);
    q<HTMLButtonElement>(ctx.el, "button[data-delete]").click();
    await settle(ctx.el);
    const dlg = q<HTMLElement>(ctx.el, "dm-dialog");
    const input = dlg.querySelector("input[type=password]") as HTMLInputElement;
    input.value = "pw";
    input.dispatchEvent(new Event("input"));
    await settle(ctx.el);
    return { ...ctx, dlg };
  }

  it("a 409 means the deletion is already under way: signs out locally and goes to the receipt page, which has no receipt", async () => {
    const { services, dlg } = await ask({
      deleteAccount: vi.fn(async () => {
        throw new ApiError(409, "erasure_in_progress");
      }),
    });
    (dlg.querySelector("button[data-confirm]") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(services.router.route).toEqual({ name: "account-deleted" }));
    expect(services.auth.get()).toEqual({ status: "anonymous" });
    expect(services.receipt.get()).toBeUndefined();
  });

  it("after a lost answer, Check status tells a signed-in user nothing was deleted, and a signed-out one that it was accepted", async () => {
    let calls = 0;
    const me = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return ME;
      throw new ApiError(401, "unauthorized");
    });
    const { services, dlg, el } = await ask({
      me,
      deleteAccount: vi.fn(async () => {
        throw new ApiError(0, "network");
      }),
    });
    expect(dlg.querySelector("button[data-status]")).toBeNull();
    (dlg.querySelector("button[data-confirm]") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(dlg.querySelector("button[data-status]")).not.toBeNull());
    (dlg.querySelector("button[data-status]") as HTMLButtonElement).click();
    await vi.waitFor(() =>
      expect(dlg.querySelector("[role=alert]")?.textContent).toContain("still active"),
    );
    expect(services.auth.get().status).toBe("signed-in");
    await settle(el);
    (dlg.querySelector("button[data-status]") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(services.router.route).toEqual({ name: "account-deleted" }));
    expect(services.auth.get().status).toBe("anonymous");
  });

  it("ignores a second confirm while one is in flight, and shows Cancel as unavailable", async () => {
    let release: (v: unknown) => void = () => {};
    const deleteAccount = vi.fn(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    const { dlg, el } = await ask({ deleteAccount });
    const confirm = dlg.querySelector("button[data-confirm]") as HTMLButtonElement;
    confirm.click();
    confirm.click();
    await settle(el);
    expect(deleteAccount).toHaveBeenCalledTimes(1);
    expect(dlg.querySelector("button[data-cancel]")?.getAttribute("aria-disabled")).toBe("true");
    (dlg.querySelector("button[data-cancel]") as HTMLButtonElement).click();
    await settle(el);
    expect((dlg as HTMLElement & { open: boolean }).open).toBe(true);
    release({ erasure: "accepted", receipt: RECEIPT });
  });

  it("submits from the form (Enter) through the same single path as the button", async () => {
    const { dlg, api } = await ask({});
    const form = dlg.querySelector("form") as HTMLFormElement;
    expect((dlg.querySelector("button[data-confirm]") as HTMLElement).getAttribute("form")).toBe(
      form.id,
    );
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() =>
      expect(
        (api as never as { deleteAccount: ReturnType<typeof vi.fn> }).deleteAccount,
      ).toHaveBeenCalledTimes(1),
    );
  });
});
