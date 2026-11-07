-- 0027: artifact blobs of the visuals lineages (@loom-ui/lineage over loom's ContentStore SPI; Ruling R17).
--
-- Deliberately NOT tenant-scoped: loom's content API has no tenant (a blob is
-- addressed by its hash alone, and a put of identical bytes is one row), so there is no tenant for a policy to
-- compare, and a per-tenant row would break content addressing. Row-level security is enabled only to keep the
-- invariant that no public table is unprotected (db/tenancy.test.ts); its one policy admits every row to the app role. Confidentiality does not come from this table:
-- the only writer is PgContentStore under EncryptingContentStore, so `bytes` always holds ciphertext sealed under
-- the owning user's key, and erasing a user destroys that key (the row stays, but can no longer be opened).
-- Never read or write this table with plaintext.
--
-- `touched_ms` is the SPI 1.3.0 touch time (epoch ms, never moves backwards), which the orphan sweep uses.
-- The app role gets its grants from the default privileges set in 0001_app_role.sql.
CREATE TABLE lineage_content (
  address text COLLATE "C" PRIMARY KEY CHECK (address LIKE 'sha256:%'),
  bytes bytea NOT NULL,
  touched_ms bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE lineage_content ENABLE ROW LEVEL SECURITY;
CREATE POLICY not_tenant_scoped ON lineage_content USING (true) WITH CHECK (true);
