-- The role the server connects as. It owns nothing, cannot bypass row-level security, and starts
-- with no login: `pnpm db:migrate` gives it one when DOCMIND_APP_DB_PASSWORD is set.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'docmind_app') THEN
    CREATE ROLE docmind_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO docmind_app;

-- Tables the migrator creates from here on are readable and writable by the app role. Row-level
-- security (enabled per table in each migration) is what limits which rows.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO docmind_app;
