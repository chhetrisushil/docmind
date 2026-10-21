import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
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
writeFileSync(join(dir, "assets", "big.js"), Buffer.alloc(48 * 1024 * 1024, 97));
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
    const odd = mkdtempSync(join(tmpdir(), "dm-odd-"));
    mkdirSync(join(odd, "index.html")); // a directory, not a file
    expect(() => loadWebDir(odd)).toThrow(StartupConfigError);
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

  it("keeps /api paths JSON whatever the case or encoding", async () => {
    expect((await raw("/api")).status).toBe(200); // "/api" itself is a client route
    for (const path of [
      "/api/x/y",
      "/API/x",
      "/Api/x/y",
      "//api/x",
      "///api/x",
      "/api%2fx",
      "/API%2Fx",
      "/%61pi/x",
    ]) {
      const res = await raw(path);
      expect(res.status, path).toBe(404);
      expect(res.body, path).toContain("not_found");
      expect(res.body, path).not.toContain("<dm-app>");
    }
  });

  it("refuses an absolute-form request target", async () => {
    const res = await raw(`http://127.0.0.1:${port}/assets/app-abc123.js`);
    expect(res.status).toBe(400);
  });

  it("refuses a source map or dotfile whatever the case", async () => {
    for (const path of ["/assets/app-abc123.js.MAP", "/assets/app-abc123.js.Map", "/.ENV"]) {
      const res = await raw(path);
      expect([400, 404], path).toContain(res.status);
      expect(res.body, path).not.toContain("sentinel-");
    }
  });

  it("serves an uppercase extension with its type", async () => {
    writeFileSync(join(dir, "assets", "LOGO.PNG"), "png");
    expect((await fetch(`${base}/assets/LOGO.PNG`)).headers.get("content-type")).toBe("image/png");
  });

  it("does not exempt the static fallback from the request timer", () => {
    expect(DEFAULT_HTTP_LIMITS.streamingRoutes.has("GET (web)")).toBe(false);
    expect(DEFAULT_HTTP_LIMITS.streamingRoutes.has("HEAD (web)")).toBe(false);
  });

  it("destroys a static response whose client stops reading", async () => {
    const slow = createHttpServer(
      {},
      { secure: false },
      { requestTimeoutMs: 100 },
      staticHandler(dir),
    );
    await new Promise<void>((r) => slow.listen(0, "127.0.0.1", r));
    const closed = new Promise<void>((r) =>
      slow.on("connection", (sock) => sock.on("close", () => r())),
    );
    const sock = connect((slow.address() as AddressInfo).port, "127.0.0.1");
    sock.write("GET /assets/big.js HTTP/1.1\r\nhost: x\r\n\r\n");
    sock.pause(); // never read
    await Promise.race([
      closed,
      new Promise((_, rej) => setTimeout(() => rej(new Error("socket was not destroyed")), 5000)),
    ]);
    sock.destroy();
    await new Promise<void>((r) => slow.close(() => r()));
  });

  it("refuses an in-root symlink that points at a source map", async () => {
    symlinkSync(join(dir, "assets", "app-abc123.js.map"), join(dir, "assets", "alias.js"));
    const res = await raw("/assets/alias.js");
    expect(res.status).toBe(404);
    expect(res.body).not.toContain("sentinel-");
  });
});
