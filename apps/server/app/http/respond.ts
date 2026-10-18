import type { IncomingMessage, ServerResponse } from "node:http";
import type { ErrorBody } from "@docmind/contracts";

/** What the router knows about the matched route. */
export interface RouteContext {
  /** Path parameters from a route key such as `GET /api/documents/:id`, percent-decoded. */
  params: Readonly<Record<string, string>>;
}

export type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
) => void | Promise<void>;

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  json(res, status, { error: { code, message } } satisfies ErrorBody);
}
