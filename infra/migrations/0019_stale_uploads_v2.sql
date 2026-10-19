-- Generation-aware stale-upload scan (M3b D1). A document's current generation is its own column
-- (0018), so the function reads it instead of taking one, and returns it so the sweep starts exactly
-- that execution. Age and lookback use updated_at, which the upload sets and a retry bumps, so a
-- retry whose start failed is found however old the document is. Ids and an integer only, across
-- tenants: STRICT, at most 500 rows, out-of-range arguments return no rows, as 0015.
CREATE INDEX documents_updated_at_idx ON public.documents (updated_at);

CREATE FUNCTION public.docmind_stale_uploads_v2(older_than interval, lookback interval, max_rows integer)
RETURNS TABLE (tenant_id uuid, owner_id uuid, id uuid, generation integer)
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT d.tenant_id, d.owner_id, d.id, d.ingest_generation
    FROM public.documents d
   WHERE older_than >= interval '0'
     AND lookback <= interval '400 days'
     AND d.updated_at < pg_catalog.now() - older_than
     AND d.updated_at > pg_catalog.now() - lookback
     AND NOT EXISTS (
       SELECT 1 FROM public.read_model_state s
        WHERE s.model_id = 'ingest-status'
          AND s.execution_id = 'u_' || d.owner_id::text || ':ingest-' || d.id::text
              || '.' || d.ingest_generation::text)
   ORDER BY d.updated_at DESC
   LIMIT LEAST(GREATEST(max_rows, 1), 500)
$$;
REVOKE ALL ON FUNCTION public.docmind_stale_uploads_v2(interval, interval, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.docmind_stale_uploads_v2(interval, interval, integer) TO docmind_app;

DROP FUNCTION public.docmind_stale_uploads(interval, interval, integer, integer);
