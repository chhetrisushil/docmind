import { POLICIES, SESSION_COOKIE, accountKey } from "@docmind/auth";
import { DeleteAccountResponse, ErasureInProgressBody, ErrorBody } from "@docmind/contracts";
import { describe, expect, it, vi } from "vitest";
import type { AccountErasure } from "../erasure/account";
import { hashReceipt } from "../erasure/receipt";
import { serveMemoryAuth, useServers } from "./testing";

const EMAIL = "ada@example.com";
const PASSWORD = "correct horse battery";

const serve = useServers();

async function start(erasure: AccountErasure | undefined) {
  const api = await serveMemoryAuth(serve, erasure);
  await api.service.signUp(EMAIL, PASSWORD);
  const started = await api.service.logIn(EMAIL, PASSWORD);
  if (!started) throw new Error("login failed");
  const cookie = `${SESSION_COOKIE}=${started.token}`;
  const del = (body: unknown, headers: Record<string, string> = {}, withCookie = true) =>
    fetch(`${api.base}/api/me`, {
      method: "DELETE",
      headers: { "content-type": "application/json", ...(withCookie && { cookie }), ...headers },
      body: JSON.stringify(body),
    });
  const me = () => fetch(`${api.base}/api/me`, { headers: { cookie } });
  return { ...api, started, del, me };
}

function fakeErasure() {
  const calls: string[] = [];
  const erasure: AccountErasure = {
    request: vi.fn(async (_identity, _receiptHash) => {
      calls.push("request");
      return true;
    }),
    start: vi.fn(() => void calls.push("start")),
    status: vi.fn(async () => null),
  };
  return { erasure, calls };
}

describe("DELETE /api/me", () => {
  it("is not a route without an erasure wiring", async () => {
    const api = await start(undefined);
    expect((await api.del({ password: PASSWORD })).status).toBe(404);
  });

  it("needs a session", async () => {
    const { erasure } = fakeErasure();
    const api = await start(erasure);
    const res = await api.del({ password: PASSWORD }, {}, false);
    expect(res.status).toBe(401);
    expect(ErrorBody.parse(await res.json()).error.code).toBe("unauthorized");
    expect(erasure.request).not.toHaveBeenCalled();
  });

  it("refuses a body without a password", async () => {
    const { erasure } = fakeErasure();
    const api = await start(erasure);
    expect((await api.del({})).status).toBe(400);
    expect((await api.del({ password: "" })).status).toBe(400);
    expect(erasure.request).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin write before it reads anything", async () => {
    const { erasure } = fakeErasure();
    const api = await start(erasure);
    const res = await api.del({ password: PASSWORD }, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(erasure.request).not.toHaveBeenCalled();
  });

  it("a wrong password is 401 invalid_credentials, erases nothing, and leaves the session valid", async () => {
    const { erasure } = fakeErasure();
    const api = await start(erasure);
    const res = await api.del({ password: "not the password" });
    expect(res.status).toBe(401);
    expect(ErrorBody.parse(await res.json()).error.code).toBe("invalid_credentials");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(erasure.request).not.toHaveBeenCalled();
    expect(erasure.start).not.toHaveBeenCalled();
    expect((await api.me()).status).toBe(200);
  });

  it("the right password: requests the erasure, then starts it, answers 202 and clears the cookie", async () => {
    const { erasure, calls } = fakeErasure();
    const api = await start(erasure);
    const res = await api.del({ password: PASSWORD });
    expect(res.status).toBe(202);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = DeleteAccountResponse.parse(await res.json());
    expect(body.erasure).toBe("accepted");
    expect(body.receipt).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${SESSION_COOKIE}=;`);
    expect(cookie).toContain("Max-Age=0");
    expect(calls).toEqual(["request", "start"]);
    // The request gets the HASH of the receipt, never the token.
    expect(erasure.request).toHaveBeenCalledWith(api.started.identity, hashReceipt(body.receipt));
    expect(erasure.start).toHaveBeenCalledWith(api.started.identity.userId);
  });

  it("erases the session's own user only: a body naming another user changes nothing", async () => {
    const { erasure } = fakeErasure();
    const api = await start(erasure);
    const res = await api.del({
      password: PASSWORD,
      userId: "22222222-2222-4222-8222-222222222222",
      tenantId: "33333333-3333-4333-8333-333333333333",
    });
    expect(res.status).toBe(202);
    expect(erasure.request).toHaveBeenCalledWith(api.started.identity, expect.any(Buffer));
    expect(erasure.start).toHaveBeenCalledWith(api.started.identity.userId);
  });

  it("gives every erasure a fresh receipt, and neither stores nor logs the token", async () => {
    const out = ["log", "error", "warn", "info"].map((m) =>
      vi.spyOn(console, m as "log").mockImplementation(() => {}),
    );
    const { erasure } = fakeErasure();
    const api = await start(erasure);
    const first = DeleteAccountResponse.parse(await (await api.del({ password: PASSWORD })).json());
    const second = DeleteAccountResponse.parse(
      await (await api.del({ password: PASSWORD })).json(), // the fake keeps the session
    );
    expect(first.receipt).not.toBe(second.receipt);
    for (const call of vi.mocked(erasure.request).mock.calls) {
      const hash = call[1];
      expect(hash).toHaveLength(32);
      expect(hash.toString("base64url")).not.toBe(first.receipt);
    }
    expect(JSON.stringify(out.flatMap((s) => s.mock.calls))).not.toContain(first.receipt);
    for (const s of out) s.mockRestore();
  });

  it("clears the email's sign-up counter BEFORE it records the request (the email is replaced in that transaction)", async () => {
    const { erasure } = fakeErasure();
    const api = await start(erasure);
    const signUpKey = accountKey("signup", EMAIL);
    for (let i = 0; i < POLICIES.signUpAccount.free + 2; i++)
      await api.throttle.fail(signUpKey, POLICIES.signUpAccount);
    expect(await api.throttle.retryAfter([signUpKey])).toBeGreaterThan(0);
    let lockedAtRequest = -1;
    vi.mocked(erasure.request).mockImplementation(async () => {
      lockedAtRequest = await api.throttle.retryAfter([signUpKey]);
      return true;
    });
    expect((await api.del({ password: PASSWORD })).status).toBe(202);
    expect(lockedAtRequest).toBe(0); // already cleared when the request was made
    expect(await api.throttle.retryAfter([signUpKey])).toBe(0);
  });

  it("clears the email's login counter BEFORE it records the request", async () => {
    const { erasure } = fakeErasure();
    const api = await start(erasure);
    const loginKey = accountKey("login", EMAIL);
    for (let i = 0; i < 3; i++) await api.throttle.fail(loginKey, POLICIES.loginAccount);
    let guessesToLock = -1;
    vi.mocked(erasure.request).mockImplementation(async () => {
      // How many more failures until the counter locks: the full free allowance plus one means it was cleared.
      guessesToLock = 0;
      while ((await api.throttle.retryAfter([loginKey])) === 0 && guessesToLock < 50) {
        await api.throttle.fail(loginKey, POLICIES.loginAccount);
        guessesToLock++;
      }
      return true;
    });
    expect((await api.del({ password: PASSWORD })).status).toBe(202);
    expect(guessesToLock).toBe(POLICIES.loginAccount.free + 1);
  });

  it("answers 409 and starts nothing when a request already exists (the receipt was not stored)", async () => {
    const { erasure } = fakeErasure();
    vi.mocked(erasure.request).mockResolvedValue(false);
    const api = await start(erasure);
    const res = await api.del({ password: PASSWORD });
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(ErasureInProgressBody.parse(JSON.parse(text)).error.code).toBe("erasure_in_progress");
    expect(text).not.toContain("receipt");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(erasure.start).not.toHaveBeenCalled();
  });

  it("starts nothing when the request cannot be recorded, and does not claim success", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { erasure } = fakeErasure();
    erasure.request = vi.fn(async () => {
      throw new RangeError("db down");
    });
    const api = await start(erasure);
    const res = await api.del({ password: PASSWORD });
    expect(res.status).toBe(500);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(erasure.start).not.toHaveBeenCalled();
    expect((await api.me()).status).toBe(200); // still signed in: nothing happened
    errors.mockRestore();
  });

  it("is throttled like login: guesses share the account counter, and a locked caller is not even checked", async () => {
    const { erasure } = fakeErasure();
    const api = await start(erasure);
    for (let i = 0; i < POLICIES.loginAccount.free; i++)
      expect((await api.del({ password: "guess" })).status).toBe(401);
    const locked = await api.del({ password: "guess" });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    // even the right password waits out the lock, and the lock covers login too (one counter)
    expect((await api.del({ password: PASSWORD })).status).toBe(429);
    expect(erasure.request).not.toHaveBeenCalled();
    const login = await fetch(`${api.base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    expect(login.status).toBe(429);
  });

  it("a right password clears the account counter", async () => {
    const { erasure } = fakeErasure();
    const api = await start(erasure);
    for (let i = 0; i < 3; i++) await api.del({ password: "guess" });
    expect((await api.del({ password: PASSWORD })).status).toBe(202);
    for (let i = 0; i < POLICIES.loginAccount.free; i++)
      expect((await api.del({ password: "guess" })).status).toBe(401); // a fresh budget of free guesses
  });
});
