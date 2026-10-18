import type { AuthStore, Identity, LoginRecord, NewAccount, NewSession } from "@docmind/auth";
import type { Pool } from "pg";
import { withTenant } from "../db/tenant";

/**
 * AuthStore on Postgres, connected as the docmind_app role. The steps that happen before a tenant
 * is known go through the SECURITY DEFINER functions in migration 0005; everything else runs in
 * `withTenant`, so row-level security applies to it.
 */
export class PgAuthStore implements AuthStore {
  constructor(private readonly pool: Pool) {}

  async findLogin(email: string): Promise<LoginRecord | null> {
    const { rows } = await this.pool.query(
      "SELECT user_id, tenant_id, password_hash FROM public.auth_find_login($1)",
      [email],
    );
    const row = rows[0];
    return row
      ? { userId: row.user_id, tenantId: row.tenant_id, passwordHash: row.password_hash }
      : null;
  }

  async createAccount(a: NewAccount): Promise<boolean> {
    const { rows } = await this.pool.query("SELECT public.auth_sign_up($1, $2, $3, $4) AS ok", [
      a.tenantId,
      a.userId,
      a.email,
      a.passwordHash,
    ]);
    return rows[0].ok;
  }

  async createSession(s: NewSession): Promise<void> {
    await withTenant(this.pool, s.tenantId, (tx) =>
      tx.query(
        "INSERT INTO auth_sessions (token_hash, tenant_id, user_id, expires_at) VALUES ($1, $2, $3, $4)",
        [s.tokenHash, s.tenantId, s.userId, s.expiresAt],
      ),
    );
  }

  async findSession(tokenHash: string): Promise<Identity | null> {
    const { rows } = await this.pool.query(
      "SELECT user_id, tenant_id FROM public.auth_find_session($1)",
      [tokenHash],
    );
    return rows[0] ? { userId: rows[0].user_id, tenantId: rows[0].tenant_id } : null;
  }

  async findEmail(identity: Identity): Promise<string | null> {
    const { rows } = await withTenant(this.pool, identity.tenantId, (tx) =>
      tx.query("SELECT email FROM users WHERE id = $1", [identity.userId]),
    );
    return rows[0]?.email ?? null;
  }

  async deleteSession(identity: Identity, tokenHash: string): Promise<void> {
    await withTenant(this.pool, identity.tenantId, (tx) =>
      tx.query("DELETE FROM auth_sessions WHERE token_hash = $1 AND user_id = $2", [
        tokenHash,
        identity.userId,
      ]),
    );
  }

  /** Deletes every tenant's expired sessions; returns how many. */
  async purgeExpiredSessions(): Promise<number> {
    const { rows } = await this.pool.query("SELECT public.auth_purge_expired_sessions() AS n");
    return Number(rows[0].n);
  }
}
