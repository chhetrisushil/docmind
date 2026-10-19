-- The current ingest generation of each document (M3b D1). Execution ids are
-- u_<user>:ingest-<document>.<generation>; part 1 started generation 2 for every document, so every
-- existing row is 2. A user retry bumps it by compare-and-set (apps/server/app/documents/repo.ts,
-- bumpGeneration); nothing else writes it. 1 is the retired M2 stub's bare name and is never current.
ALTER TABLE documents
  ADD COLUMN ingest_generation integer NOT NULL DEFAULT 2
  CONSTRAINT documents_ingest_generation_check CHECK (ingest_generation BETWEEN 2 AND 999999999);
