import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Authenticator } from "@docmind/auth";
import { UiViewResponse } from "@docmind/contracts";
import { createViews } from "@docmind/experiences";
import { InMemoryLineageStore, Lineage } from "@loom-ui/lineage";
import { ReferencePlanner } from "@loom-ui/planner";
import { InMemoryContentStore } from "@loom/plugin-content";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { commitPlan, commitPlanTo } from "../flows/visualize-document/lineage";
import { aPlan, recording, scriptedPlannerModel } from "../flows/visualize-document/testing";
import { turnExperienceId } from "../flows/visualize-turn/ids";
import { TURN_INTENT, planTurn } from "../flows/visualize-turn/plan";
import { aTurnPlan } from "../flows/visualize-turn/testing";
import { createHttpServer } from "../server";
import { uiRoutes } from "./routes";

const ID = {
  tenantId: "7f6d1b8e-3b0a-4a56-8f2f-0a8e0f7c4d11",
  userId: "0b4f7d52-6c53-4c6e-9d49-2b0e7a3f9a10",
};
const BOB_ID = { tenantId: ID.tenantId, userId: "1c1c1c1c-1c1c-4c1c-8c1c-1c1c1c1c1c1c" };
const authenticator: Authenticator = {
  authenticate: async (req: IncomingMessage) =>
    req.headers["x-test-user"] === "alice"
      ? ID
      : req.headers["x-test-user"] === "bob"
        ? BOB_ID
        : null,
} as never;
const CHAT = "00000000-0000-4000-8000-0000000000c1";
const CHAT_NO_HEAD = "00000000-0000-4000-8000-0000000000c2";
const GONE_DOC = "00000000-0000-4000-8000-0000000000d9";
let ownedFails = false;
const turnFactCalls: unknown[] = [];
const ownsCalls: [string, string][] = [];
const target = (r: { userId: string; chatId: string; ord: number }) => ({
  experienceId: turnExperienceId(r),
  intent: TURN_INTENT,
  sourceKind: "turn-visuals",
});
const at = () => "2026-11-08T10:00:00.000Z";
const MINE = "00000000-0000-4000-8000-0000000000a1";
const MINE_EMPTY = "00000000-0000-4000-8000-0000000000a2";
const THEIRS = "00000000-0000-4000-8000-0000000000b1";
const lineage = new Lineage({
  events: new InMemoryLineageStore(),
  content: new InMemoryContentStore(),
});
const visualFactCalls: unknown[] = [];
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
      lineage,
      owns: async (_identity, id) => id === MINE || id === MINE_EMPTY,
      ownsChat: async (identity, id) => {
        ownsCalls.push([identity.userId, id]);
        return identity.userId === ID.userId && (id === CHAT || id === CHAT_NO_HEAD); // alice's chats; bob owns none
      },
      ownedDocuments: async (_identity, ids) => {
        if (ownedFails) throw new TypeError("db down");
        return new Set(ids.filter((d) => d !== GONE_DOC));
      },
      readersFor: (identity) => {
        builtFor.push(identity);
        return {
          documents: async (a) => {
            readerCalls.push(["documents", a]);
            return { items: [], truncated: false };
          },
          document: async () => null,
          content: async () => null,
          source: async () => null,
          chats: async () => [],
          visualFacts: async (a) => {
            visualFactCalls.push(a);
            return [
              {
                kind: "figure",
                label: "Revenue",
                value: 4242,
                unit: "USD",
                chunkIds: [],
                ordinal: 0,
              },
            ];
          },
          turnFacts: async (a) => {
            turnFactCalls.push(a);
            return [
              {
                kind: "figure",
                label: "Revenue",
                value: 4242,
                unit: "USD",
                chunkIds: [],
                ordinal: 0,
              },
            ];
          },
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
  it("does not echo a client-chosen params key in a 400", async () => {
    const one = await req("doc-total");
    const bad = await post({
      view: "library",
      requests: [{ ...one, params: { "sentinel-key-xyz": {} } }],
    });
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain("sentinel");
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

describe("GET /api/ui/documents/:id/detail", () => {
  const detail = async (id: string, query = "", user = "alice") =>
    get(`/api/ui/documents/${id}/detail${query}`, user);
  const commit = async (id: string) => {
    const plan = await aPlan("revenue", "Revenue");
    await commitPlan(
      lineage,
      { tenantId: ID.tenantId, userId: ID.userId, documentId: id },
      plan,
      () => "2026-11-08T10:00:00.000Z",
    );
  };

  it("answers 404 (never 403) for a document that is not the caller's, a missing one and a malformed id", async () => {
    for (const id of [THEIRS, "00000000-0000-4000-8000-0000000000ff", "nope"]) {
      const res = await detail(id);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    }
    expect((await detail(MINE, "", "")).status).toBe(401);
  });

  it("serves the static detail's blueprint when the document has no visuals", async () => {
    const stat = UiViewResponse.parse(await (await get("/api/ui/views/detail")).json());
    const res = await detail(MINE_EMPTY);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = UiViewResponse.parse(await res.json());
    expect(body.blueprint).toEqual(stat.blueprint);
    expect(body.versionHash).toBe(stat.versionHash);
  });

  it("adds the Visuals panel once the lineage has a head, on both surfaces", async () => {
    await commit(MINE);
    const stat = UiViewResponse.parse(await (await get("/api/ui/views/detail")).json());
    for (const query of ["", "?surface=terminal"]) {
      const body = UiViewResponse.parse(await (await detail(MINE, query)).json());
      expect(body.versionHash).not.toBe(stat.versionHash);
      expect(JSON.stringify(body.blueprint)).toContain("v-revenue");
      expect(body.inventory.handles.map((h) => h.handle)).toContain("fact-0");
    }
    expect((await detail(MINE, "?surface=hologram")).status).toBe(400);
  });

  it("falls back to the static detail when the line is erased or unreadable", async () => {
    const erased = {
      resolveLatest: async () => ({ ok: false, refusal: { kind: "line-erased" } }),
    } as never;
    const stat = UiViewResponse.parse(await (await get("/api/ui/views/detail")).json());
    const server = createHttpServer(
      uiRoutes({
        authenticator,
        views: createViews({ placeholderKey: "k".repeat(32), revisionKey: "r".repeat(32) }),
        readers: {} as never,
        lineage: erased,
        owns: async () => true,
      }),
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ui/documents/${MINE}/detail`;
      const body = UiViewResponse.parse(
        await (await fetch(url, { headers: { "x-test-user": "alice" } })).json(),
      );
      expect(body.versionHash).toBe(stat.versionHash);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("hydrates fact-0 through the document, reshaped, with one visualFacts read", async () => {
    const served = UiViewResponse.parse(await (await detail(MINE)).json());
    visualFactCalls.length = 0;
    const res = await post({
      document: MINE,
      requests: [
        {
          experienceId: served.experienceId,
          versionHash: served.versionHash,
          handle: "fact-0",
          params: {},
        },
      ],
    });
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as { results: { state: string; value: unknown }[] };
    expect(results[0]?.state).toBe("ready");
    expect(JSON.stringify(results[0]?.value)).toContain("4242");
    expect(visualFactCalls).toEqual([{ id: MINE }]);
  });

  it("refuses to hydrate another user's document (404), and a stale version hash is a finding, not data", async () => {
    const other = await post({
      document: THEIRS,
      requests: [
        { experienceId: "docmind.detail", versionHash: "x", handle: "fact-0", params: {} },
      ],
    });
    expect(other.status).toBe(404);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const stale = await post({
      document: MINE,
      requests: [
        {
          experienceId: "docmind.detail",
          versionHash: "sha256:stale",
          handle: "fact-0",
          params: {},
        },
      ],
    });
    const { results } = (await stale.json()) as { results: { state: string }[] };
    expect(results[0]?.state).toBe("error");
    expect(log).toHaveBeenCalledWith("ui finding version-mismatch");
    log.mockRestore();
  });
});

describe("GET /api/ui/chats/:id/turns/:ord/visuals", () => {
  beforeAll(async () => {
    // alice's head, and a head on the same chat id under bob's user id: only the owner check can keep bob out
    await commitPlanTo(
      lineage,
      target({ userId: ID.userId, chatId: CHAT, ord: 4 }),
      await aTurnPlan("headline", "Revenue"),
      at,
    );
    await commitPlanTo(
      lineage,
      target({ userId: BOB_ID.userId, chatId: CHAT, ord: 4 }),
      await aTurnPlan("headline", "Revenue"),
      at,
    );
    // a head whose only widget binds a document that is no longer the caller's: it drops out, nothing survives
    const model = scriptedPlannerModel([
      JSON.stringify({
        summary: "s",
        nodes: [
          {
            id: "g1",
            type: "KeyFigure",
            label: "Gone",
            span: 4,
            props: {},
            binding: { capability: "fact-0", arguments: {}, path: "value", priority: "P0" },
          },
        ],
      }),
    ]);
    const gone = await planTurn(
      new ReferencePlanner({ model, modelId: "test" }),
      [
        {
          fact: { kind: "figure", label: "Gone", value: 1, chunkIds: [], ordinal: 0 },
          origin: { kind: "doc", documentId: GONE_DOC },
        },
      ],
      recording(),
    );
    await commitPlanTo(lineage, target({ userId: ID.userId, chatId: CHAT, ord: 6 }), gone, at);
  });
  it("serves the compiled turn visuals to the owner, uncacheable", async () => {
    const res = await get(`/api/ui/chats/${CHAT}/turns/4/visuals?surface=web`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const body = UiViewResponse.parse(await res.json());
    expect(body.view).toBe("turn");
    expect(body.inventory.handles.length).toBeGreaterThan(0);
  });
  it("is 404 for a user who does not own the chat even though a head exists under their id: the owner check is what refuses", async () => {
    ownsCalls.length = 0;
    expect((await get(`/api/ui/chats/${CHAT}/turns/4/visuals`, "bob")).status).toBe(404);
    expect(ownsCalls).toEqual([[BOB_ID.userId, CHAT]]);
  });
  it("a database failure while checking the documents is a 500 logged apart from 'head unavailable', never a silent 404", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    ownedFails = true;
    try {
      expect((await get(`/api/ui/chats/${CHAT}/turns/4/visuals`)).status).toBe(500);
      expect(log).toHaveBeenCalledWith("turn visuals documents lookup failed", "TypeError");
      expect(log).not.toHaveBeenCalledWith("turn visuals head unavailable", expect.anything());
    } finally {
      ownedFails = false;
      log.mockRestore();
    }
  });
  it("is 401 without a session, 404 for a chat or turn without a head, a malformed id or ord, and a head none of whose widgets survive; 400 for an unknown surface", async () => {
    expect((await get(`/api/ui/chats/${CHAT}/turns/4/visuals`, "")).status).toBe(401);
    expect((await get(`/api/ui/chats/${CHAT_NO_HEAD}/turns/4/visuals`)).status).toBe(404);
    expect((await get(`/api/ui/chats/${CHAT}/turns/5/visuals`)).status).toBe(404); // no head for that ord
    expect((await get(`/api/ui/chats/${CHAT}/turns/6/visuals`)).status).toBe(404); // its only document is gone
    for (const bad of ["x", "0", "01", "-1"])
      expect((await get(`/api/ui/chats/${CHAT}/turns/${bad}/visuals`)).status, bad).toBe(404);
    expect((await get("/api/ui/chats/not-a-uuid/turns/4/visuals")).status).toBe(404);
    expect((await get(`/api/ui/chats/${CHAT}/turns/4/visuals?surface=paper`)).status).toBe(400);
  });
});

describe("POST /api/ui/hydrate with a turn", () => {
  it("hydrates the turn's extracted fact for its owner", async () => {
    const view = UiViewResponse.parse(
      await (await get(`/api/ui/chats/${CHAT}/turns/4/visuals?surface=web`)).json(),
    );
    const handle = view.inventory.handles[0]?.handle as string;
    const res = await post({
      turn: { chatId: CHAT, ord: 4 },
      requests: [
        { experienceId: view.experienceId, versionHash: view.versionHash, handle, params: {} },
      ],
    });
    expect(res.status).toBe(200);
    const { results } = (await res.json()) as { results: { state: string }[] };
    expect(results[0]?.state).toBe("ready");
    expect(turnFactCalls).toContainEqual({ chatId: CHAT, ord: 4 });
  });
  it("is 404 for a user who does not own the chat, and for a turn without a head", async () => {
    const req = { experienceId: "e", versionHash: "h", handle: "fact-0", params: {} };
    ownsCalls.length = 0;
    expect((await post({ turn: { chatId: CHAT, ord: 4 }, requests: [req] }, "bob")).status).toBe(
      404,
    );
    expect(ownsCalls).toEqual([[BOB_ID.userId, CHAT]]);
    expect((await post({ turn: { chatId: CHAT_NO_HEAD, ord: 4 }, requests: [req] })).status).toBe(
      404,
    );
  });
});

describe("a document's detail says where its visuals stand", () => {
  const STATE_DOC = "00000000-0000-4000-8000-0000000000e1";
  const calls: [string, string, boolean][] = [];
  let answer: "none" | "ready" | "failed" | "running" = "failed";
  let headNow = async () => {};
  let serverUrl = "";
  let stop = async () => {};
  beforeAll(async () => {
    const lin = new Lineage({
      events: new InMemoryLineageStore(),
      content: new InMemoryContentStore(),
    });
    headNow = async () => {
      await commitPlan(
        lin,
        { tenantId: ID.tenantId, userId: ID.userId, documentId: STATE_DOC },
        await aPlan("revenue", "Revenue"),
        at,
      );
    };
    const server = createHttpServer(
      uiRoutes({
        authenticator,
        views: createViews({ placeholderKey: "k".repeat(32), revisionKey: "r".repeat(32) }),
        readers: {} as never,
        lineage: lin,
        owns: async (identity, id) => identity.userId === ID.userId && id === STATE_DOC,
        visualsState: async (identity, id, hasHead) => {
          calls.push([identity.userId, id, hasHead]);
          return answer;
        },
      }),
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    stop = () => new Promise<void>((r) => server.close(() => r()));
  });
  afterAll(() => stop());
  const detailOf = (id: string, user = "alice") =>
    fetch(`${serverUrl}/api/ui/documents/${id}/detail?surface=web`, {
      headers: { "x-test-user": user },
    });

  it("adds visuals.state for the owner, asked with the caller's identity and whether a head exists", async () => {
    for (const state of ["none", "ready", "failed", "running"] as const) {
      answer = state;
      const body = UiViewResponse.parse(await (await detailOf(STATE_DOC)).json());
      expect(body.visuals).toEqual({ state });
    }
    expect(calls.at(-1)).toEqual([ID.userId, STATE_DOC, false]);
    await headNow();
    answer = "ready";
    await detailOf(STATE_DOC);
    expect(calls.at(-1)).toEqual([ID.userId, STATE_DOC, true]);
  });

  it("is owner-only: another user's, an unknown and a malformed id are the same 404 and the state is never asked", async () => {
    calls.length = 0;
    expect((await detailOf(STATE_DOC, "bob")).status).toBe(404);
    expect((await detailOf("00000000-0000-4000-8000-0000000000ff")).status).toBe(404);
    expect((await detailOf("not-a-uuid")).status).toBe(404);
    expect(calls).toEqual([]);
  });
});
