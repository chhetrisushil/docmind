-- 0033: ready documents with NO visual_runs row for their current generation (document connections rollout, K6). A document
-- visualized before 0030 created `visual_runs` has no row, so the stale-format function (0030/0032, which joins the table) never
-- lists it and it never gets the Connections section. This function lists them: ids only (tenant_id, owner_id, id, generation),
-- across tenants, keyset-paged by document id, capped at 500, users being erased excluded. Whether the document was ever
-- visualized (a visuals lineage head) is checked by the starter, under the owner, not here: the lineage is sealed content.
-- A re-run records a row (any outcome), so a document is listed once. Same hardening as 0030/0032. 0032 is not edited.
CREATE FUNCTION public.docmind_visual_unrecorded_documents(p_after uuid, p_limit integer)
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
          AND s.execution_id = 'u_' || d.owner_id::text || ':ingest-' || d.id::text
              || CASE WHEN d.ingest_generation = 1 THEN '' ELSE '.' || d.ingest_generation::text END)
   ORDER BY d.id
   LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;
REVOKE ALL ON FUNCTION public.docmind_visual_unrecorded_documents(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.docmind_visual_unrecorded_documents(uuid, integer) TO docmind_app;
