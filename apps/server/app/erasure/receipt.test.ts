import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashReceipt, newReceipt } from "./receipt";

describe("receipt", () => {
  it("is 32 random bytes as 43 base64url characters, fresh every time", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const { token } = newReceipt();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, "base64url")).toHaveLength(32);
      seen.add(token);
    }
    expect(seen.size).toBe(50);
  });

  it("stores the sha256 of the token text and never the token", () => {
    const { token, hash } = newReceipt();
    expect(hash).toHaveLength(32);
    expect(hash.equals(createHash("sha256").update(token).digest())).toBe(true);
    expect(hashReceipt(token).equals(hash)).toBe(true);
    expect(hash.toString("base64url")).not.toBe(token);
    expect(hash.includes(Buffer.from(token))).toBe(false);
  });
});
