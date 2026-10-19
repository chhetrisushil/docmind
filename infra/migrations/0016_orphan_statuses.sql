-- A delete can run before a document's first status row is written, leaving a row for a document
-- that is gone. This lists the execution ids of such live rows (a tombstone is the erasure watermark
-- and is kept) so the sweep can tombstone them through the status model, never a raw DELETE. Ids
-- only, cross-tenant: a narrow SECURITY DEFINER function like 0015's, STRICT, at most 500 rows. A
-- status row appears only after its document committed, so a new document is never listed. Rows
-- carry no timestamp, so the order is by execution id; each purge shrinks the set.
CREATE FUNCTION public.docmind_orphan_statuses(max_rows integer)
RETURNS TABLE (execution_id text)
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT s.execution_id
    FROM public.read_model_state s
   WHERE s.model_id = 'ingest-status'
     AND NOT s.erased
     AND s.app_key IS NOT NULL
     AND s.scope IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.documents d
        WHERE d.id::text = s.app_key AND d.owner_id::text = s.scope)
   ORDER BY s.execution_id
   LIMIT LEAST(GREATEST(max_rows, 1), 500)
$$;
REVOKE ALL ON FUNCTION public.docmind_orphan_statuses(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.docmind_orphan_statuses(integer) TO docmind_app;
