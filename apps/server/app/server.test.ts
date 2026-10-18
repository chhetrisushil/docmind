import { type IncomingMessage, request } from "node:http";
import type { AddressInfo } from "node:net";
import { type MockInstance, afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHttpServer } from "./server";

const server = createHttpServer();
let base = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("http server", () => {
  it("GET /healthz returns ok", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("answers an unknown route with a JSON 404", async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "no such route" } });
  });

  it("answers an unparseable request target with a JSON 400 and keeps serving", async () => {
    // fetch normalizes URLs, so send the raw target `//` (invalid against a base URL).
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      request({ host: "127.0.0.1", port: Number(new URL(base).port), path: "//" }, resolve)
        .on("error", reject)
        .end();
    });
    expect(res.statusCode).toBe(400);
    let body = "";
    for await (const chunk of res) body += chunk;
    expect(JSON.parse(body).error).toEqual({
      code: "bad_request",
      message: "invalid request target",
    });
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });
});

describe("handler failures", () => {
  const marked = new Error("secret detail sk-live-1234");
  const failing = createHttpServer({
    "GET /rejects": async () => {
      throw new Error("boom");
    },
    "GET /throws": () => {
      throw new Error("boom");
    },
    "GET /marked": () => {
      throw marked;
    },
    "GET /rejects-after-headers": async (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("partial");
      throw new Error("boom");
    },
  });
  let url = "";
  let consoleError: MockInstance<typeof console.error>;

  beforeAll(async () => {
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await new Promise<void>((resolve) => failing.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(failing.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      failing.close(() => resolve());
      failing.closeAllConnections();
    });
    consoleError.mockRestore();
  });

  it.each(["/rejects", "/throws"])(
    "answers a JSON 500 when %s fails, and keeps serving",
    async (path) => {
      const res = await fetch(`${url}${path}`);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: { code: "internal", message: "internal error" } });
      expect((await fetch(`${url}/healthz`)).status).toBe(200);
    },
  );

  it("logs the failure server-side and keeps the 500 body fixed", async () => {
    const res = await fetch(`${url}/marked`);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: { code: "internal", message: "internal error" } });
    expect(body).not.toContain("secret detail");
    // P11: class name, method and path only; never the error object or its message.
    expect(consoleError).toHaveBeenCalledWith("handler failed", "GET", "/marked", "Error");
    const logged = JSON.stringify(consoleError.mock.calls);
    expect(logged).not.toContain("secret detail");
    for (const call of consoleError.mock.calls) expect(call).not.toContain(marked);
  });

  it("ends a response that already started instead of hanging or crashing", async () => {
    const res = await fetch(`${url}/rejects-after-headers`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("partial");
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
  });
});

describe("route parameters", () => {
  const withParams = createHttpServer({
    "GET /things/:id": (_req, res, ctx) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: ctx.params.id }));
    },
    "GET /things/new": (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ exact: true }));
    },
    "DELETE /things/:id/parts/:part": (_req, res, ctx) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(ctx.params));
    },
  });
  let paramBase = "";

  beforeAll(async () => {
    await new Promise<void>((resolve) => withParams.listen(0, "127.0.0.1", resolve));
    paramBase = `http://127.0.0.1:${(withParams.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => withParams.close(() => resolve()));
  });

  it("passes a path segment as a parameter, decoded", async () => {
    expect(await (await fetch(`${paramBase}/things/abc`)).json()).toEqual({ id: "abc" });
    expect(await (await fetch(`${paramBase}/things/a%20b`)).json()).toEqual({ id: "a b" });
  });

  it("prefers an exact route to a parameterised one", async () => {
    expect(await (await fetch(`${paramBase}/things/new`)).json()).toEqual({ exact: true });
  });

  it("supports several parameters and requires the method to match", async () => {
    const del = await fetch(`${paramBase}/things/1/parts/2`, { method: "DELETE" });
    expect(await del.json()).toEqual({ id: "1", part: "2" });
    expect((await fetch(`${paramBase}/things/1/parts/2`)).status).toBe(404);
  });

  it("does not match an empty segment, an extra segment or a bad escape", async () => {
    expect((await fetch(`${paramBase}/things/`)).status).toBe(404);
    expect((await fetch(`${paramBase}/things/a/b`)).status).toBe(404);
    expect((await fetch(`${paramBase}/things/%E0%A4%A`)).status).toBe(404);
  });

  it("matches a literal colon segment through the pattern, with the segment as the value", async () => {
    expect(await (await fetch(`${paramBase}/things/:id`)).json()).toEqual({ id: ":id" });
  });

  it("decodes an encoded slash into one segment", async () => {
    expect(await (await fetch(`${paramBase}/things/a%2Fb`)).json()).toEqual({ id: "a/b" });
  });

  it("treats a parameter named like an object prototype key as plain data", async () => {
    expect(await (await fetch(`${paramBase}/things/__proto__`)).json()).toEqual({
      id: "__proto__",
    });
  });
});
