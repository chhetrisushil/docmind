import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ApiError, createHttp } from "./http";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("createHttp", () => {
  it("sends JSON with same-origin credentials and parses the answer with the schema", async () => {
    const fetch = vi.fn(async () => json(200, { n: 2 }));
    const http = createHttp({ fetch: fetch as never });
    const out = await http.request("POST", "/api/x", {
      body: { a: 1 },
      schema: z.object({ n: z.number() }),
    });
    expect(out).toEqual({ n: 2 });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/x");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", body: '{"a":1}' });
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("maps a failure to an ApiError with the code and Retry-After, and never keeps the server's message", async () => {
    const http = createHttp({
      fetch: (async () =>
        json(
          429,
          { error: { code: "too_many_requests", message: "sentinel-title-0123456789" } },
          { "retry-after": "7" },
        )) as never,
    });
    const err = await http.request("GET", "/api/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 429,
      code: "too_many_requests",
      retryAfter: 7,
      message: "429 too_many_requests",
    });
    expect(JSON.stringify(err)).not.toContain("sentinel");
  });

  it("treats an empty or blank Retry-After as absent, not 0", async () => {
    for (const value of ["", "  "]) {
      const http = createHttp({
        fetch: (async () => json(429, { error: { code: "x", message: "m" } }, { "retry-after": value })) as never,
      });
      const err = await http.request("GET", "/api/x").catch((e: unknown) => e);
      expect((err as ApiError).retryAfter).toBeUndefined();
    }
  });

  it("an error body that is not ours, or a code that is not a plain word, becomes 'unknown'", async () => {
    const odd = createHttp({
      fetch: (async () => new Response("<html>", { status: 502 })) as never,
    });
    expect(await odd.request("GET", "/x").catch((e: unknown) => e)).toMatchObject({
      status: 502,
      code: "unknown",
    });
    const weird = createHttp({
      fetch: (async () => json(400, { error: { code: "Bad Code; drop", message: "m" } })) as never,
    });
    expect(await weird.request("GET", "/x").catch((e: unknown) => e)).toMatchObject({
      code: "unknown",
    });
  });

  it("calls onUnauthorized for the code 'unauthorized' only (a wrong password is also 401 and must not sign anyone out)", async () => {
    const onUnauthorized = vi.fn();
    const expired = createHttp({
      onUnauthorized,
      fetch: (async () => json(401, { error: { code: "unauthorized", message: "m" } })) as never,
    });
    await expect(expired.request("GET", "/api/me")).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    const wrong = createHttp({
      onUnauthorized,
      fetch: (async () =>
        json(401, { error: { code: "invalid_credentials", message: "m" } })) as never,
    });
    await expect(wrong.request("POST", "/api/auth/login")).rejects.toMatchObject({
      code: "invalid_credentials",
    });
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("an answer that fails its schema is a bad_response, and a dropped connection is status 0 'network'", async () => {
    const bad = createHttp({ fetch: (async () => json(200, { n: "two" })) as never });
    await expect(
      bad.request("GET", "/x", { schema: z.object({ n: z.number() }) }),
    ).rejects.toMatchObject({ code: "bad_response" });
    const down = createHttp({
      fetch: (async () => {
        throw new TypeError("sentinel-title-0123456789");
      }) as never,
    });
    const err = await down.request("GET", "/x").catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 0, code: "network", message: "0 network" });
  });

  it("returns undefined for 204 and lets an abort through untouched", async () => {
    const http = createHttp({ fetch: (async () => new Response(null, { status: 204 })) as never });
    expect(await http.request("DELETE", "/x")).toBeUndefined();
    const aborted = createHttp({
      fetch: (async () => {
        throw new DOMException("x", "AbortError");
      }) as never,
    });
    await expect(aborted.request("GET", "/x")).rejects.toMatchObject({ name: "AbortError" });
  });
});
