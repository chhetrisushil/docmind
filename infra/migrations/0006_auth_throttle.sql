-- Failure counters behind login and sign-up throttling (packages/auth/src/throttle.ts). A key is
-- "<scope>-ip:<address>" or "<scope>-acct:<sha256 of the email>", so no address of a person is stored
-- and an email that does not exist is counted like one that does. The counters are in Postgres so
-- they survive restarts and are shared by every server instance.
CREATE TABLE public.auth_throttle (
  key text PRIMARY KEY,
  failures integer NOT NULL,
  locked_until timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

-- Throttling happens before any tenant is known, so there is no tenant policy: docmind_app gets no
-- privilege on the table and reaches it only through the functions below.
ALTER TABLE public.auth_throttle ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.auth_throttle FROM PUBLIC, docmind_app;

-- Seconds until the last of these keys unlocks; 0 when none is locked.
CREATE FUNCTION public.throttle_retry_after(p_keys text[])
  RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ SELECT COALESCE(ceil(max(extract(epoch FROM t.locked_until - pg_catalog.now())))::integer, 0)
          FROM public.auth_throttle t WHERE t.key = ANY (p_keys) AND t.locked_until > pg_catalog.now() $$;

-- Counts one failure, also one made while locked. Past the free allowance the key is locked from now
-- for base * 2^(n - free - 1) seconds (exponent clamped at 30), at most cap: the same as lockSeconds()
-- in packages/auth/src/throttle.ts. A key whose last failure is p_decay seconds old starts again
-- from one failure.
CREATE FUNCTION public.throttle_fail(p_key text, p_free integer, p_base integer, p_cap integer, p_decay integer)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  n integer;
BEGIN
  INSERT INTO public.auth_throttle AS t (key, failures, locked_until, updated_at)
    VALUES (p_key, 1, pg_catalog.now(), pg_catalog.now())
    ON CONFLICT (key) DO UPDATE SET
      failures = CASE WHEN t.updated_at <= pg_catalog.now() - pg_catalog.make_interval(secs => p_decay)
                      THEN 1 ELSE t.failures + 1 END,
      locked_until = CASE WHEN t.updated_at <= pg_catalog.now() - pg_catalog.make_interval(secs => p_decay)
                          THEN pg_catalog.now() ELSE t.locked_until END,
      updated_at = pg_catalog.now()
    RETURNING t.failures INTO n;
  IF n > p_free THEN
    UPDATE public.auth_throttle
       SET locked_until = pg_catalog.now() + pg_catalog.make_interval(
             secs => least(p_cap::float8, p_base::float8 * pg_catalog.power(2::float8, least(n - p_free - 1, 30))))
     WHERE key = p_key;
  END IF;
END
$$;

CREATE FUNCTION public.throttle_clear(p_key text)
  RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ DELETE FROM public.auth_throttle WHERE key = p_key $$;

-- Drops counters that are unlocked and untouched for a day; returns how many.
CREATE FUNCTION public.throttle_purge()
  RETURNS bigint
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
  AS $$ WITH gone AS (DELETE FROM public.auth_throttle
                       WHERE updated_at < pg_catalog.now() - interval '1 day' AND locked_until < pg_catalog.now()
                       RETURNING 1)
        SELECT pg_catalog.count(*) FROM gone $$;

REVOKE ALL ON FUNCTION public.throttle_retry_after(text[]),
  public.throttle_fail(text, integer, integer, integer, integer),
  public.throttle_clear(text), public.throttle_purge() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.throttle_retry_after(text[]),
  public.throttle_fail(text, integer, integer, integer, integer),
  public.throttle_clear(text), public.throttle_purge() TO docmind_app;
