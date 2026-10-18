import { describe, expect, it } from "vitest";
import { SESSION_COOKIE, readSessionCookie } from "./cookie";
import { MemoryAuthStore } from "./memoryStore";
import { PasswordAuthenticator } from "./passwordAuthenticator";
import { SESSION_TTL_MS, hashToken, newSessionToken } from "./session";
import { type AuthenticatorHarness, runAuthenticatorConformance } from "./testing";

const cookieFor = (token: string) => ({ cookie: `other=1; ${SESSION_COOKIE}=${token}` });

function setup() {
  const store = new MemoryAuthStore();
  const owners = new Map<string, { tenantId: string; userId: string }>();
  const harness: AuthenticatorHarness = {
    authenticator: new PasswordAuthenticator(store),
    async issue(identity) {
      const { token, tokenHash } = newSessionToken();
      owners.set(token, identity);
      await store.createSession({
        ...identity,
        tokenHash,
        expiresAt: new Date(store.now().getTime() + SESSION_TTL_MS),
      });
      return cookieFor(token);
    },
    async revoke(headers) {
      const token = readSessionCookie(headers) ?? "";
      await store.deleteSession(
        owners.get(token) ?? { tenantId: "", userId: "" },
        hashToken(token),
      );
    },
    forged: () => cookieFor(newSessionToken().token),
  };
  return { store, harness };
}

runAuthenticatorConformance(() => setup().harness, "PasswordAuthenticator");

describe("PasswordAuthenticator", () => {
  const alice = { tenantId: "t1", userId: "u1" };

  it("rejects a session that has expired", async () => {
    const { store, harness } = setup();
    const headers = await harness.issue(alice);
    expect(await harness.authenticator.authenticate({ headers })).toEqual(alice);
    store.now = () => new Date(Date.now() + SESSION_TTL_MS + 1000);
    expect(await harness.authenticator.authenticate({ headers })).toBeNull();
  });

  it("does not consult the store for a cookie that cannot be a real token", async () => {
    const { store, harness } = setup();
    store.findSession = async () => {
      throw new Error("store consulted");
    };
    const headers = { cookie: `${SESSION_COOKIE}=junk` };
    expect(await harness.authenticator.authenticate({ headers })).toBeNull();
  });
});
