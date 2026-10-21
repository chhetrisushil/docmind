import { POLICIES } from "@docmind/auth";
import { ErasureStatusResponse, ErrorBody } from "@docmind/contracts";
import { describe, expect, it, vi } from "vitest";
import type { AccountErasure } from "../erasure/account";
import { hashReceipt, newReceipt } from "../erasure/receipt";
import { serveMemoryAuth, useServers } from "./testing";

const serve = useServers();

async function start(withErasure = true, failWith?: Error) {
  const known = new Map<string, "pending" | "done">(); // receipt hash (hex) -> state
  const asked: Buffer[] = [];
  const erasure: AccountErasure = {
    request: async () => true,
    start: () => {},
    status: vi.fn(async (hash: Buffer) => {
      asked.push(hash);
      if (failWith) throw failWith;
      return known.get(hash.toString("hex")) ?? null;
    }),
  };
  const api = await serveMemoryAuth(serve, withErasure ? erasure : undefined);
  const get = (receipt: string) => fetch(`${api.base}/api/erasure/${receipt}`); // no cookie, no origin
  const issue = (state: "pending" | "done") => {
    const r = newReceipt();
    known.set(r.hash.toString("hex"), state);
    return r;
  };
  return { ...api, get, issue, known, asked, erasure };
}

describe("GET /api/erasure/:receipt", () => {
  it("is not a route without an erasure wiring", async () => {
    const api = await start(false);
    expect((await api.get(newReceipt().token)).status).toBe(404);
  });

  it("answers pending, then done, to a caller with no session, and never caches", async () => {
    const api = await start();
    const r = api.issue("pending");
    const pending = await api.get(r.token);
    expect(pending.status).toBe(200);
    expect(pending.headers.get("cache-control")).toBe("no-store");
    expect(ErasureStatusResponse.parse(await pending.json())).toEqual({ state: "pending" });
    api.known.set(r.hash.toString("hex"), "done");
    const done = await api.get(r.token);
    expect(done.status).toBe(200);
    expect(done.headers.get("cache-control")).toBe("no-store");
    expect(ErasureStatusResponse.parse(await done.json())).toEqual({ state: "done" });
  });

  it("looks the receipt up by its hash, never by the token", async () => {
    const api = await start();
    const r = api.issue("pending");
    await api.get(r.token);
    expect(api.asked).toHaveLength(1);
    expect(api.asked[0]?.equals(hashReceipt(r.token))).toBe(true);
    expect(api.asked[0]).toHaveLength(32);
  });

  it("answers an unknown receipt 404, the same as a malformed one, with no-store", async () => {
    const api = await start();
    const unknown = await api.get(newReceipt().token);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("cache-control")).toBe("no-store");
    const body = ErrorBody.parse(await unknown.json());
    expect(body.error.code).toBe("not_found");
    for (const bad of [
      "x",
      "A".repeat(42),
      "A".repeat(44),
      `${"A".repeat(42)}=`,
      `${"A".repeat(42)}!`,
      `${"A".repeat(41)}%2F_`,
    ]) {
      const res = await api.get(bad);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(ErrorBody.parse(await res.json())).toEqual(body); // indistinguishable from an unknown receipt
    }
    expect(api.erasure.status).toHaveBeenCalledTimes(1); // the malformed ones never reached the database
  });

  it("is throttled per IP: every request counts, then 429 with Retry-After and no-store", async () => {
    const api = await start();
    const r = api.issue("pending");
    for (let i = 0; i < POLICIES.erasureStatusIp.free; i++)
      expect((await api.get(r.token)).status).toBe(200);
    const locked = await api.get(r.token);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(locked.headers.get("cache-control")).toBe("no-store");
    expect(ErrorBody.parse(await locked.json()).error.code).toBe("too_many_requests");
    expect((await api.get("not-a-receipt")).status).toBe(429); // a malformed token is counted and locked out too
  });

  it("does not share its budget with login or sign-up", async () => {
    const api = await start();
    const r = api.issue("pending");
    for (let i = 0; i < POLICIES.erasureStatusIp.free + 1; i++) await api.get(r.token);
    const login = await fetch(`${api.base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com", password: "x" }),
    });
    expect(login.status).toBe(401); // not 429: the login budget is untouched
  });

  it("a failing lookup is a 500 and the receipt token appears in no console call", async () => {
    const out = (["log", "error", "warn", "info"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const api = await start(true, new RangeError("db down"));
    const r = newReceipt();
    const res = await api.get(r.token);
    expect(res.status).toBe(500);
    expect(out[1]).toHaveBeenCalledWith(
      "handler failed",
      "GET",
      "/api/erasure/:receipt",
      "RangeError",
    );
    const logged = JSON.stringify(out.flatMap((s) => s.mock.calls));
    expect(logged).not.toContain(r.token);
    expect(logged).not.toContain(r.hash.toString("base64url"));
    for (const s of out) s.mockRestore();
  });
});
