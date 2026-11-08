-- 0030: the last visualize run of a document's ingest generation (retry of document visuals). One row per (document,
-- generation): the run number (0 is the automatic run, n is `-r<n>`), its state and, for a failed run, a fixed code. It
-- is what the detail page reads for "Visuals couldn't be made" and what the boot sweep reads to re-run a document whose
-- last run ended `visuals-model-unavailable`. Ids, enums and codes only: no content.
CREATE TABLE visual_runs (
  document_id uuid NOT NULL,
  generation int NOT NULL CHECK (generation >= 1),
  tenant_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  run int NOT NULL CHECK (run BETWEEN 0 AND 999),
  state text NOT NULL CHECK (state IN ('running', 'done', 'empty', 'skipped', 'failed', 'document_gone')),
  code text CHECK (code IS NULL OR code IN (
    'unsupported_content', 'corrupt_content', 'too_large', 'vision_unavailable',
    'visuals-plan-invalid', 'visuals-model-unavailable', 'internal')),
  -- The fact-format fingerprint (packages/experiences `factFormatFingerprint`) of the last run of this generation that ended
  -- `done`; NULL for a run that never did (and for rows from before the column). A short canonical string of pins: no content.
  format text CHECK (format IS NULL OR length(format) <= 200),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, generation),
  CONSTRAINT visual_runs_owner_fkey FOREIGN KEY (tenant_id, owner_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT visual_runs_document_fkey FOREIGN KEY (tenant_id, document_id) REFERENCES documents (tenant_id, id) ON DELETE CASCADE
);
ALTER TABLE visual_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON visual_runs USING (tenant_id = app_tenant_id());

-- Records a run's state. The event feed that sees a visualize execution end carries the user, document and generation
-- (the execution id) but no tenant, so this narrow SECURITY DEFINER function takes the tenant from the document row, and
-- writes only for a live document of that owner (not one being erased, as the lists below) whose CURRENT generation is the
-- run's (a superseded generation's run is history). A lower run number never overwrites a higher one (a late event of an older run), and a finished run is
-- never put back to `running` (the start of a run races its own fast end). Ids, enums, a code and the format string only.
-- The format is kept only when the run ends `done`: a run that ends empty, failed or skipped records no fingerprint change.
CREATE FUNCTION public.docmind_record_visual_run(
  p_owner uuid, p_document uuid, p_generation integer, p_run integer, p_state text, p_code text, p_format text)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  INSERT INTO public.visual_runs (document_id, generation, tenant_id, owner_id, run, state, code, format)
  SELECT d.id, d.ingest_generation, d.tenant_id, d.owner_id, p_run, p_state, p_code,
         CASE WHEN p_state = 'done' THEN p_format END
    FROM public.documents d
    JOIN public.users u ON u.id = d.owner_id AND u.erasing_at IS NULL
   WHERE d.id = p_document AND d.owner_id = p_owner AND d.ingest_generation = p_generation
  ON CONFLICT (document_id, generation) DO UPDATE
     SET run = EXCLUDED.run, state = EXCLUDED.state, code = EXCLUDED.code, updated_at = now(),
         -- only a run that ended `done` changes the format; any other run keeps the last stamp
         format = CASE WHEN EXCLUDED.state = 'done' THEN COALESCE(EXCLUDED.format, public.visual_runs.format)
                       ELSE public.visual_runs.format END
   WHERE EXCLUDED.run > public.visual_runs.run
      OR (EXCLUDED.run = public.visual_runs.run
          AND (public.visual_runs.state = 'running' OR EXCLUDED.state <> 'running'))
$$;
REVOKE ALL ON FUNCTION public.docmind_record_visual_run(uuid, uuid, integer, integer, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.docmind_record_visual_run(uuid, uuid, integer, integer, text, text, text) TO docmind_app;

-- The boot sweep's second source: ready documents (as 0028) whose last visualize run of the current generation ended
-- `visuals-model-unavailable` AT LEAST AN HOUR AGO (`updated_at`): a process that crash-loops on boot must not re-run these
-- every start and hammer a model that is down. Ids only, across tenants, keyset-paged by document id, at most 500 rows.
CREATE FUNCTION public.docmind_visual_retry_documents(p_after uuid, p_limit integer)
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
          AND s.execution_id = 'u_' || d.owner_id::text || ':ingest-' || d.id::text
              || CASE WHEN d.ingest_generation = 1 THEN '' ELSE '.' || d.ingest_generation::text END)
   ORDER BY d.id
   LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;
REVOKE ALL ON FUNCTION public.docmind_visual_retry_documents(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.docmind_visual_retry_documents(uuid, integer) TO docmind_app;

-- The boot reconcile's source: runs recorded as `running` for a document's current generation. A recorded end can be lost
-- (the event feed is live only and its writes are dropped at shutdown), so the starter asks Loom for the execution's real
-- state and repairs the row. Ids and the run number only, across tenants, keyset-paged by document id, at most 500 rows.
CREATE FUNCTION public.docmind_visual_running_runs(p_after uuid, p_limit integer)
RETURNS TABLE (tenant_id uuid, owner_id uuid, id uuid, generation integer, run integer)
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT d.tenant_id, d.owner_id, d.id, d.ingest_generation, r.run
    FROM public.documents d
    JOIN public.users u ON u.id = d.owner_id AND u.erasing_at IS NULL
    JOIN public.visual_runs r ON r.document_id = d.id AND r.generation = d.ingest_generation
   WHERE d.id > p_after AND r.state = 'running'
   ORDER BY d.id
   LIMIT LEAST(GREATEST(p_limit, 1), 500)
$$;
REVOKE ALL ON FUNCTION public.docmind_visual_running_runs(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.docmind_visual_running_runs(uuid, integer) TO docmind_app;

-- The boot sweep's stale-format source: ready documents (as 0028) whose last visualize run of the current generation ended
-- `done` with a recorded format that differs from the caller's current one. A NULL format (a run from before the column, or
-- one never stamped) is NOT stale. Ids only, across tenants, keyset-paged by document id, at most 500 rows.
CREATE FUNCTION public.docmind_visual_stale_format_documents(p_after uuid, p_limit integer, p_format text)
RETURNS TABLE (tenant_id uuid, owner_id uuid, id uuid, generation integer)
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT d.tenant_id, d.owner_id, d.id, d.ingest_generation
    FROM public.documents d
    JOIN public.users u ON u.id = d.owner_id AND u.erasing_at IS NULL
    JOIN public.visual_runs r ON r.document_id = d.id AND r.generation = d.ingest_generation
   WHERE d.id > p_after
     AND r.state = 'done' AND r.format IS NOT NULL AND r.format <> p_format
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
