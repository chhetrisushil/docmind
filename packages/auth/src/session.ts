import { createHash, randomBytes } from "node:crypto";

/** A session lasts 30 days from login; logout ends it sooner. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** What the browser holds (the cookie value) and what the database keeps (its hash). */
export interface SessionToken {
  token: string;
  tokenHash: string;
}

/** The database stores only this, so a leaked table cannot be replayed as cookies. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 256 random bits, so a plain SHA-256 is enough; a slow hash would only slow every request. */
export function newSessionToken(): SessionToken {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}
