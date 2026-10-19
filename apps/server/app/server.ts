import { type Server, createServer } from "node:http";
import { type OriginGuardOptions, isSameOriginRequest } from "./http/originGuard";
import { type Handler, type RouteContext, json, sendError } from "./http/respond";

const baseRoutes: Record<string, Handler> = {
  "GET /healthz": (_req, res) => json(res, 200, { status: "ok" }),
};

interface Pattern {
  method: string;
  segments: string[]; // ":name" entries are parameters
  handler: Handler;
}

function compile(routes: Record<string, Handler>): Pattern[] {
  return Object.entries(routes)
    .filter(([key]) => key.includes("/:"))
    .map(([key, handler]) => {
      const space = key.indexOf(" ");
      return { method: key.slice(0, space), segments: key.slice(space + 1).split("/"), handler };
    });
}

/** Segment-by-segment comparison; no pattern is ever built from client input. */
function match(
  patterns: Pattern[],
  method: string,
  path: string,
): { handler: Handler; ctx: RouteContext } | undefined {
  const parts = path.split("/");
  for (const p of patterns) {
    if (p.method !== method || p.segments.length !== parts.length) continue;
    // No prototype, so a parameter value or name such as "__proto__" is plain data.
    const params: Record<string, string> = Object.create(null);
    let ok = true;
    for (let i = 0; i < parts.length && ok; i++) {
      const want = p.segments[i] as string;
      const got = parts[i] as string;
      if (want.startsWith(":")) {
        try {
          params[want.slice(1)] = decodeURIComponent(got);
          ok = got !== "";
        } catch {
          ok = false; // malformed percent-encoding never matches
        }
      } else {
        ok = want === got;
      }
    }
    if (ok) return { handler: p.handler, ctx: { params } };
  }
  return undefined;
}

/** The HTTP edge. Routes are keyed "METHOD /path"; unknown routes are a JSON 404. */
export function createHttpServer(
  extraRoutes: Record<string, Handler> = {},
  guard: OriginGuardOptions = { secure: false },
): Server {
  const routes = { ...baseRoutes, ...extraRoutes };
  const patterns = compile(routes);
  // Parameterised keys never match literally: `GET /things/:id` as a request is a pattern match.
  const exactRoutes = Object.fromEntries(
    Object.entries(routes).filter(([key]) => !key.includes("/:")),
  );
  return createServer((req, res) => {
    let path: string;
    try {
      path = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      return sendError(res, 400, "bad_request", "invalid request target");
    }
    const method = req.method ?? "GET";
    // The one place a state-changing request is checked, before routing, so no route can skip it.
    if (!isSameOriginRequest(req, guard)) {
      // The method only: the path of an unauthenticated, attacker-driven request can carry a document id.
      console.error("cross-origin request refused", method);
      req.resume();
      res.setHeader("connection", "close");
      return json(res, 403, { error: { code: "cross_origin_request" } });
    }
    const key = `${method} ${path}`;
    const exact = Object.hasOwn(exactRoutes, key) ? exactRoutes[key] : undefined;
    const found = exact
      ? { handler: exact, ctx: { params: {} } satisfies RouteContext }
      : match(patterns, method, path);
    if (!found) return sendError(res, 404, "not_found", "no such route");
    // The async wrapper turns a synchronous throw and a rejected promise into the same failure.
    (async () => found.handler(req, res, found.ctx))().catch((err: unknown) => {
      // Class name, method and path only: the message could carry a secret. The client gets the
      // fixed body below, never the error.
      console.error(
        "handler failed",
        method,
        path,
        err instanceof Error ? err.constructor.name : typeof err,
      );
      if (res.headersSent) res.end();
      else sendError(res, 500, "internal", "internal error");
    });
  });
}
