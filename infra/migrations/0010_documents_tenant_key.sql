-- Child tables reference a document together with its tenant, so a foreign key can never pair a
-- document with the wrong tenant. `id` is already the primary key; this adds no new restriction on
-- the data, only a key the composite foreign keys of 0011 (and later chunk_links) can point at.
ALTER TABLE documents ADD CONSTRAINT documents_tenant_id_id_key UNIQUE (tenant_id, id);
