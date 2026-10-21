import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/http";
import { Router } from "../router";
import { createServices } from "../services";
import { AuthStore } from "../state/auth";
import { mountWith } from "../testing/mount";
import "./dm-auth-form";

const ME = {
  userId: "0b4f7d52-6c53-4c6e-9d49-2b0e7a3f9a10",
  tenantId: "7f6d1b8e-3b0a-4a56-8f2f-0a8e0f7c4d11",
  email: "a@example.com",
};
function routerAt(path: string) {
  const win = {
    location: { pathname: path, search: "" },
    history: {
      pushState: (_s: unknown, _t: string, u: string) => {
        win.location.pathname = u;
      },
      replaceState: (_s: unknown, _t: string, u: string) => {
        win.location.pathname = u;
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return { router: new Router(win as never), win };
}
function setup(over: Record<string, unknown> = {}, path = "/sign-in") {
  const api = {
    me: vi.fn(async () => ME),
    login: vi.fn(async () => ME),
    logout: vi.fn(async () => {}),
    signUp: vi.fn(async () => {}),
    ...over,
  } as never;
  const auth = new AuthStore(api);
  const { router, win } = routerAt(path);
  const services = createServices({
    api,
    auth,
    router,
    fetch: (async () => new Response("{}")) as never,
  });
  return { services, auth, api, win };
}
const root = (el: Element) => el.shadowRoot as ShadowRoot;
const q = <T extends Element>(el: Element, sel: string) => root(el).querySelector(sel) as T;
const settle = (el: Element) =>
  (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
async function fill(el: HTMLElement, email: string, password: string) {
  q<HTMLInputElement>(el, "input[type=email]").value = email;
  q<HTMLInputElement>(el, "input[name=password]").value = password;
  q<HTMLInputElement>(el, "input[type=email]").dispatchEvent(new Event("input"));
  q<HTMLInputElement>(el, "input[name=password]").dispatchEvent(new Event("input"));
}

describe("dm-auth-form: sign in", () => {
  it("labels its fields, submits the credentials, and goes to the chats", async () => {
    const { services, api } = setup();
    const el = await mountWith<HTMLElement>(services, "dm-auth-form", { mode: "sign-in" });
    expect(q(el, "label[for=email]").textContent).toBe("Email");
    expect(q(el, "h1").textContent).toBe("Sign in");
    await fill(el, "a@example.com", "pw");
    q<HTMLFormElement>(el, "form").dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(services.router.route).toEqual({ name: "chat" }));
    expect((api as never as { login: ReturnType<typeof vi.fn> }).login).toHaveBeenCalledWith({
      email: "a@example.com",
      password: "pw",
    });
  });

  it("shows a fixed sentence for a wrong password, marks the field invalid, and never the server's text", async () => {
    const { services } = setup({
      login: vi.fn(async () => {
        throw new ApiError(401, "invalid_credentials");
      }),
    });
    const el = await mountWith<HTMLElement>(services, "dm-auth-form", { mode: "sign-in" });
    await fill(el, "a@example.com", "nope");
    q<HTMLFormElement>(el, "form").dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() =>
      expect(q(el, "[role=alert]")?.textContent).toContain("The email or password is not right."),
    );
    expect(q(el, "input[name=password]").getAttribute("aria-invalid")).toBe("true");
    expect(services.router.route).toEqual({ name: "sign-in" });
  });

  it("clears the password after a failed attempt and keeps it out of the address", async () => {
    const { services, win } = setup({
      login: vi.fn(async () => {
        throw new ApiError(401, "invalid_credentials");
      }),
    });
    const el = await mountWith<HTMLElement>(services, "dm-auth-form", { mode: "sign-in" });
    await fill(el, "a@example.com", "hunter2-secret");
    const ev = new Event("submit", { cancelable: true });
    q<HTMLFormElement>(el, "form").dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(q(el, "[role=alert]")).not.toBeNull());
    await settle(el);
    expect(q<HTMLInputElement>(el, "input[name=password]").value).toBe("");
    expect(win.location.pathname).toBe("/sign-in");
    expect(root(el).textContent).not.toContain("hunter2-secret");
  });

  it("asks the browser for the right autofill hints", async () => {
    const { services } = setup();
    const inn = await mountWith<HTMLElement>(services, "dm-auth-form", { mode: "sign-in" });
    expect(q(inn, "input[type=email]").getAttribute("autocomplete")).toBe("email");
    expect(q(inn, "input[name=password]").getAttribute("autocomplete")).toBe("current-password");
    const up = await mountWith<HTMLElement>(services, "dm-auth-form", { mode: "sign-up" });
    expect(q(up, "input[name=password]").getAttribute("autocomplete")).toBe("new-password");
  });

  it("says how long to wait when throttled, and names no account", async () => {
    const { services } = setup({
      login: vi.fn(async () => {
        throw new ApiError(429, "too_many_requests", 7);
      }),
    });
    const el = await mountWith<HTMLElement>(services, "dm-auth-form", { mode: "sign-in" });
    await fill(el, "a@example.com", "pw");
    q<HTMLFormElement>(el, "form").dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() =>
      expect(q(el, "[role=alert]")?.textContent).toContain("Try again in 7 seconds."),
    );
    expect(q(el, "[role=alert]").textContent).not.toContain("a@example.com");
  });

  it("lets the password be shown and hidden, with a name on the toggle", async () => {
    const { services } = setup();
    const el = await mountWith<HTMLElement>(services, "dm-auth-form", { mode: "sign-in" });
    const toggle = q<HTMLButtonElement>(el, "button[aria-label='Show password']");
    toggle.click();
    await settle(el);
    expect(q<HTMLInputElement>(el, "input[name=password]").type).toBe("text");
    expect(q(el, "button[aria-label='Hide password']")).not.toBeNull();
  });
});

describe("dm-auth-form: sign up", () => {
  it("states the 12-character rule, refuses a short password before calling the server, then signs in", async () => {
    const { services, api } = setup();
    const el = await mountWith<HTMLElement>(services, "dm-auth-form", { mode: "sign-up" });
    expect(q(el, "h1").textContent).toBe("Create your account");
    expect(root(el).textContent).toContain("At least 12 characters");
    await fill(el, "a@example.com", "short");
    q<HTMLFormElement>(el, "form").dispatchEvent(new Event("submit", { cancelable: true }));
    await settle(el);
    expect(q(el, "[role=alert]").textContent).toContain("At least 12 characters");
    expect((api as never as { signUp: ReturnType<typeof vi.fn> }).signUp).not.toHaveBeenCalled();
    await fill(el, "a@example.com", "a long enough password");
    q<HTMLFormElement>(el, "form").dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(services.router.route).toEqual({ name: "chat" }));
  });

  it("when the sign-in after sign-up fails (the address may already be registered) it says so without saying which", async () => {
    const { services } = setup({
      login: vi.fn(async () => {
        throw new ApiError(401, "invalid_credentials");
      }),
    });
    const el = await mountWith<HTMLElement>(services, "dm-auth-form", { mode: "sign-up" });
    await fill(el, "a@example.com", "a long enough password");
    q<HTMLFormElement>(el, "form").dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() =>
      expect(q(el, "[role=alert]")?.textContent).toContain("We could not sign you in."),
    );
    expect(q(el, "[role=alert]").textContent).toContain(
      "If you already have an account, sign in instead.",
    );
    await settle(el);
    expect(q<HTMLInputElement>(el, "input[name=password]").value).toBe("");
  });

  it("links between the two modes", async () => {
    const { services } = setup();
    const el = await mountWith<HTMLElement>(services, "dm-auth-form", { mode: "sign-in" });
    expect(q<HTMLAnchorElement>(el, "a[href='/sign-up']")).not.toBeNull();
    const up = await mountWith<HTMLElement>(services, "dm-auth-form", { mode: "sign-up" });
    expect(q<HTMLAnchorElement>(up, "a[href='/sign-in']")).not.toBeNull();
  });
});
