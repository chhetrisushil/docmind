import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { positiveInt } from "./documents/limits";
import { type OriginGuardOptions, isSameOriginRequest, refusalLogger } from "./http/originGuard";
import { type Handler, type RouteContext, json, sendError } from "./http/respond";

const baseRoutes: Record<string, Handler> = {
  "GET /healthz": (_req, res) => json(res, 200, { status: "ok" }),
};

interface Pattern {
  method: string;
  route: string; // the pattern path, as registered
  segments: string[]; // ":name" entries are parameters
  handler: Handler;
}

function compile(routes: Record<string, Handler>): Pattern[] {
  return Object.entries(routes)
    .filter(([key]) => key.includes("/:"))
    .map(([key, handler]) => {
      const space = key.indexOf(" ");
      const route = key.slice(space + 1);
      return { method: key.slice(0, space), route, segments: route.split("/"), handler };
    });
}

/** Segment-by-segment comparison; no pattern is ever built from client input. */
function match(
  patterns: Pattern[],
  method: string,
  path: string,
): { handler: Handler; ctx: RouteContext; route: string } | undefined {
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
    if (ok) return { handler: p.handler, ctx: { params }, route: p.route };
  }
  return undefined;
}

/** Server limits; every field is overridable so a test can set a small value and await the event. */
export interface HttpLimits {
  headersTimeoutMs: number;
  /** Per-route, for every route except the streaming ones. */
  requestTimeoutMs: number;
  keepAliveTimeoutMs: number;
  maxConnections: number;
  maxHeadersCount: number;
  /** How often Node checks the header timeout (its default is 30 s). */
  connectionsCheckingIntervalMs?: number;
  /** "METHOD /pattern" keys that stream and so never get the request timer. */
  streamingRoutes: ReadonlySet<string>;
}

export const DEFAULT_MAX_CONNECTIONS = 2000;

export const DEFAULT_HTTP_LIMITS: HttpLimits = {
  headersTimeoutMs: 20_000,
  requestTimeoutMs: 60_000,
  keepAliveTimeoutMs: 5_000,
  maxConnections: DEFAULT_MAX_CONNECTIONS,
  maxHeadersCount: 100,
  // The upload streams a multipart body; the event stream is open-ended by design.
  streamingRoutes: new Set(["POST /api/documents", "GET /api/documents/events"]),
};

/** `DOCMIND_MAX_CONNECTIONS` (default 2000, at most 65535); a bad value fails the boot. */
export function loadMaxConnections(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(env, "DOCMIND_MAX_CONNECTIONS", DEFAULT_MAX_CONNECTIONS, 65_535);
}

/** The HTTP edge. Routes are keyed "METHOD /path"; unknown routes are a JSON 404. */
export function createHttpServer(
  extraRoutes: Record<string, Handler> = {},
  guard: OriginGuardOptions = { secure: false },
  limitOverrides: Partial<HttpLimits> = {},
): Server {
  const limits = { ...DEFAULT_HTTP_LIMITS, ...limitOverrides };
  const routes = { ...baseRoutes, ...extraRoutes };
  const logRefusal = guard.log ?? refusalLogger();
  const patterns = compile(routes);
  // Parameterised keys never match literally: `GET /things/:id` as a request is a pattern match.
  const exactRoutes = Object.fromEntries(
    Object.entries(routes).filter(([key]) => !key.includes("/:")),
  );
  // Node's requestTimeout is server-wide, so it is off and the router arms a per-route timer.
  const nodeOptions = {
    requestTimeout: 0,
    connectionsCheckingInterval: limits.connectionsCheckingIntervalMs,
  };
  const server = createServer(nodeOptions, (req, res) => {
    let path: string;
    try {
      path = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      return sendError(res, 400, "bad_request", "invalid request target");
    }
    const method = req.method ?? "GET";
    const key = `${method} ${path}`;
    const exact = Object.hasOwn(exactRoutes, key) ? exactRoutes[key] : undefined;
    const found = exact
      ? { handler: exact, ctx: { params: {} } satisfies RouteContext, route: path }
      : match(patterns, method, path);
    // The one place a state-changing request is checked, before routing, so no route can skip it.
    if (!isSameOriginRequest(req, guard)) {
      // The matched route pattern, never the raw path: an attacker-driven path can carry anything.
      logRefusal(method, found?.route ?? "(unrouted)");
      req.resume();
      res.setHeader("connection", "close");
      return json(res, 403, { error: { code: "cross_origin_request" } });
    }
    if (!found) return sendError(res, 404, "not_found", "no such route");
    if (!limits.streamingRoutes.has(`${method} ${found.route}`))
      armRequestTimeout(req, res, limits);
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
  server.headersTimeout = limits.headersTimeoutMs;
  server.keepAliveTimeout = limits.keepAliveTimeoutMs;
  server.maxConnections = limits.maxConnections;
  server.maxHeadersCount = limits.maxHeadersCount;
  return server;
}

/** Cut a request that outlives its budget; the timer never outlives the response. */
function armRequestTimeout(req: IncomingMessage, res: ServerResponse, limits: HttpLimits): void {
  const timer = setTimeout(() => {
    if (res.headersSent) req.socket.destroy();
    else {
      res.setHeader("connection", "close");
      sendError(res, 503, "timeout", "the request took too long");
      req.resume();
    }
  }, limits.requestTimeoutMs);
  const clear = () => clearTimeout(timer);
  res.once("finish", clear);
  res.once("close", clear);
}
