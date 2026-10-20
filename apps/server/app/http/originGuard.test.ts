import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { AuthService, PasswordAuthenticator } from "@docmind/auth";
import { MemoryAuthStore, MemoryThrottle } from "@docmind/auth/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authRoutes } from "../auth/routes";
import { createHttpServer } from "../server";
import { StartupConfigError } from "../startupError";
import { parsePublicOrigin, refusalLogger } from "./originGuard";
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
const logged: [string, string][] = [];
const http = createHttpServer(routes, { secure: false, log: (m, p) => logged.push([m, p]) });
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
function send(
  method: string,
  path: string,
  headers: Record<string, string | string[]> = {},
  p = port,
) {
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
        logged.length = 0;
        const res = await send(method, path, { "sec-fetch-site": site });
        expect(res).toEqual({ status: 403, body: REFUSED });
        // Method and path only; never a header value.
        expect(logged).toEqual([[method, path]]);
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

  it("refuses a Sec-Fetch-Site that is not exactly same-origin or none", async () => {
    for (const site of ["", "SAME-ORIGIN", "bogus", ["same-origin", "same-origin"]]) {
      expect((await send("POST", "/t", { "sec-fetch-site": site })).status).toBe(403);
    }
  });

  it("refuses a foreign Origin when Sec-Fetch-Site is absent", async () => {
    for (const origin of [
      "http://evil.example",
      "null",
      `http://127.0.0.1:${port + 1}`,
      `http://127.0.0.1:${port}.evil.example`,
      `http://127.0.0.1:${port}0`,
      `http://127.0.0.1:${port}/`,
      `HTTP://127.0.0.1:${port}`,
    ]) {
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
    // Only GET has a route here; HEAD and OPTIONS reach the router's own 404, not the guard's 403.
    for (const [method, status] of [
      ["GET", 200],
      ["HEAD", 404],
      ["OPTIONS", 404],
    ] as const) {
      const res = await send(method, "/t", {
        "sec-fetch-site": "cross-site",
        origin: "http://evil.example",
      });
      expect(res.status).toBe(status);
    }
  });
});

describe("DOCMIND_PUBLIC_ORIGIN", () => {
  const PUBLIC = "https://docmind.example.com";
  const proxied = createHttpServer(routes, { secure: false, publicOrigin: PUBLIC, log: () => {} });
  let proxiedPort = 0;
  beforeAll(async () => {
    await new Promise<void>((r) => proxied.listen(0, "127.0.0.1", r));
    proxiedPort = (proxied.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => {
      proxied.close(() => r());
      proxied.closeAllConnections();
    });
  });

  it("accepts the public origin and refuses the rewritten Host's origin", async () => {
    const host = "app.internal:3000";
    const pass = await send("POST", "/t", { host, origin: PUBLIC }, proxiedPort);
    expect(pass.status).toBe(200);
    const refused = await send("POST", "/t", { host, origin: `http://${host}` }, proxiedPort);
    expect(refused).toEqual({ status: 403, body: REFUSED });
  });

  it("still lets Sec-Fetch-Site decide first", async () => {
    const res = await send(
      "POST",
      "/t",
      { origin: PUBLIC, "sec-fetch-site": "cross-site" },
      proxiedPort,
    );
    expect(res.status).toBe(403);
  });

  it("accepts well-formed values, and treats unset or empty as off", () => {
    expect(parsePublicOrigin("https://a.example")).toBe("https://a.example");
    expect(parsePublicOrigin("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
    expect(parsePublicOrigin(undefined)).toBeUndefined();
    expect(parsePublicOrigin("")).toBeUndefined();
  });

  it.each([
    "docmind.example.com",
    "https://a.example/",
    "https://a.example/app",
    "https://a.example?x=1",
    "https://user:pw@a.example",
    "ftp://a.example",
    "HTTPS://A.example",
    "not a url",
  ])("refuses to start on %s, naming only the variable", (v) => {
    expect(() => parsePublicOrigin(v)).toThrow(StartupConfigError);
    expect(() => parsePublicOrigin(v)).toThrow(
      /^DOCMIND_PUBLIC_ORIGIN must be scheme:\/\/host\[:port\]$/,
    );
  });
});

describe("refusal log sampling", () => {
  it("logs once per window per method + path, then reports the suppressed count", () => {
    const lines: string[] = [];
    let now = 1_000;
    const log = refusalLogger(
      (l) => lines.push(l),
      () => now,
    );
    for (let i = 0; i < 100; i++) log("POST", "/api/documents");
    expect(lines).toEqual(["cross-origin request refused POST /api/documents"]);
    log("DELETE", "/api/documents");
    expect(lines).toHaveLength(2);
    now += 60_000;
    log("POST", "/api/documents");
    expect(lines[2]).toBe(
      "cross-origin request refused POST /api/documents (and 99 more since the last line)",
    );
    now += 60_000;
    log("POST", "/api/documents");
    expect(lines[3]).toBe("cross-origin request refused POST /api/documents");
  });

  it("collapses id segments so the line carries no document id", () => {
    const lines: string[] = [];
    const log = refusalLogger(
      (l) => lines.push(l),
      () => 0,
    );
    log("DELETE", "/api/documents/0b9c1d2e-3f40-4a51-8b62-73849a5b6c7d");
    expect(lines).toEqual(["cross-origin request refused DELETE /api/documents/:id"]);
  });
});
