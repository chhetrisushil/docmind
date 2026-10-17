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
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const handler = routes[`${req.method ?? "GET"} ${path}`];
    if (handler) handler(req, res);
    else json(res, 404, { error: { code: "not_found", message: "no such route" } });
  });
}
