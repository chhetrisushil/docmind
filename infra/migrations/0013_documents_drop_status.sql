-- A document's status is the ingest-status model's state (0012): a document with no row there is
-- `uploaded`, and the failure text is derived from the failure code at read time. A column that
-- nothing writes would only be a second source of truth that can disagree with the log.
ALTER TABLE documents DROP COLUMN status, DROP COLUMN error;
