import { randomUUID } from "node:crypto";
import type { Identity } from "./authenticator";
import { hashPassword, verifyAgainstDecoy, verifyPassword } from "./password";
import { SESSION_TTL_MS, hashToken, newSessionToken } from "./session";
import type { AuthStore } from "./store";

/** A started session: who it is for, and the cookie token to hand the browser. */
export interface StartedSession {
  identity: Identity;
  token: string;
}

/** Sign-up, login and logout over an AuthStore. Emails arrive normalised by the contracts. */
export class AuthService {
  constructor(private readonly store: AuthStore) {}

  /**
   * Creates a personal tenant and its user; false when the email is taken. It starts no session,
   * and the HTTP layer must answer the same either way, or sign-up tells anyone which emails are
   * registered. The password is hashed before the store is asked, so both outcomes cost the same.
   */
  async signUp(email: string, password: string): Promise<boolean> {
    const passwordHash = await hashPassword(password);
    const identity = { tenantId: randomUUID(), userId: randomUUID() };
    return this.store.createAccount({ ...identity, email, passwordHash });
  }

  /** Null for an unknown email and for a wrong password alike, after the same amount of work. */
  async logIn(email: string, password: string): Promise<StartedSession | null> {
    const login = await this.store.findLogin(email);
    if (!login) {
      await verifyAgainstDecoy(password);
      return null;
    }
    if (!(await verifyPassword(login.passwordHash, password))) return null;
    return this.start({ tenantId: login.tenantId, userId: login.userId });
  }

  /** Ends the session the caller authenticated with. */
  async logOut(identity: Identity, token: string): Promise<void> {
    await this.store.deleteSession(identity, hashToken(token));
  }

  private async start(identity: Identity): Promise<StartedSession> {
    const { token, tokenHash } = newSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.store.createSession({ ...identity, tokenHash, expiresAt });
    return { identity, token };
  }
}
