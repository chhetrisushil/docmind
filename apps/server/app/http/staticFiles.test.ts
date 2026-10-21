import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_HTTP_LIMITS, createHttpServer } from "../server";
import { StartupConfigError } from "../startupError";
import { WEB_CSP, loadWebDir, staticHandler } from "./staticFiles";

const outside = mkdtempSync(join(tmpdir(), "dm-outside-"));
writeFileSync(join(outside, "secret.txt"), "sentinel-outside-0123456789");
const dir = mkdtempSync(join(tmpdir(), "dm-web-"));
mkdirSync(join(dir, "assets"));
writeFileSync(join(dir, "index.html"), "<!doctype html><dm-app></dm-app>");
writeFileSync(join(dir, "assets", "app-abc123.js"), "console.log(1)");
writeFileSync(join(dir, "assets", "app-abc123.js.map"), "sentinel-map-0123456789");
writeFileSync(join(dir, "assets", "inter.woff2"), "font");
writeFileSync(join(dir, ".env"), "sentinel-dotfile-0123456789");
symlinkSync(join(outside, "secret.txt"), join(dir, "assets", "leak.txt"));
symlinkSync(outside, join(dir, "assets", "leakdir"));

const server = createHttpServer(
  {
    "GET /api/ping": (_q, res) => {
      res.end("pong");
    },
  },
  { secure: false },
  {},
  staticHandler(dir),
);
let base = "";
let port = 0;
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

/** A raw request line, so no client normalises the path before it is sent. */
function raw(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      let body = "";
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("loadWebDir", () => {
  it("is off when unset, and refuses a directory without index.html without naming it", () => {
    expect(loadWebDir(undefined)).toBeUndefined();
    expect(loadWebDir("")).toBeUndefined();
    expect(loadWebDir(dir)).toBe(dir);
    expect(() => loadWebDir(outside)).toThrow(StartupConfigError);
    try {
      loadWebDir(outside);
    } catch (err) {
      expect((err as Error).message).toBe(
        "DOCMIND_WEB_DIR must be a directory that holds index.html",
      );
    }
    expect(() => loadWebDir(join(dir, "missing"))).toThrow(StartupConfigError);
  });
});

describe("the static fallback", () => {
  it("serves assets with their type and a year-long immutable cache, and the page with no-cache and the CSP", async () => {
    const js = await fetch(`${base}/assets/app-abc123.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(js.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await js.text()).toBe("console.log(1)");
    expect((await fetch(`${base}/assets/inter.woff2`)).headers.get("content-type")).toBe(
      "font/woff2",
    );
    const page = await fetch(`${base}/documents`); // a client route: no extension
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("cache-control")).toBe("no-cache");
    expect(page.headers.get("content-security-policy")).toBe(WEB_CSP);
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await page.text()).toContain("<dm-app>");
  });

  it("has a strict policy", () => {
    expect(WEB_CSP).not.toMatch(/unsafe-/);
    for (const d of [
      "script-src 'self'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ])
      expect(WEB_CSP).toContain(d);
  });

  it("never answers a missing asset with the page, and never leaves the directory", async () => {
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
    for (const path of [
      "/..%2f..%2fetc%2fpasswd",
      "/%2e%2e/%2e%2e/etc/passwd",
      "/assets/%00.js",
      "/.env",
      "/assets/leak.txt",
      "/assets/leakdir/secret.txt",
      "/..\\..\\etc\\passwd",
      "/assets/..%5c..%5csecret.txt",
      "/assets/app-abc123.js.map",
    ]) {
      const res = await raw(path);
      expect([400, 404], path).toContain(res.status);
      expect(res.body, path).not.toContain("sentinel-");
    }
    for (const path of [
      "/../../etc/passwd",
      "/assets/../../secret.txt",
      "//etc/passwd",
      "/%2fetc%2fpasswd",
    ]) {
      const res = await raw(path);
      expect(res.body, path).not.toContain("sentinel-");
      expect(res.body, path).not.toContain("root:");
    }
  });

  it("answers HEAD without a body, and leaves /api and every other method to the router", async () => {
    const head = await fetch(`${base}/assets/app-abc123.js`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("14");
    expect(await head.text()).toBe("");
    expect(await (await fetch(`${base}/api/ping`)).text()).toBe("pong");
    const missing = await fetch(`${base}/api/nope`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe("not_found"); // JSON, not the page
    const post = await fetch(`${base}/documents`, { method: "POST" }); // Node's fetch sends no Origin, which the guard allows
    expect(post.status).toBe(404);
    expect(((await post.json()) as { error: { code: string } }).error.code).toBe("not_found"); // JSON, not the page: the fallback answers GET and HEAD only
  });

  it("keeps /api paths JSON whatever the case or encoding of the prefix", async () => {
    const res = await raw("/api");
    expect(res.status).toBe(200); // "/api" itself is a client route, not an API path
    const nested = await raw("/api/x/y");
    expect(nested.status).toBe(404);
    expect(nested.body).toContain("not_found");
  });

  it("exempts the static fallback from the request timer, so a slow download is not cut", () => {
    expect(DEFAULT_HTTP_LIMITS.streamingRoutes.has("GET (web)")).toBe(true);
    expect(DEFAULT_HTTP_LIMITS.streamingRoutes.has("HEAD (web)")).toBe(true);
  });
});
