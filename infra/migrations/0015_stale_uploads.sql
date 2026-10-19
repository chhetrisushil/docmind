-- Documents committed but never given a flow: the upload crashed or the start failed between COMMIT
-- and the Loom start. "No flow" = no row for the document's current-generation ingest execution in
-- the status model's table (0012). Cross-tenant by nature, so a narrow SECURITY DEFINER function
-- (owned by the migration role, which RLS does not bind) rather than a policy hole. It returns ids
-- only. The execution id is built exactly as apps/server/app/documents/ingest.ts builds it:
-- generation 1 is the bare name, n >= 2 is ".n" (".1" is never emitted); the sweep test pins that.
-- documents.status and .error no longer exist (0013), so nothing here reads them.
-- Narrow on purpose: STRICT (a NULL argument returns no rows), at most 500 rows, and an argument
-- outside its range (generation < 1, a negative grace, a lookback over 400 days) returns no rows.
CREATE INDEX documents_created_at_idx ON public.documents (created_at);

CREATE FUNCTION public.docmind_stale_uploads(older_than interval, lookback interval, generation integer, max_rows integer)
RETURNS TABLE (tenant_id uuid, owner_id uuid, id uuid)
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT d.tenant_id, d.owner_id, d.id
    FROM public.documents d
   WHERE generation >= 1
     AND older_than >= interval '0'
     AND lookback <= interval '400 days'
     AND d.created_at < pg_catalog.now() - older_than
     AND d.created_at > pg_catalog.now() - lookback
     AND NOT EXISTS (
       SELECT 1 FROM public.read_model_state s
        WHERE s.model_id = 'ingest-status'
          AND s.execution_id = 'u_' || d.owner_id::text || ':ingest-' || d.id::text
              || CASE WHEN generation = 1 THEN '' ELSE '.' || generation::text END)
   ORDER BY d.created_at DESC
   LIMIT LEAST(GREATEST(max_rows, 1), 500)
$$;
REVOKE ALL ON FUNCTION public.docmind_stale_uploads(interval, interval, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.docmind_stale_uploads(interval, interval, integer, integer) TO docmind_app;
