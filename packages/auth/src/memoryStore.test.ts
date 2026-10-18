import { describe, expect, it } from "vitest";
import { MemoryAuthStore } from "./memoryStore";

const alice = { tenantId: "t1", userId: "u1" };
const account = { ...alice, email: "a@example.com", passwordHash: "hash" };
const session = { ...alice, tokenHash: "h1", expiresAt: new Date(Date.now() + 60_000) };

describe("MemoryAuthStore", () => {
  it("creates an account once per email and finds it by email and by identity", async () => {
    const store = new MemoryAuthStore();
    expect(await store.createAccount(account)).toBe(true);
    expect(await store.createAccount({ ...account, userId: "u2" })).toBe(false);
    expect(await store.findLogin("a@example.com")).toEqual({
      tenantId: "t1",
      userId: "u1",
      passwordHash: "hash",
    });
    expect(await store.findLogin("b@example.com")).toBeNull();
    expect(await store.findEmail(alice)).toBe("a@example.com");
    expect(await store.findEmail({ ...alice, tenantId: "t2" })).toBeNull();
  });

  it("finds a session until it expires", async () => {
    const store = new MemoryAuthStore();
    await store.createSession(session);
    expect(await store.findSession("h1")).toEqual(alice);
    store.now = () => new Date(session.expiresAt.getTime() + 1);
    expect(await store.findSession("h1")).toBeNull();
  });

  it("stores copies, so later caller mutation does not change the store", async () => {
    const store = new MemoryAuthStore();
    const mutable = { ...account };
    await store.createAccount(mutable);
    mutable.passwordHash = "changed";
    expect(await store.findLogin("a@example.com")).toEqual({
      tenantId: "t1",
      userId: "u1",
      passwordHash: "hash",
    });

    const s = { ...session, tokenHash: "h2", expiresAt: new Date(session.expiresAt) };
    await store.createSession(s);
    s.expiresAt.setTime(0);
    expect(await store.findSession("h2")).toEqual(alice);
  });

  it("ends a session only for the tenant that owns it", async () => {
    const store = new MemoryAuthStore();
    await store.createSession(session);
    await store.deleteSession({ tenantId: "t2", userId: "u9" }, "h1");
    expect(await store.findSession("h1")).toEqual(alice);
    await store.deleteSession(alice, "h1");
    expect(await store.findSession("h1")).toBeNull();
  });
});
