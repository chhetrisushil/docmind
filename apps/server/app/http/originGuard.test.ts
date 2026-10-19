import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { AuthService, PasswordAuthenticator } from "@docmind/auth";
import { MemoryAuthStore, MemoryThrottle } from "@docmind/auth/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { authRoutes } from "../auth/routes";
import { createHttpServer } from "../server";
import { json } from "./respond";

const ok = (_req: unknown, res: Parameters<typeof json>[0]) => json(res, 200, { ran: true });
const store = new MemoryAuthStore();
const routes = {
  ...authRoutes({
    service: new AuthService(store),
    authenticator: new PasswordAuthenticator(store),
    store,
    throttle: new MemoryThrottle(),
    secureCookies: false,
    trustProxy: false,
  }),
  "POST /t": ok,
  "PUT /t": ok,
  "PATCH /t": ok,
  "DELETE /t": ok,
  "GET /t": ok,
  "POST /t/:id": ok,
};
const http = createHttpServer(routes);
const https = createHttpServer(routes, { secure: true });
let port = 0;
let securePort = 0;

beforeAll(async () => {
  for (const s of [http, https]) await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  port = (http.address() as AddressInfo).port;
  securePort = (https.address() as AddressInfo).port;
});
afterAll(async () => {
  for (const s of [http, https]) {
    await new Promise<void>((r) => {
      s.close(() => r());
      s.closeAllConnections();
    });
  }
});

/** Raw request, so headers such as Origin and Host are sent exactly as given. */
function send(method: string, path: string, headers: Record<string, string> = {}, p = port) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: p, method, path, headers }, async (res) => {
      let body = "";
      for await (const c of res) body += c;
      resolve({ status: res.statusCode ?? 0, body });
    });
    req.on("error", reject).end();
  });
}

const REFUSED = JSON.stringify({ error: { code: "cross_origin_request" } });
const STATE_CHANGING = [
  ["POST", "/t"],
  ["PUT", "/t"],
  ["PATCH", "/t"],
  ["DELETE", "/t"],
  ["POST", "/t/abc"],
  ["POST", "/api/auth/sign-up"],
  ["POST", "/api/auth/login"],
  ["POST", "/api/auth/logout"],
] as const;

describe("origin guard", () => {
  for (const [method, path] of STATE_CHANGING) {
    for (const site of ["same-site", "cross-site"]) {
      it(`refuses ${method} ${path} with Sec-Fetch-Site ${site}`, async () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => {});
        const res = await send(method, path, { "sec-fetch-site": site });
        expect(res).toEqual({ status: 403, body: REFUSED });
        // Method and path only; never a header value.
        expect(spy).toHaveBeenCalledWith("cross-origin request refused", method, path);
        spy.mockRestore();
      });
    }
  }

  it.each(["same-origin", "none"])("lets Sec-Fetch-Site %s through", async (site) => {
    expect((await send("POST", "/t", { "sec-fetch-site": site })).status).toBe(200);
    expect((await send("DELETE", "/t", { "sec-fetch-site": site })).status).toBe(200);
  });

  it("lets Sec-Fetch-Site win over a matching Origin", async () => {
    const host = `127.0.0.1:${port}`;
    const res = await send("POST", "/t", {
      "sec-fetch-site": "cross-site",
      origin: `http://${host}`,
    });
    expect(res.status).toBe(403);
  });

  it("refuses a foreign Origin when Sec-Fetch-Site is absent", async () => {
    for (const origin of ["http://evil.example", "null", `http://127.0.0.1:${port + 1}`]) {
      expect((await send("POST", "/t", { origin })).status).toBe(403);
    }
  });

  it("allows a matching Origin, and a request with neither header", async () => {
    expect((await send("POST", "/t", { origin: `http://127.0.0.1:${port}` })).status).toBe(200);
    expect((await send("POST", "/t")).status).toBe(200);
  });

  it("builds the own origin as https when the cookie is Secure", async () => {
    const host = `127.0.0.1:${securePort}`;
    expect((await send("POST", "/t", { origin: `https://${host}` }, securePort)).status).toBe(200);
    expect((await send("POST", "/t", { origin: `http://${host}` }, securePort)).status).toBe(403);
  });

  it("does not believe X-Forwarded-Host or X-Forwarded-Proto", async () => {
    const res = await send("POST", "/t", {
      origin: "http://evil.example",
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "http",
    });
    expect(res.status).toBe(403);
  });

  it("never blocks GET, HEAD or OPTIONS", async () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const res = await send(method, "/t", {
        "sec-fetch-site": "cross-site",
        origin: "http://evil.example",
      });
      expect(res.status).not.toBe(403);
    }
  });
});
