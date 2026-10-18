import { describe, expect, it } from "vitest";
import { ErrorBody, LoginRequest, MeResponse, SignUpRequest, SignUpResponse } from "./index";

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
