import type { IncomingMessage } from "node:http";
import { StartupConfigError } from "../startupError";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface OriginGuardOptions {
  /**
   * Whether the public side is HTTPS. This is the same switch as the Secure cookie flag
   * (`DOCMIND_COOKIE_SECURE`), so behind a TLS-terminating proxy the server's own origin is built
   * as https without believing any `X-Forwarded-*` header a client could forge.
   */
  secure: boolean;
  /**
   * The browser-visible origin (`DOCMIND_PUBLIC_ORIGIN`), for a proxy that rewrites `Host`. When set,
   * the `Origin` fallback compares against it instead of the `Host`-derived origin.
   */
  publicOrigin?: string;
  /** Where a refusal is reported with its matched route pattern, or "(unrouted)" (rate-limited by `refusalLogger`). */
  log?: (method: string, path: string) => void;
}

/** Validates `DOCMIND_PUBLIC_ORIGIN`: exactly `scheme://host[:port]`, no path, query, fragment or credentials. */
export function parsePublicOrigin(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  const bad = () => new StartupConfigError("DOCMIND_PUBLIC_ORIGIN must be scheme://host[:port]");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw bad();
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== raw) throw bad();
  return raw;
}

const WINDOW_MS = 60_000;
/**
 * Rate-limits the refusal line to one per window per method + route pattern; the next line after a
 * window reports how many were suppressed. The key set is bounded by the route table. `now` is
 * injectable so tests need no timers.
 */
export function refusalLogger(
  emit: (line: string) => void = (line) => console.error(line),
  now: () => number = () => performance.now(),
): (method: string, route: string) => void {
  const seen = new Map<string, { at: number; suppressed: number }>();
  return (method, route) => {
    const line = `${method} ${route}`;
    const t = now();
    const entry = seen.get(line);
    if (entry && t - entry.at < WINDOW_MS) {
      entry.suppressed += 1;
      return;
    }
    const more = entry?.suppressed ?? 0;
    seen.set(line, { at: t, suppressed: 0 });
    emit(
      `cross-origin request refused ${line}${more > 0 ? ` (and ${more} more since the last line)` : ""}`,
    );
  };
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
  if (typeof origin !== "string") return false;
  const host = req.headers.host;
  if (opts.publicOrigin === undefined && (typeof host !== "string" || host === "")) return false;
  return origin === (opts.publicOrigin ?? `${opts.secure ? "https" : "http"}://${host}`);
}
