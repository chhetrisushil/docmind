import type { AddressInfo } from "node:net";
import { AuthService } from "@docmind/auth";
import { MemoryAuthStore, MemoryThrottle } from "@docmind/auth/testing";
import { ErrorBody, SignUpResponse } from "@docmind/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createHttpServer } from "../server";
import { authRoutes } from "./routes";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const PASSWORD = "correct horse battery";

/** A fresh server, store and throttle per test. The clock is fixed, so a lock never runs out. */
async function start(trustProxy = false) {
  const store = new MemoryAuthStore();
  const throttle = new MemoryThrottle();
  throttle.now = () => 1_000_000;
  const server = createHttpServer(
    authRoutes({ service: new AuthService(store), throttle, trustProxy }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    store,
    signUp: (email: string, password = PASSWORD, headers: Record<string, string> = {}) =>
      fetch(`${base}/api/auth/sign-up`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ email, password }),
      }),
  };
}

/** Everything a client can see of a response except the Date header. */
async function wire(res: Response) {
  const headers = [...res.headers.entries()].filter(([name]) => name !== "date");
  return { status: res.status, headers, body: await res.text() };
}

describe("sign-up", () => {
  it("answers 202 with no cookie, and creates the account", async () => {
    const api = await start();
    const res = await api.signUp("Ada@Example.com");
    expect(res.status).toBe(202);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(SignUpResponse.parse(await res.json())).toEqual({ status: "accepted" });
    expect((await api.store.findLogin("ada@example.com"))?.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it("answers a new email and a taken one with byte-identical responses", async () => {
    const api = await start();
    const fresh = await wire(await api.signUp("new@example.com"));
    const taken = await wire(await api.signUp("new@example.com", "another long password"));
    expect(taken).toEqual(fresh);
  });

  it("leaves a taken email's password alone", async () => {
    const api = await start();
    await api.signUp("ada@example.com");
    const first = await api.store.findLogin("ada@example.com");
    await api.signUp("ada@example.com", "another long password");
    expect(await api.store.findLogin("ada@example.com")).toEqual(first);
  });

  it("rejects a short password with 400, before anything is counted", async () => {
    const api = await start();
    expect((await api.signUp("b@example.com", "short")).status).toBe(400);
  });

  it("limits sign-ups per address, then answers 429 with Retry-After", async () => {
    const api = await start();
    for (let i = 0; i < 6; i++) await api.signUp(`user${i}@example.com`);
    const res = await api.signUp("next@example.com");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(ErrorBody.parse(await res.json()).error.code).toBe("too_many_requests");
  });

  it("limits sign-ups per email, whether or not it is registered", async () => {
    const api = await start();
    for (let i = 0; i < 4; i++) await api.signUp("same@example.com");
    expect((await api.signUp("same@example.com")).status).toBe(429);
  });

  it("ignores X-Forwarded-For unless the proxy is trusted", async () => {
    const spoofed = await start(false);
    for (let i = 0; i < 6; i++) {
      await spoofed.signUp(`u${i}@example.com`, PASSWORD, { "x-forwarded-for": `10.0.0.${i}` });
    }
    const blocked = await spoofed.signUp("v@example.com", PASSWORD, {
      "x-forwarded-for": "10.9.9.9",
    });
    expect(blocked.status).toBe(429);

    const proxied = await start(true);
    for (let i = 0; i < 7; i++) {
      const res = await proxied.signUp(`u${i}@example.com`, PASSWORD, {
        "x-forwarded-for": `10.0.0.${i}`,
      });
      expect(res.status).toBe(202);
    }
  });
});
