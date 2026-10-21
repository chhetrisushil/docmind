import { describe, expect, it } from "vitest";
import {
  DeleteAccountRequest,
  DeleteAccountResponse,
  ErasureInProgressBody,
  ErasureReceipt,
  ErasureStatusResponse,
  ErrorBody,
  LoginRequest,
  MeResponse,
  SignUpRequest,
  SignUpResponse,
} from "./index";

const ID = "11111111-1111-4111-8111-111111111111";

describe("auth contracts", () => {
  it("normalises the email on sign-up", () => {
    const parsed = SignUpRequest.parse({
      email: "  Ada@Example.COM ",
      password: "correct horse battery",
    });
    expect(parsed.email).toBe("ada@example.com");
  });

  it("rejects a short sign-up password but accepts it on login", () => {
    expect(SignUpRequest.safeParse({ email: "a@b.co", password: "short" }).success).toBe(false);
    expect(LoginRequest.safeParse({ email: "a@b.co", password: "short" }).success).toBe(true);
  });

  it("rejects a malformed email", () => {
    expect(LoginRequest.safeParse({ email: "not-an-email", password: "x" }).success).toBe(false);
  });

  it("requires uuid ids in MeResponse", () => {
    const ok = { userId: ID, tenantId: ID, email: "a@b.co" };
    expect(MeResponse.parse(ok)).toEqual(ok);
    expect(MeResponse.safeParse({ ...ok, userId: "u1" }).success).toBe(false);
  });

  it("describes errors as { error: { code, message } }", () => {
    expect(ErrorBody.safeParse({ error: { code: "unauthorized", message: "no" } }).success).toBe(
      true,
    );
    expect(ErrorBody.safeParse({ error: "no" }).success).toBe(false);
  });

  it("answers sign-up with the one accepted body", () => {
    expect(SignUpResponse.parse({ status: "accepted" })).toEqual({ status: "accepted" });
    expect(SignUpResponse.safeParse({ status: "exists" }).success).toBe(false);
  });
});

describe("delete account contract", () => {
  it("needs a password of 1 to 128 characters and ignores nothing else it is given", () => {
    expect(DeleteAccountRequest.parse({ password: "x" })).toEqual({ password: "x" });
    expect(DeleteAccountRequest.safeParse({}).success).toBe(false);
    expect(DeleteAccountRequest.safeParse({ password: "" }).success).toBe(false);
    expect(DeleteAccountRequest.safeParse({ password: "p".repeat(129) }).success).toBe(false);
    // a short password is fine here: it only has to match the one on file (no minimum, like login)
    expect(DeleteAccountRequest.safeParse({ password: "short" }).success).toBe(true);
  });

  it("answers with { erasure: 'accepted', receipt } and the receipt is 43 base64url characters", () => {
    const receipt = "A".repeat(43);
    expect(DeleteAccountResponse.parse({ erasure: "accepted", receipt })).toEqual({
      erasure: "accepted",
      receipt,
    });
    expect(DeleteAccountResponse.safeParse({ erasure: "done", receipt }).success).toBe(false);
    expect(DeleteAccountResponse.safeParse({ erasure: "accepted" }).success).toBe(false);
    expect(ErasureReceipt.safeParse("a-b_c".padEnd(43, "0")).success).toBe(true);
    for (const bad of [
      "",
      "A".repeat(42),
      "A".repeat(44),
      `${"A".repeat(42)}=`,
      `${"A".repeat(42)}+`,
      `${"A".repeat(42)}/`,
      `${"A".repeat(42)} `,
    ])
      expect(ErasureReceipt.safeParse(bad).success).toBe(false);
  });
});

describe("erasure status contract", () => {
  it("answers with exactly { state } and the state is pending or done", () => {
    expect(ErasureStatusResponse.parse({ state: "pending" })).toEqual({ state: "pending" });
    expect(ErasureStatusResponse.parse({ state: "done" })).toEqual({ state: "done" });
    expect(ErasureStatusResponse.safeParse({ state: "failed" }).success).toBe(false);
    expect(ErasureStatusResponse.safeParse({}).success).toBe(false);
  });
});

describe("erasure conflict contract", () => {
  it("is the 409 body with the code erasure_in_progress and nothing else is accepted as it", () => {
    const ok = { error: { code: "erasure_in_progress", message: "m" } };
    expect(ErasureInProgressBody.parse(ok)).toEqual(ok);
    expect(
      ErasureInProgressBody.safeParse({ error: { code: "not_found", message: "m" } }).success,
    ).toBe(false);
  });
});
