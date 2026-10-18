/**
 * Event paths that can carry user content, sealed in the log under the owning user's key.
 *
 * Rules for every flow, agent or tool added later (M3 onwards):
 *  - a flow's start input carries ids only (the `ingest-document` stub: `{ tenantId, userId, documentId }`), never a filename, title or text;
 *  - any step output or event field that can hold user content (document text, summaries, questions,
 *    answers) is listed here, or marked `sensitive(...)` in its schema and derived with
 *    `sensitivePathsFromSteps`; add it in the SAME PR that adds the flow, because an event written
 *    before its path is registered stays readable in the clear forever;
 *  - execution ids are plaintext and survive erasure, so they never contain user content either.
 *
 * M2's only flow (`ingest-document`, Task 53) has a start input of three UUIDs and a two-value enum
 * output, so nothing is registered yet; Task 53's tests fail if that stops being true.
 */
export const SENSITIVE_EVENT_PATHS: Readonly<Record<string, readonly string[]>> = {};
