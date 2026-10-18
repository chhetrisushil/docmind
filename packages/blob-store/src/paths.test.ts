import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertScope, blobPath, userDirOf } from "./paths";

const T = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const U = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";

describe("blob paths", () => {
  it("requires an absolute root and canonical lowercase UUIDs", () => {
    expect(() => assertScope("relative/root", T, U)).toThrow("blob root must be an absolute path");
    expect(() => assertScope("/r", T.toUpperCase(), U)).toThrow(
      "tenantId and userId must be canonical lowercase UUIDs",
    );
    expect(() => assertScope("/r", "../x", U)).toThrow(
      "tenantId and userId must be canonical lowercase UUIDs",
    );
  });

  it("places a user's blobs under <root>/<tenant>/<user>", () => {
    expect(userDirOf("/r", T, U)).toBe(join("/r", T, U));
  });

  it("accepts only 64 lowercase hex digits as a fingerprint", () => {
    const dir = userDirOf("/r", T, U);
    expect(blobPath(dir, "a".repeat(64))).toBe(join(dir, "a".repeat(64)));
    expect(() => blobPath(dir, `../${"a".repeat(61)}`)).toThrow(
      "fingerprint must be 64 lowercase hex digits",
    );
    expect(() => blobPath(dir, "A".repeat(64))).toThrow(
      "fingerprint must be 64 lowercase hex digits",
    );
  });
});
