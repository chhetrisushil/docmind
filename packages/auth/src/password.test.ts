import { describe, expect, it } from "vitest";
import { hashPassword, verifyAgainstDecoy, verifyPassword } from "./password";

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
});
