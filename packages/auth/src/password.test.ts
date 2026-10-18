import argon2 from "argon2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashPassword, verifyAgainstDecoy, verifyPassword } from "./password";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("password hashing", () => {
  it("produces an argon2id hash and verifies the right password only", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    expect(await verifyPassword(hash, "correct horse battery")).toBe(true);
    expect(await verifyPassword(hash, "wrong horse battery")).toBe(false);
  });

  it("salts every hash", async () => {
    expect(await hashPassword("same password here")).not.toBe(
      await hashPassword("same password here"),
    );
  });

  it("treats a malformed stored hash as a mismatch", async () => {
    expect(await verifyPassword("not-a-hash", "anything")).toBe(false);
  });

  it("takes a decoy check without throwing, even for the decoy's own password", async () => {
    await expect(verifyAgainstDecoy("decoy-password-never-matches")).resolves.toBeUndefined();
  });

  it("spends exactly one real argon2 verification against a decoy with the real parameters", async () => {
    const verify = vi.spyOn(argon2, "verify");
    await verifyAgainstDecoy("some-unknown-email-password");
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]?.[0]).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
  });

  it("never throws when the decoy hash fails once, and recomputes it on the next check", async () => {
    const { verifyAgainstDecoy: check } = await import("./password");
    const hash = vi
      .spyOn(argon2, "hash")
      .mockRejectedValueOnce(new Error("ARGON2_MEMORY_ALLOCATION_ERROR"));
    await expect(check("some-unknown-email-password")).resolves.toBeUndefined();
    expect(hash).toHaveBeenCalledTimes(1);
    await expect(check("some-unknown-email-password")).resolves.toBeUndefined();
    expect(hash).toHaveBeenCalledTimes(2);
  });

  it("primeDecoy never throws on a failed hash and the next check recomputes", async () => {
    const { primeDecoy, verifyAgainstDecoy: check } = await import("./password");
    const hash = vi
      .spyOn(argon2, "hash")
      .mockRejectedValueOnce(new Error("ARGON2_MEMORY_ALLOCATION_ERROR"));
    await expect(primeDecoy()).resolves.toBeUndefined();
    expect(hash).toHaveBeenCalledTimes(1);
    await expect(check("some-unknown-email-password")).resolves.toBeUndefined();
    expect(hash).toHaveBeenCalledTimes(2);
  });
});
