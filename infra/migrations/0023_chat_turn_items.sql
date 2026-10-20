-- What the conversation record cannot carry (M4 D5): tool steps, retrieved passages and outcomes of each turn,
-- keyed by the chat and the turn key (`ord` holds the turn key: the <o> of the step ids conv#o<o>#turn:<i>, not
-- MessageRecord.ord). Append-only and sealed (bind chatitem:<id>). `id` is derived from the natural key
-- (chatItemId in apps/server), so a retried attempt rewrites its own row under the same bind; `seq` keeps the
-- order rows were first written in. The model's reasoning is NOT here: Loom captures it (ADR 0133) into
-- chat_reasoning_texts below.
CREATE TABLE chat_turn_items (
  id uuid PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  chat_id uuid NOT NULL,
  ord integer NOT NULL CHECK (ord >= 0),
  kind text NOT NULL CONSTRAINT chat_turn_items_kind_check CHECK (kind IN ('tool', 'passages', 'outcome')),
  step_key text NOT NULL CONSTRAINT chat_turn_items_step_key_check CHECK (char_length(step_key) BETWEEN 1 AND 200),
  body_enc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_turn_items_chat_fkey FOREIGN KEY (tenant_id, user_id, chat_id)
    REFERENCES chat_sessions (tenant_id, user_id, id) ON DELETE CASCADE,
  CONSTRAINT chat_turn_items_natural_key UNIQUE (tenant_id, user_id, chat_id, ord, kind, step_key)
);
ALTER TABLE chat_turn_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chat_turn_items USING (tenant_id = app_tenant_id());

-- The model's reasoning text (M4 amendment, Loom ADR 0133): one row per captured text, sealed under the
-- owner's data key (bind chatreasoning:<chat>:<address>). Loom's ReasoningStore has no tenancy of its own; this
-- one is owner-scoped. `address` is random (32 hex digits), never a hash of the text. Rows cascade with the chat,
-- and so with the user; destroying the owner's key makes them unreadable (Loom reports the part `erased`).
CREATE TABLE chat_reasoning_texts (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  chat_id uuid NOT NULL,
  address text NOT NULL CONSTRAINT chat_reasoning_texts_address_check CHECK (address ~ '^[0-9a-f]{32}$'),
  text_enc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, chat_id, address),
  CONSTRAINT chat_reasoning_texts_chat_fkey FOREIGN KEY (tenant_id, user_id, chat_id)
    REFERENCES chat_sessions (tenant_id, user_id, id) ON DELETE CASCADE
);
ALTER TABLE chat_reasoning_texts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chat_reasoning_texts USING (tenant_id = app_tenant_id());
