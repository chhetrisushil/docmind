import type { AddressInfo } from "node:net";
import type { Authenticator, Identity } from "@docmind/auth";
import { type MockInstance, afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHttpServer } from "../server";
import { requireAuth } from "./requireAuth";
import { json } from "./respond";

const ALICE: Identity = {
  tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  userId: "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1",
};

/** Accepts only the header `x-test-user: alice`; `x-test-user: down` simulates an outage. */
const authenticator: Authenticator = {
  async authenticate(req) {
    const who = req.headers["x-test-user"];
    if (who === "down") throw new Error("database unavailable");
    return who === "alice" ? ALICE : null;
  },
};

let handlerRuns = 0;
const server = createHttpServer({
  "GET /whoami": requireAuth(authenticator, (_req, res, identity) => {
    handlerRuns++;
    json(res, 200, identity);
  }),
  "GET /whoami/:name": requireAuth(authenticator, (_req, res, identity, ctx) => {
    handlerRuns++;
    json(res, 200, { name: ctx.params.name, ...identity });
  }),
});
let base = "";
let consoleError: MockInstance<typeof console.error>;

beforeAll(async () => {
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  consoleError.mockRestore();
});

describe("requireAuth", () => {
  it("gives the handler the authenticated identity", async () => {
    const res = await fetch(`${base}/whoami`, { headers: { "x-test-user": "alice" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(ALICE);
  });

  it("answers 401 without running the handler when nobody is authenticated", async () => {
    handlerRuns = 0;
    const res = await fetch(`${base}/whoami`, { headers: { "x-test-user": "mallory" } });
    expect(res.status).toBe(401);
    expect(handlerRuns).toBe(0);
    expect(await res.json()).toEqual({
      error: { code: "unauthorized", message: "authentication required" },
    });
  });

  it("answers 500, not 401 and not access, when the authenticator itself fails", async () => {
    handlerRuns = 0;
    const res = await fetch(`${base}/whoami`, { headers: { "x-test-user": "down" } });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: "internal", message: "internal error" } });
    expect(handlerRuns).toBe(0);
    expect(consoleError).toHaveBeenCalledWith("handler failed", "GET", "/whoami", "Error");
  });

  it("passes route parameters through to the handler, and not past a 401", async () => {
    const ok = await fetch(`${base}/whoami/x`, { headers: { "x-test-user": "alice" } });
    expect(await ok.json()).toEqual({ name: "x", ...ALICE });
    handlerRuns = 0;
    expect((await fetch(`${base}/whoami/x`)).status).toBe(401);
    expect(handlerRuns).toBe(0);
  });
});
