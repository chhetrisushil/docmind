import { describe, expect, it } from "vitest";
import { hashToken, newSessionToken } from "./session";

describe("session tokens", () => {
  it("are 256 random bits in a cookie-safe alphabet, never repeated", () => {
    const a = newSessionToken();
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newSessionToken().token).not.toBe(a.token);
  });

  it("are stored as a hash that cannot be used as the cookie", () => {
    const { token, tokenHash } = newSessionToken();
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).not.toBe(token);
    expect(hashToken(token)).toBe(tokenHash);
  });
});
