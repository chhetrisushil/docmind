-- 0034: the unrecorded-documents list (0033) now also requires a visualize execution for the document's current generation, the
-- inverse of 0028's ready list. A document re-ingested to a new generation while the process was down still has a lineage head
-- from the old one; the ready pass starts its run 0 (an extraction), and this list must not also re-plan it. The pass is now exactly
-- "visualized for this generation, with no visual_runs row", disjoint from the ready pass. Same signature, columns and hardening
-- (CREATE OR REPLACE keeps the grants); 0033 is not edited.
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
          AND s.execution_id = 'u_' || d.owner_id::text || ':ingest-' || d.id::text
              || CASE WHEN d.ingest_generation = 1 THEN '' ELSE '.' || d.ingest_generation::text END)
     AND EXISTS (
       SELECT 1 FROM public.read_model_state v
        WHERE v.model_id = 'ingest-status'
          AND v.execution_id = 'u_' || d.owner_id::text || ':visualize-' || d.id::text
              || CASE WHEN d.ingest_generation = 1 THEN '' ELSE '.' || d.ingest_generation::text END)
   ORDER BY d.id
   LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;
