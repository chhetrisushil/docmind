-- 0029: facts extracted from a chat turn's own retrieved chunks, the fallback of chat visuals (spec
-- docs/specs/2026-11-08-chat-visuals-design.md §6). `ord` is the assistant record's ordinal (the id the chat API shows).
-- Sealed under the owner's key (bind turnfact:<id>); a re-run replaces the turn's rows in one transaction.
CREATE TABLE turn_visual_facts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  chat_id uuid NOT NULL,
  ord bigint NOT NULL CHECK (ord >= 1), -- RecordOrd: the range of ChatMessageDto.id (15 digits)
  ordinal int NOT NULL CHECK (ordinal BETWEEN 0 AND 15),
  fact_enc jsonb NOT NULL,
  chunk_ids uuid[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT turn_visual_facts_chat_fkey FOREIGN KEY (tenant_id, user_id, chat_id)
    REFERENCES chat_sessions (tenant_id, user_id, id) ON DELETE CASCADE,
  CONSTRAINT turn_visual_facts_key UNIQUE (chat_id, ord, ordinal)
);
ALTER TABLE turn_visual_facts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON turn_visual_facts USING (tenant_id = app_tenant_id());

-- The tenant of a live chat, for the turn-settled hook: the conversation id carries the user and the chat but no
-- tenant. Ids only, a narrow SECURITY DEFINER function like 0028; a soft-deleted chat or an owner being erased gives
-- no row (the hook then does nothing).
CREATE FUNCTION public.docmind_chat_tenant(p_chat uuid)
RETURNS uuid
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.tenant_id
    FROM public.chat_sessions c
    JOIN public.users u ON u.id = c.user_id AND u.erasing_at IS NULL
   WHERE c.id = p_chat AND c.deleted_at IS NULL
$$;
REVOKE ALL ON FUNCTION public.docmind_chat_tenant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.docmind_chat_tenant(uuid) TO docmind_app;
