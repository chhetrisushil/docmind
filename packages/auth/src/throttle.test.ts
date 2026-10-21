import { describe, expect, it } from "vitest";
import { POLICIES, accountKey, ipKey, lockSeconds, throttleAddress } from "./throttle";

describe("throttle policy", () => {
  it("has an erasure-status scope of its own, per IP, generous enough to poll", () => {
    expect(ipKey("erasure", "203.0.113.9")).toBe("erasure-ip:203.0.113.9");
    expect(ipKey("erasure", "203.0.113.9")).not.toBe(ipKey("login", "203.0.113.9"));
    expect(POLICIES.erasureStatusIp.free).toBeGreaterThanOrEqual(60); // a client polling every second for a minute
    expect(lockSeconds(POLICIES.erasureStatusIp, POLICIES.erasureStatusIp.free)).toBe(0);
    expect(
      lockSeconds(POLICIES.erasureStatusIp, POLICIES.erasureStatusIp.free + 1),
    ).toBeGreaterThan(0);
  });

  it("is free up to the allowance, then doubles up to the cap", () => {
    const p = POLICIES.loginAccount;
    const locks = [5, 6, 7, 8, 9, 20].map((n) => lockSeconds(p, n));
    expect(locks).toEqual([0, 2, 4, 8, 16, 900]);
  });

  it("keys an account by a hash of its email, the same for any case-normalised email", () => {
    expect(accountKey("login", "A@Example.com ")).toBe(accountKey("login", "a@example.com"));
    expect(accountKey("login", "a@example.com")).not.toContain("a@example.com");
    expect(accountKey("login", "a@example.com")).not.toBe(accountKey("signup", "a@example.com"));
    expect(ipKey("login", "203.0.113.9")).toBe("login-ip:203.0.113.9");
  });

  it("counts an IPv6 client per /64, and an IPv4-mapped one as its IPv4", () => {
    expect(ipKey("login", "2001:db8:0:1:aaaa::1")).toBe(ipKey("login", "2001:db8:0:1:ffff::2"));
    expect(ipKey("login", "2001:db8:0:1::1")).not.toBe(ipKey("login", "2001:db8:0:2::1"));
    expect(throttleAddress("2001:DB8:0:1::1")).toBe("2001:db8:0:1::/64");
    expect(ipKey("login", "::ffff:203.0.113.9")).toBe("login-ip:203.0.113.9");
    expect(throttleAddress("203.0.113.9")).toBe("203.0.113.9");
  });

  it("never overflows: every policy's lock is its cap at a huge failure count", () => {
    for (const p of Object.values(POLICIES)) {
      expect(lockSeconds(p, 1e6)).toBe(p.capSeconds);
    }
    expect(POLICIES.signUpAccount.capSeconds).toBe(3600);
  });
});
