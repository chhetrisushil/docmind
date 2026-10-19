-- requires-extension: vector
-- The embedding is stored in the clear on purpose (spec 4.4): pgvector must compare raw vectors. It
-- is hard-deleted with its row on erasure and survives only in backups, for their retention window.
-- 768 is nomic-embed-text's dimension; changing the model's size is a new migration plus a re-embed.
-- Deployment: pgvector is not a trusted extension, so the migrator must be a superuser or a DBA must
-- run CREATE EXTENSION vector first. In the second case the grant loop below finds the functions
-- already PUBLIC-executable (0001's default privileges only cover objects the migrator creates), so
-- its GRANTs are no-ops that warn; that is harmless, they are pure math and type functions.
-- Upgrades: ALTER EXTENSION vector UPDATE adds functions the app cannot execute (0001's revoke), so
-- any migration that updates the extension must re-run the grant loop. The test's `ungranted: 0`
-- assertion catches this.
-- Ownership: the migrator owns the extension, the column and the index, like every other object;
-- row-level security on chunks is unchanged and covers the new column.
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE chunks
  ADD COLUMN embedding vector(768),
  ADD COLUMN embedding_model text,
  ADD CONSTRAINT chunks_embedding_pair CHECK ((embedding IS NULL) = (embedding_model IS NULL));

CREATE INDEX chunks_embedding_hnsw ON chunks USING hnsw (embedding vector_cosine_ops);

-- F01. 0001 revokes EXECUTE on every new function from PUBLIC (a global default privilege), and that
-- also reaches the extension's own functions created above. The app role would then fail with
-- "permission denied for function vector" (the typmod coercion on every write to vector(768)) and
-- "permission denied for function cosine_distance" (every search). Grant it EXECUTE on the
-- extension's member functions only, never on all functions (aggregates are skipped: prokind 'f').
DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure
    FROM pg_depend d
    JOIN pg_extension e ON e.oid = d.refobjid
    JOIN pg_proc p ON p.oid = d.objid
    WHERE d.refclassid = 'pg_extension'::regclass
      AND d.classid = 'pg_proc'::regclass
      AND d.deptype = 'e'
      AND e.extname = 'vector'
      AND p.prokind = 'f'
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO docmind_app', f);
  END LOOP;
END
$$;
