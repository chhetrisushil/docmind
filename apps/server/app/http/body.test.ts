import type { AddressInfo } from "node:net";
import { ErrorBody } from "@docmind/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createHttpServer } from "../server";
import { readJson } from "./body";
import { json } from "./respond";

const Echo = z.object({ name: z.string().min(1) });
const Kind = z.object({ kind: z.enum(["a", "b"]) });

const server = createHttpServer({
  "POST /echo": async (req, res) => {
    const body = await readJson(req, res, Echo);
    if (body) json(res, 200, body);
  },
  "POST /big": async (req, res) => {
    const body = await readJson(req, res, Echo, { maxBytes: 40 * 1024 });
    if (body) json(res, 200, { name: body.name.length });
  },
  "POST /whoami": (req, res) =>
    json(res, 200, { contentType: req.headers["content-type"] ?? null }),
  "POST /kind": async (req, res) => {
    const body = await readJson(req, res, Kind);
    if (body) json(res, 200, body);
  },
});
let base = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
});

const post = (body: string, type = "application/json", path = "/echo") =>
  fetch(`${base}${path}`, { method: "POST", headers: { "content-type": type }, body });

/** A valid `{"name": ...}` body of exactly `bytes` bytes. */
const nameBody = (bytes: number) => `{"name":"${"x".repeat(bytes - 11)}"}`;

describe("readJson", () => {
  it("returns the validated body", async () => {
    const res = await post(JSON.stringify({ name: "ada", extra: 1 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "ada" });
  });

  it("accepts the media type with parameters and in any case", async () => {
    const res = await post(JSON.stringify({ name: "ada" }), "Application/JSON; charset=utf-8");
    expect(res.status).toBe(200);
  });

  it("refuses a body that is not declared as JSON (a form post cannot send it)", async () => {
    const res = await post("name=ada", "application/x-www-form-urlencoded");
    expect(res.status).toBe(415);
  });

  it("refuses a body with no Content-Type", async () => {
    const sent = await fetch(`${base}/whoami`, {
      method: "POST",
      body: new TextEncoder().encode(JSON.stringify({ name: "ada" })),
    });
    expect(await sent.json()).toEqual({ contentType: null });
    const res = await fetch(`${base}/echo`, {
      method: "POST",
      body: new TextEncoder().encode(JSON.stringify({ name: "ada" })),
    });
    expect(res.status).toBe(415);
  });

  it("answers 400 for broken JSON and for a body that fails the schema", async () => {
    expect((await post("{nope")).status).toBe(400);
    const bad = await post(JSON.stringify({ name: "" }));
    expect(bad.status).toBe(400);
    expect(ErrorBody.parse(await bad.json()).error.message).toContain("name:");
  });

  it("answers 400 for bytes that are not valid UTF-8", async () => {
    const res = await fetch(`${base}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Uint8Array([0x7b, 0x22, 0x6e, 0xff, 0x22, 0x7d]),
    });
    expect(res.status).toBe(400);
  });

  it("does not echo a submitted enum value in the error", async () => {
    const res = await post(
      JSON.stringify({ kind: "SECRET-MARKER-123" }),
      "application/json",
      "/kind",
    );
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("kind:");
    expect(text).not.toContain("SECRET-MARKER-123");
  });

  it("answers 413 for an oversized body and keeps serving", async () => {
    const res = await post(JSON.stringify({ name: "x".repeat(20_000) }));
    expect(res.status).toBe(413);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it("accepts a body of exactly 16 KiB and refuses one byte more", async () => {
    expect((await post(nameBody(16_384))).status).toBe(200);
    expect((await post(nameBody(16_385))).status).toBe(413);
  });
});

describe("readJson with a larger cap", () => {
  it("accepts a body between the default cap and the route's own", async () => {
    const res = await post(nameBody(20 * 1024), "application/json", "/big");
    expect(res.status).toBe(200);
  });
  it("still refuses a body over the route's cap, by its declared length and with the connection closed", async () => {
    const res = await post(nameBody(41 * 1024), "application/json", "/big");
    expect(res.status).toBe(413);
    expect(res.headers.get("connection")).toBe("close");
  });
  it("keeps the default cap for a route that does not ask", async () => {
    expect((await post(nameBody(20 * 1024))).status).toBe(413);
  });
});
