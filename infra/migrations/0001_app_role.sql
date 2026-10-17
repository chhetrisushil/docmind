-- The role the server connects as. It owns nothing, cannot bypass row-level security, and starts
-- with no login: `pnpm db:migrate` gives it one when DOCMIND_APP_DB_PASSWORD is set.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'docmind_app') THEN
    CREATE ROLE docmind_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles r WHERE rolname = 'docmind_app' AND (rolsuper OR rolbypassrls OR rolcreaterole
      OR rolcreatedb OR rolreplication OR EXISTS (SELECT FROM pg_auth_members m WHERE m.member = r.oid))) THEN
    RAISE EXCEPTION 'docmind_app must not be privileged or a member of any role (it would void row-level security)';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO docmind_app;

-- Tables the migrator creates from here on are readable and writable by the app role. Row-level
-- security (enabled per table in each migration) is what limits which rows.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO docmind_app;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC; -- global: IN SCHEMA cannot subtract
