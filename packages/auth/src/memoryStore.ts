import type { Identity } from "./authenticator";
import type { AuthStore, LoginRecord, NewAccount, NewSession } from "./store";

/** An AuthStore in memory, for tests of everything built on the interface. */
export class MemoryAuthStore implements AuthStore {
  private readonly accounts = new Map<string, LoginRecord & { email: string }>();
  private readonly sessions = new Map<string, NewSession>();

  /** Tests move this to make sessions expire without waiting. */
  now: () => Date = () => new Date();

  async findLogin(email: string): Promise<LoginRecord | null> {
    const a = this.accounts.get(email);
    if (!a) return null;
    return { tenantId: a.tenantId, userId: a.userId, passwordHash: a.passwordHash };
  }

  async createAccount(a: NewAccount): Promise<boolean> {
    if (this.accounts.has(a.email)) return false;
    this.accounts.set(a.email, a);
    return true;
  }

  async createSession(s: NewSession): Promise<void> {
    this.sessions.set(s.tokenHash, s);
  }

  async findSession(tokenHash: string): Promise<Identity | null> {
    const s = this.sessions.get(tokenHash);
    if (!s || s.expiresAt <= this.now()) return null;
    return { tenantId: s.tenantId, userId: s.userId };
  }

  async findEmail(identity: Identity): Promise<string | null> {
    for (const a of this.accounts.values()) {
      if (a.userId === identity.userId && a.tenantId === identity.tenantId) return a.email;
    }
    return null;
  }

  async deleteSession(identity: Identity, tokenHash: string): Promise<void> {
    if (this.sessions.get(tokenHash)?.tenantId === identity.tenantId) {
      this.sessions.delete(tokenHash);
    }
  }
}
