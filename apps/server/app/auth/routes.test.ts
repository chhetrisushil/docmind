import type { AddressInfo } from "node:net";
import { AuthService, POLICIES, SESSION_TTL_MS } from "@docmind/auth";
import { MemoryAuthStore, MemoryThrottle } from "@docmind/auth/testing";
import { ErrorBody, MeResponse, SignUpResponse } from "@docmind/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHttpServer } from "../server";
import { authRoutes } from "./routes";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const PASSWORD = "correct horse battery";

/** A fresh server, store and throttle per test. The clock is fixed, so a lock never runs out. */
async function start(trustProxy = false, secureCookies = false) {
  const store = new MemoryAuthStore();
  const throttle = new MemoryThrottle();
  throttle.now = () => 1_000_000;
  const service = new AuthService(store);
  const server = createHttpServer(authRoutes({ service, throttle, secureCookies, trustProxy }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    store,
    service,
    throttle,
    logIn: (email: string, password = PASSWORD) =>
      fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      }),
    signUp: (email: string, password = PASSWORD, headers: Record<string, string> = {}) =>
      fetch(`${base}/api/auth/sign-up`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ email, password }),
      }),
  };
}

/** Everything a client can see of a response except the Date header. */
async function wire(res: Response) {
  const headers = [...res.headers.entries()].filter(([name]) => name !== "date");
  return { status: res.status, headers, body: await res.text() };
}

describe("sign-up", () => {
  it("answers 202 with no cookie, and creates the account", async () => {
    const api = await start();
    const res = await api.signUp("Ada@Example.com");
    expect(res.status).toBe(202);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(SignUpResponse.parse(await res.json())).toEqual({ status: "accepted" });
    expect((await api.store.findLogin("ada@example.com"))?.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it("answers a new email and a taken one with byte-identical responses", async () => {
    const api = await start();
    const fresh = await wire(await api.signUp("new@example.com"));
    const taken = await wire(await api.signUp("new@example.com", "another long password"));
    expect(taken).toEqual(fresh);
  });

  it("leaves a taken email's password alone", async () => {
    const api = await start();
    await api.signUp("ada@example.com");
    const first = await api.store.findLogin("ada@example.com");
    await api.signUp("ada@example.com", "another long password");
    expect(await api.store.findLogin("ada@example.com")).toEqual(first);
  });

  it("rejects a short password with 400, before anything is counted", async () => {
    const api = await start();
    for (let i = 0; i < 7; i++) await api.signUp("b@example.com", "short");
    expect((await api.signUp("b@example.com", "short")).status).toBe(400);
    expect((await api.signUp("b@example.com")).status).toBe(202);
  });

  it("limits sign-ups per address, then answers 429 with Retry-After", async () => {
    const api = await start();
    for (let i = 0; i < POLICIES.signUpIp.free; i++) await api.signUp(`user${i}@example.com`);
    const res = await api.signUp("next@example.com");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(ErrorBody.parse(await res.json()).error.code).toBe("too_many_requests");
  });

  it("limits sign-ups per email, whether or not it is registered", async () => {
    const api = await start();
    for (let i = 0; i < POLICIES.signUpAccount.free; i++) await api.signUp("same@example.com");
    expect((await api.signUp("same@example.com")).status).toBe(429);
  });

  it("answers 429 identically for a registered and a never-registered email", async () => {
    const lockedOut = async (registered: boolean) => {
      const api = await start();
      if (!registered) api.store.createAccount = async () => true;
      for (let i = 0; i < POLICIES.signUpAccount.free; i++) await api.signUp("e@example.com");
      const res = await api.signUp("e@example.com");
      expect(res.status).toBe(429);
      return wire(res);
    };
    expect(await lockedOut(false)).toEqual(await lockedOut(true));
  });

  it("holds a parallel burst from one address to the limit", async () => {
    const api = await start();
    const sent = Array.from({ length: 20 }, (_, i) => api.signUp(`burst${i}@example.com`));
    const statuses = (await Promise.all(sent)).map((r) => r.status);
    const accepted = statuses.filter((s) => s === 202).length;
    expect(accepted).toBeLessThanOrEqual(POLICIES.signUpIp.free);
    expect(statuses.filter((s) => s === 429)).toHaveLength(20 - accepted);
  });

  it("ignores X-Forwarded-For unless the proxy is trusted", async () => {
    const spoofed = await start(false);
    for (let i = 0; i < POLICIES.signUpIp.free; i++) {
      await spoofed.signUp(`u${i}@example.com`, PASSWORD, { "x-forwarded-for": `10.0.0.${i}` });
    }
    const blocked = await spoofed.signUp("v@example.com", PASSWORD, {
      "x-forwarded-for": "10.9.9.9",
    });
    expect(blocked.status).toBe(429);

    const proxied = await start(true);
    for (let i = 0; i < POLICIES.signUpIp.free + 2; i++) {
      const res = await proxied.signUp(`u${i}@example.com`, PASSWORD, {
        "x-forwarded-for": `10.0.0.${i}`,
      });
      expect(res.status).toBe(202);
    }
  });
});

const WRONG = "wrong password here";

describe("login", () => {
  it("logs in after sign-up, with an HttpOnly session cookie", async () => {
    const api = await start();
    await api.signUp("Ada@Example.com");
    const res = await api.logIn("ada@example.com");
    expect(res.status).toBe(200);
    expect(MeResponse.parse(await res.json()).email).toBe("ada@example.com");
    expect(res.headers.get("set-cookie")).toMatch(/^dm_session=[\w-]{43}; /);
  });

  it("sets the cookie attributes, with Secure only from the config option", async () => {
    for (const secure of [false, true]) {
      const api = await start(false, secure);
      await api.signUp("ada@example.com");
      const cookie = (await api.logIn("ada@example.com")).headers.get("set-cookie") ?? "";
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain(`Max-Age=${SESSION_TTL_MS / 1000}`);
      expect(/; Secure(;|$)/.test(cookie)).toBe(secure);
    }
  });

  it("answers the same 401 for a wrong password and an unknown email", async () => {
    const api = await start();
    await api.signUp("ada@example.com");
    const wrong = await wire(await api.logIn("ada@example.com", WRONG));
    const unknown = await wire(await api.logIn("nobody@example.com"));
    expect(wrong.status).toBe(401);
    expect(unknown).toEqual(wrong);
    expect(wrong.headers.some(([name]) => name === "set-cookie")).toBe(false);
  });

  it("allows loginAccount.free wrong guesses for an email, then answers 429", async () => {
    const api = await start();
    await api.signUp("ada@example.com");
    for (let i = 0; i < POLICIES.loginAccount.free; i++) {
      expect((await api.logIn("ada@example.com", WRONG)).status).toBe(401);
    }
    const next = await api.logIn("ada@example.com", WRONG);
    expect(next.status).toBe(429);
    expect(Number(next.headers.get("retry-after"))).toBeGreaterThan(0);
    // The right password does not help while the lock lasts.
    expect((await api.logIn("ada@example.com")).status).toBe(429);
  });

  it("answers a locked email that exists exactly like one that does not", async () => {
    const api = await start();
    await api.signUp("ada@example.com");
    const lockOut = async (email: string) => {
      for (let i = 0; i < POLICIES.loginAccount.free; i++) await api.logIn(email, WRONG);
      return wire(await api.logIn(email, WRONG));
    };
    const known = await lockOut("ada@example.com");
    const unknown = await lockOut("nobody@example.com");
    expect(known.status).toBe(429);
    expect(unknown).toEqual(known);
  });

  it("forgets an email's count after a success, but not the address's", async () => {
    const api = await start();
    await api.signUp("ada@example.com");
    const spy = vi.spyOn(api.throttle, "clear");
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < POLICIES.loginAccount.free - 1; i++) {
        await api.logIn("ada@example.com", WRONG);
      }
      expect((await api.logIn("ada@example.com")).status).toBe(200);
    }
    expect(spy).toHaveBeenCalledTimes(2);
    // 8 wrong guesses came from this address (the successes did not reset them): 13 more pass
    // loginIp.free (20), and the next caller is locked.
    for (let i = 0; i < POLICIES.loginIp.free - 7; i++)
      await api.logIn(`other${i}@example.com`, WRONG);
    expect((await api.logIn("fresh@example.com", WRONG)).status).toBe(429);
  });

  it("locks a client address after loginIp.free failed logins, whatever emails it tries", async () => {
    const api = await start();
    // The address is counted after a failed check, so the first free + 1 failures answer 401.
    for (let i = 0; i < POLICIES.loginIp.free + 1; i++) {
      expect((await api.logIn(`user${i}@example.com`)).status).toBe(401);
    }
    expect((await api.logIn("another@example.com")).status).toBe(429);
  });

  it("lets only loginAccount.free of a concurrent burst reach the password check", async () => {
    // MemoryThrottle has no real awaits, so this guards the count-first contract, not a race.
    const api = await start();
    await api.signUp("ada@example.com");
    const spy = vi.spyOn(api.service, "logIn");
    const sent = Array.from({ length: 15 }, () => api.logIn("ada@example.com", WRONG));
    const statuses = (await Promise.all(sent)).map((r) => r.status);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(POLICIES.loginAccount.free);
    expect(statuses.filter((s) => s === 401)).toHaveLength(spy.mock.calls.length);
    expect(statuses.filter((s) => s === 429)).toHaveLength(15 - spy.mock.calls.length);
  });
});
