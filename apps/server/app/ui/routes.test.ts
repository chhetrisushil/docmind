import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Authenticator } from "@docmind/auth";
import { UiViewResponse } from "@docmind/contracts";
import { createViews } from "@docmind/experiences";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHttpServer } from "../server";
import { uiRoutes } from "./routes";

const ID = {
  tenantId: "7f6d1b8e-3b0a-4a56-8f2f-0a8e0f7c4d11",
  userId: "0b4f7d52-6c53-4c6e-9d49-2b0e7a3f9a10",
};
const authenticator: Authenticator = {
  authenticate: async (req: IncomingMessage) =>
    req.headers["x-test-user"] === "alice" ? ID : null,
} as never;
const readerCalls: unknown[] = [];
const builtFor: unknown[] = [];
let base = "";
let close = async () => {};

beforeAll(async () => {
  const views = createViews({
    placeholderKey: "k".repeat(32),
    revisionKey: "r".repeat(32),
    onFinding: (_handle, code) => console.error(`ui finding ${code}`),
  });
  // the route builds readers from `deps.readers` and the identity; here the pool and fields are never touched, because the fake readers replace `readersFor`
  const server = createHttpServer(
    uiRoutes({
      authenticator,
      views,
      readers: {} as never,
      readersFor: (identity) => {
        builtFor.push(identity);
        return {
          documents: async (a) => {
            readerCalls.push(["documents", a]);
            return { items: [], truncated: false };
          },
          document: async () => null,
          content: async () => null,
          chats: async () => [],
        };
      },
    }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise<void>((r) => server.close(() => r()));
});
afterAll(() => close());

const get = (path: string, user = "alice") =>
  fetch(`${base}${path}`, { headers: user ? { "x-test-user": user } : {} });
const post = (body: unknown, user = "alice", headers: Record<string, string> = {}) =>
  fetch(`${base}/api/ui/hydrate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(user ? { "x-test-user": user } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });

describe("GET /api/ui/views/:view", () => {
  it("serves the compiled view, content-free, with no-store", async () => {
    const res = await get("/api/ui/views/library");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = UiViewResponse.parse(await res.json());
    expect(body).toMatchObject({ view: "library", surface: "web" });
    expect(body.inventory.handles.map((h) => h.handle).sort()).toEqual([
      "doc-ready",
      "doc-total",
      "documents",
      "ingest",
    ]);
  });
  it("serves the terminal compile of the same view when asked", async () => {
    const web = UiViewResponse.parse(await (await get("/api/ui/views/detail")).json());
    const terminal = UiViewResponse.parse(
      await (await get("/api/ui/views/detail?surface=terminal")).json(),
    );
    expect(terminal.surface).toBe("terminal");
    expect(terminal.versionHash).toBe(web.versionHash); // one experience, two compiles
  });
  it("answers 404 for an unknown view, 400 for an unknown surface, 401 without a session, none echoing the input", async () => {
    const bad = await get("/api/ui/views/nope-sentinel-view");
    expect(bad.status).toBe(404);
    expect(bad.headers.get("cache-control")).toContain("no-store");
    expect(await bad.text()).not.toContain("sentinel");
    const surface = await get("/api/ui/views/library?surface=hologram-sentinel");
    expect(surface.status).toBe(400);
    expect(surface.headers.get("cache-control")).toContain("no-store");
    expect(await surface.text()).not.toContain("sentinel");
    const anon = await get("/api/ui/views/library", "");
    expect(anon.status).toBe(401);
    expect(anon.headers.get("cache-control")).toContain("no-store");
  });
});

describe("POST /api/ui/hydrate", () => {
  const req = async (handle: string, params: Record<string, unknown> = {}) => {
    const v = UiViewResponse.parse(await (await get("/api/ui/views/library")).json());
    return { experienceId: v.experienceId, versionHash: v.versionHash, handle, params };
  };
  it("answers one result per request, in order, from the readers the identity built", async () => {
    const res = await post({
      view: "library",
      requests: [await req("doc-total"), await req("documents", { status: "ready" })],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const { results } = (await res.json()) as { results: { state: string }[] };
    expect(results.map((r) => r.state)).toEqual(["ready", "ready"]);
    expect(readerCalls).toContainEqual(["documents", { limit: 200, status: "ready" }]);
  });
  it("builds the readers fresh for every request, from the session identity only", async () => {
    builtFor.length = 0;
    const one = await req("doc-total");
    await post({ view: "library", requests: [one] });
    await post({ view: "library", requests: [one], tenantId: "x", userId: "y" });
    expect(builtFor).toEqual([ID, ID]);
    expect(builtFor[0]).toBe(builtFor[1]); // the authenticator hands out one object; the readers are what is fresh, see the pg test for two users
  });
  it("answers 400 for an unknown view or surface body without echoing it, and 413 for an oversize body", async () => {
    const one = await req("doc-total");
    const unknown = await post({ view: "nope-sentinel-view", requests: [one] });
    expect(unknown.status).toBe(400);
    expect(unknown.headers.get("cache-control")).toBe("no-store");
    expect(await unknown.text()).not.toContain("sentinel");
    const big = await post({
      view: "library",
      requests: [{ ...one, params: { q: "x".repeat(40_000) } }],
    });
    expect(big.status).toBe(413);
  });
  it("refuses a malformed body, an anonymous caller and a cross-origin post", async () => {
    const empty = await post({ view: "library", requests: [] });
    expect(empty.status).toBe(400);
    expect(empty.headers.get("cache-control")).toBe("no-store");
    expect((await post({ view: "library", requests: [await req("doc-total")] }, "")).status).toBe(
      401,
    );
    const cross = await post({ view: "library", requests: [await req("doc-total")] }, "alice", {
      "sec-fetch-site": "cross-site",
    });
    expect(cross.status).toBe(403);
    expect(((await cross.json()) as { error: { code: string } }).error.code).toBe(
      "cross_origin_request",
    );
  });
  it("logs a finding's code and nothing else when a load fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await post({
      view: "detail",
      requests: [
        {
          experienceId: "docmind.detail",
          versionHash: "sha256:stale",
          handle: "doc-status",
          params: { id: "sentinel-id-0123456789" },
        },
      ],
    });
    // not vacuous: the finding WAS logged, as its code alone
    expect(error.mock.calls.length).toBeGreaterThan(0);
    for (const call of error.mock.calls) {
      expect(call).toHaveLength(1);
      expect(call[0]).toMatch(/^ui finding [a-z-]+$/);
      expect(JSON.stringify(call)).not.toMatch(/sentinel|doc-status/);
    }
    error.mockRestore();
  });
});
