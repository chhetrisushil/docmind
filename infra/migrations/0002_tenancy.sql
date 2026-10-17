-- Tenancy core. Every table carries tenant_id; row-level security keeps each request to its own
-- tenant. The server sets `app.tenant_id` per transaction (apps/server/app/db/tenant.ts).

-- The tenant of the current transaction. NULL when unset or empty (an ended SET LOCAL leaves ''),
-- so a query with no tenant context matches no rows instead of failing or leaking.
CREATE FUNCTION app_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE TABLE tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_sessions (
  token_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);

-- Not FORCEd: the owner (migrations, the SECURITY DEFINER lookups login will need) bypasses RLS,
-- while docmind_app owns nothing and is bound by it.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenants USING (id = app_tenant_id());
CREATE POLICY tenant_isolation ON users USING (tenant_id = app_tenant_id());
CREATE POLICY tenant_isolation ON auth_sessions USING (tenant_id = app_tenant_id());
