-- 0036: document tags (spec docs/specs/2026-11-10-document-tags-design.md section 3). Additive: no existing row changes.
-- Names are sealed under the owner's data key (bind tag:<id>:name); `name_bind` is an HMAC of the normalised name under a key
-- derived from the same data key (the entities.name_key pattern), so uniqueness never compares plaintext and cannot be tested
-- against guesses once the key is destroyed. Every table carries the tenant-isolation policy of `documents`; the owner is
-- named in every query. Rows cascade with the document, the tag and the user, so erasure (DELETE FROM users) removes them.

-- A key the composite foreign keys below can point at: it makes "this document's owner is this tag's owner" a database fact.
ALTER TABLE documents ADD CONSTRAINT documents_tenant_owner_id_key UNIQUE (tenant_id, owner_id, id);

CREATE TABLE tags (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  name_enc jsonb NOT NULL,
  name_bind bytea NOT NULL CHECK (octet_length(name_bind) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tags_owner_fkey FOREIGN KEY (tenant_id, owner_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT tags_owner_name_key UNIQUE (owner_id, name_bind),
  CONSTRAINT tags_tenant_owner_id_key UNIQUE (tenant_id, owner_id, id)
);
ALTER TABLE tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tags USING (tenant_id = app_tenant_id());

CREATE TABLE document_tags (
  document_id uuid NOT NULL,
  tag_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, tag_id),
  CONSTRAINT document_tags_document_fkey FOREIGN KEY (tenant_id, owner_id, document_id)
    REFERENCES documents (tenant_id, owner_id, id) ON DELETE CASCADE,
  CONSTRAINT document_tags_tag_fkey FOREIGN KEY (tenant_id, owner_id, tag_id)
    REFERENCES tags (tenant_id, owner_id, id) ON DELETE CASCADE
);
-- The listing filter starts here: a tag's documents of one owner, in document order.
CREATE INDEX document_tags_owner_tag_idx ON document_tags (owner_id, tag_id, document_id);
ALTER TABLE document_tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON document_tags USING (tenant_id = app_tenant_id());

CREATE TABLE document_tag_suggestions (
  document_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  names_enc jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_tag_suggestions_document_fkey FOREIGN KEY (tenant_id, owner_id, document_id)
    REFERENCES documents (tenant_id, owner_id, id) ON DELETE CASCADE
);
ALTER TABLE document_tag_suggestions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON document_tag_suggestions USING (tenant_id = app_tenant_id());
