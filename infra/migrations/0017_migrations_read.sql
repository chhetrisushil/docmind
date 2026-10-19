-- The server checks at start that no applied migration file was edited (apps/server/app/db/migrate.ts,
-- verifyMigrationChecksums). It connects as docmind_app, which needs to read the runner's own table.
-- Read-only: file names and SHA-256 digests, no data.
GRANT SELECT ON public.schema_migrations TO docmind_app;
