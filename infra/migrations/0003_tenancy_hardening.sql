-- A session must belong to a user of its own tenant: the lone user_id FK ignored the tenant, so a
-- tenant could attach a session to another tenant's user.
ALTER TABLE users ADD CONSTRAINT users_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE auth_sessions DROP CONSTRAINT auth_sessions_user_id_fkey;
ALTER TABLE auth_sessions ADD CONSTRAINT auth_sessions_tenant_user_fkey
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE;

-- Tenants are created and removed by owner-run code (sign-up will use a SECURITY DEFINER function),
-- never by a tenant's own session: a DELETE here would cascade over all of its users.
REVOKE INSERT, DELETE ON tenants FROM docmind_app;
