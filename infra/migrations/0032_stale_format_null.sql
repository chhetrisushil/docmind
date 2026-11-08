-- 0032: for this release a done visualize run with NO recorded format counts as stale (document connections, K6). The fact-format
-- fingerprint gained the connections pin, and every visualized document needs one re-plan (over its stored facts, no extraction)
-- to add the Connections section: the `done` runs with a NULL format (recorded before stamping existed, or by a boot reconcile, which does not stamp) were skipped by 0030's function.
-- A re-plan that ends `done` stamps the new fingerprint (the event feed), so each document is listed once. Same signature and
-- columns as 0030's function (CREATE OR REPLACE keeps the grants); only the format test changes, from
-- `format IS NOT NULL AND format <> p_format` to `format IS DISTINCT FROM p_format`. STRICT still answers nothing to a NULL argument.
-- A later release returns to "NULL is not stale" with its own migration; 0030 is not edited.
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
          AND s.execution_id = 'u_' || d.owner_id::text || ':ingest-' || d.id::text
              || CASE WHEN d.ingest_generation = 1 THEN '' ELSE '.' || d.ingest_generation::text END)
   ORDER BY d.id
   LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;
REVOKE ALL ON FUNCTION public.docmind_visual_stale_format_documents(uuid, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.docmind_visual_stale_format_documents(uuid, integer, text) TO docmind_app;
