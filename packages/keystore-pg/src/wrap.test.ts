import { createSecretKey, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { unwrapKey, wrapKey } from "./wrap";

describe("key wrapping", () => {
  const kek = createSecretKey(randomBytes(32));
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

  it("does not open under another KEK or another subject", () => {
    const wrapped = wrapKey(kek, "user-1", dek);
    expect(() => unwrapKey(createSecretKey(randomBytes(32)), "user-1", wrapped)).toThrow();
    expect(() => unwrapKey(kek, "user-2", wrapped)).toThrow();
  });

  it("rejects a flipped IV byte, tag byte, or ciphertext byte", () => {
    const wrapped = wrapKey(kek, "user-1", dek);
    for (const at of [0, 12, wrapped.length - 1]) {
      const flipped = Buffer.from(wrapped);
      flipped[at] = (flipped[at] ?? 0) ^ 1;
      expect(() => unwrapKey(kek, "user-1", flipped)).toThrow();
    }
  });

  it("rejects malformed blobs as malformed", () => {
    const wrapped = wrapKey(kek, "user-1", dek);
    for (const bad of [wrapped.subarray(0, 59), wrapped.subarray(0, 16), Buffer.alloc(0)]) {
      expect(() => unwrapKey(kek, "user-1", bad)).toThrow("malformed wrapped key");
    }
  });

  it("refuses a data key that is not 32 bytes", () => {
    expect(() => wrapKey(kek, "user-1", randomBytes(16))).toThrow("the data key must be 32 bytes");
  });
});
