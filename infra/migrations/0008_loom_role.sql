-- Loom's Postgres stores (event log, snapshots, leases) create and migrate their own tables, so
-- they get their own role and their own schema. The role owns that schema and nothing else:
-- it has no privilege on DocMind's tables, and docmind_app has none on Loom's. Like docmind_app it
-- is not privileged and cannot bypass row-level security; it starts without a login and
-- `pnpm db:migrate` gives it one when DOCMIND_LOOM_DB_PASSWORD is set.
-- The default privileges in 0001 are the migrator's, so they do not reach objects docmind_loom creates.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'docmind_loom') THEN
    CREATE ROLE docmind_loom NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles r WHERE rolname = 'docmind_loom' AND (rolsuper OR rolbypassrls OR rolcreaterole
      OR rolcreatedb OR rolreplication OR EXISTS (SELECT FROM pg_auth_members m WHERE m.member = r.oid))) THEN
    RAISE EXCEPTION 'docmind_loom must not be privileged or a member of any role';
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS loom AUTHORIZATION docmind_loom;
REVOKE ALL ON SCHEMA loom FROM PUBLIC;
ALTER ROLE docmind_loom SET search_path = loom;
