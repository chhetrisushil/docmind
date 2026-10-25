import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { CHAT_STREAM_ROUTE } from "./chats/stream";
import { EVENTS_ROUTE } from "./documents/events";
import { positiveInt } from "./documents/limits";
import { UPLOAD_ROUTE } from "./documents/routes";
import { type OriginGuardOptions, isSameOriginRequest, refusalLogger } from "./http/originGuard";
import { type Handler, type RouteContext, json, sendError } from "./http/respond";
import { StartupConfigError } from "./startupError";

const baseRoutes: Record<string, Handler> = {
  "GET /healthz": (_req, res) => json(res, 200, { status: "ok" }),
  // A balancer may probe with HEAD; without a route it would fall through to the web app's static fallback.
  "HEAD /healthz": (_req, res) => json(res, 200, { status: "ok" }),
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
  connectionsCheckingIntervalMs: 5_000,
  maxConnections: DEFAULT_MAX_CONNECTIONS,
  maxHeadersCount: 100,
  // The upload streams a multipart body; the event stream is open-ended by design, and the chat stream is open-ended too.
  // Not the static fallback: it is unauthenticated, so a client that stops reading must still be cut by the timer.
  streamingRoutes: new Set([UPLOAD_ROUTE, EVENTS_ROUTE, CHAT_STREAM_ROUTE]),
};

/** `DOCMIND_MAX_CONNECTIONS` (default 2000, at most 65535); a bad value fails the boot. */
export function loadMaxConnections(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInt(env, "DOCMIND_MAX_CONNECTIONS", DEFAULT_MAX_CONNECTIONS, 65_535);
}

const MAX_TIMEOUT_MS = 3_600_000;

/**
 * `DOCMIND_KEEP_ALIVE_TIMEOUT_MS` (default 5000) and `DOCMIND_HEADERS_TIMEOUT_MS` (default 20000). Behind a
 * load balancer the keep-alive timeout must be above the balancer's idle timeout (an ALB's is 60 s, so
 * 65000): otherwise Node closes a socket the balancer is about to reuse, and the client sees a 502.
 * The headers timeout must stay above the keep-alive timeout, as Node's own guidance says, so a reused
 * idle socket is not cut by the headers timer while its next request's headers arrive.
 * A bad value, or a headers timeout not above the keep-alive one, fails the boot.
 */
export function loadHttpTimeouts(env: NodeJS.ProcessEnv = process.env): {
  keepAliveTimeoutMs: number;
  headersTimeoutMs: number;
} {
  const keepAliveTimeoutMs = positiveInt(
    env,
    "DOCMIND_KEEP_ALIVE_TIMEOUT_MS",
    DEFAULT_HTTP_LIMITS.keepAliveTimeoutMs,
    MAX_TIMEOUT_MS,
  );
  const headersTimeoutMs = positiveInt(
    env,
    "DOCMIND_HEADERS_TIMEOUT_MS",
    DEFAULT_HTTP_LIMITS.headersTimeoutMs,
    MAX_TIMEOUT_MS,
  );
  if (headersTimeoutMs <= keepAliveTimeoutMs)
    throw new StartupConfigError(
      "DOCMIND_HEADERS_TIMEOUT_MS must be greater than DOCMIND_KEEP_ALIVE_TIMEOUT_MS",
    );
  return { keepAliveTimeoutMs, headersTimeoutMs };
}

/** The HTTP edge. Routes are keyed "METHOD /path"; unknown routes are a JSON 404. */
export function createHttpServer(
  extraRoutes: Record<string, Handler> = {},
  guard: OriginGuardOptions = { secure: false },
  limitOverrides: Partial<HttpLimits> = {},
  /** Answers GET and HEAD requests that match no route and are not under /api/ (the built web app). */
  fallback?: Handler,
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
    const matched = exact
      ? { handler: exact, ctx: { params: {} } satisfies RouteContext, route: path }
      : match(patterns, method, path);
    const isPage = (method === "GET" || method === "HEAD") && !path.startsWith("/api/");
    const found =
      matched ??
      (fallback && isPage
        ? { handler: fallback, ctx: { params: {} } satisfies RouteContext, route: "(web)" }
        : undefined);
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
      // Class name, method and the matched route pattern only: the message could carry a secret, and the raw
      // path can (`/api/erasure/:receipt` carries the receipt token). The client gets the fixed body below,
      // never the error.
      console.error(
        "handler failed",
        method,
        found.route,
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
    if (res.writableEnded) return; // ended, not yet flushed: let it go out
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
