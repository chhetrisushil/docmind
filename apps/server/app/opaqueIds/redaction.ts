/**
 * The shapes of ids as a scrubber sees them in free text (Loom's warnings, notices): where an id is recognised without being parsed
 * into a subject. They live here, beside the builders, so the id-shape ratchet (`executionIds.test.ts`) can keep every pattern that
 * names an id's shape inside this directory.
 */

/** A new-format lineage line (`visuals-<handle>-<token>`, `turnvisuals-<handle>-<token>-<ord>`). Lower-case base32 only. */
export const LINEAGE_ID_PATTERN = /\b(?:turn)?visuals-[a-z2-7]{26}-[a-z2-7]{52}/;
/** A bare 26-character handle. Lower-case base32 only. */
export const HANDLE_PATTERN = /\b[a-z2-7]{25}[aeimquy4]\b/;
/** Any UUID (a user, document or chat id). */
export const UUID_ANY_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** The body of a `u_…` or `h_…` execution id token: the prefix and at least six id characters. */
export const USER_ID_TOKEN_SOURCE = "\\b[uh]_[0-9A-Za-z_-]{6,}";
