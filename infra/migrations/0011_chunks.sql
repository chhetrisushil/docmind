-- Chunks of a parsed document (spec 4.2). text_enc holds {text, headingPath} sealed under the owner's
-- data key; heading text is content, so the plaintext locator carries only numbers (kind + offsets).
-- section_ordinal is the chunker's section index (an integer; linked retrieval's `structure` links).
-- The embedding column is added by 0014, only where the pgvector extension exists.
CREATE TABLE chunks (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  section_ordinal integer NOT NULL CHECK (section_ordinal >= 0),
  text_enc jsonb NOT NULL,
  locator jsonb NOT NULL,
  token_count integer NOT NULL CHECK (token_count > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chunks_document_fkey FOREIGN KEY (tenant_id, document_id)
    REFERENCES documents (tenant_id, id) ON DELETE CASCADE,
  -- chunk_links (part 2) references chunks with a composite key too.
  CONSTRAINT chunks_tenant_id_id_key UNIQUE (tenant_id, id),
  -- Also the (tenant_id, document_id) B-tree of spec 4.2: its leading columns.
  CONSTRAINT chunks_document_ordinal_key UNIQUE (tenant_id, document_id, ordinal)
);
ALTER TABLE chunks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chunks USING (tenant_id = app_tenant_id());

-- The parser's output on its way from the parse step to the chunk step. Sealed, and removed by the
-- chunk step once the chunks exist; cascade-deleted with the document either way.
CREATE TABLE parsed_documents (
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  body_enc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, document_id),
  CONSTRAINT parsed_documents_document_fkey FOREIGN KEY (tenant_id, document_id)
    REFERENCES documents (tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE parsed_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON parsed_documents USING (tenant_id = app_tenant_id());
