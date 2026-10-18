import type { Identity } from "./authenticator";

export interface LoginRecord extends Identity {
  passwordHash: string;
}

export interface NewAccount extends Identity {
  email: string;
  passwordHash: string;
}

export interface NewSession extends Identity {
  tokenHash: string;
  expiresAt: Date;
}

/**
 * Where accounts and sessions live. The password/session code depends on this interface so it can
 * be tested without a database; the server implements it on Postgres (`SECURITY DEFINER`
 * functions for the steps that happen before a tenant is known, `withTenant` for the rest).
 */
export interface AuthStore {
  /** The account an email belongs to, if any. Emails arrive already lower-cased. */
  findLogin(email: string): Promise<LoginRecord | null>;
  /** Creates the personal tenant and its first user together. False when the email is taken. */
  createAccount(account: NewAccount): Promise<boolean>;
  createSession(session: NewSession): Promise<void>;
  /** The owner of a session that has not expired, found by token hash. */
  findSession(tokenHash: string): Promise<Identity | null>;
  /** The email of an account, for `GET /api/me`. Null when the account no longer exists. */
  findEmail(identity: Identity): Promise<string | null>;
  /** Ends one session. A no-op for a session that is already gone. */
  deleteSession(identity: Identity, tokenHash: string): Promise<void>;
}
