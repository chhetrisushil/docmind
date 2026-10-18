import { type Server, createServer } from "node:http";
import { type Handler, json, sendError } from "./http/respond";

const baseRoutes: Record<string, Handler> = {
  "GET /healthz": (_req, res) => json(res, 200, { status: "ok" }),
};

/** The HTTP edge. Routes are keyed "METHOD /path"; unknown routes are a JSON 404. */
export function createHttpServer(extraRoutes: Record<string, Handler> = {}): Server {
  const routes = { ...baseRoutes, ...extraRoutes };
  return createServer((req, res) => {
    let path: string;
    try {
      path = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      return sendError(res, 400, "bad_request", "invalid request target");
    }
    const handler = Object.hasOwn(routes, `${req.method ?? "GET"} ${path}`)
      ? routes[`${req.method ?? "GET"} ${path}`]
      : undefined;
    if (!handler) return sendError(res, 404, "not_found", "no such route");
    // The async wrapper turns a synchronous throw and a rejected promise into the same failure.
    (async () => handler(req, res))().catch(() => {
      if (res.headersSent) res.end();
      else sendError(res, 500, "internal", "internal error");
    });
  });
}
