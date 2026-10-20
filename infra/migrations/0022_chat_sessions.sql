-- Chat sessions (M4 D13). One row per chat; the API speaks this uuid (D1). The title is content, so it
-- is sealed under the owner's data key (bind chat:<id>:title); the message count and last activity are
-- NOT here: they are the folded read model `chat-activity` (read_model_state), joined by the list.
-- Deleting a chat sets deleted_at; the row stays until erasure (D15) and cascades with the user.
CREATE TABLE chat_sessions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  title_enc jsonb,
  title_source text NOT NULL DEFAULT 'none' CHECK (title_source IN ('none', 'auto', 'user')),
  scope jsonb NOT NULL DEFAULT '"all"'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT chat_sessions_owner_fkey FOREIGN KEY (tenant_id, user_id)
    REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT chat_sessions_tenant_id_id_key UNIQUE (tenant_id, id),
  -- Child tables (chat_turn_items, chat_reasoning_blocks) reference this key, so a row can only
  -- belong to the chat's own owner.
  CONSTRAINT chat_sessions_owner_id_key UNIQUE (tenant_id, user_id, id),
  CONSTRAINT chat_sessions_title_pair CHECK ((title_enc IS NULL) = (title_source = 'none')),
  -- "all", or {"documentIds": [1..100 ids]} (contracts ChatScope; the ids are validated by the API).
  CONSTRAINT chat_sessions_scope_shape CHECK (
    scope = '"all"'::jsonb
    OR (jsonb_typeof(scope) = 'object'
        AND CASE WHEN jsonb_typeof(scope -> 'documentIds') = 'array'
                 THEN jsonb_array_length(scope -> 'documentIds') BETWEEN 1 AND 100
                 ELSE false END))
);
CREATE INDEX chat_sessions_owner_created_idx ON chat_sessions (tenant_id, user_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chat_sessions USING (tenant_id = app_tenant_id());
