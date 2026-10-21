-- Erasure requests are listed by keyset, so a listing never skips a request (M5 final review M4). 0024's function
-- returned at most 1000 rows, oldest first; callers that need every request (the boot resume, the rescan, the post-boot
-- re-tombstoning of erased users) could not reach the rest. The new function takes the last user id already seen and a
-- page size, orders by user id, and a caller repeats until a page comes back short. It replaces the old one (a new
-- signature is a new function, so the old one is dropped), keeps the same grants, and keeps the definer count at six.
-- STRICT, so a NULL argument answers nothing; the nil UUID is the "from the start" cursor and belongs to no user.
DROP FUNCTION public.docmind_erasure_pending(text);

CREATE FUNCTION public.docmind_erasure_pending(
  p_state text DEFAULT 'pending',
  p_after uuid DEFAULT '00000000-0000-0000-0000-000000000000',
  p_limit integer DEFAULT 500
)
RETURNS TABLE (user_id uuid, tenant_id uuid, state text, steps text[], attempts integer)
LANGUAGE plpgsql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_state NOT IN ('pending', 'done') OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'invalid erasure listing' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT r.user_id, r.tenant_id, r.state, r.steps, r.attempts
      FROM public.erasure_requests r
     WHERE r.state = p_state AND r.user_id > p_after
     ORDER BY r.user_id
     LIMIT p_limit;
END
$$;

REVOKE ALL ON FUNCTION public.docmind_erasure_pending(text, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.docmind_erasure_pending(text, uuid, integer) TO docmind_app;
