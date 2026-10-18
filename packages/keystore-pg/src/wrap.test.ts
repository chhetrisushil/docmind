import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { unwrapKey, wrapKey } from "./wrap";

describe("key wrapping", () => {
  const kek = randomBytes(32);
  const dek = randomBytes(32);

  it("round-trips and does not contain the data key in the clear", () => {
    const wrapped = wrapKey(kek, "user-1", dek);
    expect(wrapped).toHaveLength(12 + 16 + 32);
    expect(wrapped.includes(dek)).toBe(false);
    expect(unwrapKey(kek, "user-1", wrapped).equals(dek)).toBe(true);
  });

  it("never wraps the same key to the same bytes", () => {
    expect(wrapKey(kek, "user-1", dek).equals(wrapKey(kek, "user-1", dek))).toBe(false);
  });

  it("does not open under another KEK, another subject, or after tampering", () => {
    const wrapped = wrapKey(kek, "user-1", dek);
    expect(() => unwrapKey(randomBytes(32), "user-1", wrapped)).toThrow();
    expect(() => unwrapKey(kek, "user-2", wrapped)).toThrow();
    const flipped = Buffer.from(wrapped);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
    expect(() => unwrapKey(kek, "user-1", flipped)).toThrow();
  });
});
