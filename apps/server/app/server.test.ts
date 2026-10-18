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
  const marked = new Error("secret detail");
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
    expect(consoleError).toHaveBeenCalledWith("handler failed", "GET", "/marked", marked);
  });

  it("ends a response that already started instead of hanging or crashing", async () => {
    const res = await fetch(`${url}/rejects-after-headers`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("partial");
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
  });
});
