import type { IncomingMessage, ServerResponse } from "node:http";
import type { ErrorBody } from "@docmind/contracts";

export type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

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
