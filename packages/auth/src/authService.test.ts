import { describe, expect, it } from "vitest";
import { AuthService } from "./authService";
import { SESSION_COOKIE } from "./cookie";
import { MemoryAuthStore } from "./memoryStore";
import { PasswordAuthenticator } from "./passwordAuthenticator";

const EMAIL = "ada@example.com";
const PASSWORD = "correct horse battery";

function setup() {
  const store = new MemoryAuthStore();
  const authenticator = new PasswordAuthenticator(store);
  const whoIs = (token: string) =>
    authenticator.authenticate({ headers: { cookie: `${SESSION_COOKIE}=${token}` } });
  return { store, service: new AuthService(store), whoIs };
}

describe("AuthService", () => {
  it("signs up with only an argon2id hash stored, starting no session", async () => {
    const { store, service } = setup();
    expect(await service.signUp(EMAIL, PASSWORD)).toBe(true);
    const stored = await store.findLogin(EMAIL);
    expect(stored?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(stored)).not.toContain(PASSWORD);
  });

  it("refuses a second sign-up with the same email and keeps the first password", async () => {
    const { service } = setup();
    await service.signUp(EMAIL, PASSWORD);
    expect(await service.signUp(EMAIL, "another long password")).toBe(false);
    expect(await service.logIn(EMAIL, PASSWORD)).not.toBeNull();
    expect(await service.logIn(EMAIL, "another long password")).toBeNull();
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

  it("answers null for a wrong password and for an unknown email", async () => {
    const { service } = setup();
    await service.signUp(EMAIL, PASSWORD);
    expect(await service.logIn(EMAIL, "wrong password here")).toBeNull();
    expect(await service.logIn("nobody@example.com", PASSWORD)).toBeNull();
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
});
