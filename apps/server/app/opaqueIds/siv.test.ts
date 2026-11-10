import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode } from "./base32";
import { deriveIdKey, handleOfKey, openToken, sealToken } from "./siv";

const DEK = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("base32", () => {
  it("matches the RFC 4648 vectors (lower case, no padding)", () => {
    expect(base32Encode(Buffer.from("foobar"))).toBe("mzxw6ytboi");
    expect(base32Encode(Buffer.from([0xff, 0xff]))).toBe("777q");
  });
  it("decodes strictly: one spelling, an exact length, no stray characters", () => {
    expect(base32Decode("mzxw6ytboi", 6)?.toString()).toBe("foobar");
    expect(base32Decode("mzxw6ytbo", 6)).toBeNull(); // short
    expect(base32Decode("mzxw6ytboi=", 6)).toBeNull();
    expect(base32Decode("MZXW6YTBOI", 6)).toBeNull(); // upper case
    expect(base32Decode("777r", 2)).toBeNull(); // non-zero padding bits: a second spelling of 777q
  });
});

describe("the id key and the SIV token", () => {
  const key = deriveIdKey(DEK);

  it("pins the derived key, the handle and one token per family (known answers)", () => {
    expect(key.root.toString("hex")).toBe(
      "f4e3b42e90f917e3b3bdbb3479b7c6b3a1c8f0cd14996ed132a12e4e42829dc9",
    );
    expect(handleOfKey(key)).toBe("kk7zcxcciabo34q7qbcn7mlo4i");
    expect(sealToken(key, "doc", UUID)).toBe(
      "vmqd4aixfeawlpniksczeas5gmzrrsors76ejrwedakvajmt6v2q",
    );
    expect(sealToken(key, "chat", UUID)).toBe(
      "w2lj745t5q3hj6e6wa2zl7tvvwojggtt3ea5u4icpzw4brxrxjqa",
    );
  });

  it("round-trips, and is deterministic", () => {
    const token = sealToken(key, "doc", UUID);
    expect(token).toHaveLength(52);
    expect(sealToken(key, "doc", UUID)).toBe(token);
    expect(openToken(key, "doc", token)).toBe(UUID);
  });

  it("separates domains: a family, a user and the handle never collide", () => {
    const doc = sealToken(key, "doc", UUID);
    expect(sealToken(key, "chat", UUID)).not.toBe(doc);
    expect(openToken(key, "chat", doc)).toBeNull(); // a document token is not a chat token
    const other = deriveIdKey(Buffer.alloc(32, 7));
    expect(openToken(other, "doc", doc)).toBeNull(); // another user's key
    expect(handleOfKey(other)).not.toBe(handleOfKey(key));
    expect(doc.startsWith(handleOfKey(key))).toBe(false);
  });

  it("rejects every single-character change of a token (authenticated)", () => {
    const token = sealToken(key, "doc", UUID);
    const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
    for (let i = 0; i < token.length; i++) {
      const swapped = alphabet[(alphabet.indexOf(token[i] as string) + 1) % 32] as string;
      const bad = token.slice(0, i) + swapped + token.slice(i + 1);
      expect(openToken(key, "doc", bad)).toBeNull();
    }
  });

  it("refuses to seal anything but a canonical lower-case uuid", () => {
    expect(() => sealToken(key, "doc", UUID.toUpperCase())).toThrow(RangeError);
    expect(() => sealToken(key, "doc", "not-a-uuid")).toThrow(RangeError);
  });
});
