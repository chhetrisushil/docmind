-- Durable status of a document's ingest, folded from the flow's events by Loom's read-model
-- plugin (ADR 0132). The two tables are Loom's folded-state layout, created here (D10) so the
-- migrator owns them: docmind_loom must never own a table with row-level security (the server
-- refuses to start if it does), and the policy below reads users, which lives in this schema.
CREATE TABLE IF NOT EXISTS "public"."read_model_folds" (
  model_id TEXT PRIMARY KEY,
  version TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS "public"."read_model_state" (
  model_id TEXT NOT NULL,
  execution_id TEXT COLLATE "C" NOT NULL,
  app_key TEXT,
  scope TEXT,
  sequence BIGINT NOT NULL,
  state JSONB,
  erased BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (model_id, execution_id)
);
CREATE INDEX IF NOT EXISTS "read_model_state_key_idx" ON "public"."read_model_state" (model_id, app_key) WHERE app_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS "read_model_state_scope_idx" ON "public"."read_model_state" (model_id, scope) WHERE scope IS NOT NULL;

-- scope is a user id (the model's scopeOf) or NULL; the policy casts it, so nothing else may be stored.
ALTER TABLE "public"."read_model_state" ADD CONSTRAINT read_model_state_scope_uuid
  CHECK (scope IS NULL OR scope ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

-- 0001's default privileges give docmind_app every right on new tables; take them back.
REVOKE ALL ON "public"."read_model_state", "public"."read_model_folds" FROM PUBLIC, docmind_app;
GRANT USAGE ON SCHEMA public TO docmind_loom;
GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."read_model_state", "public"."read_model_folds" TO docmind_loom;
GRANT SELECT ON "public"."read_model_state" TO docmind_app;

ALTER TABLE "public"."read_model_state" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."read_model_folds" ENABLE ROW LEVEL SECURITY;

-- The Loom role (the service's writer: live feed, catch-up, refresh, purge) writes every tenant's
-- rows. FOR ALL, because INSERT ... ON CONFLICT needs to see the row it conflicts with.
CREATE POLICY ingest_all ON "public"."read_model_state" FOR ALL TO docmind_loom USING (true) WITH CHECK (true);
CREATE POLICY ingest_all ON "public"."read_model_folds" FOR ALL TO docmind_loom USING (true) WITH CHECK (true);

-- The app role reads the rows of the users of its transaction's tenant (app_tenant_id() is NULL
-- without a tenant, which matches nothing).
CREATE POLICY tenant_read ON "public"."read_model_state" FOR SELECT TO docmind_app
  USING (scope IS NOT NULL AND EXISTS (
    SELECT 1 FROM "public"."users" u WHERE u.id = scope::uuid AND u.tenant_id = app_tenant_id()));
