import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/http";
import { AuthStore, authErrorText } from "./auth";

const ME = {
  userId: "0b4f7d52-6c53-4c6e-9d49-2b0e7a3f9a10",
  tenantId: "7f6d1b8e-3b0a-4a56-8f2f-0a8e0f7c4d11",
  email: "a@example.com",
};
const api = (over: Record<string, unknown> = {}) =>
  ({
    me: vi.fn(async () => ME),
    login: vi.fn(async () => ME),
    logout: vi.fn(async () => {}),
    signUp: vi.fn(async () => {}),
    ...over,
  }) as never;

describe("AuthStore", () => {
  it("bootstrap: a live session is signed-in, a 401 is anonymous, and a dead network stays unknown-free (anonymous)", async () => {
    const live = new AuthStore(api());
    await live.bootstrap();
    expect(live.get()).toEqual({ status: "signed-in", me: ME });
    const gone = new AuthStore(
      api({
        me: vi.fn(async () => {
          throw new ApiError(401, "unauthorized");
        }),
      }),
    );
    await gone.bootstrap();
    expect(gone.get()).toEqual({ status: "anonymous" });
    const down = new AuthStore(
      api({
        me: vi.fn(async () => {
          throw new ApiError(0, "network");
        }),
      }),
    );
    await down.bootstrap();
    expect(down.get()).toEqual({ status: "anonymous" });
  });

  it("login signs in; a refused login stays anonymous and rethrows for the form", async () => {
    const store = new AuthStore(
      api({
        me: vi.fn(async () => {
          throw new ApiError(401, "unauthorized");
        }),
        login: vi.fn(async () => {
          throw new ApiError(401, "invalid_credentials");
        }),
      }),
    );
    await store.bootstrap();
    await expect(store.login({ email: "a@example.com", password: "x" })).rejects.toMatchObject({
      code: "invalid_credentials",
    });
    expect(store.get()).toEqual({ status: "anonymous" });
    const ok = new AuthStore(api());
    await ok.login({ email: "a@example.com", password: "x" });
    expect(ok.get()).toEqual({ status: "signed-in", me: ME });
  });

  it("signUp then logs in with the same credentials (sign-up answers 202 whether or not the address exists)", async () => {
    const a = api();
    const store = new AuthStore(a);
    await store.signUp({ email: "a@example.com", password: "a long enough password" });
    expect((a as never as { signUp: ReturnType<typeof vi.fn> }).signUp).toHaveBeenCalledTimes(1);
    expect((a as never as { login: ReturnType<typeof vi.fn> }).login).toHaveBeenCalledWith({
      email: "a@example.com",
      password: "a long enough password",
    });
    expect(store.get().status).toBe("signed-in");
  });

  it("logout clears the state even when the server call fails; expired() and signedOut() go anonymous", async () => {
    const store = new AuthStore(
      api({
        logout: vi.fn(async () => {
          throw new ApiError(0, "network");
        }),
      }),
    );
    await store.login({ email: "a@example.com", password: "x" });
    await store.logout();
    expect(store.get()).toEqual({ status: "anonymous" });
    await store.login({ email: "a@example.com", password: "x" });
    store.expired();
    expect(store.get()).toEqual({ status: "anonymous" });
  });
});

describe("AuthStore signed-out transitions", () => {
  it("does not notify again when it is already anonymous", async () => {
    const store = new AuthStore(
      api({
        me: vi.fn(async () => {
          throw new ApiError(401, "unauthorized");
        }),
      }),
    );
    await store.bootstrap();
    const seen = vi.fn();
    store.subscribe(seen);
    store.expired();
    store.signedOut();
    expect(seen).not.toHaveBeenCalled();
  });
  it("a sign-up the server refuses never tries to sign in", async () => {
    const a = api({
      signUp: vi.fn(async () => {
        throw new ApiError(429, "too_many_requests", 5);
      }),
    });
    const store = new AuthStore(a);
    await expect(
      store.signUp({ email: "a@example.com", password: "a long enough password" }),
    ).rejects.toBeInstanceOf(ApiError);
    expect((a as never as { login: ReturnType<typeof vi.fn> }).login).not.toHaveBeenCalled();
  });
});

describe("authErrorText", () => {
  it("answers with fixed sentences by status and code, and the wait time for a throttle", () => {
    expect(authErrorText(new ApiError(401, "invalid_credentials"))).toBe(
      "The email or password is not right.",
    );
    expect(authErrorText(new ApiError(429, "too_many_requests", 12))).toBe(
      "Too many attempts. Try again in 12 seconds.",
    );
    expect(authErrorText(new ApiError(429, "too_many_requests"))).toBe(
      "Too many attempts. Try again in a minute.",
    );
    expect(authErrorText(new ApiError(400, "invalid_request"))).toBe(
      "Check the email and password and try again.",
    );
    expect(authErrorText(new ApiError(0, "network"))).toBe(
      "Could not reach the server. Check your connection.",
    );
    expect(authErrorText(new ApiError(500, "internal"))).toBe("Something went wrong. Try again.");
    expect(authErrorText(new Error("sentinel-title-0123456789"))).toBe(
      "Something went wrong. Try again.",
    );
  });
});
