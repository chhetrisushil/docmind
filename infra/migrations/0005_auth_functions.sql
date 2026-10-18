-- Auth steps that happen before a tenant is known (sign-up, login by email, session by token hash)
-- or that span tenants (the expired-session sweep). docmind_app is bound by row-level security and
-- cannot create tenants, so each step is a narrow SECURITY DEFINER function owned by the migration
-- role, which bypasses RLS. Every one pins search_path (a definer function must not resolve names
-- through the caller's path) and schema-qualifies what it touches.

-- Creates a personal tenant and its first user together. False when the email is already taken.
CREATE FUNCTION auth_sign_up(p_tenant_id uuid, p_user_id uuid, p_email text, p_password_hash text)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  INSERT INTO public.tenants (id, name) VALUES (p_tenant_id, 'Personal');
  INSERT INTO public.users (id, tenant_id, email, password_hash)
    VALUES (p_user_id, p_tenant_id, p_email, p_password_hash)
    ON CONFLICT (email) DO NOTHING;
  IF NOT FOUND THEN
    DELETE FROM public.tenants WHERE id = p_tenant_id;
    RETURN false;
  END IF;
  RETURN true;
END
$$;

-- Login: the one row a given email maps to.
CREATE FUNCTION auth_find_login(p_email text)
  RETURNS TABLE (user_id uuid, tenant_id uuid, password_hash text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT u.id, u.tenant_id, u.password_hash FROM public.users u WHERE u.email = p_email $$;

-- Authentication: the owner of a live session, found by the hash of its cookie token.
CREATE FUNCTION auth_find_session(p_token_hash text)
  RETURNS TABLE (user_id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT s.user_id, s.tenant_id FROM public.auth_sessions s
         WHERE s.token_hash = p_token_hash AND s.expires_at > now() $$;

-- Deletes every expired session of every tenant; returns how many.
CREATE FUNCTION auth_purge_expired_sessions()
  RETURNS bigint
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ WITH gone AS (DELETE FROM public.auth_sessions WHERE expires_at <= now() RETURNING 1)
        SELECT count(*) FROM gone $$;

-- 0001 revokes PUBLIC execute on new functions; grant it to the app role explicitly, and revoke
-- PUBLIC again so this file does not depend on that default.
REVOKE ALL ON FUNCTION auth_sign_up(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_find_login(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_find_session(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth_purge_expired_sessions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_sign_up(uuid, uuid, text, text) TO docmind_app;
GRANT EXECUTE ON FUNCTION auth_find_login(text) TO docmind_app;
GRANT EXECUTE ON FUNCTION auth_find_session(text) TO docmind_app;
GRANT EXECUTE ON FUNCTION auth_purge_expired_sessions() TO docmind_app;
