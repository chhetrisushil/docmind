-- Links between passages (linked-retrieval note, M3b D12): M4's search hops along them. Stored in both
-- directions; each chunk keeps its MAX_DEGREE strongest outgoing links (apps/server, LinkStore). Link
-- existence and weight are plaintext metadata like chunks.embedding (spec 4.4 trade-off); every row
-- cascades with either chunk, so deleting a document or a user removes its links.
CREATE TABLE chunk_links (
  tenant_id uuid NOT NULL,
  src_chunk_id uuid NOT NULL,
  dst_chunk_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('structure', 'reference', 'entity', 'similar')),
  weight real NOT NULL CHECK (weight > 0 AND weight <= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, src_chunk_id, dst_chunk_id, kind),
  CONSTRAINT chunk_links_not_self CHECK (src_chunk_id <> dst_chunk_id),
  CONSTRAINT chunk_links_src_fkey FOREIGN KEY (tenant_id, src_chunk_id) REFERENCES chunks (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT chunk_links_dst_fkey FOREIGN KEY (tenant_id, dst_chunk_id) REFERENCES chunks (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX chunk_links_dst_idx ON chunk_links (tenant_id, dst_chunk_id);
ALTER TABLE chunk_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chunk_links USING (tenant_id = app_tenant_id());
