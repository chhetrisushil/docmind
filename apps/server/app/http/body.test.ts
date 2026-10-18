import type { AddressInfo } from "node:net";
import { ErrorBody } from "@docmind/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createHttpServer } from "../server";
import { readJson } from "./body";
import { json } from "./respond";

const Echo = z.object({ name: z.string().min(1) });

const server = createHttpServer({
  "POST /echo": async (req, res) => {
    const body = await readJson(req, res, Echo);
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

const post = (body: string, type = "application/json") =>
  fetch(`${base}/echo`, { method: "POST", headers: { "content-type": type }, body });

describe("readJson", () => {
  it("returns the validated body", async () => {
    const res = await post(JSON.stringify({ name: "ada", extra: 1 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "ada" });
  });

  it("refuses a body that is not declared as JSON (a form post cannot send it)", async () => {
    const res = await post("name=ada", "application/x-www-form-urlencoded");
    expect(res.status).toBe(415);
  });

  it("answers 400 for broken JSON and for a body that fails the schema", async () => {
    expect((await post("{nope")).status).toBe(400);
    const bad = await post(JSON.stringify({ name: "" }));
    expect(bad.status).toBe(400);
    expect(ErrorBody.parse(await bad.json()).error.message).toContain("name:");
  });

  it("answers 413 for an oversized body and keeps serving", async () => {
    const res = await post(JSON.stringify({ name: "x".repeat(20_000) }));
    expect(res.status).toBe(413);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });
});
