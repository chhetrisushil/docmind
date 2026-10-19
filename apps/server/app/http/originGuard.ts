import type { IncomingMessage } from "node:http";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface OriginGuardOptions {
  /**
   * Whether the public side is HTTPS. This is the same switch as the Secure cookie flag
   * (`DOCMIND_COOKIE_SECURE`), so behind a TLS-terminating proxy the server's own origin is built
   * as https without believing any `X-Forwarded-*` header a client could forge.
   */
  secure: boolean;
}

/**
 * True when a request may proceed. Reads, and requests from clients that cannot be a browser acting
 * with an ambient cookie, pass; a state-changing request that a browser marks (or whose Origin
 * shows) as coming from another origin, same-site included, does not.
 */
export function isSameOriginRequest(req: IncomingMessage, opts: OriginGuardOptions): boolean {
  if (SAFE_METHODS.has(req.method ?? "GET")) return true;
  const site = req.headers["sec-fetch-site"];
  if (site !== undefined) return site === "same-origin" || site === "none";
  const origin = req.headers.origin;
  if (origin === undefined) return true; // curl, server-to-server: no ambient cross-origin cookies
  const host = req.headers.host;
  if (typeof origin !== "string" || typeof host !== "string" || host === "") return false;
  return origin === `${opts.secure ? "https" : "http"}://${host}`;
}
