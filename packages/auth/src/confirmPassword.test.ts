import { describe, expect, it, vi } from "vitest";
import { AuthService } from "./authService";
import { MemoryAuthStore } from "./memoryStore";
import * as password from "./password";

const EMAIL = "ada@example.com";
const PASSWORD = "correct horse battery";

async function setup() {
  const store = new MemoryAuthStore();
  const service = new AuthService(store);
  await service.signUp(EMAIL, PASSWORD);
  const login = await store.findLogin(EMAIL);
  if (!login) throw new Error("sign-up did not create the account");
  const identity = { userId: login.userId, tenantId: login.tenantId };
  return { service, identity };
}

describe("AuthService.confirmPassword", () => {
  it("is true for the account's own password", async () => {
    const { service, identity } = await setup();
    expect(await service.confirmPassword(identity, EMAIL, PASSWORD)).toBe(true);
  });

  it("is false for a wrong password", async () => {
    const { service, identity } = await setup();
    expect(await service.confirmPassword(identity, EMAIL, "not the password")).toBe(false);
  });

  it("is false when the right password belongs to a different account than the identity", async () => {
    const { service, identity } = await setup();
    await service.signUp("bob@example.com", PASSWORD);
    expect(await service.confirmPassword(identity, "bob@example.com", PASSWORD)).toBe(false);
  });

  it("is false for an unknown email, after the same hash work", async () => {
    const { service, identity } = await setup();
    const decoy = vi.spyOn(password, "verifyAgainstDecoy");
    expect(await service.confirmPassword(identity, "nobody@example.com", PASSWORD)).toBe(false);
    expect(decoy).toHaveBeenCalledOnce();
    decoy.mockRestore();
  });
});
