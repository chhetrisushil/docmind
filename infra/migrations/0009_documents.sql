-- Uploaded documents (spec 4.2). Titles, filenames, stats and summaries are sealed with the owner's
-- data key (the *_enc columns hold Loom's envelope as jsonb); everything else is metadata. The
-- original bytes live in the blob store, addressed by content_address.
CREATE TABLE documents (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  owner_id uuid NOT NULL,
  title_enc jsonb NOT NULL,
  filename_enc jsonb NOT NULL,
  mime text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  -- Keyed fingerprint of the plaintext (HMAC-SHA256 under a key derived from the owner's data key),
  -- as the ContentStore ref ("hmac-sha256:<hex>") and as bare hex. Not a plain hash: knowing a
  -- file's sha256 does not let anyone test whether it was uploaded.
  content_address text NOT NULL CHECK (content_address ~ '^hmac-sha256:[0-9a-f]{64}$'),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'uploaded'
    CHECK (status IN ('uploaded', 'parsing', 'embedding', 'ready', 'failed')),
  -- Plain text: only ever a fixed message, never a filename or document text.
  error text,
  stats_enc jsonb, -- outline, dates, numbers derive from content: sealed like the other *_enc columns
  summary_enc jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- The owner must be a user of the same tenant; deleting the user (erasure) removes the rows.
  CONSTRAINT documents_owner_fkey FOREIGN KEY (tenant_id, owner_id)
    REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  -- Re-uploading identical bytes returns the existing document (spec 4.2).
  CONSTRAINT documents_owner_fingerprint_key UNIQUE (tenant_id, owner_id, fingerprint)
);

CREATE INDEX documents_owner_created_idx ON documents (tenant_id, owner_id, created_at DESC, id DESC);

ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON documents USING (tenant_id = app_tenant_id());
