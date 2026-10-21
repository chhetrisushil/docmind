-- Account erasure (M5 D2). Three things:
--   * users.erasing_at: set in the transaction that accepts a DELETE /api/me; login and session lookup then refuse the user.
--   * erasure_requests: the durable request the eraser resumes from. It outlives the user (no foreign key), so it holds
--     ids, step names, a retry counter and times only: no email, no content.
--   * four narrow SECURITY DEFINER functions, the "fourth cross-tenant path": they list requests by state across tenants
--     (the boot resume has no tenant), record a step, answer the state of one request by the hash of its receipt (the
--     receipt route has no session, so no tenant), and delete a tenant that has no users left (docmind_app cannot
--     delete tenants, 0003). Each pins search_path, is STRICT where it takes arguments, returns ids or a state only, and
--     is executable by docmind_app alone.
--   * The email scrub (users.email = 'erased:' || id, done by the route in its own tenant transaction) needs nothing
--     here: docmind_app already holds UPDATE on users under the tenant_isolation policy.
ALTER TABLE users ADD COLUMN erasing_at timestamptz;

CREATE TABLE erasure_requests (
  user_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  -- sha256 of the receipt token's text. The token itself is never stored; the hash is what the status route looks up.
  receipt_hash bytea NOT NULL
    CONSTRAINT erasure_requests_receipt_hash_key UNIQUE
    CONSTRAINT erasure_requests_receipt_hash_len CHECK (octet_length(receipt_hash) = 32),
  state text NOT NULL DEFAULT 'pending'
    CONSTRAINT erasure_requests_state_check CHECK (state IN ('pending', 'done')),
  steps text[] NOT NULL DEFAULT '{}'
    CONSTRAINT erasure_requests_steps_check
    CHECK (steps <@ ARRAY['stop', 'shred', 'readModels', 'rows', 'blobs', 'key', 'done']::text[]),
  attempts integer NOT NULL DEFAULT 0 CONSTRAINT erasure_requests_attempts_check CHECK (attempts >= 0),
  requested_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT erasure_requests_done_pair CHECK ((state = 'done') = (completed_at IS NOT NULL))
);
CREATE INDEX erasure_requests_pending_idx ON erasure_requests (requested_at) WHERE state = 'pending';

-- Row-level security stays on (the tenancy suite requires it on every table). The route inserts the request inside the
-- user's own tenant transaction, so the app role may INSERT and nothing else: the check pins the row to the
-- transaction's tenant, to a user of that tenant, and to a fresh pending request. Reads and updates go through the
-- functions below only.
ALTER TABLE erasure_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON erasure_requests FROM PUBLIC, docmind_app;
GRANT INSERT ON erasure_requests TO docmind_app;
CREATE POLICY request_insert ON erasure_requests FOR INSERT TO docmind_app
  WITH CHECK (
    tenant_id = app_tenant_id()
    AND state = 'pending' AND steps = '{}' AND attempts = 0 AND completed_at IS NULL
    AND EXISTS (SELECT 1 FROM users u
                 WHERE u.tenant_id = erasure_requests.tenant_id AND u.id = erasure_requests.user_id));

-- The requests in one state ('pending', the default, or 'done'), across tenants: ids, step names and a counter. At most
-- 1000: pending oldest first (the boot resume), done newest first (the post-boot forgetUser re-run). Any other state is
-- rejected. STRICT, so a NULL state answers no rows. One function serves both lists, so the definer count is six (four erasure functions and the sweep's two).
CREATE FUNCTION public.docmind_erasure_pending(p_state text DEFAULT 'pending')
RETURNS TABLE (user_id uuid, tenant_id uuid, state text, steps text[], attempts integer)
LANGUAGE plpgsql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF p_state NOT IN ('pending', 'done') THEN
    RAISE EXCEPTION 'unknown erasure state' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT r.user_id, r.tenant_id, r.state, r.steps, r.attempts
      FROM public.erasure_requests r
     WHERE r.state = p_state
     ORDER BY (CASE WHEN p_state = 'pending' THEN r.requested_at END), r.completed_at DESC NULLS LAST, r.user_id
     LIMIT 1000;
END
$$;

-- Records one finished step of a request, or counts a retry (p_step = 'retry', which is not a step; it bumps attempts
-- while the request is pending). Steps are recorded in ERASURE_STEPS order only: a step is accepted when it is the next
-- one after those already recorded; a step already recorded, or any mark on a request that is done, is an idempotent
-- no-op that answers true. p_done must agree with p_step = 'done', and 'done' is the last step, so a request becomes
-- done only after every earlier step is recorded. False when there is no such request. Errors carry codes only (22023).
CREATE FUNCTION public.docmind_erasure_mark(p_user_id uuid, p_step text, p_done boolean)
RETURNS boolean
LANGUAGE plpgsql STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  all_steps constant text[] := ARRAY['stop', 'shred', 'readModels', 'rows', 'blobs', 'key', 'done']::text[];
  req public.erasure_requests%ROWTYPE;
BEGIN
  IF p_step = 'retry' THEN
    UPDATE public.erasure_requests r
       SET attempts = r.attempts + 1, updated_at = pg_catalog.now()
     WHERE r.user_id = p_user_id AND r.state = 'pending';
    RETURN FOUND;
  END IF;
  IF NOT (p_step = ANY (all_steps)) THEN
    RAISE EXCEPTION 'unknown erasure step' USING ERRCODE = '22023';
  END IF;
  IF p_done IS DISTINCT FROM (p_step = 'done') THEN
    RAISE EXCEPTION 'done flag disagrees with the step' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO req FROM public.erasure_requests r WHERE r.user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF req.state = 'done' OR p_step = ANY (req.steps) THEN
    RETURN true;
  END IF;
  IF all_steps[pg_catalog.cardinality(req.steps) + 1] IS DISTINCT FROM p_step THEN
    RAISE EXCEPTION 'erasure step out of order' USING ERRCODE = '22023';
  END IF;
  UPDATE public.erasure_requests r
     SET steps = pg_catalog.array_append(r.steps, p_step),
         state = CASE WHEN p_step = 'done' THEN 'done' ELSE r.state END,
         completed_at = CASE WHEN p_step = 'done' THEN pg_catalog.now() ELSE r.completed_at END,
         updated_at = pg_catalog.now()
   WHERE r.user_id = p_user_id;
  RETURN true;
END
$$;

-- The state of the request a receipt belongs to: 'pending', 'done', or NULL for a hash that matches none. It takes a hash
-- and returns a state, nothing else: no id, no step, no time. STRICT, so a NULL hash answers NULL. The receipt route has
-- no session and so no tenant; knowing the token (256 random bits) is the credential.
CREATE FUNCTION public.docmind_erasure_status(p_receipt_hash bytea)
RETURNS text
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT r.state FROM public.erasure_requests r WHERE r.receipt_hash = p_receipt_hash
$$;

-- Deletes a tenant that has no user left (the personal tenant of an erased user). docmind_app cannot delete tenants
-- (0003): a tenant's own session must never be able to cascade over its users. True when a tenant was deleted.
CREATE FUNCTION public.docmind_delete_empty_tenant(p_tenant_id uuid)
RETURNS boolean
LANGUAGE plpgsql STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- Lock the tenant row first. A concurrent INSERT INTO users takes FOR KEY SHARE on it (the foreign key), which
  -- conflicts with FOR UPDATE; the emptiness check below is a later statement, so it sees a fresh snapshot and the
  -- insert cannot slip in between the check and the delete (the cascade would remove that new user).
  PERFORM 1 FROM public.tenants t WHERE t.id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF EXISTS (SELECT 1 FROM public.users u WHERE u.tenant_id = p_tenant_id) THEN
    RETURN false;
  END IF;
  DELETE FROM public.tenants t WHERE t.id = p_tenant_id;
  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION public.docmind_erasure_pending(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.docmind_erasure_mark(uuid, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.docmind_erasure_status(bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.docmind_delete_empty_tenant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.docmind_erasure_pending(text) TO docmind_app;
GRANT EXECUTE ON FUNCTION public.docmind_erasure_mark(uuid, text, boolean) TO docmind_app;
GRANT EXECUTE ON FUNCTION public.docmind_erasure_status(bytea) TO docmind_app;
GRANT EXECUTE ON FUNCTION public.docmind_delete_empty_tenant(uuid) TO docmind_app;

-- A user who is being erased cannot log in or authenticate. Same signatures as 0005, so the grants carry over; an
-- unknown email already takes the login route's decoy path, so the answer is the one for invalid credentials.
CREATE OR REPLACE FUNCTION public.auth_find_login(p_email text)
  RETURNS TABLE (user_id uuid, tenant_id uuid, password_hash text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT u.id, u.tenant_id, u.password_hash FROM public.users u
         WHERE u.email = p_email AND u.erasing_at IS NULL $$;

CREATE OR REPLACE FUNCTION public.auth_find_session(p_token_hash text)
  RETURNS TABLE (user_id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT s.user_id, s.tenant_id FROM public.auth_sessions s
          JOIN public.users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
         WHERE s.token_hash = p_token_hash AND s.expires_at > pg_catalog.now() AND u.erasing_at IS NULL $$;
REVOKE ALL ON FUNCTION public.auth_find_login(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_find_session(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_find_login(text) TO docmind_app;
GRANT EXECUTE ON FUNCTION public.auth_find_session(text) TO docmind_app;

-- Once a user is being erased, nobody can undo it: erasing_at cannot be cleared or changed, and the email can only be
-- the scrubbed 'erased:' || id (the tenant_isolation policy lets any session of the tenant update its users).
CREATE FUNCTION public.erasure_users_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.erasing_at IS NOT NULL THEN
    IF NEW.erasing_at IS DISTINCT FROM OLD.erasing_at THEN
      RAISE EXCEPTION 'erasing_at is final' USING ERRCODE = '23514';
    END IF;
    IF NEW.email IS DISTINCT FROM OLD.email AND NEW.email IS DISTINCT FROM 'erased:' || NEW.id::text THEN
      RAISE EXCEPTION 'email of an erasing user is final' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.erasure_users_guard() FROM PUBLIC;
CREATE TRIGGER erasure_users_guard BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION public.erasure_users_guard();

-- The upload sweep must not start the ingest of a user who is being erased. Same signature, security settings,
-- search_path and grants as 0019 (CREATE OR REPLACE keeps the owner and the ACL); the only change is the erasing_at join.
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
        WHERE s.model_id = 'ingest-status'
          AND s.execution_id = 'u_' || d.owner_id::text || ':ingest-' || d.id::text
              || '.' || d.ingest_generation::text)
   ORDER BY d.updated_at DESC
   LIMIT LEAST(GREATEST(max_rows, 1), 500)
$$;
REVOKE ALL ON FUNCTION public.docmind_stale_uploads_v2(interval, interval, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.docmind_stale_uploads_v2(interval, interval, integer) TO docmind_app;
