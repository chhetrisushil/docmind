import { type IncomingMessage, request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
