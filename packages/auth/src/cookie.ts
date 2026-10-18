import type { IncomingHttpHeaders } from "node:http";

export const SESSION_COOKIE = "dm_session";

/**
 * The value of the session cookie, or undefined. A cookie can only be sent by its own site's origin.
 * The first `dm_session` wins; malformed parts are skipped; an empty value counts as absent.
 */
export function readSessionCookie(headers: IncomingHttpHeaders): string | undefined {
  for (const part of (headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === SESSION_COOKIE) {
      return part.slice(eq + 1).trim() || undefined;
    }
  }
  return undefined;
}

/**
 * The Set-Cookie value that starts a session. HttpOnly keeps scripts away from it, SameSite=Lax
 * keeps other sites from sending it on a form post, `secure` is for HTTPS deployments.
 */
export function sessionCookie(token: string, maxAgeMs: number, secure: boolean): string {
  const attrs = ["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${Math.floor(maxAgeMs / 1000)}`];
  return [`${SESSION_COOKIE}=${token}`, ...attrs, ...(secure ? ["Secure"] : [])].join("; ");
}

/** The Set-Cookie value that removes the session cookie from the browser. */
export function clearedSessionCookie(secure: boolean): string {
  return sessionCookie("", 0, secure);
}
