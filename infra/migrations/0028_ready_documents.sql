-- The visualize-document boot sweep (visuals Task 9): the documents whose ingest has finished (the current
-- generation's ingest-status row is `ready`) and that have no visualize execution for that generation yet. Ids only,
-- across tenants, like 0016 and 0019: a narrow SECURITY DEFINER function, STRICT, paged by document id (the caller
-- repeats with the last id until a page comes back short; the nil UUID starts the scan), at most 500 rows. A user
-- being erased is skipped (as 0024's stale-upload scan). Loom writes a row for EVERY execution into read_model_state,
-- so a visualize execution that has started has a row, whatever its outcome, and is not listed again.
CREATE FUNCTION public.docmind_ready_documents(p_after uuid, p_limit integer)
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
          AND s.execution_id = 'u_' || d.owner_id::text || ':ingest-' || d.id::text
              || CASE WHEN d.ingest_generation = 1 THEN '' ELSE '.' || d.ingest_generation::text END)
     AND NOT EXISTS (
       SELECT 1 FROM public.read_model_state v
        WHERE v.model_id = 'ingest-status'
          AND v.execution_id = 'u_' || d.owner_id::text || ':visualize-' || d.id::text
              || CASE WHEN d.ingest_generation = 1 THEN '' ELSE '.' || d.ingest_generation::text END)
   ORDER BY d.id
   LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;
REVOKE ALL ON FUNCTION public.docmind_ready_documents(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.docmind_ready_documents(uuid, integer) TO docmind_app;
