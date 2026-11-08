-- 0031: when each recurring maintenance job last COMPLETED, so a job that runs "every N hours" survives restarts (the lineage
-- content collector, storage/lineageGc.ts: a service redeployed daily would otherwise never reach its first interval).
-- Deliberately NOT tenant-scoped: a job name and a timestamp, no tenant or user data, so it has no row-level security
-- and is an explicit exemption in db/tenancy.test.ts. The app role gets its grants from the default privileges set in
-- 0001_app_role.sql. Times are written and compared with the database's clock (now()), never a replica's.
CREATE TABLE maintenance_runs (
  name text PRIMARY KEY CHECK (length(name) BETWEEN 1 AND 64),
  last_run_at timestamptz NOT NULL
);
