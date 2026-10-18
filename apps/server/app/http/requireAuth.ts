import type { IncomingMessage, ServerResponse } from "node:http";
import type { Authenticator, Identity } from "@docmind/auth";
import { type Handler, sendError } from "./respond";

export type AuthedHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  identity: Identity,
) => void | Promise<void>;

/**
 * Wraps a route so it runs only for an authenticated caller and receives the Identity. A route
 * must take the tenant and user from here, never from the request body or URL. If the
 * authenticator itself fails, the rejection reaches the router, which answers 500: a failed
 * check is never treated as a pass.
 */
export function requireAuth(authenticator: Authenticator, handler: AuthedHandler): Handler {
  return async (req, res) => {
    const identity = await authenticator.authenticate(req);
    if (!identity) return sendError(res, 401, "unauthorized", "authentication required");
    await handler(req, res, identity);
  };
}
