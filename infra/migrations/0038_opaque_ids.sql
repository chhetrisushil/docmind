-- 0038: opaque execution and lineage ids (R14, docs/specs/2026-11-10-opaque-ids-design.md, phase 1).
--
-- 1. `users.id_handle` (O3): the user's handle `H`, 26 characters of lower-case base32 (128 bits), created lazily on the user's first
--    new-format start and unique across tenants. NULL until then. It is deleted with the user's row.
-- 2. Two lookups for the key cache, both SECURITY DEFINER like 0015..0034 (the boot warm-up and a cache miss run outside any tenant):
--    the user of a handle, and one keyset page of the users that have a handle. Ids and handles only, at most 500 rows.
-- 3. `documents.ingest_execution_id` and `documents.visualize_execution_id`: the id of the CURRENT generation's ingest and visualize
--    (run 0) executions. The sweeps below and the connections reader used to BUILD those ids inside SQL from the user and document
--    UUIDs; a new-format id cannot be built in SQL (it needs the user's key), so the application stores the id it started and the SQL
--    only compares it. NULL means "no execution recorded for this generation": it never matches a status row. The application writes
--    both when it starts the execution (documents/executionIds.ts) and `bumpGeneration` clears both with the generation.
--    Backfill (`docmind_repair_execution_ids`): a document whose current generation already has an old-format status row keeps that
--    exact old id, so a run that started before the deploy stays found; any other document stays NULL and the next start records its
--    (new-format) id. It only ever fills a NULL column, so it can run again: the migration runs it once, unbounded, and the server runs it at
--    every boot (bounded to documents updated in the last 7 days: the `p_within` argument), so a document an OLD pod ingested during a rolling deploy (old pods never write the columns) is repaired before the
--    sweeps start. Rolling BACK after this migration is not supported (see docs/operations/cloud-deploy.md).
-- 4. The five SECURITY DEFINER functions that built ids (0024's `docmind_stale_uploads_v2`, 0028's `docmind_ready_documents`,
--    0030's `docmind_visual_retry_documents`, 0032's `docmind_visual_stale_format_documents`, 0034's
--    `docmind_visual_unrecorded_documents`) are replaced with the same signature, columns and grants (CREATE OR REPLACE keeps the
--    ACL), comparing the stored columns. Their other predicates are unchanged. Old migrations are never edited.
ALTER TABLE users ADD COLUMN id_handle text
  CONSTRAINT users_id_handle_shape CHECK (id_handle ~ '^[a-z2-7]{25}[aeimquy4]$')
  CONSTRAINT users_id_handle_key UNIQUE;

ALTER TABLE documents
  ADD COLUMN ingest_execution_id text CHECK (ingest_execution_id IS NULL OR length(ingest_execution_id) <= 1024),
  ADD COLUMN visualize_execution_id text CHECK (visualize_execution_id IS NULL OR length(visualize_execution_id) <= 1024);

CREATE FUNCTION public.docmind_repair_execution_ids(p_within interval DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  ingest_set integer;
  visualize_set integer;
BEGIN
  -- Serializes concurrent repairs (two pods booting together would otherwise lock the same rows in different orders and deadlock).
  -- The key is fixed: 7038001 = migration 0038, lock 1. The IS NULL guards make the second run a cheap no-op.
  PERFORM pg_catalog.pg_advisory_xact_lock(7038001);
  UPDATE public.documents d
     SET ingest_execution_id = 'u_' || d.owner_id::text || ':ingest-' || d.id::text
           || CASE WHEN d.ingest_generation = 1 THEN '' ELSE '.' || d.ingest_generation::text END
   WHERE d.ingest_execution_id IS NULL
     AND (p_within IS NULL OR d.updated_at > pg_catalog.now() - p_within)
     AND EXISTS (
       SELECT 1 FROM public.read_model_state s
        WHERE s.model_id = 'ingest-status'
          AND s.execution_id = 'u_' || d.owner_id::text || ':ingest-' || d.id::text
              || CASE WHEN d.ingest_generation = 1 THEN '' ELSE '.' || d.ingest_generation::text END);
  GET DIAGNOSTICS ingest_set = ROW_COUNT;
  UPDATE public.documents d
     SET visualize_execution_id = 'u_' || d.owner_id::text || ':visualize-' || d.id::text
           || CASE WHEN d.ingest_generation = 1 THEN '' ELSE '.' || d.ingest_generation::text END
   WHERE d.visualize_execution_id IS NULL
     AND (p_within IS NULL OR d.updated_at > pg_catalog.now() - p_within)
     AND EXISTS (
       SELECT 1 FROM public.read_model_state s
        WHERE s.model_id = 'ingest-status'
          AND s.execution_id = 'u_' || d.owner_id::text || ':visualize-' || d.id::text
              || CASE WHEN d.ingest_generation = 1 THEN '' ELSE '.' || d.ingest_generation::text END);
  GET DIAGNOSTICS visualize_set = ROW_COUNT;
  RETURN ingest_set + visualize_set;
END
$$;
REVOKE ALL ON FUNCTION public.docmind_repair_execution_ids(interval) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.docmind_repair_execution_ids(interval) TO docmind_app;
-- Once, now: a run that started before the deploy stays found. The server calls it again at every boot (repairStoredExecutionIds).
SELECT public.docmind_repair_execution_ids();

CREATE FUNCTION public.docmind_user_of_handle(p_handle text)
RETURNS uuid
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT u.id FROM public.users u WHERE u.id_handle = p_handle
$$;
REVOKE ALL ON FUNCTION public.docmind_user_of_handle(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.docmind_user_of_handle(text) TO docmind_app;

CREATE FUNCTION public.docmind_user_handles(p_after uuid, p_limit integer)
RETURNS TABLE (id uuid, id_handle text)
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT u.id, u.id_handle
    FROM public.users u
   WHERE u.id_handle IS NOT NULL AND u.id > p_after
   ORDER BY u.id
   LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;
REVOKE ALL ON FUNCTION public.docmind_user_handles(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.docmind_user_handles(uuid, integer) TO docmind_app;

CREATE OR REPLACE FUNCTION public.docmind_stale_uploads_v2(older_than interval, lookback interval, max_rows integer)
RETURNS TABLE (tenant_id uuid, owner_id uuid, id uuid, generation integer)
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT d.tenant_id, d.owner_id, d.id, d.ingest_generation
    FROM public.documents d
    JOIN public.users u ON u.id = d.owner_id AND u.erasing_at IS NULL
   WHERE older_than >= interval '0'
     AND lookback <= interval '400 days'
     AND d.updated_at < pg_catalog.now() - older_than
     AND d.updated_at > pg_catalog.now() - lookback
     AND NOT EXISTS (
       SELECT 1 FROM public.read_model_state s
        WHERE s.model_id = 'ingest-status' AND s.execution_id = d.ingest_execution_id)
   ORDER BY d.updated_at DESC
   LIMIT LEAST(GREATEST(max_rows, 1), 500)
$$;

CREATE OR REPLACE FUNCTION public.docmind_ready_documents(p_after uuid, p_limit integer)
RETURNS TABLE (tenant_id uuid, owner_id uuid, id uuid, generation integer)
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT d.tenant_id, d.owner_id, d.id, d.ingest_generation
    FROM public.documents d
    JOIN public.users u ON u.id = d.owner_id AND u.erasing_at IS NULL
   WHERE d.id > p_after
     AND EXISTS (
       SELECT 1 FROM public.read_model_state s
        WHERE s.model_id = 'ingest-status'
          AND NOT s.erased
          AND s.state ->> 'status' = 'ready'
          AND s.execution_id = d.ingest_execution_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.read_model_state v
        WHERE v.model_id = 'ingest-status' AND v.execution_id = d.visualize_execution_id)
   ORDER BY d.id
   LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;

CREATE OR REPLACE FUNCTION public.docmind_visual_retry_documents(p_after uuid, p_limit integer)
RETURNS TABLE (tenant_id uuid, owner_id uuid, id uuid, generation integer)
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT d.tenant_id, d.owner_id, d.id, d.ingest_generation
    FROM public.documents d
    JOIN public.users u ON u.id = d.owner_id AND u.erasing_at IS NULL
    JOIN public.visual_runs r ON r.document_id = d.id AND r.generation = d.ingest_generation
   WHERE d.id > p_after
     AND r.state = 'failed' AND r.code = 'visuals-model-unavailable'
     AND r.updated_at < now() - interval '1 hour'
     AND EXISTS (
       SELECT 1 FROM public.read_model_state s
        WHERE s.model_id = 'ingest-status'
          AND NOT s.erased
          AND s.state ->> 'status' = 'ready'
          AND s.execution_id = d.ingest_execution_id)
   ORDER BY d.id
   LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;

CREATE OR REPLACE FUNCTION public.docmind_visual_stale_format_documents(p_after uuid, p_limit integer, p_format text)
RETURNS TABLE (tenant_id uuid, owner_id uuid, id uuid, generation integer)
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT d.tenant_id, d.owner_id, d.id, d.ingest_generation
    FROM public.documents d
    JOIN public.users u ON u.id = d.owner_id AND u.erasing_at IS NULL
    JOIN public.visual_runs r ON r.document_id = d.id AND r.generation = d.ingest_generation
   WHERE d.id > p_after
     AND r.state = 'done' AND r.format IS DISTINCT FROM p_format
     AND EXISTS (
       SELECT 1 FROM public.read_model_state s
        WHERE s.model_id = 'ingest-status'
          AND NOT s.erased
          AND s.state ->> 'status' = 'ready'
          AND s.execution_id = d.ingest_execution_id)
   ORDER BY d.id
   LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;

CREATE OR REPLACE FUNCTION public.docmind_visual_unrecorded_documents(p_after uuid, p_limit integer)
RETURNS TABLE (tenant_id uuid, owner_id uuid, id uuid, generation integer)
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT d.tenant_id, d.owner_id, d.id, d.ingest_generation
    FROM public.documents d
    JOIN public.users u ON u.id = d.owner_id AND u.erasing_at IS NULL
   WHERE d.id > p_after
     AND NOT EXISTS (
       SELECT 1 FROM public.visual_runs r
        WHERE r.document_id = d.id AND r.generation = d.ingest_generation)
     AND EXISTS (
       SELECT 1 FROM public.read_model_state s
        WHERE s.model_id = 'ingest-status'
          AND NOT s.erased
          AND s.state ->> 'status' = 'ready'
          AND s.execution_id = d.ingest_execution_id)
     AND EXISTS (
       SELECT 1 FROM public.read_model_state v
        WHERE v.model_id = 'ingest-status' AND v.execution_id = d.visualize_execution_id)
   ORDER BY d.id
   LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;
