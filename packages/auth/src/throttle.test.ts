import { describe, expect, it } from "vitest";
import { POLICIES, accountKey, ipKey, lockSeconds } from "./throttle";

describe("throttle policy", () => {
  it("is free up to the allowance, then doubles up to the cap", () => {
    const p = POLICIES.loginAccount;
    const locks = [5, 6, 7, 8, 9, 20].map((n) => lockSeconds(p, n));
    expect(locks).toEqual([0, 2, 4, 8, 16, 900]);
  });

  it("keys an account by a hash of its email, the same for any case-normalised email", () => {
    expect(accountKey("login", "a@example.com")).toBe(accountKey("login", "a@example.com"));
    expect(accountKey("login", "a@example.com")).not.toContain("a@example.com");
    expect(accountKey("login", "a@example.com")).not.toBe(accountKey("signup", "a@example.com"));
    expect(ipKey("login", "203.0.113.9")).toBe("login-ip:203.0.113.9");
  });
});
