-- 0039: the id format of a chat (R14 phase 2, docs/specs/2026-11-10-opaque-ids-design.md).
--
-- A chat's Loom ids (its conversation and every generation `~n`, its title execution, its turn visuals executions and its turn lineage
-- lines) are built by one of two formats: `legacy` (`u_<user>.c-<chat>`, the plain UUIDs every chat created before this migration used)
-- or `opaque` (`h_<H>.c-<C>`, keyed pseudonyms). The format cannot be derived from the chat's UUID, and one chat must never mix them, so it
-- is stored. Every row that exists now was created under the old format, which is exactly what the default says; the create route writes
-- `opaque` for a chat made after the deploy. A row inserted without the column (an old pod during a deploy, a test) is legacy, which is
-- what that code would have started. The column holds no id and nothing that links a chat to a handle.
--
-- A constant default is a metadata-only change (no table rewrite). The inline CHECK is validated against every existing row under the
-- table lock (migrations run in one transaction, so NOT VALID then VALIDATE would hold the lock all the same); `chat_sessions` is small. Rolling back after the first `opaque` chat exists is not supported
-- (older code cannot parse its ids; see docs/operations/cloud-deploy.md).
ALTER TABLE chat_sessions
  ADD COLUMN id_format text NOT NULL DEFAULT 'legacy'
    CONSTRAINT chat_sessions_id_format_check CHECK (id_format IN ('legacy', 'opaque'));
