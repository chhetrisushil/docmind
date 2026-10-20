-- What the conversation record cannot carry (M4 D5): thinking summaries, tool steps, retrieved passages
-- and outcomes of each turn, keyed by the chat and the turn key (`ord` holds the turn key: the <o> of the step ids conv#o<o>#turn:<i>, not MessageRecord.ord). Append-only and sealed
-- (bind chatitem:<id>). `id` is derived from the natural key (chatItemId in apps/server), so a retried
-- attempt rewrites its own row under the same bind; `seq` keeps the order rows were first written in.
CREATE TABLE chat_turn_items (
  id uuid PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  chat_id uuid NOT NULL,
  ord integer NOT NULL CHECK (ord >= 0),
  kind text NOT NULL CONSTRAINT chat_turn_items_kind_check CHECK (kind IN ('thinking', 'tool', 'passages', 'outcome')),
  step_key text NOT NULL CONSTRAINT chat_turn_items_step_key_check CHECK (char_length(step_key) BETWEEN 1 AND 200),
  body_enc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_turn_items_chat_fkey FOREIGN KEY (tenant_id, user_id, chat_id)
    REFERENCES chat_sessions (tenant_id, user_id, id) ON DELETE CASCADE,
  CONSTRAINT chat_turn_items_natural_key UNIQUE (tenant_id, user_id, chat_id, ord, kind, step_key)
);
ALTER TABLE chat_turn_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chat_turn_items USING (tenant_id = app_tenant_id());

-- A response's full ordered content blocks (thinking / redacted_thinking, opaque and signed, with the text and
-- tool_use blocks around them), echoed verbatim on the next request of the same tool loop (D3, P1). One row
-- per tool_use id; sealed (bind chatblocks:<chat>:<toolUseId>).
CREATE TABLE chat_reasoning_blocks (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  chat_id uuid NOT NULL,
  tool_use_id text NOT NULL CONSTRAINT chat_reasoning_blocks_tool_use_id_check CHECK (char_length(tool_use_id) BETWEEN 1 AND 200),
  blocks_enc jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, chat_id, tool_use_id),
  CONSTRAINT chat_reasoning_blocks_chat_fkey FOREIGN KEY (tenant_id, user_id, chat_id)
    REFERENCES chat_sessions (tenant_id, user_id, id) ON DELETE CASCADE
);
ALTER TABLE chat_reasoning_blocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chat_reasoning_blocks USING (tenant_id = app_tenant_id());
