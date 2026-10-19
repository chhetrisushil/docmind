/**
 * Per-owner advisory lock key for entity writes (R12). Ingests take it shared before their upserts;
 * the document delete takes it exclusive before the orphan purge, so the purge's snapshot postdates
 * every committed ingest and a mention can never be cascaded away by a purge that could not see it.
 */
export const ENTITY_LOCK_KEY = "pg_catalog.hashtextextended('docmind-entities:' || $1::text, 0)";
export const ENTITY_LOCK_SHARED = `SELECT pg_catalog.pg_advisory_xact_lock_shared(${ENTITY_LOCK_KEY})`;
export const ENTITY_LOCK_EXCLUSIVE = `SELECT pg_catalog.pg_advisory_xact_lock(${ENTITY_LOCK_KEY})`;

/** Per-owner exclusive advisory lock that serialises link writes (R14); the key is derived from the owner id. */
export const LINK_LOCK_KEY = "pg_catalog.hashtextextended('docmind-links:' || $1::text, 0)";
export const LINK_LOCK_EXCLUSIVE = `SELECT pg_catalog.pg_advisory_xact_lock(${LINK_LOCK_KEY})`;
