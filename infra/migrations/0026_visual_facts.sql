-- 0026: facts extracted for a document's visuals (spec docs/specs/2026-11-08-document-visuals-design.md §5).
CREATE TABLE visual_facts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  document_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('series', 'figure', 'factTable')),
  ordinal int NOT NULL CHECK (ordinal BETWEEN 0 AND 15),
  fact_enc jsonb NOT NULL,
  chunk_ids uuid[] NOT NULL,
  schema_version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT visual_facts_owner_fkey FOREIGN KEY (tenant_id, owner_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT visual_facts_document_fkey FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT visual_facts_document_ordinal_key UNIQUE (tenant_id, document_id, ordinal)
);
ALTER TABLE visual_facts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON visual_facts USING (tenant_id = app_tenant_id());
