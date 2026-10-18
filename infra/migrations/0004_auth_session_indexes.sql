-- Lookups the auth flows make: a user's sessions within their tenant (revoke all, account erasure),
-- and the sweep that deletes expired sessions.
CREATE INDEX auth_sessions_tenant_user_idx ON auth_sessions (tenant_id, user_id);
CREATE INDEX auth_sessions_expires_at_idx ON auth_sessions (expires_at);
