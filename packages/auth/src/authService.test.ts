import argon2 from "argon2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthService } from "./authService";
import { SESSION_COOKIE } from "./cookie";
import { MemoryAuthStore } from "./memoryStore";
import { PasswordAuthenticator } from "./passwordAuthenticator";
import { SESSION_TTL_MS, hashToken } from "./session";
import type { AuthStore, NewSession } from "./store";

const EMAIL = "ada@example.com";
const PASSWORD = "correct horse battery";
const STORE_METHODS = [
  "findLogin",
  "createAccount",
  "createSession",
  "findSession",
  "findEmail",
  "deleteSession",
] as const;

function setup() {
  const store = new MemoryAuthStore();
  const authenticator = new PasswordAuthenticator(store);
  const whoIs = (token: string) =>
    authenticator.authenticate({ headers: { cookie: `${SESSION_COOKIE}=${token}` } });
  return { store, service: new AuthService(store), whoIs };
}

/** Spies on every AuthStore method, so a test can count the store calls a path makes. */
function countStoreCalls(store: AuthStore) {
  const spies = Object.fromEntries(
    STORE_METHODS.map((name) => [name, vi.spyOn(store, name)]),
  ) as Record<(typeof STORE_METHODS)[number], ReturnType<typeof vi.spyOn>>;
  const total = () => Object.values(spies).reduce((n, spy) => n + spy.mock.calls.length, 0);
  return { spies, total };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AuthService", () => {
  it("signs up with only an argon2id hash stored, starting no session", async () => {
    const { store, service } = setup();
    const { spies } = countStoreCalls(store);
    expect(await service.signUp(EMAIL, PASSWORD)).toBe(true);
    const stored = await store.findLogin(EMAIL);
    expect(stored?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(stored)).not.toContain(PASSWORD);
    expect(spies.createSession).not.toHaveBeenCalled();
  });

  it("refuses a second sign-up with the same email and keeps the first password", async () => {
    const { service } = setup();
    await service.signUp(EMAIL, PASSWORD);
    expect(await service.signUp(EMAIL, "another long password")).toBe(false);
    expect(await service.logIn(EMAIL, PASSWORD)).not.toBeNull();
    expect(await service.logIn(EMAIL, "another long password")).toBeNull();
  });

  it("does the same store and hash work for a new email and a taken one", async () => {
    const { store, service } = setup();
    const hash = vi.spyOn(argon2, "hash");
    const { spies, total } = countStoreCalls(store);

    await service.signUp(EMAIL, PASSWORD);
    expect(hash).toHaveBeenCalledTimes(1);
    expect(spies.createAccount).toHaveBeenCalledTimes(1);
    expect(total()).toBe(1);

    hash.mockClear();
    for (const spy of Object.values(spies)) spy.mockClear();
    await service.signUp(EMAIL, "another long password");
    expect(hash).toHaveBeenCalledTimes(1);
    expect(spies.createAccount).toHaveBeenCalledTimes(1);
    expect(total()).toBe(1);
  });

  it("logs in as the signed-up user, on a new session each time", async () => {
    const { service, whoIs } = setup();
    await service.signUp(EMAIL, PASSWORD);
    const first = await service.logIn(EMAIL, PASSWORD);
    const again = await service.logIn(EMAIL, PASSWORD);
    expect(again?.identity).toEqual(first?.identity);
    expect(again?.token).not.toBe(first?.token);
    expect(await whoIs(again?.token ?? "")).toEqual(first?.identity);
  });

  it("stores only the token hash, and the session expires after its TTL", async () => {
    const { store, service, whoIs } = setup();
    const { spies } = countStoreCalls(store);
    await service.signUp(EMAIL, PASSWORD);
    const started = await service.logIn(EMAIL, PASSWORD);
    if (!started) throw new Error("setup failed");

    const stored = spies.createSession.mock.calls[0]?.[0] as NewSession | undefined;
    expect(stored?.tokenHash).toBe(hashToken(started.token));
    expect(stored?.tokenHash).not.toBe(started.token);

    store.now = () => new Date(Date.now() + SESSION_TTL_MS + 1);
    expect(await whoIs(started.token)).toBeNull();
  });

  it("answers null for a wrong password and for an unknown email", async () => {
    const { service } = setup();
    await service.signUp(EMAIL, PASSWORD);
    expect(await service.logIn(EMAIL, "wrong password here")).toBeNull();
    expect(await service.logIn("nobody@example.com", PASSWORD)).toBeNull();
  });

  it("does one store lookup and one password check for a wrong password and for an unknown email", async () => {
    const { store, service } = setup();
    await service.signUp(EMAIL, PASSWORD);
    const verify = vi.spyOn(argon2, "verify");
    const { spies } = countStoreCalls(store);

    expect(await service.logIn(EMAIL, "wrong password here")).toBeNull();
    expect(spies.findLogin).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);

    verify.mockClear();
    spies.findLogin.mockClear();
    expect(await service.logIn("nobody@example.com", PASSWORD)).toBeNull();
    expect(spies.findLogin).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("ends only the session it is asked to end", async () => {
    const { service, whoIs } = setup();
    await service.signUp(EMAIL, PASSWORD);
    const a = await service.logIn(EMAIL, PASSWORD);
    const b = await service.logIn(EMAIL, PASSWORD);
    if (!a || !b) throw new Error("setup failed");
    await service.logOut(a.identity, a.token);
    expect(await whoIs(a.token)).toBeNull();
    expect(await whoIs(b.token)).toEqual(b.identity);
  });

  it("logs out an unknown or garbage token without throwing or deleting anything", async () => {
    const { service, whoIs } = setup();
    await service.signUp(EMAIL, PASSWORD);
    const live = await service.logIn(EMAIL, PASSWORD);
    if (!live) throw new Error("setup failed");
    const nobody = { tenantId: "no-tenant", userId: "no-user" };
    await expect(service.logOut(nobody, "not-a-real-token")).resolves.toBeUndefined();
    await expect(service.logOut(live.identity, "garbage")).resolves.toBeUndefined();
    expect(await whoIs(live.token)).toEqual(live.identity);
  });
});
