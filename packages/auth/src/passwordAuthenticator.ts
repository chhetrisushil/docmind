import type { AuthRequest, Authenticator, Identity } from "./authenticator";
import { readSessionCookie } from "./cookie";
import { hashToken } from "./session";
import type { AuthStore } from "./store";

/** What `newSessionToken` produces; anything else cannot be a real cookie, so skip the lookup. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** The v1 Authenticator: the session cookie set at login, checked against the stored hash. */
export class PasswordAuthenticator implements Authenticator {
  constructor(private readonly store: AuthStore) {}

  async authenticate(req: AuthRequest): Promise<Identity | null> {
    const token = readSessionCookie(req.headers);
    if (!token || !TOKEN_SHAPE.test(token)) return null;
    return this.store.findSession(hashToken(token));
  }
}
