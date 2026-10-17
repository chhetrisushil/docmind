import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const routes: Record<string, Handler> = {
  "GET /healthz": (_req, res) => json(res, 200, { status: "ok" }),
};

/** The HTTP edge. Later PRs add routes to the table; unknown routes are a JSON 404. */
export function createHttpServer(): Server {
  return createServer((req, res) => {
    let path: string;
    try {
      path = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      return json(res, 400, { error: { code: "bad_request", message: "invalid request target" } });
    }
    const handler = routes[`${req.method ?? "GET"} ${path}`];
    if (!handler) return json(res, 404, { error: { code: "not_found", message: "no such route" } });
    try {
      handler(req, res);
    } catch {
      if (res.headersSent) res.end();
      else json(res, 500, { error: { code: "internal", message: "internal error" } });
    }
  });
}
