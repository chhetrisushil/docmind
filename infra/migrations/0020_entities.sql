-- Named entities per owner (M3b D13, linked-retrieval note). name_enc is sealed under the owner's data
-- key (bind entity:<id>:name); name_key is an HMAC of the normalized name under a key derived from the
-- same DEK, so the same entity matches across the owner's documents without storing the name in the
-- clear, and cannot be tested against guesses once the key is destroyed. Entities are per owner, never
-- shared across users of a tenant; they cascade with the user.
CREATE TABLE entities (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('person', 'organization', 'product', 'project', 'place', 'other')),
  name_enc jsonb NOT NULL,
  name_key text NOT NULL CHECK (name_key ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entities_owner_fkey FOREIGN KEY (tenant_id, owner_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT entities_owner_name_key UNIQUE (tenant_id, owner_id, name_key),
  CONSTRAINT entities_tenant_id_id_key UNIQUE (tenant_id, id)
);
ALTER TABLE entities ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON entities USING (tenant_id = app_tenant_id());

-- Which chunks mention which entity. Plaintext ids only; cascades with the chunk and with the entity.
CREATE TABLE chunk_entities (
  tenant_id uuid NOT NULL,
  chunk_id uuid NOT NULL,
  entity_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, chunk_id, entity_id),
  CONSTRAINT chunk_entities_chunk_fkey FOREIGN KEY (tenant_id, chunk_id) REFERENCES chunks (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT chunk_entities_entity_fkey FOREIGN KEY (tenant_id, entity_id) REFERENCES entities (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX chunk_entities_entity_idx ON chunk_entities (tenant_id, entity_id);
ALTER TABLE chunk_entities ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chunk_entities USING (tenant_id = app_tenant_id());
