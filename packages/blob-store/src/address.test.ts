import { createHash, hkdfSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ADDRESS_PREFIX,
  FINGERPRINT_INFO,
  addressOf,
  deriveFingerprintKey,
  fingerprintHasher,
  fingerprintOf,
  parseAddress,
  sameFingerprint,
} from "./address";

const DEK = randomBytes(32);
const bytes = (s: string) => Buffer.from(s);

describe("fingerprint key", () => {
  it("is deterministic per data key, 32 bytes, and not the data key itself", () => {
    const a = deriveFingerprintKey(DEK);
    expect(a.length).toBe(32);
    expect(a.equals(deriveFingerprintKey(DEK))).toBe(true);
    expect(a.equals(DEK)).toBe(false);
    expect(a.equals(deriveFingerprintKey(randomBytes(32)))).toBe(false);
  });

  it("is domain-separated by its label", () => {
    const other = Buffer.from(
      hkdfSync("sha256", DEK, Buffer.alloc(0), "docmind-something-else", 32),
    );
    expect(deriveFingerprintKey(DEK).equals(other)).toBe(false);
    expect(FINGERPRINT_INFO).toBe("docmind-fingerprint-v1");
  });
});

describe("fingerprintOf", () => {
  it("is 64 lowercase hex digits, stable for equal bytes and different for different bytes", () => {
    const key = deriveFingerprintKey(DEK);
    const a = fingerprintOf(key, bytes("same"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintOf(key, bytes("same"))).toBe(a);
    expect(fingerprintOf(key, bytes("other"))).not.toBe(a);
  });

  it("is not the plain sha256, and differs between users (different data keys) for the same bytes", () => {
    const plain = createHash("sha256").update("quarterly numbers").digest("hex");
    const mine = fingerprintOf(deriveFingerprintKey(DEK), bytes("quarterly numbers"));
    const yours = fingerprintOf(deriveFingerprintKey(randomBytes(32)), bytes("quarterly numbers"));
    expect(mine).not.toBe(plain);
    expect(mine).not.toBe(yours);
  });
});

describe("addresses", () => {
  const fp = "a".repeat(64);

  it("round-trips a fingerprint", () => {
    expect(addressOf(fp)).toBe(`${ADDRESS_PREFIX}${fp}`);
    expect(parseAddress(addressOf(fp))).toBe(fp);
  });

  it("rejects everything that is not exactly hmac-sha256:<64 lowercase hex>", () => {
    for (const bad of [
      "",
      `sha256:${fp}`, // the plain scheme is not this store's
      "sha256:deadbeef",
      `${ADDRESS_PREFIX}${"A".repeat(64)}`,
      `${ADDRESS_PREFIX}${"a".repeat(63)}`,
      `${ADDRESS_PREFIX}${fp}a`,
      `${ADDRESS_PREFIX}${fp}\n`,
      `${ADDRESS_PREFIX}../${"a".repeat(61)}`,
      fp,
    ]) {
      expect(parseAddress(bad), bad).toBeNull();
    }
  });

  it("compares equal, different and different-length fingerprints correctly", () => {
    expect(sameFingerprint(fp, fp)).toBe(true);
    expect(sameFingerprint(fp, "b".repeat(64))).toBe(false);
    expect(sameFingerprint(fp, "a")).toBe(false);
  });
});

describe("fingerprintHasher", () => {
  it("matches fingerprintOf when fed in chunks", () => {
    const key = deriveFingerprintKey(DEK);
    const hasher = fingerprintHasher(key);
    hasher.update(bytes("hello "));
    hasher.update(bytes("world"));
    expect(hasher.digest()).toBe(fingerprintOf(key, bytes("hello world")));
  });
});
