-- Per-subject data keys for crypto-shredding (spec 4.4). A subject is a user. The key is stored
-- wrapped by a master key held outside the database. Destroying it leaves a tombstone row, so the
-- subject can never be given a new key.
CREATE TABLE public.data_keys (
  subject_id text PRIMARY KEY,
  wrapped_dek bytea,
  kek_id text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  destroyed_at timestamptz,
  CONSTRAINT data_keys_live_or_destroyed CHECK (
    (wrapped_dek IS NOT NULL AND kek_id IS NOT NULL AND destroyed_at IS NULL)
    OR (wrapped_dek IS NULL AND kek_id IS NULL AND destroyed_at IS NOT NULL))
);

-- No policy and no privileges for docmind_app: the functions below are its only way in, so it can
-- ask for one subject's key but cannot dump the table. (Keys are used outside any tenant context.)
ALTER TABLE public.data_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.data_keys FROM PUBLIC, docmind_app;

-- The live key of a subject, if it has one.
CREATE FUNCTION public.key_get(p_subject text)
  RETURNS TABLE (dek bytea, kek text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT k.wrapped_dek, k.kek_id FROM public.data_keys k
         WHERE k.subject_id = p_subject AND k.wrapped_dek IS NOT NULL $$;

-- Stores a key unless the subject has one and returns the stored one, so racing creators agree.
-- Refuses a destroyed subject.
CREATE FUNCTION public.key_put(p_subject text, p_dek bytea, p_kek text)
  RETURNS TABLE (dek bytea, kek text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  INSERT INTO public.data_keys (subject_id, wrapped_dek, kek_id)
    VALUES (p_subject, p_dek, p_kek) ON CONFLICT (subject_id) DO NOTHING;
  RETURN QUERY SELECT k.wrapped_dek, k.kek_id FROM public.data_keys k
    WHERE k.subject_id = p_subject AND k.wrapped_dek IS NOT NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the key for subject % was destroyed and cannot be recreated', p_subject
      USING ERRCODE = 'DM001';
  END IF;
END
$$;

-- Overwrites the live row and tombstones the subject (also one never seen, which is then barred from
-- a key). Dead rows (until VACUUM), WAL and backups still hold the wrapped key: real shredding needs
-- KEK rotation, then retiring the old KEK after the backup/WAL retention window.
CREATE FUNCTION public.key_destroy(p_subject text)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ INSERT INTO public.data_keys (subject_id, destroyed_at) VALUES (p_subject, pg_catalog.now())
        ON CONFLICT (subject_id) DO UPDATE
          SET wrapped_dek = NULL, kek_id = NULL,
              destroyed_at = COALESCE(public.data_keys.destroyed_at, pg_catalog.now()) $$;

-- Proof of destruction (Loom's KeyStore.wasDestroyed).
CREATE FUNCTION public.key_was_destroyed(p_subject text)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT EXISTS (SELECT 1 FROM public.data_keys
                        WHERE subject_id = p_subject AND destroyed_at IS NOT NULL) $$;

REVOKE ALL ON FUNCTION public.key_get(text), public.key_put(text, bytea, text),
  public.key_destroy(text), public.key_was_destroyed(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.key_get(text), public.key_put(text, bytea, text),
  public.key_destroy(text), public.key_was_destroyed(text) TO docmind_app;
