import { describe, expect, it } from "vitest";
import { SESSION_COOKIE, clearedSessionCookie, readSessionCookie, sessionCookie } from "./cookie";

describe("session cookie", () => {
  it("reads its own cookie among others, and nothing from a look-alike name", () => {
    expect(readSessionCookie({ cookie: `a=1; ${SESSION_COOKIE}=tok; b=2` })).toBe("tok");
    expect(readSessionCookie({ cookie: `x${SESSION_COOKIE}=evil; a=1` })).toBeUndefined();
    expect(readSessionCookie({})).toBeUndefined();
  });

  it("treats an empty value as absent", () => {
    expect(readSessionCookie({ cookie: `${SESSION_COOKIE}=` })).toBeUndefined();
    expect(readSessionCookie({ cookie: `${SESSION_COOKIE}=; a=1` })).toBeUndefined();
  });

  it("first dm_session wins when the header repeats it", () => {
    expect(readSessionCookie({ cookie: `${SESSION_COOKIE}=first; ${SESSION_COOKIE}=second` })).toBe(
      "first",
    );
  });

  it("skips malformed parts without throwing", () => {
    expect(() => readSessionCookie({ cookie: "junk; ;; =tok; noeq" })).not.toThrow();
    expect(readSessionCookie({ cookie: "junk; ;; =tok; noeq" })).toBeUndefined();
    expect(readSessionCookie({ cookie: ";;;" })).toBeUndefined();
    expect(readSessionCookie({ cookie: `junk; ${SESSION_COOKIE}=tok ;` })).toBe("tok");
    expect(readSessionCookie({ cookie: `  ${SESSION_COOKIE}  =  tok  ` })).toBe("tok");
  });

  it("is HttpOnly and SameSite=Lax, Secure only when asked", () => {
    const plain = sessionCookie("tok", 90_000, false);
    expect(plain).toBe(`${SESSION_COOKIE}=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=90`);
    expect(sessionCookie("tok", 90_000, true)).toMatch(/; Secure$/);
  });

  it("is removed by an empty, immediately expiring cookie", () => {
    expect(clearedSessionCookie(false)).toBe(
      `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    );
  });
});
